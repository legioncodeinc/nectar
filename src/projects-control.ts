/**
 * The reusable projects + brooding-control core (PRD-019b).
 *
 * One place that composes the shared `~/.deeplake/projects.json` bindings, the
 * nectar-owned brooding state, and the active-set resolution into the read view
 * the `GET /api/hive-graph/projects` endpoint and the `nectar projects` CLI both
 * render, plus the persist helpers the `POST .../projects/brooding` endpoint and
 * the `nectar brooding` CLI both call. Pure of HTTP/CLI concerns so both surfaces
 * produce the identical persisted + reconciled effect (b-AC-7).
 */
import { loadProjectsCache, type ProjectsCache } from "./hive-graph/project-scope.js";
import {
  loadBroodingState,
  writeBroodingState,
  withGlobalBrooding,
  withProjectBrooding,
  type BroodingState,
  type BroodingStateOptions,
  type GlobalBrooding,
  type ProjectBrooding,
} from "./registration/brooding-state.js";
import { resolveActiveProjects, type ActiveProjectResolution } from "./hive-graph/active-projects.js";
import type { WatcherState } from "./registration/fs-watch.js";

/** The global switch value as surfaced to the dashboard. */
export type GlobalBroodingView = GlobalBrooding;

/** One project's row in the read view (PRD-019b GET /projects shape). */
export interface ProjectBroodingEntry {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly brooding: "active" | "paused" | "global-paused";
  readonly watcher: WatcherState;
  /**
   * Per-project brood/enrich counts. Reserved for a later per-project counts
   * surface; the current daemon tracks brood counts globally, so this is `null`
   * (honest) rather than a fabricated per-project number.
   */
  readonly counts: null;
}

/** The `GET /api/hive-graph/projects` (and `nectar projects`) read view. */
export interface ProjectsView {
  readonly globalBrooding: GlobalBroodingView;
  readonly projects: readonly ProjectBroodingEntry[];
}

export interface ProjectsControlOptions {
  /** Override the `~/.deeplake` cache dir (tests). */
  readonly cacheDir?: string;
  /** Tenancy guard for the shared cache (org/workspace the daemon authenticated as). */
  readonly expect?: { org: string; workspace: string };
  /** Override the brooding-state file location (tests). */
  readonly broodingState?: BroodingStateOptions;
  /** Home for the pathological-root guard (default: `os.homedir()`). */
  readonly home?: string;
  /** Platform for the pathological-root guard (default: `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Env for the pathological-root guard (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/** Load the bindings + brooding state and resolve the active set. */
export function readActiveProjects(options: ProjectsControlOptions = {}): {
  readonly resolution: ActiveProjectResolution;
  readonly cache: ProjectsCache;
  readonly state: BroodingState;
} {
  const cache = loadProjectsCache({
    ...(options.cacheDir !== undefined ? { dir: options.cacheDir } : {}),
    ...(options.expect !== undefined ? { expect: options.expect } : {}),
  });
  const state = loadBroodingState(options.broodingState ?? {});
  const resolution = resolveActiveProjects({
    bindings: cache.bindings,
    broodingState: state,
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  return { resolution, cache, state };
}

/** Build the read view from a resolution + cache + a per-project watcher-state lookup. */
export function buildProjectsView(
  resolution: ActiveProjectResolution,
  cache: ProjectsCache,
  watcherStateFor: (projectId: string) => WatcherState,
): ProjectsView {
  const nameById = new Map(cache.projects.map((p) => [p.projectId, p.name] as const));
  return {
    globalBrooding: resolution.globalPaused ? "paused" : "on",
    projects: resolution.projects.map((p) => ({
      projectId: p.projectId,
      name: nameById.get(p.projectId) ?? "",
      path: p.path,
      brooding: p.brooding,
      watcher: p.brooding === "active" ? watcherStateFor(p.projectId) : "stopped",
      counts: null,
    })),
  };
}

/**
 * Persist a per-project brooding flag (atomic write). Throws on a write failure
 * so the caller preserves the prior state and skips the reconcile (b-AC-6).
 * Returns the new state.
 */
export function persistProjectBrooding(
  projectId: string,
  brooding: ProjectBrooding,
  options: ProjectsControlOptions = {},
): BroodingState {
  const state = loadBroodingState(options.broodingState ?? {});
  const next = withProjectBrooding(state, projectId, brooding);
  writeBroodingState(next, options.broodingState ?? {});
  return next;
}

/** Persist the global switch (atomic write). Throws on a write failure (b-AC-6). Returns the new state. */
export function persistGlobalBrooding(
  global: GlobalBrooding,
  options: ProjectsControlOptions = {},
): BroodingState {
  const state = loadBroodingState(options.broodingState ?? {});
  const next = withGlobalBrooding(state, global);
  writeBroodingState(next, options.broodingState ?? {});
  return next;
}
