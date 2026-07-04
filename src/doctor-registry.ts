/**
 * nectar's registry entry in doctor's daemon registry (PRD-003c).
 *
 * nectar becomes a supervised daemon by appending ONE entry to doctor's
 * registry file (`<fleet-root>/registry.json` when the fleet root exists,
 * else legacy `~/.honeycomb/doctor.daemons.json`, the schema PRD-004a
 * specifies, mirrored read-side in `doctor/src/registry.ts`). That entry
 * carries nectar's `healthUrl`, `pidPath`, `probeIntervalMs`, `startupGraceMs`,
 * and restart thresholds. At the next doctor boot, doctor reads the
 * registry and spawns one supervisor instance for nectar alongside honeycomb
 * and hive.
 *
 * Registration is a FILE EDIT at install time (PRD-003c "Registration mechanics"),
 * never a runtime call: this module does not restart doctor, does not open an
 * HTTP connection, and does not hot-reload anything. It is idempotent - re-running
 * the installer replaces nectar's own entry (keyed by `name: "nectar"`)
 * rather than appending a duplicate, and every other daemon's entry is preserved
 * byte-for-byte apart from array position.
 *
 * A PRESENT-but-malformed registry file fails loudly (this module never silently
 * clobbers a broken file it cannot safely parse), mirroring doctor's own
 * fail-loud posture for a malformed registry (`doctor/src/registry.ts`).
 * PRD-017a deliberately does NOT change this posture to match doctor's own
 * fail-soft posture for a malformed registry read - the two are intentionally
 * different (this writer refuses to clobber a broken install-time file; a
 * malformed registry read is doctor's own runtime concern, not this one).
 *
 * **Known race (PRD-018j / NEC-032).** Concurrent installs of two products
 * (for example nectar and hive) perform read-modify-write with no serialization;
 * one entry can be lost. Writes are atomic (temp file plus rename) and preserve
 * unknown top-level keys, but the read-modify-write window itself is not locked.
 *
 * PRD-017a extends this entry with `telemetryDbPath`: the absolute path to
 * nectar's runtime telemetry SQLite database (`telemetry/db.ts`,
 * `~/.apiary/nectar/telemetry/nectar.sqlite` by default), per doctor's
 * `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. It is
 * derived from `config.pidFilePath`'s directory (the same resolved runtime dir
 * `healthUrl`/`pidPath` already come from), so a test-overridden runtime dir
 * (`NECTAR_RUNTIME_DIR` / `resolveConfig({ runtimeDir })`) keeps every
 * per-daemon artifact - pid, lock, and now telemetry DB - colocated, with no
 * separate `~` round-trip needed here (same rationale as `healthUrl`/`pidPath`).
 *
 * Built-ins only: node:fs, node:os, node:path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { legacyRuntimeDir, resolveApiaryRoot } from "./apiary-root.js";
import type { RuntimeConfig } from "./config.js";
import { TELEMETRY_DB_FILE_NAME, TELEMETRY_DIR_NAME } from "./telemetry/db.js";

/** The daemon name nectar registers itself under. */
export const NECTAR_DAEMON_NAME = "nectar" as const;

/**
 * Who restarts nectar. PRD-018a (NEC-030) decides the OS service unit is the
 * single restart authority: doctor probes health and reports, but does not spawn
 * or restart nectar when an OS unit is installed. `nectar install` installs an
 * always-restart OS unit (`service/index.ts`), so the registry entry it writes
 * marks restarts as externally owned. Two contending restart authorities would,
 * via NEC-002, have each losing attempt destroy the winner's lock.
 */
export const NECTAR_RESTART_POLICY = "external" as const;
export type RestartPolicy = typeof NECTAR_RESTART_POLICY;

/**
 * One registry entry, matching the schema doctor's registry loader parses
 * (PRD-004a / `doctor/src/registry.ts`).
 */
