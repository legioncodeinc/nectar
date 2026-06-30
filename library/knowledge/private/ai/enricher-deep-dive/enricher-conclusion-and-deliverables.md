# Enricher Conclusion and Deliverables

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

The deliverable of the enricher deep dive: a lazy, debounced, cost-capped enrichment loop that keeps descriptions fresh without re-describing on every save; the model-choice defensibility restated; the graceful-degradation contract; and forward pointers to the sibling documents that complete the picture.

**Related:**
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`enricher-technical-specification.md`](enricher-technical-specification.md)
- [`enricher-introduction-and-theory.md`](enricher-introduction-and-theory.md)
- [`enricher-user-stories.md`](enricher-user-stories.md)
- [`enricher-ecosystem-story-arc.md`](enricher-ecosystem-story-arc.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../../data/source-graph-schema.md`](../../data/source-graph-schema.md)
- [`../../data/recall-integration.md`](../../data/recall-integration.md)
- [`../../overview.md`](../../overview.md)

---

## The deliverable

The enricher deep dive describes a single deliverable: a lazy, debounced, cost-capped enrichment loop that keeps file descriptions fresh in steady state, without re-describing on every save. The loop is the steady-state counterpart to brooding's one-time bootstrap, and it is the component that makes Hivenectar's semantic memory layer survive active editing of a codebase.

The deliverable decomposes into four properties, each of which is non-negotiable and each of which is grounded in the contract documented across this deep dive.

**Lazy.** A version row can sit with `describe_status = 'pending'` for hours or days. Recall does not surface undescribed rows; it filters on `describe_status = 'described'` and falls back to filename-only matching. Nothing breaks while a description is pending. The loop processes only the latest pending version per nectar, so intermediate saves within a cycle are never described.

**Debounced.** Two layers collapse volume. The `node:fs.watch` intake debounces per-path observations, so a developer hitting Cmd-S ten times in ten seconds produces one signal. The enricher queue coalesces pending rows by selecting `MAX(seq) per nectar`, so five edits in a minute yield at most one LLM call. On top of both, a meaningful-change heuristic — a Jaccard similarity over token multisets, threshold 0.85 — skips cosmetic changes (reformats, comment tweaks) by inheriting the previous description. The combination means the loop pays for an LLM call only when a genuinely semantic change occurs.

**Cost-capped at brood time.** The one-time `brood` bootstrap can be bounded with `--limit N` and previewed with `--dry-run` (both documented in `../brooding-pipeline.md`). The steady-state enricher loop is not separately cost-capped per invocation; its cost is bounded by the pending-queue depth and the 30-second poll interval. The loop delegates transient-failure retry to Portkey's built-in rate-limit handling rather than implementing its own, avoiding double-retry pathologies. Persistent failure — 5 consecutive failed cycles — raises a dashboard alert and stops further attempts until an operator acknowledges. The dashboard surfaces a rolling 24-hour cost counter and a queue-depth gauge, so cost is observable, not hidden.

**Fresh without churn.** The loop keeps descriptions current as files change, but it does not churn the version chain with rephrased-but-equivalent descriptions. The inheritance path writes `describe_model = inherited-from:<prev_content_hash>`, which records that the description was carried forward rather than re-minted, so a reviewer can distinguish a refreshed description from an inherited one at a glance.

---

## Model-choice defensibility, restated

The model choice is Gemini 2.5 Flash, routed through the Portkey gateway, and its defensibility rests on three legs that compose.

The first leg is **Pareto-optimality, not cheapness.** The comparison table — reproduced in the technical specification — shows Gemini 2.5 Flash landing at lower total cost than Haiku 4.5 and GPT-4.1 on the 1500-small-file brood slice, at comparable quality, because its 1M-token context window enables batch sizes that 200K-window models cannot match. GPT-4o-mini is price-competitive on paper but carries a quality risk and a 128K-window batch overhead that surfaces as call count and failure-retry cost. The choice is "lowest price at frontier quality with 1M context," which is a defensible criterion with the table as evidence.

The second leg is **configurability, not hardcoding.** The model is a default in the provider router, set via `agent.yaml` / Portkey config. A swap to Haiku, GPT-4.1, GPT-4o-mini, or a local Ollama model requires no code changes. The system never codes itself into one provider; the real contract is the capability tier — long context, single-file code understanding, structured JSON output, function calling NOT required, multilingual tolerance — and any model satisfying the tier is acceptable.

The third leg is **auditability, not implicitness.** The `describe_model` column on every `source_graph_versions` row records which model produced each description. After a swap, old-model rows are filterable, which makes selective re-description surgical rather than all-or-nothing. The system answers "which descriptions came from which model" from the data, not from inference.

---

## The graceful-degradation contract

The enricher never produces a recall quality cliff. Every failure path degrades gracefully rather than breaking recall, and the contract is worth stating explicitly because it is what makes the loop safe to run unattended.

| Condition | Behavior | Recall impact |
|---|---|---|
| Embedding provider unavailable | Description written; embedding NULL; `describe_status = 'described'` | Row served by BM25 over `title`/`description` — lexical-only, no error |
| LLM returns malformed JSON | Batch retried once, then each file tried solo | Offending file marked `failed`; others described normally |
| LLM rate-limits persistently | Portkey backoff for transients; batch marked `failed` after exhaustion | Failed rows excluded from recall until retried; pending rows invisible |
| File deleted while pending | Row marked `skipped-deleted`; no LLM call | Row never reaches recall — correct, the file is gone |
| Cosmetics-only edit | Description inherited; no LLM call | Recall surfaces the carried-forward description unchanged |

The shared shape across every row is that `describe_status` is the single gate recall reads. A row is recallable only when `describe_status = 'described'`, and every path that reaches that state — LLM call, inheritance, or a prior brooding write — is equivalent from recall's perspective. The embedding column is an enhancement, not a prerequisite: when it is NULL, recall falls back to BM25 over the description text, which is the same silent-fallback behavior the rest of Honeycomb uses. There is no error, no quality cliff, just lexical-only recall over descriptions until embeddings are available.

This is the contract that lets the enricher run as a background loop without an operator watching it. A transient daemon outage, a rate-limit spike, a malformed batch — each degrades a single cycle or a single file, and the next cycle recovers. Recall never sees a partial or broken state, because it only ever sees rows that have reached `described`.

---

## Forward pointers

This deep dive covers the enricher in isolation. Four sibling documents complete the picture, and each is the authoritative reference for a facet the enricher depends on but does not own.

**Brooding pipeline** (`../brooding-pipeline.md`) is the one-time bootstrap that takes a codebase from no nectars to every file described. The enricher is its steady-state counterpart: brooding owns the first pass and the projection bootstrap; the enricher owns everything after. The two share the same LLM call shape, the same embedding step, and the same model choice, but they differ in workload shape — brooding batches aggressively across the whole codebase; the enricher drains a trickle of pending rows.

**Source graph schema** (`../../data/source-graph-schema.md`) is the row contract the enricher writes to. Every column the enricher touches — `describe_status`, `describe_model`, `described_at`, `title`, `description`, `concepts`, `embedding` — is defined there, with its type, its lifecycle, and its participation in the indexes recall reads. The schema is the ground truth; this deep dive is the behavioral spec layered on top of it.

**Recall integration** (`../../data/recall-integration.md`) is the arm that consumes the enricher's output. It documents the guarded arm over `source_graph_versions` filtered to the latest described version per nectar, the BM25-and-vector scoring, and the RRF fusion that sits Hivenectar hits alongside session, memory, and skill hits. The enricher's `describe_status = 'described'` gate is what makes a row eligible for this arm.

**Overview** (`../../overview.md`) is the entry point that frames the three design pillars, of which lazy LLM description through a cheap long-context model is the second. The enricher is the steady-state expression of that pillar — brooding is the bootstrap expression. Read the overview first for the why; read this deep dive for the how the loop behaves in steady state.

---

## What this deep dive does not cover

To keep the scope tight, this deep dive deliberately leaves three topics to their own documents. **Re-association** — the ladder that decides which nectar a changed file belongs to, and that appends the pending version row the enricher later drains — is documented in `../identity-and-reassociation.md`. **The portable projection** — `.honeycomb/nectars.json`, the lockfile the projection-sync step regenerates — is documented in `../../data/portable-registry.md`. **The Portkey gateway and model provider router internals** — the routing, caching, and rate-limit handling the enricher depends on but does not own — live in the main Honeycomb corpus. The enricher is a consumer of all three; it is not the authoritative reference for any of them.
