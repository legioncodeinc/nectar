/**
 * Runtime configuration resolution for the nectar daemon.
 *
 * Resolution precedence (mirrors honeycomb's `resolveRuntimeConfig`,
 * honeycomb/src/daemon/runtime/config.ts:143): explicit overrides -> environment
 * -> built-in defaults. Every default below is flagged in PRD-001b / PRD-002a as
 * "DEFAULT - confirm before implementation" and is centralized here so the whole
 * daemon reads one contract.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

/** The `~/.honeycomb` runtime dir convention shared with honeycomb + doctor. */
export const RUNTIME_DIR_NAME = ".honeycomb";

/** nectar's loopback port. 3850 honeycomb, 3851 embeddings, 3852 doctor status, 3853 hive are occupied (PRD-001b). */
export const DEFAULT_PORT = 3854;

/** Loopback-only, mirroring honeycomb's posture (honeycomb/embeddings/src/index.ts EMBED_HOST). */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * True when `host` is a loopback bind address (PRD-018j startup gate). Accepts
 * `127.0.0.0/8`, `::1`, `[::1]`, and the literal `localhost`.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (h.startsWith("127.")) return true;
  return false;
}

/** Worker poll floor: the enricher's 30s cadence (ai/enricher-and-llm-model.md). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Distinct from honeycomb's `daemon.pid`/`daemon.lock` so both daemons coexist in ~/.honeycomb (PRD-002d). */
export const DEFAULT_PID_FILE_NAME = "nectar.pid";
export const DEFAULT_LOCK_FILE_NAME = "nectar.lock";

/** Valid TCP port range for `NECTAR_PORT` (0 is only reachable via an explicit override for ephemeral test binds). */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;

/**
 * Floor for `NECTAR_POLL_INTERVAL_MS`. Below this a misconfigured interval (e.g.
 * `0`) degrades into a 1 ms tight poll (`poll-loop.ts` clamps to `>= 1`), which
 * pegs a CPU. One second is safely below the 30 s default cadence yet high
 * enough to rule out a runaway loop.
 */
export const MIN_POLL_INTERVAL_MS = 1_000;

export interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly runtimeDir: string;
  readonly pidFilePath: string;
  readonly lockFilePath: string;
  readonly pollIntervalMs: number;
}

export interface RuntimeConfigOverrides {
  readonly host?: string;
  readonly port?: number;
  readonly runtimeDir?: string;
  readonly pidFileName?: string;
  readonly lockFileName?: string;
  readonly pollIntervalMs?: number;
}

/**
 * Read an integer env var STRICTLY (daemon-api review L6): the whole trimmed
 * value must be an integer (no `3854abc` trailing garbage), and it must fall in
 * `[min, max]`. Anything else throws a {@link ConfigError} with a clear message
 * at startup, rather than silently truncating (`parseInt` behavior) or letting
 * an out-of-range value surface as an opaque `listen()` bind error or a tight
 * poll. Unset or blank returns `undefined` so the caller falls back to a default.
 */
function envInt(name: string, bounds: { readonly min: number; readonly max?: number }): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${name} is not a safe integer: ${JSON.stringify(raw)}`);
  }
  const { min, max } = bounds;
  if (parsed < min || (max !== undefined && parsed > max)) {
    const range = max !== undefined ? `${min}-${max}` : `>= ${min}`;
    throw new ConfigError(`${name} must be ${range}, got ${parsed}`);
  }
  return parsed;
}

/** Read a string env var, treating unset OR blank/whitespace-only as absent (so it falls back to the default). */
function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

/**
 * Resolve the runtime config. Overrides win, then env, then defaults. The env
 * layer keeps the daemon operable without a config file; overrides exist so
 * tests can point the daemon at an ephemeral port and a temp runtime dir.
 */
export function resolveConfig(overrides: RuntimeConfigOverrides = {}): RuntimeConfig {
  const runtimeDir =
    overrides.runtimeDir ??
    envStr("NECTAR_RUNTIME_DIR") ??
    join(homedir(), RUNTIME_DIR_NAME);

  const host = overrides.host ?? envStr("NECTAR_HOST") ?? DEFAULT_HOST;
  const port = overrides.port ?? envInt("NECTAR_PORT", { min: MIN_PORT, max: MAX_PORT }) ?? DEFAULT_PORT;
  const pollIntervalMs =
    overrides.pollIntervalMs ??
    envInt("NECTAR_POLL_INTERVAL_MS", { min: MIN_POLL_INTERVAL_MS }) ??
    DEFAULT_POLL_INTERVAL_MS;

  const pidFilePath = join(runtimeDir, overrides.pidFileName ?? DEFAULT_PID_FILE_NAME);
  const lockFilePath = join(runtimeDir, overrides.lockFileName ?? DEFAULT_LOCK_FILE_NAME);

  return { host, port, runtimeDir, pidFilePath, lockFilePath, pollIntervalMs };
}
