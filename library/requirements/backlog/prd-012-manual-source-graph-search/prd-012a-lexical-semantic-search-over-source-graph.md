# PRD-012a: Lexical + Semantic Search over the Source Graph

> Parent: [`prd-012-manual-source-graph-search-index.md`](./prd-012-manual-source-graph-search-index.md)

## Overview

This sub-PRD owns the **`searchSourceGraph` engine** — a standalone search function that runs BM25 lexical + `<#>` vector semantic search over `source_graph_versions`, filtered to the latest described version per nectar. It mirrors the recall arm's mechanics but is not the recall arm: it is a focused operator tool ("search just the file descriptions"), distinct from PRD-013's guarded arm that fuses `source_graph_versions` into the agent-facing recall. The engine is the single shared dependency the CLI (012b) and the `/api/source-graph/search` endpoint (PRD-008b) call.

The engine reuses the recall engine's proven patterns rather than inventing new ones. The **lexical arm** builds a guarded `ILIKE` query over `title + ' ' + description + ' ' + concepts`, routed through the same SQL-safety helpers (`sqlIdent`, `sqlLike`) the three recall arm builders use (`buildMemoriesArmSql` / `buildMemoryArmSql` / `buildSessionsArmSql` at `honeycomb/src/daemon/runtime/memories/recall.ts:319-383`). The **semantic arm** embeds the query via the embed client (the same `EmbedClient` that powers sessions/memories embeddings — `honeycomb/src/daemon/runtime/services/embed-client.ts`) and runs the `<#>` cosine match over `embedding`, gated on `embedding IS NOT NULL`. Both arms apply the **latest-per-nectar subquery** (`MAX(seq)` join) and the **`describe_status = 'described'` filter** carried verbatim from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md). The per-arm fail-soft guard is load-bearing: a missing `source_graph_versions` table on a fresh workspace degrades to an empty result, never a 500 (`honeycomb/src/daemon/runtime/memories/recall.ts:24-35`).

## Goals

- Build `searchSourceGraph(query, scope, limit?, deps?)` that returns `{ hits, sources, degraded }`, mirroring the recall engine's result shape (`honeycomb/src/daemon/runtime/memories/recall.ts:2064-2119`).
- Run a **guarded lexical arm** over `title + ' ' + description + ' ' + concepts` using `sqlLike` + `sqlIdent`, mirroring `buildMemoriesArmSql` (`honeycomb/src/daemon/runtime/memories/recall.ts:319-337`).
- Run a **guarded `<#>` semantic arm** over `embedding` when embeddings are available, embedding the query via the embed client and mirroring `runSemanticArm` (`honeycomb/src/daemon/runtime/memories/recall.ts:925-961`).
- Apply the **latest-per-nectar subquery** (`MAX(seq)` join) and the **`describe_status = 'described'` filter**, carried verbatim from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md).
- Apply the **per-arm fail-soft** guard so a missing table degrades to empty, never a 500, mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:24-35`.
- Fuse the two arms by reciprocal rank within the standalone search and return `degraded: true` when the vector arm did not run.

## Non-Goals

- Adding `source_graph_versions` to the **fused agent-facing recall** — **PRD-013**. This engine is standalone.
- The CLI command + HTTP endpoint surface — **012b** (CLI) + **PRD-008b** (handler). This sub-PRD owns the engine they call.
- The embed client implementation (nomic vs Cohere-via-Portkey) — **PRD-014**. This engine consumes the client.
- The table schemas — **PRD-005**.
- The fusion/ranking heuristics of the full multi-arm recall — this engine fuses only its own two arms (lexical + semantic over one table); the cross-arm RRF + arm-class weighting of the fused recall is PRD-013/PRD-027's domain.

---

## The engine signature

```ts
export interface SourceGraphSearchDeps {
  readonly storage: StorageQuery;          // the DeepLake client (FR-6)
  readonly embed?: EmbedClient;            // optional; absent → lexical-only, degraded: true
}

