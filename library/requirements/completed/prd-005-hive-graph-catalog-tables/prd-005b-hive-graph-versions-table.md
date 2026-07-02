# PRD-005b: `hive_graph_versions` Table — Content + Description Chain

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S

## Overview

`hive_graph_versions` is **append-only**, keyed by the composite `(nectar, content_hash)`. One row per observed state of a file. It carries the path at observation time, the metadata (size, ext, mtime), and the lazily-filled LLM description (`title`, `description`, `concepts`) plus the 768-dim `embedding`. "Current state of file X" is the latest version row for X's nectar; "full history of file X" is all version rows for X's nectar. Both are cheap queries.

The composite key has a useful invariant carried from the source doc: the same content under the same nectar is a no-op (idempotent re-observation after a no-change save); the same content under a *different* nectar is the copy-paste signal that sets `derived_from_nectar` on the newer nectar (PRD-006d).

This sub-PRD registers `hive_graph_versions` as a Honeycomb `CatalogTable`, including its nullable `FLOAT4[]` `embedding` column — the only embedding column in the hive-graph schema and the one the recall arm (PRD-013) queries.

## Goals

- Carry the `hive_graph_versions` DDL verbatim from [`hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md).
- Translate it into a `ColumnDef[]` that passes the load-time guard at `honeycomb/src/daemon/storage/schema.ts:80-100` — including the nullable `embedding` column, which is exempt from the NOT-NULL-must-have-DEFAULT rule.
- Register it as a `CatalogTable` with `embeddingColumns: ["embedding"]` and `scope: tenant`.

## Non-Goals

- The identity table — PRD-005a.
- The enricher loop that fills `title`/`description`/`embedding` — PRD-016.
- The embeddings provider that produces the 768-dim vectors — PRD-014.
- The recall arm over the `embedding` column — PRD-013.
- The portable projection regenerated from this table — PRD-011.
- Edit-coalesced versioning — explicitly a v1 non-goal in the source doc; every save appends a version row and debouncing happens at the watcher intake (PRD-006), not at the schema level.

## Verbatim DDL

Carried unchanged from [`hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) § "The `hive_graph_versions` table (content + description chain)":

```sql
CREATE TABLE IF NOT EXISTS "hive_graph_versions" (
  nectar          TEXT NOT NULL DEFAULT '',
  content_hash    TEXT NOT NULL DEFAULT '',
  seq             BIGINT NOT NULL DEFAULT 0,
  path            TEXT NOT NULL DEFAULT '',
  filename        TEXT NOT NULL DEFAULT '',
  ext             TEXT NOT NULL DEFAULT '',
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  mtime_observed  TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  concepts        TEXT NOT NULL DEFAULT '[]',
  embedding       FLOAT4[],
  confidence      REAL,
  fingerprint     TEXT,
  described_at    TEXT NOT NULL DEFAULT '',
  describe_model  TEXT NOT NULL DEFAULT '',
  describe_status TEXT NOT NULL DEFAULT 'pending',
  observed_at     TEXT NOT NULL DEFAULT '',
  org_id          TEXT NOT NULL DEFAULT '',
  workspace_id    TEXT NOT NULL DEFAULT '',
  project_id      TEXT NOT NULL DEFAULT '',
  last_update_date TEXT NOT NULL DEFAULT ''
) USING deeplake;
```

> **`confidence` column (nullable; set on TLSH fuzzy-match rows).** The Nectar corpus's `ai/identity-and-reassociation.md` states that fuzzy-match version rows "carry a `confidence` field (1 − normalized distance)." This PRD makes that claim literally true by adding a nullable `confidence REAL` column. It is set only on rows appended by re-association ladder step 4 (TLSH fuzzy match); all other rows leave it NULL. Nullable (like `embedding`), so it is exempt from the NOT-NULL-must-have-DEFAULT rule and heal-safe. The corpus's `hive-graph-schema.md` carries this column too (`confidence REAL`), so the corpus and this PRD agree. Supports the audit query: "show me all auto-carried matches below a given confidence."

