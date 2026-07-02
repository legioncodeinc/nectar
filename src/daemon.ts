/**
 * The nectar daemon composition root.
 *
 * Mirrors honeycomb's `assembleDaemon` + `runAssembledDaemon`
 * (honeycomb/src/daemon/runtime/assemble.ts, honeycomb/src/daemon/index.ts:150-187)
 * per PRD-002a, scoped to nectar's job surface. The load-bearing ordering is
 * lock BEFORE bind (PRD-002a step 5 before step 7): a double-start fails fast at
 * the lock before the port is bound, and a bind failure rolls the lifecycle back
 * so no stale lock survives.
 *
 * `assembleDaemon()` constructs but never listens (importing the module is
 * side-effect free). `start()` acquires the lock, starts the worker, and binds
 * the socket. `shutdown()` drains the worker, closes the socket, and releases
 * the lock, idempotently.
 *
 * PRD-017a wires nectar's telemetry check-in/heartbeat here: `start()`
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
import { HealthState, type HealthBody, type PipelineStatus } from "./health.js";
import { resolvePortkeyConfig, type PortkeyConfigOverrides } from "./portkey/config.js";
import {
  resolveEmbeddingsConfig,
  type EmbeddingsConfigOverrides,
} from "./embeddings/config.js";
import type { EmbedProviderSelector } from "./embeddings/provider.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./lock.js";
import { createHttpServer, type HttpServer } from "./server.js";
import {
  NectarRouter,
  ROUTE_GROUPS,
  allowAllPermission,
  type PermissionGate,
  type RouteGroup,
} from "./api/router.js";
import { mountHiveGraphApi, type MountHiveGraphOptions } from "./api/hive-graph-api.js";
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
import type { Tenancy } from "./hive-graph/model.js";
import type { HiveGraphStore } from "./hive-graph/store.js";
import { createDiskRegistrationFs } from "./registration/disk-fs.js";
import { createOffProvider } from "./embeddings/provider.js";
import {
  createEnricherLoop,
  EnricherInMemoryStore,
  type EnricherCycleDeps,
  type EnricherCycleLogSink,
  type EnricherLoop,
  type EnricherStore,
} from "./enricher/index.js";
import {
  evaluateAutoBrood,
  runBrood,
  shouldAutoBrood,
  type BroodConfig,
  type BroodResult,
  type BroodRunOptions,
  type BroodRuntimeDeps,
} from "./brooding/index.js";
import { loadProjection, loadProjectionFromFile, type LoadIgnoreReason } from "./projection/load.js";
import { inheritFromProjection, type DiskHashMap, type InheritRow, type InheritSummary } from "./projection/inherit.js";
import type { PortableProjection } from "./projection/format.js";

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
  /** Portkey config overrides (default: resolve from `process.env`). Lets a test set the health `portkey.enabled` bit without env. */
  readonly portkey?: PortkeyConfigOverrides;
  /** Embeddings config overrides (default: resolve from `process.env`). Lets a test set the health `embeddings.provider` label without env. */
  readonly embeddings?: EmbeddingsConfigOverrides;

  // ── Wave C daemon wiring (PRD-007 / PRD-011 / PRD-016) ──────────────────────
  /** Project tenancy shared by the enricher loop, the auto-brood trigger, and the boot projection load (default: an empty placeholder — an empty store yields no work). */
  readonly tenancy?: Tenancy;
  /** Project root shared by the auto-brood trigger's discovery + projection existence check (default: `process.cwd()`). */
  readonly projectRoot?: string;

  /** Disable the enricher steady-state loop (PRD-016). Default: enabled. */
  readonly enricherEnabled?: boolean;
  /** The enricher store the loop reads/writes (default: an empty in-memory working set; the durable bridge is injected by production wiring). */
  readonly enricherStore?: EnricherStore;
  /** Enricher cycle deps beyond the store/tenancy/health-sink the daemon supplies (portkey, embed provider, content reader, config...). */
  readonly enricherCycle?: Partial<Omit<EnricherCycleDeps, "store" | "tenancy" | "logSink">>;
  /** Enricher poll cadence override (default: `DEFAULT_ENRICHER_POLL_INTERVAL_MS`). */
  readonly enricherPollIntervalMs?: number;
  /** Injected timer for the enricher loop (deterministic tests). */
  readonly enricherTimer?: Timer;

  /**
   * The sync hive-graph store the auto-brood trigger evaluates + broods against
   * (PRD-007d). When absent the auto-brood check is skipped: `runBrood` consumes
   * the synchronous `HiveGraphStore`, while the only durable substrate
   * (`DeepLakeHiveGraphStore`) is asynchronous, so production auto-brood awaits
   * the sync/async bridge documented on `AsyncHiveGraphStore`.
   */
  readonly broodStore?: HiveGraphStore;
  /** Disable the auto-brood trigger even when `broodStore` is present. Default: enabled when `broodStore` is set. */
  readonly autoBroodEnabled?: boolean;
  /** The brood runner (default: {@link runBrood}). A test injects a spy to assert the trigger fired without an LLM call. */
  readonly broodRun?: (config: BroodConfig, deps?: BroodRuntimeDeps, options?: BroodRunOptions) => Promise<BroodResult>;
  /** Extra brood config (fs seam, gitLsFiles, pack options...). `store`/`tenancy`/`root` are always supplied by the daemon. */
  readonly broodConfig?: Partial<Omit<BroodConfig, "store" | "tenancy" | "root">>;
  /** Brood runtime deps (describe transport, embed provider, projection regen seam). */
  readonly broodDeps?: BroodRuntimeDeps;
  /** Brood run options for the auto-trigger (default: `{}`). */
  readonly broodOptions?: BroodRunOptions;

  /** Boot projection load + fresh-clone inheritance seam (PRD-011 AC-6). Absent -> skipped. */
  readonly bootProjection?: BootProjectionLoad;

  // ── Wave D daemon API surface (PRD-008 / PRD-012b) ──────────────────────────
  /**
   * The permission gate mounted on every `protect: true` route group (PRD-008a).
   * The shipped daemon has no auth beyond the unprotected `/health`; 008a
   * scaffolds this seam. Default: {@link allowAllPermission} (open on loopback).
   * A test injects a deny gate to prove permission inheritance; a future RBAC
   * policy attaches here.
   */
  readonly apiPermission?: PermissionGate;
  /**
   * When supplied, the daemon mounts the `/api/hive-graph/*` handlers (PRD-008b
   * search + 008c build/status/projection) via {@link mountHiveGraphApi} at
   * assembly time. Absent -> the group is still scaffolded + protected, but no
   * handler is attached (an unfilled path answers the root 501 scaffold). Tests
   * and production wiring may also call `mountHiveGraphApi(daemon, options)`
   * directly on the returned daemon.
   */
  readonly hiveGraphApi?: MountHiveGraphOptions;
}

