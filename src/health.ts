/**
 * The `/health` contract for the nectar daemon.
 *
 * Per PRD-001b (decision #20, revised): the top-level coarse `status` bit is
 * what doctor classifies on (modeled on honeycomb's `PipelineStatus`,
 * honeycomb/src/daemon/runtime/health.ts:42), and the body carries
 * nectar-native subsystem fields honeycomb's `/health` does not have
 * (brooding, enricher queue, projection, cost, provider state). The HTTP status
 * gates 200 when ok / 503 when degraded (PRD-003a; mirrors server.ts:318-341).
 */

export type PipelineStatus = "ok" | "degraded";

export interface HealthBody {
  status: PipelineStatus;
  uptimeMs: number;
  /**
   * PRD-003a (a-AC-1 / a-AC-2): the durable-store reachability posture, which is
   * the sole determinant of the coarse `status` bit today. A daemon that booted
   * without resolvable Deeplake credentials reports `reachable: false` with
   * `reason: "credentials-missing"`, which flips `status` to `degraded` so
   * `/health` answers 503 while the process stays up (the pre-login fleet
   * posture). When credentials appear (`nectar login` or a hive-side login), the
   * credentials watch flips this back to `reachable: true` / `status: ok` without
   * a restart. `reachable: true` (the default) leaves the daemon `ok`.
   */
  storage: {
    reachable: boolean;
    /** Machine-readable reason storage is unreachable (`"credentials-missing"`), or null when reachable. */
    reason: string | null;
  };
  brooding: {
    active: boolean;
    /**
     * Machine-readable reason brooding is inactive, or null when active/ready
     * (PRD-018k AC-018k.3). `"credentials_missing"` / `"portkey_disabled"` name
     * the unmet prerequisite so supervision and humans can both see WHY a booted
     * daemon describes nothing, rather than inferring it from the provider bits.
     */
    reason: string | null;
    filesDescribed: number;
    filesTotal: number;
    lastEventAt: string | null;
  };
  enricher: {
    queueDepth: number;
    lastCycleAt: string | null;
    consecutiveFailures: number;
    lastFileDescribed: string | null;
  };
  projection: {
    lastWriteAt: string | null;
    lastContentHash: string | null;
  };
  cost: {
    broodTotalTokens: number;
    broodTotalUsd: number;
  };
  embeddings: {
    provider: "local-nomic" | "hosted" | "off";
  };
  portkey: {
    enabled: boolean;
  };
  /**
   * PRD-019a: the active-project set the daemon broods + watches. A daemon with
   * no bound, brooding-enabled projects is DORMANT: `count` is 0 and `reason` is
   * `"no-active-projects"` (never a brood of the cwd / `$HOME` / `System32`).
   * Each entry carries the resolved tenancy project id, the bound path, its
   * effective brooding state, and its watcher liveness. `refused` lists bound
   * roots that resolved to a guarded path (`$HOME` / filesystem root / System32)
   * with reason `"pathological-root"`.
   */
  activeProjects: {
    count: number;
    /** `"no-active-projects"` when zero are active, `"global-paused"` when the global switch is paused, else null. */
    reason: string | null;
    projects: Array<{
      projectId: string;
      path: string;
      brooding: "active" | "paused" | "global-paused";
      watcher: "stopped" | "running" | "restarting" | "degraded";
    }>;
    refused: Array<{ projectId: string; path: string; reason: string }>;
  };
  watch: {
    /** True once the update-on-change registration pipeline's NodeFS watcher is running (PRD-018b). */
    running: boolean;
    /**
     * Why the watch leg is not running, when it is not: `"no-credentials"` when
     * the daemon booted without a durable store (the pipeline is dormant, not
     * broken - AC-018b.7), `"disabled"` when explicitly turned off, or null when
     * running (or simply not yet started). Surfaced so a dormant watch leg is
     * observable rather than silent.
     */
    reason: string | null;
    /** Durable flushes from the sync/async bridge that failed (surfaced, not swallowed - AC-018b.4). */
    flushFailures: number;
    /** ISO 8601 timestamp of the most recent durable-flush failure, or null when none has failed. */
    lastFlushErrorAt: string | null;
    /**
     * PRD-018c AC-018c.6/7: the watcher's own liveness, independent of
     * `reason` (which explains why the watch leg is dormant AT ALL, e.g.
     * no-credentials). `"running"` mirrors `running=true`; `"restarting"`
     * surfaces an active error-backoff recovery; `"degraded"` means restart
     * attempts were exhausted (the periodic resync backstop keeps
     * reconciling); `"stopped"` is the pre-start/post-shutdown default.
     */
    state: "stopped" | "running" | "restarting" | "degraded";
  };
}

