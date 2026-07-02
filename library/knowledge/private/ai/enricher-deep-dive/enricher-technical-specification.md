# Enricher Technical Specification

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

The enricher contract: the polling loop over pending rows, the debounce plus meaningful-change heuristic, the rate-limit and cost-cap knobs, the model-comparison table, the capability tier a model must satisfy, the `describe_model` column contract, the failure-to-retry-solo path, and the embeddings layer.

**Related:**
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`enricher-user-stories.md`](enricher-user-stories.md)
- [`enricher-introduction-and-theory.md`](enricher-introduction-and-theory.md)
- [`enricher-ecosystem-story-arc.md`](enricher-ecosystem-story-arc.md)
- [`enricher-conclusion-and-deliverables.md`](enricher-conclusion-and-deliverables.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md)

---

## Why this exists

Brooding describes every file once, as a one-time bootstrap. Everything after that — re-describing a file whose content meaningfully changed, describing a file that brooding skipped (cost cap or `--limit`), and describing genuinely new files the watcher detected — is the enricher's job. The enricher is the steady-state description-maintenance loop, and this document is its contract: the observable inputs, the invariants, and the failure paths.

The enricher runs as a background loop inside the hiveantennae daemon, polling a work queue of `hive_graph_versions` rows where `describe_status = 'pending'`. Its correctness rests on two laziness properties — time-laziness (pending rows sit harmlessly) and change-laziness (only meaningful changes re-describe) — plus a graceful-degradation contract that never produces a recall quality cliff.

---

## The polling loop

The enricher loop runs on a configurable interval (default 30 seconds) and selects the latest pending version per nectar within the current tenancy scope. Selecting `MAX(seq) per nectar` is what makes intermediate saves within a cycle disappear: if a file was edited five times in a minute, only the most recent version row carries content worth describing, and the enricher never pays for the intermediates.

```sql
-- The enricher's pending-work query (simplified; real query is sqlStr-guarded)
SELECT nectar, MAX(seq) AS seq
FROM hive_graph_versions
WHERE describe_status = 'pending'
  AND org_id = :org
  AND workspace_id = :workspace
  AND project_id = :project
GROUP BY nectar
ORDER BY MIN(observed_at)
LIMIT :batch_size;
```

The `ORDER BY MIN(observed_at)` guarantees oldest-first fairness so a file that went pending hours ago is not starved by a file that went pending seconds ago. Intermediate version rows that this query skips keep NULL descriptions forever — they remain in the chain as history, and nobody will ever recall a stale intermediate state.

---

## The debounce layers

Two independent debounce layers sit between a save event and an LLM call. Their separation matters: the first collapses events at the filesystem boundary; the second coalesces pending rows at the queue boundary.

### Watcher intake debounce (per-path)

The `node:fs.watch` intake debounces observations per-path with a configurable window. Multiple uncorrelated `(eventType, filename)` observations on the same path within the window collapse to a single "the file at this path changed" signal, which then enters re-association. This mirrors Honeycomb's file-watcher pattern and avoids adding another watcher dependency.

### Enricher queue debounce (per-cycle)

After re-association appends a new version row, the row sits in the queue with `describe_status = 'pending'`. The enricher does not describe it immediately. The poll interval plus the `MAX(seq) per nectar` selection naturally coalesces rapid-fire edits: a file edited five times in a minute yields at most one LLM call (for the latest version), regardless of how many pending rows accumulated.

---

## The meaningful-change heuristic

The debounce layers collapse volume; the meaningful-change heuristic collapses *noise*. Not every content change warrants a re-description. A Prettier reformat changes the content hash but not the file's meaning, and re-describing it wastes an LLM call and pollutes the version chain with an artificially-churned description (the LLM rephrases even identical semantic content).

The heuristic is a fast pre-LLM diff evaluated before any model call:

