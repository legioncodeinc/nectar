# PRD-018f: Brooding batch-call robustness

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (1-2d)
> **Schema changes:** None

---

## Overview

The brooding pipeline's economics rest on batching 30-50 small files per LLM call. The 2026-07-02 brooding review found two defects in how a batch call fails and how its response is attributed. First, a whole-call transport failure (gateway down, 429, timeout) marks every target in the batch failed and the pipeline then retries each one solo, so one rate-limited call on a 2000-file repo fans out into thousands of doomed requests, and the default `max_tokens=4096` sits at or below the corpus's own 2-4K estimate for a full batch's output, making JSON truncation (and the same solo storm) a predictable steady-state event rather than an anomaly (NEC-013, review finding H3). Second, the batch parser's positional fallback can silently attach one file's title, description, and concepts to another file when the model omits or reorders an entry, persisting a permanently wrong search index with no error anywhere (NEC-014, finding H4); the spec's required array-length validation is missing.

Both defects directly attack mission leg 1 ("analyze an entire code base using the brooding process"): the first multiplies cost and worsens the very rate limiting that triggered it, the second corrupts the recall index that legs 2 and 3 depend on.

---

## Goals

- A transport-level batch failure marks the batch's rows `failed` (re-enqueueable by the next run or the enricher) instead of fanning out into per-file solo retries.
- Batch calls request an output budget sized from the batch's file count instead of inheriting `PORTKEY_DEFAULT_MAX_TOKENS = 4096`.
- The transport surfaces `finish_reason`, and the pipeline split-retries a truncated batch by halving instead of failing it wholesale.
- The per-attempt timeout accommodates a realistic batch completion (roughly 20K input tokens, multi-K output tokens).
- The positional parse fallback applies only when `entries.length === targets.length`; any other unmatched shape is treated as malformed and takes the spec's solo retry path.

## Non-Goals

- When and how described/failed rows are persisted (per-batch durability) belongs to [PRD-018e](./prd-018e-brooding-durability-and-scale.md) (NEC-003).
- The enricher's own batch describe path and its index misalignment (NEC-015) belong to [PRD-018g](./prd-018g-enricher-correctness-and-concurrency.md); this sub-PRD touches only the brooding describe path in `src/brooding/describe.ts` and the shared Portkey transport.
- Portkey credential gating and first-run configuration (NEC-023) belong to PRD-018k.

---

## NEC-013: Batch describe failure becomes a solo retry storm; `max_tokens` default truncates full batches

**Issue.** Three compounding behaviors turn a single failed batch call into an amplification event: whole-call failures fan out to solo retries, the default output-token cap invites truncation of full batches, and truncation is indistinguishable from garbage because `finish_reason` is never read.

**Evidence** (brooding review H3):

- A whole-call transport error marks every target failed (`src/brooding/describe.ts:159-163`), and the pipeline then retries each failed nectar solo (`pipeline.ts:447-459`; async `pipeline-async.ts:334-346`). The spec reserves the solo retry for malformed entries (`brooding-technical-specification.md:84`), not whole-call failures. With Portkey down or rate-limiting, a 2000-file repo's 38 batches become 38 x (3 batch attempts + up to 50 solo calls x 3 attempts each), roughly thousands of doomed requests; under a 429 the solo storm makes the rate limiting worse.
- Batch calls set no `maxTokens`, so `PORTKEY_DEFAULT_MAX_TOKENS = 4096` applies (`src/portkey/transport.ts:18`, applied at `transport.ts:163`). The corpus estimates batch output at 2-4K tokens (`brooding-technical-specification.md:65`): a full 50-file batch sits at or above the cap, the JSON array truncates mid-stream, `extractJson` finds no closing `]` (`describe.ts:98-119`), the whole batch is marked failed, and all ~50 files re-run solo.
- `finish_reason` is never inspected (`transport.ts:121-143`), so truncation is indistinguishable from garbage.
- The 15s per-attempt timeout (`transport.ts:34`) is tight for a ~20K-token-input / multi-K-token-output batch completion and can produce the same systematic all-failed then solo-storm path.

**Failure mode.** One gateway outage or rate-limit window multiplies request volume by orders of magnitude against an already-limiting upstream; a healthy gateway still truncates full batches at the default cap, paying for the input tokens and then discarding the output.

**Fix direction.** Distinguish failure classes in the pipeline's retry policy: on a transport-level batch failure, mark the batch's rows `failed` and move on (they re-enqueue on the next run or via the enricher); reserve the solo path for malformed entries per the spec. Size `max_tokens` from the batch's file count so a full batch's output fits with headroom. Surface `finish_reason` from the transport; when it indicates truncation, split the batch in half and retry the halves rather than failing or soloing. Raise the per-attempt timeout for batch calls to a value that accommodates the expected completion size.

---

## NEC-014: Positional batch-parse fallback can attach the wrong description

**Issue.** When the model's response entries lack echoed `nectar` fields, the parser falls back to positional alignment with no array-length validation, so an omitted or reordered entry shifts descriptions onto the wrong files.

**Evidence** (brooding review H4):

