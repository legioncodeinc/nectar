/**
 * Types for the PRD-012a `searchHiveGraph` engine.
 *
 * The engine reads `hive_graph_versions` through an injected {@link StorageQuery}
 * and optionally embeds the query through {@link EmbedClient}. CLI (012b) and the
 * HTTP handler (PRD-008b) both delegate to the same function signature.
 */
import type { Tenancy } from "./model.js";

/** Org/workspace partition + soft `project_id` filter (decision #3). */
export type QueryScope = Tenancy;

/** One row of a Deep Lake query result. */
export type StorageRow = Record<string, unknown>;

/**
 * The read seam the engine uses. Org/workspace ride the transport headers;
 * `project_id` is filtered in SQL via {@link QueryScope.projectId}.
 */
export interface StorageQuery {
  query(sql: string, scope: QueryScope): Promise<readonly StorageRow[]>;
}

/**
 * Embeds a single query string to a 768-dim vector, or `null` on every failure
 * mode (disabled, unreachable, timeout, wrong-dim). Mirrors honeycomb's
 * `EmbedClient` contract consumed by recall's semantic arm.
 */
export interface EmbedClient {
  embed(text: string): Promise<number[] | null>;
}

/** One ranked hive-graph search hit (latest described version per nectar). */
export interface HiveGraphHit {
  readonly source: "nectar";
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly concepts: string;
  readonly content_hash: string;
}

export interface HiveGraphSearchDeps {
  readonly storage: StorageQuery;
  /** When absent, search runs lexical-only and returns `degraded: true`. */
  readonly embed?: EmbedClient;
  /**
   * The active embedding provider's model id (PRD-018i / NEC-018 AC-018i.3). When
   * set, the semantic arm excludes rows whose non-null `embed_model` disagrees
   * with it (a cross-space cosine comparison is meaningless) and reports the
   * mismatched nectars through {@link onReembedNeeded}. Rows with a null
   * `embed_model` (pre-provenance rows) are treated as compatible.
   */
  readonly activeEmbedModel?: string;
  /** Sink for nectars whose stored embedding disagrees with the active model, to be re-embedded (AC-018i.3). */
  readonly onReembedNeeded?: (nectars: readonly string[]) => void;
  /**
   * The recall RRF multiplier loaded from `~/.honeycomb/nectar.json`'s
   * `nectar_rrf_multiplier` knob (PRD-018k / NEC-041 AC-018k.7). This is the
   * config SURFACE the knob plugs into: the value is accepted and exposed here,
   * but this standalone two-arm engine deliberately applies NO cross-arm class
   * weighting (PRD-012a; see the recall review's spec-conformance note), so the
   * multiplier does not yet alter fusion. It reaches the recall path so a future
   * cross-table fusion arm can weight nectar hits without a new plumbing change.
   */
  readonly rrfMultiplier?: number;
}

export type HiveGraphSearchArmState = "ok" | "missing-table" | "error" | "not-run";

export type HiveGraphSearchArmName = "semantic" | "lexical";

export interface HiveGraphSearchArmStatus {
  readonly status: HiveGraphSearchArmState;
  readonly rows: number;
  readonly reason?: string;
}

export type HiveGraphSearchReason =
  | "ok"
  | "empty-query"
  | "semantic-unavailable"
  | "no-matches"
  | "missing-table"
  | "backend-error";

export interface HiveGraphSearchResult {
  readonly hits: readonly HiveGraphHit[];
  readonly sources: readonly ("nectar")[];
  readonly degraded: boolean;
  readonly reason?: HiveGraphSearchReason;
  readonly errorSources?: readonly HiveGraphSearchArmName[];
  readonly arms?: {
    readonly semantic: HiveGraphSearchArmStatus;
    readonly lexical: HiveGraphSearchArmStatus;
  };
}