1. **Tokenize both versions** with the lightweight, language-aware tokenizer the structural CodeGraph uses for parse-error reporting — a token stream, not a full AST.
2. **Compute a Jaccard similarity** over the token multisets.
3. **If similarity ≥ `REDESCRIBE_THRESHOLD`** (default 0.85), the change is cosmetic. The new version row inherits the previous version's `title`, `description`, `concepts`, and `embedding`; `describe_status` is set to `described`; `describe_model` is set to `inherited-from:<prev_content_hash>`. No LLM call is made.
4. **If similarity < threshold**, the change is meaningful and the new version row enters the pending queue.

This adapts the Smith intuition (`Hash != Described-Against-Hash` triggers re-description; equality skips it) from raw-hash equality to token similarity, so a reformat — which changes the hash but not the tokens meaningfully — does not trigger re-description. The threshold is tunable per-repo via `~/.honeycomb/nectar.json`.

---

## Rate-limit and cost-cap knobs

The enricher does not implement its own retry logic. It delegates transient-failure handling to Portkey's built-in rate-limit handling, which on a 429 or 5xx retries with exponential backoff. Avoiding a second retry layer prevents double-retry pathologies.

| Knob | Default | Purpose |
|---|---|---|
| Enricher poll interval | 30 seconds | How often the loop drains the pending queue |
| Watcher intake debounce | Configurable; mirrors Honeycomb's `fs.watch` timer pattern | Per-path event collapse window |
| `REDESCRIBE_THRESHOLD` | 0.85 | Jaccard similarity above which a change is cosmetic |
| Persistent-failure threshold | 5 consecutive cycles | Cycles of all-retry-failure before alert-and-stop |

Cost caps and dry-run cost estimates belong to the `brood` command (`--limit N`, `--dry-run`), documented in `../brooding-pipeline.md`. The enricher loop itself is a steady-state poller; per-invocation cost bounding is a brood-time concern, not an enricher-loop knob.

A batch that fails all Portkey retries is marked `describe_status = 'failed'` on its constituent version rows and retried on the next enricher cycle with a smaller batch size. Persistent failure — 5 consecutive failed cycles — raises a dashboard alert and stops further enrichment attempts until an operator acknowledges.

---

## The model-comparison table

The default describe model is Gemini 2.5 Flash, routed through the Portkey gateway. The choice is driven by one property above all others: the 1-million-token context window at frontier-tier quality and price. The table below reproduces the comparison for the 1500-small-file brood slice.

| Model | Context | Per-call batch | Calls for 1500 small files | Input cost | Output cost | Total |
|---|---|---|---|---|---|---|
| Gemini 2.5 Flash | 1M | 40 | 38 | $0.65 | $2.40 | **$3.05** |
| Claude Haiku 4.5 | 200K | 8 | 188 | $1.50 | $5.50 | **$7.00** |
| GPT-4.1 | 1M | 40 | 38 | $3.00 | $8.50 | **$11.50** |
| GPT-4o-mini | 128K | 5 | 300 | $0.60 | $2.40 | **$3.00** (quality risk) |

GPT-4o-mini is price-competitive but its single-file summarization quality is measurably worse on code understanding benchmarks, and its 128K window forces tiny batches that increase call overhead and failure-retry cost. Gemini 2.5 Flash is the Pareto-optimal point: frontier-tier quality, 1M context, lowest price at that quality.

---

## The capability-tier spec

The model does not need to be a frontier reasoner. It needs to satisfy a specific tier, and any model satisfying the tier is acceptable. The tier is what makes the model choice configurable rather than hardcoded.

- **Long context** — ≥1M tokens preferred, ≥200K acceptable. Required for batching.
- **Single-file code understanding** — at the level of "what does this file do, what is it for." Well within Haiku/Flash/4o-mini tier.
- **Structured JSON output** — the response is a JSON array of description objects. Gemini, Claude, and GPT families support this reliably.
- **Function calling is NOT required.** The enricher sends content and receives descriptions; it does not use tools.
- **Multilingual tolerance** — the codebase may contain non-English comments or identifiers. Flash and Haiku handle this; very small local models may not.

