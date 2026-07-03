# PRD-018e: Brooding durability and scale

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

Brooding is mission leg 1: "analyze an entire code base using the brooding process." The 2026-07-02 brooding review found that the pipeline runs end to end and closely tracks the corpus on constants, prompts, bucketing, and cost math, but drifts from the spec on the one property the spec calls load-bearing: incremental persistence. Descriptions accumulate in memory across the entire describe+embed stage and persist only in Stage 6, so a mid-run kill loses all paid LLM work (NEC-003, review finding C1). Around that core defect sit two scale and correctness problems: `prepareFiles` reads and retains the full bytes of every discovered file for the whole run, including known-binary and oversize files that will never be described, an OOM risk on monorepos (NEC-012, finding H2); and the resume classifier keys on `describeStatus` alone, so a re-run of `brood` never refreshes a file whose content changed while the daemon was off (NEC-038, finding M2).

Together these three issues mean a large real-world brood is fragile in exactly the hours-long phase where fragility is most expensive, and a repaired re-run cannot fix a stale index. This sub-PRD makes the pipeline honor its own committed-write-before-next-file contract, bounds memory to the working chunk, and lets an explicit re-brood repair changed files.

---

## Goals

- Persist described and failed rows incrementally inside the Stage-4 describe loops of both `src/brooding/pipeline.ts` and `src/brooding/pipeline-async.ts`, per batch group (or per file), so a killed brood retains every description already paid for.
- Bound brooding memory: never read files that bucketing will exclude without content, hash without retaining full bytes, and release buffers as chunks are persisted.
- Make the resume classifier re-enqueue a path whose latest stored `contentHash` differs from the prepared file's hash, even when the latest status is `described`.

## Non-Goals

- Batch-call failure handling: the solo-retry storm, `max_tokens` sizing, `finish_reason` inspection, and the batch timeout belong to [PRD-018f](./prd-018f-brooding-batch-call-robustness.md) (NEC-013, NEC-014).
- The brood/enricher concurrency mutex, the auto-brood in-flight guard, and atomic `nextSeq` belong to [PRD-018g](./prd-018g-enricher-correctness-and-concurrency.md) (NEC-011).
- Duplicate-content projection inherit and its duplicate seq-0 rows (NEC-037) belong to PRD-018i.
- Dry-run cost math and actual-usage accounting (brooding review finding M4) are not part of any NEC issue in scope here and are deliberately excluded.
- Ignore-rule parity between discovery and watching (NEC-007, NEC-039) belongs to PRD-018c.

---

## NEC-003: Brooding loses all paid LLM work on mid-run kill

**Issue.** Descriptions accumulate in memory and persist only in Stage 6 after the entire describe+embed stage completes, contradicting the spec's committed-write-before-next-file resumability contract. This is the single Critical finding of the brooding review (C1) and the reason this sub-PRD is P0.

**Evidence** (brooding review C1):

- `src/brooding/pipeline.ts:434` (`describedByNectar` map), filled across the batch loop `pipeline.ts:439-460` and the solo loop `pipeline.ts:462-470`; embed at `pipeline.ts:472-478`; first persist of any described row at `pipeline.ts:480-499` (failed rows at `pipeline.ts:501-511`).
- Identical structure in the async pipeline: `src/brooding/pipeline-async.ts:321-357` (accumulate), `pipeline-async.ts:367-387` (persist).
- Spec contradiction: the tech spec states "Each [stage] produces a committed Deep Lake write before the next begins, which is what makes the pipeline resumable at every boundary" (`brooding-technical-specification.md:40`) and "Every write is committed before the next file is processed" (`brooding-technical-specification.md:105`, restated at `:152`); `brooding-pipeline.md:126` says "Every nectar mint and every description write is a committed Deep Lake write, not an in-memory accumulation."
- The module's own header (`pipeline.ts:15-17`) repeats the spec's claim; the code does the opposite for descriptions.
- A throwing embed provider would likewise reject `runBrood` after all spend and before any persist: the `EmbedProvider` contract says never-rejects (`src/embeddings/provider.ts:44-52`), but a third-party implementation can violate it.

**Failure mode.** The describe stage is the hours-long, most fragile phase of a large brood (network, rate limits, laptop lid). Kill the process at 95% through Stage 4/5 and zero described rows exist; every file is still `pending`, so the next run re-describes everything and the full LLM cost is paid twice. Resumability currently protects only against crashes between stages, not within the one stage that matters.

