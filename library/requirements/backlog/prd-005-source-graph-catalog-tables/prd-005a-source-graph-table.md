# PRD-005a: `source_graph` Table — Identity + Provenance

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S

## Overview

`source_graph` is one row per logical file, keyed by the daemon-minted nectar (26-char ULID). It carries **identity and provenance only** — no content, no description. The content + description chain lives in `source_graph_versions` (PRD-005b). The split is forced by ADR-0001: a file's identity is stable (it survives edits, renames, and moves) while its content and description change constantly, and collapsing both into one row either loses history (overwrite on every edit) or loses the stable-identity key under a pile of versions (append on every edit).

This sub-PRD registers `source_graph` as a Honeycomb `CatalogTable`: the verbatim DDL from the spec, translated into a `ColumnDef[]` array, a write pattern, an embedding-column list (empty — identity has no embedding), and a tenancy scope.

## Goals

- Carry the `source_graph` DDL verbatim from [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md).
- Translate it into a `ColumnDef[]` that passes the load-time guard at `honeycomb/src/daemon/storage/schema.ts:80-100`.
- Register it as a `CatalogTable` with the write pattern + scope the catalog contract requires (`honeycomb/src/daemon/storage/catalog/types.ts:80-95`).

## Non-Goals

- The versions table — PRD-005b.
- The process that writes rows (minting happens in hiveantennae, PRD-002/PRD-006) — this PRD owns only the schema + catalog entry.
- Directory-level or symbol-level rows — deferred to v2 (the `kind` column reserves the namespace).

## Verbatim DDL

Carried unchanged from [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) § "The `source_graph` table (identity + provenance)":

```sql
CREATE TABLE IF NOT EXISTS "source_graph" (
  nectar              TEXT NOT NULL DEFAULT '',
  kind                TEXT NOT NULL DEFAULT 'file',
  created_at          TEXT NOT NULL DEFAULT '',
  derived_from_nectar TEXT NOT NULL DEFAULT '',
  fork_content_hash   TEXT NOT NULL DEFAULT '',
  org_id              TEXT NOT NULL DEFAULT '',
  workspace_id        TEXT NOT NULL DEFAULT '',
  project_id          TEXT NOT NULL DEFAULT '',
  last_update_date    TEXT NOT NULL DEFAULT ''
) USING deeplake;
```

Nine columns, all `TEXT`, all `NOT NULL` with a `DEFAULT`. The nectar column is the logical primary key.

## Column-by-column rationale

Each row cites the verbatim DDL above and the source doc.

