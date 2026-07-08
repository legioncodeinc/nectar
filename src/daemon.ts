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
import { join } from "node:path";
import {
  type RuntimeConfig,
  type RuntimeConfigOverrides,
  resolveConfig,
  isLoopbackHost,
} from "./config.js";
import { HealthState, type HealthBody, type PipelineStatus } from "./health.js";
import type { BroodPrereqStatus } from "./brood-prereqs.js";
import { resolvePortkeyConfig, type PortkeyConfigOverrides } from "./portkey/config.js";
import {
  resolveEmbeddingsConfig,
  type EmbeddingsConfigOverrides,
} from "./embeddings/config.js";
import type { EmbedProviderSelector } from "./embeddings/provider.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock, type LockIdentity } from "./lock.js";
import { DaemonStartAbortedError, NonLoopbackOpenApiError } from "./errors.js";
import { createHttpServer, DEFAULT_CLOSE_GRACE_MS, type HttpServer } from "./server.js";
import {
  NectarRouter,
  ROUTE_GROUPS,
  allowAllPermission,
  type PermissionGate,
  type RouteGroup,
} from "./api/router.js";
import { mountHiveGraphApi, type MountHiveGraphOptions } from "./api/hive-graph-api.js";
import { createBroodGuard, type BroodGuard } from "./brood-guard.js";
import type { Timer } from "./poll-loop.js";
import { ActiveProjectsController } from "./active-projects-runtime.js";
import { CredentialsWatch } from "./credentials-watch.js";
import type { ProjectContextFactory } from "./project-supervisor.js";
import type { ActiveProjectResolution } from "./hive-graph/active-projects.js";
import {
  createLogTap,
  createNullTelemetry,
  createTelemetry,
  TELEMETRY_DB_FILE_NAME,
  TELEMETRY_DIR_NAME,
  telemetryDbPathForRuntimeDir,
  type LogSink,
  type Telemetry,
} from "./telemetry/index.js";
import { assertNoLegacyDaemonRunning, resolveStateReadPath, runStateMigration } from "./state-migration.js";
import {
  HiveantennaeWorker,
  type JobHandler,
  type JobKind,
  type JobSource,
  emptyJobSource,
} from "./worker.js";
import type { Tenancy } from "./hive-graph/model.js";
import type { AsyncHiveGraphStore, HiveGraphStore } from "./hive-graph/store.js";
import { createDiskRegistrationFs } from "./registration/disk-fs.js";
import { RegistrationService, type RegistrationFs } from "./registration/service.js";
import type { WatcherState } from "./registration/fs-watch.js";
import { StoreBridge } from "./registration/store-bridge.js";
import { createSharedIgnore, type IgnorePredicate } from "./registration/ignore.js";
import { createTlshFuzzyStep, DEFAULT_TUNABLE_FUZZY_CONFIG, type FuzzyConfig } from "./registration/tlsh.js";
import { FilePendingReviewStore, type PendingReviewStore } from "./registration/review-store.js";
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
  evaluateAutoBroodAsync,
  runBrood,
  runBroodAsync,
  shouldAutoBrood,
  type AsyncBroodConfig,
  type AsyncBroodRuntimeDeps,
  type BroodConfig,
  type BroodResult,
  type BroodRunOptions,
  type BroodRuntimeDeps,
} from "./brooding/index.js";
import type { PipelineMetricsSink } from "./telemetry/index.js";
import { loadProjection, loadProjectionFromFile, type LoadIgnoreReason } from "./projection/load.js";
import { inheritFromProjection, type DiskHashMap, type InheritRow, type InheritSummary } from "./projection/inherit.js";
import type { PortableProjection } from "./projection/format.js";

/**
 * Bounded drain timeout for `shutdown()` (PRD-018a NEC-033 / AC-018a.11): how
 * long to wait for the in-flight worker tick and background boot tasks to settle
 * before releasing the lock and proceeding. A drain that exceeds this logs and
 * proceeds, so shutdown stays bounded (it must not reintroduce the NEC-021 hang).
 */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;

/**
 * Await `work` but give up after `ms`. Resolves `true` when the work settled
 * first, `false` on timeout. The timer is unref'd so it never keeps the process
 * alive, and cleared on settle so it never leaks.
 */
