# PRD-018g: Enricher correctness and concurrency

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XL (3-5d)
> **Schema changes:** None (the write-pattern decision for NEC-017 stays within existing columns; if the version-bump append is chosen it uses existing seq semantics)

---

## Overview

The enricher is the steady-state maintenance loop that keeps descriptions current after the initial brood; it is the machinery behind the "update it upon change" leg of the mission once change signals reach it, and it feeds the recall index that leg 3 serves. The 2026-07-02 reviews found six defects that make the shipped loop race, misattribute, stall, or silently lose its own output. The enricher polls the same `pending`/`failed` rows a running brood is describing, with a read-then-append `nextSeq`, so concurrent operation duplicates LLM spend and collides sequence numbers; boot auto-brood also bypasses the `/build` in-flight guard, so two concurrent broods double-mint every identity (NEC-011). Inside a cycle, a file deleted mid-batch shifts every later description onto the wrong file (NEC-015). The working set is hydrated exactly once at daemon boot, so post-boot pending rows wait for a restart (NEC-016). The durable write-back is a fire-and-forget in-place UPDATE the codebase itself documents as unreliable on this backend (NEC-017). The Jaccard cosmetic-change gate shipped by PRD-016a is exported and tested but invoked nowhere, so every whitespace edit pays a full re-describe (NEC-026). And the enricher-cycle projection regeneration trigger has a seam production wiring never fills, so the committed `nectars.json` goes stale in steady state (NEC-031).

This sub-PRD makes the enricher safe to run alongside brooding and makes its output durable, correctly attributed, fresh, cost-gated, and reflected in the committed projection.

---

## Goals

- Brooding and the enricher never describe the same rows concurrently, and concurrent broods are impossible: one shared in-process guard covers `/build`, boot auto-brood, and the enricher.
- `nextSeq` is atomic or collision-safe under concurrent writers.
- A batch describe attaches each description to exactly the file whose content was sent, regardless of mid-batch deletions.
- The enricher's working set reflects the durable store during steady state, not a boot-time snapshot.
- Enrichment write-backs are durable before the cycle counts a file described, using a write pattern consistent with the table's declared semantics.
- The cosmetic-change gate is either wired into the cycle or removed along with its PRD claim (wiring recommended).
- The enricher-cycle projection regeneration trigger fires in production.

## Non-Goals

- Wiring `RegistrationService`/`WatchIntake` into the daemon so change signals reach the enricher at all: PRD-018b (NEC-001, NEC-006).
- Re-embedding projection-inherited rows (NEC-019) and embed-model provenance (NEC-018): PRD-018i owns embeddings and projection integrity, including the inherit re-embed.
- The brooding pipeline's own persistence timing (NEC-003): [PRD-018e](./prd-018e-brooding-durability-and-scale.md).
- Brooding batch transport failure handling (NEC-013, NEC-014): [PRD-018f](./prd-018f-brooding-batch-call-robustness.md).
- Daemon lock and lifecycle correctness (NEC-002, NEC-020, NEC-021): PRD-018a.
- Recall-side ranking and error reporting (NEC-005, NEC-024, NEC-025, NEC-027): [PRD-018h](./prd-018h-recall-ranking-and-error-honesty.md).

---

## NEC-011: Enricher races brooding on the same rows; auto-brood bypasses the in-flight guard; `nextSeq` is not atomic

**Issue.** Three interlocking concurrency gaps: the enricher's poll selects exactly the rows a running brood is mid-describe on, sequence allocation is read-then-append, and the boot auto-brood does not participate in the `/build` route's in-flight guard.

**Evidence** (brooding review H1):

