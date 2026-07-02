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
  brooding: {
    active: boolean;
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

  readonly brooding: HealthBody["brooding"] = {
    active: false,
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

  markStarted(atMs: number = Date.now()): void {
    this.startedAtMs = atMs;
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
      brooding: { ...this.brooding },
      enricher: { ...this.enricher },
      projection: { ...this.projection },
      cost: { ...this.cost },
      embeddings: { ...this.embeddings },
      portkey: { ...this.portkey },
    };
  }
}

/** Map the coarse pipeline bit to the HTTP status code (200 ok / 503 degraded). */
export function healthHttpStatus(status: PipelineStatus): 200 | 503 {
  return status === "ok" ? 200 : 503;
}
