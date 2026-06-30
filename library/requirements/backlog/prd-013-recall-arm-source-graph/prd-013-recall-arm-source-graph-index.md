# PRD-013: Recall Arm — Add `source_graph_versions` to the Fused Recall

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M
> **Schema changes:** None (reads the PRD-005b table; adds no tables/columns)

## Overview

PRD-013 owns the **load-bearing integration** — the single point at which Hivenectar's file descriptions surface inside an agent's recall. It adds a fourth arm to Honeycomb's shared hybrid recall engine so a query like *"where is the login logic"* returns the code-file description (`src/middleware/session-refresh.ts` — "refreshes JWT claims on each authenticated request") alongside the session trace and the distilled fact, fused into one ranked list. The integration is the sole agent-facing exposure point for Hivenectar: because recall is a shared engine that every harness (Claude Code, Codex, Cursor) already calls through its hook loopback, a new arm propagates to all of them with zero per-harness work (locked decision, [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md) "Two decisions recorded this revision" #1; see PRD-009 for the per-harness mapping).

The defining constraint — locked as decision #2 in [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md) — is that the integration is **per-arm, not a `UNION ALL`**. Recall runs each table as its own guarded `storage.query` precisely so a missing sibling table on a fresh workspace degrades to "empty for that arm" rather than failing the whole recall (`recall.ts:24-35`). The 4th arm therefore **mirrors** the existing three arm builders (`buildMemoriesArmSql` / `buildMemoryArmSql` / `buildSessionsArmSql` at `recall.ts:319-383`) as a new `buildSourceGraphVersionsArmSql`, plus a `RecallSource` union entry, an `ARM_CLASS_WEIGHT` entry, a semantic-arm spec over the `embedding` column, and the `runArm`/`arms` insertions in the `Promise.all` fusion. A `UNION ALL` refactor is explicitly rejected: it would regress the deliberate graceful-degradation design (a missing `source_graph_versions` table on a fresh workspace would blank out the session/memory hits too).

The arm queries the latest described version per nectar — a `MAX(seq)` subquery that collapses a file's 50 near-duplicate version rows into the one current row — filtered to `describe_status = 'described'`, scoped by `project_id` (the soft column filter from [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm" and PRD-005c). The authoritative integration spec is [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) (read in full); the table it reads is defined in PRD-005b; the embedding column it scores is produced by PRD-014.

## Defaults registered in this PRD

Two values are defaults pending implementation confirmation. Each is flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| `ARM_CLASS_WEIGHT` for `source_graph_versions` | `1.0` (the distilled `memory` class weight) | 013a | Hivenectar descriptions are LLM-minted, clean, and short — the same shape as the distilled `memory`/`memories` arms, not the noisy `sessions` dumps. Equal weighting is the corpus default ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "Weighting and the Hivenectar multiplier"). Flagged for eval-harness tuning. |
| The arm's per-arm `LIMIT` | Matches the existing arms' bound — the clamped caller `limit` (`resolveRecallLimit`, default 20, `recall.ts:128-129`) | 013a, 013b | Every existing arm is bounded by the overall `limit` (`recall.ts:2096-2101`) so no single arm starves the fusion; the 4th arm matches that bound. |

## Goals

- Add `"source_graph_versions"` to the `RecallSource` union (`recall.ts:169`) so the arm is a first-class source the fusion, dedup, and rerank stages recognize.
- Author `buildSourceGraphVersionsArmSql` mirroring `buildMemoriesArmSql` (`recall.ts:319-337`): guarded `ILIKE` over `title`/`description`/`concepts`, the latest-per-nectar `MAX(seq)` subquery, the `describe_status = 'described'` filter, and `project_id` scoping via the shared `buildProjectScopeConjunct`.
- Register the arm in `ARM_CLASS_WEIGHT` (`recall.ts:158-161`) at the distilled-`memory` class weight and wire it through `kindOfSource` (`recall.ts:164-166`) so the RRF fusion scores it as a clean distilled hit, not a raw session dump.
- Add a `source_graph_versions` entry to `SEMANTIC_ARMS` (`recall.ts:868-888`) running `<#>` cosine over the 768-dim `embedding` column, so the arm is hybrid (lexical + semantic) like `memories` and `sessions`.
- Insert the new arm into the `Promise.all` + `arms` array (`recall.ts:2096-2118`) so it runs concurrently with the other three and contributes to the RRF fusion.
- Preserve the fail-soft contract: a missing `source_graph_versions` table on a fresh workspace degrades to empty for this arm only; the other arms still answer (`recall.ts:24-35`, 826-842).

## Non-Goals

