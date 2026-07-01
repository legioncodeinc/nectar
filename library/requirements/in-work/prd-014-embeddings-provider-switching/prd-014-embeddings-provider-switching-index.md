# PRD-014: Embeddings provider switching

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None (768-dim is fixed; a dimension change is a schema event, out of scope)

---

## Overview

The provider-config abstraction that does not exist today (DECISION #5). Hivenectar's embeddings come from two strategies behind a single switch: (a) the existing local nomic daemon (`nomic-embed-text-v1.5`, q8, Unix-socket NDJSON IPC, the zero-marginal-cost default), and (b) a new Cohere-via-Portkey embeddings transport, modeled on the already-shipped Cohere-rerank-via-Portkey transport, as an operator opt-in. Both strategies honor the **768-dim contract** — recall's `embed.dim_rejected` guard discards any vector of the wrong dimension rather than storing it. The config surface extends the vault `embeddings.enabled` boolean into a provider selector. **This index covers the module scope.** Sub-feature PRDs cover the strategy + config, the Cohere transport, and the switch + BM25 fallback verification.

---

## Goals

- A single `EmbedProvider` strategy switch fronts both the local nomic daemon (default) and the new Cohere-via-Portkey embeddings transport (opt-in).
- The local nomic path stays the zero-marginal-cost default; Cohere-via-Portkey is an operator opt-in.
- Both providers honor the 768-dim contract; a vector of the wrong dimension is discarded by recall's guard, never stored as valid recall data.
- The config surface extends the existing vault `embeddings.enabled` boolean into a provider selector without inventing a parallel enable mechanism.

## Non-Goals

- Defaulting to Cohere. DECISION #5 rejects this (it flips away from the zero-marginal-cost local option the corpus cost-math is designed around).
- Local-only for v1. DECISION #5 rejects this (operators who want hosted embeddings have no path).
- Changing the dimensionality. The `FLOAT4[768]` columns are fixed; changing the dim is a schema event, not a normal provider switch (`ai/enricher-and-llm-model.md` § Embeddings).
- Client-side semantic caching for embeddings. Out of scope (see PRD-010c for the server-side posture).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-014a-embed-provider-strategy-and-config`](./prd-014a-embed-provider-strategy-and-config.md) | `EmbedProvider` strategy switch; local nomic default + Cohere-via-Portkey opt-in; extends the `embeddings.enabled` vault key | Draft |
| [`prd-014b-cohere-via-portkey-transport`](./prd-014b-cohere-via-portkey-transport.md) | New embeddings transport modeled on `rerank-portkey.ts`; honors 768-dim or recall's `embed.dim_rejected` guard discards | Draft |
| [`prd-014c-provider-switch-and-bm25-fallback`](./prd-014c-provider-switch-and-bm25-fallback.md) | Switch verification + graceful BM25-only fallback when embeddings off | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given no explicit provider selection, when an embedding is computed, then the local nomic daemon path runs (the default). |
| AC-2 | Given the operator selects the Cohere-via-Portkey provider, when an embedding is computed, then it POSTs to the Portkey embeddings endpoint via the rerank-transport pattern (`buildPortkeyHeaders` + the same host). |
| AC-3 | Given either provider returns a vector that is not exactly 768-dim, then recall's `embed.dim_rejected` guard discards it (the column stays NULL); it is never stored as valid recall data. |
| AC-4 | Given embeddings are off (not installed, or the daemon failed to warm), then the embedding column is left NULL and recall falls back to BM25 over title/description — no error, no quality cliff. |

---

## Data model changes

None. The 768-dim contract is load-bearing: it matches `sessions.message_embedding` and `memory.summary_embedding` (`ai/enricher-and-llm-model.md` § Embeddings). Changing the dimensionality is a schema event, not part of this PRD.

---

## API changes

None at the endpoint level. The vault `embeddings.enabled` setting gains a provider-selector dimension (owned by 014a).

---

## Related

- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — DECISION #5 (build the provider switch) and the PRD-014 entry.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the embeddings layer + 768-dim contract + BM25 fallback.
- [`../prd-010-portkey-gateway/prd-010-portkey-gateway-index.md`](../prd-010-portkey-gateway/prd-010-portkey-gateway-index.md) — the Portkey transport the Cohere embeddings path reuses the auth pattern from.
