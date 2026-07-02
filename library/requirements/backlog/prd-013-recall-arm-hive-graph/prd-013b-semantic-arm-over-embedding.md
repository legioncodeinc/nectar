# PRD-013b: Semantic Arm — `<#>` Cosine over the `embedding` Column

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M

## Overview

The semantic arm is the second half of the hybrid hive-graph recall. When an `EmbedClient` is injected and the query embeds to a real 768-dim vector, recall runs the `<#>` cosine match over the `hive_graph_versions.embedding` column and contributes its cosine-ranked list to the RRF fusion alongside the lexical arm (PRD-013a). It is the arm that lets a query like *"where is the login logic"* surface `src/middleware/session-refresh.ts` even when none of the words `login`/`session`/`refresh` appear in the description — the vector carries the semantic proximity the lexical `ILIKE` cannot ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "Structural-vs-semantic complementarity in practice").

This sub-PRD adds a `hive_graph_versions` entry to `SEMANTIC_ARMS` (`recall.ts:868-888`), the array of `SemanticArmSpec` records `runSemanticArms` (`recall.ts:1008-1032`) iterates. It reuses the EXISTING `vectorSearch` engine (`recall.ts:943-953`, `storage/vector.ts`) and the existing `buildSemanticHydrateSql` + `runSemanticArm` machinery — no forked vector path. The arm is paired with the lexical arm (PRD-013a): the two share an id space (the `nectar`) so a file surfaced by both fuses its contributions into one `source+id`-deduped hit (`recall.ts:403-457`).

## Goals

- Add a `hive_graph_versions` entry to `SEMANTIC_ARMS` (`recall.ts:868-888`) so `runSemanticArms` runs the `<#>` match over `embedding` for this table.
- Widen the `SemanticArmSpec.source` type (`recall.ts:852`) so the new arm is type-correct against the extended `RecallSource` union.
- Reuse the existing `vectorSearch` engine and `runSemanticArm` pipeline — no forked vector search.
- Wire the arm through `embeddingColumnFor` (`recall.ts:1041-1045`) so the PRD-047b rerank stage can re-score the fused top-N by `cosine(query, candidate)` over this table's embedding.

## Non-Goals

- The lexical arm — PRD-013a.
- The graceful-fallback behavior (no `EmbedClient` / null embed) — PRD-013c.
- The `embedding` column itself — PRD-005b; the vector that fills it — PRD-014.
- Changing `EMBEDDING_DIMS` (`vector.ts:35`) or `assertEmbeddingDim` (`vector.ts:75-84`). The 768-dim contract is schema-coupled and load-bearing.
- A new vector engine. `vectorSearch` (`storage/vector.ts`) is reused as-is (D-5, `recall.ts:916-924`).

## The 768-dim contract

