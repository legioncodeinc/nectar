# PRD-007: Brooding Process (First-Run Full-Codebase Description)

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L
> **Schema changes:** None (PRD-007 owns no Deep Lake table — it *writes* `source_graph` + `source_graph_versions` owned by [PRD-005](../../completed/prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md). This PRD owns the one-time bootstrap pipeline.)

---

## Overview

PRD-007 owns the **brooding process** — the one-time, per-project full-codebase scan that takes a repository from "no nectars exist" to "every file has a nectar and most have a description." Brooding is one of the daemon's four operating modes and is distinct from live watch and cold-catch-up for two reasons carried verbatim from [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md): (1) it can **batch aggressively** — packing 30–50 small files into a single LLM call collapses per-file description cost by an order of magnitude versus the one-file-at-a-time steady-state loop; (2) it **owns the projection bootstrap** — brooding is the only mode that writes the initial `.honeycomb/nectars.json`, without which a fresh clone has no identity map and no descriptions and the team-share story breaks.

The pipeline runs in a fixed discover→pre-check→bucket→describe→embed→persist→regenerate-projection order, mirroring Honeycomb's `runGraphBuild` discover→extract→persist composition (`honeycomb/src/daemon/runtime/codebase/api.ts:234-261`): aggregate the codebase into a snapshot, finalize, and persist atomically. Brooding reuses the same shape — discover files, content-hash pre-check against the committed projection (the fresh-clone shortcut), bucket by size/type into four buckets, make batched or solo LLM calls through Portkey (model choice + transport owned by [PRD-010](../../in-work/prd-010-portkey-gateway/prd-010-portkey-gateway-index.md)), write `source_graph` + `source_graph_versions` rows, embed `title + ' ' + description` (provider owned by [PRD-014](../../in-work/prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md)), and regenerate `.honeycomb/nectars.json` (owned by [PRD-011](../../in-work/prd-011-portable-projection/prd-011-portable-projection-index.md)).

The **cost math is the budget contract** for this PRD. Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md): a representative 2000-file TypeScript repository broods for **~$3.05 total = $0.65 input + $2.40 output** across **~2.15M input tokens** in **~318 calls**; a 10000-file monorepo broods for **~$15**; a 200-file microservice broods for **~$0.30**. This is a one-time cost per project, and a fresh clone that inherits the committed projection pays **$0** because every file's content hash matches and no LLM call is made. These numbers are carried unchanged — no rounding, no paraphrase.

This PRD owns four sub-features: **discovery + content-hash pre-check** (the fresh-clone shortcut), **bucketing + LLM call shapes** (the four buckets with the 4 KB / 100 KB / 256 KB thresholds and the batch/solo prompts), **resumability state machine** (via `describe_status`, no lockfile), and the **CLI surface** (`brood`, `--force`, `--limit N`, `--dry-run` cost preview). The model selection, Portkey transport, and semantic-cache story are delegated to PRD-010; the enricher steady-state loop is [PRD-016](../prd-016-enricher-steady-state/prd-016-enricher-steady-state-index.md); the CLI *invocation* surface that drives these mechanics is documented in [PRD-002c](../../completed/prd-002-hivenectar-daemon/prd-002c-hivenectar-cli-surface.md).

---

## Goals