/**
 * Mutable daemon health state. Subsystems update their slices as later PRDs
 * (007 brooding, 016 enricher, 011 projection, 010 portkey, 014 embeddings) land;
 * until then the fields report their honest zero/off values. `degrade()` flips
 * the coarse bit doctor classifies on.
 */
export class HealthState {
  private startedAtMs = Date.now();
  private status: PipelineStatus = "ok";

  readonly storage: HealthBody["storage"] = {
    reachable: true,
    reason: null,
  };
  readonly brooding: HealthBody["brooding"] = {
    active: false,
    reason: null,
    filesDescribed: 0,
    filesTotal: 0,
    lastEventAt: null,
  };
  readonly enricher: HealthBody["enricher"] = {
    queueDepth: 0,
    lastCycleAt: null,
    consecutiveFailures: 0,
    lastFileDescribed: null,
  };
  readonly projection: HealthBody["projection"] = {
    lastWriteAt: null,
    lastContentHash: null,
  };
  readonly cost: HealthBody["cost"] = {
    broodTotalTokens: 0,
    broodTotalUsd: 0,
  };
  readonly embeddings: HealthBody["embeddings"] = { provider: "off" };
  readonly portkey: HealthBody["portkey"] = { enabled: false };
  readonly activeProjects: HealthBody["activeProjects"] = {
    count: 0,
    reason: "no-active-projects",
    projects: [],
    refused: [],
  };
  readonly watch: HealthBody["watch"] = {
    running: false,
    reason: null,
    flushFailures: 0,
    lastFlushErrorAt: null,
    state: "stopped",
  };

  markStarted(atMs: number = Date.now()): void {
    this.startedAtMs = atMs;
  }

  /**
   * Set the durable-store reachability posture (PRD-003a a-AC-1 / a-AC-2) and
   * flip the coarse `status` bit accordingly: `reachable: false` degrades the
   * daemon (`/health` -> 503) with the given machine-readable reason;
   * `reachable: true` restores `ok` (200) and clears the reason. This is the
   * only runtime path that toggles `status` today, so a credentials-missing boot
   * serves 503 degraded while the process stays up, and the credentials watch
   * restores 200 without a restart the moment credentials appear.
   */
  setStorageState(state: { reachable: boolean; reason: string | null }): void {
    this.storage.reachable = state.reachable;
    this.storage.reason = state.reachable ? null : state.reason;
    this.status = state.reachable ? "ok" : "degraded";
  }

  /**
   * Record the resolved provider state (PRD-010 / PRD-014, decision #20's
   * purpose-built health shape). Resolved ONCE at assemble/start from the
   * env-backed config, never per `/health` request. `new HealthState()` keeps
   * the honest defaults (`portkey.enabled = false`, `embeddings.provider = off`)
   * until a composition root calls this.
   */
  setProviderState(state: {
    portkeyEnabled: boolean;
    embeddingsProvider: HealthBody["embeddings"]["provider"];
  }): void {
    this.portkey.enabled = state.portkeyEnabled;
    this.embeddings.provider = state.embeddingsProvider;
  }

  /**
   * Merge the brooding subsystem slice (PRD-007 / decision #20). Called by the
   * daemon's auto-brood path and the CLI/API brood mechanic as a brood advances.
   * Fail-soft: an absent subsystem never calls this and the honest zero defaults
   * stand; a partial only overwrites the fields it carries.
   */
  setBroodingState(state: Partial<HealthBody["brooding"]>): void {
    if (state.active !== undefined) this.brooding.active = state.active;
    if (state.reason !== undefined) this.brooding.reason = state.reason;
    if (state.filesDescribed !== undefined) this.brooding.filesDescribed = state.filesDescribed;
    if (state.filesTotal !== undefined) this.brooding.filesTotal = state.filesTotal;
    if (state.lastEventAt !== undefined) this.brooding.lastEventAt = state.lastEventAt;
  }

