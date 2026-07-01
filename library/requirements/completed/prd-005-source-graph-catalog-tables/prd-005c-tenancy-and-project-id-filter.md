# PRD-005c: Tenancy Model + `project_id` Soft-Filter Verification

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S

## Overview

This sub-PRD pins the tenancy contract both source-graph tables share and verifies, against the real Honeycomb code, that `project_id` is a **column-level soft `WHERE` filter within the workspace partition — never a partition**. This is locked decision #3 in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md): the user's "auto-create tables per org>workspace>project" reframes to "register the catalog group; tables self-heal on first write; scope by the `project_id` column."

The verification has three legs: (1) `QueryScope` carries only `org` + `workspace`, so the storage layer partitions at the workspace boundary and has no `project` axis; (2) `project_id` is an ordinary `TEXT NOT NULL DEFAULT ''` column on both tables, filtered in query `WHERE` clauses; (3) the tenancy columns mirror the tenant-scoped `codebase` table and diverge deliberately from `sessions`/`memory` (no `agent_id`, no `visibility`) because file identity is cross-agent.

## Goals

- Pin the three-column tenancy contract (`org_id` / `workspace_id` / `project_id`) both tables carry.
- Verify `project_id` is a soft column filter, not a partition, by citing `QueryScope` and the partition model.
- Specify the soft-filter query pattern every reader (recall, projection sync, dashboard) applies.
- Document the cross-agent rationale for the absence of `agent_id` / `visibility`.

## Non-Goals

- The recall arm's full SQL — PRD-013 (this PRD specifies only the scope-filter shape the arm reuses).
- The OS-service / registry mechanics that resolve `project_id` — PRD-003.
- Per-project provisioning of any kind — explicitly rejected by decision #3.

## The tenancy contract

Both `source_graph` (005a) and `source_graph_versions` (005b) declare `scope: tenant` and carry three explicit tenancy columns, carried verbatim from [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md):

```sql
org_id              TEXT NOT NULL DEFAULT '',
workspace_id        TEXT NOT NULL DEFAULT '',
project_id          TEXT NOT NULL DEFAULT '',
```

`CatalogScope = "tenant"` (`honeycomb/src/daemon/storage/catalog/types.ts:74`) is defined as: a cross-cutting table that "carries explicit `org_id` + `workspace_id` … rather than relying on the agent-level storage partition." This is exactly the `codebase` table's model (`honeycomb/src/daemon/storage/catalog/product.ts:216-219, 318`) — the source doc names `codebase` as the table to mirror.

### Why explicit columns (not partition isolation alone)

Carried from [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) § "Tenancy and isolation": the explicit columns diverge from `sessions`/`memory`, which lean on partition isolation plus `agent_id`/`visibility`. File identity is **cross-agent by nature** — every agent and every harness working in the same project sees the same file descriptions. There is therefore:

- **No `agent_id` column** — a description minted for one agent is correct for all.
- **No `visibility` column** — isolation is org→workspace→project, full stop.

A team sharing a workspace (the normal Honeycomb collaboration model) shares a single Hivenectar graph per project. A new teammate's `git clone` + `hivenectar daemon` boot pulls the cloud-synced `source_graph_versions` rows for the workspace and re-derives the local projection, the same way the CodeGraph's `pullSnapshot` works.

### Denormalization into the versions table

