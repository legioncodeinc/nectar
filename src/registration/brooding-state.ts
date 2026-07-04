/**
 * The nectar-owned brooding-state store (PRD-019b).
 *
 * Records per-project and global brooding on/off in a nectar-owned JSON file at
 * `<fleet-root>/nectar/projects.json` (fleet ADR-0003 / nectar ADR-0005). This
 * is NOT the shared `~/.deeplake/projects.json` (which carries the folder
 * bindings nectar reads for scope, per ADR-0002); nectar's own control state
 * lives under its own per-product subdirectory of the neutral fleet root,
 * created on first write, so it never depends on honeycomb being installed.
 *
 * Fail-soft loader/writer built on `node:fs` only (zero runtime dependencies,
 * mirroring `src/config-file.ts`): a missing file, malformed JSON, or a
 * non-object payload reads as defaults (global `on`, each project defaulting to
 * `on` when first seen); unknown keys warn and are skipped (forward
 * compatibility); writes are atomic (temp file + rename) and create the
 * directory on first write.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nectarStateDir } from "../apiary-root.js";

/** The nectar-owned brooding-state file name (under `<fleet-root>/nectar/`). */
export const BROODING_STATE_FILE_NAME = "projects.json";

/** The schema version this reader/writer understands. */
export const BROODING_STATE_SCHEMA_VERSION = 1 as const;

/** The global brooding switch value. `paused` is the runtime-toggleable emergency pause. */
export type GlobalBrooding = "on" | "paused";

/** A per-project brooding value. */
export type ProjectBrooding = "on" | "off";

/** The default a newly-seen bound project takes (PRD-019 index resolved decision: ON). */
export const DEFAULT_PROJECT_BROODING: ProjectBrooding = "on";

/** The default global switch value (PRD-019 index resolved decision: ON). */
export const DEFAULT_GLOBAL_BROODING: GlobalBrooding = "on";

/**
 * The effective brooding state for a project after AND-ing the global switch with
 * the per-project flag: the global pause always wins, then a per-project `off`
 * pauses, else the project is active.
 */
export type EffectiveBrooding = "active" | "paused" | "global-paused";

/** The validated brooding state (defaults when the file is missing/malformed). */
export interface BroodingState {
  readonly schemaVersion: typeof BROODING_STATE_SCHEMA_VERSION;
  readonly globalBrooding: GlobalBrooding;
  /** projectId -> per-project brooding flag. A project absent here defaults to {@link DEFAULT_PROJECT_BROODING}. */
  readonly projects: Readonly<Record<string, ProjectBrooding>>;
}

export interface BroodingStateOptions {
  /** Override the directory holding `projects.json` (default: `<fleet-root>/nectar`). */
  readonly dir?: string;
  /** Env bag for resolving the fleet root (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Warning sink (default: NDJSON to stderr). Fail-soft warnings route here. */
  readonly warn?: (message: string) => void;
}

/** Resolve the directory holding the brooding-state file (honors the test override). */
export function broodingStateDir(options: BroodingStateOptions = {}): string {
  return options.dir ?? nectarStateDir(options.env ?? process.env);
}

/** Resolve the full brooding-state file path (honors the test override). */
export function broodingStatePath(options: BroodingStateOptions = {}): string {
  return join(broodingStateDir(options), BROODING_STATE_FILE_NAME);
}

/** The defaults a missing/malformed file falls soft to. */
export function defaultBroodingState(): BroodingState {
  return { schemaVersion: BROODING_STATE_SCHEMA_VERSION, globalBrooding: DEFAULT_GLOBAL_BROODING, projects: {} };
}

