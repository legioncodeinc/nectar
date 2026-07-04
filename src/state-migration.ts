import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { legacyRuntimeDir, nectarStateDir } from "./apiary-root.js";
import type { RuntimeConfig } from "./config.js";
import { defaultDoctorRegistryPath, registerWithDoctor } from "./doctor-registry.js";
import { DaemonAlreadyRunningError } from "./errors.js";
import { isPidAlive, readPidFile } from "./lock.js";
import { TELEMETRY_DB_FILE_NAME, TELEMETRY_DIR_NAME } from "./telemetry/db.js";

export const MIGRATION_MARKER_FILE_NAME = ".migrated-from-honeycomb.json";

export const MIGRATION_RELATIVE_PATHS: readonly string[] = [
  "nectar.json",
  "pending-reviews.json",
  "telemetry/nectar.sqlite",
  "nectar-usage-telemetry.json",
];

export interface ResolveStateReadPathOptions {
  readonly runtimeDir?: string;
  readonly legacyDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a state file for reads during the migration window.
 * New path wins; legacy path is used only when the new path is absent.
 */
export function resolveStateReadPath(relativePath: string, options: ResolveStateReadPathOptions = {}): string {
  const runtimeDir = options.runtimeDir ?? nectarStateDir(options.env ?? process.env);
  const legacyDir = options.legacyDir ?? legacyRuntimeDir();
  const preferred = join(runtimeDir, relativePath);
  if (existsSync(preferred)) return preferred;
  const legacy = join(legacyDir, relativePath);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

export interface LegacyInstanceGuardOptions {
  readonly runtimeDir: string;
  readonly pidFilePath: string;
  readonly lockFilePath: string;
  readonly legacyDir?: string;
}

/**
 * During the compatibility window, refuse boot when a legacy-path daemon PID is live.
 */
export function assertNoLegacyDaemonRunning(options: LegacyInstanceGuardOptions): void {
  const legacyDir = options.legacyDir ?? legacyRuntimeDir();
  if (options.runtimeDir === legacyDir) return;

  const legacyPidPath = join(legacyDir, basename(options.pidFilePath));
  const legacyPid = readPidFile(legacyPidPath);
  if (legacyPid === null || !isPidAlive(legacyPid)) return;

  const legacyLockPath = join(legacyDir, basename(options.lockFilePath));
  throw new DaemonAlreadyRunningError(legacyPid, legacyLockPath);
}

export interface StateMigrationOptions {
  readonly config: Pick<RuntimeConfig, "runtimeDir" | "host" | "port" | "pidFilePath">;
  readonly log?: (line: Record<string, unknown>) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowIso?: () => string;
  readonly legacyDir?: string;
  readonly migrateFile?: (sourcePath: string, targetPath: string) => void;
  readonly homeDir?: string;
}

export interface StateMigrationResult {
  readonly markerPath: string;
  readonly moved: readonly string[];
  readonly failed: readonly string[];
  readonly refreshedRegistry: boolean;
  readonly skipped: boolean;
}

function anyLegacyStateExists(legacyDir: string): boolean {
  for (const relativePath of MIGRATION_RELATIVE_PATHS) {
    if (existsSync(join(legacyDir, relativePath))) return true;
  }
  return false;
}

function copyThenRename(sourcePath: string, targetPath: string): void {
  const targetDir = dirname(targetPath);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    copyFileSync(sourcePath, tmpPath);
    renameSync(tmpPath, targetPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function writeMigrationMarker(
  markerPath: string,
  moved: readonly string[],
  failed: readonly string[],
  refreshedRegistry: boolean,
  nowIso: () => string,
): void {
  const body = {
    schemaVersion: 1,
    migratedAt: nowIso(),
    moved,
    failed,
    refreshedRegistry,
  };
  writeFileSync(markerPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * One-time additive migration from the legacy runtime dir into the new nectar state dir.
 */
export function runStateMigration(options: StateMigrationOptions): StateMigrationResult {
  const runtimeDir = options.config.runtimeDir;
  const legacyDir = options.legacyDir ?? legacyRuntimeDir();
  const markerPath = join(runtimeDir, MIGRATION_MARKER_FILE_NAME);
  const markerExists = existsSync(markerPath);
  const legacyExists = anyLegacyStateExists(legacyDir);

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  if (markerExists && !legacyExists) {
    return { markerPath, moved: [], failed: [], refreshedRegistry: false, skipped: true };
  }

  const moved: string[] = [];
  const failed: string[] = [];
  for (const relativePath of MIGRATION_RELATIVE_PATHS) {
    const sourcePath = join(legacyDir, relativePath);
    const targetPath = join(runtimeDir, relativePath);
    if (!existsSync(sourcePath) || existsSync(targetPath)) continue;

    try {
      const migrateFile = options.migrateFile ?? copyThenRename;
      migrateFile(sourcePath, targetPath);
      rmSync(sourcePath, { force: true });
      moved.push(relativePath);
      options.log?.({
        level: "info",
        scope: "state-migration",
        msg: "migrated file",
        relativePath,
        from: sourcePath,
        to: targetPath,
      });
    } catch (error) {
      failed.push(relativePath);
      options.log?.({
        level: "warn",
        scope: "state-migration",
        msg: "failed to migrate file",
        relativePath,
        from: sourcePath,
        to: targetPath,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const shouldRefreshRegistry = legacyExists || moved.length > 0 || failed.length > 0;
  let refreshedRegistry = false;
  if (shouldRefreshRegistry) {
    const registryPath = defaultDoctorRegistryPath(options.homeDir, options.env ?? process.env);
    // Advertise only what actually exists post-migration: when the telemetry
    // SQLite move FAILED and the legacy DB is still the live one, the entry
    // must point doctor at the legacy path (a pointer at a not-yet-existing
    // new path would report a missing DB for the whole retry window). Heals on
    // the retry boot that completes the move, which refreshes again.
    const telemetryDbPath = resolveStateReadPath(join(TELEMETRY_DIR_NAME, TELEMETRY_DB_FILE_NAME), {
      runtimeDir,
      legacyDir,
    });
    try {
      registerWithDoctor({
        config: {
          host: options.config.host,
          port: options.config.port,
          pidFilePath: options.config.pidFilePath,
        },
        registryPath,
        overrides: { telemetryDbPath },
      });
      refreshedRegistry = true;
    } catch (error) {
      // Boot-path fail-soft: a PRESENT-but-malformed registry file (which
      // `registerWithDoctor` refuses to clobber, and which any fleet product's
      // installer may have written) must not brick nectar's boot. Log the
      // reason loudly (path + why), skip the refresh, and keep booting. The
      // fail-loud-on-write posture is preserved for the `nectar install` verb,
      // which surfaces this same error to the operator and exits non-zero.
      options.log?.({
        level: "warn",
        scope: "state-migration",
        msg: "doctor registry refresh skipped; the registry file could not be safely edited (not clobbered)",
        registryPath,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  writeMigrationMarker(markerPath, moved, failed, refreshedRegistry, nowIso);
  return { markerPath, moved, failed, refreshedRegistry, skipped: false };
}