  /**
   * Merge the enricher subsystem slice (PRD-016 / decision #20). Fed by the
   * enricher loop's per-cycle sink; absent subsystems leave the zero defaults.
   */
  setEnricherState(state: Partial<HealthBody["enricher"]>): void {
    if (state.queueDepth !== undefined) this.enricher.queueDepth = state.queueDepth;
    if (state.lastCycleAt !== undefined) this.enricher.lastCycleAt = state.lastCycleAt;
    if (state.consecutiveFailures !== undefined) this.enricher.consecutiveFailures = state.consecutiveFailures;
    if (state.lastFileDescribed !== undefined) this.enricher.lastFileDescribed = state.lastFileDescribed;
  }

  /** Merge the projection subsystem slice (PRD-011): last write time + content hash. */
  setProjectionState(state: Partial<HealthBody["projection"]>): void {
    if (state.lastWriteAt !== undefined) this.projection.lastWriteAt = state.lastWriteAt;
    if (state.lastContentHash !== undefined) this.projection.lastContentHash = state.lastContentHash;
  }

  /**
   * Accumulate brooding cost (PRD-007b / decision #20). Additive: each completed
   * brood adds its estimated input tokens + USD to the running totals. Negative
   * or non-finite deltas are ignored so a bad estimate never corrupts the total.
   */
  addBroodCost(delta: { tokens?: number; usd?: number }): void {
    if (typeof delta.tokens === "number" && Number.isFinite(delta.tokens) && delta.tokens > 0) {
      this.cost.broodTotalTokens += delta.tokens;
    }
    if (typeof delta.usd === "number" && Number.isFinite(delta.usd) && delta.usd > 0) {
      this.cost.broodTotalUsd += delta.usd;
    }
  }

  /**
   * Merge the watch-leg slice (PRD-018b): whether the NodeFS watcher is running
   * and, when it is not, why. The daemon calls this at start (running once the
   * pipeline starts after auto-brood settles, or dormant with `"no-credentials"`
   * when no durable store resolved) and at shutdown (running false). Only the
   * fields the partial carries are overwritten.
   */
  setWatchState(state: Partial<Pick<HealthBody["watch"], "running" | "reason" | "state">>): void {
    if (state.running !== undefined) this.watch.running = state.running;
    if (state.reason !== undefined) this.watch.reason = state.reason;
    if (state.state !== undefined) this.watch.state = state.state;
  }

  /**
   * Record a durable-flush failure from the sync/async bridge (PRD-018b
   * AC-018b.4): bump the count and stamp the time, so a failed durable write is
   * visible on `/health` rather than silently dropped.
   */
  recordWatchFlushFailure(atIso: string = new Date().toISOString()): void {
    this.watch.flushFailures += 1;
    this.watch.lastFlushErrorAt = atIso;
  }

  /**
   * Replace the active-project slice (PRD-019a). The reconcile driver calls this
   * after every reconcile cycle with the resolved set + per-project watcher
   * liveness, so `/health` reflects exactly what the daemon broods and watches.
   */
  setActiveProjects(state: HealthBody["activeProjects"]): void {
    this.activeProjects.count = state.count;
    this.activeProjects.reason = state.reason;
    this.activeProjects.projects = state.projects.map((p) => ({ ...p }));
    this.activeProjects.refused = state.refused.map((r) => ({ ...r }));
  }

  setStatus(status: PipelineStatus): void {
    this.status = status;
  }

  degrade(): void {
    this.status = "degraded";
  }

  get pipelineStatus(): PipelineStatus {
    return this.status;
  }

  /** The full `/health` body, snapshotted from cached state (no synchronous probe). */
  snapshot(nowMs: number = Date.now()): HealthBody {
    return {
      status: this.status,
      uptimeMs: Math.max(0, nowMs - this.startedAtMs),
      storage: { ...this.storage },
      brooding: { ...this.brooding },
      enricher: { ...this.enricher },
      projection: { ...this.projection },
      cost: { ...this.cost },
      embeddings: { ...this.embeddings },
      portkey: { ...this.portkey },
      activeProjects: {
        count: this.activeProjects.count,
        reason: this.activeProjects.reason,
        projects: this.activeProjects.projects.map((p) => ({ ...p })),
        refused: this.activeProjects.refused.map((r) => ({ ...r })),
      },
      watch: { ...this.watch },
    };
  }
}

/** Map the coarse pipeline bit to the HTTP status code (200 ok / 503 degraded). */
export function healthHttpStatus(status: PipelineStatus): 200 | 503 {
  return status === "ok" ? 200 : 503;
}
