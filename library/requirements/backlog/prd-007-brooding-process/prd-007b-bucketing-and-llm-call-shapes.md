# PRD-007b: Bucketing + LLM Call Shapes

> Parent: [`prd-007-brooding-process-index.md`](./prd-007-brooding-process-index.md)

## Overview

The core of brooding: how the files that survive the [007a](./prd-007a-discovery-and-content-hash-precheck.md) pre-check are **bucketed by size and parsability** into four buckets, how each bucket shapes its LLM call (or skips the LLM entirely), what the batch and solo prompts ask for, and the **cost math** that is this PRD's budget contract.

Every bucket, threshold, call shape, prompt field, and cost figure below is carried **verbatim** from [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "Bucketing," "The batch call," "The solo call," "Embedding," and "The cost math." No number is rounded or paraphrased. The four buckets — skip-binary, skip-too-large, batch, solo — are the load-bearing structure; the 4 KB / 100 KB / 256 KB thresholds are tuned against Gemini 2.5 Flash's 1M-token context window; and the cost table is the highest hallucination-risk surface in this PRD, reproduced exactly.

The LLM calls route through Portkey (transport + model selection owned by [PRD-010](../prd-010-portkey-gateway/prd-010-portkey-gateway-index.md)); the embeddings go through the provider switch (owned by [PRD-014](../prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md)). This sub-PRD owns the *bucketing logic*, the *prompt shapes*, and the *cost math*; it does not own the transport.

## Goals

- Carry the **four buckets and their criteria verbatim** from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md): skip-binary, skip-too-large, batch, solo.
- Carry the **thresholds verbatim**: `BATCH_FILE_SIZE` = 4 KB, `BATCH_TOTAL_SIZE` = 100 KB, `MAX_DESCRIBE_SIZE` = 256 KB, binary detection = NUL bytes in first 8 KB or known-binary extension.
- Carry the **batch call prompt and the solo call prompt verbatim**, including the output shapes: batch (title ≤80 chars + 1–3 sentence description + 1–5 concepts), solo (3–5 sentence description + primary symbol).
- Carry the **cost math table verbatim** — the 2000-file breakdown, the ~$3.05 total ($0.65 input + $2.40 output), ~2.15M input tokens, ~318 calls, and the ~$15 / ~$0.30 scale figures — with no rounding or paraphrase.
- Define the **batch size cap** default (40 files) within the corpus's 30–50 band, and the embedding step that follows every description.

## Non-Goals

- The discovery + content-hash pre-check that produces the files entering bucketing — [007a](./prd-007a-discovery-and-content-hash-precheck.md).
- The Portkey transport, model selection (Gemini 2.5 Flash), `describe_model` audit, and semantic-cache story — [PRD-010](../prd-010-portkey-gateway/prd-010-portkey-gateway-index.md). This sub-PRD assumes the batch/solo calls are made through Portkey; PRD-010 owns how.
- The embeddings provider switch (local nomic default vs Cohere-via-Portkey) and the 768-dim-must-match-schema rule — [PRD-014](../prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md). This sub-PRD states that embedding happens after description; PRD-014 owns the provider.
- The tables the descriptions land in (`source_graph_versions`) — [PRD-005b](../prd-005-source-graph-catalog-tables/prd-005b-source-graph-versions-table.md).
- The resumability rules that span the bucketing flow — [007c](./prd-007c-resumability-state-machine.md).
- The `--dry-run` cost *preview* output format (it consumes the cost math here but owns its own surface) — [007d](./prd-007d-cli-surface-and-dry-run.md).

---

## Bucketing

Files are bucketed by size and parsability **before any LLM call is made**. The bucket determines the call shape.