async function raceWithTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasExplicitRuntimeDirOverride(options: AssembleOptions): boolean {
  if (options.runtimeDir !== undefined) return true;
  const envRuntimeDir = process.env["NECTAR_RUNTIME_DIR"];
  return envRuntimeDir !== undefined && envRuntimeDir.trim() !== "";
}

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
  /** Bounded drain timeout for `shutdown()` (AC-018a.11). Default: {@link DEFAULT_SHUTDOWN_DRAIN_MS}. */
  readonly shutdownDrainMs?: number;
  /** Grace before force-closing active connections on shutdown (AC-018a.6). Default: {@link DEFAULT_CLOSE_GRACE_MS}. */
  readonly shutdownCloseGraceMs?: number;
  /** Portkey config overrides (default: resolve from `process.env`). Lets a test set the health `portkey.enabled` bit without env. */
  readonly portkey?: PortkeyConfigOverrides;
  /**
   * The resolved brood prerequisites (PRD-018k / NEC-023). When supplied and
   * NOT ready, the daemon sets the `/health` brooding reason at assembly
   * (AC-018k.3) and logs one loud line naming exactly which prerequisites are
   * missing at `start()` (AC-018k.1 / AC-018k.2). Absent -> no dormancy signal
   * (the pre-018k behavior for callers that do not resolve prerequisites).
   */
  readonly broodPrereqs?: BroodPrereqStatus;
  /** Embeddings config overrides (default: resolve from `process.env`). Lets a test set the health `embeddings.provider` label without env. */
  readonly embeddings?: EmbeddingsConfigOverrides;

  // ── PRD-003a: solo-vs-fleet login deferral (the degraded-until-login posture) ──
  /**
   * The durable-store credentials presence at boot (PRD-003a a-AC-1). When
   * `false`, `/health` boots 503 degraded with `storage.reason:
   * "credentials-missing"` while the daemon stays up; when `true`, it boots ok.
   * Absent (undefined) leaves the legacy `ok` posture unchanged - so every
   * existing caller/test that never sets it is unaffected.
   */
  readonly storageCredentialsPresent?: boolean;
  /**
   * A credentials watch (PRD-003a a-AC-2): when set, `start()` arms a poll loop
   * that re-resolves credentials on the poll cadence and flips `/health` between
   * degraded and healthy WITHOUT a restart the moment
   * `~/.deeplake/credentials.json` appears (or disappears). `shutdown()` stops
   * it. Absent -> no watch (the pre-003a behavior).
   */
  readonly credentialsWatch?: {
    /** Re-resolve whether valid credentials are present (production: `loadDeepLakeCredentials`). */
    probe(): boolean;
    /** Poll cadence override (default: `config.pollIntervalMs`). */
    intervalMs?: number;
    /** Injected timer for the watch loop (deterministic tests). */
    timer?: Timer;
    /** Observe a probe error. */
    onError?: (err: unknown) => void;
  };

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
  /**
   * The durable ASYNC hive-graph store the auto-brood trigger evaluates + broods
   * against (the sync/async bridge). When set, auto-brood runs {@link runBroodAsync}
   * against Deep Lake (wrapped with the daemon's telemetry metrics so the PRD-017
   * counters move). Takes precedence over {@link broodStore}. When neither is set
   * the auto-brood check is a no-op (logged nowhere - simply skipped).
   */
  readonly asyncBroodStore?: AsyncHiveGraphStore;
  /** Disable the auto-brood trigger even when a brood store is present. Default: enabled when a brood store is set. */
  readonly autoBroodEnabled?: boolean;
  /** The brood runner (default: {@link runBrood}). A test injects a spy to assert the trigger fired without an LLM call. */
  readonly broodRun?: (config: BroodConfig, deps?: BroodRuntimeDeps, options?: BroodRunOptions) => Promise<BroodResult>;
  /** The async brood runner (default: {@link runBroodAsync}). A test injects a spy to assert the durable trigger fired. */
  readonly broodRunAsync?: (
    config: AsyncBroodConfig,
    deps?: AsyncBroodRuntimeDeps,
    options?: BroodRunOptions,
  ) => Promise<BroodResult>;
  /** Extra brood config (fs seam, gitLsFiles, pack options...). `store`/`tenancy`/`root` are always supplied by the daemon. */
  readonly broodConfig?: Partial<Omit<BroodConfig, "store" | "tenancy" | "root">>;
  /** Extra async brood config (fs seam, gitLsFiles, pack options...) for the durable path. */
  readonly broodConfigAsync?: Partial<Omit<AsyncBroodConfig, "store" | "tenancy" | "root">>;
  /** Brood runtime deps (describe transport, embed provider, projection regen seam). */
  readonly broodDeps?: BroodRuntimeDeps;
  /** Async brood runtime deps (describe transport, embed provider, async projection regen seam) for the durable path. */
  readonly broodDepsAsync?: AsyncBroodRuntimeDeps;
  /** Brood run options for the auto-trigger (default: `{}`). */
  readonly broodOptions?: BroodRunOptions;

  /** Boot projection load + fresh-clone inheritance seam (PRD-011 AC-6). Absent -> skipped. */
  readonly bootProjection?: BootProjectionLoad;

  // ── PRD-018b: the update-on-change registration pipeline ────────────────────
  /**
   * The durable ASYNC store the update-on-change pipeline persists to (Deep
   * Lake). When set (and {@link registrationEnabled} is not false), `start()`
   * constructs a {@link RegistrationService} over a sync/async
   * {@link StoreBridge}, hydrates it, starts the NodeFS watcher, and requests a
   * cold-catch-up resync - all sequenced AFTER auto-brood settles (AC-018b.1/5/6).
   * Absent -> the watch leg is dormant and `/health` says so (AC-018b.7).
   */
  readonly registrationStore?: AsyncHiveGraphStore;
  /** Disable the registration pipeline even when a store is present. Default: enabled when a store is set. */
  readonly registrationEnabled?: boolean;
  /** Override the registration filesystem seam (default: `createDiskRegistrationFs(projectRoot)`). */
  readonly registrationFs?: RegistrationFs;
  /** Override the shared ignore predicate (default: `createSharedIgnore(projectRoot).isIgnored`, PRD-018c AC-018c.1 - the SAME predicate is also used by brood discovery's fs/isIgnored). */
  readonly registrationIgnore?: IgnorePredicate;
  /** Override the pending-review queue (default: a {@link FilePendingReviewStore} in the runtime dir). */
  readonly registrationReviews?: PendingReviewStore;
  /** Fuzzy step-4 config override (default: {@link DEFAULT_TUNABLE_FUZZY_CONFIG}). */
  readonly registrationFuzzyConfig?: FuzzyConfig;
  /** Injected timer for the intake debounce (deterministic tests). */
  readonly registrationTimer?: Timer;
  /** Debounce window for the intake (default: the intake's own `DEFAULT_DEBOUNCE_MS`). */
  readonly registrationDebounceMs?: number;

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

  // ── PRD-019a: the multi-root, dormant-by-default active-project supervisor ───
  /**
   * When supplied, the daemon is DORMANT BY DEFAULT and multi-root: instead of
   * the single-root `projectRoot` brood/watch wiring above, it stands up one
   * brood + watch context per active project (resolved from the shared
   * `~/.deeplake/projects.json` bindings AND the nectar-owned brooding state),
   * reconciling on the poll cadence and on demand (the 019b toggle API calls
   * {@link AssembledDaemon.reconcileActiveProjects}). Zero active projects => no
   * context is constructed and `/health` reports `activeProjects: 0` with reason
   * `no-active-projects` (never a brood of the cwd / `$HOME` / `System32`).
   *
   * Absent => the legacy single-root path stands (the explicit `projectRoot`
   * override the tests and a power-user `NECTAR_PROJECT_ROOT` use).
   */
  readonly activeProjects?: {
    /** Resolve the current active set (reads bindings + the brooding-state file). */
    resolve(): ActiveProjectResolution;
    /** Build a running brood + watch context for a project. */
    factory: ProjectContextFactory;
    /** Reconcile cadence override (default: `config.pollIntervalMs`). */
    reconcileIntervalMs?: number;
    /** Injected timer for the reconcile loop (deterministic tests). */
    timer?: Timer;
    /** Observe a context start/stop failure. */
    onError?: (scope: "start" | "stop", projectId: string, err: unknown) => void;
  };
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

