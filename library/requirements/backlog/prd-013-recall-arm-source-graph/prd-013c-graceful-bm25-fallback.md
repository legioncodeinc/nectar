# PRD-013c: Graceful BM25-Only Fallback When Embeddings Are Off

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S

## Overview

The fallback behavior is the property that makes the source-graph recall a **resilient floor**, not a brittle feature. When embeddings are off — no `EmbedClient` injected, or the query embed returns null (the embeddings daemon down / unreachable / timed-out / wrong-dim) — the lexical source-graph arm (PRD-013a) runs alone and the semantic arm (PRD-013b) silently contributes nothing. There is no error, no partial failure surfaced to the agent, and no quality cliff: a file-description match still surfaces on the lexical `ILIKE` over `title`/`description`/`concepts`. This sub-PRD confirms the new arm inherits the exact graceful-fallback behavior every existing arm already carries, by construction.

The behavior is not new code to write — it is the guaranteed consequence of how recall is architected. This sub-PRD exists to document that consequence for the source-graph arm, name the mechanisms that produce it, and fix the acceptance criteria the implementation must satisfy. The authoritative description is [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm" ("When embeddings are off, only the BM25 arm runs — same silent-fallback behavior as every other recall arm in Honeycomb").

## Goals

- Confirm the lexical source-graph arm (PRD-013a) runs unconditionally as part of the resilient lexical floor, independent of the embed path.
- Confirm the semantic source-graph arm (PRD-013b) degrades to empty (not error) whenever the semantic path cannot run, and that this leaves the lexical arm intact.
- Confirm the per-arm fail-soft contract holds for the new arm: a missing `source_graph_versions` table degrades to empty for this arm only, never fails the recall.
- Pin the `degraded` flag's honesty: lexical-only source-graph recall reports `degraded: true` when the semantic path could not run.

## Non-Goals

- The lexical arm builder — PRD-013a.
- The semantic arm spec — PRD-013b.
- The embeddings provider that, when on, makes the semantic arm run — PRD-014.
- Introducing a new fallback mode. Recall already has exactly two branches (`recall.ts:2048-2062`); this PRD adds no third.
- Filling undescribed rows into recall. A file with `describe_status != 'described'` is excluded from BOTH the lexical and the semantic arm; the fallback is BM25-over-described-rows, not BM25-over-everything ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "What recall does not do with Hivenectar").

## The two branches

Recall has exactly two execution branches (`recall.ts:2048-2062`), and the source-graph arm participates in both:

- **SEMANTIC ran.** An `EmbedClient` is injected AND the query embedded to a 768-dim vector → the `<#>` cosine arms run (including the source-graph semantic arm, PRD-013b) and contribute their cosine-ranked lists to the RRF fusion. `degraded` is `false`. The lexical source-graph arm ALSO ran (it always does).
- **LEXICAL fallback.** No embed client, or the embed returned null/off/unreachable/timeout/wrong-dim → only the BM25/ILIKE arms run, including the lexical source-graph arm (PRD-013a). `degraded` is `true`.

The lexical arms ALWAYS run — they are the resilient floor (`recall.ts:2056-2058`). The semantic path is additive: when it can run, it contributes ranked lists; when it cannot, it contributes nothing and the lexical arms carry the recall. The source-graph arm follows this shape exactly because it is wired into the same `Promise.all` and `arms` array as the others (PRD-013a).

## Why the fallback is silent — the embed path never throws

`runSemanticArms` (`recall.ts:1008-1032`) returns `null` — not an exception — for every condition that makes the semantic path unable to run:

- **No `EmbedClient` injected** (`recall.ts:1013`): `deps.embed === undefined → null`.
- **The embed call returns null** (`recall.ts:1017`): the `EmbedClient.embed` contract is null-on-failure.
- **The embed call throws unexpectedly** (`recall.ts:1018-1022`): a flaky embeddings daemon degrades recall to lexical, never throws into the route.
- **The embed returns a wrong-dim vector** (`recall.ts:1025`): `queryVector.length !== EMBEDDING_DIMS → null` (defense in depth; the client already dim-guards).

A `null` semantic run is the signal to the caller that the lexical floor carries the recall, and `degraded` is set honestly from it (`recall.ts:2106`: `const degraded = keywordOnly ? false : semanticRun === null`). The source-graph semantic arm participates in this exactly: when `runSemanticArms` returns `null`, no `SemanticArmSpec` (including the new one) runs, and the lexical source-graph arm still answers from the `Promise.all`.

The one exception is `keyword` mode (`recall.ts:2084`): when the user-selected `recallMode === "keyword"`, the semantic path is skipped *by intent* (`recall.ts:2097`: `keywordOnly ? Promise.resolve(null) : ...`), and `degraded` is forced `false` because an intentional lexical-only run is not a degraded fallback (PRD-029 coherence). In `keyword` mode the source-graph arm is lexical-only too — by design, not by failure.

