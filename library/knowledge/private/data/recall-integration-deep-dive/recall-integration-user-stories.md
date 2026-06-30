# Recall Integration — Engineering User Stories

> Category: Data | Version: 1.0 | Date: June 2026 | Status: Draft

Engineering and operator user stories with acceptance criteria for the Hivenectar recall arm: the personas who build, run, fuse, scope, and extend the fourth guarded arm, and the verifiable behavior each story demands. Scope is engineering — these are not product PRD stories.

**Related:**
- [`../recall-integration.md`](../recall-integration.md)
- [`recall-integration-technical-specification.md`](recall-integration-technical-specification.md)
- [`recall-integration-introduction-and-theory.md`](recall-integration-introduction-and-theory.md)
- [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md)
- [`recall-integration-conclusion-and-deliverables.md`](recall-integration-conclusion-and-deliverables.md)
- [`../source-graph-schema.md`](../source-graph-schema.md)

---

## Why this exists

This document captures the engineering contract for the Hivenectar recall arm as a set of user stories with acceptance criteria. Each story is written from the perspective of a persona who builds or operates a piece of the arm — the agent issuing a semantic query, the recall pipeline fusing results, the enricher producing described rows, the operator scoping by tenancy, the engineer adding the arm. The stories are the operational ground truth: they say what "done" looks like for each facet of the arm, in verifiable terms. The SQL behind them lives in [`recall-integration-technical-specification.md`](recall-integration-technical-specification.md); the end-to-end trace lives in [`recall-integration-ecosystem-story-arc.md`](recall-integration-ecosystem-story-arc.md).

These stories are engineering scope. They describe the arm's behavior, its contracts, and its failure modes — not product features, rollout plans, or success metrics. A product treatment belongs in a PRD, which is out of scope for this deep-dive.

---

## The personas

| Persona | Role | Cares about |
|---|---|---|
| The agent | Issues a semantic query at runtime and consumes the ranked list | Getting files alongside discussions in one list |
| The recall pipeline | Fuses the four arms by RRF | Rank-based fusion, per-arm multipliers, no score-scale mismatch |
| The enricher | Produces described rows that feed the arm | `describe_status='described'`, embedding presence, lazy filling |
| The operator | Scopes recall by tenancy and tunes weighting | Org/workspace/project isolation, multiplier knob |
| The engineer | Adds or maintains the `source_graph_versions` arm | SQL-guard compliance, latest-per-nectar, fallback behavior |

---

## The fourth guarded arm

**US-RI-001** — As the recall pipeline, I want the Hivenectar arm to participate in the same guarded per-arm recall flow as sessions, memory, and memories, so that file-description rows are fused with discussion rows rather than returned as a separate list.
**Acceptance criteria:** (a) the Hivenectar arm runs as its own guarded query and returns empty when its table is absent; (b) the Hivenectar arm is tagged `'hivenectar'` in its `source` column; (c) the agent receives one ranked list containing rows from all successful arms.

**US-RI-002** — As the engineer, I want the Hivenectar arm to be composable rather than a separate query, so that scoping, fusion, and weighting are shared with the other arms instead of re-implemented.
**Acceptance criteria:** (a) tenancy scoping is applied inside the arm using the same `org_id` / `workspace_id` / `project_id` columns the other arms use; (b) the arm's output is consumed by the same RRF fusion as the other three; (c) no second query path exists that the agent must invoke separately and merge by hand.

**US-RI-003** — As the engineer, I want every dynamic value in the arm's SQL to flow through the storage-layer SQL guards (`sqlStr` / `sqlLike` and siblings), so that no tenancy value, query pattern, or identifier can become an injection vector.
**Acceptance criteria:** (a) no string concatenation of user-supplied input into the recall SQL; (b) every bound parameter routes through the appropriate helper from `src/daemon/storage/sql.ts`; (c) a recall query that concatenates user input is treated as a defect.

---

## The latest-per-nectar subquery

**US-RI-004** — As the recall pipeline, I want the arm to return at most one row per nectar, so that a file edited many times does not dominate recall with near-duplicate version rows.
**Acceptance criteria:** (a) the arm joins `source_graph_versions` against a subquery computing `MAX(seq)` per nectar; (b) for any nectar, at most one row appears in the arm's output; (c) a nectar with 50 version rows contributes exactly one row to recall.