The tenancy columns are **denormalized into `source_graph_versions`** (not joined from `source_graph` at query time). This is deliberate: the versions table is queryable in isolation for recall (PRD-013's arm reads it directly), and the projection sync (PRD-011) scans it without a join. Every version row carries the same `org_id`/`workspace_id`/`project_id` as its parent identity row.

## Verification: `project_id` is a soft filter, not a partition

The decisive evidence is `QueryScope` (`honeycomb/src/daemon/storage/client.ts:40-46`):

```ts
export interface QueryScope {
	/** Resolved org/workspace identity for this request. Required. */
	readonly org: string;
	/** Target workspace/partition. Defaults to the configured workspace. */
	readonly workspace?: string;
}
```

`QueryScope` carries **only `org` and `workspace`**. There is no `project` field. The doc-comment on `workspace` calls it the "Target workspace/**partition**" — confirming the storage layer partitions at the **workspace** boundary, and `project_id` is not an axis of that partition. Three consequences:

1. **No per-project table provisioning.** Tables are created once per workspace partition (lazily, via `withHeal` on first write — `honeycomb/src/daemon/storage/heal.ts:286-313`). There is no code path that creates a `source_graph` per project, because `QueryScope` has nowhere to carry a project when issuing the `CREATE`.

2. **`project_id` is an ordinary filtered column.** It is `TEXT NOT NULL DEFAULT ''` on both tables (005a, 005b) and appears in query `WHERE` clauses alongside the scope columns. It never appears in a table name or a partition selector.

3. **The "auto-create per org>workspace>project" request reframes correctly.** "Register the catalog group" = the `source-graph` group is appended to `CATALOG` once (`honeycomb/src/daemon/storage/catalog/index.ts:45-59`); "tables self-heal on first write" = `withHeal` creates the table inside the workspace partition on first write; "scope by `project_id` column" = every query filters rows by the `project_id` value. No per-project DDL, no per-project partition — consistent with every other Honeycomb table.

## The soft-filter query pattern

Every reader of these tables applies the same scope-then-filter shape. The `org` / `workspace` resolve the partition (via `QueryScope`); `project_id` filters rows inside it. The pattern, scoped to `source_graph_versions` (the table recall reads):

```sql
SELECT ... FROM "source_graph_versions"
WHERE org_id = <sqlStr(org)>
  AND workspace_id = <sqlStr(workspace)>
  AND project_id = <sqlStr(project_id)>
  -- ... arm-specific predicates (describe_status = 'described', latest-per-nectar subquery, BM25/vector)
```

Every dynamic value routes through the daemon's storage-layer SQL guards (`sqlStr`, `sqlLike`, and siblings from `honeycomb/src/daemon/storage/sql.ts`) — never string-interpolated. The Hivenectar corpus names `sqlStr` and `sqlLike`; no helper names outside the corpus are invented (per the `hivenectar-stinger` guide 00 § Principle 1).

The recall arm (PRD-013) applies exactly this scope filter before its BM25/vector predicates; the manual search (PRD-012) and the projection sync (PRD-011) do the same. A query that omits the `project_id` predicate reads across all projects in the workspace — which is never the intended scope for source-graph reads.

## Acceptance Criteria

- [ ] Both tables declare `scope: tenant` and carry `org_id` / `workspace_id` / `project_id` as `TEXT NOT NULL DEFAULT ''` (005a, 005b).
- [ ] Neither table carries an `agent_id` or `visibility` column (verified against the verbatim DDL).
- [ ] `QueryScope` (`honeycomb/src/daemon/storage/client.ts:40-46`) is cited as the evidence that `project` is not a partition axis; `workspace` is documented as the partition.
- [ ] The boot sequence contains no per-project DDL step; both tables self-create via `withHeal` (`heal.ts:286-313`) at the workspace partition on first write.
- [ ] Every documented reader query (recall, search, projection sync) applies the three-column scope filter (`org_id` + `workspace_id` + `project_id`) with values routed through the SQL guards.
- [ ] The "auto-create per org>workspace>project" reframing is recorded verbatim from decision #3: register the catalog group; tables self-heal on first write; scope by `project_id` column.

## Related

- [PRD-005a](./prd-005a-source-graph-table.md) — `source_graph` columns.
- [PRD-005b](./prd-005b-source-graph-versions-table.md) — `source_graph_versions` columns.
- [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) § "Tenancy and isolation" — the authoritative tenancy rationale.
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) decision #3 — the locked lazy-`withHeal` / `project_id`-as-soft-filter decision.
- `honeycomb/src/daemon/storage/client.ts:40-46` — `QueryScope` (org + workspace only).
- `honeycomb/src/daemon/storage/catalog/types.ts:60-74` — `WritePattern` / `CatalogScope` (`tenant` definition).
- `honeycomb/src/daemon/storage/catalog/product.ts:216-219, 313-319` — `codebase`, the tenant-scoped table mirrored.
- `honeycomb/src/daemon/storage/catalog/index.ts:45-59` — the `CATALOG` aggregation the `source-graph` group appends to.
- `honeycomb/src/daemon/storage/heal.ts:286-313` — `withHeal` lazy-create at the workspace partition.
