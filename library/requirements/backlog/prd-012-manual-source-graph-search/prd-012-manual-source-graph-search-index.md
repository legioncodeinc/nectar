# PRD-012: Manual Source Graph Search

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None (search reads the `source_graph_versions` table PRD-005 owns; this PRD owns the query engine + the CLI/endpoint surfaces, no table changes.)

---

## Overview

PRD-012 is the operator-facing search capability: a focused "search just the file descriptions" tool that runs lexical + semantic search over `source_graph_versions` (the latest described version per nectar) **without** fusing into the agent-facing recall. It mirrors the recall arm's BM25 + vector mechanics — the guarded arm SQL shape, the latest-per-nectar subquery, the `describe_status = 'described'` filter — but stands alone: a dedicated engine (`searchSourceGraph`) callable from a CLI command (`hivenectar search <query>`) and an HTTP endpoint (`/api/source-graph/search`, owned as a handler by [PRD-008b](../prd-008-hivenectar-api-endpoints/prd-008b-search-endpoint.md)). It is distinct from **PRD-013** (the [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) entry "Recall arm: add `source_graph_versions` to the fused recall"), which adds the `source_graph_versions` arm to the *fused* recall the agents call.

The engine reuses the same per-arm guarded-query pattern and SQL-safety floor the recall engine enforces. The lexical arm builds a guarded `ILIKE` query over `title + ' ' + description + ' ' + concepts`, routed through `sqlLike` (so a literal `%`/`_` is never a wildcard) and `sqlIdent`, mirroring `buildMemoriesArmSql` / `buildMemoryArmSql` / `buildSessionsArmSql` ([`honeycomb/src/daemon/runtime/memories/recall.ts:319-383`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)). The semantic arm embeds the query via the embed client (the same `EmbedClient` that powers sessions/memories embeddings — [`honeycomb/src/daemon/runtime/services/embed-client.ts`](../../../../honeycomb/src/daemon/runtime/services/embed-client.ts)) and runs the `<#>` cosine match over `embedding`, gated on `embedding IS NOT NULL`; when embeddings are off/unavailable, only the lexical arm runs (the graceful fallback). The two arms fuse by reciprocal rank within the standalone search, scoped by `org_id`/`workspace_id`/`project_id`.

This PRD owns two sub-features: the **search engine** (012a — BM25 + vector over `source_graph_versions` latest-per-nectar, mirroring the recall arm mechanics but standalone), and the **CLI + endpoint surface** (012b — `hivenectar search <query>` + the `/api/source-graph/search` endpoint that PRD-008b mounts). The search contract derives from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md); the engine is a focused subset of the recall mechanics, not the fused recall itself.

---

## Goals

- Build a **standalone search engine** (`searchSourceGraph`) that runs BM25 lexical + `<#>` vector semantic search over `source_graph_versions` filtered to the latest described version per nectar, mirroring the recall arm's SQL shape ([`honeycomb/src/daemon/runtime/memories/recall.ts:319-383`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)) and the integration spec ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)).
- Apply the **latest-per-nectar subquery** so the engine returns one row per current file (not one row per version), and the **`describe_status = 'described'` filter** so pending/failed/skipped rows never surface.
- Reuse the **per-arm fail-soft** pattern: a missing `source_graph_versions` table (fresh workspace) degrades to an empty result, never a 500, mirroring the recall engine's guarded-query discipline ([`honeycomb/src/daemon/runtime/memories/recall.ts:24-35`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)).
- Reuse the **embed client** ([`honeycomb/src/daemon/runtime/services/embed-client.ts`](../../../../honeycomb/src/daemon/runtime/services/embed-client.ts)) for the query vector, with the same null-on-failure contract (disabled / unreachable / wrong-dim → lexical-only, `degraded: true`).
- Ship a **CLI command** (`hivenectar search <query>`) and an **HTTP endpoint** (`/api/source-graph/search`) as two clients of the one engine, returning an identical result shape.

## Non-Goals

