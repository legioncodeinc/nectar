# PRD-010b: Model selection and describe_model audit

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S (1-3h)
> **Schema changes:** None (uses the existing `describe_model` column)

---

## Overview

The model that produces Hivenectar's file descriptions is **Gemini 2.5 Flash** by default — the Pareto-optimal point on the model comparison table (1M-token context at frontier-tier quality and price). It is the **default** in the model provider router, configurable via the `activeModel` vault setting and the Portkey config; it is not hardcoded. Swapping models is never automatic: the operator runs `honeycomb hivenectar brood --force --model <new>` to force re-description, and the `describe_model` column on every `source_graph_versions` row records which model produced each description so the swap is auditable.

---

## Goals

- The default requested model resolves to Gemini 2.5 Flash (`activeModel` default) for both brooding and enricher calls.
- `brood --force --model <new>` resets every non-skipped `source_graph_versions` row to `pending` and re-describes under the new model.
- The `describe_model` column records the producing model on every described row (including the `inherited-from:<prev_content_hash>` marker for cosmetic changes that inherit a prior description).

## Non-Goals

- Automatic re-description on a model swap. Existing descriptions stay valid until the operator forces it (`ai/enricher-and-llm-model.md` § What the enricher explicitly does not do).
- Pinning a single model in code. The default is configurable via `activeModel` / `portkey.config`.
- Symbol-level or directory-level description. v1 is file-granular (a corpus-deliberate spec gap).

---

## The model comparison table (carried verbatim)

The 2000-file brood cost comparison, verbatim from `ai/enricher-and-llm-model.md`:

| Model | Context | Per-call batch | Calls for 1500 small files | Input cost | Output cost | Total |
|---|---|---|---|---|---|---|
| Gemini 2.5 Flash | 1M | 40 | 38 | $0.65 | $2.40 | **$3.05** |
| Claude Haiku 4.5 | 200K | 8 | 188 | $1.50 | $5.50 | **$7.00** |
| GPT-4.1 | 1M | 40 | 38 | $3.00 | $8.50 | **$11.50** |
| GPT-4o-mini | 128K | 5 | 300 | $0.60 | $2.40 | **$3.00** (quality risk) |

**Default = Gemini 2.5 Flash.** GPT-4o-mini is price-competitive but its single-file summarization quality is measurably worse on code-understanding benchmarks, and its 128K window forces tiny batches that increase call overhead and failure-retry cost. Gemini 2.5 Flash is the Pareto-optimal point: frontier-tier quality, 1M context, lowest price at that quality.

---

## User stories

### US-010b.1 — Default to Gemini 2.5 Flash

**As a** brooding operator, **I want to** descriptions produced by Gemini 2.5 Flash by default, **so that** the 1M-token context keeps batch sizes large and the per-file cost low.

**Acceptance criteria:**
- AC-010b.1.1 Given no explicit model override, when a description is generated, then the transport's `model` body field resolves to the `activeModel` default (Gemini 2.5 Flash).
- AC-010b.1.2 Given the model is configurable via `activeModel`, then an operator can swap to Haiku, GPT-4.1, or a local Ollama model via config without code changes.

### US-010b.2 — Force re-description under a swapped model

**As a** operator who swapped models, **I want to** run `honeycomb hivenectar brood --force --model <new>`, **so that** every non-skipped row is re-described under the new model rather than carrying stale descriptions.

**Acceptance criteria:**
- AC-010b.2.1 Given `brood --force --model <new>`, then every non-skipped `source_graph_versions` row is reset to `describe_status = 'pending'`.
- AC-010b.2.2 Given the forced re-description completes for a row, then `describe_model` is stamped to the new model id.

### US-010b.3 — Audit which model produced each description

**As a** reviewer, **I want to** the `describe_model` column to record the producing model per row, **so that** a model swap can trigger selective re-description of files described by the old model if quality demands it.

**Acceptance criteria:**
- AC-010b.3.1 Given any description is produced by an LLM call, then `describe_model` records the producing model id.
- AC-010b.3.2 Given a cosmetic change inherits a prior description (Jaccard ≥ `REDESCRIBE_THRESHOLD`), then `describe_model = inherited-from:<prev_content_hash>`.

---

## Implementation notes

- **Model flows as `activeModel`.** The factory builds the Portkey config with `model` = the vault `activeModel` (D-2: `model-client-factory.ts:97-98`, `:404-406`); the transport sends `call.target.model` as the `model` body field (`transport-portkey.ts:198`). Hivenectar's default for `activeModel` is Gemini 2.5 Flash.
- **`--force` resets to pending; `--model` sets the target.** `--force` re-describes all non-skipped rows (`ai/brooding-pipeline.md` CLI flags on `brood` only); `--model <new>` overrides the target model for that run. The two combine as `brood --force --model <new>` (spec'd CLI surface, MASTER-PRD-INDEX.md). PRD-007 owns the `--force`/`--limit`/`--dry-run` flags; this PRD owns the `--model` interaction.
- **`describe_model` is the audit surface.** The column records the producing model per row (`ai/enricher-and-llm-model.md` § Why Gemini 2.5 Flash specifically). Cosmetic-change inheritance writes the `inherited-from:<prev_content_hash>` marker (default `REDESCRIBE_THRESHOLD` 0.85, `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic). PRD-016 owns the heuristic mechanics.
- **Do NOT apply `--limit`/`--dry-run` to the enricher.** Those are `brood`-only flags (a corpus hallucination did this once and was fixed — `ai/brooding-pipeline.md` / guide 04).

---

## Flagged defaults

- **[SIGNED OFF 2026-07-02, decision #29 in `PRD-DECISIONS-AND-DEFAULTS.md`:** Gemini model id `gemini-2.5-flash` is the `activeModel` default Hivenectar ships, overridable per-run via `brood --force --model <new>`. Mechanical check at implementation: verify the literal id string against Portkey's config surface.]

---

## Related

- [`./prd-010-portkey-gateway-index.md`](./prd-010-portkey-gateway-index.md)
- [`./prd-010a-portkey-transport-reuse.md`](./prd-010a-portkey-transport-reuse.md) — the transport that carries the `model` field.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the source of the model comparison table + the `describe_model` audit contract.
