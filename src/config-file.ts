/**
 * The `~/.honeycomb/nectar.json` per-repo config-file loader (PRD-018k / NEC-041).
 *
 * Two knowledge docs promise a per-repo config file carrying tunables the
 * enricher and the recall path read: the enricher's redescribe threshold
 * (`ai/enricher-and-llm-model.md`) and the recall multiplier
 * (`data/recall-integration.md`). This module is the small, fail-soft loader
 * that makes that promise real.
 *
 * Precedence (documented in both knowledge docs): environment variables win
 * over the file, and the file wins over the code defaults. Consumers apply
 * their own code default when both the env var and the file value are absent,
 * so this module returns only what was actually configured.
 *
 * Fail-soft by design: a missing file is silent (returns nothing configured);
 * a malformed file, a non-object payload, or a wrong-typed value logs a warning
 * and is ignored (the daemon never crashes over a config typo); an unknown key
 * logs a warning and is skipped (forward compatibility). Node built-ins only,
 * zero runtime dependencies (AGENTS.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RUNTIME_DIR_NAME } from "./config.js";

/** The config file name within the runtime dir (`~/.honeycomb/nectar.json`). */
export const NECTAR_CONFIG_FILE_NAME = "nectar.json";

/** Environment override for the enricher redescribe threshold (wins over the file). */
export const ENV_REDESCRIBE_THRESHOLD = "NECTAR_REDESCRIBE_THRESHOLD";

/** Environment override for the recall RRF multiplier (wins over the file). */
export const ENV_RECALL_MULTIPLIER = "NECTAR_RECALL_MULTIPLIER";

/** The file key for the enricher redescribe threshold. */
export const FILE_KEY_REDESCRIBE_THRESHOLD = "redescribe_threshold";

/** The file key for the recall RRF multiplier. */
export const FILE_KEY_RECALL_MULTIPLIER = "nectar_rrf_multiplier";

/** The closed set of keys the loader understands; anything else warns and is ignored. */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  FILE_KEY_REDESCRIBE_THRESHOLD,
  FILE_KEY_RECALL_MULTIPLIER,
];

/** The tunables the config file may carry. Only present when actually configured. */
export interface NectarFileConfig {
  /** Enricher cosmetic-change redescribe threshold (Jaccard). */
  readonly redescribeThreshold?: number;
  /** Recall RRF multiplier (the `nectar_rrf_multiplier` knob). */
  readonly recallMultiplier?: number;
}

/** The resolved tunables after applying env-over-file precedence (still optional; consumers default). */
export interface NectarTunables {
  /** `NECTAR_REDESCRIBE_THRESHOLD` env, else the file's `redescribe_threshold`, else undefined. */
  readonly redescribeThreshold?: number;
  /** `NECTAR_RECALL_MULTIPLIER` env, else the file's `nectar_rrf_multiplier`, else undefined. */
  readonly recallMultiplier?: number;
}

/** Options for {@link loadNectarFileConfig} / {@link resolveNectarTunables} (all injectable for tests). */
export interface NectarConfigOptions {
  /** Override the runtime dir holding `nectar.json` (default: `~/.honeycomb`). */
  readonly dir?: string;
  /** Env bag for the precedence layer (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Warning sink (default: NDJSON to stderr). Fail-soft warnings route here. */
  readonly warn?: (message: string) => void;
}

/** The full `~/.honeycomb/nectar.json` path, honoring the test dir override. */
export function nectarConfigPath(options: NectarConfigOptions = {}): string {
  const dir = options.dir ?? join(homedir(), RUNTIME_DIR_NAME);
  return join(dir, NECTAR_CONFIG_FILE_NAME);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "warn", scope: "config-file", msg: message })}\n`);
}

/** Coerce a raw JSON value to a finite number, or undefined when it is not one. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Load and validate `~/.honeycomb/nectar.json`. Never throws: a missing file
 * returns `{}` silently; a malformed/non-object file or a wrong-typed known
 * value warns and is dropped; an unknown key warns and is skipped. Only the
 * two spec'd tunables are read.
 */
export function loadNectarFileConfig(options: NectarConfigOptions = {}): NectarFileConfig {
  const warn = options.warn ?? defaultWarn;
  const path = nectarConfigPath(options);
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`ignoring malformed ${path} (not valid JSON); falling back to env/defaults`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`ignoring ${path} (not a JSON object); falling back to env/defaults`);
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const result: { redescribeThreshold?: number; recallMultiplier?: number } = {};

  for (const key of Object.keys(record)) {
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      warn(`ignoring unknown key ${JSON.stringify(key)} in ${path}`);
      continue;
    }
    if (key === FILE_KEY_REDESCRIBE_THRESHOLD) {
      const n = asFiniteNumber(record[key]);
      if (n === undefined) warn(`ignoring non-numeric ${FILE_KEY_REDESCRIBE_THRESHOLD} in ${path}`);
      else result.redescribeThreshold = n;
    } else if (key === FILE_KEY_RECALL_MULTIPLIER) {
      const n = asFiniteNumber(record[key]);
      if (n === undefined) warn(`ignoring non-numeric ${FILE_KEY_RECALL_MULTIPLIER} in ${path}`);
      else result.recallMultiplier = n;
    }
  }

  return result;
}

/** Read a finite-number env var, warning (and ignoring) a set-but-unparseable value. */
function envNumber(env: NodeJS.ProcessEnv, name: string, warn: (m: string) => void): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    warn(`ignoring non-numeric ${name}=${JSON.stringify(raw)}; falling back to the file/default`);
    return undefined;
  }
  return n;
}

/**
 * Resolve the tunables with env-over-file precedence (env wins, then the file,
 * then the caller's own code default when both are absent). Returns only what
 * was configured; a value the caller does not find here should fall back to its
 * built-in default.
 */
export function resolveNectarTunables(options: NectarConfigOptions = {}): NectarTunables {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const file = loadNectarFileConfig(options);

  const redescribeThreshold = envNumber(env, ENV_REDESCRIBE_THRESHOLD, warn) ?? file.redescribeThreshold;
  const recallMultiplier = envNumber(env, ENV_RECALL_MULTIPLIER, warn) ?? file.recallMultiplier;

  const out: { redescribeThreshold?: number; recallMultiplier?: number } = {};
  if (redescribeThreshold !== undefined) out.redescribeThreshold = redescribeThreshold;
  if (recallMultiplier !== undefined) out.recallMultiplier = recallMultiplier;
  return out;
}
