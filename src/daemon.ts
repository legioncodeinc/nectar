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
 *
 * PRD-017a wires hivenectar's telemetry check-in/heartbeat here: `start()`
 * checks in (a fresh binding_time) right after `health.markStarted()` and arms
 * a heartbeat interval; `shutdown()` disarms it and closes the SQLite handle.
 * A fresh `Telemetry` is opened on every `start()` (not once at
 * `assembleDaemon()` construction time), so a stop/start cycle on the SAME
 * `AssembledDaemon` - not just a brand-new process - also gets a fresh
 * binding_time and zeroed since-restart counters (AC-017a.3.2 / AC-017b.3.1).
 * Opening/writing telemetry is fail-soft throughout (`telemetry/index.ts`):
 * a SQLite failure never blocks the lock, the bind, or the pipeline (AC-7).
 */
import {
  type RuntimeConfig,
  type RuntimeConfigOverrides,
  resolveConfig,
} from "./config.js";
import { HealthState, type PipelineStatus } from "./health.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./lock.js";
import { createHttpServer, type HttpServer } from "./server.js";
import type { Timer } from "./poll-loop.js";
import {
  createLogTap,
  createNullTelemetry,
  createTelemetry,
  telemetryDbPathForRuntimeDir,
  type LogSink,
  type Telemetry,
} from "./telemetry/index.js";
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
  /** Override the telemetry SQLite DB path (default: derived from the resolved runtime dir). */
  readonly telemetryDbPath?: string;
  /** Override the check-in heartbeat cadence (default: `DEFAULT_HEARTBEAT_INTERVAL_MS`). */
  readonly telemetryHeartbeatIntervalMs?: number;
  /** Injected timer for the heartbeat (deterministic tests). */
  readonly telemetryTimer?: Timer;
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
  /** The current telemetry facade (PRD-017): a no-op before the first `start()`, real once bound. */
  telemetry(): Telemetry;
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
  const baseLog = options.log ?? defaultLog;
  const health = new HealthState();
  const telemetryDbPath = options.telemetryDbPath ?? telemetryDbPathForRuntimeDir(config.runtimeDir);

  // A no-op placeholder until the first start() actually opens the SQLite store
  // (constructing/importing the daemon must stay side-effect free, unchanged).
  let telemetry: Telemetry = createNullTelemetry(telemetryDbPath);
  // Indirection so `log` (built once, below) always taps whatever `telemetry`
  // CURRENTLY is, across every start()/shutdown() cycle that reassigns it.
  const telemetrySink: LogSink = { log: (level, message) => telemetry.log(level, message) };
  const log = createLogTap(baseLog, telemetrySink);

  const worker = new HiveantennaeWorker({
    source: options.jobSource ?? emptyJobSource,
    handlers: options.handlers ?? {},
    pollIntervalMs: config.pollIntervalMs,
    onError: (err) => log({ level: "error", scope: "worker", err: String(err) }),
  });

  const lockPaths = { lockFilePath: config.lockFilePath, pidFilePath: config.pidFilePath };

  let server: HttpServer | null = null;
  let closed = false;
  let signalsInstalled = false;
  /** The one in-flight (or settled) startup. Concurrent/repeat callers share it, so nobody observes a "started" port before listen() actually succeeds. */
  let startPromise: Promise<number> | null = null;
  /** Stops the check-in heartbeat armed by the current telemetry instance, or null before/after it is running. */
  let stopHeartbeat: (() => void) | null = null;

  async function start(): Promise<number> {
    if (startPromise !== null) return startPromise;

    startPromise = (async () => {
      // Step 5 (PRD-002a): acquire the single-instance lock BEFORE the bind.
      acquireSingleInstanceLock(lockPaths);
      closed = false;
      // Step 6: start services (the worker's adaptive poll loop).
      worker.start();
      health.markStarted();

      // PRD-017a: open a FRESH telemetry store and check in (a new binding_time)
      // on every start(), so a stop/start cycle on this SAME daemon object also
      // resets since-restart state, not only a brand-new process. Fail-soft
      // throughout (`createTelemetry`): a SQLite failure never blocks the bind.
      telemetry = createTelemetry({
        dbPath: telemetryDbPath,
        onceFailure: (msg) => baseLog({ level: "warn", scope: "telemetry", msg }),
      });
      stopHeartbeat = telemetry.startCheckin(() => health.pipelineStatus, {
        intervalMs: options.telemetryHeartbeatIntervalMs,
        timer: options.telemetryTimer,
      });

      // Step 7: bind the socket.
      server = createHttpServer(health, config.host, config.port);
      const boundPort = await server.listen();
      log({ level: "info", scope: "daemon", msg: "listening", host: config.host, port: boundPort });
      return boundPort;
    })();

    // Only the caller that created the promise drives rollback; concurrent
    // callers returned the shared promise above and observe the same result.
    try {
      return await startPromise;
    } catch (err) {
      log({ level: "error", scope: "daemon", msg: "start failed, rolling back", err: String(err) });
      await shutdown(); // clears startPromise so a later start() can retry cleanly
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
    stopHeartbeat?.();
    stopHeartbeat = null;
    releaseSingleInstanceLock(lockPaths);
    startPromise = null; // allow a fresh start after a clean shutdown
    log({ level: "info", scope: "daemon", msg: "shutdown complete" });
    telemetry.close();
    telemetry = createNullTelemetry(telemetryDbPath);
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
    telemetry: () => telemetry,
    installSignalHandlers,
  };
}