- `describeBatchGroup` matches entries by `nectar` but falls back to positional `entries[i]` (`describe.ts:180-185`). If the model returns entries without echoed `nectar` fields and omits or reorders one entry, file i receives file j's title/description/concepts and is persisted as `described`: permanently wrong search index content, undetectable downstream.
- The tech spec requires: "The validator checks both the per-entry structure and the array length: a response with the wrong number of entries is treated as malformed" (`brooding-technical-specification.md:84`). No length check exists.
- The existing malformed-entry test (`test/brooding.test.ts:323-333`) uses nectar-keyed entries only, so the positional path is untested against wrong-length responses.

**Failure mode.** A single dropped entry in a 50-file batch poisons up to 49 stored descriptions in one call; recall then serves wrong answers for those files indefinitely, with `describe_status = 'described'` masking the corruption.

**Fix direction.** Apply the positional fallback only when `entries.length === targets.length`; otherwise treat unmatched (no-nectar) entries as malformed and route those targets to the solo retry path. Optionally sanity-check that a positionally matched entry's path-like fields do not contradict the target.

---

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| AC-018f.1 | Given a batch describe call that fails at the transport level (throw, 429, timeout), when the pipeline handles the failure, then every target in that batch is marked `failed` and no solo describe calls are issued for them in the same run. |
| AC-018f.2 | Given a batch of k files, when the describe request is built, then its `max_tokens` is derived from k (not the 4096 default) with enough headroom that a full 50-file batch's expected 2-4K token output fits. |
| AC-018f.3 | Given a batch response whose `finish_reason` indicates output truncation, when the pipeline handles it, then the batch is split in half and each half is retried as a batch; targets are neither wholesale-failed nor soloed on the first truncation. |
| AC-018f.4 | Given a batch call, when the request is issued, then its per-attempt timeout is the raised batch-call value, and solo calls retain their existing timeout. |
| AC-018f.5 | Given a batch response with entries lacking `nectar` fields and `entries.length !== targets.length`, when the parser runs, then no positional assignment occurs; unmatched targets are classified malformed and take the solo retry path. |
| AC-018f.6 | Given a batch response with entries lacking `nectar` fields and `entries.length === targets.length`, when the parser runs, then positional assignment proceeds as today (fallback preserved for the well-formed case). |

---

## Files touched

| File | Change kind | What changes |
|---|---|---|
| `src/brooding/describe.ts` | modify | Failure-class distinction on whole-call errors (`:159-163`); length-gated positional fallback (`:180-185`); truncation-aware batch outcome so the pipeline can split-retry. |
| `src/brooding/pipeline.ts` | modify | Retry policy: transport-failed batches mark rows `failed` instead of entering the solo loop (`:447-459`); halving split-retry on truncation. |
| `src/brooding/pipeline-async.ts` | modify | Same retry-policy change for the async variant (`:334-346`). |
| `src/portkey/transport.ts` | modify | Expose `finish_reason` in the completion result (`:121-143`); accept per-call `maxTokens` for batch sizing (default applied at `:163`); raised batch-call timeout (base at `:34`). |
| `test/brooding.test.ts` | modify | New failure-class, truncation split-retry, and wrong-length positional tests. |
| `test/portkey-gateway.test.ts` | modify | `finish_reason` surfacing, per-call `maxTokens` passthrough, and batch timeout coverage at the transport layer. |

---

## Tests to add

The brooding review's coverage notes explicitly list transport-failure and truncated-batch fan-out (H3) and positional-fallback misattribution with a wrong-length response (H4) as untested in `test/brooding.test.ts`.

| AC | Test file | Scenario |
|---|---|---|
| AC-018f.1 | `test/brooding.test.ts` | Transport that rejects the batch call; assert all batch targets end `failed` and the recorded call log contains zero solo describe calls for them. |
| AC-018f.2 | `test/brooding.test.ts` | Spy on the describe request options; a 50-file batch requests a `max_tokens` derived from file count, above the 4096 default. |
| AC-018f.3 | `test/brooding.test.ts` | Transport returns a truncated body with a truncation `finish_reason`; assert the pipeline reissues two half-batches and succeeds without solo calls. |
| AC-018f.4 | `test/portkey-gateway.test.ts` | Batch-call request uses the raised timeout; solo-call request keeps the existing one. |
| AC-018f.5 | `test/brooding.test.ts` | Response with unkeyed entries, length off by one; assert no target receives another file's description and the short set routes to solo retry (closes the gap left by the nectar-keyed-only test at `:323-333`). |
| AC-018f.6 | `test/brooding.test.ts` | Response with unkeyed entries, correct length; assert positional assignment matches each target to its own entry. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-013, NEC-014)
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) (findings H3, H4 and the coverage notes)
- [`../../../knowledge/private/ai/brooding-deep-dive/brooding-technical-specification.md`](../../../knowledge/private/ai/brooding-deep-dive/brooding-technical-specification.md) (solo-retry scope and array-length validation at `:84`; batch output estimate at `:65`)
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) (batching model and cost math)
- [`./prd-018e-brooding-durability-and-scale.md`](./prd-018e-brooding-durability-and-scale.md) (adjacent: per-batch persistence of the failed rows this sub-PRD produces)
- [`./prd-018g-enricher-correctness-and-concurrency.md`](./prd-018g-enricher-correctness-and-concurrency.md) (adjacent: the enricher describe path)
