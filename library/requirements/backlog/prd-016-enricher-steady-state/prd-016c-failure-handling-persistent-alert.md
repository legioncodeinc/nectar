# PRD-016c: Failure handling and the persistent-failure alert

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S (1-3h)
> **Schema changes:** None

---

## Overview

The enricher's model call can fail — malformed JSON, a wrong-length response, a persistent rate limit, an oversized batch, or a deleted-while-pending file. This sub-PRD owns the failure paths: the retry-once-then-fail-solo ladder that recovers a bad batch, the `describe_status = 'failed'` marking that moves a stuck row out of the pending queue, and the persistent-failure alert that raises a dashboard notification after 5 consecutive failed cycles (default) and halts further enrichment until an operator acknowledges. The goal is graceful degradation: a failing batch never blocks the queue, a transient failure self-heals on the next cycle, and only a genuine persistent outage escalates.

---

## Goals

- A batch that returns malformed JSON or a wrong-length response is retried once with a stricter prompt; if it still fails, each constituent version row is marked `describe_status = 'failed'` and retried solo (smaller batch) on the next cycle.
- A batch that fails all Portkey retries marks its rows `failed` and alerts when the failure persists.
- A batch that exceeds the context window (which should never happen — the batcher respects the limit) is split in half and retried.
- A file deleted while pending has its pending version row marked `describe_status = 'skipped-deleted'` on the next cycle, with no LLM call.
- Persistent failure (default 5 consecutive cycles) raises a dashboard alert and stops further enrichment attempts until an operator acknowledges.
- Every enricher cycle logs files described, files inherited, files failed, tokens consumed, and estimated cost; the dashboard surfaces a rolling 24-hour cost counter and a queue-depth gauge.

## Non-Goals

- The Portkey transport's retry/backoff mechanics. Portkey handles transient 429s/5xx with exponential backoff (PRD-010); the enricher does not implement its own retry logic, avoiding double-retry pathologies. This PRD owns only what happens after Portkey's retries are exhausted.
- The model call happy path (PRD-016b).
- The meaningful-change heuristic (PRD-016a).
- Operator-initiated re-description of `failed` rows. Recovery of a failed row to `pending` is an operator/CLI action; this PRD owns the alerting and the `failed` marking, not the recovery command.

---

## The failure ladder

The enricher respects the model provider's rate limits through Portkey's built-in rate-limit handling. On a 429 or 5xx, Portkey retries with exponential backoff; the enricher does not implement its own retry logic, avoiding double-retry pathologies. A batch that fails all Portkey retries is marked `describe_status = 'failed'` on its constituent version rows and retried on the next enricher cycle with a smaller batch size. Persistent failure (default: 5 consecutive cycles) raises a dashboard alert and stops further enrichment attempts until an operator Acknowledges (`ai/enricher-and-llm-model.md` § Rate limiting).

### `failed` → retry-solo

A `failed` batch is retried on the next cycle at a smaller batch size — ultimately solo (one file per call), which isolates a single bad file from a good batch. A file that fails solo stays `failed` until the persistent-failure threshold trips or an operator intervenes.

---

## The failure-modes table (carried verbatim)

The failure behaviors, carried verbatim from `ai/enricher-and-llm-model.md` § Failure modes and observability:

| Failure | Behavior |
|---|---|
| LLM returns malformed JSON | Re-try the batch once with a stricter prompt; if still malformed, mark each file `describe_status = 'failed'` and process them solo on the next cycle. |
| LLM returns wrong number of descriptions | Same as malformed — the validator catches length mismatch, retries, then falls back to solo. |
| LLM rate-limits persistently | Portkey backoff handles transient 429s; persistent failure marks the batch `failed` and alerts. |
| LLM call exceeds context window | Should never happen (batcher respects the limit), but if it does, the batch is split in half and retried. |
| Embedding provider unavailable | Description is written; embedding is NULL; `describe_status = 'described'` (recall falls back to BM25). |
| File deleted while pending | The pending version row is marked `describe_status = 'skipped-deleted'` on the next enricher cycle; no LLM call is made. |

Note the embedding-provider-unavailable row is NOT a failure: the description is written, the embedding is left NULL, and `describe_status` is `described` with recall falling back to BM25 (`ai/enricher-and-llm-model.md` § Embeddings). The only rows that become `failed` are LLM-output failures the validator catches (malformed JSON, wrong length) and persistent rate limits that exhaust Portkey's backoff.

---

## Per-cycle observability

Every enricher cycle logs: files described, files inherited, files failed, tokens consumed, estimated cost. The dashboard surfaces a rolling 24-hour cost counter and a queue-depth gauge (`ai/enricher-and-llm-model.md` § Failure modes and observability). This is the same observability pattern the pollinating loop and skillify miner use. The observability is surfaced to the dashboard via PRD-008's `/api/source-graph/status` endpoint — no new endpoint.

### The persistent-failure alert

When 5 consecutive cycles (default) fail, the dashboard alert fires and enrichment halts until an operator acknowledges. The alert is the escalation boundary: transient failures self-heal on the next cycle's retry-solo; only a genuine persistent outage (provider down, key revoked, a structural prompt regression) trips the alert and demands human attention. The threshold is configurable (flagged default, see below).

