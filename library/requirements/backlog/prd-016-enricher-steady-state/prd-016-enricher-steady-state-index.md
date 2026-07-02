# PRD-016: Enricher steady-state loop + meaningful-change heuristic

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None (operates on the existing `hive_graph_versions` rows owned by PRD-005)

---

## Overview

Brooding describes every file once. The enricher is everything after: the steady-state description-maintenance loop that re-describes a file when its content meaningfully changes, describes a file that was minted but skipped during brooding (cost cap or `--limit`), and describes genuinely new files the watcher detected. It runs as a background loop inside the hiveantennae daemon, polling a work queue of `hive_graph_versions` rows where `describe_status = 'pending'` on a 30s interval, coalescing rapid-fire edits via the 500ms watcher intake debounce, applying a meaningful-change heuristic (Jaccard ≥ 0.85 = cosmetic → inherit), calling the model via Portkey, embedding, and updating `describe_status` — with a `failed` → retry-solo path and a persistent-failure alert. This PRD owns the loop's three concerns: the queue poll + debounce + heuristic, the model call + `describe_model` audit, and the failure handling + alert. **This index covers the module scope.** Sub-feature PRDs cover each concern separately.

---

## Goals

- The enricher polls the pending queue (`describe_status = 'pending'`) on a 30s interval and processes it in batches, selecting the latest pending version per nectar so intermediate saves within a cycle are never described.
- The watcher intake debounces raw `(eventType, filename)` events per-path on a 500ms window before they enter re-association, so a developer hitting Cmd-S ten times in ten seconds triggers one enricher signal, not ten.
- The meaningful-change heuristic classifies a content delta: Jaccard ≥ `REDESCRIBE_THRESHOLD` (default 0.85) is cosmetic → inherit the prior description with `describe_model = inherited-from:<prev_content_hash>`; below the threshold is meaningful → enter the pending queue.
- Each enricher model call routes through Portkey (`/v1/chat/completions`) and stamps the producing model on the `describe_model` column; cosmetic inheritance stamps `inherited-from:<prev_content_hash>`.
- A failed batch marks its version rows `describe_status = 'failed'` and retries them solo on the next cycle; persistent failure (default 5 consecutive cycles) raises a dashboard alert and stops further enrichment until an operator acknowledges.
- An enricher cycle that wrote one or more new descriptions invokes PRD-011's projection rewrite (trigger #2): the debounced projection writer regenerates `.honeycomb/nectars.json` so the committed projection tracks the newly-described versions (PRD-011 AC-2). A cycle that wrote nothing new skips the trigger.

## Non-Goals