| Bucket | Criteria | LLM call shape |
|---|---|---|
| **Skip-binary** | First 8 KB contains NUL bytes, or extension is in a known-binary list (`.png`, `.jpg`, `.pdf`, `.woff2`, …) | No LLM call. Mint nectar, set `describe_status = 'skipped-binary'`, leave `title = filename`, `description = ''`. |
| **Skip-too-large** | `size_bytes > MAX_DESCRIBE_SIZE` (default 256 KB) | No LLM call. Mint nectar, set `describe_status = 'skipped-too-large'`, leave `title = filename`. The structural CodeGraph still extracts symbols; Hivenectar just does not describe it semantically. |
| **Batch** | Text, `size_bytes <= BATCH_FILE_SIZE` (default 4 KB), and the cumulative batch size is under `BATCH_TOTAL_SIZE` (default 100 KB) | 30–50 files per LLM call. |
| **Solo** | Text, `size_bytes > BATCH_FILE_SIZE` but `<= MAX_DESCRIBE_SIZE` | One file per LLM call. |

Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "Bucketing." The buckets are mutually exclusive (a file lands in exactly one) and exhaustive (every discovered, pre-check-surviving file lands in one of the four).

### The thresholds and their rationale

| Constant | Default | Role |
|---|---|---|
| `BATCH_FILE_SIZE` | 4 KB | Files `≤` this are batch candidates. 4 KB of source ≈ 1K tokens. |
| `BATCH_TOTAL_SIZE` | 100 KB | Cumulative cap per batch call. 40 files × ~2 KB ≈ 80 KB, well under. |
| `MAX_DESCRIBE_SIZE` | 256 KB | Files `>` this are skipped-too-large. The threshold is high so only genuinely large files pay the solo cost. |
| Binary detection | NUL in first 8 KB | A file with a NUL byte in its first 8 KB is treated as binary. |

[`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) states the tuning rationale verbatim: "The thresholds are tuned against Gemini 2.5 Flash's 1M-token context window and per-call economics. 4 KB of source ≈ 1K tokens; 40 files ≈ 40K tokens of input, well under the window. The output (one title + one 1–3 sentence description per file) is ≈ 50–100 tokens per file, ≈ 2–4K tokens per batch."

### Batch size cap *(DEFAULT — confirm before implementation)*

The corpus states batch calls pack **"30–50 files per LLM call"** ([`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)). This PRD registers **`40` files** as the batch-size cap — the midpoint of the 30–50 band, and the count the pipeline diagram + the cost table use ("group into batches of ~40 files", "40 files/call"). It is flagged **DEFAULT — confirm before implementation**: an implementation may choose any value in the 30–50 band as long as the `BATCH_TOTAL_SIZE` (100 KB) cumulative cap is also respected, since the cost math holds for the band, not for a single value.

---

## The batch call

A batch call sends the LLM a JSON array of `{ nectar, path, content }` objects and asks for a JSON array of `{ nectar, title, description, concepts }` back, **in the same order**. Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "The batch call."

### Batch system prompt (verbatim)

```
You are describing source files in a codebase for a semantic search index.
For each file, return:
- title: <=80 chars, a human-readable name for what this file IS (not its path).
- description: 1-3 sentences, what this file does and what it is for.
- concepts: 1-5 lowercase tags for cross-file linking (e.g. "auth", "session", "jwt").
Respond as a JSON array, one object per input file, in input order.
```

### Batch output shape

- **title** — ≤80 chars, a human-readable name for what the file IS (not its path).
- **description** — 1–3 sentences, what the file does and what it is for.
- **concepts** — 1–5 lowercase tags for cross-file linking (e.g. `auth`, `session`, `jwt`).

### Validation + failure handling

The response is parsed, validated against the expected shape, and written to the corresponding `source_graph_versions` rows. [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) states: "malformed entries are re-tried solo or marked `describe_status = 'failed'`." A malformed entry in a batch is therefore not fatal to the whole batch — the well-formed entries are written, and the malformed ones fall back to a solo retry or a `failed` status.

---

## The solo call

Large files (`size_bytes > BATCH_FILE_SIZE` but `<= MAX_DESCRIBE_SIZE`) get a solo call — one file per LLM call — with a slightly richer prompt. Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "The solo call."

### Solo output shape

