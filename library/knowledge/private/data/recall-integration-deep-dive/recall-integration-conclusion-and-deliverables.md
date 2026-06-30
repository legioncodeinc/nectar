# Recall Integration — Conclusion and Deliverables

> Category: Data | Version: 1.0 | Date: June 2026 | Status: Draft

The deliverable of the recall-integration work restated in one place — a fourth recall arm that fuses the CodeGraph's structural answers and Hivenectar's semantic answers into one ranked list — alongside the two contracts (complementarity and graceful degradation) the arm honors, and the forward pointers to the rows, the descriptions, and the two-layer thesis that motivate the design.

**Related:**
- [`../recall-integration.md`](../recall-integration.md)
- [`recall-integration-introduction-and-theory.md`](recall-integration-introduction-and-theory.md)
- [`recall-integration-technical-specification.md`](recall-integration-technical-specification.md)
- [`recall-integration-user-stories.md`](recall-integration-user-stories.md)
- [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md)
- [`../source-graph-schema.md`](../source-graph-schema.md)
- [`../../ai/enricher-and-llm-model.md`](../../ai/enricher-and-llm-model.md)
- [`../../overview.md`](../../overview.md)

---

## Why this exists

This document closes the recall-integration deep-dive. It states the deliverable in one sentence, restates the two contracts the deliverable depends on (complementarity and graceful degradation), and points forward to the three documents outside this folder that a reader needs to understand the arm in full: the source-graph schema that defines the rows, the enricher doc that defines the descriptions, and the overview that defines the two-layer thesis. The preceding four documents expand the arm along different axes; this one consolidates.

---

## The deliverable

The deliverable is a fourth recall arm that makes the CodeGraph's structural answers and Hivenectar's semantic answers appear in one fused ranked list. Concretely, it is a `UNION ALL` arm over `source_graph_versions` — filtered to the latest described version per nectar, scoped by org/workspace/project, scored by BM25 over `title + description + concepts` and 768-dim vector similarity over `embedding`, and fused into the same reciprocal-rank pipeline as the sessions, memory, and memories arms.

The deliverable is *not* a separate query path, a separate index, or a separate fusion strategy. It is an arm — composable, scoped, fused, and weighted exactly like its three siblings. That shape is the point: a union arm participates in everything the pipeline already does, where a separate query would fragment scoping, fusion, and ranking across two paths and force the agent to reconcile them.

The SQL that implements the arm is in [`recall-integration-technical-specification.md`](recall-integration-technical-specification.md). The end-to-end trace of a query through it is in [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md). The acceptance criteria that define "done" are in [`recall-integration-user-stories.md`](recall-integration-user-stories.md).

---

## Contract 1 — Complementarity

The arm rests on a complementarity contract between the structural CodeGraph and the semantic Hivenectar layer. The contract has two clauses, and the arm is only useful because both hold.

**Independence.** A file can be in the CodeGraph without a nectar — it has AST structure but no description yet, because brooding has not reached it or it was skipped as binary. A file can have a nectar without being in the CodeGraph — a config file, a markdown doc, a `.env.example`, anything with meaning but no AST. The two indexes are built independently and queried independently; neither is a prerequisite for the other. The arm filters on `describe_status = 'described'`, so an undescribed file is absent from semantic recall even when it is present in the structural graph.

**Complementarity.** When both cover the same file, they contribute different facts. The CodeGraph contributes symbol names, line numbers, and call edges. Hivenectar contributes a description, concept tags, and an embedding. The recall layer does not deduplicate a file that appears in both a Hivenectar hit and a CodeGraph `find/` hit — both are returned, because dedup would strip the structural context the CodeGraph hit carries. Recognizing the two as the same file is the agent's (or the harness prompt assembler's) job.

The complementarity is observable in the worked example from [`../recall-integration.md`](../recall-integration.md): for the query *"everything associated with logins"*, the structural hit finds `login.ts` by symbol name, the semantic hit finds `session-refresh.ts`, `jwt.ts`, and `logout.ts` by description, and the session hit finds the human discussion. Separately each is a blind spot; together they give the agent a complete picture. The arm exists to put the semantic facet into the same ranked list as the others.

---

## Contract 2 — Graceful degradation

The arm honors a graceful-degradation contract: there is no quality cliff when embeddings are off.

The vector path gates on `embedding IS NOT NULL`. When the embeddings daemon is not installed, or it failed to warm up, the `embedding` column is NULL across the arm, the vector path returns nothing, and the BM25 path carries recall alone over `title` and `description`. There is no error, no empty result, and no special-case configuration. The arm returns lexical hits ranked by BM25 until embeddings are available, at which point vector scoring resumes on the next daemon warm-up without a manual re-index step.

This is the same silent-fallback behavior every other recall arm in Honeycomb uses. The contract is that Hivenectar is not a special case operationally: disabling embeddings degrades the arm the same way it degrades sessions, memory, and memories — lexical-only, no cliff. An operator who runs Hivenectar without the embeddings daemon gets working semantic recall over file descriptions; an operator who enables the daemon gets hybrid lexical+vector recall over the same descriptions. The arm is useful in both states.

---

## What recall does not do with Hivenectar

The deliverable is bounded by a set of deliberate non-guarantees, all documented in [`../recall-integration.md`](../recall-integration.md) and traced in [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md):

