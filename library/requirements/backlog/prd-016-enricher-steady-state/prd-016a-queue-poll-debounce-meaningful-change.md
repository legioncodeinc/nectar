# PRD-016a: Queue poll, debounce, and the meaningful-change heuristic

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

The enricher is the steady-state description-maintenance loop: it polls a work queue of `source_graph_versions` rows where `describe_status = 'pending'`, processes them in batches, and either re-describes a file or inherits its prior description. This sub-PRD owns the three intake/coalescing mechanisms that make the loop change-lazy rather than eager: the 30s queue poll that selects the latest pending version per nectar, the 500ms watcher intake debounce that collapses rapid-fire saves, and the meaningful-change heuristic (Jaccard ≥ `REDESCRIBE_THRESHOLD`) that decides whether a content delta is cosmetic (inherit, no LLM call) or meaningful (queue for description). Together they ensure a developer hitting Cmd-S ten times in ten seconds triggers one enricher signal describing the latest content, not ten calls.

---

## Goals

- The enricher polls the pending queue on a 30s interval (default) and processes it in batches, selecting only the latest pending version per nectar so intermediate saves within a cycle are never described.
- The watcher intake debounces raw `(eventType, filename)` events per-path on a 500ms window (default) so multiple uncorrelated observations on the same path collapse to a single changed-file signal entering re-association.
- The meaningful-change heuristic tokenizes both versions and computes a Jaccard similarity over the token multisets; similarity ≥ `REDESCRIBE_THRESHOLD` (default 0.85) inherits the prior description with `describe_model = inherited-from:<prev_content_hash>` and no LLM call; below the threshold the row enters the pending queue.

## Non-Goals

- The Portkey model call mechanics (PRD-016b, PRD-010).
- Failure handling and the persistent-failure alert (PRD-016c).
- The re-association ladder itself (PRD-006). The watcher intake feeds re-association; this PRD owns only the per-path debounce that precedes it.
- The embeddings computation. PRD-014/PRD-016b own the 768-dim embedding over `title + ' ' + description`.

---

## The 30s queue poll

The enricher runs as a background loop inside the hiveantennae daemon, polling a work queue of `source_graph_versions` rows where `describe_status = 'pending'`. After re-association appends a new version row, the enricher does not immediately describe it — the row sits in the queue pending. The loop runs on a configurable interval (default 30 seconds) and processes the queue in batches, which naturally coalesces rapid-fire edits to the same file: if a file was edited five times in a minute, only the most recent version row (the latest content) is worth describing, and the enricher skips the intermediate versions by selecting only `MAX(seq) per nectar WHERE describe_status = 'pending'` (`ai/enricher-and-llm-model.md` § Enricher queue debounce).

The pending-work query, carried verbatim from `ai/enricher-and-llm-model.md` § Enricher queue debounce (simplified; the real query is `sqlStr`-guarded per the codebase convention):

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

This "latest pending version per nectar" semantics means intermediate saves within an enricher cycle are never described — their version rows remain in the chain as history, but their descriptions stay NULL forever, which is correct (nobody will ever recall a stale intermediate state) (`ai/enricher-and-llm-model.md` § Enricher queue debounce).

### Poll-loop cadence

The loop cadence mirrors the adaptive poll loop in `honeycomb/src/daemon/runtime/services/poll-loop.ts:1-227` — a `tick → skip-if-in-flight → run one lease pass → schedule next tick` shape with an injected `setTimer`/`clearTimer` seam and an overlap guard (a slow run never overlaps the next). The enricher's default cadence is the flat 30s interval; the adaptive-backoff path (idle → slow, lease → fast) is the same optional `PollBackoffConfig` the stage worker exposes. The default poll interval on the stage worker is 1s (`stage-worker.ts:171`, `DEFAULT_POLL_INTERVAL_MS = 1_000`); the enricher overrides it to 30s.

---

## The 500ms watcher intake debounce