## The per-arm fail-soft — a missing table degrades to empty for that arm

The second fallback layer is per-arm. Each lexical arm is its own guarded `storage.query` (`recall.ts:24-35`). `runArm` (`recall.ts:826-842`) treats a non-`ok` result — a missing `source_graph_versions` table on a fresh partition (brooding not yet run), any `query_error`, a connection error, a timeout — as EMPTY for that arm, not a recall-wide failure:

```ts
async function runArm(sql, request, deps): Promise<StorageRow[]> {
	const pool = resolveRecallPool(deps);
	const result = await pool.run(() => deps.storage.query(sql, request.scope, { source: SOURCE_RECALL_ARM }));
	return isOk(result) ? result.rows : [];
}
```

This is the contract that makes the new arm safe to add: a workspace where Hivenectar brooding has not yet created `source_graph_versions` returns `[]` for the source-graph arm, and the `memories`/`memory`/`sessions` arms still answer. The source-graph semantic arm carries the same contract via `runSemanticArm` (`recall.ts:955-959`): a missing `embedding` column/table or any query error returns `[]` for that arm. Recall fails-soft overall — every arm failing yields an empty result, never a 500 (`recall.ts:2044-2047`).

## No quality cliff

The fallback is graceful in quality, not just in error-handling. A description-less fallback would be a cliff (empty results); a BM25-over-descriptions fallback is the same kind of lexical recall the `memories` and `sessions` arms perform, over content that is LLM-minted and clean ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "Fusion with the other arms" — "sessions JSONB is noisy; Hivenectar descriptions are clean and short"). The lexical `ILIKE` over `title`/`description`/`concepts` finds files whose description names the query topic; it simply cannot find files whose description is semantically about the topic without naming it (that is what the semantic arm adds). The two together are strictly better than either alone; the lexical floor alone is the honest degraded mode, not a broken state.

## Acceptance Criteria

- [ ] Given no `EmbedClient` is injected, the lexical source-graph arm (PRD-013a) runs and the semantic source-graph arm (PRD-013b) contributes nothing; `degraded` is `true` (`recall.ts:1013, 2106`).
- [ ] Given the embed returns null (daemon down / unreachable / timeout), recall degrades to lexical-only including the source-graph lexical arm; no exception propagates into the route (`recall.ts:1017-1022`).
- [ ] Given the embed returns a non-768 vector, the whole semantic path short-circuits to `null` (`recall.ts:1025`) before the source-graph semantic arm runs; the lexical source-graph arm still answers.
- [ ] Given `recallMode === "keyword"`, the semantic path is skipped by intent and `degraded` is `false`; the source-graph arm is lexical-only (`recall.ts:2084, 2097, 2106`).
- [ ] Given the `source_graph_versions` table is absent (fresh workspace, brooding not run), `runArm` returns `[]` for the source-graph arm; the other arms still answer and recall returns 200, not 500 (`recall.ts:826-842, 2044-2047`).
- [ ] Given the `embedding` column is missing or a query error occurs in the semantic arm, `runSemanticArm` returns `[]` for the source-graph arm only (`recall.ts:955-959`).
- [ ] The lexical-only source-graph recall surfaces files whose `title`/`description`/`concepts` match the query term, scoped to described rows and the right project — no quality cliff, no empty result when described rows exist.

## Related

- [PRD-013](./prd-013-recall-arm-source-graph-index.md) — the module index.
- [PRD-013a](./prd-013a-lexical-arm-builder-and-weight.md) — the lexical arm that forms the resilient floor.
- [PRD-013b](./prd-013b-semantic-arm-over-embedding.md) — the semantic arm that degrades to empty when embeddings are off.
- [PRD-014c](../../in-work/prd-014-embeddings-provider-switching/prd-014c-provider-switch-and-bm25-fallback.md) — the embeddings-provider-side BM25 fallback (the same graceful-degradation posture, from the provider switch's perspective).
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm", § "Fusion with the other arms", § "What recall does not do with Hivenectar".
- `honeycomb/src/daemon/runtime/memories/recall.ts:24-35` — the per-arm rationale.
- `honeycomb/src/daemon/runtime/memories/recall.ts:826-842` — `runArm` (per-arm fail-soft).
- `honeycomb/src/daemon/runtime/memories/recall.ts:955-959` — `runSemanticArm` per-arm fail-soft.
- `honeycomb/src/daemon/runtime/memories/recall.ts:1008-1032` — `runSemanticArms` null-on-every-failure.
- `honeycomb/src/daemon/runtime/memories/recall.ts:2044-2106` — the two branches + the honest `degraded` flag.