**Fix direction.** Persist each batch group's described and failed rows (and each solo result) immediately after the call returns, inside the Stage-4 loops of both pipelines. For embeddings, either embed per chunk before that chunk's persist, or persist descriptions first and backfill embeddings afterward, matching the spec's `writeRows → embed` order. Keep the final projection regeneration where it is (end of run). Guard against a throwing embed provider so that already-persisted description rows survive an embed-stage rejection.

---

## NEC-012: Whole-tree memory residency during brooding

**Issue.** `prepareFiles` reads and retains the full bytes of every discovered file for the duration of the run, including known-binary and >256KB files that need no read at all.

**Evidence** (brooding review H2):

- `prepareFile` reads full content and keeps it on `PreparedFile.bytes` (`src/brooding/precheck.ts:56-72`); `prepareFiles` does this for the whole tree (`precheck.ts:75-82`).
- Those `PreparedFile` objects stay referenced through bucketing (`pipeline.ts:429-432`), `nectarByPrepared` (`pipeline.ts:400`), and `describedByNectar` (`pipeline.ts:434`) until Stage 6 completes.
- `classifyBucket` skips known-binary extensions without any content dependence (`src/brooding/bucketing.ts:41-42`), yet `prepareFile` has already read the entire file: a git-tracked 2GB `.mp4` is fully buffered just to sha256 it. Skip-too-large files (>256KB) are likewise fully read and retained.

