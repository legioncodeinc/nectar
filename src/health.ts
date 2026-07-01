/**
 * The `/health` contract for the hivenectar daemon.
 *
 * Per PRD-001b (decision #20, revised): the top-level coarse `status` bit is
 * what hivedoctor classifies on (modeled on honeycomb's `PipelineStatus`,
 * honeycomb/src/daemon/runtime/health.ts:42), and the body carries
 * hivenectar-native subsystem fields honeycomb's `/health` does not have
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
    provider: "local-nomic" | "cohere" | "off";
  };
  portkey: {
    enabled: boolean;
  };
}

/**
 * Mutable daemon health state. Subsystems update their slices as later PRDs
 * (007 brooding, 016 enricher, 011 projection, 010 portkey, 014 embeddings) land;
 * until then the fields report their honest zero/off values. `degrade()` flips
 * the coarse bit hivedoctor classifies on.
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
