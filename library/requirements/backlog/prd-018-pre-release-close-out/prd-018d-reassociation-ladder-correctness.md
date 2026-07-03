# PRD-018d: Re-association ladder correctness

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (1-2d)
> **Schema changes:** None

---

## Overview

The re-association ladder is the mechanism that keeps a nectar (and its paid-for description history) attached to the right file across edits, moves, and deletes. The identity spec is explicit that "a mis-association is worse than a new nectar because it corrupts the history chain" (`identity-and-reassociation.md`, "What re-association explicitly does not do"). Two findings violate that priority. First, the TLSH fuzzy step's confidence mapping is size-insensitive: it normalizes distance by a fixed maximum of 801, so two completely unrelated ~10-byte files score above the 0.85 auto-carry band and the ladder carries the wrong nectar (and its whole description history) onto unrelated content. This is broken logic, not a tuning gap: the deliberately-unspecified band thresholds stay tunable; the score feeding them must become honest. Second, the ladder's durable writes are multi-step and non-atomic (mint = insert then append; carry = append then touch; review-accept = carry then remove then delete), and the file-backed review store both loses updates under its own stated daemon+CLI concurrency and grows without bound, duplicating candidates per re-observation.

This epic lands after [PRD-018b](./prd-018b-wire-update-on-change.md) wires the pipeline, because only then does the ladder run against real workloads. Source evidence: [`2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) H5, M4, M5, M6 (the NEC-036 wording, "non-atomic multi-write ladder actions + lossy review queue", folds M5 and M6 under it alongside M4).

---

## Goals

- The fuzzy-match confidence score is evidence-aware: small inputs can no longer reach the auto-carry band on coincidence, and the abstain floor reflects actual trigram mass. Band edges stay operator-tunable per the deliberate spec gap.
- Every ladder action's durable footprint is crash-consistent: either applied as a single store transaction or repaired by an idempotent sweep, so no crash leaves an identity with zero version rows, a stale `lastUpdateDate` feeding prune, or two identities on one path after a review accept.
- The pending-review store serializes concurrent daemon and CLI writers (its stated purpose) and dedupes candidates by `(candidateNectar, newPath)` so the queue is bounded and reviews are never stale duplicates.

## Non-Goals

- Wiring the ladder into the daemon and the sync/async store bridge. [PRD-018b](./prd-018b-wire-update-on-change.md) owns construction; this epic assumes the bridge exists and defines the transaction/sweep semantics on top of it.
- Case-only rename classification and the step-2 mtime refresh. [PRD-018c](./prd-018c-watcher-robustness-and-ignore-parity.md).
- Re-tuning the TLSH band thresholds themselves (`highConfidence`, the review band). Deliberate spec gap; this epic fixes the mapping that feeds them, not the values.
- The step-4 candidate-scan cost (O(known-files) stats per new file, change-detection review M7) and the step-3 duplicate-content source-selection order (review L6). Performance and tie-break refinements that can ride along if trivial, but they are not NEC-listed gates for this epic.
- The `review-matches` accept/reject sub-flag grammar. Deliberate spec gap behind the injected-decider seam.

---

## NEC-010: TLSH fuzzy matching mis-associates tiny files

**Issue.** Confidence normalizes distance by a fixed `MAX_DISTANCE = 801`, but small inputs cannot produce distances anywhere near that maximum, so unrelated tiny files score above the auto-carry band and step 4 carries the wrong nectar.

**Evidence** (change-detection review H5; NECTAR-ISSUES NEC-010):

- Confidence is `1 - distance/MAX_DISTANCE` with fixed `MAX_DISTANCE = 801` (`src/registration/tlsh.ts:42,154-158`).
- A file of N bytes yields only N-2 trigrams, so two completely unrelated ~10-byte files (each occupying at most 8 of 128 buckets; quartiles all 0, so the body is an occupancy bitmap) have body distance at most 6x16 = 96, length distance 0 (same size bucket), checksum 1: distance at most 97, confidence at least 0.879, above the operator default `highConfidence: 0.85` (`tlsh.ts:191-194`).
- The floor `MIN_FUZZY_BYTES = 3` (`tlsh.ts:170`) only blocks content of 2 bytes or less; the tie guard (`tlsh.ts:229-231,237`) only helps when two candidates tie exactly.
- Step 4 auto-carries above the high band (`ladder.ts:167-189`).
- Coverage gap: `tlsh.test.ts` uses fixtures of roughly 100 bytes and up, so the tiny-file band behavior is never exercised.

**Failure mode.** Delete a tiny file (a `.gitkeep`-sized stub, a tiny config) and create any other tiny file of similar size: step 4 auto-carries the missing nectar and its description history onto unrelated content, the exact outcome the spec ranks worst. Mid-size files (roughly 30-300 bytes) land in the review band instead, spamming the review queue (compounding NEC-036's unbounded growth).

**Fix direction** (from the review; the mapping, not the thresholds):

1. **Size-aware normalization:** normalize distance by an input-size-aware achievable maximum rather than the fixed 801, so the confidence for small inputs reflects how much distance was actually possible; and/or
2. **Evidence gate:** require a minimum trigram count before fuzzy matching participates at all, raising the abstain floor from `MIN_FUZZY_BYTES = 3` to a size where the digest carries real signal (the review suggests the neighborhood of 50-100 bytes; make it a named, documented constant); and/or
3. **Evidence-scaled confidence:** scale the normalized score by evidence mass so sparse digests cannot saturate the band.

Whichever combination is chosen, the deliverable is that unrelated small files abstain (mint fresh) or land below the review band, while genuinely similar larger files keep their current behavior. Keep `highConfidence` and the review band edges tunable exactly as spec'd: fix the score, not the threshold.

---

## NEC-036: Non-atomic multi-write ladder actions and a lossy, unbounded review queue

**Issue.** Ladder actions are multi-write sequences with no atomicity across crashes, and the file-backed review store both loses concurrent updates and duplicates candidates without bound. (The issue's "lossy review queue" wording covers both the concurrency loss and the dedupe/growth defects.)

**Evidence** (change-detection review M4, M5, M6):

- Multi-write actions (M4): mint = `insertIdentity` then `appendVersion` (`src/registration/ladder.ts:370-374`); edit = `appendVersion` then `touchIdentity` (`ladder.ts:275-276`); carry = the same pair (`ladder.ts:312-313`); review-accept = carry, then `pendingReviews.remove`, then `deleteNectar(minted)` (`src/registration/review-cli.ts:88-115`). A crash between writes leaves (a) an identity with zero version rows, (b) a version row whose identity's `lastUpdateDate` is stale, which feeds prune eligibility directly (`src/registration/prune-cli.ts:58-61`), or (c) after an accepted review, two identities pointing at one path (carry landed, placeholder delete did not). None of these self-heal explicitly.
- Lost updates (M5): each review-store mutation is read-whole-file, modify, atomic-rename write (`src/registration/review-store.ts:128-140`, write at 111-126). The comment (109-110) is honest that only torn-file atomicity is guaranteed, not read-modify-write serialization, but the store's stated purpose is "a separate `review-matches` CLI process can see candidates a daemon queued" (`review-store.ts:12-14`), exactly two concurrent writers. A daemon `add()` racing a CLI `remove()` either resurrects a resolved candidate or silently drops a fresh one.
- Unbounded duplicates (M6): every ladder pass landing in the review band mints a new candidate id (`src/registration/service.ts:285-299`, `mintNectar()` per add); `add()` dedupes by id only (`review-store.ts:128-131`); `skip` keeps entries forever (`review-cli.ts:132-134`); there is no TTL and no dedupe by `(candidateNectar, newPath)`. Accepting an old duplicate carries stale hash/mtime metadata (`review-cli.ts:88-100`).

**Failure mode.** Crashes (which [PRD-018a](./prd-018a-daemon-lock-and-lifecycle.md) makes rarer but cannot eliminate) corrupt the registry in ways that feed prune deletions and duplicate identities; the review workflow, once 018b makes it real, loses or duplicates exactly the candidates it exists to adjudicate.

**Fix direction** (from the review's M4/M5/M6 directions, made concrete):

1. **Atomic ladder actions.** Batch each ladder action's writes into a single store transaction at the bridge layer (the sync/async bridge from 018b is the right seam: it already serializes durable writes, so an action-scoped batch is a natural unit), or, where the backend cannot express the batch atomically, add an idempotent repair sweep to the resync cycle: detect and heal orphan identities (zero version rows), stale `lastUpdateDate` relative to the newest version row, and post-review dangling placeholders (two identities on one path where one is a review-minted placeholder). Sweep and transaction are complementary; at minimum the sweep must exist, because pre-fix crashes may already have left these states.
2. **Serialized review-store writers.** Either an append-only journal (one JSON line per add/resolve, compacted by the CLI on read) or an advisory lock file around the read-modify-write, mirroring the daemon's existing single-instance lock pattern. The journal is preferred if the 018a lock work lands its identity primitives first (reuse, not reinvent); the decision is an implementation detail as long as AC-018d.6 holds.
3. **Dedupe and freshness.** `add()` dedupes/replaces by `(candidateNectar, newPath)` (a re-observation refreshes the candidate in place rather than appending a sibling), and review-time acceptance drops any pending entry whose `newPath`'s latest content hash no longer matches the candidate's recorded `contentHash` (stale candidates resolve as stale instead of carrying outdated metadata).

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-018d.1 | Given two unrelated files of roughly 10 bytes each with the same size bucket, when the fuzzy step scores them, then the resulting confidence is below the review band (abstain: fresh mint), not above `highConfidence`. |
| AC-018d.2 | Given a file below the evidence floor (minimum trigram/byte gate), when a missing-file candidate scan runs, then the fuzzy step abstains for that input regardless of digest distance. |
| AC-018d.3 | Given two genuinely similar files large enough to carry real trigram mass (the existing `tlsh.test.ts` fixture sizes), when the fuzzy step scores them, then their band placement is unchanged by this epic (no regression on the sanctioned auto-carry path), and the band edges remain configurable via `DEFAULT_TUNABLE_FUZZY_CONFIG`. |
| AC-018d.4 | Given a crash injected between the two writes of a mint, edit, or carry action, when the daemon next boots and the repair path runs (transactional batch prevents the state, or the resync sweep heals it), then the store contains no identity with zero version rows and no version row whose identity `lastUpdateDate` predates it, and prune eligibility is computed only from healed state. |
| AC-018d.5 | Given a crash injected between the carry and the placeholder delete of a review accept, when the repair path runs, then exactly one identity points at the accepted path and the review-minted placeholder is gone. |
| AC-018d.6 | Given a daemon `add()` and a CLI `remove()` racing on the review store, when both complete, then the store reflects both operations: the resolved candidate stays resolved and the freshly queued candidate is present (no lost update in either direction). |
| AC-018d.7 | Given a file re-observed into the review band while a candidate for the same `(candidateNectar, newPath)` is already pending, when `add()` runs, then the existing candidate is replaced/refreshed in place and the queue length does not grow. |
| AC-018d.8 | Given a pending review whose `newPath` content hash no longer matches the candidate's recorded `contentHash`, when the operator accepts it, then the accept resolves as stale (no carry of outdated hash/mtime metadata onto the identity). |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/registration/tlsh.ts` | modify | Size-aware distance normalization and/or evidence gate; named abstain-floor constant; band edges untouched |
| `src/registration/ladder.ts` | modify | Ladder actions emit transactional write batches (or sweep-recognizable markers); no behavioral change to step semantics |
| `src/registration/service.ts` | modify | Resync cycle invokes the idempotent repair sweep; review-candidate add path passes dedupe identity |
| `src/registration/store-bridge.ts` (from 018b) | modify | Action-scoped transactional batching for ladder writes |
| `src/registration/review-store.ts` | modify | Journal or advisory-lock serialization; dedupe/replace by `(candidateNectar, newPath)` |
| `src/registration/review-cli.ts` | modify | Stale-candidate detection at accept time; compaction (if journal chosen) |
| `test/tlsh.test.ts` | modify | Tiny-file band behavior at the default bands; evidence floor; large-file regression |
| `test/registration.test.ts` | modify | Crash-injected ladder actions and sweep healing |
| `test/registration-service.test.ts` | modify | Sweep wiring in the resync cycle |
| `test/review-matches.test.ts` | modify | Concurrent writers, dedupe-on-add, stale accept |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018d.1 | `test/tlsh.test.ts` | Two unrelated ~10-byte fixtures score below the review band at the default bands (the review notes `tlsh.test.ts` uses ~100+-byte fixtures only; this closes the "tiny-file fuzzy behavior at the default bands (H5)" gap). |
| AC-018d.2 | `test/tlsh.test.ts` | Inputs below the evidence floor abstain regardless of digest distance. |
| AC-018d.3 | `test/tlsh.test.ts` | Existing similar-file fixtures keep their band placement; band edges still read from `DEFAULT_TUNABLE_FUZZY_CONFIG`. |
| AC-018d.4 | `test/registration.test.ts` | Fault injection between `insertIdentity`/`appendVersion` (and `appendVersion`/`touchIdentity`): sweep heals orphan identity and stale `lastUpdateDate`; prune preview on the healed store lists nothing spurious. |
| AC-018d.5 | `test/review-matches.test.ts` | Fault injection between carry and placeholder delete on accept: sweep converges to one identity per path. |
| AC-018d.6 | `test/review-matches.test.ts` | Interleaved daemon `add()` and CLI `remove()` (driven concurrently against one store dir): both effects present afterward (closes the "concurrent `FilePendingReviewStore` writers (M5)" gap). |
| AC-018d.7 | `test/review-matches.test.ts` | Repeated review-band observations of one path: queue length stays 1, candidate metadata refreshed. |
| AC-018d.8 | `test/review-matches.test.ts` | Accept of a candidate whose target file changed since queueing resolves as stale; no metadata carry. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md) : the PRD-018 program index.
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) : NEC-010, NEC-036.
- [`../../../notes/2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) : AUTHORITATIVE evidence: H5 (size-insensitive confidence), M4 (multi-write actions), M5 (review-store lost updates), M6 (unbounded duplicate candidates).
- [`../../../knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) : the ladder contract, the mis-association-is-worst principle, and the deliberately tunable band edges this epic preserves.
- [`./prd-018b-wire-update-on-change.md`](./prd-018b-wire-update-on-change.md) : the store bridge whose write serialization this epic's transactions build on; makes the ladder reachable at all.
- [`./prd-018c-watcher-robustness-and-ignore-parity.md`](./prd-018c-watcher-robustness-and-ignore-parity.md) : adjacent ladder fixes (case folding, step-2 refresh) that share files with this epic.
- [`./prd-018a-daemon-lock-and-lifecycle.md`](./prd-018a-daemon-lock-and-lifecycle.md) : the lock/identity primitives an advisory-lock review store would mirror.