- Brood Phase A writes `pending` rows for the entire describe set up front: `pipeline.ts:399-425`, `pipeline-async.ts:287-312`. The describe stage then runs for minutes to hours.
- The daemon starts the enricher loop at boot (`src/daemon.ts:431-436`, started at `daemon.ts:532`) and fires auto-brood in the background concurrently (`daemon.ts:460-497`).
- The enricher's pending-work selector picks exactly those rows every 30s: `WHERE describe_status IN ('pending', 'failed')` at `src/enricher/pending-query.ts:30-40`; default poll 30s (`src/enricher/config.ts`, `DEFAULT_ENRICHER_POLL_INTERVAL_MS = 30_000`).
- `nextSeq` is a read-then-append with no atomicity: `src/hive-graph/deeplake-store.ts:379-389`, `src/hive-graph/memory-store.ts:47-53`. Both brood (`pipeline-async.ts:373`) and enricher compute `MAX(seq)+1` then append; concurrent writers produce duplicate `(nectar, seq)` rows and ambiguous latest-version resolution.
- The HTTP `/build` route has a `broodInFlight` guard (`src/api/hive-graph-api.ts:160`, `:187-205`), but the daemon's boot auto-brood does not set or check it: a `POST /build` during the background auto-brood launches a second concurrent brood; both classify the same paths as `fresh` and double-mint identities for every file.

**Failure mode.** During any real (non-test) brood on a daemon, the enricher describes the same files in parallel: duplicated cost, duplicated version rows, seq collisions. Two concurrent broods duplicate every identity.

**Fix direction.** Introduce a shared in-process brood/enricher mutex: either pause the enricher while a brood is active, or have the enricher skip rows younger than the brood's start. Route the boot auto-brood through the same `broodInFlight` guard the API uses so exactly one brood can run per daemon. Make `nextSeq` atomic or collision-safe (for example, serialize seq allocation per nectar behind the shared guard, or detect-and-retry on a duplicate `(nectar, seq)`).

---

## NEC-015: Enricher can attach descriptions to the wrong files

**Issue.** The cycle reads each work item's content twice, once to build the LLM payload and once (after the call) to realign results by a manually advanced index; a file that disappears between the two reads shifts every later description one slot.

**Evidence** (recall review H2):

- `src/enricher/cycle.ts:117-121` (first content read builds `files`) and `cycle.ts:138-146` (second content read drives `fileIdx` alignment). The second-read loop skips a null read without consuming `fileIdx` (`cycle.ts:139`).
- `parseDescribeResponse` guarantees `descriptions.length === files.length` (`describe.ts:63`), so alignment depends entirely on the second read returning null for exactly the same items as the first. The LLM call between the two reads can take seconds to minutes.

**Failure mode.** A file deleted (or made unreadable) during the LLM call means every subsequent item in the batch receives the previous file's description, title, concepts, and embedding; the corrupted rows are written `describe_status = 'described'` and served by recall indefinitely, a poisoned index with no error anywhere.

**Fix direction.** Read content exactly once per item: build `files` and a parallel `included: EnricherWorkItem[]` array in the same loop, then zip `included[i]` with `descriptions[i]`. The deleted-in-window case then falls out naturally: the file was described from the content that existed, and the next observation supersedes it.

---

## NEC-016: Enricher working set frozen at boot

**Issue.** The live enricher's in-memory mirror is seeded exactly once, at daemon start; version rows appended afterward are invisible until a restart.

**Evidence** (recall review H3):

- `src/enricher/store-adapter.ts:57-61` (`hydrate` is the only seeding path), `src/cli.ts:584-596` (hydrate seam wired to `listLatestVersions`), `src/cli.ts:665-670` (hydrate called exactly once, at daemon start).
- `cli.ts:584-586` hydrates from `listLatestVersions` (latest-per-nectar) even though the seam's own contract (`store-adapter.ts:33-36`) asks for every version row, full history; the docblock at `cli.ts:552-560` acknowledges the cosmetic-inherit degradation but not the frozen-working-set consequence.
- The durable-store pending query that could refresh the set already exists and is unused in production: `buildPendingWorkSql` at `src/enricher/pending-query.ts:25-41`.

**Failure mode.** Stale recall after change: files whose describe failed or whose rows arrived after boot (a `POST /build` brood leaving `failed` rows, teammate-synced rows, or future watcher output) sit at `pending`/`failed` forever, and `countPending` on the mirror under-reports the real queue.

**Fix direction.** Re-hydrate the working set periodically (every N enricher cycles), or poll the durable store directly each cycle via the existing `buildPendingWorkSql`, or push registration/brood appends into the mirror at write time. The durable-poll option is preferred because the query already exists and removes the mirror-freshness problem entirely for work selection.

---

## NEC-017: Enrichment writes use a pattern the codebase calls unreliable

