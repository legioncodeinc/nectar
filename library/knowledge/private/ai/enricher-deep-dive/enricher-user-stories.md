# Enricher User Stories

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

Engineering and operator user stories for the lazy enrichment loop — the personas that own polling, model configuration, auditing, change-detection, and cost control, with acceptance criteria grounded in the enricher contract.

**Related:**
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`enricher-technical-specification.md`](enricher-technical-specification.md)
- [`enricher-introduction-and-theory.md`](enricher-introduction-and-theory.md)
- [`enricher-ecosystem-story-arc.md`](enricher-ecosystem-story-arc.md)
- [`enricher-conclusion-and-deliverables.md`](enricher-conclusion-and-deliverables.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../../data/recall-integration.md`](../../data/recall-integration.md)

---

## How to read these stories

These are engineering-scope stories, not product requirements. They describe what the enricher loop, the operator, and the reviewer must be able to observe and do. Each story is phrased from the perspective of a concrete persona and carries lettered acceptance criteria that reference the enricher's observable behavior on `source_graph_versions`. They are the executable checklist a developer or operator uses to confirm the enrichment loop behaves as specified.

The personas recur across the stories:

- **The enricher loop** — the background poller inside the hiveantennae daemon.
- **The operator** — the engineer who configures `agent.yaml` / Portkey routing and runs `honeycomb` commands.
- **The reviewer** — the engineer who audits description provenance per row.
- **The watcher intake** — the `node:fs.watch` path that reports disk observations and triggers debounced re-description.
- **The cost-bound operator** — the operator operating under a cost cap or budget.

---

## Time-laziness — pending rows sit harmlessly

**US-EN-001** — As the enricher loop, I leave version rows with `describe_status = 'pending'` in the queue untouched until my poll interval fires, so that the queue absorbs bursts of edits without thrashing the LLM.
**Acceptance criteria:**
(a) A row appended at time T is not described before the next enricher cycle begins.
(b) The poll interval is configurable (default 30 seconds).
(c) No error, alert, or recall degradation occurs while a row sits pending.

**US-EN-002** — As an agent querying recall, I never see undescribed rows, so that pending enrichment cannot leak a half-filled description into results.
**Acceptance criteria:**
(a) The recall arm filters on `describe_status = 'described'`.
(b) A pending row is invisible to both the BM25 and vector recall arms.
(c) If the file has no described version, recall falls back to filename-only matching against the structural layer.

**US-EN-003** — As the enricher loop, I process only the latest pending version per nectar, so that intermediate saves within a cycle are never described.
**Acceptance criteria:**
(a) The pending-work query selects `MAX(seq) per nectar WHERE describe_status = 'pending'`.
(b) Intermediate version rows keep NULL descriptions permanently.
(c) The intermediate rows remain in the version chain as history.

---

## Change-laziness — the meaningful-change heuristic

**US-EN-004** — As the watcher, after debouncing and re-association, I append a pending version row only when the change passes the meaningful-change heuristic, so that whitespace-only and comment-only edits do not consume LLM calls.
**Acceptance criteria:**
(a) The heuristic tokenizes both versions with a language-aware tokenizer and computes Jaccard similarity over token multisets.
(b) If similarity ≥ `REDESCRIBE_THRESHOLD` (default 0.85), the new row inherits the previous `title`, `description`, `concepts`, and `embedding`.
(c) An inherited row is marked `describe_status = 'described'` with `describe_model = inherited-from:<prev_content_hash>`.
(d) No LLM call is made for inherited rows.

**US-EN-005** — As the enricher loop, when similarity falls below threshold I treat the change as meaningful and queue the row for a real LLM description.
**Acceptance criteria:**
(a) A reformatted file (Prettier, gofmt, rustfmt) that changes hash but not tokens meaningfully does not trigger re-description.
(b) A genuine semantic edit (renamed function, changed logic) does trigger re-description.
(c) The threshold is tunable per-repo via `~/.honeycomb/hivenectar.json`.

**US-EN-006** — As the operator, I can tune `REDESCRIBE_THRESHOLD` to make the heuristic more or less aggressive, so I can trade description churn for LLM cost on a per-repo basis.
**Acceptance criteria:**
(a) The threshold is read from `~/.honeycomb/hivenectar.json`.
(b) A lower threshold re-describes more eagerly; a higher threshold skips more edits.
(c) Changing the threshold does not retroactively re-evaluate already-described rows.

---

## Watcher intake debounce

**US-EN-007** — As the watcher, I debounce per-path events within a configurable window, so that a developer hitting Cmd-S ten times in ten seconds produces one "the file at this path changed" signal.
**Acceptance criteria:**
(a) Multiple `node:fs.watch` observations on the same path within the configured debounce window collapse to a single signal.
(b) The collapsed signal enters re-association once.
(c) The window is configurable independently of the enricher poll interval.

**US-EN-008** — As the watcher, my debounce window is shorter than Cartog's AST-rebuild debounce, because re-association is cheaper than a full AST re-extraction.
**Acceptance criteria:**
(a) The watcher debounce is configurable and mirrors Honeycomb's `fs.watch` + timer pattern rather than Cartog's richer watcher dependency.
(b) The two workers (CodeGraph and Hivenectar) run concurrently against the same file without coordination.
(c) Each writes to its own table (`codebase` vs `source_graph_versions`).

---

## The Gemini 2.5 Flash default + Portkey routing

**US-EN-009** — As the operator, the default describe model is Gemini 2.5 Flash routed through the Portkey gateway, so that out-of-the-box brooding and enrichment land at frontier-tier quality and the lowest cost-per-file.
**Acceptance criteria:**
(a) The default in the model provider router is Gemini 2.5 Flash.
(b) The model is reached through the Portkey gateway, not a hardcoded provider client.
(c) Every describe call records `describe_model` on the written row.

**US-EN-010** — As the operator, I swap the describe model by editing `agent.yaml` / Portkey config, so that no code change is required to switch providers or models.
**Acceptance criteria:**
(a) The model is a configuration default, not a hardcoded constant.
(b) Swapping to Haiku, GPT-4.1, GPT-4o-mini, or a local Ollama model requires only config edits.
(c) A swap to a local Ollama model reduces marginal cost to $0 at the cost of local GPU footprint and smaller batches.

---

## The 1M-context property is load-bearing

**US-EN-011** — As the enricher loop, I exploit the 1M-token context window to pack 30–50 small files per batch call, so that per-file cost collapses roughly linearly with batch size.
**Acceptance criteria:**
(a) Batch size is capped at 40–50 files in practice for output-token and reliability reasons.
(b) A 200K-window model (Haiku, Sonnet, GPT-4o) would cap the batch at ~6–10 files, quintupling call count.
(c) The batcher respects the configured model's context window.

**US-EN-012** — As the operator reviewing the comparison table, I can see that Gemini 2.5 Flash is Pareto-optimal at frontier quality + 1M context + lowest price at that quality.
**Acceptance criteria:**
(a) The model-comparison table is available in the technical specification.
(b) GPT-4o-mini is price-competitive but flagged for quality risk and 128K-window batch overhead.
(c) Gemini 2.5 Flash total cost for the 1500-small-file brood is lower than Haiku and GPT-4.1 at comparable quality.

---

## The capability tier

**US-EN-013** — As the operator, when I choose a model I check it against the capability tier, so that any model satisfying the tier is acceptable and the system does not code itself into one provider.
**Acceptance criteria:**
(a) Long context is required: ≥1M tokens preferred, ≥200K acceptable.
(b) Single-file code understanding at "what does this file do" tier is required.
(c) Structured JSON output is required.
(d) Function calling is NOT required — the enricher sends content and receives descriptions.
(e) Multilingual tolerance is required — non-English comments and identifiers must be handled.

---

## describe_model auditability

**US-EN-014** — As the reviewer, I read the `describe_model` column on every row to see which model produced each description, so that I can audit provenance per file.
**Acceptance criteria:**
(a) Every described row carries a non-empty `describe_model`.
(b) Inherited rows carry `inherited-from:<prev_content_hash>`.
(c) The column distinguishes which model produced which descriptions within the same project.

**US-EN-015** — As the reviewer, I can filter rows by `describe_model` to find descriptions produced by an old model after a swap, so that I can decide which to re-describe.
**Acceptance criteria:**
(a) Rows described by the previous model are identifiable by `describe_model` value.
(b) The reviewer can target selective re-description at those rows.
(c) Rows described by the new model are excluded from re-description.

---

## Selective re-description on model swap

**US-EN-016** — As the operator, a model swap does not automatically re-describe existing rows, because existing descriptions remain valid until proven otherwise.
**Acceptance criteria:**
(a) Swapping the configured model does not touch any existing `source_graph_versions` row.
(b) New pending rows pick up the new `describe_model` on next enrichment.
(c) Recall continues to surface old-model descriptions unchanged.

**US-EN-017** — As the operator, when I want to re-describe everything under the new model I run `honeycomb hivenectar brood --force --model <new>`, which sets all non-skipped rows back to pending.
**Acceptance criteria:**
(a) The command resets non-skipped rows to `describe_status = 'pending'`.
(b) Skipped rows (`skipped-binary`, `skipped-too-large`) are not reset.
(c) The enricher re-describes them on subsequent cycles using the new model.

---

## Cost cap and rate limiting

**US-EN-018** — As the cost-bound operator, I can cap the cost of a *brood* with `--limit N` and preview it with `--dry-run`, so the one-time bootstrap cannot exceed a known cost.
**Acceptance criteria:**
(a) `honeycomb hivenectar brood --limit N` describes at most N pending files per invocation (a `brood` flag, documented in `../brooding-pipeline.md`).
(b) Remaining pending files stay pending for a subsequent brood or for the enricher loop to pick up.
(c) `honeycomb hivenectar brood --dry-run` reports the estimated call count and cost without making LLM calls.
(d) The steady-state enricher loop is not separately cost-capped per invocation; its cost is bounded by the pending-queue depth and the 30-second poll interval.

**US-EN-019** — As the enricher loop, I rely on Portkey's built-in rate-limit handling for 429s and 5xxs rather than implementing my own retry, so that double-retry pathologies are avoided.
**Acceptance criteria:**
(a) Transient 429/5xx responses are retried with exponential backoff by Portkey.
(b) The enricher does not wrap the call in its own retry loop.
(c) A batch that fails all retries is marked `describe_status = 'failed'`.

**US-EN-020** — As the enricher loop, after 5 consecutive failed cycles I raise a dashboard alert and stop further enrichment attempts until an operator acknowledges.
**Acceptance criteria:**
(a) The persistent-failure threshold is 5 consecutive cycles (configurable).
(b) A dashboard alert is raised when the threshold is crossed.
(c) No further enrichment attempts run until the operator acknowledges.

**US-EN-021** — As the enricher loop, I log every cycle's files described, files inherited, files failed, tokens consumed, and estimated cost, so the dashboard can surface a rolling 24-hour cost counter and queue-depth gauge.
**Acceptance criteria:**
(a) Each cycle emits a structured log with the five counters.
(b) The dashboard exposes a rolling 24-hour cost counter.
(c) The dashboard exposes a queue-depth gauge.

---

## Failure → describe_status='failed' → retry-solo

**US-EN-022** — As the enricher loop, when a batch returns malformed JSON or the wrong number of descriptions, I retry the batch once with a stricter prompt, then fall back to solo calls.
**Acceptance criteria:**
(a) A length-mismatch or parse failure triggers one batch retry with a stricter prompt.
(b) If the retry fails, each file is marked `describe_status = 'failed'` and queued for solo processing on the next cycle.
(c) Solo processing describes one file per call, isolating the failure to the offending file.

**US-EN-023** — As the enricher loop, if a batch call exceeds the context window (which should never happen) I split the batch in half and retry each half.
**Acceptance criteria:**
(a) The batcher respects the configured context window under normal operation.
(b) An over-window batch is split in half and each half retried.
(c) The split recurses until the batch fits.

**US-EN-024** — As the enricher loop, when a pending file is deleted before I reach it, I mark its version row `describe_status = 'skipped-deleted'` and make no LLM call.
**Acceptance criteria:**
(a) A missing source file is detected on the next cycle.
(b) The row is marked `skipped-deleted`, not `failed`.
(c) No LLM call is made for deleted files.

---

## BM25 fallback when embeddings are off

**US-EN-025** — As the enricher loop, when the configured embedding provider is unavailable I still write the description and mark the row `described`, leaving the embedding NULL, so recall falls back to BM25 with no quality cliff.
**Acceptance criteria:**
(a) The description is written regardless of daemon availability.
(b) The embedding column is left NULL when the daemon is down or uninstalled.
(c) `describe_status` is set to `described`, not `failed`.
(d) Recall serves the row via BM25 over `title` and `description`.
(e) No error is raised; the fallback is silent, matching the rest of Honeycomb.