export async function searchSourceGraph(
  query: string,
  scope: QueryScope,                       // org/workspace (+ project as soft filter)
  limit?: number,                          // default 20 (DEFAULT_RECALL_LIMIT)
  deps: SourceGraphSearchDeps,
): Promise<{ hits: SourceGraphHit[]; sources: ("hivenectar")[]; degraded: boolean }>;
```

The `limit` defaults to 20 and is clamped via the same `resolveRecallLimit` shape the recall engine uses (`honeycomb/src/daemon/runtime/memories/recall.ts:129, 303-308`). `degraded` is `true` when the vector arm did not run (embeddings off / unavailable / wrong-dim), mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:2106`.

---

## The latest-per-nectar subquery (load-bearing)

The defining query shape — carried verbatim from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — restricts every arm to the latest described version per nectar. Without it, a file edited 50 times dominates search with 50 near-duplicate rows; with it, search sees only the most recent described state (one row per current file).

```sql
-- The latest-per-nectar subquery (simplified; the real query is sqlStr/sqlLike-guarded).
SELECT nectar, MAX(seq) AS max_seq
FROM source_graph_versions
WHERE describe_status = 'described'
  AND org_id       = :org
  AND workspace_id = :workspace
  AND project_id   = :project
GROUP BY nectar
```

Both arms `INNER JOIN` this subquery (`v.nectar = latest.nectar AND v.seq = latest.max_seq`), so only the current described version of each file participates. The `describe_status = 'described'` filter excludes pending, failed, and skipped rows — a file never described (brooding not yet reached it, or skipped as binary/too-large) does not surface ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)).

---

## The lexical arm

The lexical arm builds a guarded `ILIKE` query over `title + ' ' + description + ' ' + concepts`, mirroring `buildMemoriesArmSql`'s shape (`honeycomb/src/daemon/runtime/memories/recall.ts:319-337`): the term routes through `sqlLike` (so a literal `%`/`_` is never a wildcard), every identifier through `sqlIdent`, and the per-arm `LIMIT` is a clamped integer (a bare numeric interpolation, never a `String(...)` wrapper).

```sql
-- Lexical arm (simplified; term is sqlLike-guarded, identifiers sqlIdent-guarded).
SELECT 'hivenectar' AS source,
       v.nectar     AS id,
       v.path       AS path,
       v.title      AS title,
       v.description AS body,
       v.concepts   AS concepts,
       v.content_hash AS content_hash
FROM source_graph_versions v
INNER JOIN (
  SELECT nectar, MAX(seq) AS max_seq
  FROM source_graph_versions
  WHERE describe_status = 'described'
    AND org_id = :org AND workspace_id = :workspace AND project_id = :project
  GROUP BY nectar
) latest ON v.nectar = latest.nectar AND v.seq = latest.max_seq
WHERE (v.title ILIKE :pattern OR v.description ILIKE :pattern OR v.concepts ILIKE :pattern)
LIMIT :per_arm
```

The `source` projection is the literal `'hivenectar'`, carried from the integration spec ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)). The projected columns (`id`, `path`, `title`, `body`, `concepts`, `content_hash`) match the engine's `SourceGraphHit` shape.

---

## The semantic arm

The semantic arm is analogous to the lexical arm, substituting the `<#>` (cosine distance) match over `embedding` for the `ILIKE` filter, gated on `embedding IS NOT NULL`. It mirrors `runSemanticArm` (`honeycomb/src/daemon/runtime/memories/recall.ts:925-961`) and the integration spec's vector-arm description ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)).

