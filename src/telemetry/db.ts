/**
 * Shared `node:sqlite` plumbing for hivenectar's local telemetry database
 * (PRD-017, hivedoctor ADR-0001 / ADR-0002).
 *
 * ONE physical file (`~/.honeycomb/telemetry/hivenectar.sqlite` by default),
 * three tables, per the pinned Contract B shared with hivedoctor:
 *   - `service_status`  single row (id=1, latest-wins): binding time, last-seen,
 *     health, and Deep Lake connectivity (PRD-017a).
 *   - `service_metrics` single row (id=1, latest-wins): the 5 since-restart
 *     pipeline counters (PRD-017b).
 *   - `service_logs`    append-only, bounded/rotated by `logs.ts` (PRD-017c).
 *
 * Mirrors honeycomb's `daemon/runtime/logs/log-store.ts` precedent: `node:sqlite`
 * is loaded via a DYNAMIC `require` (never a top-level import), so a Node that
 * lacks the module (older than 22.5, or missing `--experimental-sqlite`) throws
 * HERE and is caught by the fail-soft facade in `index.ts` (AC-7 / AC-017a's
 * "never blocks boot or the pipeline"), rather than crashing at module load.
 *
 * WAL mode is set on open so hivedoctor's read-only poller (~1s cadence, per
 * ADR-0001) never contends with hivenectar's own writes. hivedoctor is the ONLY
 * external reader, and it opens read-only; this module is hivenectar's write
 * side only.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RUNTIME_DIR_NAME } from "../config.js";

/** The subdirectory of the runtime dir the telemetry database lives under. */
export const TELEMETRY_DIR_NAME = "telemetry";
/** The telemetry database's filename, matching hivedoctor's per-service naming (`<name>.sqlite`). */
export const TELEMETRY_DB_FILE_NAME = "hivenectar.sqlite";

/** Derive the telemetry DB path from a resolved runtime dir (keeps it alongside the pid/lock files). */
export function telemetryDbPathForRuntimeDir(runtimeDir: string): string {
  return join(runtimeDir, TELEMETRY_DIR_NAME, TELEMETRY_DB_FILE_NAME);
}

/** The default telemetry DB path: `~/.honeycomb/telemetry/hivenectar.sqlite`. */
export function defaultTelemetryDbPath(home: string = homedir()): string {
  return telemetryDbPathForRuntimeDir(join(home, RUNTIME_DIR_NAME));
}

/**
 * The minimal `node:sqlite` `DatabaseSync` surface this module uses, declared
 * structurally so callers (and tests) can inject a fake without a hard
 * `import("node:sqlite")` type dependency.
 */
export interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabaseLike;
}

/**
 * Load `node:sqlite` via a dynamic `require` (via `module.createRequire`, so it
 * works under ESM) rather than a top-level import: a Node build without the
 * module/flag throws HERE, inside the caller's try/catch, instead of crashing
 * the whole daemon bundle at load time.
 */
function loadSqlite(): SqliteModule {
  const req = createRequire(import.meta.url);
  return req("node:sqlite") as SqliteModule;
}

/**
 * Open (or create) the telemetry database at `dbPath` in WAL mode, creating all
 * three tables (idempotent, additive) if absent. Throws on any failure (missing
 * `node:sqlite`, an unwritable directory, a corrupt file, ...); the caller
 * (`index.ts`'s `createTelemetry`) catches and degrades to a no-op rather than
 * ever propagating into daemon boot or the nectar pipeline.
 */
export function openTelemetryDb(dbPath: string): SqliteDatabaseLike {
  // SECURITY (security-review finding, medium): owner-only mode, matching honeycomb's
  // fleet-store.ts precedent. Without it, the default umask on a multi-user host often
  // yields a world-readable/traversable directory, letting another local user read
  // service_logs (paths, errors, partially-redacted text) and operational metrics.
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const sqlite = loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  migrateSchema(db);
  return db;
}

/**
 * Create the three telemetry tables + the log index if absent. Column/table
 * names are fixed literal constants under our own control (never interpolated
 * user input), matching the pinned Contract B schema hivedoctor's poller reads
 * verbatim - schema drift here is a cross-repo break, not a local style choice.
 */
function migrateSchema(db: SqliteDatabaseLike): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS service_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      binding_time TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      health TEXT NOT NULL,
      deeplake_connected INTEGER,
      deeplake_last_comm TEXT
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS service_metrics (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      files_registered INTEGER NOT NULL DEFAULT 0,
      nectars_minted INTEGER NOT NULL DEFAULT 0,
      descriptions_generated INTEGER NOT NULL DEFAULT 0,
      source_graph_versions INTEGER NOT NULL DEFAULT 0,
      embeddings_computed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS service_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('error','warn','info','debug')),
      message TEXT NOT NULL
    )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_service_logs_ts ON service_logs(ts DESC)");
}