/**
 * Inputs to the boot projection load (PRD-011b AC-6). The daemon validates the
 * projection on boot and, when `diskHashes` is supplied, inherits every
 * hash-matched file's nectar + description with zero LLM calls, writing the
 * inherited rows through `write`. Fail-soft: an invalid projection is ignored
 * (reason surfaced), never partially loaded, and never throws.
 */
export interface BootProjectionLoad {
  readonly tenancy: Tenancy;
  /** An explicit projection document (tests / in-memory boot). */
  readonly doc?: PortableProjection;
  /** Load + validate the projection from this file path (the `.honeycomb/nectars.json` on disk). */
  readonly filePath?: string;
  /**
   * Repo-relative path -> content hash from a disk scan; enables the inheritance
   * step. May be a provider so the (potentially expensive) scan runs in the
   * background AFTER validation passes, never blocking readiness.
   */
  readonly diskHashes?: DiskHashMap | (() => DiskHashMap | Promise<DiskHashMap>);
  /**
   * Nectars already present in the local store; never overwritten (additive-only
   * inheritance). May be a provider so the durable store read is deferred to the
   * background boot task.
   */
  readonly existingNectars?: ReadonlySet<string> | (() => ReadonlySet<string> | Promise<ReadonlySet<string>>);
  /** Persist the inherited rows to the durable store (async ok). Omitted -> inheritance is computed but not written. */
  readonly write?: (rows: readonly InheritRow[]) => void | Promise<void>;
  /** ISO 8601 "now" for the inherited rows (deterministic tests). */
  readonly nowIso?: string;
  /** Observe the outcome (validation reason / inherit summary). */
  readonly onResult?: (result: BootProjectionResult) => void;
}