/**
 * The live update-on-change pipeline handle (PRD-018b): the settled-handler
 * {@link RegistrationService} and the sync/async {@link StoreBridge} it persists
 * through. Exposed for introspection/tests once the pipeline has started (after
 * auto-brood settles); null when the watch leg is dormant (no durable store).
 */
export interface RegistrationPipeline {
  readonly service: RegistrationService;
  readonly bridge: StoreBridge;
}

export interface AssembledDaemon {
  readonly config: RuntimeConfig;
  readonly health: HealthState;
  readonly worker: HiveantennaeWorker;
  /**
   * The daemon's shared brood guard (PRD-018g / NEC-011 AC-018g.2). Pass it into
   * `mountHiveGraphApi` so the API `/build` handler and the boot auto-brood share
   * one single-flight; also exposed so a test can assert brood/enricher exclusion.
   */
  readonly broodGuard: BroodGuard;
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
  /**
   * The update-on-change pipeline (PRD-018b), or null when the watch leg is
   * dormant (no durable store resolved). Available once `start()` has bound;
   * the watcher itself starts in the background after auto-brood settles, so
   * assert liveness through `health.snapshot().watch.running` after `awaitBoot()`.
   */
  registration(): RegistrationPipeline | null;
  /**
   * PRD-019a: force an immediate reconcile of the active-project set (the 019b
   * toggle API calls this after persisting a brooding change). A no-op resolving
   * to `undefined`-equivalent when the multi-root supervisor is not wired.
   */
  reconcileActiveProjects(): Promise<void>;
  /**
   * How many times the daemon has requested the boot cold-catch-up resync
   * (AC-018b.5): exactly once per successful `start()` once boot settles, and
   * zero when the watch leg is dormant. Lets a test assert the "requested
   * exactly once, after auto-brood" contract.
   */
  registrationBootResyncCount(): number;
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

  // PRD-018k / NEC-023: surface the brooding-dormancy reason on /health as soon
  // as the daemon is constructed, so a dormant daemon is observable before the
  // auto-brood trigger even runs. Ready (or unspecified) leaves reason null.
  const broodPrereqs = options.broodPrereqs;
  if (broodPrereqs !== undefined) {
    health.setBroodingState({ reason: broodPrereqs.ready ? null : broodPrereqs.reason });
  }

