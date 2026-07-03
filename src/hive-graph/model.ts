/**
 * The Hive Graph domain model (PRD-005).
 *
 * Two tables, one purpose each, straight from the corpus
 * (`library/knowledge/private/data/hive-graph-schema.md`):
 *   - `hive_graph`          one row per logical file, keyed by nectar (ULID). Identity + provenance.
 *   - `hive_graph_versions` append-only, keyed by (nectar, content_hash). Content + lazy description.
 *
 * These types are the frozen contract the store adapters (PRD-005) and the
 * file-registration ladder (PRD-006) both build against. Column names match the
 * DDL exactly so the future Deep Lake adapter maps 1:1.
 */

/** Tenancy triple. Scope is org+workspace at the storage layer; project_id is a soft column filter (PRD-005c / decision #3). */
export interface Tenancy {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

/**
 * True when a row's tenancy columns match `t` exactly on all three of
 * `orgId`/`workspaceId`/`projectId`. The single scoping predicate re-used by
 * the in-memory store, the ladder's carry guard, and the delete/prune/review
 * paths so no identity mutation ever crosses a project boundary (AC-20).
 */
export function inTenancy(row: { orgId: string; workspaceId: string; projectId: string }, t: Tenancy): boolean {
  return row.orgId === t.orgId && row.workspaceId === t.workspaceId && row.projectId === t.projectId;
}

/** `hive_graph.kind` discriminator. Only `file` is minted in v1; `directory` reserves the namespace (schema doc YAGNI note). */
export type NectarKind = "file" | "directory";

/**
 * `hive_graph_versions.describe_status`. Exactly the six values in the schema
 * doc column table (including `skipped-deleted`, the decisions-doc #14 addition).
 */
export type DescribeStatus =
  | "pending"
  | "described"
  | "failed"
  | "skipped-too-large"
  | "skipped-binary"
  | "skipped-deleted";

export const DESCRIBE_STATUSES: readonly DescribeStatus[] = [
  "pending",
  "described",
  "failed",
  "skipped-too-large",
  "skipped-binary",
  "skipped-deleted",
];

/** A row of `hive_graph` (identity + provenance only; no content, no description). */
export interface HiveGraphRow {
  /** 26-char ULID, minted once, never derived from content. Primary key. */
  nectar: string;
  kind: NectarKind;
  /** ISO 8601 minting time (the decoded ULID timestamp). */
  createdAt: string;
  /** Copy-paste provenance; empty for an originally-minted file. */
  derivedFromNectar: string;
  /** Content hash at the fork point; empty unless derived. */
  forkContentHash: string;
  orgId: string;
  workspaceId: string;
  projectId: string;
  /** Denormalized "last observed change" timestamp; bumped on every appended version. */
  lastUpdateDate: string;
}

/** A row of `hive_graph_versions` (one per observed content state of a nectar). */
export interface HiveGraphVersionRow {
  /** FK -> hive_graph.nectar. Composite key part 1. */
  nectar: string;
  /** sha256 of file content at observation. Composite key part 2. */
  contentHash: string;
  /** Monotonic per-nectar version counter (0, 1, 2, ...). "latest" = MAX(seq). */
  seq: number;
  /** Repo-relative path (forward slashes) at observation time. Mutable across a nectar's versions -> records moves. */
  path: string;
  filename: string;
  /** Lowercased extension without the dot (`ts`, `md`, `json`). */
  ext: string;
  sizeBytes: number;
  /** File mtime at observation (ISO 8601). Not authoritative; a fast-path cache key only. */
  mtimeObserved: string;
  /** LLM-minted, <=80 chars. Empty while pending. */
  title: string;
  /** LLM-minted, 1-3 sentences. Empty while pending. */
  description: string;
  /** JSON-encoded string array, e.g. '["auth","session"]'. Defaults to '[]'. */
  concepts: string;
  /** 768-dim vector over title+description. Null until enriched (or if embeddings off). */
  embedding: number[] | null;
  /** Set only on ladder step-4 (TLSH fuzzy) rows: 1 - normalizedTLSHDistance. Null otherwise. */
  confidence: number | null;
  /**
   * TLSH-family fingerprint of the content (the `computeFingerprint` "H1"-prefixed
   * digest); set on every content-bearing row, consulted by ladder step 4 for
   * missing files so cold-catch-up fuzzy matching survives a daemon restart. Null
   * on pre-fingerprint rows (they self-heal on next observation).
   */
  fingerprint: string | null;
  describedAt: string;
  describeModel: string;
  /**
   * The embedding model that produced {@link embedding} (PRD-018i / NEC-018).
   * Null when the row carries no embedding (`embedding === null`) or was written
   * before this column existed (the catalog heal path backfills old rows as
   * null). Additive nullable column; the ONLY schema change in PRD-018.
   */
  embedModel?: string | null;
  describeStatus: DescribeStatus;
  /** Timestamp the version row was appended (distinct from mtimeObserved). */
  observedAt: string;
  orgId: string;
  workspaceId: string;
  projectId: string;
  lastUpdateDate: string;
}

/** The embedding contract: 768 dims, tied to the FLOAT4[] column (ADR-0001 / PRD-014). A different dimension is rejected upstream. */
export const EMBED_DIMS = 768;

/** True if a vector honors the 768-dim contract. Recall's `embed.dim_rejected` guard discards anything else. */
export function isValidEmbedding(vec: number[] | null): boolean {
  return vec === null || vec.length === EMBED_DIMS;
}