/** The outcome of {@link runBootProjectionLoad}. */
export interface BootProjectionResult {
  readonly loaded: boolean;
  readonly reason?: LoadIgnoreReason;
  readonly inheritSummary?: InheritSummary;
}

/**
 * Load + validate a projection on boot and, when disk hashes are supplied, run
 * the fresh-clone inheritance (PRD-011b AC-6). Never throws: a validation
 * failure returns `{ loaded: false, reason }`, and a `write` rejection is
 * swallowed (recall is simply not pre-warmed). Uses `projection/load.ts` +
 * `projection/inherit.ts` verbatim.
 */
export async function runBootProjectionLoad(opts: BootProjectionLoad): Promise<BootProjectionResult> {
  let loaded;
  try {
    if (opts.doc !== undefined) {
      loaded = loadProjection(opts.doc, opts.tenancy);
    } else if (opts.filePath !== undefined) {
      loaded = loadProjectionFromFile(opts.filePath, { tenancy: opts.tenancy });
    } else {
      return { loaded: false };
    }
  } catch {
    return { loaded: false };
  }

  if (!loaded.ok) {
    const result: BootProjectionResult = { loaded: false, reason: loaded.reason };
    opts.onResult?.(result);
    return result;
  }

  let inheritSummary: InheritSummary | undefined;
  if (opts.diskHashes !== undefined) {
    const diskHashes = typeof opts.diskHashes === "function" ? await opts.diskHashes() : opts.diskHashes;
    const existingNectars =
      typeof opts.existingNectars === "function" ? await opts.existingNectars() : opts.existingNectars;
    inheritSummary = inheritFromProjection(loaded.doc, diskHashes, {
      tenancy: opts.tenancy,
      ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
      ...(existingNectars !== undefined ? { existingNectars } : {}),
    });
    if (opts.write !== undefined && inheritSummary.rows.length > 0) {
      try {
        await opts.write(inheritSummary.rows);
      } catch {
        // fail-soft: recall is not pre-warmed, but the daemon still boots.
      }
    }
  }

  const result: BootProjectionResult = inheritSummary !== undefined ? { loaded: true, inheritSummary } : { loaded: true };
  opts.onResult?.(result);
  return result;
}

/** Map the embeddings selector (`off | local | hosted`) to the health body's provider label. */
function embeddingsHealthProvider(selector: EmbedProviderSelector): HealthBody["embeddings"]["provider"] {
  switch (selector) {
    case "off":
      return "off";
    case "local":
      return "local-nomic";
    case "hosted":
      return "hosted";
    default: {
      // Exhaustiveness: a new selector variant fails the build here until mapped.
      const unreachable: never = selector;
      return unreachable;
    }
  }
}

