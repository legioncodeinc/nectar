# PRD-016b: Model call and the `describe_model` audit

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S (1-3h)
> **Schema changes:** None (uses the existing `describe_model` column)

---

## Overview

When the meaningful-change heuristic (PRD-016a) deems a delta meaningful, the enricher makes an LLM call to produce a fresh description, then stamps the producing model on the `describe_model` column. This sub-PRD owns the enricher side of that call — how the loop sends the version row's content through the model and writes the result back with its provenance — and the `describe_model` audit contract that makes every description traceable to the model (or to an inheritance) that produced it. The Portkey transport mechanics (headers, base URL, `/v1/chat/completions`, retry/backoff) are owned by PRD-010; this PRD consumes them and adds no transport code.

---

## Goals

- A meaningful change produces a description via an LLM call routed through Portkey's `/v1/chat/completions` (the transport mechanics in PRD-010), and the result is written back to the version row.
- Every LLM-produced description records the producing model id on the `describe_model` column.
- A cosmetic-change inheritance (PRD-016a) records `describe_model = inherited-from:<prev_content_hash>` so inherited descriptions are auditable as inherited, not mistaken for LLM output.
- Once a description is written (by brooding, by the enricher, or inherited), the enricher computes a 768-dim embedding over `title + ' ' + description` through the configured provider (PRD-014), or leaves the embedding NULL when embeddings are off (BM25-only fallback).

## Non-Goals

- The Portkey transport mechanics — `buildPortkeyHeaders`, `PORTKEY_BASE_URL`, the `/v1/chat/completions` request shape, and retry/backoff are PRD-010's deliverables. This PRD calls that transport; it does not redefine it.
- The default model choice and the model comparison table. PRD-010b owns the Gemini 2.5 Flash default and the rationale.
- The embeddings provider switch. PRD-014 owns local nomic vs Cohere-via-Portkey; this PRD consumes the configured provider.
- The meaningful-change heuristic that gates whether the call happens. PRD-016a owns it.
- Failure handling for a failed call. PRD-016c owns `failed` → retry-solo and the persistent-failure alert.

---

## The model call (mechanics in PRD-010)

When the heuristic (PRD-016a) deems a change meaningful, the new version row enters the pending queue; the next 30s cycle's batch describes it. The enricher sends the version row's content to the model and receives a structured description object (`title`, `description`, `concepts`) written back to the row with `describe_status = 'described'`. The call routes through Portkey's `/v1/chat/completions` reusing Honeycomb's already-shipped transport (`buildPortkeyHeaders` + `PORTKEY_BASE_URL`), so Nectar sends no new transport code to the gateway (PRD-010a). The default requested model is **Gemini 2.5 Flash** (`activeModel` vault default, PRD-010b) — the 1M-token context keeps the enricher's per-file cost low.

### Function-calling is not required

The model does not use tools; the enricher sends content and receives descriptions (`ai/enricher-and-llm-model.md` § What Nectar needs from the model). The response is a structured JSON object; malformed or wrong-length JSON is caught by the validator and routed to the failure path (PRD-016c). This keeps the enricher call shape simpler than a tool-using call.

### Embedding follows the description

Once a description is written (by brooding, by the enricher, or inherited from a similar previous version), the enricher computes a 768-dim embedding over `title + ' ' + description` through the embedding provider switch (PRD-014) (`ai/enricher-and-llm-model.md` § Embeddings). The default provider is the local nomic path (`nomic-embed-text-v1.5`, q8 quantization, Unix-socket NDJSON IPC); the hosted opt-in is Cohere via Portkey. If embeddings are off, the embedding column is left NULL and recall falls back to BM25 over `title` and `description` — a silent fallback, no error, no quality cliff.

---

## The `describe_model` audit column

The `describe_model` column on every `hive_graph_versions` row records which model produced each description (`ai/enricher-and-llm-model.md` § Why Gemini 2.5 Flash specifically). It is the audit surface that makes a model swap traceable: an operator who swaps models and wants selective re-description of files described by the old model can query it.

| Description source | `describe_model` value |
|---|---|
| LLM call (brooding or enricher) | the producing model id (e.g. `gemini-2.5-flash`) |
| Cosmetic-change inheritance (PRD-016a) | `inherited-from:<prev_content_hash>` |

The cosmetic-inheritance marker is what distinguishes an inherited description from an LLM-produced one: a reviewer or a model-swap sweep can tell that a row's description was carried over from a prior version rather than freshly generated. This marker is defined in `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic (step 3) and carried into the projection verbatim (PRD-011a).

### Model swaps are not automatic