  // PRD-003a a-AC-1: set the durable-store reachability posture at assembly, so
  // a credentials-missing boot serves 503 degraded immediately (before the first
  // watch tick). Only applied when the caller declares it; absent leaves the
  // legacy `ok` default untouched (every pre-003a test path is unaffected).
  if (options.storageCredentialsPresent !== undefined) {
    health.setStorageState(
      options.storageCredentialsPresent
        ? { reachable: true, reason: null }
        : { reachable: false, reason: "credentials-missing" },
    );
  }

  const runtimeDirOverride = hasExplicitRuntimeDirOverride(options);
  let telemetryDbPath = options.telemetryDbPath ?? telemetryDbPathForRuntimeDir(config.runtimeDir);

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
  const apiPermission = options.apiPermission ?? allowAllPermission;

  // Shared Wave C context: an empty placeholder tenancy means an empty store
  // yields no work, so the default enricher loop is a harmless no-op until a
  // real tenancy + store are wired in.
  const waveCTenancy: Tenancy = options.tenancy ?? { orgId: "", workspaceId: "", projectId: "" };
  const projectRoot = options.projectRoot ?? process.cwd();

  // PRD-018c NEC-007 (AC-018c.1): the ONE shared ignore predicate (segments ∪
  // graph-ignore ∪ gitignore semantics) - the SAME function reference is used
  // by brood discovery (both its git and walk paths), the watch intake, and
  // the resync path, so the three legs of the mission never disagree about
  // what the codebase is again. Memoized and constructed LAZILY on first
  // actual use (registration or brood activating), not at assembly time: a
  // daemon that never wires a store (most unit tests) never spawns `git`.
  let sharedIgnoreInstance: ReturnType<typeof createSharedIgnore> | undefined;
  function sharedIgnore(): ReturnType<typeof createSharedIgnore> {
    if (sharedIgnoreInstance === undefined) sharedIgnoreInstance = createSharedIgnore(projectRoot);
    return sharedIgnoreInstance;
  }
  const resolvedIgnore: IgnorePredicate =
    options.registrationIgnore ?? ((relPath: string) => sharedIgnore().isIgnored(relPath));

  // PRD-018g / NEC-011: the ONE shared brood guard. The boot auto-brood and the
  // API `/build` handler both go through it, and the enricher pauses while it is
  // active, so at most one brood runs per daemon and the enricher never races it.
  const broodGuard = createBroodGuard();

  // PRD-019a: the multi-root, dormant-by-default active-project supervisor. Built
  // only when the caller wires the active-projects seam (the shipped daemon does,
  // via `runDaemon`); absent, the legacy single-root path below stands unchanged.
  const activeProjectsController: ActiveProjectsController | null =
    options.activeProjects !== undefined
      ? new ActiveProjectsController({
          resolve: options.activeProjects.resolve,
          factory: options.activeProjects.factory,
          setHealth: (slice) => health.setActiveProjects(slice),
          intervalMs: options.activeProjects.reconcileIntervalMs ?? config.pollIntervalMs,
          ...(options.activeProjects.timer !== undefined ? { timer: options.activeProjects.timer } : {}),
          ...(options.activeProjects.onError !== undefined ? { onError: options.activeProjects.onError } : {}),
        })
      : null;

  // PRD-003a a-AC-2: the credentials watch. On each poll it re-resolves whether
  // credentials are present and, on a change, flips the /health storage posture
  // (degraded <-> healthy) with no restart. When credentials appear it also asks
  // the active-project supervisor to reconcile (a no-op when unwired).
  const credentialsWatch: CredentialsWatch | null =
    options.credentialsWatch !== undefined
      ? new CredentialsWatch({
          probe: options.credentialsWatch.probe,
          onChange: (present) => {
            health.setStorageState(
              present ? { reachable: true, reason: null } : { reachable: false, reason: "credentials-missing" },
            );
            log({
              level: "info",
              scope: "credentials",
              msg: present ? "credentials resolved; storage reachable" : "credentials absent; storage unreachable",
            });
            if (present && activeProjectsController !== null) {
              void activeProjectsController.reconcileNow().catch((err: unknown) => {
                log({ level: "error", scope: "credentials", msg: "reconcile after credentials appeared failed", err: String(err) });
              });
            }
          },
          intervalMs: options.credentialsWatch.intervalMs ?? config.pollIntervalMs,
          ...(options.credentialsWatch.timer !== undefined ? { timer: options.credentialsWatch.timer } : {}),
          ...(options.credentialsWatch.onError !== undefined ? { onError: options.credentialsWatch.onError } : {}),
        })
      : null;