export interface AssembledDaemon {
  readonly config: RuntimeConfig;
  readonly health: HealthState;
  readonly worker: HiveantennaeWorker;
  /** Acquire lock -> start worker -> bind socket. Returns the bound port. Idempotent. */
  start(): Promise<number>;
  /** Drain worker -> close socket -> release lock. Idempotent. */
  shutdown(): Promise<void>;
  /** The coarse health bit doctor classifies on. */
  pipelineStatus(): PipelineStatus;
  /** The current telemetry facade (PRD-017): a no-op before the first `start()`, real once bound. */
  telemetry(): Telemetry;
  /** Register process SIGINT/SIGTERM handlers that call shutdown once. */
  installSignalHandlers(): void;
  /**
   * The `group(path)` accessor (PRD-008a): returns the {@link RouteGroup} handle
   * for a mounted route group (e.g. `/api/hive-graph`), or `undefined` for an
   * unknown group path. `mountHiveGraphApi` attaches handlers through it; the
   * route table is live, so a handler attached after `start()` is still served.
   */
  group(path: string): RouteGroup | undefined;
  /**
   * Acknowledge the enricher's persistent-failure alert (PRD-016c), the operator
   * action that un-halts enrichment. A no-op when the enricher loop is disabled.
   */
  acknowledgeAlert(): void;
  /**
   * Resolves once the background boot tasks kicked off by the latest `start()`
   * (fresh-clone projection load, auto-brood trigger) have settled. These never
   * block readiness — `start()` returns as soon as the socket is bound — so this
   * exists for tests and orderly shutdown, not the hot path. Resolves immediately
   * before the first `start()`.
   */
  awaitBoot(): Promise<void>;
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

  // Resolve the provider state ONCE here, not per /health request (decision #20).
  // Both resolvers read only `process.env` (or an injected override bag) and never
  // touch disk or the network, so this keeps construction side-effect free.
  const portkeyConfig = resolvePortkeyConfig(options.portkey ?? {});
  const embeddingsConfig = resolveEmbeddingsConfig(options.embeddings ?? {});
  health.setProviderState({
    portkeyEnabled: portkeyConfig.enabled,
    embeddingsProvider: embeddingsHealthProvider(embeddingsConfig.selector),
  });

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

  // ── PRD-008a: the in-repo router seam over node:http ────────────────────────
  // Constructed side-effect free (no socket): it holds the frozen ROUTE_GROUPS,
  // the shared live route table, and the permission gate. `createHttpServer`
  // consumes it at start(); `daemon.group("/api/hive-graph")` exposes the
  // RouteGroup handle so `mountHiveGraphApi` can attach handlers before OR after
  // the socket binds (the route table is consulted per request).
  const router = new NectarRouter(ROUTE_GROUPS, options.apiPermission ?? allowAllPermission);

  // Shared Wave C context: an empty placeholder tenancy means an empty store
  // yields no work, so the default enricher loop is a harmless no-op until a
  // real tenancy + store are wired in.
  const waveCTenancy: Tenancy = options.tenancy ?? { orgId: "", workspaceId: "", projectId: "" };
  const projectRoot = options.projectRoot ?? process.cwd();

  // ── PRD-016: the enricher steady-state loop ─────────────────────────────────
  // The loop reads/writes the SYNCHRONOUS EnricherStore seam; its per-cycle stats
  // feed the /health enricher slice through `enricherHealthSink`. Started on
  // start(), stopped on shutdown(). The durable Deep Lake bridge is injected via
  // `enricherStore` (see enricher/store-adapter.ts); the default is an empty
  // in-memory working set.
  let enricherLoop: EnricherLoop | null = null;
  if (options.enricherEnabled ?? true) {
    const enricherStore: EnricherStore = options.enricherStore ?? new EnricherInMemoryStore();
    const nowIso = options.enricherCycle?.nowIso ?? (() => new Date().toISOString());
    const enricherHealthSink: EnricherCycleLogSink = {
      logCycle: (stats) => {
        try {
          health.setEnricherState({
            queueDepth: stats.queueDepth,
            lastCycleAt: nowIso(),
            consecutiveFailures: enricherLoop?.getFailureState().consecutiveFailures ?? 0,
          });
        } catch {
          // fail-soft: /health is best-effort and never blocks a cycle.
        }
      },
    };
    const cycleDeps: EnricherCycleDeps = {
      readContent: { read: () => null },
      portkey: null,
      embedProvider: createOffProvider(),
      ...options.enricherCycle,
      store: enricherStore,
      tenancy: waveCTenancy,
      logSink: enricherHealthSink,
    };
    enricherLoop = createEnricherLoop({
      deps: cycleDeps,
      ...(options.enricherPollIntervalMs !== undefined ? { pollIntervalMs: options.enricherPollIntervalMs } : {}),
      ...(options.enricherTimer !== undefined ? { timer: options.enricherTimer } : {}),
      onError: (err) => log({ level: "error", scope: "enricher", err: String(err) }),
    });
  }