The watcher fires events on every save. A developer hitting Cmd-S ten times in ten seconds must not trigger ten enricher calls (or even ten re-association ladders). Hivenectar applies the watcher intake debounce as the first layer: the `node:fs.watch` intake debounces events per-path with a configurable window (default 500ms). Multiple uncorrelated `(eventType, filename)` observations on the same path within the window collapse to a single "the file at this path changed" signal, which then enters re-association (`ai/enricher-and-llm-model.md` § Watcher intake debounce).

This mirrors Honeycomb's existing `fs.watch` + `setTimeout`/`clearTimeout` debounce pattern (DECISION #4 — `node:fs.watch`, not chokidar; `MASTER-PRD-INDEX.md` decision #4) and avoids adding another watcher dependency. The watcher intake is the first of two debounce layers; the 30s queue poll is the second.

---

## The meaningful-change heuristic

Not every content change warrants a re-description. A developer who reformats a file (Prettier, gofmt, rustfmt) has not changed its meaning, and re-describing it wastes LLM calls and produces an artificially-churned description (the LLM phrases the new description slightly differently even for identical semantic content, which pollutes the version chain) (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic).

Hivenectar applies a fast pre-LLM diff to decide whether to re-describe, carried verbatim from `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic:

1. **Tokenize both versions** with a lightweight, language-aware tokenizer (the same one the structural CodeGraph uses for its parse-error reporting — not a full AST, just a token stream).
2. **Compute a Jaccard similarity** over the token multisets.
3. **If similarity ≥ `REDESCRIBE_THRESHOLD`** (default 0.85), the change is deemed cosmetic. The new version row inherits the previous version's `title`, `description`, `concepts`, and `embedding`, and `describe_status` is set to `described` with a `describe_model` marker of `inherited-from:<prev_content_hash>`.
4. **If similarity < threshold**, the change is deemed meaningful and the new version row enters the pending queue.

This is the same intuition Smith uses (`Hash != Described-Against-Hash` triggers re-description; equality skips it), adapted to token similarity rather than raw hash equality so that a reformat (which changes the hash but not the tokens meaningfully) does not trigger re-description. The threshold is configurable and tunable per-repo via `~/.honeycomb/hivenectar.json` (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic).

### Why token similarity, not raw hash equality

A reformat changes the content hash (so raw-hash equality would trigger a wasteful re-description) but does not change the tokens meaningfully. The Jaccard-over-token-multisets comparison absorbs the cosmetic change: the token sets are nearly identical, the similarity clears the 0.85 threshold, and the prior description is inherited with no LLM call.

---

## User stories

### US-016a.1 — Poll the queue every 30s and process in batches

**As a** operator, **I want to** the enricher to poll the pending queue on a 30s interval, **so that** rapid-fire edits coalesce into one batch rather than ten eager calls.

**Acceptance criteria:**
- AC-016a.1.1 Given pending rows exist, when the 30s cycle fires, then the pending-work query selects `MAX(seq) per nectar WHERE describe_status = 'pending'`, scoped to the project, ordered by `MIN(observed_at)`.
- AC-016a.1.2 Given a file edited five times within one cycle, then only its latest pending version row is selected; the intermediate pending rows stay NULL forever.

### US-016a.2 — Debounce watcher intake per-path on a 500ms window

**As a** developer hitting Cmd-S rapidly, **I want to** my repeated saves collapsed to one signal, **so that** the enricher does not re-associate or describe on every save.

**Acceptance criteria:**
- AC-016a.2.1 Given multiple `(eventType, filename)` events on the same path within the 500ms window, then they collapse to a single changed-file signal entering re-association.
- AC-016a.2.2 Given events on different paths, then each path is debounced independently.

### US-016a.3 — Inherit on a cosmetic change (Jaccard ≥ 0.85)

**As a** developer who reformatted a file, **I want to** my reformat to inherit the prior description, **so that** no LLM call is wasted and the version chain is not polluted with churn.

**Acceptance criteria:**
- AC-016a.3.1 Given a new version row whose token Jaccard similarity to the prior version is ≥ `REDESCRIBE_THRESHOLD` (default 0.85), then the new row inherits the prior `title`, `description`, `concepts`, and `embedding`.
- AC-016a.3.2 Given a cosmetic inheritance, then `describe_status = 'described'` and `describe_model = inherited-from:<prev_content_hash>`, with no LLM call made.

### US-016a.4 — Queue on a meaningful change (Jaccard < 0.85)

**As a** developer who changed a file's meaning, **I want to** the change to enter the pending queue, **so that** the file is re-described with the new content.

**Acceptance criteria:**
- AC-016a.4.1 Given a new version row whose token Jaccard similarity to the prior version is < `REDESCRIBE_THRESHOLD` (default 0.85), then the change is deemed meaningful.
- AC-016a.4.2 Given a meaningful change, then the row enters the pending queue with `describe_status = 'pending'` for the next cycle.

---

## Implementation notes

- **Two debounce layers, in order.** Watcher intake (500ms, per-path) → re-association (PRD-006) appends a version row → queue poll (30s) selects latest-pending-per-nectar → heuristic (0.85) decides inherit vs. queue → (PRD-016b) model call. The intake debounce precedes re-association; the queue poll precedes the heuristic.
- **Heuristic runs before the LLM call.** The token similarity check is a fast pre-LLM gate; a cosmetic change never reaches the Portkey transport (PRD-010). The tokenizer is the same lightweight language-aware stream the CodeGraph uses for parse-error reporting (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic), not a full AST.
- **Inheritance copies the embedding.** A cosmetic change inherits the prior `embedding` as well as `title`/`description`/`concepts` — the content (and thus the regenerated embedding) has not meaningfully changed, so re-embedding would be wasteful (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic).
- **`sqlStr`-guarded query.** The pending-work query above is simplified for the PRD; the real query uses the codebase's `sqlStr` guard convention (mirrors Honeycomb's recall arm SQL builders).
- **Poll loop reuses `buildWorkerPollLoop`.** The cadence plumbing (injected timers, overlap guard, optional adaptive backoff) is the shared `buildWorkerPollLoop` from `poll-loop.ts:192-227`; the enricher passes `flatIntervalMs = 30_000` and its own `tick`. Timers are `.unref()`-ed (`poll-loop.ts:198-213`) so a background poll never keeps the process alive.

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Enricher poll interval: 30s (`ai/enricher-and-llm-model.md` § Enricher queue debounce — "default 30 seconds"). From corpus, confirm.
- **[DEFAULT — confirm before implementation]** Watcher intake debounce: 500ms. The corpus (`ai/enricher-and-llm-model.md` § Watcher intake debounce) specifies the mechanism but leaves the window value unspecified; the 500ms figure mirrors Honeycomb's `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (`fs.watch` + `setTimeout` pattern, DECISION #4). Mirrored default, confirm.
- **[DEFAULT — confirm before implementation]** `REDESCRIBE_THRESHOLD`: 0.85 (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic — "default 0.85"; configurable per-repo via `~/.honeycomb/hivenectar.json`). From corpus, confirm.

---

## Related

- [`./prd-016-enricher-steady-state-index.md`](./prd-016-enricher-steady-state-index.md)
- [`./prd-016b-model-call-and-describe-model-audit.md`](./prd-016b-model-call-and-describe-model-audit.md) — the model call this heuristic gates.
- [`./prd-016c-failure-handling-persistent-alert.md`](./prd-016c-failure-handling-persistent-alert.md) — what happens when the model call fails.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — AUTHORITATIVE: the two debounce layers, the verbatim heuristic, the verbatim pending-work query.
- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — DECISION #4 (`node:fs.watch`, not chokidar).
- `honeycomb/src/daemon/runtime/services/poll-loop.ts:1-227` — the adaptive poll loop (`buildWorkerPollLoop`) the cadence mirrors.
- `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts:171, 210-217` — the worker harness + `DEFAULT_POLL_INTERVAL_MS` the enricher overrides to 30s.
- [`../../completed/prd-006-file-registration-protocol/`](../../completed/prd-006-file-registration-protocol/) — the re-association ladder the debounced intake feeds.