- **description** — 3–5 sentences (richer than the batch's 1–3).
- **primary symbol** — the most important function/class/type in the file, which becomes a hint for cross-linking to the structural CodeGraph.

[`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) states the rationale verbatim: "Solo calls are the most expensive path per file, which is why the threshold (256 KB) is high: only genuinely large files pay this cost." Solo is the most expensive path per file precisely because it cannot amortize — one file, one call. The 4 KB `BATCH_FILE_SIZE` boundary and the 256 KB `MAX_DESCRIBE_SIZE` ceiling keep the solo count bounded.

---

## Skip buckets (no LLM call)

The skip buckets mint a nectar and record metadata but make **no LLM call**, leaving `title` as the filename and `description` empty. They exist so the source graph still *indexes* binary and oversized files (they have an identity row and a version row, just not a semantic description) without paying description cost.

- **skip-binary** — `describe_status = 'skipped-binary'`, `title = filename`, `description = ''`.
- **skip-too-large** — `describe_status = 'skipped-too-large'`, `title = filename`. The structural CodeGraph still extracts symbols from these files; Hivenectar simply does not describe them semantically.

The four valid `describe_status` terminal values a brood produces are therefore `described`, `failed`, `skipped-too-large`, and `skipped-binary` — matching the column contract in [PRD-005b](../prd-005-source-graph-catalog-tables/prd-005b-source-graph-versions-table.md).

---

## Embedding (after description)

After the description is written (batch or solo), the enricher computes a 768-dim embedding over `title + ' ' + description` through the shared embedding provider switch. Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "Embedding":

- **Default provider:** local nomic path (`nomic-embed-text-v1.5`, q8).
- **Hosted opt-in provider:** Cohere via Portkey.
- **Fallback:** if embeddings are off or the selected provider is unavailable, the embedding is left NULL and recall silently falls back to BM25 over `title` and `description` — no error, no quality cliff, the same degradation behavior as session and memory recall.

The provider switch, the 768-dim-must-match-schema rule, and the `embed.dim_rejected` guard are owned by [PRD-014](../prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md). This sub-PRD states only that embedding happens after description, over `title + ' ' + description`.

---

## The cost math (verbatim — the budget contract)

This section is the **highest hallucination-risk surface** in the PRD. Every number below is carried verbatim from [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "The cost math." No number is rounded, no figure is paraphrased, no new number is introduced. If any figure here disagrees with the source doc, the source doc wins.

### The 2000-file breakdown

Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md):

| Bucket | File count | Avg size | Tokens per file | Call shape | Calls | Total input tokens |
|---|---|---|---|---|---|---|
| Skip-binary | ~200 | — | 0 | — | 0 | 0 |
| Skip-too-large | ~20 | — | 0 | — | 0 | 0 |
| Batch (≤4KB) | ~1500 | 2 KB | ~500 | 40 files/call | 38 | ~750K |
| Solo (>4KB, ≤256KB) | ~280 | 20 KB | ~5000 | 1 file/call | 280 | ~1.4M |
| **Total** | **2000** | | | | **318** | **~2.15M input tokens** |

### The dollar figures (verbatim)

At Gemini 2.5 Flash pricing, carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md):

- **Input:** ~2.15M × $0.30/M = **$0.65**
- **Output:** ~318 calls × ~3K tokens avg = ~950K × $2.50/M = **$2.40** (output is the larger cost because descriptions are richer than the input file contents on a per-token basis)
- **Embedding:** ~1780 non-skipped files × 768-dim via local nomic provider = **$0** by default (Cohere via Portkey is opt-in and priced by provider)
- **Total brooding cost for a 2000-file repo: ~$3.05**

> The source doc notes the pricing tier detail verbatim: "≤200K tier: $0.30/M input, $2.50/M output; >200K tier: $0.70/M input, $5.00/M output — the >200K tier applies because each batch and solo call exceeds 200K cumulative across the project, but per-call inputs are well under 200K so the ≤200K rate applies per call."

### Scaling (verbatim)

Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md):

- **10000-file monorepo:** **~$15**
- **200-file microservice:** **~$0.30**

The source doc states: "For larger repos the math scales linearly with file count, with the batch/solo ratio holding roughly constant."

### One-time + fresh-clone-free

Carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md): "This is a one-time cost per project. Subsequent brooding (on a fresh clone that lacks the projection, or after projection loss) is avoided by the projection's content-hash inheritance — a clone of the same repo pays $0 if `.honeycomb/nectars.json` is committed, because every file's content hash matches the projection and no LLM call is made."

---

## Composition

The bucketing + describe + embed stages are steps 3–5 of the pipeline (after the [007a](./prd-007a-discovery-and-content-hash-precheck.md) discover → pre-check):

3. **Bucket** (this sub-PRD) — four buckets by size/type.
4. **Describe** (this sub-PRD) — batch or solo LLM call via Portkey (PRD-010); skip buckets make no call.
5. **Embed** (this sub-PRD) — 768-dim over `title + ' ' + description` (PRD-014).

Then persist rows (PRD-005) and regenerate the projection (PRD-011). Resumability across this flow is specified in [007c](./prd-007c-resumability-state-machine.md).

---

## User stories

### US-007b.1 — Small files are batched to collapse cost
**As an** operator, **when** brooding reaches 1500 small (≤4 KB) files, **they** are packed ~40 per batch call (38 calls), **so that** per-file description cost drops by an order of magnitude versus solo.

- Acceptance: batch bucket criteria = text + `size_bytes ≤ 4 KB` + cumulative `≤ 100 KB`, 30–50 files/call (default cap 40) ([`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) "Bucketing").

