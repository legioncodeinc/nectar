# Enricher and LLM Model

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

The lazy enrichment path that fills titles and descriptions after brooding: why Gemini 2.5 Flash is the canonical model (and what makes it the right choice over Haiku, GPT-4.1, and local Ollama), how the enricher debounces and rate-limits, how failures and model swaps are handled, and how the embeddings layer fits.

**Related:**
- [`../overview.md`](../overview.md)
- [`brooding-pipeline.md`](brooding-pipeline.md)
- [`identity-and-reassociation.md`](identity-and-reassociation.md)
- [`../data/source-graph-schema.md`](../data/source-graph-schema.md)
- [`../data/recall-integration.md`](../data/recall-integration.md)
- [`../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)
- [`../reference/prior-art-crosswalk.md`](../reference/prior-art-crosswalk.md)

---

## The enricher's job

Brooding describes every file once. The enricher's job is everything after: re-describing a file when its content meaningfully changes, describing a file that was minted but skipped during brooding (cost cap hit, or `--limit` was used), and describing genuinely new files the watcher detected. The enricher is the steady-state description maintenance loop; brooding is the one-time bootstrap.

The enricher runs as a background loop inside the hiveantennae worker, polling a work queue of `source_graph_versions` rows where `describe_status = 'pending'`. It is lazy in two senses:

1. **Time-lazy.** A version row can sit with `describe_status = 'pending'` for hours or days. Recall simply does not surface undescribed rows (the recall query filters on `describe_status = 'described'` OR falls back to filename-only matching). Nothing breaks while a description is pending.
2. **Change-lazy.** The enricher does not re-describe on every save. It debounces (next section) and, even after debouncing, applies a "meaningful change" heuristic — if the new content hash produces a structural delta below a threshold (e.g., only whitespace or only comment changes, detectable via a fast AST-light diff), the existing description is re-attached to the new version row and no LLM call is made.

---

## Why Gemini 2.5 Flash specifically

The model choice for Hivenectar is **Gemini 2.5 Flash**, routed through the existing Portkey gateway (documented in the main Honeycomb corpus at `ai/portkey-gateway.md` and `ai/model-provider-router.md`). The choice is driven by one property above all others: the **1-million-token context window at frontier-tier quality and price**.

Long context is load-bearing for Hivenectar in a way it is not for most LLM applications. The brooding batch call packs 30–50 small files into a single LLM round-trip; the per-file cost collapses roughly linearly with batch size up to the context limit. A model with a 200K-token window (Claude Haiku, Claude Sonnet, GPT-4o) caps the batch at ~6–10 small files per call, quintupling the call count and the per-file overhead. A model with a 1M-token window fits ~200 small files per call in principle, though batch size is capped at 40–50 in practice for output-token and reliability reasons.

The comparison, for the 2000-file brood from `brooding-pipeline.md`:

| Model | Context | Per-call batch | Calls for 1500 small files | Input cost | Output cost | Total |
|---|---|---|---|---|---|---|
| Gemini 2.5 Flash | 1M | 40 | 38 | $0.65 | $2.40 | **$3.05** |
| Claude Haiku 4.5 | 200K | 8 | 188 | $1.50 | $5.50 | **$7.00** |
| GPT-4.1 | 1M | 40 | 38 | $3.00 | $8.50 | **$11.50** |
| GPT-4o-mini | 128K | 5 | 300 | $0.60 | $2.40 | **$3.00** (quality risk) |

GPT-4o-mini is price-competitive but its single-file summarization quality is measurably worse on code understanding benchmarks, and its 128K window forces tiny batches that increase call overhead and failure-retry cost. Gemini 2.5 Flash is the Pareto-optimal point: frontier-tier quality, 1M context, lowest price at that quality.

The model is not hardcoded. It is the **default** in the model provider router, configurable via the same `agent.yaml` / Portkey config that routes every other LLM call in Honeycomb. An operator who wants to swap to Haiku (smaller batches, higher cost, no infrastructure change) or to a local Ollama model (zero marginal cost, local GPU footprint, smaller batches) can do so without code changes. The `describe_model` column on every `source_graph_versions` row records which model produced each description, so a model swap can trigger selective re-description of files described by the old model if quality demands it.

### What Hivenectar needs from the model (capability tier)

The model does not need to be a frontier reasoner. It needs:

- **Long context** (≥1M tokens preferred, ≥200K acceptable) — for batching.
- **Single-file code understanding** at the level of "what does this file do, what is it for" — well within Haiku/Flash/4o-mini tier.
- **Structured JSON output** — the response is a JSON array of description objects. Gemini, Claude, and GPT families all support this reliably.
- **Function calling is NOT required.** The enricher does not use tools; it sends content and receives descriptions.
- **Multilingual tolerance** — the codebase may contain files with non-English comments or identifiers. Flash and Haiku handle this; very small local models may not.

A model that satisfies these is acceptable. Gemini 2.5 Flash is the default because it satisfies them at the lowest cost-per-file for the batch sizes Hivenectar uses.

---

## Debouncing and rate limiting

The watcher fires events on every save. A developer hitting Cmd-S ten times in ten seconds should not trigger ten enricher calls (or even ten re-association ladders). Hivenectar applies two layers of debouncing:

### Watcher intake debounce

The chokidar intake debounces events per-path with a configurable window (default 2000 ms). Multiple events on the same path within the window collapse to a single "the file at this path changed" signal, which then enters re-association. This is the same pattern the CodeGraph worker uses for its build trigger, and the same pattern Cartog uses (`--debounce 5000` is Cartog's default; Hivenectar's is shorter because re-association is cheaper than a full AST re-extraction).

### Enricher queue debounce

After re-association appends a new version row, the enricher does not immediately describe it. The version row sits in the queue with `describe_status = 'pending'`. The enricher loop runs on a configurable interval (default 30 seconds) and processes the queue in batches, which naturally coalesces rapid-fire edits to the same file: if a file was edited five times in a minute, only the most recent version row (the latest content) is worth describing, and the enricher skips the intermediate versions by selecting only `MAX(seq) per nectar WHERE describe_status = 'pending'`.

```sql
-- The enricher's pending-work query (simplified; real query is sqlStr-guarded)
SELECT nectar, MAX(seq) AS seq
FROM source_graph_versions
WHERE describe_status = 'pending'
  AND org_id = :org
  AND workspace_id = :workspace
  AND project_id = :project
GROUP BY nectar
ORDER BY MIN(observed_at)
LIMIT :batch_size;
```

This "latest pending version per nectar" semantics means intermediate saves within an enricher cycle are never described — their version rows remain in the chain as history, but their descriptions stay NULL forever, which is correct (nobody will ever recall a stale intermediate state).

### Rate limiting

The enricher respects the model provider's rate limits through Portkey's built-in rate-limit handling (documented in the main corpus's Portkey doc). On a 429 or 5xx, Portkey retries with exponential backoff; the enricher does not implement its own retry logic, avoiding double-retry pathologies. A batch that fails all retries is marked `describe_status = 'failed'` on its constituent version rows and retried on the next enricher cycle with a smaller batch size. Persistent failure (default: 5 consecutive cycles) raises a dashboard alert and stops further enrichment attempts until an operator Acknowledges.

---

## The "meaningful change" heuristic

Not every content change warrants a re-description. A developer who reformats a file (Prettier, gofmt, rustfmt) has not changed its meaning, and re-describing it wastes LLM calls and produces an artificially-churned description (the LLM will phrase the new description slightly differently even for identical semantic content, which pollutes the version chain).

Hivenectar applies a fast pre-LLM diff to decide whether to re-describe:

1. **Tokenize both versions** with a lightweight, language-aware tokenizer (the same one the structural CodeGraph uses for its parse-error reporting — not a full AST, just a token stream).
2. **Compute a Jaccard similarity** over the token multisets.
3. **If similarity ≥ REDESCRIBE_THRESHOLD** (default 0.85), the change is deemed cosmetic. The new version row inherits the previous version's `title`, `description`, `concepts`, and `embedding`, and `describe_status` is set to `described` with a `describe_model` marker of `inherited-from:<prev_content_hash>`.
4. **If similarity < threshold**, the change is deemed meaningful and the new version row enters the pending queue.

This is the same intuition Smith uses (`Hash != Described-Against-Hash` triggers re-description; equality skips it), adapted to token similarity rather than raw hash equality so that a reformat (which changes the hash but not the tokens meaningfully) does not trigger re-description. The threshold is configurable and tunable per-repo via `~/.honeycomb/hivenectar.json`.

---

## Embeddings

Once a description is written (by brooding, by enricher, or inherited from a similar previous version), the enricher computes a 768-dim embedding over `title + ' ' + description` using the existing embeddings daemon (nomic-embed-text-v1.5, q8 quantization, Unix-socket NDJSON IPC — fully documented in the main corpus's embeddings docs).

The embedding dimensionality (768) matches `sessions.message_embedding` and `memory.summary_embedding` deliberately. This is a load-bearing constraint: the hybrid recall pipeline's vector index expects a consistent dimensionality across the tables it unions over. A different dimensionality would force a separate index and a separate recall arm, doubling the query cost. If the embedding model is ever swapped, all three tables must be re-embedded together — this is a known constraint documented in the main corpus's embeddings runtime doc, and Hivenectar inherits it without modification.

If embeddings are off (the optional dependency was not installed, or the daemon failed to warm up), the embedding column is left NULL and recall falls back to BM25 over `title` and `description`. This is the same silent-fallback behavior the rest of Honeycomb uses; there is no error, no quality cliff, just lexical-only recall over descriptions until embeddings are available.

---

## Failure modes and observability

| Failure | Behavior |
|---|---|
| LLM returns malformed JSON | Re-try the batch once with a stricter prompt; if still malformed, mark each file `describe_status = 'failed'` and process them solo on the next cycle. |
| LLM returns wrong number of descriptions | Same as malformed — the validator catches length mismatch, retries, then falls back to solo. |
| LLM rate-limits persistently | Portkey backoff handles transient 429s; persistent failure marks the batch `failed` and alerts. |
| LLM call exceeds context window | Should never happen (batcher respects the limit), but if it does, the batch is split in half and retried. |
| Embedding daemon unavailable | Description is written; embedding is NULL; `describe_status = 'described'` (recall falls back to BM25). |
| File deleted while pending | The pending version row is marked `describe_status = 'skipped-deleted'` on the next enricher cycle; no LLM call is made. |

Every enricher cycle logs: files described, files inherited, files failed, tokens consumed, estimated cost. The dashboard surfaces a rolling 24-hour cost counter and a queue-depth gauge. This is the same observability pattern the pollinating loop and skillify miner use.

---

## What the enricher explicitly does not do

- **It does not describe directories.** Folders are derived from file paths in v1; a directory's "description" is synthesized on demand from its files' descriptions.
- **It does not describe symbols.** Symbol-level description is a future possibility that would multiply row counts 10–100×; v1 is file-granular.
- **It does not run on files the CodeGraph is building.** The two workers are independent; they may run concurrently against the same file without coordination, because they write to different tables (`codebase` vs `source_graph_versions`).
- **It does not block recall.** A query during enrichment sees whatever has been described so far. There is no read-lock, no "enrichment in progress" state.
- **It does not re-describe on model swap automatically.** Existing descriptions are valid until proven otherwise. An operator who swaps models and wants to re-describe everything runs `honeycomb hivenectar brood --force --model <new>`, which sets all non-skipped rows back to `pending`.
