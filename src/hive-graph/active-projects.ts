/**
 * Active-project resolution for the dormant-by-default multi-root daemon (PRD-019a).
 *
 * The daemon's brood + watch scope is the set of folder bindings read from the
 * shared `~/.deeplake/projects.json` (via `loadProjectsCache`) whose per-project
 * brooding flag is ON and whose global switch is not paused (PRD-019b), MINUS
 * any binding whose path resolves to a guarded ("pathological") root. With zero
 * such bindings the daemon is dormant: it broods nothing, watches nothing, and
 * NEVER falls back to `process.cwd()`, `$HOME`, `/`, or `System32`.
 *
 * Pure functions of their inputs (bindings snapshot, brooding state, home /
 * platform / env), so the whole resolution is unit-testable without disk.
 */
import { parse, resolve } from "node:path";
import type { FolderBinding } from "./project-scope.js";
import { effectiveBrooding, type BroodingState, type EffectiveBrooding } from "../registration/brooding-state.js";

/** A bound project resolved into the active-set view (with its effective brooding). */
export interface ResolvedProject {
  readonly projectId: string;
  readonly path: string;
  readonly brooding: EffectiveBrooding;
}

/** A bound root refused activation because it resolved to a guarded path. */
export interface RefusedProject {
  readonly projectId: string;
  readonly path: string;
  readonly reason: "pathological-root";
}

/** The full resolution: every bound project (with brooding state), the refused set, and the active subset. */
export interface ActiveProjectResolution {
  /** Every bound, non-refused project with its effective brooding state (for `/health`). */
  readonly projects: readonly ResolvedProject[];
  /** Bound roots refused for resolving to a guarded path. */
  readonly refused: readonly RefusedProject[];
  /** The subset of `projects` whose brooding is `"active"` - the daemon's brood + watch targets. */
  readonly active: readonly ResolvedProject[];
  /** True when the global switch is paused (so nothing is active regardless of per-project state). */
  readonly globalPaused: boolean;
}

export interface PathologicalRootOptions {
  /** The user's home directory (default: `os.homedir()`). Injectable for tests. */
  readonly home?: string;
  /** The platform whose root/System32 conventions apply (default: `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Env bag (for `%WINDIR%`; default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/** Normalize a path for comparison: absolute, forward-slashed, no trailing slash, case-folded on win32. */
function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const forward = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const trimmed = forward === "" ? "/" : forward;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * True when `rootPath` resolves to a guarded root that must never be brooded,
 * even when explicitly bound (defense in depth against a mis-bind, PRD-019a):
 * the user's `$HOME`, a filesystem/drive root (`/`, `C:\`), or `%WINDIR%\System32`.
 */
export function isPathologicalRoot(rootPath: string, options: PathologicalRootOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const resolved = resolve(rootPath);
  const norm = normalizeForCompare(resolved, platform);

  // Filesystem / drive root: `path.parse().root` equals the path itself.
  const rootOfPath = normalizeForCompare(parse(resolved).root === "" ? resolved : parse(resolved).root, platform);
  if (parse(resolved).root !== "" && norm === rootOfPath) return true;
  // POSIX belt-and-suspenders for an empty/`/` resolve.
  if (norm === "/" || norm === "") return true;

  // $HOME.
  if (options.home !== undefined || platform !== undefined) {
    const home = options.home;
    if (home !== undefined && home.trim() !== "" && norm === normalizeForCompare(home, platform)) return true;
  }

  // %WINDIR%\System32 (Windows Scheduled Task default cwd).
  const windir = env.WINDIR ?? env.windir;
  const systemRoot = windir !== undefined && windir.trim() !== "" ? windir : platform === "win32" ? "C:/Windows" : undefined;
  if (systemRoot !== undefined) {
    const sys32 = normalizeForCompare(`${systemRoot.replace(/\\/g, "/")}/System32`, platform);
    if (norm === sys32) return true;
  }

  return false;
}

export interface ResolveActiveProjectsInput {
  /** The folder bindings from the shared `~/.deeplake/projects.json` (via `loadProjectsCache`). */
  readonly bindings: readonly FolderBinding[];
  /** The nectar-owned brooding state (per-project + global switch). */
  readonly broodingState: BroodingState;
  /** Home directory for the pathological-root guard (default: `os.homedir()`). */
  readonly home?: string;
  /** Platform for the pathological-root guard (default: `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Env bag for the pathological-root guard (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the active-project set from the folder bindings + brooding state.
 * De-duplicates by project id (first binding wins). A binding whose path is a
 * guarded root is refused, not activated. Returns every bound (non-refused)
 * project with its effective brooding for `/health`, plus the `active` subset
 * (brooding `"active"`) the supervisor stands contexts up for.
 */
export function resolveActiveProjects(input: ResolveActiveProjectsInput): ActiveProjectResolution {
  const guardOptions: PathologicalRootOptions = {
    ...(input.home !== undefined ? { home: input.home } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  };

  const projects: ResolvedProject[] = [];
  const refused: RefusedProject[] = [];
  const seen = new Set<string>();

  for (const binding of input.bindings) {
    const projectId = binding.projectId.trim();
    if (projectId === "" || binding.path.trim() === "") continue;
    if (seen.has(projectId)) continue;
    seen.add(projectId);

    if (isPathologicalRoot(binding.path, guardOptions)) {
      refused.push({ projectId, path: binding.path, reason: "pathological-root" });
      continue;
    }
    projects.push({ projectId, path: binding.path, brooding: effectiveBrooding(input.broodingState, projectId) });
  }

  const active = projects.filter((p) => p.brooding === "active");
  return {
    projects,
    refused,
    active,
    globalPaused: input.broodingState.globalBrooding === "paused",
  };
}

/** Build the `/health` `activeProjects` slice from a resolution + a per-project watcher-state lookup. */
export function activeProjectsHealth(
  resolution: ActiveProjectResolution,
  watcherStateFor: (projectId: string) => "stopped" | "running" | "restarting" | "degraded",
): {
  count: number;
  reason: string | null;
  projects: Array<{ projectId: string; path: string; brooding: "active" | "paused" | "global-paused"; watcher: "stopped" | "running" | "restarting" | "degraded" }>;
  refused: Array<{ projectId: string; path: string; reason: string }>;
} {
  const count = resolution.active.length;
  const reason = count > 0 ? null : resolution.globalPaused ? "global-paused" : "no-active-projects";
  return {
    count,
    reason,
    projects: resolution.projects.map((p) => ({
      projectId: p.projectId,
      path: p.path,
      brooding: p.brooding,
      watcher: p.brooding === "active" ? watcherStateFor(p.projectId) : "stopped",
    })),
    refused: resolution.refused.map((r) => ({ projectId: r.projectId, path: r.path, reason: r.reason })),
  };
}