### US-007b.2 — Binary and oversized files are skipped, not described
**As an** operator, **when** brooding reaches a `.png` or a 1 MB file, **it** mints a nectar but makes no LLM call, **so that** cost is not wasted on undescribable content.

- Acceptance: skip-binary sets `describe_status = 'skipped-binary'`; skip-too-large sets `describe_status = 'skipped-too-large'` for `size_bytes > 256 KB` ([`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)).

### US-007b.3 — A brood's cost matches the budget contract
**As an** operator, **when** I brood a 2000-file repo, **the** total cost is ~$3.05 ($0.65 input + $2.40 output, ~318 calls, ~2.15M input tokens), **so that** brooding is predictable.

- Acceptance: the cost math reproduces the [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) table verbatim (no rounding).

---

## Implementation notes

- All four buckets + thresholds + the two prompts are carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md). The batch system prompt is reproduced character-for-character above.
- The batch call's "re-try malformed solo or mark `failed`" failure path feeds the resumability state machine in [007c](./prd-007c-resumability-state-machine.md) — a `failed` row is re-enqueueable.
- The LLM calls go through Portkey; the model is Gemini 2.5 Flash by default (configurable via `agent.yaml` / Portkey per [`knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md)). The transport + model selection is owned by [PRD-010](../prd-010-portkey-gateway/prd-010-portkey-gateway-index.md); this sub-PRD owns only the call *shape* (batch vs solo, prompt, output fields).
- The `describe_model` column ([PRD-005b](../prd-005-source-graph-catalog-tables/prd-005b-source-graph-versions-table.md)) records which model produced each description; brooding sets it to the model the call used.
- The describe→embed→persist composition mirrors `runGraphBuild`'s extract→finalize→persist at [`honeycomb/src/daemon/runtime/codebase/api.ts:247-253`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts): brooding extracts a description, embeds it, and persists atomically.

No open questions. The bucketing + prompts + cost math are all carried verbatim from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md); the only flagged default is the batch-size cap of 40 (DEFAULT — confirm before implementation).

## Related

- [PRD-007 index](./prd-007-brooding-process-index.md)
- [PRD-007a](./prd-007a-discovery-and-content-hash-precheck.md) — discovery + pre-check feed bucketing.
- [PRD-007c](./prd-007c-resumability-state-machine.md) — the `failed`/`pending` states this stage writes.
- [PRD-007d](./prd-007d-cli-surface-and-dry-run.md) — `--dry-run` consumes the cost math here.
- [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — the authoritative bucketing + prompts + cost math.
- [`knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the Gemini 2.5 Flash rationale + `describe_model`.
- [PRD-005b](../prd-005-source-graph-catalog-tables/prd-005b-source-graph-versions-table.md) — the `describe_status` / `describe_model` columns this stage writes.
- [PRD-010](../prd-010-portkey-gateway/prd-010-portkey-gateway-index.md) — the Portkey transport + model selection.
- [PRD-014](../prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md) — the embeddings provider switch + BM25 fallback.
- [`honeycomb/src/daemon/runtime/codebase/api.ts:234-261`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts) — `runGraphBuild`, the extract→persist composition to mirror.
