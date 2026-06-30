# PRD-014a: Embed provider strategy and config

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Overview

The strategy switch that fronts the two embedding providers. Today nomic is hard-wired — the model id, revision, quantization, dimension, and prefix are module-level constants in the embeddings daemon. This sub-PRD abstracts those behind an `EmbedProvider` strategy so the local nomic daemon stays the default and a Cohere-via-Portkey transport is an operator opt-in. The config surface extends the existing vault `embeddings.enabled` boolean into a provider selector rather than introducing a parallel enable mechanism.

---

## Goals

- Define the `EmbedProvider` strategy abstraction that both the local nomic daemon and the Cohere-via-Portkey transport implement.
- Keep the local nomic path as the zero-marginal-cost default (nomic-embed-text-v1.5, q8, 768-dim).
- Make Cohere-via-Portkey an explicit operator opt-in, selected via config — never the default (DECISION #5).
- Extend the vault `embeddings.enabled` setting into a provider selector so the existing enable/disable semantics are preserved.

## Non-Goals

- Defaulting to Cohere. DECISION #5 rejects this.
- Abstracting the model revision / quantization into per-provider config for the local path. The nomic consts (`MODEL_ID`, `MODEL_REVISION`, `MODEL_QUANTIZATION`) stay pinned for reproducibility.
- A dimension selector. The 768-dim contract is fixed; changing it is a schema event.

---

## User stories

### US-014a.1 — Default to the local nomic provider

**As a** operator with no hosted-embeddings preference, **I want to** embeddings from the local nomic daemon by default, **so that** recall works at zero marginal cost without any provider configuration.

**Acceptance criteria:**
- AC-014a.1.1 Given no explicit provider selection, when the embed strategy is resolved, then the local nomic provider is selected.
- AC-014a.1.2 Given the local nomic provider runs, then it honors the pinned `MODEL_ID` (`nomic-ai/nomic-embed-text-v1.5`), `MODEL_REVISION`, and `MODEL_QUANTIZATION` (`q8`) consts.

### US-014a.2 — Opt in to Cohere-via-Portkey

**As a** operator who prefers hosted embeddings, **I want to** select the Cohere-via-Portkey provider via config, **so that** embeddings are computed by Cohere through the Portkey gateway.

**Acceptance criteria:**
- AC-014a.2.1 Given the operator selects the Cohere provider via config, when the embed strategy is resolved, then the Cohere-via-Portkey provider is selected.
- AC-014a.2.2 Given the Cohere provider is selected, then the local nomic daemon path is not exercised for embeddings.

### US-014a.3 — Preserve the enable/disable semantics

**As a** operator, **I want to** the `embeddings.enabled` toggle to still turn embeddings off entirely, **so that** switching providers does not regress the lexical-only fallback path.

**Acceptance criteria:**
- AC-014a.3.1 Given `embeddings.enabled` is false, when the strategy resolves, then no provider computes a vector (NULL embedding, BM25 fallback) regardless of which provider is selected.

---

## Implementation notes

- **Abstract the hard-wired consts.** The local nomic path is defined by module-level constants in the embeddings daemon: `EMBED_DIMS = 768` (`embeddings/src/index.ts:43`), `MODEL_ID = "nomic-ai/nomic-embed-text-v1.5"` (`:46`), `MODEL_REVISION` (`:57`), `MODEL_QUANTIZATION = "q8"` (`:60`), and `DOCUMENT_PREFIX = "search_document: "` (`:63`). The `EmbedProvider` strategy surfaces the dimension contract and the `embed(text)` method behind an interface; the local provider keeps the consts pinned.
- **The 768-dim contract is shared.** Both providers honor `EMBED_DIMS` (768). The embeddings daemon already throws on a dim mismatch (`embeddings/src/index.ts:213-217`); recall's `embed.dim_rejected` guard (`embed-client.ts:272-274`) and the `assertEmbeddingDim` throw (`storage/vector.ts:75-84`, `VectorDimensionError`) are the downstream guards. PRD-014b owns the Cohere transport's dim enforcement.
- **Extend `embeddings.enabled`, do not parallel it.** The vault key `EMBEDDINGS_ENABLED_KEY = "embeddings.enabled"` (`vault/api.ts:66`) is the single source of truth shared by the settings allow-list, the boot read, and the toggle action. The provider selector extends this surface — it does not introduce a second enable mechanism. The env-side toggle `HONEYCOMB_EMBEDDINGS` (`embed-client.ts:169-177`) stays the opt-OUT switch (UNSET/`true`/`1` → enabled; explicit `false`/`0` → disabled).
- **The strategy interface mirrors the existing `EmbedClient`.** The `EmbedClient.embed(text): Promise<readonly number[] | null>` contract (`embed-client.ts:80-83`) already returns `null` for disabled/unreachable/wrong-dim; the `EmbedProvider` strategy composes under that same null-on-failure contract so the capture path and the BM25 fallback need no change.

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Provider selector default: `local` (nomic). Unset/absent → local nomic provider (DECISION #5). Confirm the exact vault key name and selector vocabulary (e.g. `embeddings.provider` ∈ `{local, cohere}`) before implementation.

---

## Related

- [`./prd-014-embeddings-provider-switching-index.md`](./prd-014-embeddings-provider-switching-index.md)
- [`./prd-014b-cohere-via-portkey-transport.md`](./prd-014b-cohere-via-portkey-transport.md) — the Cohere transport this switch selects.
- [`./prd-014c-provider-switch-and-bm25-fallback.md`](./prd-014c-provider-switch-and-bm25-fallback.md) — the switch verification + BM25 fallback.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the embeddings layer + 768-dim contract.