---

## User stories

### US-016c.1 — Retry-solo a malformed batch

**As a** operator, **I want to** a malformed batch retried solo, **so that** one bad file does not poison a good batch.

**Acceptance criteria:**
- AC-016c.1.1 Given a batch returns malformed JSON, then it is retried once with a stricter prompt.
- AC-016c.1.2 Given the retry still fails, then each constituent version row is marked `describe_status = 'failed'` and processed solo on the next cycle.
- AC-016c.1.3 Given a wrong-length response (count mismatch), then the same retry-then-solo path applies.

### US-016c.2 — Split an oversized batch

**As a** operator, **I want to** an oversized batch split and retried, **so that** a context-window overflow never fails the whole batch.

**Acceptance criteria:**
- AC-016c.2.1 Given a batch exceeds the context window (which should never happen), then the batch is split in half and retried.

### US-016c.3 — Skip a deleted-while-pending file

**As a** developer who deleted a file mid-cycle, **I want to** its pending row skipped, **so that** no LLM call is wasted on a deleted file.

**Acceptance criteria:**
- AC-016c.3.1 Given a file is deleted while its version row is pending, then on the next cycle the pending row is marked `describe_status = 'skipped-deleted'` with no LLM call.

### US-016c.4 — Alert on persistent failure

**As a** operator, **I want to** a dashboard alert after 5 consecutive failed cycles, **so that** a genuine outage escalates and enrichment halts until I acknowledge.

**Acceptance criteria:**
- AC-016c.4.1 Given 5 consecutive cycles fail (default), then a dashboard alert is raised.
- AC-016c.4.2 Given the alert is raised, then further enrichment attempts stop until an operator acknowledges.
- AC-016c.4.3 Given a cycle succeeds before the threshold, then the consecutive-failure counter resets to zero.

### US-016c.5 — Log per-cycle observability

**As a** operator, **I want to** per-cycle files-described/inherited/failed, tokens, and cost logged, **so that** the dashboard cost counter and queue-depth gauge stay current.

**Acceptance criteria:**
- AC-016c.5.1 Given any enricher cycle, then it logs files described, files inherited, files failed, tokens consumed, and estimated cost.
- AC-016c.5.2 Given the rolling logs, then the dashboard surfaces a rolling 24-hour cost counter and a queue-depth gauge (via PRD-008's status endpoint).

---

## Implementation notes

- **No double-retry.** Portkey owns transient-429/5xx backoff (PRD-010); the enricher's only retry is the malformed-JSON stricter-prompt retry, which is a *content* retry, not a transport retry. After that, rows go `failed` and the next cycle's retry-solo is a fresh attempt, not a re-retry of the same call (`ai/enricher-and-llm-model.md` § Rate limiting).
- **`failed` rows stay queryable.** A `failed` row is not deleted; it stays in the version chain with `describe_status = 'failed'` so the operator can see what failed and why. Recovery to `pending` is an operator action, not automatic.
- **The alert is cycle-counted, not time-counted.** "5 consecutive cycles" means 5 cycles that ran and failed, not 5 wall-clock intervals. A cycle that finds no pending rows (idle) does not count as a failure and does not reset the counter (it neither increments nor resets).
- **Embedding-unavailable is not a failure.** The failure-modes table marks it `described` with a NULL embedding (BM25 fallback), not `failed`; do not wire it into the persistent-failure counter.
- **`skipped-deleted` is terminal.** A deleted-while-pending row is `skipped-deleted`, not retried — the file is gone, so describing it would be wasted. This is distinct from `failed` (which is retried solo).
- **Observability reuses the existing pattern.** Per-cycle logging + the rolling cost counter/queue-depth gauge mirror the pollinating loop and skillify miner (`ai/enricher-and-llm-model.md` § Failure modes and observability); no new observability framework.

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Persistent-failure alert threshold: 5 consecutive failed cycles (`ai/enricher-and-llm-model.md` § Rate limiting — "default: 5 consecutive cycles"). From corpus, confirm.

---

## Related

- [`./prd-016-enricher-steady-state-index.md`](./prd-016-enricher-steady-state-index.md)
- [`./prd-016a-queue-poll-debounce-meaningful-change.md`](./prd-016a-queue-poll-debounce-meaningful-change.md) — the cycle that produces these failures.
- [`./prd-016b-model-call-and-describe-model-audit.md`](./prd-016b-model-call-and-describe-model-audit.md) — the happy path whose failures this PRD catches.
- [`../../in-work/prd-010-portkey-gateway/`](../../in-work/prd-010-portkey-gateway/) — Portkey's transient-429/5xx backoff (PRD-010), which precedes the enricher's `failed` marking.
- [`../prd-008-hivenectar-api-endpoints/`](../prd-008-hivenectar-api-endpoints/) — the `/api/source-graph/status` endpoint surfacing the cost counter + queue-depth gauge (referenced by MASTER-PRD-INDEX.md PRD-008).
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — AUTHORITATIVE: the verbatim failure-modes table, the persistent-failure "5 consecutive cycles" default, and the per-cycle observability contract.
- `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts:236-260` — the route → run → complete/fail harness shape the enricher's failure routing mirrors (handler throws → `queue.fail`).