  /** Background boot tasks (projection load, auto-brood) from the latest start(); never blocks readiness. */
  let bootSettled: Promise<void> = Promise.resolve();

  /**
   * PRD-007d automatic trigger: after the socket is bound, if the project has no
   * hive_graph rows OR no projection, brood in the BACKGROUND (never blocks
   * readiness). Only runs when a sync `broodStore` is wired.
   */
  async function triggerAutoBrood(): Promise<void> {
    const store = options.broodStore;
    if (store === undefined || (options.autoBroodEnabled ?? true) === false) return;
    try {
      if (!shouldAutoBrood(evaluateAutoBrood(store, waveCTenancy, projectRoot))) return;
      health.setBroodingState({ active: true, lastEventAt: new Date().toISOString() });
      const broodConfig: BroodConfig = {
        ...options.broodConfig,
        store,
        tenancy: waveCTenancy,
        root: projectRoot,
        fs: options.broodConfig?.fs ?? createDiskRegistrationFs(projectRoot),
      };
      const run = options.broodRun ?? runBrood;
      const result = await run(broodConfig, options.broodDeps ?? {}, options.broodOptions ?? {});
      health.setBroodingState({
        active: false,
        filesDescribed: result.describedCount,
        filesTotal: result.discoveredCount,
        lastEventAt: new Date().toISOString(),
      });
      health.addBroodCost({ tokens: result.estimate.inputTokens, usd: result.estimate.totalUsd });
    } catch (err) {
      health.setBroodingState({ active: false });
      log({ level: "error", scope: "brood", err: String(err) });
    }
  }

  /** PRD-011b AC-6: load + validate the projection and inherit hash-matched files, in the background. */
  async function loadBootProjection(): Promise<void> {
    const boot = options.bootProjection;
    if (boot === undefined) return;
    try {
      const result = await runBootProjectionLoad(boot);
      if (result.loaded && result.inheritSummary !== undefined && result.inheritSummary.inherited > 0) {
        health.setProjectionState({ lastWriteAt: new Date().toISOString() });
      }
    } catch (err) {
      log({ level: "error", scope: "projection", err: String(err) });
    }
  }

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
      // Step 6: start services (the worker's adaptive poll loop + the enricher loop).
      worker.start();
      enricherLoop?.start();
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
      server = createHttpServer(health, config.host, config.port, router);
      const boundPort = await server.listen();
      log({ level: "info", scope: "daemon", msg: "listening", host: config.host, port: boundPort });

      // Step 8 (Wave C): kick off the background boot tasks AFTER the daemon is
      // accepting requests, so neither the fresh-clone projection load nor the
      // auto-brood trigger ever blocks readiness (PRD-007d / PRD-011b AC-6).
      bootSettled = Promise.allSettled([loadBootProjection(), triggerAutoBrood()]).then(() => {});

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
    enricherLoop?.stop();
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

  const daemon: AssembledDaemon = {
    config,
    health,
    worker,
    start,
    shutdown,
    pipelineStatus: () => health.pipelineStatus,
    telemetry: () => telemetry,
    installSignalHandlers,
    acknowledgeAlert: () => enricherLoop?.acknowledgeAlert(),
    awaitBoot: () => bootSettled,
    group: (path) => router.group(path),
  };

  // PRD-008: attach the /api/hive-graph handlers when the caller wired the
  // mechanics. The group is already scaffolded + protected regardless; this
  // fills it. Callers may equivalently call mountHiveGraphApi(daemon, opts).
  if (options.hiveGraphApi !== undefined) {
    mountHiveGraphApi(daemon, options.hiveGraphApi);
  }

  return daemon;
}
