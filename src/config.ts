/**
 * Runtime configuration resolution for the hivenectar daemon.
 *
 * Resolution precedence (mirrors honeycomb's `resolveRuntimeConfig`,
 * honeycomb/src/daemon/runtime/config.ts:143): explicit overrides -> environment
 * -> built-in defaults. Every default below is flagged in PRD-001b / PRD-002a as
 * "DEFAULT - confirm before implementation" and is centralized here so the whole
 * daemon reads one contract.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The `~/.honeycomb` runtime dir convention shared with honeycomb + hivedoctor. */
export const RUNTIME_DIR_NAME = ".honeycomb";

/** hivenectar's loopback port. 3850 honeycomb, 3851 embeddings, 3852 hivedoctor status, 3853 thehive are occupied (PRD-001b). */
export const DEFAULT_PORT = 3854;

/** Loopback-only, mirroring honeycomb's posture (honeycomb/embeddings/src/index.ts EMBED_HOST). */
export const DEFAULT_HOST = "127.0.0.1";

/** Worker poll floor: the enricher's 30s cadence (ai/enricher-and-llm-model.md). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Distinct from honeycomb's `daemon.pid`/`daemon.lock` so both daemons coexist in ~/.honeycomb (PRD-002d). */
export const DEFAULT_PID_FILE_NAME = "hivenectar.pid";
export const DEFAULT_LOCK_FILE_NAME = "hivenectar.lock";

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

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    envStr("HIVENECTAR_RUNTIME_DIR") ??
    join(homedir(), RUNTIME_DIR_NAME);

  const host = overrides.host ?? envStr("HIVENECTAR_HOST") ?? DEFAULT_HOST;
  const port = overrides.port ?? envInt("HIVENECTAR_PORT") ?? DEFAULT_PORT;
  const pollIntervalMs =
    overrides.pollIntervalMs ??
    envInt("HIVENECTAR_POLL_INTERVAL_MS") ??
    DEFAULT_POLL_INTERVAL_MS;

  const pidFilePath = join(runtimeDir, overrides.pidFileName ?? DEFAULT_PID_FILE_NAME);
  const lockFilePath = join(runtimeDir, overrides.lockFileName ?? DEFAULT_LOCK_FILE_NAME);

  return { host, port, runtimeDir, pidFilePath, lockFilePath, pollIntervalMs };
}