**US-RI-005** — As the engineer, I want "latest version" to be defined by the monotonic `seq` counter, not by timestamp parsing or `content_hash` ordering, so that the latest row is unambiguous.
**Acceptance criteria:** (a) the subquery selects `MAX(seq)` grouped by nectar; (b) no reliance on `observed_at` or `content_hash` for ordering; (c) the outer query joins on `(nectar, seq = max_seq)`.

**US-RI-006** — As the operator, I want the latest-per-nectar collapse to reflect only described rows in my tenancy, so that a pending fresh edit does not displace the last good described version.
**Acceptance criteria:** (a) the `describe_status = 'described'` filter and the tenancy predicates sit *inside* the `MAX(seq)` subquery; (b) a pending row with a higher `seq` than the latest described row does not win `MAX(seq)`; (c) the latest *described* version is the row that surfaces.

---

## The `describe_status = 'described'` filter

**US-RI-007** — As the agent, I want recall to exclude undescribed files from the semantic arm, so that I am not handed rows with empty titles and null descriptions.
**Acceptance criteria:** (a) rows with `describe_status` of `pending`, `failed`, `skipped-too-large`, or `skipped-binary` do not appear in the arm's output; (b) only `described` rows surface; (c) a file minted but never described is absent from semantic recall.

**US-RI-008** — As the agent, I understand that an undescribed file absent from semantic recall may still be reachable via the structural CodeGraph's `find/` results keyed by symbol name, because the two layers are independent.
**Acceptance criteria:** (a) the recall arm does not block on description; (b) the CodeGraph remains queryable for undescribed files; (c) the independence is observable — a file can be in one layer without the other.

---

## Tenancy scoping

**US-RI-009** — As the operator, I want recall scoped by org, workspace, and project, so that a query in one project never surfaces another project's file descriptions.
**Acceptance criteria:** (a) `org_id`, `workspace_id`, and `project_id` predicates are applied inside the latest-per-nectar subquery; (b) a cross-tenant nectar never appears in recall output; (c) the scoping columns are the same ones denormalized onto `source_graph_versions` from `source_graph`.

**US-RI-010** — As the operator, I want the Hivenectar arm to carry no `agent_id` and no `visibility` column, because file identity is cross-agent by nature and every agent in a project sees the same descriptions.
**Acceptance criteria:** (a) the arm's scoping is org → workspace → project only; (b) two agents in the same project receive the same Hivenectar hits for the same query; (c) no per-agent isolation is applied to file descriptions.

---

## RRF fusion with the other arms

**US-RI-011** — As the recall pipeline, I want fusion to be rank-based (RRF), not score-based, so that arms with different score distributions contribute on equal footing.
**Acceptance criteria:** (a) each arm contributes its rank order to the fusion; (b) a row's fused score sums `multiplier / (k + rank)` over the arms that returned it; (c) raw BM25/vector scores are not compared across arms.

**US-RI-012** — As the recall pipeline, I want a Hivenectar hit at rank 1 to contribute the same fused weight as a sessions hit at rank 1, so that no arm drowns the others out by virtue of its score scale.
**Acceptance criteria:** (a) default per-arm multiplier for Hivenectar is 1.0; (b) the RRF constant `k` is shared across arms; (c) rank-1 contributions are equal across arms at default weighting.

**US-RI-013** — As the operator, I want a per-arm multiplier I can tune, so that I can damp Hivenectar if its descriptions dominate recall at the expense of session memory.
**Acceptance criteria:** (a) the multiplier is configurable via `~/.honeycomb/hivenectar.json` under `recall.hivenectar_rrf_multiplier`; (b) lowering the multiplier reduces Hivenectar's fused contribution; (c) the default of 1.0 is documented as equal weighting.

---

## Per-arm BM25 + vector hybrid

**US-RI-014** — As the engineer, I want each arm — including Hivenectar's — to run both a BM25 lexical path and a 768-dim vector path, so that a row can match on either or both.
**Acceptance criteria:** (a) the Hivenectar arm scores BM25 over `title + description + concepts`; (b) the vector arm scores cosine distance over `embedding`; (c) both paths feed their rank order into RRF.

**US-RI-015** — As the engineer, I want the Hivenectar embedding dimensionality to match `sessions.message_embedding` and `memory.summary_embedding` (768-dim), so that the same hybrid vector index serves all arms.
**Acceptance criteria:** (a) `embedding` is a 768-dim vector over `title + ' ' + description`; (b) no separate index is required for the Hivenectar arm by virtue of dimensionality; (c) an embedding-model swap would require re-embedding all three tables together.