> **`fingerprint` column (nullable; PRD-006 addendum).** Added additively for PRD-006 step-4 fingerprint persistence. It holds the TLSH-family locality-sensitive digest of the content (the `computeFingerprint` "H1"-prefixed string), computed on every content-bearing version row. Re-association ladder step 4 matches a moved-and-edited file against the fingerprints of *missing* files; persisting the fingerprint on the version row (rather than only in an in-process cache) is what lets cold-catch-up fuzzy matching survive a daemon restart. Nullable (like `embedding` and `confidence`), so it is exempt from the NOT-NULL-must-have-DEFAULT rule and heal-safe: rows written before this column existed leave it NULL and self-heal on next observation. The corpus's `hive-graph-schema.md` carries this column too (`fingerprint TEXT`), so the corpus and this PRD agree. This is a post-completion addendum recorded to keep the completed PRD's history honest: the column was introduced by PRD-006, not the original PRD-005 tranche.

Twenty-two columns. Nineteen are `NOT NULL` with a `DEFAULT`; `embedding` (`FLOAT4[]`), `confidence` (`REAL`), and `fingerprint` (`TEXT`) are the three nullable columns (no `NOT NULL`, no `DEFAULT`).

## Column-by-column rationale

Each row cites the verbatim DDL above and the source doc.