- Define the brooding pipeline end-to-end in a fixed order — discover → content-hash pre-check → bucket → describe → embed → persist rows → regenerate projection — citing [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) as the authoritative source and `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` (`runGraphBuild`) as the discover→extract→persist composition to mirror.
- Carry the **four buckets and their thresholds verbatim** from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md): skip-binary (NUL bytes in first 8 KB or known-binary extension), skip-too-large (`size_bytes > 256 KB`), batch (`size_bytes ≤ 4 KB` and cumulative `≤ 100 KB`, 30–50 files/call), solo (`> 4 KB` but `≤ 256 KB`, one file/call).
- Carry the **cost math verbatim** — ~$3.05/2000 files ($0.65 input + $2.40 output, ~2.15M input tokens, ~318 calls), ~$15/10000-file monorepo, ~$0.30/200-file microservice — and the batch/solo output shapes (batch: title ≤80 chars + 1–3 sentence description + 1–5 concepts; solo: 3–5 sentence description + primary symbol).
- Specify the **resumability state machine** via `source_graph_versions.describe_status` (no lockfile, no partial-state marker), confirming the append-only/resumable pattern Honeycomb uses for the pollinating loop and skillify miner.
- Specify the **CLI surface** (`brood`, `--force`, `--limit N`, `--dry-run`) and the `--dry-run` cost-preview behavior (discovery + bucketing + printed estimate, no LLM calls).
- Confirm brooding **does not block daemon readiness** (per the corpus's ADR-0007 reference) and **runs once per project** unless the projection is lost.

## Non-Goals

- The tables brooding writes (`source_graph`, `source_graph_versions`) and their DDL — [PRD-005](../../completed/prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md). This PRD *writes* those tables; PRD-005 owns the schema.
- The portable projection (`.honeycomb/nectars.json`) format, atomic-write, validation-on-load, and the `rebuild-projection` mechanic — [PRD-011](../../in-work/prd-011-portable-projection/prd-011-portable-projection-index.md). Brooding is one of the projection's three generation triggers; PRD-011 owns the write.
- The Portkey transport, model selection, `describe_model` audit, and semantic-cache story — [PRD-010](../../in-work/prd-010-portkey-gateway/prd-010-portkey-gateway-index.md). Brooding's LLM calls route through Portkey; PRD-010 owns the routing.
- The embeddings provider switch (local nomic default vs Cohere-via-Portkey) and the 768-dim contract — [PRD-014](../../in-work/prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md). Brooding calls embed after describing; PRD-014 owns the provider.
- The enricher steady-state loop (poll 30 s, debounce 500 ms, meaningful-change heuristic) — [PRD-016](../prd-016-enricher-steady-state/prd-016-enricher-steady-state-index.md). Brooding is the one-time bootstrap; the enricher is everything after.
- The file-registration protocol (the `node:fs.watch` intake + the 5-step re-association ladder) — [PRD-006](../../completed/prd-006-file-registration-protocol/prd-006-file-registration-protocol-index.md). Brooding reuses the ladder's *discovery* (`git ls-files`); PRD-006 owns the live-watch intake + the ladder algorithm.
- The daemon process, worker harness, and the CLI *invocation* dispatch — [PRD-002](../../completed/prd-002-hivenectar-daemon/prd-002-hivenectar-daemon-index.md) (the worker in [002b](../../completed/prd-002-hivenectar-daemon/prd-002b-hiveantennae-worker.md), the CLI surface in [002c](../../completed/prd-002-hivenectar-daemon/prd-002c-hivenectar-cli-surface.md)). This PRD owns the brooding *mechanics* those surfaces invoke.
- The daemon's HTTP API endpoints (`/api/source-graph/*`, including the `POST /api/source-graph/build` trigger that maps to brooding) — [PRD-008](../prd-008-hivenectar-api-endpoints/prd-008-hivenectar-api-endpoints-index.md).

---

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [`prd-007a-discovery-and-content-hash-precheck`](./prd-007a-discovery-and-content-hash-precheck.md) | `git ls-files` discovery (mirrors CodeGraph) + content-hash pre-check against the projection (fresh-clone shortcut) | Draft |
| [`prd-007b-bucketing-and-llm-call-shapes`](./prd-007b-bucketing-and-llm-call-shapes.md) | The four buckets (skip-binary / skip-too-large / batch / solo) with 4 KB / 100 KB / 256 KB thresholds + the batch/solo LLM call shapes + verbatim cost math | Draft |
| [`prd-007c-resumability-state-machine`](./prd-007c-resumability-state-machine.md) | Resumability via `describe_status`; no lockfile; the skip / re-enqueue / discover-fresh rules | Draft |
| [`prd-007d-cli-surface-and-dry-run`](./prd-007d-cli-surface-and-dry-run.md) | `brood`, `--force`, `--limit N`, `--dry-run` (cost preview); triggering (auto vs explicit) | Draft |

---

## Acceptance Criteria

- [ ] Brooding runs in the fixed discover → pre-check → bucket → describe → embed → persist → regenerate-projection order, mirroring `runGraphBuild`'s discover→extract→persist composition at `honeycomb/src/daemon/runtime/codebase/api.ts:234-261`.
- [ ] Discovery reuses the CodeGraph's `git ls-files --cached --others --exclude-standard -z` command verbatim (carried from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)), honoring `.gitignore`, with a manual recursive walk fallback when git is unavailable.
- [ ] A file whose `content_hash` matches a committed projection entry inherits its nectar + description and makes **no LLM call** — the fresh-clone shortcut. Only files with no projection match enter bucketing.
- [ ] The four buckets and their thresholds match [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) exactly: skip-binary (NUL in first 8 KB or known-binary ext), skip-too-large (`> 256 KB`), batch (`≤ 4 KB`/file, `≤ 100 KB`/batch, 30–50 files/call), solo (`> 4 KB` but `≤ 256 KB`).
- [ ] The cost math is carried verbatim — **~$3.05/2000 files = $0.65 input + $2.40 output; ~2.15M input tokens; ~318 calls; ~$15/10000-file monorepo; ~$0.30/200-file microservice** — with no rounding or paraphrase against the source table.
- [ ] The batch call asks for title (≤80 chars) + 1–3 sentence description + 1–5 concepts; the solo call asks for a richer 3–5 sentence description + a "primary symbol," matching [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md).
- [ ] Brooding is resumable via `source_graph_versions.describe_status` with **no lockfile and no partial-state marker**; a killed-mid-brood daemon resumes on the next boot using the three skip / re-enqueue / discover-fresh rules.
- [ ] `brood --dry-run` runs discovery + bucketing, prints the estimated call count + cost, and exits **without any LLM call** (the corpus's recommended first step).
- [ ] `brood --force` re-describes every non-skipped file; `brood --limit N` caps the number of pending files brooded — both carried from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) "Triggering brooding."
- [ ] Brooding does **not** block daemon readiness and runs in the background after the daemon accepts requests (per the corpus's ADR-0007 reference in [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) "What brooding does not do").
- [ ] Every Honeycomb `file:line` citation and every corpus citation resolves to its cited source (no hallucinated line numbers, thresholds, or cost figures).

---

## Defaults registered in this PRD

Two values are defaults pending implementation confirmation. Each is flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| Discovery command | `git ls-files --cached --others --exclude-standard -z` | 007a | Carried from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) "File discovery"; honors `.gitignore` exactly via the shared CodeGraph discovery the corpus names. |
| Batch packing | DYNAMIC token-budget packing (decision #22, locked) | 007b | Locked decision #22 (`PRD-DECISIONS-AND-DEFAULTS.md`) supersedes the earlier fixed-40 default: pack files until the estimated input-token budget approaches the batch budget, capped by the 100 KB cumulative `BATCH_TOTAL_SIZE` plus a max-files safety ceiling in the corpus's 30–50 band. The corpus's "~40 files/call" figures remain the representative cost-math illustration, which dynamic packing preserves. |

## Deliberate spec gaps preserved (NOT invented here)

This PRD introduces **no** new deliberate gaps. The three corpus gaps (TLSH confidence thresholds, symbol/directory nectars, `review-matches` sub-flag syntax — per `hivenectar-stinger` guide 00 § Principle 3) are owned by other PRDs and are out of brooding's scope. The TLSH fuzzy step is a cold-catch-up / live-watch concern (PRD-006d), not a brooding concern.

---

## Related

- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-007 brief + the six locked decisions (decision #3 lazy-create, #4 fs.watch mirror, #5 embeddings switch, #6 Portkey cache server-side).
- [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — **the authoritative pipeline + cost math.** Every threshold, bucket, call shape, cost figure, and CLI flag in this PRD traces here.
- [`knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the Gemini 2.5 Flash rationale + the `describe_model` audit column brooding populates + the `--force --model <new>` re-describe path.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — the identity model brooding bootstraps (nectars minted here are the keys the ladder carries).
- [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the tables brooding writes.
- [`knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) — the projection brooding bootstraps and regenerates.
- [`knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../../knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md) — the identity decision forcing the two-table split brooding populates.
- [`prd-002-hivenectar-daemon`](../../completed/prd-002-hivenectar-daemon/prd-002-hivenectar-daemon-index.md) — the daemon process + the worker ([002b](../../completed/prd-002-hivenectar-daemon/prd-002b-hiveantennae-worker.md)) that drives brooding + the CLI surface ([002c](../../completed/prd-002-hivenectar-daemon/prd-002c-hivenectar-cli-surface.md)) that invokes it.
- [`prd-005-source-graph-catalog-tables`](../../completed/prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — the tables brooding writes ([005b](../../completed/prd-005-source-graph-catalog-tables/prd-005b-source-graph-versions-table.md) `describe_status` is the resumability key).
- [`prd-006-file-registration-protocol`](../../completed/prd-006-file-registration-protocol/prd-006-file-registration-protocol-index.md) — the `git ls-files` discovery brooding reuses is shared with the ladder's cold-catch-up.
- `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` — `runGraphBuild`, the discover→extract→persist composition to mirror.
- `honeycomb/src/daemon/storage/catalog/projects.ts:34-49, 152-218` — the lazy-create + `withHeal` pattern + the catalog-group registration brooding's writes rely on.