The `embedding` column is `FLOAT4[]`, **768-dim**, vector over `title + ' ' + description` — the same dimensionality as `sessions.message_embedding` and `memory.summary_embedding`, which is the whole reason the same hybrid pipeline can query all three ([PRD-005b](../../completed/prd-005-hive-graph-catalog-tables/prd-005b-hive-graph-versions-table.md) § "The `embedding` column"; [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "Fusion with the other arms"). `runSemanticArms` rejects any non-768 query vector before any arm runs (`recall.ts:1025`: `queryVector.length !== EMBEDDING_DIMS → null`), so the semantic arm never executes on a wrong-dim query. PRD-014's provider switch honors this: both the local nomic default and the Cohere-via-Portkey opt-in produce 768-dim vectors, or the guard discards the vector.

## The `SEMANTIC_ARMS` entry

`SEMANTIC_ARMS` (`recall.ts:868-888`) is a `readonly SemanticArmSpec[]` that `runSemanticArms` iterates with `Promise.all` (`recall.ts:1027-1029`), running one `runSemanticArm` per spec. Each spec names the table, the id column, the embedding column, the text column, the timestamp column, and an optional hydration filter.

The `SemanticArmSpec.source` field is typed as `Extract<RecallSource, "memories" | "sessions">` (`recall.ts:852`) — a constrained subset of the union. Adding `"hive_graph_versions"` to `RecallSource` (PRD-013a) does NOT automatically admit it into `SEMANTIC_ARMS`; this type constraint must also be widened to include the new source, else the entry does not type-check:

```ts
readonly source: Extract<RecallSource, "memories" | "sessions" | "hive_graph_versions">;
```

The new entry:

```ts
{
	source: "hive_graph_versions",
	table: "hive_graph_versions",
	idColumn: "nectar",
	embeddingColumn: "embedding",
	textColumn: "description",
	timestampColumn: "described_at",
	hydrateFilter: `AND ${sqlIdent("describe_status")} = 'described'`,
},
```

### Column mapping — verified against PRD-005b

- **`idColumn: "nectar"`** — the stable file identity. The semantic arm matches version rows but returns their `nectar` as the id, so a file hit by both arms fuses on `source+nectar` (`recall.ts:403-457`).
- **`embeddingColumn: "embedding"`** — the nullable 768-dim `FLOAT4[]` column. `vectorSearch` ignores null/empty embeddings rather than failing (`vector.ts:18-19`), so an undescribed file's null embedding contributes nothing — no error.
- **`textColumn: "description"`** — the body hydrated for the hit. (The `title` is a ≤80-char label; the `description` is the 1–3-sentence body the surface renders, matching the lexical arm's `text` projection.)
- **`timestampColumn: "described_at"`** — aliased to `created_at` by `buildSemanticHydrateSql` (`recall.ts:910`) for the recency dampener (PRD-047d), mirroring how `memories.created_at` and `sessions.creation_date` alias.
- **`hydrateFilter: "AND describe_status = 'described'"`** — the hydration guard that excludes pending/failed/skipped rows, mirroring the lexical arm's `describe_status = 'described'` filter and the `memories` arm's `is_deleted = 0` guard (`recall.ts:877`).

### The version-table nuance (verified constraint)

`hive_graph_versions` is **append-only**, one row per observed state of a file (`MAX(seq)` per nectar is the "latest version" query, [PRD-005b](../../completed/prd-005-hive-graph-catalog-tables/prd-005b-hive-graph-versions-table.md)). The embedding lives on the version row, not on a current-state row as it does on `memories`/`sessions`. This is the one place the hive-graph semantic arm diverges from its siblings, and the divergence is a verified constraint, not an invented value:

- `vectorSearch` (`recall.ts:943-953`, `storage/vector.ts`) matches the `embedding` column directly and returns scored ids. On an append-only version table, this matches **individual version rows** — including non-latest or undescribed rows whose embedding is non-null — and returns their nectars. A file with two described versions therefore can return two matches for the same nectar.
- The existing `runSemanticArm` dedups by id within the arm (`recall.ts:976-980`, the `seen` set), and `fuseHits` dedups cross-arm by `source+id` (`recall.ts:403-457`). So a nectar hit twice from the semantic arm collapses to one entry, and a nectar hit by both arms fuses its contributions — the dedup is correct.
- The `hydrateFilter: "AND describe_status = 'described'"` plus the `projectClause` (the `project_id` conjunct `runSemanticArm` threads into both the `<#>` match and the hydrate, `recall.ts:934, 966`) keep the hydration scoped to described rows in the right project.

The remaining question — whether the semantic match should be restricted to the **latest** described version per nectar (so a stale prior version's embedding cannot win the cosine match over the current version's) — is a fidelity concern. The lexical arm enforces latest-per-nectar via its `MAX(seq)` subquery (PRD-013a); the semantic arm, reusing `vectorSearch`, does not carry that subquery. This is flagged below as an implementation decision: the conservative choice is to accept the version-table match and rely on the within-arm `seen` dedup, which is correct (no duplicate hits) but may, on a heavily-versioned file, occasionally surface the cosine-best version rather than the strictly-latest. Surfaced for implementation; no value invented.

## The rerank seam — `embeddingColumnFor`

The PRD-047b rerank stage re-scores the fused top-N by `cosine(query, candidate)` over each hit's embedding. `embeddingColumnFor` (`recall.ts:1041-1045`) maps a source to its embedding column, returning `null` for sources without one:

```ts
function embeddingColumnFor(source: RecallSource): string | null {
	if (source === "memories") return "content_embedding";
	if (source === "sessions") return "message_embedding";
	return null; // `memory` (summaries) — no embedding column.
}
```

It gains a branch for the new source so its candidates participate in the rerank fetch (`fetchCandidateEmbeddings`, `recall.ts:1096-1110`):

```ts
function embeddingColumnFor(source: RecallSource): string | null {
	if (source === "memories") return "content_embedding";
	if (source === "sessions") return "message_embedding";
	if (source === "hive_graph_versions") return "embedding";
	return null; // `memory` (summaries) — no embedding column.
}
```

The companion `idColumnFor` (`recall.ts:1073-1075`) already maps non-`sessions`/non-`memory` sources to `"id"` — but the hive-graph id column is `nectar`, not `id`. This must be corrected so the rerank fetch keys on the right column:

```ts
function idColumnFor(source: RecallSource): string {
	if (source === "sessions" || source === "memory") return "path";
	if (source === "hive_graph_versions") return "nectar";
	return "id";
}
```

Both edits keep the rerank stage fail-soft: a fetch failure degrades the rerank to the RRF order, never throws (`recall.ts:1093-1095`).

## Reused machinery (no fork)

The semantic arm reuses the existing pipeline unchanged:

- **`runSemanticArm`** (`recall.ts:925-984`) — embed → `vectorSearch` (`<#>`) → hydrate, tolerant like the lexical `runArm` (a missing table/column or query error degrades this arm to empty, `recall.ts:955-959`).
- **`vectorSearch`** (`storage/vector.ts`) — validates the dim (`assertEmbeddingDim`, `vector.ts:75-84`), over-fetches (default 3×, `vector.ts:38`), and applies the org/workspace partition via `QueryScope` plus the inline `project_id` conjunct (`recall.ts:949-952`). NOT forked (D-5).
- **`buildSemanticHydrateSql`** (`recall.ts:898-914`) — the guarded hydration SELECT, reusing `sLiteral`/`sqlIdent` and aliasing the timestamp to `created_at`.
- **`runSemanticArms`** (`recall.ts:1008-1032`) — embeds the query once, runs every `SEMANTIC_ARMS` spec concurrently, returns one `RankedArm` per table plus the reused query vector for the reranker.

Adding the spec to `SEMANTIC_ARMS` is the integration: `runSemanticArms` iterates the array, so the new arm runs automatically under the same concurrency, the same bounded pool (`resolveRecallPool`, `recall.ts:117-121`), and the same `degraded`-truth logic (`recall.ts:2084-2106`). No new orchestration code.

## Acceptance Criteria

- [ ] A `hive_graph_versions` `SemanticArmSpec` is appended to `SEMANTIC_ARMS` (`recall.ts:868-888`) with `table: "hive_graph_versions"`, `idColumn: "nectar"`, `embeddingColumn: "embedding"`, `textColumn: "description"`, `timestampColumn: "described_at"`, and `hydrateFilter` excluding non-`described` rows.
- [ ] The `SemanticArmSpec.source` type constraint (`recall.ts:852`) is widened to include `"hive_graph_versions"`; the entry type-checks.
- [ ] Given an injected `EmbedClient` whose query embed is a 768-dim vector, `runSemanticArm` for the new spec runs `<#>` over `embedding` via the existing `vectorSearch` (`recall.ts:943-953`) and contributes its cosine-ranked list to the RRF fusion.
- [ ] A non-768 query vector short-circuits the whole semantic path to `null` (`recall.ts:1025`) before the new arm runs — the arm never executes on a wrong-dim vector.
- [ ] `embeddingColumnFor` (`recall.ts:1041-1045`) returns `"embedding"` for `"hive_graph_versions"`; `idColumnFor` (`recall.ts:1073-1075`) returns `"nectar"` for `"hive_graph_versions"`, so the PRD-047b rerank fetch keys on the correct column.
- [ ] A file hit by both the semantic and the lexical hive-graph arm fuses into one `source+nectar`-deduped hit (`recall.ts:403-457`); the within-arm `seen` set (`recall.ts:976-980`) collapses a nectar matched on two version rows to one entry.
- [ ] Given the `embedding` column is missing or a query error occurs, `runSemanticArm` returns `[]` for this arm only (`recall.ts:955-959`); the lexical arm and the other arms still answer.

## Related

- [PRD-013](./prd-013-recall-arm-hive-graph-index.md) — the module index.
- [PRD-013a](./prd-013a-lexical-arm-builder-and-weight.md) — the lexical arm this semantic arm pairs with.
- [PRD-013c](./prd-013c-graceful-bm25-fallback.md) — the graceful fallback when embeddings are off.
- [PRD-005b](../../completed/prd-005-hive-graph-catalog-tables/prd-005b-hive-graph-versions-table.md) § "The `embedding` column" — the 768-dim nullable column.
- [PRD-014](../../in-work/prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md) — the embeddings provider producing the 768-dim vector.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm", § "Fusion with the other arms", § "Structural-vs-semantic complementarity in practice".
- `honeycomb/src/daemon/runtime/memories/recall.ts:852-888` — `SemanticArmSpec` + `SEMANTIC_ARMS`.
- `honeycomb/src/daemon/runtime/memories/recall.ts:898-984` — `buildSemanticHydrateSql` + `runSemanticArm`.
- `honeycomb/src/daemon/runtime/memories/recall.ts:1008-1032` — `runSemanticArms` (embeds once, iterates `SEMANTIC_ARMS`).
- `honeycomb/src/daemon/runtime/memories/recall.ts:1041-1045, 1073-1075` — `embeddingColumnFor` + `idColumnFor` (rerank seam).
- `honeycomb/src/daemon/storage/vector.ts:35, 75-84` — `EMBEDDING_DIMS` + `assertEmbeddingDim`.