function defaultWarn(message: string): void {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: "warn", scope: "brooding-state", msg: message })}\n`,
  );
}

function isGlobalBrooding(v: unknown): v is GlobalBrooding {
  return v === "on" || v === "paused";
}

function isProjectBrooding(v: unknown): v is ProjectBrooding {
  return v === "on" || v === "off";
}

/**
 * Load and validate the brooding-state file. Never throws: a missing file
 * returns the defaults silently; malformed JSON, a non-object payload, or a
 * wrong `schemaVersion` warns and returns the defaults; unknown top-level keys
 * and malformed per-project values warn and are skipped (forward compatibility).
 */
export function loadBroodingState(options: BroodingStateOptions = {}): BroodingState {
  const warn = options.warn ?? defaultWarn;
  const path = broodingStatePath(options);
  if (!existsSync(path)) return defaultBroodingState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`ignoring malformed ${path} (not valid JSON); falling back to defaults`);
    return defaultBroodingState();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`ignoring ${path} (not a JSON object); falling back to defaults`);
    return defaultBroodingState();
  }

  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== BROODING_STATE_SCHEMA_VERSION) {
    warn(`ignoring ${path} (unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}); falling back to defaults`);
    return defaultBroodingState();
  }

  let globalBrooding: GlobalBrooding = DEFAULT_GLOBAL_BROODING;
  const projects: Record<string, ProjectBrooding> = {};

  for (const key of Object.keys(record)) {
    if (key === "schemaVersion") continue;
    if (key === "globalBrooding") {
      if (isGlobalBrooding(record[key])) globalBrooding = record[key] as GlobalBrooding;
      else warn(`ignoring invalid globalBrooding ${JSON.stringify(record[key])} in ${path}`);
      continue;
    }
    if (key === "projects") {
      const raw = record[key];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        warn(`ignoring invalid projects map in ${path}`);
        continue;
      }
      for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const brooding = (value as Record<string, unknown>).brooding;
          if (isProjectBrooding(brooding)) projects[projectId] = brooding;
          else warn(`ignoring invalid brooding for project ${JSON.stringify(projectId)} in ${path}`);
        } else {
          warn(`ignoring malformed entry for project ${JSON.stringify(projectId)} in ${path}`);
        }
      }
      continue;
    }
    warn(`ignoring unknown key ${JSON.stringify(key)} in ${path}`);
  }

  return { schemaVersion: BROODING_STATE_SCHEMA_VERSION, globalBrooding, projects };
}

/** Serialize the state to the on-disk JSON shape (`{ schemaVersion, globalBrooding, projects: { id: { brooding } } }`). */
function serialize(state: BroodingState): string {
  const projects: Record<string, { brooding: ProjectBrooding }> = {};
  for (const [projectId, brooding] of Object.entries(state.projects)) {
    projects[projectId] = { brooding };
  }
  return `${JSON.stringify({ schemaVersion: BROODING_STATE_SCHEMA_VERSION, globalBrooding: state.globalBrooding, projects }, null, 2)}\n`;
}

/**
 * Atomically write the brooding state (temp file + rename), creating the
 * directory on first write. Mirrors the projection/registry write discipline.
 * Throws on a hard IO failure so the caller can preserve the prior state and
 * skip the reconcile (b-AC-6).
 */
export function writeBroodingState(state: BroodingState, options: BroodingStateOptions = {}): void {
  const path = broodingStatePath(options);
  const dir = dirname(path);
  // Create the nectar state dir owner-only (0o700), matching the other state
  // writers (state-migration `copyThenRename`, telemetry-usage `saveLedger`);
  // a default-mode mkdir would leave the runtime state dir group/other-traversable.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.${BROODING_STATE_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, serialize(state), "utf8");
  renameSync(tmpPath, path);
}

/** Resolve the effective brooding for a project id (global pause beats per-project off). */
export function effectiveBrooding(state: BroodingState, projectId: string): EffectiveBrooding {
  if (state.globalBrooding === "paused") return "global-paused";
  const project = state.projects[projectId] ?? DEFAULT_PROJECT_BROODING;
  return project === "off" ? "paused" : "active";
}

/** Return a new state with `projectId`'s brooding set to `brooding` (immutable update). */
export function withProjectBrooding(state: BroodingState, projectId: string, brooding: ProjectBrooding): BroodingState {
  return { ...state, projects: { ...state.projects, [projectId]: brooding } };
}

/** Return a new state with the global switch set to `global` (immutable update). */
export function withGlobalBrooding(state: BroodingState, global: GlobalBrooding): BroodingState {
  return { ...state, globalBrooding: global };
}
