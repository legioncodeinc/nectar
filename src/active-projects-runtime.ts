/**
 * The active-projects reconcile driver (PRD-019a).
 *
 * Ties the pure resolution ({@link resolveActiveProjects}) to the stateful
 * {@link ProjectSupervisor} and the `/health` slice, and drives a reconcile on
 * the daemon's existing poll cadence plus on demand (the 019b toggle API calls
 * {@link ActiveProjectsController.reconcileNow}). No new watch dependency: it
 * reuses the injected timer seam the rest of the daemon uses, so it is
 * deterministic under a manual clock in tests.
 */
import { PollLoop, realTimer, type Timer } from "./poll-loop.js";
import { ProjectSupervisor, type ProjectContextFactory, type ReconcileOutcome } from "./project-supervisor.js";
import { activeProjectsHealth, type ActiveProjectResolution } from "./hive-graph/active-projects.js";
import type { HealthBody } from "./health.js";

export interface ActiveProjectsControllerDeps {
  /** Resolve the current active set (reads the `~/.deeplake` bindings + the brooding-state file). */
  resolve(): ActiveProjectResolution;
  /** Build a running brood + watch context for a project. */
  readonly factory: ProjectContextFactory;
  /** Apply the computed `/health` active-projects slice. */
  setHealth(slice: HealthBody["activeProjects"]): void;
  /** Reconcile cadence in ms (default: the daemon's poll interval). */
  readonly intervalMs: number;
  /** Injected timer (tests). Default: the real timer. */
  readonly timer?: Timer;
  /** Observe a context start/stop failure. Default: no-op. */
  readonly onError?: (scope: "start" | "stop", projectId: string, err: unknown) => void;
}

export class ActiveProjectsController {
  readonly supervisor: ProjectSupervisor;
  private readonly deps: ActiveProjectsControllerDeps;
  private readonly loop: PollLoop;
  private started = false;

  constructor(deps: ActiveProjectsControllerDeps) {
    this.deps = deps;
    this.supervisor = new ProjectSupervisor({
      factory: deps.factory,
      ...(deps.onError !== undefined ? { onError: deps.onError } : {}),
    });
    this.loop = new PollLoop({
      tick: async () => {
        const outcome = await this.reconcileNow();
        return outcome.started.length > 0 || outcome.stopped.length > 0;
      },
      floorMs: Math.max(1, deps.intervalMs),
      timer: deps.timer ?? realTimer,
    });
  }

  /** Publish the current resolution to `/health` without touching the supervisor (dormant snapshot). */
  publishHealth(): void {
    const resolution = this.deps.resolve();
    this.deps.setHealth(activeProjectsHealth(resolution, (id) => this.supervisor.watcherStateFor(id)));
  }

  /** Resolve the active set, reconcile the supervisor to it, and refresh the `/health` slice. */
  async reconcileNow(): Promise<ReconcileOutcome> {
    const resolution = this.deps.resolve();
    const outcome = await this.supervisor.reconcile(resolution.active);
    this.deps.setHealth(activeProjectsHealth(resolution, (id) => this.supervisor.watcherStateFor(id)));
    return outcome;
  }

  /** Arm the reconcile poll loop (the loop fires an immediate first tick at delay 0). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.loop.start();
  }

  /** Disarm the loop, drain any in-flight reconcile, then stop every running context (a-AC-7). */
  async stop(): Promise<void> {
    this.loop.stop();
    await this.loop.whenIdle();
    await this.supervisor.stopAll();
    this.started = false;
    this.deps.setHealth(activeProjectsHealth(this.deps.resolve(), () => "stopped"));
  }
}
