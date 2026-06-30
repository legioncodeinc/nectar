# PRD-014b: Cohere-via-Portkey embeddings transport

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Overview

The new embeddings transport for the Cohere-via-Portkey provider. It is modeled on the already-shipped Cohere-rerank-via-Portkey transport: it reuses the same `buildPortkeyHeaders` auth pair and the same `PORTKEY_BASE_URL` host, and differs only in the path (`/v1/embeddings`) and the Cohere embeddings request/response shape. The load-bearing rule is the **768-dim contract** — recall's `embed.dim_rejected` guard discards any vector that is not exactly 768-dim, so the transport enforces the dimension before the vector is stored.

---

## Goals

- A Cohere-via-Portkey embeddings transport that POSTs to the Portkey embeddings endpoint reusing `buildPortkeyHeaders` + `PORTKEY_BASE_URL`.
- The transport enforces the 768-dim contract: a non-768 vector resolves to `null` (the column stays NULL), never a stored vector of the wrong dimension.
- The transport is fail-soft and never throws into the caller's hot path — it mirrors the rerank transport's typed-failure discipline and the `EmbedClient` null-on-failure contract.

## Non-Goals

- Reranking. This transport computes embeddings only; the rerank transport (`rerank-portkey.ts`) is a separate, already-shipped surface.
- A client-side cache for embedding responses. Out of scope (server-side posture, PRD-010c).
- A dimension selector. The 768-dim contract is fixed.

---

## User stories

### US-014b.1 — Compute an embedding through Portkey

**As a** operator on the Cohere provider, **I want to** each description embedded by Cohere through the Portkey gateway, **so that** the vector is computed by the hosted model with the gateway's routing and guardrails.

**Acceptance criteria:**
- AC-014b.1.1 Given the Cohere provider is selected + Portkey is keyed, when `embed(text)` runs, then the transport POSTs to the Portkey embeddings endpoint with headers from `buildPortkeyHeaders(resolvedKey, configId)`.
- AC-014b.1.2 Given a successful 2xx response, then the transport returns the parsed vector as `readonly number[]`.

### US-014b.2 — Discard non-768 vectors

**As a** recall reviewer, **I want to** a vector of the wrong dimension rejected, **so that** the 768-dim contract is never violated in storage.

**Acceptance criteria:**
- AC-014b.2.1 Given a successful response whose vector is not exactly 768-dim, then the transport resolves to `null` and emits the `embed.dim_rejected` event (expected 768, actual length) — never returns the wrong-dim vector.
- AC-014b.2.2 Given the column is left NULL by a discarded vector, then recall falls back to BM25 over title/description (no error surfaced to the caller).

### US-014b.3 — Fail soft on transport errors

**As a** caller, **I want to** a network or gateway failure to resolve to `null` rather than throw, **so that** the capture path and recall are never broken by an embeddings outage.

**Acceptance criteria:**
- AC-014b.3.1 Given a network/transport failure or a non-2xx gateway status, then the transport resolves to `null` and never throws into the caller's hot path.
- AC-014b.3.2 Given any failure path, then the resolved key is never included in a log, returned value, or error message (secret-discipline invariant).

---

## Implementation notes

- **Model on `rerank-portkey.ts`.** The Cohere rerank transport is the template (`recall/rerank-portkey.ts`). It reuses the 063b chat foundation: the same `x-portkey-api-key` + `x-portkey-config` header pair via the shared `buildPortkeyHeaders` (`rerank-portkey.ts:46`, `:164`), the same injectable `FetchLike`, the same `${SECRET_REF}`-resolved key discipline. The ONE difference is the path (`/v1/rerank` for rerank; `/v1/embeddings` for this transport) and the request/response shape.
- **Reuse the auth, change the path + shape.** `PORTKEY_BASE_URL = "https://api.portkey.ai/v1"` (`transport-portkey.ts:74`); the embeddings endpoint hangs off the same host at `/v1/embeddings`. The request shape is the Cohere/OpenAI embeddings body; the response shape carries the embedding vector. Build the headers through `buildPortkeyHeaders(apiKey, configId)` — do not re-hand-roll the header object (jscpd discipline, per `rerank-portkey.ts:9-15`).
- **Fail-soft is the cardinal rule.** Mirror the rerank transport's `RerankCallResult` typed-failure discipline (`rerank-portkey.ts:63-65`) and the `EmbedClient` null-on-failure contract (`embed-client.ts:80-83`): a network/transport failure or a non-2xx status resolves to `null`, never a throw the caller must catch. The `onTransportError` observed-failure signal (`rerank-portkey.ts:84`, `:141-148`) is reused so `/health` can flip `reasons.portkey` from a real failure, not a probe.
- **Enforce 768-dim before storing.** The existing `DaemonEmbedClient` already guards: `parsed.vector.length !== EMBEDDING_DIMS` → emit `embed.dim_rejected` + return `null` (`embed-client.ts:272-274`). The Cohere transport composes under the same guard. Downstream, `assertEmbeddingDim` (`storage/vector.ts:75-84`) throws `VectorDimensionError` before any SQL is built, and `serializeFloat4Array` (`storage/vector.ts:91-98`) serializes the validated vector. A wrong-dim Cohere vector is discarded at the client, never reaches the SQL path.
- **Secret-never-logged invariant.** The resolved Portkey key lives only in the `x-portkey-api-key` header (via `buildPortkeyHeaders`); it is never logged, returned, or thrown (the chat transport's `b-AC-3` invariant, `transport-portkey.ts:38-42`; the rerank transport's `c-AC-2`, `rerank-portkey.ts:32-36`).

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Cohere embed model: `embed-english-v3.0`. Flag — confirm the exact model id string (Cohere's `embed-english-v3.0` vs `embed-multilingual-v3.0` vs the v4 line) and that Portkey advertises it at `/v1/embeddings` before implementation.
- **[DEFAULT — confirm before implementation]** Cohere endpoint via Portkey: `/v1/embeddings` (i.e. `https://api.portkey.ai/v1/embeddings`, hanging off `PORTKEY_BASE_URL`). Confirm the gateway still advertises this embeddings path before implementation.

---

## Related

- [`./prd-014-embeddings-provider-switching-index.md`](./prd-014-embeddings-provider-switching-index.md)
- [`./prd-014a-embed-provider-strategy-and-config.md`](./prd-014a-embed-provider-strategy-and-config.md) — the strategy switch that selects this transport.
- [`../prd-010-portkey-gateway/prd-010a-portkey-transport-reuse.md`](../prd-010-portkey-gateway/prd-010a-portkey-transport-reuse.md) — the `buildPortkeyHeaders` + `PORTKEY_BASE_URL` foundation this transport reuses.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the 768-dim contract + BM25 fallback.