- **It does not return undescribed rows.** The `describe_status = 'described'` filter excludes pending, failed, and skipped rows. An undescribed file is absent from semantic recall, though it may still appear in the structural CodeGraph.
- **It does not deduplicate against CodeGraph hits.** A file appearing in both a Hivenectar hit and a structural hit is returned twice; reconciliation is the agent's job.
- **It does not return historical versions.** Only the latest described version per nectar participates. Prior versions are history, not recall.
- **It does not run during brooding's LLM calls.** Recall reads Deep Lake; brooding writes Deep Lake; the two proceed concurrently with no coordination. A query mid-brood sees whatever has been described so far.

These are not limitations to be fixed; they are the shape of the contract. The arm serves the current question over the current described state of the codebase, scoped to the caller's tenancy, fused with the other arms.

---

## How the deliverable is verified

The arm is done when its acceptance criteria pass and the two contracts hold under test. The criteria are enumerated in [`recall-integration-user-stories.md`](recall-integration-user-stories.md); the two contracts they reduce to are verifiable concretely.

**Complementarity is verified** by a query that returns both a Hivenectar semantic hit and a CodeGraph structural hit for the same file, with both present in the output and neither deduplicated away. The worked login query from [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md) is the canonical fixture: `src/auth/login.ts` appears as a semantic hit by description, and the same path can appear as a structural `find/login` hit by symbol name. Independence is verified by the converse fixtures — a described file with no AST surfacing in semantic recall but not in `find/`, and an undescribed file with AST structure surfacing in `find/` but not in semantic recall.

**Graceful degradation is verified** by running the same query twice: once with the embeddings daemon available (vector path active, hybrid BM25+vector scoring), once with the embeddings daemon stopped or absent (vector path returns nothing, BM25 carries recall alone). The contract holds when the second run returns a lexical-only ranked list with no error and no empty result, and when re-enabling the daemon restores vector scoring without a manual re-index. The fallback must match the behavior of the sessions, memory, and memories arms under the same condition — Hivenectar is not a special case.

The SQL contract behind these verifications — the latest-per-nectar subquery, the inside-subquery describe filter, the tenancy scoping, the per-arm multipliers — is in [`recall-integration-technical-specification.md`](recall-integration-technical-specification.md), and every dynamic value in the implementation must route through the storage-layer SQL guards (`sqlStr` / `sqlLike` and siblings) from the sibling daemon's `src/daemon/storage/sql.ts`.

---

## Forward pointers

The deep-dive is self-contained, but the arm is not. Three documents outside this folder carry the load-bearing context a reader needs to understand the arm in full.

**The rows — [`../source-graph-schema.md`](../source-graph-schema.md).** The arm reads `source_graph_versions`, whose full DDL, column-by-column rationale, indexing strategy, and tenancy model are documented here. The `seq` counter, the `describe_status` lifecycle, the `(nectar, content_hash)` composite key, and the denormalized tenancy columns are all defined in this document. The arm's latest-per-nectar subquery and its describe filter are direct consequences of this schema.

**The descriptions — [`../../ai/enricher-and-llm-model.md`](../../ai/enricher-and-llm-model.md).** The arm scores over `title`, `description`, and `concepts`, all of which are produced by the enricher. This document covers why Gemini 2.5 Flash is the canonical model (the 1M-token context window that makes batched description cheap), how the enricher debounces and rate-limits, how the "meaningful change" heuristic avoids re-describing cosmetic edits, and how the embeddings layer computes the 768-dim vector over `title + ' ' + description`. The arm is only as good as the descriptions the enricher produces.

**The two-layer thesis — [`../../overview.md`](../../overview.md).** The arm exists because structural identity is not semantic identity. The overview states the problem (the CodeGraph answers *"who calls this function"* but not *"where is the login logic"*), the three design pillars (stable daemon-minted identity, lazy LLM description, durable Deep Lake state with a portable projection), and the explicit non-goals (Hivenectar is not a replacement for the CodeGraph, not an LSP, not eager). The arm is the recall-side expression of that thesis: it is what makes the semantic layer reachable from a natural-language query, fused with the structural and discussion layers the pipeline already served.

---

## The deep-dive at a glance

| Document | Axis |
|---|---|
| [`recall-integration-introduction-and-theory.md`](recall-integration-introduction-and-theory.md) | The conceptual gap and the compositional thesis |
| [`recall-integration-technical-specification.md`](recall-integration-technical-specification.md) | The SQL contract: four-arm union, latest-per-nectar, RRF, guards |
| [`recall-integration-user-stories.md`](recall-integration-user-stories.md) | Engineering and operator acceptance criteria, persona by persona |
| [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md) | A single query traced end-to-end through the fused pipeline |
| `recall-integration-conclusion-and-deliverables.md` (this document) | The deliverable, the two contracts, forward pointers |

The canonical single-document summary remains [`../recall-integration.md`](../recall-integration.md); this deep-dive expands it along five axes without superseding it. The arm ships when its SQL contract is implemented behind the storage-layer guards, its acceptance criteria pass, and the two contracts (complementarity, graceful degradation) hold under test — at which point the CodeGraph's structural answers and Hivenectar's semantic answers appear in one fused ranked list, and the agent no longer has to run two queries and reconcile them in its own head.
