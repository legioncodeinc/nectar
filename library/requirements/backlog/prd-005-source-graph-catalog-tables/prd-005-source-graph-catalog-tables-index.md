# PRD-005: Source Graph Catalog Tables and Lazy Schema Healing

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S

## Overview

PRD-005 owns the **data layer** — the substrate every other Hivenectar component reads and writes. It registers the two Deep Lake tables from the spec, `source_graph` (logical file identity + provenance) and `source_graph_versions` (the append-only content + description chain), as Honeycomb `CatalogTable` entries and confirms they self-create on first write via the same `withHeal` lazy-heal pass every other Honeycomb table uses (locked decision #3 in [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md)).

The defining constraint — carried verbatim from [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — is the **two-table split**. A single table cannot cleanly represent a file's stable identity separately from its changing content and description. `source_graph` is one row per logical file keyed by the daemon-minted nectar (ULID); `source_graph_versions` is append-only, keyed by `(nectar, content_hash)`, carrying the path, metadata, the LLM-minted description, and the 768-dim embedding. This mirrors how git separates the commit anchor from content-addressed blobs and is forced by ADR-0001 (the minted-nectar identity model).

The PRD resolves the tenancy model against the real Honeycomb code. Both tables declare `CatalogScope: tenant` with explicit `org_id` / `workspace_id` / `project_id` columns, mirroring the `codebase` table. Per decision #3, `project_id` is a **column-level soft `WHERE` filter within the workspace partition**, never a partition: `QueryScope` (`honeycomb/src/daemon/storage/client.ts:40-46`) carries only `org` + `workspace`, so the storage layer partitions at the workspace boundary and `project_id` filters rows inside it. The user's "auto-create tables per org>workspace>project" reframes to: **register the catalog group; tables self-heal on first write; scope by the `project_id` column.**

## Defaults registered in this PRD

Three values are defaults pending implementation confirmation. Each is flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| Catalog group name | `source-graph` (appended to `CATALOG` at `honeycomb/src/daemon/storage/catalog/index.ts:45-59`) | this index, 005c | One group holds both tables; matches the one-group-per-concern convention (`PRODUCT_TABLES`, `MEMORIES_TABLES`, …). |
| WritePattern — `source_graph` | `update-or-insert` | 005a | Nectar is the upsert key; identity rows rarely change after minting. |
| WritePattern — `source_graph_versions` | `append-only` | 005b | The version chain is append-only per ADR-0001. |
| CatalogScope — both tables | `tenant` | 005a, 005b, 005c | Carries explicit `org_id`/`workspace_id`; mirrors the `codebase` table (`product.ts:318`); file identity is cross-agent (no `agent_id`/`visibility`). |

## Goals

- Carry the authoritative DDL from [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) **verbatim** into two `CatalogTable` records — every column name and type, no paraphrase.
- Translate each table's DDL block into a Honeycomb `ColumnDef[]` array that passes the load-time guard at `honeycomb/src/daemon/storage/schema.ts:80-100` (valid identifier, no duplicates, the NOT-NULL-must-have-DEFAULT rule).
- Register both tables under one catalog group (`source-graph`) and append that group to the `CATALOG` aggregation at `honeycomb/src/daemon/storage/catalog/index.ts:45-59`, so the heal pass + write-pattern registry see them.
- Confirm both tables self-create on first write via `withHeal` (`honeycomb/src/daemon/storage/heal.ts:286-313`) — no per-org/per-workspace/per-project DDL pre-step.
- Pin the tenancy model: `scope: tenant`, explicit `org_id`/`workspace_id`/`project_id` columns, `project_id` as a soft column filter (not a partition), verified against `QueryScope`.

## Non-Goals

- The brooding pipeline that writes the initial rows — PRD-007.
- The enricher loop that fills `title`/`description`/`embedding` — PRD-016.
- The embeddings provider that produces the 768-dim vectors — PRD-014.
- The recall arm that queries `source_graph_versions` — PRD-013.
- The portable projection (`.honeycomb/nectars.json`) — PRD-011.
- Directory-level or symbol-level nectars — deferred to v2 (deliberate spec gap, ADR-0001 non-goals).

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-005a-source-graph-table](./prd-005a-source-graph-table.md) | `source_graph` table — identity + provenance `ColumnDef[]` + `CatalogTable` entry | Draft |
| [prd-005b-source-graph-versions-table](./prd-005b-source-graph-versions-table.md) | `source_graph_versions` table — append-only `ColumnDef[]` + `CatalogTable` entry + `embedding` column | Draft |
| [prd-005c-tenancy-and-project-id-filter](./prd-005c-tenancy-and-project-id-filter.md) | Tenancy model + `project_id` soft-filter verification | Draft |

## Acceptance Criteria

- [ ] Both DDL blocks from [`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) appear verbatim in 005a/005b; every column name and SQL type cross-checks against the source.
- [ ] Each table's `ColumnDef[]` array satisfies the load-time guard (`schema.ts:80-100`): valid identifiers, no duplicates, and every `NOT NULL` column carries a `DEFAULT` (or is nullable, for the versions `embedding`).
- [ ] Both `CatalogTable` records declare `scope: tenant` and the columns carry `org_id` / `workspace_id` / `project_id`, mirroring `CODEBASE_COLUMNS` (`honeycomb/src/daemon/storage/catalog/product.ts:216-241`).
- [ ] The `source-graph` catalog group is appended to `CATALOG` (`honeycomb/src/daemon/storage/catalog/index.ts:45-59`), so `REGISTRY` (`buildRegistry(CATALOG)`) picks up both tables' write patterns.
- [ ] Both tables self-create on first write through `withHeal` (`heal.ts:286-313`); no DDL pre-step exists in the hivenectar boot sequence.
- [ ] `project_id` is documented as a soft `WHERE` column filter inside the workspace partition, verified against `QueryScope` (`client.ts:40-46`) which carries only `org` + `workspace`.

## Related

- [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — authoritative DDL (carried verbatim into 005a/005b).
- [`knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../../knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md) — the identity decision forcing the two-table split.
- [`knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) — the data layer is unchanged across the process boundary.
- [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md) decision #3 — the locked lazy-`withHeal` / `project_id`-as-soft-filter decision.
- [`honeycomb/src/daemon/storage/schema.ts:28-100`](../../../../honeycomb/src/daemon/storage/schema.ts) — `ColumnDef` + the load-time guard.
- [`honeycomb/src/daemon/storage/catalog/types.ts:60-128`](../../../../honeycomb/src/daemon/storage/catalog/types.ts) — `CatalogTable` / `WritePattern` / `CatalogScope` / `defineTable` / `defineGroup`.
- [`honeycomb/src/daemon/storage/heal.ts:286-313`](../../../../honeycomb/src/daemon/storage/heal.ts) — `withHeal` lazy-create.
- [`honeycomb/src/daemon/storage/catalog/product.ts:216-241, 313-319`](../../../../honeycomb/src/daemon/storage/catalog/product.ts) — the tenant-scoped `codebase` table to mirror.
- [`honeycomb/src/daemon/storage/catalog/index.ts:45-59`](../../../../honeycomb/src/daemon/storage/catalog/index.ts) — the `CATALOG` aggregation to append to.
- [`honeycomb/src/daemon/storage/client.ts:40-46`](../../../../honeycomb/src/daemon/storage/client.ts) — `QueryScope` (org + workspace only).