| Column | SQL | Purpose (from hive-graph-schema.md) |
|---|---|---|
| `nectar` | `TEXT NOT NULL DEFAULT ''` | FK → `hive_graph.nectar`. Composite key part 1. |
| `content_hash` | `TEXT NOT NULL DEFAULT ''` | sha256 of file content at observation. Composite key part 2. **Changes per edit** — that is the point. |
| `seq` | `BIGINT NOT NULL DEFAULT 0` | Monotonic per-nectar version counter (0, 1, 2, …). Lets "latest version" be `ORDER BY seq DESC LIMIT 1` without parsing timestamps. |
| `path` | `TEXT NOT NULL DEFAULT ''` | Repo-relative path with forward slashes, at observation time. **Mutable across version rows for the same nectar** — this is how moves are recorded. |
| `filename` | `TEXT NOT NULL DEFAULT ''` | Bare filename. Denormalized from path for fast filename-only searches without path parsing. |
| `ext` | `TEXT NOT NULL DEFAULT ''` | Lowercased extension without dot (`ts`, `tsx`, `md`, `json`). Routed to the right CodeGraph extractor and to the brooding batcher. |
| `size_bytes` | `BIGINT NOT NULL DEFAULT 0` | File size. Used to skip empty files and to bucket large files for solo-description. |
| `mtime_observed` | `TEXT NOT NULL DEFAULT ''` | File mtime at observation. Not authoritative (mtime is mutable), but useful as a fast-path cache key: if `(path, mtime, size)` all match the last observation, skip re-hashing. |
| `title` | `TEXT NOT NULL DEFAULT ''` | LLM-minted, ≤80 chars. Empty string while pending, filled by the enricher. |
| `description` | `TEXT NOT NULL DEFAULT ''` | LLM-minted, 1–3 sentences. Same lifecycle as `title`. |
| `concepts` | `TEXT NOT NULL DEFAULT '[]'` | JSON-encoded string array (`'["auth","session","jwt"]'`). LLM-minted concept tags for the Obsidian-style interlink layer. |
| `embedding` | `FLOAT4[]` | 768-dim vector over `title + ' ' + description`. **Same dimensionality as `sessions.message_embedding` and `memory.summary_embedding`** so the same hybrid recall pipeline queries all three. Nullable until enriched. |
| `described_at` | `TEXT NOT NULL DEFAULT ''` | Timestamp of the enricher run that filled `title`/`description`. Empty while pending. |
| `describe_model` | `TEXT NOT NULL DEFAULT ''` | Model identifier that produced the description (e.g. `gemini-2.5-flash` via `portkey`). Auditable; lets a model swap trigger re-description selectively. |
| `describe_status` | `TEXT NOT NULL DEFAULT 'pending'` | One of `pending`, `described`, `failed`, `skipped-too-large`, `skipped-binary`, `skipped-deleted`. Lets recall filter out undescribed rows and lets the enricher resume after failures. `skipped-deleted` (also present in the corpus enum) marks a row whose file vanished while pending — distinct from `failed` (retryable LLM failure) so the enricher doesn't keep retrying a file that's gone. |
| `observed_at` | `TEXT NOT NULL DEFAULT ''` | Timestamp the version row was appended (distinct from `mtime_observed`, which is the file's own clock). |
| `org_id` | `TEXT NOT NULL DEFAULT ''` | Tenancy, denormalized from `hive_graph` so the versions table is queryable in isolation for recall. |
| `workspace_id` | `TEXT NOT NULL DEFAULT ''` | Tenancy. Same rationale. |
| `project_id` | `TEXT NOT NULL DEFAULT ''` | Tenancy. Same rationale. |
| `last_update_date` | `TEXT NOT NULL DEFAULT ''` | Standard Honeycomb UPDATE-coalescing workaround column. |

## Translated `ColumnDef[]`

The load-time guard (`honeycomb/src/daemon/storage/schema.ts:80-100`) rejects any `NOT NULL` column lacking a `DEFAULT` but **exempts nullable columns**: NULL is their implicit default and the backfill is trivial (`schema.ts:73-74`). `embedding` is the only nullable column (`FLOAT4[]`, no constraints), so the array passes cleanly.

```ts
export const HIVE_GRAPH_VERSIONS_COLUMNS = Object.freeze([
	// Composite key
	{ name: "nectar", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "content_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "seq", sql: "BIGINT NOT NULL DEFAULT 0" },
	// Observation payload (mutable across versions for the same nectar)
	{ name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "ext", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "size_bytes", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "mtime_observed", sql: "TEXT NOT NULL DEFAULT ''" },
	// LLM-minted description (lazily filled by the enricher; empty while pending)
	{ name: "title", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "concepts", sql: "TEXT NOT NULL DEFAULT '[]'" },
	// Embedding (nullable 768-dim FLOAT4[] over title + ' ' + description)
	{ name: "embedding", sql: "FLOAT4[]" },
	// Confidence (nullable REAL; set only on step-4 TLSH fuzzy-match rows; 1 − normalized distance)
	{ name: "confidence", sql: "REAL" },
	// Fingerprint (nullable TEXT; TLSH-family digest on every content-bearing row; step-4 reads it for missing files) — PRD-006 addendum
	{ name: "fingerprint", sql: "TEXT" },
	// Description audit
	{ name: "described_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "describe_model", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "describe_status", sql: "TEXT NOT NULL DEFAULT 'pending'" },
	{ name: "observed_at", sql: "TEXT NOT NULL DEFAULT ''" },
	// Tenant identity (explicit per scope = "tenant"; mirrors CODEBASE_COLUMNS)
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	// Standard UPDATE-coalescing workaround column
	{ name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);
```

## `CatalogTable` entry

`defineTable` (`honeycomb/src/daemon/storage/catalog/types.ts:107-122`) asserts every declared embedding column exists in `columns`. `"embedding"` is present in `HIVE_GRAPH_VERSIONS_COLUMNS`, so the assertion passes.

```ts
{
	name: "hive_graph_versions",
	columns: HIVE_GRAPH_VERSIONS_COLUMNS,
	pattern: "append-only",          // DEFAULT — confirm before implementation
	embeddingColumns: ["embedding"],
	scope: "tenant",
}
```

### Write pattern: `append-only` *(DEFAULT — confirm before implementation)*

`hive_graph_versions` uses **`append-only`** (`honeycomb/src/daemon/storage/catalog/types.ts:60`): every meaningfully distinct content state inserts a new row; nothing updates an existing version row. Rationale: the version chain is append-only per ADR-0001 — that is the whole point of the two-table split (the identity table holds the stable key; this table holds the immutable history). The composite key `(nectar, content_hash)` makes re-observation of unchanged content a no-op insert. This is flagged as a default pending implementation confirmation; `append-only` is recommended and aligns with ADR-0001's append-only version chain.

### Scope: `tenant`

`scope: tenant` (`types.ts:74`). Same rationale as `hive_graph` (005a): file identity/description is cross-agent, so the table carries explicit `org_id` / `workspace_id` / `project_id` and no `agent_id` / `visibility`. The tenancy columns are **denormalized from `hive_graph`** so the versions table is queryable in isolation for recall (the recall arm in PRD-013 reads this table directly without joining back to the identity table). The `project_id` soft-filter contract is specified in PRD-005c.

## The `embedding` column

`embedding` is the sole embedding column in the hive-graph schema (and, with `confidence` and `fingerprint`, one of its three nullable columns). Contract, carried from [`hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md):

- **Type:** `FLOAT4[]` — nullable until enriched.
- **Dimensionality:** **768-dim**, vector over `title + ' ' + description`. Same dimensionality as `sessions.message_embedding` and `memory.summary_embedding`, so the same hybrid recall pipeline queries all three.
- **Lifecycle:** empty/NULL while `describe_status = 'pending'`; filled by the enricher (PRD-016) after the description is minted; produced by the embeddings daemon/provider (PRD-014).
- **Catalog registration:** declared in `embeddingColumns: ["embedding"]`, which is what makes the column participate in the embedding-aware catalog paths (`types.ts:88-92`, index AC-4).

Per ADR-0001 the 768-dim is **tied to the schema** — changing the dimension is a schema event (the `FLOAT4[]` column carries its width). PRD-014's provider switch honors this: both the local nomic default and the Cohere-via-Portkey opt-in produce 768-dim vectors, or recall's `embed.dim_rejected` guard discards the vector.

## Indexing strategy

Deep Lake indexing is additive and configured through the catalog helpers, not hand-rolled `CREATE INDEX`. The indexes `hive_graph_versions` relies on (carried from [`hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) § "Indexing strategy"):