**Issue.** The cycle's durable write-back is a fire-and-forget in-place `UPDATE` against a table whose schema declares an append-only write pattern, the exact stale-snapshot shape the store's own comments document as retired.

**Evidence** (recall review H4):

- `src/enricher/store-adapter.ts:93-99` (fire-and-forget write-back: `updateVersion` updates the mirror synchronously, then fires the durable write with `void ... .catch(onWriteBackError)` at `store-adapter.ts:96-98`), `src/enricher/sql-update.ts:11-30` (in-place `UPDATE "hive_graph_versions"`).
- Contradicts `src/hive-graph/schema.ts:79-84` (`writePattern: "append-only"` for that table, declared at `schema.ts:82`) and the caveat at `src/hive-graph/deeplake-store.ts:344-359` (honeycomb retired in-place UPDATE on this backend because point reads can return pre-update snapshots from stale segments).
- A failed write-back only prints one stderr line (`cli.ts:590-594`); the cycle still counts the file described, the projection is rebuilt from the in-memory store, and the durable row stays `pending`. Recall queries Deep Lake directly (`daemon-api-wiring.ts:104`), so the file is not recallable even though the daemon believes enrichment succeeded, until a restart re-hydrates and re-describes it, paying the LLM cost again.

**Failure mode.** Described files may never surface in recall: either the write-back failed silently, or it succeeded as an UPDATE the backend serves stale.