- Brooding. Brooding is the one-time bootstrap owned by PRD-007; the enricher is everything after.
- The Portkey transport mechanics. PRD-010 owns `buildPortkeyHeaders` + `PORTKEY_BASE_URL` + the `/v1/chat/completions` call; this PRD consumes that transport.
- The embeddings provider switch. PRD-014 owns local nomic vs Cohere-via-Portkey; this PRD consumes the configured provider for the 768-dim embedding over `title + ' ' + description`.
- Re-describing directories or symbols. v1 is file-granular (a corpus-deliberate spec gap; `ai/enricher-and-llm-model.md` § What the enricher explicitly does not do).
- Automatic re-description on a model swap. Existing descriptions stay valid until the operator runs `brood --force --model <new>` (PRD-007 / PRD-010b).
- The re-association ladder itself. The ladder is owned by PRD-006; the enricher consumes the version rows re-association appends.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-016a-queue-poll-debounce-meaningful-change`](./prd-016a-queue-poll-debounce-meaningful-change.md) | 30s queue poll; 500ms watcher intake debounce; the meaningful-change heuristic (Jaccard ≥ 0.85 → inherit) | Draft |
| [`prd-016b-model-call-and-describe-model-audit`](./prd-016b-model-call-and-describe-model-audit.md) | The Portkey model call (mechanics in PRD-010) + the `describe_model` audit column | Draft |
| [`prd-016c-failure-handling-persistent-alert`](./prd-016c-failure-handling-persistent-alert.md) | `failed` → retry-solo; the 5-cycle persistent-failure alert; per-cycle observability | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `hive_graph_versions` rows with `describe_status = 'pending'`, when the enricher cycle runs, then it selects the latest pending version per nectar (grouped by nectar, ordered by `MIN(observed_at)`) scoped to the project. |
| AC-2 | Given multiple `(eventType, filename)` events on the same path within the 500ms window, then they collapse to a single "the file at this path changed" signal entering re-association. |
| AC-3 | Given a new version row whose token Jaccard similarity to the prior version is ≥ 0.85, then the change is deemed cosmetic: the new row inherits the prior `title`/`description`/`concepts`/`embedding` and `describe_model = inherited-from:<prev_content_hash>`, with no LLM call. |
| AC-4 | Given a new version row whose token Jaccard similarity to the prior version is < 0.85, then the change is deemed meaningful and the row enters the pending queue. |
| AC-5 | Given a description produced by an enricher model call, then `describe_model` records the producing model id. |
| AC-6 | Given a batch fails all Portkey retries, then its version rows are marked `describe_status = 'failed'` and retried solo (smaller batch) on the next cycle. |
| AC-7 | Given 5 consecutive failed cycles (default), then a dashboard alert is raised and further enrichment stops until an operator acknowledges. |

---

## Data model changes

None at the table level. The enricher operates on the existing `hive_graph_versions` rows owned by PRD-005 (`data/hive-graph-schema.md`), reading and updating `describe_status`, `describe_model`, `title`, `description`, `concepts`, and the embedding column. The `describe_status` lifecycle values it exercises — `pending`, `described`, `failed`, `skipped-deleted` — are defined by PRD-005's schema.

---

## API changes

None at the endpoint level. The enricher is an internal background loop. Its per-cycle observability (files described, files inherited, files failed, tokens consumed, estimated cost; a rolling 24-hour cost counter and a queue-depth gauge) is surfaced to the dashboard via PRD-008's `/api/hive-graph/status` endpoint, not a new endpoint of its own.

---

## Flagged defaults

All four enricher cadence/threshold values are carried from the corpus (`ai/enricher-and-llm-model.md`) and flagged for confirmation:
- **[DEFAULT — confirm before implementation]** Enricher poll interval: 30s (`ai/enricher-and-llm-model.md` § Debouncing and rate limiting — "default 30 seconds"). From corpus, confirm.
- **[DEFAULT — confirm before implementation]** Watcher intake debounce: 500ms. The corpus (`ai/enricher-and-llm-model.md` § Watcher intake debounce) specifies the mechanism but leaves the window value unspecified; the 500ms figure mirrors Honeycomb's `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (`fs.watch` + `setTimeout` pattern, DECISION #4). Mirrored default, confirm.
- **[DEFAULT — confirm before implementation]** `REDESCRIBE_THRESHOLD`: 0.85 — cosmetic-change inheritance threshold (`ai/enricher-and-llm-model.md` § The "meaningful change" heuristic — "default 0.85"). From corpus, confirm.
- **[DEFAULT — confirm before implementation]** Persistent-failure alert: 5 consecutive failed cycles (`ai/enricher-and-llm-model.md` § Rate limiting — "default: 5 consecutive cycles"). From corpus, confirm.

---

## Related

- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — PRD-016 entry; DECISION #4 (`node:fs.watch` watcher, not chokidar).
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — AUTHORITATIVE: the enricher contract, the two debounce layers, the meaningful-change heuristic, rate limiting, failure modes, and the 30s/500ms/0.85/5 values.
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — brooding is the bootstrap the enricher follows.
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) — the `hive_graph_versions` rows + `describe_status` lifecycle the enricher drives.
- [`../../in-work/prd-011-portable-projection/prd-011-portable-projection-index.md`](../../in-work/prd-011-portable-projection/prd-011-portable-projection-index.md) — the projection whose trigger #2 (end of an enricher cycle that wrote new descriptions) this loop invokes; co-dependent per the dependency map.
- `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts` — the lease → route → run → complete/fail worker harness the loop mirrors.
- `honeycomb/src/daemon/runtime/services/poll-loop.ts` — the adaptive poll loop the cadence mirrors.