| Index | Columns | Why |
|---|---|---|
| `deeplake_index` (BM25) | `title`, `description` | Lexical recall over descriptions. Same operator Deep Lake applies to `memory.summary`. |
| Vector (`<#>` cosine) | `embedding` | Semantic recall over descriptions. Falls back silently to BM25 if embeddings are off — no quality cliff. |
| `deeplake_hybrid_record` | BM25 + vector | The fused path recall prefers. |
| Scope filter | `org_id`, `workspace_id`, `project_id` | Every recall query scopes by tenancy before applying BM25/vector. |

The `path` and `filename` columns are covered by the standard ILIKE fallback. No dedicated path index in v1; row counts (one per file version, not one per symbol) are small enough that ILIKE is adequate.

## Self-create via `withHeal`

Same as `hive_graph` (005a). `hive_graph_versions` is never pre-created; the first version-row append against a missing table triggers `withHeal` (`honeycomb/src/daemon/storage/heal.ts:286-313`): classify as `missing-table`, `buildCreateTableSql` with the full `ColumnDef`, `healColumnsTolerant`, retry the write exactly once. No DDL pre-step — decision #3.

## Acceptance Criteria

- [ ] The verbatim DDL block above matches [`hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) character-for-character (twenty-two columns; nineteen `NOT NULL DEFAULT`, three nullable: `embedding` `FLOAT4[]`, `confidence` `REAL`, and `fingerprint` `TEXT`).
- [ ] `HIVE_GRAPH_VERSIONS_COLUMNS` has exactly twenty-two entries, one per DDL column, in declaration order, with matching `sql` strings — including `embedding` as `"FLOAT4[]"`, `confidence` as `"REAL"`, and `fingerprint` as `"TEXT"` (no constraints).
- [ ] The array passes `validateColumnDefs("HIVE_GRAPH_VERSIONS", ...)` at module load (`schema.ts:80-100`); the nullable `embedding` is exempt from the NOT-NULL-must-have-DEFAULT rule.
- [ ] The `CatalogTable` record declares `embeddingColumns: ["embedding"]`, `scope: tenant`, and the confirmed write pattern.
- [ ] `defineTable`'s embedding-column assertion (`types.ts:108-116`) passes — `"embedding"` is present in `columns`.
- [ ] A first write against a missing table triggers exactly one `buildCreateTableSql` + one retry inside `withHeal` (`heal.ts:286-313`).
- [ ] The `embedding` column is documented as 768-dim `FLOAT4[]`, nullable until enriched, matching `sessions.message_embedding` / `memory.summary_embedding`.

## Related

- [PRD-005a](./prd-005a-hive-graph-table.md) — the identity table this version chain anchors to.
- [PRD-005c](./prd-005c-tenancy-and-project-id-filter.md) — the `project_id` soft-filter contract.
- [`knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) — the authoritative DDL + indexing strategy.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the recall arm over `embedding`.
- `honeycomb/src/daemon/storage/schema.ts:28-100` — `ColumnDef` + load-time guard (nullable-column exemption at `:73-74`).
- `honeycomb/src/daemon/storage/catalog/types.ts:60-128` — `WritePattern` / `CatalogScope` / `CatalogTable` / `defineTable` (embedding-column assertion at `:108-116`).
- `honeycomb/src/daemon/storage/catalog/product.ts:216-241, 313-319` — `CODEBASE_COLUMNS` (the tenant-scoped mirror).
- `honeycomb/src/daemon/storage/heal.ts:286-313` — `withHeal` lazy-create.