**Fix direction.** Decide the write pattern once. Preferred: the version-bump append the honeycomb history points to (append a new row at `seq+1` carrying the description; the latest-described subquery already selects it naturally, and it matches the table's declared append-only pattern and existing seq semantics, so no schema change). Alternative: keep UPDATE but make the write-back awaited within the cycle with bounded retry. In either case, only count `filesDescribed` (and only skip re-enrichment) after the durable write is confirmed. If the append is chosen, seq allocation must go through the collision-safe `nextSeq` from NEC-011.

---

## NEC-026: Jaccard cosmetic-change inheritance is dead code

**Issue.** The PRD-016a meaningful-change gate (Jaccard over token multisets, threshold 0.85) is built, exported, and unit-tested but invoked by no runtime path, so every cosmetic edit pays a full describe and embed, and `filesInherited` can never be incremented.

**Evidence** (recall review M3):

- `src/enricher/meaningful-change.ts:33-37` (`classifyMeaningfulChange`), `src/enricher/jaccard.ts`, exported via `src/enricher/index.ts:24-26`, but invoked by no runtime path (verified in the review: only definition, re-export, and `test/enricher.test.ts` reference them; `src/enricher/cycle.ts` never calls them).
- `filesInherited` (`observability.ts:9`) is checked by the loop (`loop.ts:38`) yet no code increments it.
- Threshold `DEFAULT_REDESCRIBE_THRESHOLD = 0.85` (`config.ts:15`).
- `cli.ts:552-560` documents that even if the gate were wired, `priorDescribedVersion` has no durable history after a cold boot, so it would silently never fire on the live path without a prior-content strategy.

**Failure mode.** Whitespace reformats, comment tweaks, and license-header churn each pay a full describe plus embed round trip: cost, latency, and description churn in recall. The shipped behavior also contradicts the completed PRD-016a claim.

**Fix direction.** Two options, both presented so the decision is recorded; wiring is recommended. (a) Wire `classifyMeaningfulChange`/`applyCosmeticInheritance` into the cycle before batching. This requires a prior-content strategy: key off the prior version's `content_hash` plus a content cache, or compare against the projection's inherited content view. (b) Delete the module, the `filesInherited` counter, and the PRD-016a claim before release so the shipped behavior matches the documented one. Option (a) preserves the cost model the corpus sells; option (b) is honest but abandons it.

---

## NEC-031: Enricher-cycle projection regeneration is spec'd but unwired

**Issue.** Of the portable registry's three regeneration triggers, only end-of-brood and explicit-rebuild fire; the enricher-cycle trigger has a seam production wiring never fills, so steady-state description updates never refresh the committed `nectars.json`.

**Evidence** (daemon review M4):

- `portable-registry.md:117-121` specifies three regeneration triggers. Trigger #1 works (async brood stage 7, `brooding/pipeline-async.ts:401-405`); trigger #3 works (`cli.ts:226-244`, `api/daemon-api-wiring.ts:129-132`).
- Trigger #2 has a seam (`enricher/cycle.ts:51,266` accepts a `projectionWriter` and calls `scheduleWrite`) that no production code fills: the live wiring at `cli.ts:618-629` passes `enricherCycle: { readContent, portkey, embedProvider }` with no `projectionWriter`, and `ProjectionWriter` is never constructed outside tests.

**Failure mode.** The committed projection silently goes stale until the next full brood or a manual rebuild, undermining the "clone inherits current descriptions" property the spec sells.

**Fix direction.** Construct a `ProjectionWriter` in `runDaemon()` (debounced, per `write.ts:88-151`) and pass it through the `enricherCycle` deps so trigger #2 fires, sourcing the document from `rebuildProjectionAsync` on flush.

---

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| AC-018g.1 | Given a brood in flight on the daemon, when the enricher poll fires, then the enricher describes no rows belonging to that brood (it is paused, or it skips rows younger than the brood's start). |
| AC-018g.2 | Given a boot auto-brood in flight, when `POST /api/hive-graph/build` arrives, then the request is refused by the same in-flight guard that protects API-initiated broods; at most one brood runs per daemon at any time. |
| AC-018g.3 | Given two concurrent writers appending versions for the same nectar, when both allocate a sequence number, then no duplicate `(nectar, seq)` pair is persisted. |
| AC-018g.4 | Given a batch where one file becomes unreadable between payload construction and result attribution, when the cycle attributes descriptions, then every other file receives exactly the description generated from its own content, and no row is stored with another file's description. |
| AC-018g.5 | Given a cycle, when it runs, then each work item's content is read exactly once (payload and attribution share the same read). |
| AC-018g.6 | Given a version row appended to the durable store after daemon boot with `describe_status = 'pending'`, when subsequent enricher cycles run, then the row is selected for enrichment without a daemon restart. |
| AC-018g.7 | Given a durable write-back that fails, when the cycle accounts for the batch, then the affected file is not counted in `filesDescribed` and remains eligible for re-enrichment. |
| AC-018g.8 | Given a successful enrichment, when the durable write lands, then it uses the decided write pattern (version-bump append at `seq+1`, or awaited UPDATE with bounded retry), and a subsequent read of the latest described version returns the new description. |
| AC-018g.9 | Given a pending row whose content's token Jaccard similarity to the prior described version is at or above the threshold, when the cycle processes it, then the prior description is inherited with no LLM call and `filesInherited` is incremented (if option (a) is chosen; if option (b) is chosen, the module, counter, and PRD-016a claim are removed and this AC is replaced by that removal). |
| AC-018g.10 | Given a pending row below the similarity threshold, when the cycle processes it, then it takes the full describe path exactly as today. |
| AC-018g.11 | Given an enricher cycle that wrote at least one new description, when the cycle completes, then a debounced projection write is scheduled and the committed `nectars.json` reflects the new description after the flush. |
| AC-018g.12 | Given an enricher cycle that wrote no descriptions, when the cycle completes, then no projection write is scheduled. |

---

## Files touched

| File | Change kind | What changes |
|---|---|---|
| `src/daemon.ts` | modify | Boot auto-brood routes through the shared in-flight guard; brood/enricher mutex owned at the composition root (auto-brood at `:460-497`, enricher start at `:431-436`, `:532`). |
| `src/api/hive-graph-api.ts` | modify | `broodInFlight` guard (`:160`, `:187-205`) generalized so boot auto-brood and the API share one guard instance. |
| `src/hive-graph/deeplake-store.ts` | modify | Collision-safe `nextSeq` (`:379-389`). |
| `src/hive-graph/memory-store.ts` | modify | Matching `nextSeq` semantics (`:47-53`) so the adapters stay behaviorally aligned. |
| `src/enricher/cycle.ts` | modify | Single-read `included[i]`/`descriptions[i]` zip replacing the `fileIdx` realignment (`:117-146`); cosmetic-change gate invoked before batching (option a); durable-confirmation accounting. |
| `src/enricher/store-adapter.ts` | modify | Write-back made awaited/confirmed (`:93-99`); working-set refresh path (periodic re-hydrate or durable poll). |
| `src/enricher/sql-update.ts` | modify | Replaced by the version-bump append builder, or retained with awaited bounded-retry semantics, per the NEC-017 decision. |
| `src/enricher/pending-query.ts` | modify | `buildPendingWorkSql` (`:25-41`) wired into the production work-selection path. |
| `src/cli.ts` | modify | Enricher wiring passes a constructed `ProjectionWriter` (`:618-629`); hydrate/refresh wiring updated (`:584-596`, `:665-670`); prior-content strategy for the gate (`:552-560`). |
| `src/enricher/meaningful-change.ts` | modify | Wired into the cycle (option a) or deleted with its exports and counter (option b). |
| `test/enricher.test.ts` | modify | New suites per the table below. |
| `test/brooding.test.ts` | modify | Brood/enricher race and concurrent-brood guard coverage. |
| `test/hive-graph-deeplake.test.ts` | modify | Concurrent `nextSeq` collision coverage. |
| `test/daemon.test.ts` | modify | Boot auto-brood guard participation. |

---

## Tests to add

The reviews explicitly call out these coverage gaps: enricher/brood and concurrent-brood races (brooding review H1, listed in its coverage notes), enricher deletion during the describe call (recall review H2, listed in its coverage notes), and the untested production use of `buildPendingWorkSql`.

| AC | Test file | Scenario |
|---|---|---|
| AC-018g.1 | `test/enricher.test.ts` | Start a fake long-running brood, fire an enricher cycle, assert zero describe calls for the brood's rows. |
| AC-018g.2 | `test/daemon.test.ts` | Boot auto-brood in flight; `POST /build` returns the in-flight refusal; after auto-brood completes, `/build` is accepted. |
| AC-018g.3 | `test/hive-graph-deeplake.test.ts` | Two interleaved appenders for one nectar; assert all persisted `(nectar, seq)` pairs are unique. |
| AC-018g.4 | `test/enricher.test.ts` | Delete a mid-batch file between payload build and attribution (injectable read seam); assert no slot shift and correct per-file attribution (closes the recall review's H2 gap). |
| AC-018g.5 | `test/enricher.test.ts` | Counting read seam; assert exactly one read per item per cycle. |
| AC-018g.6 | `test/enricher.test.ts` | Append a pending row to the durable fake after hydrate; assert a later cycle selects it without re-hydrating via restart. |
| AC-018g.7 | `test/enricher.test.ts` | Durable write-back rejects; assert `filesDescribed` excludes the file and it is re-selected next cycle. |
| AC-018g.8 | `test/enricher.test.ts`, `test/hive-graph-deeplake.test.ts` | Successful enrichment lands as the decided pattern; latest-described read returns the new description. |
| AC-018g.9 | `test/enricher.test.ts` | Cosmetic edit (similarity above threshold) inherits with zero LLM calls and increments `filesInherited`. |
| AC-018g.10 | `test/enricher.test.ts` | Meaningful edit (below threshold) takes the describe path. |
| AC-018g.11 | `test/enricher.test.ts` | Cycle that writes a description schedules a projection write; flushed document contains the new description. |
| AC-018g.12 | `test/enricher.test.ts` | No-op cycle schedules no projection write. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-011, NEC-015, NEC-016, NEC-017, NEC-026, NEC-031)
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) (finding H1)
- [`../../../notes/2026-07-02-recall-review.md`](../../../notes/2026-07-02-recall-review.md) (findings H2, H3, H4, M3)
- [`../../../notes/2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) (finding M4)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) (enricher defaults, queue debounce, the meaningful-change heuristic)
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) (the append-only write pattern the NEC-017 decision must respect)
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) (the three regeneration triggers, `:117-121`)
- [`../../completed/prd-016-enricher-steady-state/prd-016a-queue-poll-debounce-meaningful-change.md`](../../completed/prd-016-enricher-steady-state/prd-016a-queue-poll-debounce-meaningful-change.md) (the cosmetic-inherit claim NEC-026 must reconcile)
- [`./prd-018e-brooding-durability-and-scale.md`](./prd-018e-brooding-durability-and-scale.md) (adjacent: brood-side persistence)
- [`./prd-018h-recall-ranking-and-error-honesty.md`](./prd-018h-recall-ranking-and-error-honesty.md) (adjacent: the recall surface these writes feed)