  // ── PRD-016: the enricher steady-state loop ─────────────────────────────────
  // The loop reads/writes the SYNCHRONOUS EnricherStore seam; its per-cycle stats
  // feed the /health enricher slice through `enricherHealthSink`. Started on
  // start(), stopped on shutdown(). The durable Deep Lake bridge is injected via
  // `enricherStore` (see enricher/store-adapter.ts); the default is an empty
  // in-memory working set.
  let enricherLoop: EnricherLoop | null = null;
  // Gate on the RESOLVED config (resolveConfig(options) above), not the raw option:
  // config.enricherEnabled honors an explicit `enricherEnabled` override AND the
  // NECTAR_ENRICHER_ENABLED env, and keeps daemon.config in sync with runtime
  // behavior for any caller that does not re-forward the resolved value.
  if (config.enricherEnabled) {
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
    // Default the enricher's metrics sink to the daemon's OWN telemetry (read
    // lazily so it tracks the fresh instance opened on each start()), so a live
    // enricher cycle that describes/embeds moves the PRD-017 counters. A caller
    // may still override it via `enricherCycle.metrics`.
    const enricherMetrics: PipelineMetricsSink = options.enricherCycle?.metrics ?? {
      incrementFilesRegistered: () => telemetry.metrics.incrementFilesRegistered(),
      incrementNectarsMinted: () => telemetry.metrics.incrementNectarsMinted(),
      incrementDescriptionsGenerated: () => telemetry.metrics.incrementDescriptionsGenerated(),
      incrementHiveGraphVersions: () => telemetry.metrics.incrementHiveGraphVersions(),
      incrementEmbeddingsComputed: () => telemetry.metrics.incrementEmbeddingsComputed(),
    };
    const cycleDeps: EnricherCycleDeps = {
      readContent: { read: () => null },
      portkey: null,
      embedProvider: createOffProvider(),
      ...options.enricherCycle,
      store: enricherStore,
      tenancy: waveCTenancy,
      logSink: enricherHealthSink,
      metrics: enricherMetrics,
      // AC-018g.1: pause the enricher while a brood is in flight (shared guard).
      broodActive: () => broodGuard.active(),
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

  /** Record a completed brood's file/cost slices on /health (shared by both paths). */
  function finishBrood(result: BroodResult): void {
    health.setBroodingState({
      active: false,
      filesDescribed: result.describedCount,
      filesTotal: result.discoveredCount,
      lastEventAt: new Date().toISOString(),
    });
    health.addBroodCost({ tokens: result.actualUsage.inputTokens, usd: result.actualUsage.usd });
  }

  /**
   * PRD-007d automatic trigger: after the socket is bound, if the project has no
   * hive_graph rows OR no projection, brood in the BACKGROUND (never blocks
   * readiness). Runs against the durable ASYNC store when {@link asyncBroodStore}
   * is wired (the sync/async bridge, counting via the daemon's telemetry), else
   * against a sync {@link broodStore}; a no-op when neither is configured.
   */
  async function triggerAutoBrood(): Promise<void> {
    if ((options.autoBroodEnabled ?? true) === false) return;
    const asyncStore = options.asyncBroodStore;
    const syncStore = options.broodStore;
    if (asyncStore === undefined && syncStore === undefined) return;
    // AC-018g.2: route the boot auto-brood through the SAME shared guard the API
    // `/build` handler uses, so a `/build` arriving during the boot brood is
    // refused (409) and no two broods ever run - and no identity is double-minted.
    if (!broodGuard.tryAcquire()) return;
    try {
      if (asyncStore !== undefined) {
        if (!shouldAutoBrood(await evaluateAutoBroodAsync(asyncStore, waveCTenancy, projectRoot))) return;
        health.setBroodingState({ active: true, lastEventAt: new Date().toISOString() });
        const config: AsyncBroodConfig = {
          isIgnored: resolvedIgnore,
          ...options.broodConfigAsync,
          store: telemetry.wrapAsyncStore(asyncStore),
          tenancy: waveCTenancy,
          root: projectRoot,
          fs: options.broodConfigAsync?.fs ?? createDiskRegistrationFs(projectRoot, resolvedIgnore),
        };
        const run = options.broodRunAsync ?? runBroodAsync;
        finishBrood(await run(config, options.broodDepsAsync ?? {}, options.broodOptions ?? {}));
        return;
      }
      if (syncStore !== undefined) {
        if (!shouldAutoBrood(evaluateAutoBrood(syncStore, waveCTenancy, projectRoot))) return;
        health.setBroodingState({ active: true, lastEventAt: new Date().toISOString() });
        const config: BroodConfig = {
          isIgnored: resolvedIgnore,
          ...options.broodConfig,
          store: syncStore,
          tenancy: waveCTenancy,
          root: projectRoot,
          fs: options.broodConfig?.fs ?? createDiskRegistrationFs(projectRoot, resolvedIgnore),
        };
        const run = options.broodRun ?? runBrood;
        finishBrood(await run(config, options.broodDeps ?? {}, options.broodOptions ?? {}));
        return;
      }
    } catch (err) {
      health.setBroodingState({ active: false });
      log({ level: "error", scope: "brood", err: String(err) });
    } finally {
      broodGuard.release();
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

  // ── PRD-018b: the update-on-change registration pipeline ────────────────────
  // Constructed at start() (after the bind) when a durable async store resolved,
  // then hydrated + started + resynced in the background AFTER auto-brood settles
  // (so a first boot's brood never races the watcher into a double mint, and an
  // already-brooded boot still gets its cold catch-up). Stopped in shutdown()
  // before the lock is released, with its durable writes drained.
  const registrationStore = options.registrationStore;
  const registrationOn = registrationStore !== undefined && (options.registrationEnabled ?? true);
  let registration: RegistrationPipeline | null = null;
  let bootResyncCount = 0;

  /**
   * Build the registration pipeline: a {@link StoreBridge} over the durable async
   * store and a {@link RegistrationService} wired with the disk fs, ignore
   * predicate, the tunable TLSH fuzzy step, and the file-backed review queue.
   * Constructing the service does NOT start the watcher (that is `service.start()`).
   */
  function buildRegistration(store: AsyncHiveGraphStore): RegistrationPipeline {
    const bridge = new StoreBridge({
      durable: store,
      onFlushError: (err, op) => {
        health.recordWatchFlushFailure(new Date().toISOString());
        log({ level: "error", scope: "registration.bridge", op, err: String(err) });
      },
    });
    const pendingReviewsPath = runtimeDirOverride
      ? join(config.runtimeDir, "pending-reviews.json")
      : resolveStateReadPath("pending-reviews.json", { runtimeDir: config.runtimeDir });
    const reviews: PendingReviewStore =
      options.registrationReviews ?? new FilePendingReviewStore(pendingReviewsPath);
    const registrationMetrics: PipelineMetricsSink = {
      incrementFilesRegistered: () => telemetry.metrics.incrementFilesRegistered(),
      incrementNectarsMinted: () => telemetry.metrics.incrementNectarsMinted(),
      incrementDescriptionsGenerated: () => telemetry.metrics.incrementDescriptionsGenerated(),
      incrementHiveGraphVersions: () => telemetry.metrics.incrementHiveGraphVersions(),
      incrementEmbeddingsComputed: () => telemetry.metrics.incrementEmbeddingsComputed(),
    };
    const service = new RegistrationService({
      store: bridge,
      tenancy: waveCTenancy,
      fs: options.registrationFs ?? createDiskRegistrationFs(projectRoot, resolvedIgnore),
      root: projectRoot,
      fuzzy: createTlshFuzzyStep(options.registrationFuzzyConfig ?? DEFAULT_TUNABLE_FUZZY_CONFIG),
      pendingReviews: reviews,
      isIgnored: resolvedIgnore,
      ...(options.registrationTimer !== undefined ? { timer: options.registrationTimer } : {}),
      ...(options.registrationDebounceMs !== undefined ? { debounceMs: options.registrationDebounceMs } : {}),
      metrics: registrationMetrics,
      log,
      // PRD-018c NEC-007 point 1: refresh the shared predicate's gitignore
      // snapshot on every resync (boot, directory-event, watcher-restart, and
      // the periodic backstop all funnel through requestResync()), so the
      // cache stays warm without spawning git per watch event. A no-op when
      // `registrationIgnore` overrides the shared predicate (nothing to refresh).
      onResyncRequested: () => sharedIgnoreInstance?.refresh(),
      // PRD-018c AC-018c.6/7: surface watcher liveness on /health.
      onWatcherStateChange: (state: WatcherState) => {
        health.setWatchState({ state, running: state === "running" });
      },
    });
    return { service, bridge };
  }

  /**
   * Hydrate the mirror, start the watcher, and request the single cold-catch-up
   * resync (AC-018b.5) - the boot sequencing step that runs AFTER auto-brood
   * settles. A shutdown that raced boot sets `closed`; in that case this bails
   * out so the watcher is never started during teardown (AC-018b.3).
   */
  async function startRegistrationPipeline(): Promise<void> {
    if (registration === null || closed) return;
    try {
      await registration.bridge.hydrate(waveCTenancy);
    } catch (err) {
      log({ level: "error", scope: "registration.hydrate", err: String(err) });
    }
    if (closed) return; // a shutdown may have landed while hydrating
    registration.service.start();
    health.setWatchState({ running: true, reason: null });
    registration.service.requestResync();
    bootResyncCount += 1;
    log({ level: "info", scope: "registration", msg: "watch leg started", root: projectRoot });
  }

  const lockPaths = { lockFilePath: config.lockFilePath, pidFilePath: config.pidFilePath };
  const drainTimeoutMs = options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
  const closeGraceMs = options.shutdownCloseGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  let server: HttpServer | null = null;
  let closed = false;
  let signalsInstalled = false;
  /** The identity this instance stamped into the lock, or null when it holds no lock (never acquired, or released). */
  let lockIdentity: LockIdentity | null = null;
  /** The one in-flight (or settled) startup. Concurrent/repeat callers share it, so nobody observes a "started" port before listen() actually succeeds. */
  let startPromise: Promise<number> | null = null;
  /** Stops the check-in heartbeat armed by the current telemetry instance, or null before/after it is running. */
  let stopHeartbeat: (() => void) | null = null;

  async function start(): Promise<number> {
    if (startPromise !== null) return startPromise;

    startPromise = (async () => {
      // CodeRabbit PR-18 finding #1: clear `closed` at the very top of the
      // startPromise IIFE, before anything that can throw (the loopback guard,
      // the lock acquire). On a REUSED daemon instance (start -> shutdown ->
      // start again), a second start() that throws before this point used to
      // leave `closed === true` from the prior shutdown; the catch handler's
      // rollback `await shutdown()` then no-op'd on the `if (closed) return;`
      // guard and never cleared `startPromise`, wedging every later start() on
      // the same rejected promise forever. This is a synchronous assignment at
      // the top of a prefix that is itself synchronous up to the awaited
      // `listen()` call, so it does not affect the EX-1 race test's timing.
      closed = false;

      // PRD-018j / NEC-029: refuse to bind off loopback when the default open gate
      // is active, so the API is never network-reachable without authentication.
      if (apiPermission === allowAllPermission && !isLoopbackHost(config.host)) {
        throw new NonLoopbackOpenApiError(config.host);
      }

      if (!runtimeDirOverride) {
        assertNoLegacyDaemonRunning({
          runtimeDir: config.runtimeDir,
          pidFilePath: config.pidFilePath,
          lockFilePath: config.lockFilePath,
        });
        runStateMigration({
          config: {
            runtimeDir: config.runtimeDir,
            host: config.host,
            port: config.port,
            pidFilePath: config.pidFilePath,
          },
          log,
        });
        if (options.telemetryDbPath === undefined) {
          telemetryDbPath = resolveStateReadPath(join(TELEMETRY_DIR_NAME, TELEMETRY_DB_FILE_NAME), {
            runtimeDir: config.runtimeDir,
          });
        }
      }

      // Step 5 (PRD-002a): acquire the single-instance lock BEFORE the bind, and
      // remember the identity we stamped so the rollback path releases only what
      // THIS instance acquired (PRD-018a NEC-002).
      lockIdentity = acquireSingleInstanceLock(lockPaths);
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

      // Step 7: bind the socket. Use a local reference so a concurrent shutdown()
      // that nulls `server` cannot turn the unwind below into a null deref.
      const httpServer = createHttpServer(health, config.host, config.port, router);
      server = httpServer;
      const boundPort = await httpServer.listen();

      // EX-1 / M6: a shutdown() may have raced this start between lock acquisition
      // and the bind completing. If so, unwind: close the socket we just bound and
      // release the lock this instance holds, so we never end up listening without
      // a lock (which would let a second daemon start alongside us).
      if (closed) {
        await httpServer.close(closeGraceMs);
        if (server === httpServer) server = null;
        if (lockIdentity !== null) {
          releaseSingleInstanceLock(lockPaths, lockIdentity);
          lockIdentity = null;
        }
        throw new DaemonStartAbortedError();
      }

      log({ level: "info", scope: "daemon", msg: "listening", host: config.host, port: boundPort });

      // PRD-018k / NEC-023 (AC-018k.1 / AC-018k.2): a booted daemon that cannot
      // brood says so loudly, enumerating exactly which prerequisites are unmet
      // (the credentials file, and/or the specific NECTAR_PORTKEY_* variables),
      // instead of silently describing nothing.
      if (broodPrereqs !== undefined && !broodPrereqs.ready) {
        log({
          level: "warn",
          scope: "brood",
          msg: "brooding is dormant; the following prerequisites are missing",
          reason: broodPrereqs.reason,
          missing: broodPrereqs.missing,
        });
      }

      // PRD-018b: construct the registration pipeline now (side-effect light: no
      // watcher yet), and surface the watch-leg state on /health. Dormant with a
      // reason when no durable store resolved (AC-018b.7); constructed-but-not-yet
      // -started otherwise (the watcher starts in the boot task below).
      if (registrationOn && registrationStore !== undefined) {
        registration = buildRegistration(registrationStore);
        health.setWatchState({ running: false, reason: null });
      } else {
        health.setWatchState({
          running: false,
          reason: registrationStore === undefined ? "no-credentials" : "disabled",
        });
      }

      // Step 8 (Wave C / PRD-018b): kick off the background boot tasks AFTER the
      // daemon is accepting requests, so neither the fresh-clone projection load
      // nor the auto-brood trigger ever blocks readiness (PRD-007d / PRD-011b
      // AC-6). The registration watcher + cold-catch-up resync are sequenced
      // AFTER auto-brood settles (AC-018b.5/6): on a first boot the order is
      // brood, then watch, then resync; on a warm boot auto-brood is a no-op and
      // the resync runs promptly. No lock is needed - the watcher simply is not
      // running while the brood runs, so it cannot race a mint.
      bootSettled = (async () => {
        await Promise.allSettled([loadBootProjection(), triggerAutoBrood()]);
        await startRegistrationPipeline();
      })();

      // PRD-019a: publish the current active-project resolution to /health
      // immediately (so a dormant daemon reads activeProjects:0 with reason
      // no-active-projects right away), then arm the reconcile loop.
      if (activeProjectsController !== null) {
        try {
          activeProjectsController.publishHealth();
        } catch (err) {
          log({ level: "error", scope: "active-projects", msg: "initial publish failed", err: String(err) });
        }
        activeProjectsController.start();
      }

      // PRD-003a a-AC-2: arm the credentials watch so a login that lands after
      // boot flips /health healthy without a restart.
      credentialsWatch?.start();

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

    // EX-1 / M6: if a start is in flight, let IT observe `closed` and unwind
    // itself (close its own socket, release its own lock) rather than racing to
    // close a mid-bind socket here (which would leave the start's `listen()`
    // unsettled and hang shutdown). Its rejection is expected during this race.
    const inFlightStart = startPromise;
    if (inFlightStart !== null) {
      try {
        await inFlightStart;
      } catch {
        // An aborted or failed start during a racing shutdown is expected here.
      }
    }

    // Disarm the poll loops so no NEW tick starts, then drain the in-flight tick
    // and the background boot tasks (bootSettled) before releasing the lock.
    worker.stop();
    enricherLoop?.stop();
    // PRD-018b AC-018b.3: stop the watcher NOW (before the lock is released) so no
    // new watch event is scheduled; an in-flight cycle is drained below. This also
    // means the boot task's `startRegistrationPipeline` (if it has not run yet)
    // sees `closed` and never starts the watcher during teardown.
    registration?.service.stop();
    if (registration !== null) health.setWatchState({ running: false });
    // PRD-019a: stop the reconcile loop and tear down every running project
    // context (watcher stopped + bridge writes drained) before the lock releases.
    if (activeProjectsController !== null) {
      try {
        await activeProjectsController.stop();
      } catch (err) {
        log({ level: "error", scope: "active-projects", msg: "stop failed", err: String(err) });
      }
    }
    // PRD-003a a-AC-2: stop the credentials watch before the lock releases.
    if (credentialsWatch !== null) {
      try {
        await credentialsWatch.stop();
      } catch (err) {
        log({ level: "error", scope: "credentials", msg: "watch stop failed", err: String(err) });
      }
    }

    // AC-018a.10/11 (NEC-033): await the in-flight worker tick and bootSettled
    // under a bounded timeout so a shutdown that catches the worker busy drains
    // the write instead of killing it mid-flight. The drain never rejects
    // (errors are logged); a drain that exceeds the timeout logs and proceeds so
    // shutdown stays bounded (it must not reintroduce the NEC-021 hang). PRD-018b:
    // the registration cycle and its durable bridge flush are drained too, so a
    // ladder write in flight lands durably before the lock is released.
    const drainWork = (async () => {
      await worker.whenIdle();
      await bootSettled;
      if (registration !== null) {
        await registration.service._waitForIdle();
        await registration.bridge.whenFlushed();
      }
    })().catch((err) => {
      log({ level: "error", scope: "daemon", msg: "drain error", err: String(err) });
    });
    const drained = await raceWithTimeout(drainWork, drainTimeoutMs);
    if (!drained) {
      log({ level: "warn", scope: "daemon", msg: "drain timed out; proceeding with shutdown", timeoutMs: drainTimeoutMs });
    }

    if (server !== null) {
      await server.close(closeGraceMs);
      server = null;
    }
    stopHeartbeat?.();
    stopHeartbeat = null;
    // Ownership-checked release: only remove the lock this instance holds. A
    // failed second start (which never acquired the lock) has lockIdentity null
    // and touches nothing, so it can never delete the live daemon's lock (NEC-002).
    if (lockIdentity !== null) {
      releaseSingleInstanceLock(lockPaths, lockIdentity);
      lockIdentity = null;
    }
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
    broodGuard,
    start,
    shutdown,
    pipelineStatus: () => health.pipelineStatus,
    telemetry: () => telemetry,
    installSignalHandlers,
    acknowledgeAlert: () => enricherLoop?.acknowledgeAlert(),
    awaitBoot: () => bootSettled,
    group: (path) => router.group(path),
    registration: () => registration,
    reconcileActiveProjects: async () => {
      if (activeProjectsController === null) return;
      await activeProjectsController.reconcileNow();
    },
    registrationBootResyncCount: () => bootResyncCount,
  };

  // PRD-008: attach the /api/hive-graph handlers when the caller wired the
  // mechanics. The group is already scaffolded + protected regardless; this
  // fills it. Callers may equivalently call mountHiveGraphApi(daemon, opts).
  if (options.hiveGraphApi !== undefined) {
    // Share the daemon's brood guard with the API `/build` handler (AC-018g.2)
    // unless the caller already supplied one.
    mountHiveGraphApi(daemon, { broodGuard, ...options.hiveGraphApi });
  }

  return daemon;
}