- Adding `source_graph_versions` to the **fused agent-facing recall** — **PRD-013**. This PRD's engine is a standalone operator tool; PRD-013 owns the recall arm that surfaces descriptions alongside sessions/memory/memories hits.
- The HTTP route-group scaffolding / permission inheritance for `/api/source-graph/search` — **PRD-008** (008a scaffolds the group; 008b mounts the handler). This PRD owns the engine + the CLI; PRD-008b owns the handler that calls the engine.
- The Deep Lake table schemas (`source_graph`, `source_graph_versions`) — **PRD-005**. This engine reads them.
- The embed client implementation (nomic vs Cohere-via-Portkey) — **PRD-014**. This engine consumes the client.
- The brooding/enricher mechanics that *populate* the descriptions this engine searches — **PRD-007** / **PRD-016**.
- The dashboard page that hosts the search box — **PRD-015**.

---

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [`prd-012a-lexical-semantic-search-over-source-graph`](./prd-012a-lexical-semantic-search-over-source-graph.md) | The `searchSourceGraph` engine: BM25 + `<#>` vector over `source_graph_versions` latest-per-nectar, mirroring the recall arm mechanics but standalone | Draft |
| [`prd-012b-cli-and-endpoint`](./prd-012b-cli-and-endpoint.md) | The `hivenectar search <query>` CLI + the `/api/source-graph/search` endpoint (the handler mounted by PRD-008b) | Draft |

---

## Acceptance Criteria

- [ ] The `searchSourceGraph` engine runs a guarded lexical arm over `title + ' ' + description + ' ' + concepts` and, when embeddings are available, a guarded `<#>` vector arm over `embedding`, both scoped by `org_id`/`workspace_id`/`project_id` and filtered to the latest described version per nectar ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)).
- [ ] The engine applies the **latest-per-nectar subquery** (`MAX(seq)` join) and the **`describe_status = 'described'` filter** so it returns one row per current described file and never returns pending/failed/skipped rows.
- [ ] Every identifier routes through `sqlIdent` and the search term through `sqlLike`, mirroring the recall arm builders at [`honeycomb/src/daemon/runtime/memories/recall.ts:319-383`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts); no value is hand-quoted.
- [ ] A missing `source_graph_versions` table (fresh workspace) degrades to `{ hits: [], sources: [], degraded: true }`, never a 500, mirroring the per-arm fail-soft at [`recall.ts:24-35`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).
- [ ] When embeddings are off / the query embed returns null, the engine runs the lexical arm only and returns `degraded: true`, mirroring the graceful fallback at [`recall.ts:2106`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).
- [ ] `hivenectar search <query>` (CLI) and `/api/source-graph/search` (endpoint) return the identical result shape (two clients of the one engine).

---

## Defaults registered in this PRD

Two values are defaults pending implementation confirmation, flagged inline with **DEFAULT — confirm before implementation** at their sub-PRDs:

| Default | Value | Where | Rationale |
|---|---|---|---|
| Search result default LIMIT | 20 | 012a, 012b | The shared recall engine's `DEFAULT_RECALL_LIMIT = 20` ([`honeycomb/src/daemon/runtime/memories/recall.ts:129`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)); the search engine reuses the same clamp (`resolveRecallLimit` at [`recall.ts:303-308`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)) so one default governs both surfaces. |
| CLI command | `hivenectar search <query>` | 012b | The proposed command named in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) CLI table ("`hivenectar search` (proposed) — manual source-graph search"). |

---

## Related

- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-012 brief (operator-facing search, scoped to the source-graph table, distinct from PRD-013) + the CLI table entry.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — AUTHORITATIVE: the arm SQL shape, the latest-per-nectar subquery, the `describe_status = 'described'` filter, the vector `<#>` arm, the fail-soft guard.
- [`knowledge/private/overview.md`](../../../knowledge/private/overview.md) — the search/daemon API surface.
- [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the `source_graph_versions` columns the engine reads (`title`, `description`, `concepts`, `embedding`, `describe_status`, `seq`, `nectar`, tenancy).
- [`prd-008-hivenectar-api-endpoints`](../prd-008-hivenectar-api-endpoints/prd-008-hivenectar-api-endpoints-index.md) — owns the `/api/source-graph/search` handler (008b) that mounts this engine.
- [`prd-005-source-graph-catalog-tables`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — owns the tables this engine reads.
- [`prd-014-embeddings-provider-switching`](../prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md) — owns the embed client this engine consumes.
- `honeycomb/src/daemon/runtime/memories/recall.ts:319-383` — the three arm builders the lexical arm mirrors.
- `honeycomb/src/daemon/runtime/services/embed-client.ts` — the `EmbedClient` the semantic arm consumes.