Gemini 2.5 Flash is the default because it satisfies every tier requirement at the lowest cost-per-file for the batch sizes Nectar uses.

---

## The `describe_model` column contract

Every `hive_graph_versions` row carries a `describe_model` column that records which model produced its description. The contract:

| State | `describe_model` value |
|---|---|
| Described by a real model | The model identifier (e.g. `gemini-2.5-flash` via Portkey) |
| Inherited from a similar previous version | `inherited-from:<prev_content_hash>` |
| Pending / failed / skipped | empty string |

The column is auditable per row: a reviewer can identify which model produced which descriptions within the same project. After a model swap, rows described by the previous model are filterable, which is the mechanism behind selective re-description. The default model is set in the model provider router (configurable via `agent.yaml` / Portkey config), and a swap to Haiku, GPT-4.1, GPT-4o-mini, or a local Ollama model requires no code changes.

---

## The failure → retry-solo path

Failure handling isolates blame to the offending file rather than aborting a whole batch. The paths:

| Failure | Behavior |
|---|---|
| LLM returns malformed JSON | Re-try the batch once with a stricter prompt; if still malformed, mark each file `describe_status = 'failed'` and process them solo on the next cycle. |
| LLM returns wrong number of descriptions | Same as malformed — the validator catches length mismatch, retries, then falls back to solo. |
| LLM rate-limits persistently | Portkey backoff handles transient 429s; persistent failure marks the batch `failed` and alerts. |
| LLM call exceeds context window | Should never happen (batcher respects the limit), but if it does, the batch is split in half and retried. |
| Embedding provider unavailable | Description is written; embedding is NULL; `describe_status = 'described'` (recall falls back to BM25). |
| File deleted while pending | The pending version row is marked `describe_status = 'skipped-deleted'` on the next enricher cycle; no LLM call is made. |

The retry-solo path is what makes a single bad file non-fatal: a batch of 40 that produces malformed JSON is retried as a batch, then — if still malformed — each file is tried individually. The 39 good files get described; the one offending file is isolated, marked `failed`, and re-tried on a later cycle.

---

## The embeddings layer

Once a description is written — by brooding, by the enricher, or inherited from a similar previous version — the enricher computes a 768-dim embedding over `title + ' ' + description` using the configured embedding provider. Local nomic is the default; Cohere via Portkey is the hosted opt-in provider. Both providers must honor the 768-dim contract.

| Property | Value |
|---|---|
| Model | nomic-embed-text-v1.5 |
| Quantization | q8 |
| Dimensionality | 768 |
| Transport | Unix-socket NDJSON IPC |
| Location | Local daemon process |
| Marginal cost | $0 |

The 768 dimensionality is load-bearing: it matches `sessions.message_embedding` and `memory.summary_embedding` deliberately, so the hybrid recall pipeline's vector index expects a consistent dimensionality across the tables it unions over. A different dimensionality would force a separate index and a separate recall arm, doubling query cost. If the embedding model is ever swapped, all three tables must be re-embedded together.

### BM25 fallback

If embeddings are off — the optional dependency was not installed, or the daemon failed to warm up — the embedding column is left NULL and recall falls back to BM25 over `title` and `description`. This is the same silent-fallback behavior the rest of Honeycomb uses: no error, no quality cliff, just lexical-only recall over descriptions until embeddings are available. The row is still marked `describe_status = 'described'`, because the description itself is valid; only the vector is absent.

---

## What the enricher explicitly does not do

- **It does not describe directories.** Folders are derived from file paths in v1; a directory description is synthesized on demand from its files' descriptions.
- **It does not describe symbols.** v1 is file-granular; symbol-level description would multiply row counts 10–100×.
- **It does not run on files the CodeGraph is building.** The two workers write to different tables and may run concurrently without coordination.
- **It does not block recall.** A query during enrichment sees whatever has been described so far. There is no read-lock, no "enrichment in progress" state.
- **It does not re-describe on model swap automatically.** Existing descriptions are valid until proven otherwise; re-description requires an explicit `honeycomb nectar brood --force --model <new>`.