Existing descriptions stay valid until proven otherwise. An operator who swaps models and wants to re-describe everything runs `honeycomb nectar brood --force --model <new>`, which sets all non-skipped rows back to `pending` (`ai/enricher-and-llm-model.md` § What the enricher explicitly does not do; PRD-010b). The enricher never re-describes on a model swap by itself.

---

## User stories

### US-016b.1 — Describe a meaningful change via Portkey

**As a** developer who changed a file's meaning, **I want to** the enricher to produce a fresh description via the model, **so that** recall surfaces the new content.

**Acceptance criteria:**
- AC-016b.1.1 Given a meaningful change selected by the cycle's batch, when the enricher runs, then it calls the model through Portkey's `/v1/chat/completions` (the PRD-010 transport) with the version row's content.
- AC-016b.1.2 Given the call returns a valid description object, then the row's `title`, `description`, and `concepts` are written and `describe_status = 'described'`.

### US-016b.2 — Audit the producing model

**As a** reviewer, **I want to** `describe_model` to record which model produced each description, **so that** a model swap can trigger selective re-description.

**Acceptance criteria:**
- AC-016b.2.1 Given a description produced by an LLM call, then `describe_model` records the producing model id.
- AC-016b.2.2 Given a cosmetic-change inheritance (PRD-016a), then `describe_model = inherited-from:<prev_content_hash>`.

### US-016b.3 — Embed the description (or fall back to BM25)

**As a** operator, **I want to** the description embedded so semantic recall works, **so that** recall is hybrid when embeddings are available and lexical-only when they are not.

**Acceptance criteria:**
- AC-016b.3.1 Given a description is written and embeddings are on, then a 768-dim embedding over `title + ' ' + description` is written through the configured provider (PRD-014).
- AC-016b.3.2 Given embeddings are off (optional dependency absent, or warm-up failed), then the embedding column is left NULL, `describe_status = 'described'`, and recall falls back to BM25 over `title` and `description` with no error.

---

## Implementation notes

- **No new transport code.** The call uses PRD-010's transport verbatim (`buildPortkeyHeaders` + `PORTKEY_BASE_URL` → `/v1/chat/completions`). Nectar builds the request body (content + the `model` body field from `activeModel`) and reads the structured response; everything between is PRD-010.
- **`describe_model` is the single audit column.** It records either the producing model id or the `inherited-from:<prev_content_hash>` marker — nothing else. The marker format is fixed by the corpus heuristic (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 3) and round-trips through the projection unchanged (PRD-011a).
- **Validator catches malformed output.** A malformed or wrong-length JSON response does not get written as a description; it is routed to the failure path (PRD-016c: retry the batch once with a stricter prompt, then mark `failed` and retry solo). This PRD owns the happy-path write; PRD-016c owns the catch.
- **Embedding is over `title + ' ' + description`.** A space-joined string of the two fields, not the raw content (`ai/enricher-and-llm-model.md` § Embeddings). The 768-dim contract is load-bearing — a wrong-dimension vector is rejected by the recall guard rather than stored (PRD-014).

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Default model id: `gemini-2.5-flash` (`activeModel` default, PRD-010b). This PRD consumes it; the value is confirmed under PRD-010b.
- **[DEFAULT — confirm before implementation]** `REDESCRIBE_THRESHOLD` (the heuristic that decides whether the call happens at all): 0.85 (PRD-016a, `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic). From corpus, confirm.

---

## Related

- [`./prd-016-enricher-steady-state-index.md`](./prd-016-enricher-steady-state-index.md)
- [`./prd-016a-queue-poll-debounce-meaningful-change.md`](./prd-016a-queue-poll-debounce-meaningful-change.md) — the heuristic that gates this call.
- [`./prd-016c-failure-handling-persistent-alert.md`](./prd-016c-failure-handling-persistent-alert.md) — what happens when this call fails.
- [`../../in-work/prd-010-portkey-gateway/prd-010a-portkey-transport-reuse.md`](../../in-work/prd-010-portkey-gateway/prd-010a-portkey-transport-reuse.md) — the transport this call uses (mechanics owner).
- [`../../in-work/prd-010-portkey-gateway/prd-010b-model-selection-and-describe-model.md`](../../in-work/prd-010-portkey-gateway/prd-010b-model-selection-and-describe-model.md) — the Gemini 2.5 Flash default + the `describe_model` column's shared contract.
- [`../../in-work/prd-014-embeddings-provider-switching/`](../../in-work/prd-014-embeddings-provider-switching/) — the embeddings provider switch this PRD consumes for the 768-dim embedding.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — AUTHORITATIVE: the model-call shape, `describe_model` audit, the `inherited-from:<prev_content_hash>` marker, and the embeddings/BM25-fallback posture.