export interface DoctorRegistryEntry {
  readonly name: string;
  readonly healthUrl: string;
  readonly pidPath: string;
  readonly probeIntervalMs: number;
  readonly startupGraceMs: number;
  readonly restartGiveUpThreshold: number;
  readonly restartCooldownMs: number;
  /**
   * Who owns restarting nectar (PRD-018a NEC-030). `"external"` marks the OS
   * service unit as the single restart authority, so doctor observes health but
   * does not spawn/restart nectar. Optional in the type only so a pre-PRD-018a
   * entry a test constructs by hand still type-checks; `buildNectarRegistryEntry`
   * always populates it.
   */
  readonly restartPolicy?: RestartPolicy;
  /**
   * The absolute path to nectar's runtime telemetry SQLite database
   * (PRD-017a), so doctor knows where to poll (read-only) for check-in
   * status, metrics, and logs. Optional in the type only so a pre-PRD-017
   * entry a test constructs by hand still type-checks; `buildNectarRegistryEntry`
   * always populates it.
   */
  readonly telemetryDbPath?: string;
}

/** doctor's per-daemon defaults nectar's entry resolves to (PRD-003c table). */
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;
export const DEFAULT_STARTUP_GRACE_MS = 60_000;
export const DEFAULT_RESTART_GIVE_UP_THRESHOLD = 3;
export const DEFAULT_RESTART_COOLDOWN_MS = 5_000;

/** Thrown when a PRESENT registry file cannot be safely parsed/edited. */
export class DoctorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorRegistryError";
  }
}

/** The default registry file location per the ADR compatibility-window contract. */
export function defaultDoctorRegistryPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const fleetRoot = resolveApiaryRoot(env, { home });
  if (existsSync(fleetRoot)) return join(fleetRoot, "registry.json");
  return join(legacyRuntimeDir(home), "doctor.daemons.json");
}

/**
 * Build nectar's registry entry from its resolved {@link RuntimeConfig}
 * (PRD-003c table): `healthUrl`/`pidPath` come from nectar's own runtime
 * config (already home-expanded, so no `~` round-trip is needed here); the
 * remaining fields are doctor's per-daemon defaults unless overridden.
 *
 * `telemetryDbPath` (PRD-017a) defaults to `<runtimeDir>/telemetry/nectar.sqlite`,
 * where `runtimeDir` is `pidFilePath`'s own directory - the same resolved
 * runtime dir every other per-daemon artifact already lives under, so a
 * test-overridden runtime dir keeps pid/lock/telemetry colocated automatically.
 */