---

## Graceful BM25-only fallback

**US-RI-016** — As the agent, I want the Hivenectar arm to keep working when embeddings are off, so that disabling or losing the configured embedding provider does not produce a quality cliff in semantic recall over files.
**Acceptance criteria:** (a) the vector arm gates on `embedding IS NOT NULL`; (b) when all embeddings are NULL, the lexical arm carries recall alone; (c) no error is raised and no empty result is returned solely because embeddings are unavailable.

**US-RI-017** — As the operator, I want the fallback to be silent and identical in behavior to the other arms' fallback, so that Hivenectar is not a special case operationally.
**Acceptance criteria:** (a) the fallback matches the pattern used by sessions, memory, and memories; (b) no Hivenectar-specific error path or configuration is needed to enable fallback; (c) re-enabling embeddings restores vector scoring without a manual re-index step beyond the daemon's standard warm-up.

---

## Structural-vs-semantic complementarity

**US-RI-018** — As the agent, I want a query to return both CodeGraph structural hits and Hivenectar semantic hits, so that I see files named after the topic and files that participate in the topic without being named after it.
**Acceptance criteria:** (a) the fused ranked list can contain rows from both the structural `find/` path and the Hivenectar arm; (b) a file like `src/middleware/session-refresh.ts` (no `login*` symbol, but described as part of the login lifecycle) is reachable for a login query; (c) the structural hit and the semantic hit answer different facets of the same question.

**US-RI-019** — As the recall pipeline, I will not deduplicate a file that appears in both a Hivenectar hit and a CodeGraph `find/` hit, because dedup would strip the structural context the CodeGraph hit carries.
**Acceptance criteria:** (a) the recall layer has no view into CodeGraph results and performs no cross-layer dedup; (b) both hits are returned when both match; (c) recognizing them as the same file is the agent's or harness prompt assembler's responsibility.

**US-RI-020** — As the engineer, I want the two layers to remain independent — a file can be in the CodeGraph without a nectar and can have a nectar without being in the CodeGraph — so that neither index is a prerequisite for the other.
**Acceptance criteria:** (a) an undescribed file with AST structure appears in `find/` but not in semantic recall; (b) a described file with no AST (config, markdown, `.env.example`) appears in semantic recall but not in `find/`; (c) neither layer blocks on the other's coverage.

---

## The enricher feeding the arm

**US-RI-021** — As the enricher, I produce the described rows the arm reads, so that recall has something to score.
**Acceptance criteria:** (a) the enricher sets `describe_status = 'described'` and fills `title`, `description`, and `concepts` on the version row; (b) the configured embedding provider fills `embedding` from `title + ' ' + description` when available; (c) until the enricher runs, the row is `pending` and excluded from recall.

**US-RI-022** — As the enricher, I do not block recall — a query during enrichment sees whatever has been described so far.
**Acceptance criteria:** (a) there is no read-lock or "enrichment in progress" state; (b) a query mid-brood returns the subset of files already described; (c) recall and brooding proceed concurrently with no coordination.

---

## What recall does not do

**US-RI-023** — As the engineer, I want the arm to return only the latest described version per nectar, never historical versions, because recall serves the current question rather than archaeology.
**Acceptance criteria:** (a) prior version rows (before a refactor) are in the version chain as history but not in recall; (b) the latest-per-nectar subquery is the sole determinant of what surfaces; (c) no query path exposes historical versions through the recall arm.

**US-RI-024** — As the operator, I want the arm's behavior to be unchanged across a fresh-clone and team-share path, so that a teammate who clones the repo has working semantic recall without re-brooding.
**Acceptance criteria:** (a) `source_graph_versions` cloud-syncs like every other Deep Lake table; (b) a fresh clone inherits described rows and immediately serves semantic recall; (c) the brooding cost is paid once by whoever broods first, not per teammate.

---

## Adding a new arm — the template

**US-RI-025** — As the engineer adding a future fifth arm, I want the Hivenectar arm to serve as the template, so that adding an arm is a matter of following the established contract rather than designing a new fusion strategy.
**Acceptance criteria:** (a) the new arm provides a `source` tag, a stable id, a body column, and (optionally) a vector column; (b) the new arm applies its tenancy scoping inside its own latest-per-key subquery where a version chain exists; (c) the new arm participates in the same RRF fusion with a configurable multiplier defaulting to 1.0; (d) the new arm degrades gracefully when its optional vector column is NULL.
