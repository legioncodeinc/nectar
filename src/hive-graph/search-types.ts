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
}

export interface HiveGraphSearchResult {
  readonly hits: readonly HiveGraphHit[];
  readonly sources: readonly ("nectar")[];
  readonly degraded: boolean;
}