1. **Embed the query** via the injected `EmbedClient` (`honeycomb/src/daemon/runtime/services/embed-client.ts`). The client returns `null` on every failure mode (disabled / daemon unreachable / timeout / wrong-dim → `null`, `honeycomb/src/daemon/runtime/services/embed-client.ts:240-287`).
2. **If the embed is null**, skip the semantic arm entirely; the lexical arm runs alone and `degraded: true` is returned (mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:2106`).
3. **If the embed is a 768-dim vector**, run the `<#>` cosine match over `embedding` under the same latest-per-nectar subquery + scope, ordered by ascending distance (descending similarity). The dimension contract is 768 (`EMBEDDING_DIMS = 768`, `honeycomb/src/daemon/storage/vector.ts:35`); the embed client already rejects non-768 vectors before returning (`honeycomb/src/daemon/runtime/services/embed-client.ts:271-275`). Note the **mandatory two-step shape** the reused engine imposes: `vectorSearch` returns scored row identifiers only (`honeycomb/src/daemon/storage/vector.ts`), so the semantic arm scores first, then hydrates the matched rows' content (title/description/path columns) through a SECOND guarded query, exactly as the real `runSemanticArm` does; the arm never assumes the vector engine returns row content.

The semantic arm uses the same `<#>` vector-match engine the recall engine's `SEMANTIC_ARMS` use (`vectorSearch` via the existing engine, not a fork — D-5 of `honeycomb/src/daemon/runtime/memories/recall.ts:37-48`).

---

## Fusion within the standalone search

The two arms (lexical + semantic, both over `source_graph_versions`) fuse by reciprocal rank into the standalone result. This is the same RRF shape the recall engine uses (`honeycomb/src/daemon/runtime/memories/recall.ts:403-457`), scoped to this engine's two arms only — there is no cross-table arm-class weighting (that is PRD-013/PRD-027's domain). A hit matched by both arms appears once (deduped by `source + id`).

