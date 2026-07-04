/**
 * The multi-root project supervisor (PRD-019a).
 *
 * Owns a `Map<projectId, RunningContext>` and reconciles it against the active
 * set on demand (the daemon's poll cadence + the 019b toggle API). A newly
 * active project is started (hydrate mirror, start watcher, request cold-catch-up
 * resync, arm auto-brood); a newly inactive one is stopped and drained; the
 * daemon never restarts. Reconciles are serialized so two overlapping cycles
 * never double-start a context.
 *
 * The supervisor is deliberately generic: the per-project `RunningContext` and
 * how it is built are injected via a {@link ProjectContextFactory}, so the
 * reconcile logic is unit-testable with fakes and the live daemon wires the real
 * registration + brood context.
 */
import type { WatcherState } from "./registration/fs-watch.js";
import type { ResolvedProject } from "./hive-graph/active-projects.js";

/** One project's running brood + watch context. `start`/`stop` are idempotent from the supervisor's view. */
export interface RunningContext {
  readonly projectId: string;
  readonly path: string;
  /** The current watcher liveness for the `/health` slice. */
  watcherState(): WatcherState;
  /** Hydrate the mirror, start the watcher, request the cold-catch-up resync, arm auto-brood. */
  start(): Promise<void>;
  /** Stop the watcher and drain bridge writes before the context is released (a-AC-7). */
  stop(): Promise<void>;
}

/** Build a {@link RunningContext} for a project (does NOT start it; the supervisor calls `start`). */
export type ProjectContextFactory = (project: ResolvedProject) => RunningContext;

export interface ProjectSupervisorOptions {
  readonly factory: ProjectContextFactory;
  /** Observe a context start/stop failure (never throws out of reconcile). Default: no-op. */
  readonly onError?: (scope: "start" | "stop", projectId: string, err: unknown) => void;
}

/** The outcome of one reconcile pass (for logging/tests). */
export interface ReconcileOutcome {
  readonly started: readonly string[];
  readonly stopped: readonly string[];
}

export class ProjectSupervisor {
  private readonly factory: ProjectContextFactory;
  private readonly onError: (scope: "start" | "stop", projectId: string, err: unknown) => void;
  private readonly contextsById = new Map<string, RunningContext>();
  /** Serializes reconciles so two overlapping cycles never double-start a context. */
  private queue: Promise<ReconcileOutcome> = Promise.resolve({ started: [], stopped: [] });

  constructor(options: ProjectSupervisorOptions) {
    this.factory = options.factory;
    this.onError = options.onError ?? (() => {});
  }

  /** The currently running contexts (snapshot). */
  contexts(): readonly RunningContext[] {
    return [...this.contextsById.values()];
  }

  /** The running context for a project id, or undefined. */
  get(projectId: string): RunningContext | undefined {
    return this.contextsById.get(projectId);
  }

  /** The watcher state for a running project, or `"stopped"` when it is not running. */
  watcherStateFor(projectId: string): WatcherState {
    const ctx = this.contextsById.get(projectId);
    if (ctx === undefined) return "stopped";
    try {
      return ctx.watcherState();
    } catch {
      return "stopped";
    }
  }

  /**
   * Reconcile the running contexts against `active`: start any project not
   * running (or whose bound path changed), stop any running project no longer
   * active. Serialized behind the internal queue; never throws (start/stop
   * failures route to `onError`).
   */
  reconcile(active: readonly ResolvedProject[]): Promise<ReconcileOutcome> {
    this.queue = this.queue.then(() => this.reconcileNow(active));
    return this.queue;
  }

  private async reconcileNow(active: readonly ResolvedProject[]): Promise<ReconcileOutcome> {
    const started: string[] = [];
    const stopped: string[] = [];
    const activeById = new Map(active.map((p) => [p.projectId, p] as const));

    // Stop contexts that are no longer active, or whose bound path changed.
    for (const [projectId, ctx] of [...this.contextsById.entries()]) {
      const target = activeById.get(projectId);
      if (target === undefined || target.path !== ctx.path) {
        this.contextsById.delete(projectId);
        try {
          await ctx.stop();
        } catch (err) {
          this.onError("stop", projectId, err);
        }
        stopped.push(projectId);
      }
    }

    // Start contexts that are newly active (or were just stopped for a path change).
    for (const project of active) {
      if (this.contextsById.has(project.projectId)) continue;
      const ctx = this.factory(project);
      this.contextsById.set(project.projectId, ctx);
      try {
        await ctx.start();
      } catch (err) {
        this.onError("start", project.projectId, err);
      }
      started.push(project.projectId);
    }

    return { started, stopped };
  }

  /** Stop every running context and clear the map (shutdown / teardown, a-AC-7). Serialized behind the queue. */
  stopAll(): Promise<ReconcileOutcome> {
    return this.reconcile([]);
  }
}
