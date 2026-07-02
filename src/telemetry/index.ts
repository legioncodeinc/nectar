/**
 * The fail-soft telemetry facade (PRD-017), composing the check-in, metrics,
 * and log writers behind ONE object `daemon.ts` (and, later, the registration
 * pipeline) depends on.
 *
 * `createTelemetry()` NEVER throws (AC-7): opening the local SQLite database
 * (`node:sqlite`, WAL mode, `db.ts`) is wrapped in a try/catch, and a failure
 * degrades to {@link NULL_TELEMETRY} - a no-op that keeps the daemon boot and
 * the nectar pipeline completely unaffected. Every method on the real,
 * DB-backed implementation is individually fail-soft too (see `checkin.ts`,
 * `metrics.ts`, `logs.ts`), so a write failure MID-LIFE (a locked file, a full
 * disk) degrades the same way a failed OPEN does.
 */
import type { PipelineStatus } from "../health.js";
import type { Timer } from "../poll-loop.js";
import type { SourceGraphStore } from "../source-graph/store.js";
import { CheckinService, CheckinWriter } from "./checkin.js";
import { defaultTelemetryDbPath, openTelemetryDb, type SqliteDatabaseLike } from "./db.js";
import { LogWriter, type LogLevel } from "./logs.js";
import { MetricsWriter, wrapStoreWithMetrics, type MetricsSnapshot, type PipelineMetricsSink } from "./metrics.js";

export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  CheckinService,
  CheckinWriter,
} from "./checkin.js";
export {
  defaultTelemetryDbPath,
  telemetryDbPathForRuntimeDir,
  TELEMETRY_DIR_NAME,
  TELEMETRY_DB_FILE_NAME,
  type SqliteDatabaseLike,
} from "./db.js";
export {
  DEFAULT_LOG_MAX_AGE_MS,
  MAX_LOG_MESSAGE_LENGTH,
  LOG_LEVELS,
  LogWriter,
  createLogTap,
  redactLogMessage,
  levelFromLine,
  messageFromLine,
  type LogLevel,
  type LogSink,
} from "./logs.js";
export {
  MetricsWriter,
  wrapStoreWithMetrics,
  type MetricsSnapshot,
  type PipelineMetricsSink,
} from "./metrics.js";

export interface StopHeartbeat {
  (): void;
}

export interface StartCheckinOptions {
  readonly intervalMs?: number;
  readonly timer?: Timer;
}

export interface Telemetry {
  /** False when the local SQLite telemetry store could not be opened (AC-7); every method below is then a no-op. */
  readonly enabled: boolean;
  /** The database path this instance was opened against (or would have been). */
  readonly dbPath: string;
  /** The 5-counter since-restart metrics sink (PRD-017b). A no-op sink when `enabled` is false. */
  readonly metrics: PipelineMetricsSink;
  /** Read back the current metrics snapshot (test/introspection convenience). */
  metricsSnapshot(): MetricsSnapshot;
  /** Check in once, then heartbeat on an interval until the returned stop function is called (PRD-017a). */
  startCheckin(health: () => PipelineStatus, opts?: StartCheckinOptions): StopHeartbeat;
  /** Mirror one log line into `service_logs` (PRD-017c). Prefer `createLogTap` to wrap an existing sink. */
  log(level: LogLevel, message: string): void;
  /** Wrap a `SourceGraphStore` so nectar mints and version writes increment their counters at the real write (PRD-017b). */
  wrapStore<T extends SourceGraphStore>(store: T): T;
  /** Close the backing SQLite handle (idempotent, never throws). */
  close(): void;
}

export interface CreateTelemetryOptions {
  /** Override the database path (default: {@link defaultTelemetryDbPath}). */
  readonly dbPath?: string;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now?(): string;
  /** A one-time failure sink for the open failure (defaults to a single stderr write). Never called per-write. */
  onceFailure?(message: string): void;
}

function defaultOnceFailure(): (message: string) => void {
  let fired = false;
  return (message: string): void => {
    if (fired) return;
    fired = true;
    process.stderr.write(`${message}\n`);
  };
}

/**
 * The no-op telemetry the daemon falls back to when the local SQLite store is
 * unavailable (AC-7), and the placeholder `daemon.ts` holds before the first
 * `start()` (constructing/importing the daemon must never touch disk).
 */
export function createNullTelemetry(dbPath: string): Telemetry {
  const noopMetrics: PipelineMetricsSink = {
    incrementFilesRegistered() {},
    incrementNectarsMinted() {},
    incrementDescriptionsGenerated() {},
    incrementSourceGraphVersions() {},
    incrementEmbeddingsComputed() {},
  };
  return {
    enabled: false,
    dbPath,
    metrics: noopMetrics,
    metricsSnapshot: () => ({
      filesRegistered: 0,
      nectarsMinted: 0,
      descriptionsGenerated: 0,
      sourceGraphVersions: 0,
      embeddingsComputed: 0,
    }),
    startCheckin: () => () => {},
    log: () => {},
    wrapStore: (store) => store,
    close: () => {},
  };
}

/**
 * Open hivenectar's telemetry store and return the composed facade. NEVER
 * throws: an open failure is reported ONCE (never per-write) and this returns
 * {@link nullTelemetry} so the caller's boot sequence is completely unaffected
 * (AC-7).
 */
export function createTelemetry(opts: CreateTelemetryOptions = {}): Telemetry {
  const dbPath = opts.dbPath ?? defaultTelemetryDbPath();
  const onceFailure = opts.onceFailure ?? defaultOnceFailure();

  let db: SqliteDatabaseLike;
  try {
    db = openTelemetryDb(dbPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    onceFailure(`hivenectar: telemetry unavailable (non-fatal), continuing without it: ${reason}`);
    return createNullTelemetry(dbPath);
  }

  const checkinWriter = new CheckinWriter({ db, now: opts.now });
  const metricsWriter = new MetricsWriter({ db, now: opts.now });
  const logWriter = new LogWriter({ db, now: opts.now });

  return {
    enabled: true,
    dbPath,
    metrics: metricsWriter,
    metricsSnapshot: () => metricsWriter.snapshot(),
    startCheckin: (health, startOpts = {}) => {
      const service = new CheckinService({
        writer: checkinWriter,
        health,
        intervalMs: startOpts.intervalMs,
        timer: startOpts.timer,
      });
      service.start();
      return () => service.stop();
    },
    log: (level, message) => logWriter.write(level, message),
    wrapStore: (store) => wrapStoreWithMetrics(store, metricsWriter),
    close: () => {
      try {
        db.close();
      } catch {
        // Closing an already-closed/errored handle must never throw out of shutdown.
      }
    },
  };
}
