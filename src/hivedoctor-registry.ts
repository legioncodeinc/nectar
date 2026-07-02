/**
 * hivenectar's registry entry in hivedoctor's daemon registry (PRD-003c).
 *
 * hivenectar becomes a supervised daemon by appending ONE entry to hivedoctor's
 * registry file (`~/.honeycomb/hivedoctor.daemons.json`, the schema PRD-004a
 * specifies, mirrored read-side in `hivedoctor/src/registry.ts`). That entry
 * carries hivenectar's `healthUrl`, `pidPath`, `probeIntervalMs`, `startupGraceMs`,
 * and restart thresholds. At the next hivedoctor boot, hivedoctor reads the
 * registry and spawns one supervisor instance for hivenectar alongside honeycomb
 * and thehive.
 *
 * Registration is a FILE EDIT at install time (PRD-003c "Registration mechanics"),
 * never a runtime call: this module does not restart hivedoctor, does not open an
 * HTTP connection, and does not hot-reload anything. It is idempotent - re-running
 * the installer replaces hivenectar's own entry (keyed by `name: "hivenectar"`)
 * rather than appending a duplicate, and every other daemon's entry is preserved
 * byte-for-byte apart from array position.
 *
 * A PRESENT-but-malformed registry file fails loudly (this module never silently
 * clobbers a broken file it cannot safely parse), mirroring hivedoctor's own
 * fail-loud posture for a malformed registry (`hivedoctor/src/registry.ts`).
 * PRD-017a deliberately does NOT change this posture to match hivedoctor's own
 * fail-soft posture for a malformed registry read - the two are intentionally
 * different (this writer refuses to clobber a broken install-time file; a
 * malformed registry read is hivedoctor's own runtime concern, not this one).
 *
 * PRD-017a extends this entry with `telemetryDbPath`: the absolute path to
 * hivenectar's runtime telemetry SQLite database (`telemetry/db.ts`,
 * `~/.honeycomb/telemetry/hivenectar.sqlite` by default), per hivedoctor's
 * `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. It is
 * derived from `config.pidFilePath`'s directory (the same resolved runtime dir
 * `healthUrl`/`pidPath` already come from), so a test-overridden runtime dir
 * (`HIVENECTAR_RUNTIME_DIR` / `resolveConfig({ runtimeDir })`) keeps every
 * per-daemon artifact - pid, lock, and now telemetry DB - colocated, with no
 * separate `~` round-trip needed here (same rationale as `healthUrl`/`pidPath`).
 *
 * Built-ins only: node:fs, node:os, node:path.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "./config.js";
import { TELEMETRY_DB_FILE_NAME, TELEMETRY_DIR_NAME } from "./telemetry/db.js";

/** The daemon name hivenectar registers itself under. */
export const HIVENECTAR_DAEMON_NAME = "hivenectar" as const;

/**
 * One registry entry, matching the schema hivedoctor's registry loader parses
 * (PRD-004a / `hivedoctor/src/registry.ts`).
 */
export interface HivedoctorRegistryEntry {
  readonly name: string;
  readonly healthUrl: string;
  readonly pidPath: string;
  readonly probeIntervalMs: number;
  readonly startupGraceMs: number;
  readonly restartGiveUpThreshold: number;
  readonly restartCooldownMs: number;
  /**
   * The absolute path to hivenectar's runtime telemetry SQLite database
   * (PRD-017a), so hivedoctor knows where to poll (read-only) for check-in
   * status, metrics, and logs. Optional in the type only so a pre-PRD-017
   * entry a test constructs by hand still type-checks; `buildHivenectarRegistryEntry`
   * always populates it.
   */
  readonly telemetryDbPath?: string;
}

/** hivedoctor's per-daemon defaults hivenectar's entry resolves to (PRD-003c table). */
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;
export const DEFAULT_STARTUP_GRACE_MS = 60_000;
export const DEFAULT_RESTART_GIVE_UP_THRESHOLD = 3;
export const DEFAULT_RESTART_COOLDOWN_MS = 5_000;

/** Thrown when a PRESENT registry file cannot be safely parsed/edited. */
export class HivedoctorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HivedoctorRegistryError";
  }
}

/** The default registry file location, alongside the other `~/.honeycomb` artifacts. */
export function defaultHivedoctorRegistryPath(home: string = homedir()): string {
  return join(home, ".honeycomb", "hivedoctor.daemons.json");
}

/**
 * Build hivenectar's registry entry from its resolved {@link RuntimeConfig}
 * (PRD-003c table): `healthUrl`/`pidPath` come from hivenectar's own runtime
 * config (already home-expanded, so no `~` round-trip is needed here); the
 * remaining fields are hivedoctor's per-daemon defaults unless overridden.
 *
 * `telemetryDbPath` (PRD-017a) defaults to `<runtimeDir>/telemetry/hivenectar.sqlite`,
 * where `runtimeDir` is `pidFilePath`'s own directory - the same resolved
 * runtime dir every other per-daemon artifact already lives under, so a
 * test-overridden runtime dir keeps pid/lock/telemetry colocated automatically.
 */