export function buildNectarRegistryEntry(
  config: Pick<RuntimeConfig, "host" | "port" | "pidFilePath">,
  overrides: Partial<
    Pick<
      DoctorRegistryEntry,
      "probeIntervalMs" | "startupGraceMs" | "restartGiveUpThreshold" | "restartCooldownMs" | "telemetryDbPath"
    >
  > = {},
): DoctorRegistryEntry {
  const runtimeDir = dirname(config.pidFilePath);
  return {
    name: NECTAR_DAEMON_NAME,
    healthUrl: `http://${config.host}:${config.port}/health`,
    pidPath: config.pidFilePath,
    probeIntervalMs: overrides.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    startupGraceMs: overrides.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS,
    restartGiveUpThreshold: overrides.restartGiveUpThreshold ?? DEFAULT_RESTART_GIVE_UP_THRESHOLD,
    restartCooldownMs: overrides.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS,
    // PRD-018a NEC-030: the OS service unit is the single restart authority.
    restartPolicy: NECTAR_RESTART_POLICY,
    telemetryDbPath: overrides.telemetryDbPath ?? join(runtimeDir, TELEMETRY_DIR_NAME, TELEMETRY_DB_FILE_NAME),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** The result of reading whatever is currently on disk at the registry path. */
interface ExistingRegistry {
  /** False when the file was ABSENT (PRD-003c: the installer then creates it fresh). */
  readonly fileExisted: boolean;
  /** The parsed root object (empty when the file was absent). */
  readonly root: Record<string, unknown>;
  /** The parsed `daemons` array (empty when the file was absent or had none). */
  readonly daemons: unknown[];
}

/**
 * Read the registry file's raw `daemons` array. A PRESENT-but-malformed file
 * (unparseable JSON, not an object, or a `daemons` field that is not an array)
 * throws {@link DoctorRegistryError} rather than being silently overwritten -
 * a real misconfiguration must not be clobbered by an installer.
 */
function readExistingRegistry(registryPath: string): ExistingRegistry {
  let contents: string;
  try {
    contents = readFileSync(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { fileExisted: false, root: {}, daemons: [] };
    }
    throw new DoctorRegistryError(
      `could not read the doctor registry at ${registryPath}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new DoctorRegistryError(
      `the doctor registry at ${registryPath} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new DoctorRegistryError(
      `the doctor registry at ${registryPath} must be a JSON object with a "daemons" array`,
    );
  }
  const daemons = parsed.daemons;
  if (daemons === undefined) return { fileExisted: true, root: { ...parsed }, daemons: [] };
  if (!Array.isArray(daemons)) {
    throw new DoctorRegistryError(`the doctor registry at ${registryPath} has a non-array "daemons" field`);
  }
  return { fileExisted: true, root: { ...parsed }, daemons };
}

/**
 * Serialize and write the registry atomically (temp + rename in the same
 * directory), mirroring `projection/write.ts:56-73`.
 */
function writeRegistryAtomic(registryPath: string, root: Record<string, unknown>): void {
  const dir = dirname(registryPath);
  mkdirSync(dir, { recursive: true });

  const baseName = basename(registryPath);
  const tmpPath = join(dir, `.${baseName}.${process.pid}.${Date.now()}.tmp`);

  // Known limitation (PRD-018j / NEC-032): concurrent installs of two products
  // perform read-modify-write with no serialization; one entry can be lost.
  writeFileSync(tmpPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  renameSync(tmpPath, registryPath);
}

/** True iff a raw (unvalidated) registry entry names nectar. */
function isNectarEntry(raw: unknown): boolean {
  return isRecord(raw) && raw.name === NECTAR_DAEMON_NAME;
}

export interface RegisterWithDoctorOptions {
  /** nectar's runtime config (supplies healthUrl + pidPath). */
  readonly config: Pick<RuntimeConfig, "host" | "port" | "pidFilePath">;
  /** Override the registry file path (default: {@link defaultDoctorRegistryPath}). */
  readonly registryPath?: string;
  /** Override the entry's per-daemon fields (default: doctor's built-in defaults). */
  readonly overrides?: Partial<
    Pick<
      DoctorRegistryEntry,
      "probeIntervalMs" | "startupGraceMs" | "restartGiveUpThreshold" | "restartCooldownMs" | "telemetryDbPath"
    >
  >;
}

export interface RegisterWithDoctorResult {
  /** The path the registry file was written to. */
  readonly registryPath: string;
  /** The entry that was written for nectar. */
  readonly entry: DoctorRegistryEntry;
  /** True when the registry file did not exist and was created fresh. */
  readonly created: boolean;
  /** True when an existing nectar entry was replaced (idempotent re-install). */
  readonly replaced: boolean;
}

/**
 * Append (or idempotently replace) nectar's entry in doctor's registry
 * file (PRD-003c US-003c.1). Every OTHER daemon's entry is preserved unchanged.
 * Does NOT restart doctor and does NOT touch anything besides this one file -
 * the entry takes effect at doctor's next natural boot (PRD-003c Non-Goals).
 */
export function registerWithDoctor(
  options: RegisterWithDoctorOptions,
): RegisterWithDoctorResult {
  const registryPath = options.registryPath ?? defaultDoctorRegistryPath();
  const entry = buildNectarRegistryEntry(options.config, options.overrides);

  const { fileExisted, root, daemons: existing } = readExistingRegistry(registryPath);
  const replaced = existing.some(isNectarEntry);
  const kept = existing.filter((raw) => !isNectarEntry(raw));
  const updatedRoot = { ...root, daemons: [...kept, entry] };

  writeRegistryAtomic(registryPath, updatedRoot);

  return { registryPath, entry, created: !fileExisted, replaced };
}