| Column | SQL | Purpose (from source-graph-schema.md) |
|---|---|---|
| `nectar` | `TEXT NOT NULL DEFAULT ''` | **Primary key.** 26-char ULID minted once by hiveantennae. Never changes. Never derived from content. Sortable by creation time. |
| `kind` | `TEXT NOT NULL DEFAULT 'file'` | Discriminator: `'file'` in v1. Reserved for `'directory'` if folder-level nectars are added later (v1 non-goal). |
| `created_at` | `TEXT NOT NULL DEFAULT ''` | ISO 8601 timestamp of nectar minting. Equals the ULID's embedded timestamp but stored explicitly for portability into `nectars.json`. |
| `derived_from_nectar` | `TEXT NOT NULL DEFAULT ''` | Copy-paste provenance. Empty for an originally-minted file. Set to the source nectar when a new path appears whose content matches an existing file's current content (the copy event). Write-once. |
| `fork_content_hash` | `TEXT NOT NULL DEFAULT ''` | The content hash at the fork point. Lets the enricher render "this file was copied from X when X looked like Y." Write-once. |
| `org_id` | `TEXT NOT NULL DEFAULT ''` | Tenancy. Explicit because identity is cross-cutting (mirrors the `codebase` table's tenancy columns). |
| `workspace_id` | `TEXT NOT NULL DEFAULT ''` | Tenancy. Same rationale. |
| `project_id` | `TEXT NOT NULL DEFAULT ''` | Project isolation within a workspace. Resolved registry key, same semantics as the `project_id` column on `sessions` and `memory`. |
| `last_update_date` | `TEXT NOT NULL DEFAULT ''` | Denormalized "last observed change" timestamp. Updated whenever a new version row is appended. Lets the projection sync and the dashboard render "recently touched" without scanning the versions table. |

The `nectar` column is the only truly immutable column. `derived_from_nectar` and `fork_content_hash` are write-once (set at minting, never updated). Everything else is mutable but rarely changes after the row's first write.

## Translated `ColumnDef[]`

Each `ColumnDef` (`honeycomb/src/daemon/storage/schema.ts:28-33`) is `{ name, sql }` where `sql` is the column SQL minus the name. The load-time guard (`schema.ts:80-100`) validates every `name` as a SQL identifier, rejects duplicates, and rejects any `NOT NULL` column lacking a `DEFAULT`. All nine columns carry both `NOT NULL` and a `DEFAULT`, so the array passes cleanly.

```ts
export const SOURCE_GRAPH_COLUMNS = Object.freeze([
	// Logical identity
	{ name: "nectar", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "kind", sql: "TEXT NOT NULL DEFAULT 'file'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	// Copy-paste provenance (write-once)
	{ name: "derived_from_nectar", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "fork_content_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	// Tenant identity (explicit per scope = "tenant"; mirrors CODEBASE_COLUMNS)
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	// Denormalized update timestamp
	{ name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);
```

This mirrors the structure of `CODEBASE_COLUMNS` (`honeycomb/src/daemon/storage/catalog/product.ts:216-241`): tenant-identity columns first, row identity next, then the rest. The `as const` + `Object.freeze` matches the existing catalog convention.

## `CatalogTable` entry

`defineTable` (`honeycomb/src/daemon/storage/catalog/types.ts:107-122`) runs `validateColumnDefs` at module load and asserts every declared embedding column exists in `columns`. `source_graph` carries no embedding (identity is not described), so `embeddingColumns` is empty.

```ts
{
	name: "source_graph",
	columns: SOURCE_GRAPH_COLUMNS,
	pattern: "update-or-insert",   // DEFAULT — confirm before implementation
	embeddingColumns: [],
	scope: "tenant",
}
```

### Write pattern: `update-or-insert` *(DEFAULT — confirm before implementation)*

`source_graph` uses **`update-or-insert`** (one of the four `WritePattern` values at `honeycomb/src/daemon/storage/catalog/types.ts:60`): one row per nectar; minting inserts, a derived-from or `last_update_date` refresh upserts in place. The nectar is the natural upsert key. Rationale: identity rows are written once and rarely change after minting, so `update-or-insert` coalesces re-observation of the same nectar onto the existing row rather than appending. This is distinct from `source_graph_versions` (005b), which is `append-only` because the version chain is append-only per ADR-0001.

This is flagged as a default pending implementation confirmation. The alternative (`select-before-insert`, as the `codebase` table uses at `product.ts:316`) probes the key before inserting to make a concurrent-writer race observable; `update-or-insert` is the lighter-weight choice and is recommended because nectar minting is single-writer per daemon.

### Scope: `tenant`

`scope: tenant` (the `CatalogScope` value at `honeycomb/src/daemon/storage/catalog/types.ts:74`) means the table carries **explicit `org_id` + `workspace_id`** rather than relying on the agent-level storage partition. This matches the `codebase` table (`product.ts:318`) and the source doc's tenancy rationale: file identity is **cross-agent by nature** — every agent and harness working in the same project sees the same file descriptions, so there is no `agent_id` column and no `visibility` column. Isolation is org→workspace→project, full stop. The `project_id` column's role as a soft filter (not a partition) is specified in PRD-005c.

## Self-create via `withHeal`

`source_graph` is never pre-created. When hiveantennae issues its first write (a nectar mint) and the table is missing, `withHeal` (`honeycomb/src/daemon/storage/heal.ts:286-313`) classifies the `query_error` as `missing-table`, runs `buildCreateTableSql(target.table, target.columns)` to `CREATE` the table with the full `ColumnDef`, then runs `healColumnsTolerant` and retries the write **exactly once**. No per-org/per-workspace/per-project DDL event exists in the boot sequence — this is decision #3.

## Acceptance Criteria

- [ ] The verbatim DDL block above matches [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) character-for-character (nine columns, all `TEXT NOT NULL DEFAULT`).
- [ ] `SOURCE_GRAPH_COLUMNS` has exactly nine entries, one per DDL column, in declaration order, with matching `sql` strings.
- [ ] The array passes `validateColumnDefs("SOURCE_GRAPH", SOURCE_GRAPH_COLUMNS)` at module load (`schema.ts:80-100`) — no identifier, duplicate, or NOT-NULL-without-DEFAULT violations.
- [ ] The `CatalogTable` record declares `scope: tenant`, `embeddingColumns: []`, and the confirmed write pattern.
- [ ] The record is spread into the `source-graph` catalog group, which is appended to `CATALOG` (`honeycomb/src/daemon/storage/catalog/index.ts:45-59`).
- [ ] A first write against a missing table triggers exactly one `buildCreateTableSql` + one retry inside `withHeal` (`heal.ts:286-313`), with no second heal cycle.

## Related

- [PRD-005b](./prd-005b-source-graph-versions-table.md) — the append-only versions table this row anchors.
- [PRD-005c](./prd-005c-tenancy-and-project-id-filter.md) — the `project_id` soft-filter contract both tables rely on.
- [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the authoritative DDL.
- [`honeycomb/src/daemon/storage/schema.ts:28-100`](../../../../honeycomb/src/daemon/storage/schema.ts) — `ColumnDef` + load-time guard.
- [`honeycomb/src/daemon/storage/catalog/types.ts:60-128`](../../../../honeycomb/src/daemon/storage/catalog/types.ts) — `WritePattern` / `CatalogScope` / `CatalogTable` / `defineTable`.
- [`honeycomb/src/daemon/storage/catalog/product.ts:216-241, 313-319`](../../../../honeycomb/src/daemon/storage/catalog/product.ts) — `CODEBASE_COLUMNS` (the tenant-scoped mirror).
- [`honeycomb/src/daemon/storage/heal.ts:286-313`](../../../../honeycomb/src/daemon/storage/heal.ts) — `withHeal` lazy-create.