export function buildHivenectarRegistryEntry(
  config: Pick<RuntimeConfig, "host" | "port" | "pidFilePath">,
  overrides: Partial<
    Pick<
      HivedoctorRegistryEntry,
      "probeIntervalMs" | "startupGraceMs" | "restartGiveUpThreshold" | "restartCooldownMs" | "telemetryDbPath"
    >
  > = {},
): HivedoctorRegistryEntry {
  const runtimeDir = dirname(config.pidFilePath);
  return {
    name: HIVENECTAR_DAEMON_NAME,
    healthUrl: `http://${config.host}:${config.port}/health`,
    pidPath: config.pidFilePath,
    probeIntervalMs: overrides.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    startupGraceMs: overrides.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS,
    restartGiveUpThreshold: overrides.restartGiveUpThreshold ?? DEFAULT_RESTART_GIVE_UP_THRESHOLD,
    restartCooldownMs: overrides.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS,
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
  /** The parsed `daemons` array (empty when the file was absent or had none). */
  readonly daemons: unknown[];
}

/**
 * Read the registry file's raw `daemons` array. A PRESENT-but-malformed file
 * (unparseable JSON, not an object, or a `daemons` field that is not an array)
 * throws {@link HivedoctorRegistryError} rather than being silently overwritten -
 * a real misconfiguration must not be clobbered by an installer.
 */
function readExistingRegistry(registryPath: string): ExistingRegistry {
  let contents: string;
  try {
    contents = readFileSync(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fileExisted: false, daemons: [] };
    throw new HivedoctorRegistryError(
      `could not read the hivedoctor registry at ${registryPath}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new HivedoctorRegistryError(
      `the hivedoctor registry at ${registryPath} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new HivedoctorRegistryError(
      `the hivedoctor registry at ${registryPath} must be a JSON object with a "daemons" array`,
    );
  }
  const daemons = parsed.daemons;
  if (daemons === undefined) return { fileExisted: true, daemons: [] };
  if (!Array.isArray(daemons)) {
    throw new HivedoctorRegistryError(`the hivedoctor registry at ${registryPath} has a non-array "daemons" field`);
  }
  return { fileExisted: true, daemons };
}

/** True iff a raw (unvalidated) registry entry names hivenectar. */
function isHivenectarEntry(raw: unknown): boolean {
  return isRecord(raw) && raw.name === HIVENECTAR_DAEMON_NAME;
}

export interface RegisterWithHivedoctorOptions {
  /** hivenectar's runtime config (supplies healthUrl + pidPath). */
  readonly config: Pick<RuntimeConfig, "host" | "port" | "pidFilePath">;
  /** Override the registry file path (default: {@link defaultHivedoctorRegistryPath}). */
  readonly registryPath?: string;
  /** Override the entry's per-daemon fields (default: hivedoctor's built-in defaults). */
  readonly overrides?: Partial<
    Pick<
      HivedoctorRegistryEntry,
      "probeIntervalMs" | "startupGraceMs" | "restartGiveUpThreshold" | "restartCooldownMs" | "telemetryDbPath"
    >
  >;
}

export interface RegisterWithHivedoctorResult {
  /** The path the registry file was written to. */
  readonly registryPath: string;
  /** The entry that was written for hivenectar. */
  readonly entry: HivedoctorRegistryEntry;
  /** True when the registry file did not exist and was created fresh. */
  readonly created: boolean;
  /** True when an existing hivenectar entry was replaced (idempotent re-install). */
  readonly replaced: boolean;
}

/**
 * Append (or idempotently replace) hivenectar's entry in hivedoctor's registry
 * file (PRD-003c US-003c.1). Every OTHER daemon's entry is preserved unchanged.
 * Does NOT restart hivedoctor and does NOT touch anything besides this one file -
 * the entry takes effect at hivedoctor's next natural boot (PRD-003c Non-Goals).
 */
export function registerWithHivedoctor(
  options: RegisterWithHivedoctorOptions,
): RegisterWithHivedoctorResult {
  const registryPath = options.registryPath ?? defaultHivedoctorRegistryPath();
  const entry = buildHivenectarRegistryEntry(options.config, options.overrides);

  const { fileExisted, daemons: existing } = readExistingRegistry(registryPath);
  const replaced = existing.some(isHivenectarEntry);
  const kept = existing.filter((raw) => !isHivenectarEntry(raw));
  const daemons = [...kept, entry];

  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify({ daemons }, null, 2)}\n`, "utf8");

  return { registryPath, entry, created: !fileExisted, replaced };
}