- The `source_graph_versions` table itself — defined in PRD-005b.
- The enricher loop that fills `title`/`description`/`embedding` — PRD-016.
- The embeddings provider that produces the 768-dim vector — PRD-014.
- The harness exposure / "why no own hooks" documentation — PRD-009.
- A manual operator-facing search surface — PRD-012 (scoped to `source_graph_versions` only, not fused).
- Dedup against CodeGraph hits. A file that appears in both a Hivenectar recall hit and a CodeGraph `find/` hit is returned twice; the agent (or harness prompt assembler) reconciles them ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "What recall does not do with Hivenectar").
- Returning historical versions. Only the latest described version per nectar participates in recall; prior versions stay in the append-only chain as history, not as recall candidates.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-013a-lexical-arm-builder-and-weight](./prd-013a-lexical-arm-builder-and-weight.md) | Lexical arm: `buildSourceGraphVersionsArmSql` + `RecallSource` + `ARM_CLASS_WEIGHT` + insertion | Draft |
| [prd-013b-semantic-arm-over-embedding](./prd-013b-semantic-arm-over-embedding.md) | Semantic arm over the 768-dim `embedding` column; `SEMANTIC_ARMS` entry; embed-client integration | Draft |
| [prd-013c-graceful-bm25-fallback](./prd-013c-graceful-bm25-fallback.md) | Graceful BM25-only fallback when embeddings are off — no error, no quality cliff | Draft |

## Acceptance Criteria

- [ ] `"source_graph_versions"` is a member of the `RecallSource` union (`recall.ts:169`); `readSource` (`recall.ts:385-389`) recognizes it (rather than defaulting it to `"sessions"`).
- [ ] `buildSourceGraphVersionsArmSql` mirrors `buildMemoriesArmSql` (`recall.ts:319-337`): every identifier routes through `sqlIdent`, the search term through `sqlLike`, the `LIMIT` through the bare-numeric interpolation, and it projects `source`/`id`/`text`/`created_at` for `rowsToRankedArm` (`recall.ts:488-497`).
- [ ] The lexical arm carries the latest-per-nectar `MAX(seq)` subquery, the `describe_status = 'described'` filter, and the `project_id` conjunct from `buildProjectScopeConjunct` — matching the SQL shape in [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm".
- [ ] `ARM_CLASS_WEIGHT` scores `source_graph_versions` as the distilled `memory` class (`recall.ts:158-166`); the RRF contribution is `1.0 / (RRF_K + rank)`.
- [ ] The arm runs in the `Promise.all` (`recall.ts:2096-2101`) and is appended to the `arms` array (`recall.ts:2113-2118`); its hits fuse with the other three via `fuseHits` (`recall.ts:403-457`).
- [ ] Given an injected `EmbedClient` whose query embed is a 768-dim vector, a `source_graph_versions` semantic-arm spec in `SEMANTIC_ARMS` (`recall.ts:868-888`) runs `<#>` cosine over `embedding` and contributes its cosine-ranked list to the RRF fusion.
- [ ] Given embeddings are off (no `EmbedClient`, or a null/wrong-dim embed), the lexical arm runs alone and `degraded` is `true` — no error, no quality cliff; `source_graph_versions` BM25 hits still surface (`recall.ts:2084-2106`).
- [ ] Given the `source_graph_versions` table is absent (fresh workspace, brooding not yet run), the arm returns empty for that arm only; the `memories`/`memory`/`sessions` arms still answer — the per-arm fail-soft contract (`recall.ts:24-35`, 826-842) holds.

## Related

- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the authoritative integration spec (read in full).
- [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md) decision #2 — the locked per-arm-not-UNION-ALL decision; "Two decisions recorded" #1 — the extend-recall-not-hooks decision.
- [PRD-005b](../prd-005-source-graph-catalog-tables/prd-005b-source-graph-versions-table.md) — the `source_graph_versions` table this arm reads (DDL + the 768-dim nullable `embedding` column).
- [PRD-005c](../prd-005-source-graph-catalog-tables/prd-005c-tenancy-and-project-id-filter.md) — the `project_id` soft-filter contract the arm's scoping relies on.
- [PRD-014](../prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md) — the embeddings provider producing the 768-dim vector the semantic arm scores.
- [PRD-009](../prd-009-harness-exposure-via-recall-extension/prd-009-harness-exposure-via-recall-extension-index.md) — the harness-exposure documentation that consumes this arm (no own hooks).
- [`honeycomb/src/daemon/runtime/memories/recall.ts:24-35`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) — the per-arm rationale.
- [`honeycomb/src/daemon/runtime/memories/recall.ts:158-166, 169`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) — `ARM_CLASS_WEIGHT` + `kindOfSource` + `RecallSource`.
- [`honeycomb/src/daemon/runtime/memories/recall.ts:319-383`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) — the three arm builders to mirror.
- [`honeycomb/src/daemon/runtime/memories/recall.ts:403-457`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) — `fuseHits` / RRF.
- [`honeycomb/src/daemon/runtime/memories/recall.ts:868-888`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) — `SEMANTIC_ARMS`.
- [`honeycomb/src/daemon/runtime/memories/recall.ts:2064-2119`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) — the `Promise.all` + `arms` array insertion points.
