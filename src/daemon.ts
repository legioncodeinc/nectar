/**
 * The hivenectar daemon composition root.
 *
 * Mirrors honeycomb's `assembleDaemon` + `runAssembledDaemon`
 * (honeycomb/src/daemon/runtime/assemble.ts, honeycomb/src/daemon/index.ts:150-187)
 * per PRD-002a, scoped to hivenectar's job surface. The load-bearing ordering is
 * lock BEFORE bind (PRD-002a step 5 before step 7): a double-start fails fast at
 * the lock before the port is bound, and a bind failure rolls the lifecycle back
 * so no stale lock survives.
 *
 * `assembleDaemon()` constructs but never listens (importing the module is
 * side-effect free). `start()` acquires the lock, starts the worker, and binds
 * the socket. `shutdown()` drains the worker, closes the socket, and releases
 * the lock, idempotently.
 */
import {
  type RuntimeConfig,
  type RuntimeConfigOverrides,
  resolveConfig,
} from "./config.js";
import { HealthState, type PipelineStatus } from "./health.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./lock.js";
import { createHttpServer, type HttpServer } from "./server.js";
import {
  HiveantennaeWorker,
  type JobHandler,
  type JobKind,
  type JobSource,
  emptyJobSource,
} from "./worker.js";

export interface AssembleOptions extends RuntimeConfigOverrides {
  /** Override the worker's job source (defaults to the empty source until PRD-005/006 land). */
  readonly jobSource?: JobSource;
  /** Register worker handlers by kind (later PRDs supply these). */
  readonly handlers?: Partial<Record<JobKind, JobHandler>>;
  /** Structured log sink; defaults to stderr NDJSON. */
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface AssembledDaemon {
  readonly config: RuntimeConfig;
  readonly health: HealthState;
  readonly worker: HiveantennaeWorker;
  /** Acquire lock -> start worker -> bind socket. Returns the bound port. Idempotent. */
  start(): Promise<number>;
  /** Drain worker -> close socket -> release lock. Idempotent. */
  shutdown(): Promise<void>;
  /** The coarse health bit hivedoctor classifies on. */
  pipelineStatus(): PipelineStatus;
  /** Register process SIGINT/SIGTERM handlers that call shutdown once. */
  installSignalHandlers(): void;
}

function defaultLog(line: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
}

/**
 * Construct the daemon. Does NOT bind a socket or acquire the lock (that is
 * `start()`), so importing/constructing is safe in tests.
 */
export function assembleDaemon(options: AssembleOptions = {}): AssembledDaemon {
  const config = resolveConfig(options);
  const log = options.log ?? defaultLog;
  const health = new HealthState();

  const worker = new HiveantennaeWorker({
    source: options.jobSource ?? emptyJobSource,
    handlers: options.handlers ?? {},
    pollIntervalMs: config.pollIntervalMs,
    onError: (err) => log({ level: "error", scope: "worker", err: String(err) }),
  });

  const lockPaths = { lockFilePath: config.lockFilePath, pidFilePath: config.pidFilePath };

  let server: HttpServer | null = null;
  let started = false;
  let closed = false;
  let signalsInstalled = false;

  async function start(): Promise<number> {
    if (started) return server?.port ?? config.port;

    // Step 5 (PRD-002a): acquire the single-instance lock BEFORE the bind.
    acquireSingleInstanceLock(lockPaths);
    started = true;
    closed = false;

    try {
      // Step 6: start services (the worker's adaptive poll loop).
      worker.start();
      health.markStarted();

      // Step 7: bind the socket. Bind failure rolls the lifecycle back.
      server = createHttpServer(health, config.host, config.port);
      const boundPort = await server.listen();
      log({ level: "info", scope: "daemon", msg: "listening", host: config.host, port: boundPort });
      return boundPort;
    } catch (err) {
      log({ level: "error", scope: "daemon", msg: "start failed, rolling back", err: String(err) });
      await shutdown();
      throw err;
    }
  }

  async function shutdown(): Promise<void> {
    if (closed) return; // idempotent: a second signal is ignored
    closed = true;

    worker.stop();
    if (server !== null) {
      await server.close();
      server = null;
    }
    releaseSingleInstanceLock(lockPaths);
    started = false;
    log({ level: "info", scope: "daemon", msg: "shutdown complete" });
  }

  function installSignalHandlers(): void {
    if (signalsInstalled) return;
    signalsInstalled = true;
    const onSignal = (sig: string) => {
      log({ level: "info", scope: "daemon", msg: `received ${sig}, draining` });
      void shutdown().then(() => process.exit(0));
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  return {
    config,
    health,
    worker,
    start,
    shutdown,
    pipelineStatus: () => health.pipelineStatus,
    installSignalHandlers,
  };
}