**Failure mode.** Brooding a large monorepo (the spec's own 100K-file scaling case, `brooding-pipeline.md:120`) holds roughly the whole tree's bytes resident simultaneously; a handful of big tracked assets can OOM the daemon.

**Fix direction.** Short-circuit known-binary extensions before reading any content. Stream-hash the remaining files (crypto supports incremental update), reading only the first 8KB for the NUL sniff. Drop `bytes` for skip buckets once classified. Process and persist in chunks so buffers are released as each chunk lands, which dovetails with NEC-003's per-batch persistence.

---

## NEC-038: Brood resume never refreshes changed files

**Issue.** The resume classifier keys on nectar existence and `describeStatus`, ignoring content hash, so a re-run of `brood` skips files that changed after a successful earlier brood.

**Evidence** (brooding review M2):

- `classifyResume` looks only at the latest row's `describeStatus` (`src/brooding/resumability.ts:55-68`), keyed by path (`pipeline.ts:351-368`).
- A file edited after a successful brood (daemon/watcher not running) fails the projection pre-check (new hash) and survives to the resume partition; then rule 1 skips it because its path has a `described` row. Its description stays stale forever absent `--force`, the store keeps the old `contentHash`, and every subsequent brood re-reads, re-hashes, and re-skips it.
- The review notes the spec's rule 1 (`brooding-pipeline.md:128`) is written for resuming an interrupted brood; treating it as a path-level skip regardless of content leaves explicit re-broods unable to repair a stale index. The watcher/enricher is the intended change path, but it cannot cover edits made while the daemon was off if the projection is also stale or lost.

**Failure mode.** A user who edits files while the daemon is down and later re-runs `brood` expecting the index to catch up gets a silent no-op for every changed file; recall serves the old descriptions indefinitely.

**Fix direction.** In the resume partition, treat `latest.contentHash !== prepared.contentHash` as re-enqueue even when the latest status is `described`. Unchanged described files continue to skip; `--force` semantics are unchanged.

---

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| AC-018e.1 | Given a brood over N batch groups, when the process is killed after batch group k completes its describe call but before the run finishes, then every described and failed row from groups 1..k exists durably in the store on restart, and the resume partition re-enqueues only the not-yet-described remainder. |
| AC-018e.2 | Given a solo describe result inside Stage 4, when the solo call returns, then its row is persisted before the next solo call is issued (no accumulation of solo results until Stage 6). |
| AC-018e.3 | Given an embed provider that throws mid-run in violation of its never-rejects contract, when the throw occurs, then all description rows persisted before the throw remain durable and a subsequent run does not re-describe them. |
| AC-018e.4 | Given both pipelines (`runBrood` and `runBroodAsync`), when AC-018e.1 through AC-018e.3 are tested, then both variants satisfy them (the fix is applied to `pipeline.ts` and `pipeline-async.ts` alike). |
| AC-018e.5 | Given a discovered file whose extension is in the known-binary list, when prechecking runs, then the file's content is never read (classification happens before any read) and the run records it with its skip status. |
| AC-018e.6 | Given a discovered file above the max-describe size, when prechecking runs, then its bytes are not retained after hashing (hash computed by streaming; `PreparedFile` for skip buckets carries no full-content buffer). |
| AC-018e.7 | Given a re-run of `brood` over a path whose latest stored row is `described` but whose on-disk content hash differs from the stored `contentHash`, when the resume partition classifies it, then the path is re-enqueued for describe rather than skipped. |
| AC-018e.8 | Given a re-run of `brood` over a path whose latest stored row is `described` and whose content hash matches, when the resume partition classifies it, then the path is skipped exactly as today (no regression of resume rules 1-3 or `--force`). |

---

## Files touched

| File | Change kind | What changes |
|---|---|---|
| `src/brooding/pipeline.ts` | modify | Stage-4 loops persist described+failed rows per batch group and per solo result; embed per chunk or backfill after persist; `describedByNectar` accumulation removed or reduced to chunk scope; resume partition consults content hash. |
| `src/brooding/pipeline-async.ts` | modify | Same incremental-persist restructure for the async variant (accumulate at `:321-357`, persist at `:367-387` today). |
| `src/brooding/precheck.ts` | modify | Classify known-binary extensions before reading; stream-hash with an 8KB NUL-sniff window; drop `bytes` for skip buckets. |
| `src/brooding/resumability.ts` | modify | `classifyResume` gains a content-hash comparison: `described` + hash mismatch classifies as re-enqueue. |
| `src/brooding/bucketing.ts` | modify | If needed, expose the content-independent extension check for precheck to call before any read (today it is applied after prepare at `bucketing.ts:41-42`). |
| `test/brooding.test.ts` | modify | New suites per the table below; extend existing resume tests. |

---

## Tests to add

The brooding review's coverage notes explicitly list mid-run crash persistence (C1), memory behavior on large/binary files (H2), changed-content re-brood (M2), and the entirely untested async pipeline (`runBroodAsync`) as gaps in `test/brooding.test.ts`. All are covered below.

| AC | Test file | Scenario |
|---|---|---|
| AC-018e.1 | `test/brooding.test.ts` | Fake describe transport that succeeds for the first batch group then throws; assert the store contains group 1's described rows; run again and assert only the remainder is re-described. |
| AC-018e.2 | `test/brooding.test.ts` | Fake store records write ordering; assert a solo result's write lands before the next solo describe call is issued. |
| AC-018e.3 | `test/brooding.test.ts` | Embed provider that throws after the first chunk; assert previously persisted description rows survive and are not re-described on the next run. |
| AC-018e.4 | `test/brooding.test.ts` | Drive `runBroodAsync` through the same crash-persistence scenarios as `runBrood` (closes the review's async-pipeline coverage gap). |
| AC-018e.5 | `test/brooding.test.ts` | Instrumented read seam counts reads; a `.mp4` (known-binary extension) in discovery is classified skipped with zero content reads. |
| AC-018e.6 | `test/brooding.test.ts` | A >256KB file is hashed and bucketed skip-too-large with no retained full-content buffer on the prepared record. |
| AC-018e.7 | `test/brooding.test.ts` | Seed a `described` row for a path, change the on-disk content, re-run brood without `--force`; assert the path is re-enqueued and re-described. |
| AC-018e.8 | `test/brooding.test.ts` | Seed a `described` row with matching hash; re-run; assert skip (regression guard for the existing two-run resume test at `test/brooding.test.ts:337-374`). |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-003, NEC-012, NEC-038)
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) (findings C1, H2, M2 and the coverage notes)
- [`../../../notes/2026-07-02-executive-summary.md`](../../../notes/2026-07-02-executive-summary.md) (mission leg 1 verdict)
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) (the committed-write contract at `:126`, resume rule 1 at `:128`, the 100K scaling case at `:120`)
- [`../../../knowledge/private/ai/brooding-deep-dive/brooding-technical-specification.md`](../../../knowledge/private/ai/brooding-deep-dive/brooding-technical-specification.md) (resumability contract at `:40`, `:105`, `:152`)
- [`./prd-018f-brooding-batch-call-robustness.md`](./prd-018f-brooding-batch-call-robustness.md) (adjacent: batch-call failure handling)
- [`./prd-018g-enricher-correctness-and-concurrency.md`](./prd-018g-enricher-correctness-and-concurrency.md) (adjacent: brood/enricher races)