`degraded` is **honest**: `false` when the semantic arm ran (a real 768-dim query vector existed), `true` when it did not (embeddings off / embed returned null), mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:2103-2106`.

---

## The fail-soft guard

The per-arm fail-soft guard is load-bearing. On a fresh workspace partition, `source_graph_versions` may not exist yet (the table self-creates on first write via `withHeal` — decision #3, [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)). The engine runs each arm as its own guarded `storage.query`; a missing/failing table degrades to an empty arm rather than failing the whole search (`honeycomb/src/daemon/runtime/memories/recall.ts:24-35`). Every arm failing yields an empty result `{ hits: [], sources: [], degraded: true }`, never a 500. An empty query also returns this empty/degraded floor, mirroring `recallMemories`' empty-query guard (`honeycomb/src/daemon/runtime/memories/recall.ts:2070-2073`).

---

## User stories

### US-012a.1 — Lexical search over descriptions

**As a** operator, **I want to** search the file descriptions lexically, **so that** I find files whose title/description/concepts contain a term.

**Acceptance criteria:**
- AC-012a.1.1 Given a query and described rows, then the lexical arm builds a guarded `ILIKE` over `title + ' ' + description + ' ' + concepts` with the term routed through `sqlLike` and identifiers through `sqlIdent`, mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:319-337`.
- AC-012a.1.2 Given the query, then only the latest described version per nectar participates (the `MAX(seq)` join + `describe_status = 'described'` filter), carried from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md).
- AC-012a.1.3 Given a literal `%` or `_` in the query, then it is escaped by `sqlLike` and never acts as a wildcard, mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:319-336`.

### US-012a.2 — Semantic search over embeddings

**As a** operator, **I want to** search semantically ("everything associated with logins"), **so that** I find files by what they do, not by exact term.

**Acceptance criteria:**
- AC-012a.2.1 Given a query and embeddings available, then the semantic arm embeds the query via the `EmbedClient` and runs the `<#>` cosine match over `embedding` under the latest-per-nectar subquery + scope, mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:925-961`.
- AC-012a.2.2 Given the embed returns a non-768 vector, then the client returns `null` and the arm is skipped (`degraded: true`), mirroring `honeycomb/src/daemon/runtime/services/embed-client.ts:271-275`.
- AC-012a.2.3 Given both arms return hits, then they fuse by reciprocal rank and a hit matched by both appears once (deduped by `source + id`), mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:403-457`.

### US-012a.3 — Graceful fallback when embeddings are off

**As a** operator with embeddings disabled, **I want to** lexical-only search that still works, **so that** search never blocks on the embed daemon.

**Acceptance criteria:**
- AC-012a.3.1 Given embeddings off / the embed client absent or returning null, then the semantic arm is skipped and the lexical arm runs alone, mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:2091-2106`.
- AC-012a.3.2 Given the lexical-only run, then `degraded: true` is returned (the honest "semantic arm did not run" signal), mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:2106`.

### US-012a.4 — Fail-soft on a missing table

**As a** operator on a fresh workspace, **I want to** search to return empty rather than error, **so that** a not-yet-created table does not break the tool.

**Acceptance criteria:**
- AC-012a.4.1 Given `source_graph_versions` does not exist, then the engine returns `{ hits: [], sources: [], degraded: true }`, never a 500, mirroring the per-arm fail-soft at `honeycomb/src/daemon/runtime/memories/recall.ts:24-35`.
- AC-012a.4.2 Given an empty query, then the engine returns the empty/degraded floor, mirroring `honeycomb/src/daemon/runtime/memories/recall.ts:2070-2073`.

---

## Implementation notes

- **Mirror the arm builders, do not import them.** Per decision #2 ([`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)), the hivenectar engine mirrors the recall arm-builder pattern in its own code; it does not import honeycomb's `recall.ts`. The `buildMemoriesArmSql`/`buildMemoryArmSql`/`buildSessionsArmSql` trio (`honeycomb/src/daemon/runtime/memories/recall.ts:319-383`) is the template for the lexical arm.
- **SQL-safety floor.** Every identifier routes through `sqlIdent`; the term through `sqlLike`; the `LIMIT` is a clamped integer bare-interpolation; no value is hand-quoted (mirrors the audit-floor discipline at `honeycomb/src/daemon/runtime/memories/recall.ts:56-60`).
- **Reuse the embed client.** The semantic arm consumes the same `EmbedClient` interface sessions/memories use (`honeycomb/src/daemon/runtime/services/embed-client.ts:80-83`); it does not fork an embed path. The 768-dim contract is enforced client-side before the vector reaches the arm.
- **`describe_status = 'described'` is non-negotiable.** Pending/failed/skipped rows never surface in search — a file never described does not appear ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)). This is the same filter the recall arm applies.
- **One clamp site for the limit.** The default (20) and the clamp (`[1, 200]`) come from `DEFAULT_RECALL_LIMIT`/`MAX_RECALL_LIMIT` (`honeycomb/src/daemon/runtime/memories/recall.ts:129-131`); the engine does not invent its own default.
- **Storage through the client only.** The engine reads via the injected `storage.query(sql, scope)`; the tenant partition rides the `QueryScope`, and `project_id` is a soft column filter within it (decision #3, [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)).

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Search result default LIMIT 20. The shared recall engine defines `DEFAULT_RECALL_LIMIT = 20` (`honeycomb/src/daemon/runtime/memories/recall.ts:129`) and `MAX_RECALL_LIMIT = 200` (`honeycomb/src/daemon/runtime/memories/recall.ts:131`); the search engine reuses the same clamp so one default governs search + recall. From the shared engine's default, confirm.

---

## Related

- [`./prd-012-manual-source-graph-search-index.md`](./prd-012-manual-source-graph-search-index.md)
- [`./prd-012b-cli-and-endpoint.md`](./prd-012b-cli-and-endpoint.md) — the CLI + endpoint that call this engine.
- [`../../../knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — AUTHORITATIVE: the arm SQL shape, latest-per-nectar subquery, `describe_status = 'described'` filter, vector arm, fail-soft guard.
- [`../../../knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the `source_graph_versions` columns (`title`, `description`, `concepts`, `embedding`, `describe_status`, `seq`, `nectar`, tenancy).
- [`../../MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — decision #2 (per-arm guarded query, not UNION ALL), decision #3 (`project_id` soft filter).
- `honeycomb/src/daemon/runtime/memories/recall.ts:319-383` — the three arm builders the lexical arm mirrors.
- `honeycomb/src/daemon/runtime/memories/recall.ts:925-961` — `runSemanticArm` (the `<#>` arm the semantic arm mirrors).
- `honeycomb/src/daemon/runtime/memories/recall.ts:403-457` — `fuseHits` (the RRF + dedup the standalone fusion mirrors).
- `honeycomb/src/daemon/runtime/memories/recall.ts:24-35, 129-131, 303-308, 2064-2119` — fail-soft rationale, `DEFAULT_RECALL_LIMIT`/`MAX_RECALL_LIMIT`, `resolveRecallLimit`, the result-shape template.
- `honeycomb/src/daemon/runtime/services/embed-client.ts` — the `EmbedClient` the semantic arm consumes (`:80-83` interface, `:240-287` null-on-failure).
- `honeycomb/src/daemon/storage/vector.ts:35` — `EMBEDDING_DIMS = 768` (the dimension contract).
