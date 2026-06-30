# PRD-014c: Provider switch and BM25 fallback

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S (1-3h)
> **Schema changes:** None

---

## Overview

The verification that the provider switch actually selects the configured strategy, and the confirmation that the graceful BM25-only fallback still holds when embeddings are off. Switching providers must change which transport runs; turning embeddings off must leave the column NULL and fall recall back to lexical BM25 over title and description with no error and no quality cliff. This sub-PRD owns the switch-verification acceptance criteria and the fallback-path proof, not new code beyond the switch wiring 014a/014b deliver.

---

## Goals

- Verify the provider selector routes to the configured strategy: `local` → nomic daemon, `cohere` → Cohere-via-Portkey transport, off → no vector.
- Confirm the embeddings-off path leaves the embedding column NULL and recall falls back to BM25 over title/description (the silent-fallback behavior the rest of the system already uses).
- Confirm a wrong-dim vector from either provider is discarded (column NULL) and recall degrades to BM25 without surfacing an error.

## Non-Goals

- A quality-of-service metric for BM25-vs-semantic recall. Out of scope; the fallback is silent by design.
- A health-page redesign. The embeddings-off state is observable through the existing warm/`dim_rejected` surface.
- Forcing a re-embed on provider switch. Existing vectors stay valid; a switch affects subsequent embeds.

---

## User stories

### US-014c.1 — Switch routes to the configured provider

**As a** operator, **I want to** changing the provider selector to change which transport computes vectors, **so that** the config is authoritative.

**Acceptance criteria:**
- AC-014c.1.1 Given the selector is `local`, when an embedding is computed, then the local nomic daemon transport runs (default).
- AC-014c.1.2 Given the selector is `cohere`, when an embedding is computed, then the Cohere-via-Portkey transport runs and the local daemon does not.

### US-014c.2 — Embeddings off falls back to BM25

**As a** operator with embeddings disabled, **I want to** recall to still work over title/description, **so that** there is no error or quality cliff.

**Acceptance criteria:**
- AC-014c.2.1 Given `embeddings.enabled` is false (or the optional dependency is absent / the daemon failed to warm), when a description is written, then the embedding column is left NULL and `describe_status` is `described`.
- AC-014c.2.2 Given the embedding column is NULL, when recall runs, then it falls back to BM25 over title and description — no error, no quality cliff.

### US-014c.3 — A discarded vector degrades to BM25

**As a** recall reviewer, **I want to** a wrong-dim vector discarded, **so that** the 768-dim contract holds and recall degrades rather than corrupts.

**Acceptance criteria:**
- AC-014c.3.1 Given either provider returns a non-768 vector, then the `embed.dim_rejected` event fires, the vector is discarded, and the column stays NULL.
- AC-014c.3.2 Given the discarded vector left the column NULL, then recall falls back to BM25 over title/description (same path as embeddings-off).

---

## Implementation notes

- **The switch is the strategy resolution, not a storage concern.** The `EmbedProvider` selector (014a) determines which `embed(text)` implementation runs; both implementations return `readonly number[] | null` under the existing `EmbedClient` contract (`embed-client.ts:80-83`). Verification is: with selector `local`, the local path runs; with selector `cohere`, the Cohere transport runs; with embeddings off, neither runs and the column is NULL.
- **The embeddings-off path is already proven.** `HONEYCOMB_EMBEDDINGS` is opt-OUT (UNSET/`true`/`1` → enabled; explicit `false`/`0` → disabled, `embed-client.ts:169-177`); `DaemonEmbedClient` returns `null` when `enabled` is false (`embed-client.ts:248`). A NULL embedding column means recall falls back to BM25 over title and description (`ai/enricher-and-llm-model.md` § Embeddings). This sub-PRD confirms that path is unchanged by the provider switch.
- **The discard path is already proven.** A wrong-dim vector emits `embed.dim_rejected` and resolves to `null` (`embed-client.ts:272-274`); the attacher re-checks the dimension before any SQL (`embed-client.ts:313-316`). Downstream, `assertEmbeddingDim` throws `VectorDimensionError` before SQL is built (`storage/vector.ts:75-84`). The Cohere transport composes under the same guards (014b), so a wrong-dim Cohere vector is discarded at the client — the SQL/storage path never sees it.
- **Graceful fallback, no quality cliff.** The fallback is silent by design: descriptions stay lexically searchable, recall never errors, and there is no read-lock or "enrichment in progress" state (`ai/enricher-and-llm-model.md` § What the enricher explicitly does not do).

---

## Flagged defaults

None beyond those in 014a/014b. This sub-PRD verifies already-locked behavior; it introduces no configurable default.

---

## Related

- [`./prd-014-embeddings-provider-switching-index.md`](./prd-014-embeddings-provider-switching-index.md)
- [`./prd-014a-embed-provider-strategy-and-config.md`](./prd-014a-embed-provider-strategy-and-config.md) — owns the switch this sub-PRD verifies.
- [`./prd-014b-cohere-via-portkey-transport.md`](./prd-014b-cohere-via-portkey-transport.md) — owns the Cohere transport + dim enforcement this sub-PRD verifies.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the BM25-fallback contract.
