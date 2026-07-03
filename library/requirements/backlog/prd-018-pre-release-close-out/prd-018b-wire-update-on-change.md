# PRD-018b: Wire the update-on-change pipeline (mission leg 2)

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

The mission's middle leg, "update it upon change with NodeFS", does not exist at runtime. `WatchIntake`, `RegistrationService`, and the five-step re-association ladder are fully built and unit-tested, but no production code path constructs them: they are only re-exported from the package index, the daemon boots its worker with a no-op job source, and the mutating CLI verbs (`brood`, `prune`, `review-matches`) exit 2 as "wiring pending" stubs. Three independent review passes converged on this as the headline finding. Compounding it, the service consumes the synchronous `HiveGraphStore` interface while the only durable store (Deep Lake) is async, so even a one-line wiring change is impossible today; and nothing calls `requestResync()` on start, so offline edits made while the daemon was down would never be reconciled even once the watcher runs.

This epic constructs the pipeline in the daemon, bridges it to the durable store, gives it a cold-start catch-up, and unstubs the CLI verbs. When it lands, a file edit, rename, move, delete, or copy observed by NodeFS flows through the ladder into Deep Lake, and the enricher picks up the appended pending rows. Source evidence: [`2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) C1 and H1, and [`2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) H5.

---

## Goals

- The daemon constructs and starts the full registration pipeline on `start()`: `RegistrationService` wired with `WatchIntake`, `createDiskRegistrationFs`, `createDefaultIgnore`, `createTlshFuzzyStep(DEFAULT_TUNABLE_FUZZY_CONFIG)`, and `FilePendingReviewStore`, and stops it cleanly on `shutdown()`.
- A sync/async store bridge lets the (sync-interfaced) `RegistrationService` persist to the async Deep Lake store, without forking the ladder logic.
- Cold catch-up: `requestResync()` runs on daemon start, sequenced after auto-brood settles, so offline edits, moves, and deletes are reconciled through the same ladder on every boot.
- The `brood`, `prune`, and `review-matches` CLI verbs run for real against the durable store instead of exiting 2.

## Non-Goals

- Ignore-rule parity between brooding and watching, directory-rename handling, watcher error recovery, case folding, and mtime refresh. All owned by [PRD-018c](./prd-018c-watcher-robustness-and-ignore-parity.md); this epic wires the existing `createDefaultIgnore` as-is and 018c swaps in the shared predicate.
- The TLSH confidence mapping, ladder write atomicity, and review-store concurrency/dedupe. Owned by [PRD-018d](./prd-018d-reassociation-ladder-correctness.md); this epic wires the fuzzy step with its current tunable config.
- The enricher/brood race over pending rows and atomic `nextSeq`. Owned by [PRD-018g](./prd-018g-enricher-correctness-and-concurrency.md); this epic's wiring makes that race reachable in production, which is exactly why 018g sits adjacent in the execution order.
- The per-event performance of the durable store's by-path/by-hash lookups (full-tenancy scans, flagged as recall review L3 and batched in NEC-042). The bridge may adopt predicate pushdown opportunistically, but the perf work is not a gate for this epic.
- Rewriting the public docs that promise live updates. [PRD-018l](./prd-018l-docs-truth-pass-and-cleanup.md) does the truth pass once this lands.

---

## NEC-001: The update-on-change pipeline is dead code in production

**Issue.** The watcher, registration service, and ladder are built and tested but never constructed by the daemon or CLI, and the service cannot be wired to the durable store as-is because it consumes the sync store interface.

**Evidence** (change-detection review C1; daemon-api review H5; NECTAR-ISSUES NEC-001):

- `new RegistrationService(...)` appears only in tests (`test/registration-service.test.ts:62,75,101,129,145,173`, `test/security-remediation.test.ts:213`, `test/telemetry/metrics.test.ts:332`). The only non-test references to the pipeline are re-exports (`src/index.ts:127-128,163-164`).
- The daemon's worker boots with a no-op job source: `src/daemon.ts:366-367` (`source: options.jobSource ?? emptyJobSource`; `src/worker.ts:121-125`), so the `PollLoop` spins leasing nothing.
- `src/cli.ts:78-79` and `src/cli.ts:479-482` openly stub `prune` / `review-matches` as "durable wiring pending daemon integration"; the issue list cites the stub exit at `src/cli.ts:478-483`.
- `cli.ts:466-477` documents that "the live daemon does not instantiate the registration pipeline (a documented PRD-006a non-goal)".
- The sync/async blocker: `RegistrationService` consumes the synchronous `HiveGraphStore` (`src/registration/service.ts:93`, `src/registration/ladder.ts:87-88`), while the durable Deep Lake store implements the async interface (`src/hive-graph/store.ts:111-149`).

**Failure mode.** After brooding, no file edit, rename, move, delete, or copy is ever observed. The registry silently goes stale forever; `prune --confirm` deletes nothing; `review-matches` never has candidates. The enricher only re-describes rows something else marks pending, and nothing does. The mission's middle leg does not exist at runtime.

**Fix direction** (expanded from the review's fix direction):

1. **Construction.** In daemon `start()` (the assembly path at `src/daemon.ts:523-559`), construct the pipeline: `createDiskRegistrationFs` rooted at the workspace, `createDefaultIgnore` (replaced by the shared predicate in 018c), `createTlshFuzzyStep(DEFAULT_TUNABLE_FUZZY_CONFIG)` (mapping fixed in 018d, thresholds stay tunable), `FilePendingReviewStore` at the spec'd location, and a `RegistrationService` over the store bridge. Stop it in `shutdown()` (`src/daemon.ts:572-580`) before the lock is released, participating in the drain contract from [PRD-018a](./prd-018a-daemon-lock-and-lifecycle.md) (NEC-033).
2. **The sync/async bridge.** `RegistrationService` keeps its sync store interface; production wires it to an adapter that mirrors the durable state in memory and flushes ladder writes to the async Deep Lake store, the same shape brooding already uses to reconcile the two interfaces. The bridge must define: (a) hydration (seed the mirror from `listLatestVersions` plus identities at start, after auto-brood settles), (b) write-through ordering (ladder actions apply to the mirror synchronously and enqueue durable writes in order), and (c) failure surfacing (a failed durable flush must not silently diverge the mirror; surface to health/log and re-drive, coordinating with 018g's write-pattern decision rather than inventing a second one).
3. **Gating.** The pipeline only starts when the durable store resolves (Deep Lake credentials present), mirroring how the enricher loop is gated; without credentials the daemon boots as today and `/health` says the watch leg is off (health surfacing detail shared with 018c's watcher-liveness flag).
4. **CLI unstubbing.** `brood` (mutating), `prune`, and `review-matches` construct the same store path the daemon uses and run their already-tested mechanics (`runPrune`, `runReviewMatches`) for real, exiting 0 on success. The review-store concurrency between a running daemon and these CLI processes is 018d scope; this epic makes both writers exist.

---

## NEC-006: No cold catch-up on daemon start

**Issue.** Nothing calls `requestResync()`; the only boot-time reconciliation is auto-brood, which fires only on empty projects. Offline edits and renames are never reconciled on an already-brooded project.

**Evidence** (change-detection review H1; NECTAR-ISSUES NEC-006):

- `RegistrationService.start()` only starts the watcher (`src/registration/service.ts:133-135`); nothing calls `requestResync()` at boot.
- The daemon's only catch-up trigger is auto-brood, gated to fire only when the project has no rows or no projection (`src/daemon.ts:460-497`, `shouldAutoBrood` gating).
- The spec's hard case, "the daemon boots after the laptop was closed, the user moved and edited a dozen files offline" (`identity-and-reassociation.md`, "Live watch vs cold catch-up"), has no code path at all on an already-brooded project. The persisted-fingerprint machinery built for exactly this scenario (AC-8, `src/registration/service.ts:19-23`) is currently unreachable in the scenario it was built for.
- There is also no ordering contract between `triggerAutoBrood()` (background, `src/daemon.ts:556`) and any future `service.start()`: brooding mints directly without the ladder (`src/brooding/pipeline.ts:343-345,406-408`), so a watcher running during a brood can race it (mint from the watcher while the brood re-inserts).

**Failure mode.** Every offline edit or move is invisible until the next live watch event happens to touch that exact file. On a laptop-lid workflow this is the common case, not the edge case.

**Fix direction** (expanded from the review's fix direction):

1. Call `requestResync()` immediately after the registration service starts. The resync settle already exists and dedupes through the same ladder, so cold catch-up is a one-call trigger once construction (NEC-001) lands.
2. Sequence the pipeline start after auto-brood settles: `service.start()` (and therefore the resync) must not begin until `triggerAutoBrood()`'s completion is observable (the `bootSettled` handle from NEC-033 is the natural sequencing point). This closes the watcher-during-brood mint race without a lock: on a first boot the order is brood, then watch, then resync; on a warm boot auto-brood is a no-op and resync runs promptly.
3. Optionally (shared with 018c's watcher-loss backstop): a slow periodic resync on the existing `PollLoop`. This epic establishes the resync-on-start contract; 018c decides the periodic cadence alongside watcher error recovery.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-018b.1 | Given a daemon started with Deep Lake credentials resolved, when `start()` completes, then a `RegistrationService` is constructed with `WatchIntake`, `createDiskRegistrationFs`, an ignore predicate, `createTlshFuzzyStep(DEFAULT_TUNABLE_FUZZY_CONFIG)`, and `FilePendingReviewStore`, and the NodeFS watcher is running. |
| AC-018b.2 | Given a running daemon, when a file inside the workspace is created, edited, renamed, moved, deleted, or copied on disk, then the settled event flows through the re-association ladder and the resulting identity/version writes reach the durable Deep Lake store (via the bridge), observable by a subsequent store read. |
| AC-018b.3 | Given a daemon `shutdown()`, then the registration service and watcher are stopped before the lock is released, and no watch event is processed after shutdown resolves. |
| AC-018b.4 | Given ladder actions applied through the sync/async bridge, then durable writes land in the order the ladder produced them, and a failed durable flush is surfaced (logged and visible to health) rather than silently dropped. |
| AC-018b.5 | Given a daemon booting on an already-brooded project, when `start()` completes, then `requestResync()` has been requested exactly once, sequenced after auto-brood settles, and files edited/moved/deleted while the daemon was down are reconciled through the ladder (edit appends a version row; move carries the nectar; delete marks the path missing). |
| AC-018b.6 | Given a first boot on an empty project (auto-brood fires), then the registration service does not process events until the auto-brood completes, and no path is double-minted by the watcher racing the brood. |
| AC-018b.7 | Given a daemon booting without Deep Lake credentials, then the daemon boots as today, the registration pipeline is not started, and the dormant watch leg is observable (health/log), not silent. |
| AC-018b.8 | Given the wired daemon, when `nectar brood` (mutating), `nectar prune`, and `nectar review-matches` are invoked, then each runs its real mechanics against the durable store and exits 0 on success; none exits 2 as a wiring stub. |
| AC-018b.9 | Given the full loop, an integration-style test demonstrates watch-edit-reassociate end to end: start daemon, edit a file on disk, observe the ladder-appended version row with `describe_status = 'pending'` in the store (satisfies index AC-4). |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/daemon.ts` | modify | Construct/start/stop the registration pipeline in `start()`/`shutdown()`; sequence `service.start()` + resync after auto-brood settles |
| `src/registration/store-bridge.ts` | create | The sync/async bridge: in-memory mirror over the async Deep Lake store, ordered write-through, hydration, flush-failure surfacing |
| `src/registration/service.ts` | modify | Resync-on-start hook (if the trigger lives in the service rather than the daemon); no behavior change to the ladder |
| `src/cli.ts` | modify | Unstub `brood` (mutating), `prune`, `review-matches`: construct the durable store path and run the real mechanics; remove the exit-2 notices |
| `src/index.ts` | modify | Export the bridge (the pipeline exports at `src/index.ts:127-128,163-164` gain their production consumer) |
| `src/health.ts` | modify | Surface watch-leg status (running / dormant-no-credentials) |
| `test/registration-service.test.ts` | modify | Resync-on-start ordering; bridge-backed service behavior |
| `test/store-bridge.test.ts` | create | Bridge ordering, hydration, and flush-failure surfacing |
| `test/daemon.test.ts` | modify | Pipeline lifecycle (constructed on start, stopped on shutdown), no-credentials dormancy |
| `test/daemon-watch-integration.test.ts` | create | The end-to-end watch-edit-reassociate integration test over a real `fs.watch` |
| `test/cli.test.ts` (or the suite covering CLI verbs) | modify | `brood`/`prune`/`review-matches` no longer exit 2; run against an injected store |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018b.1, AC-018b.3 | `test/daemon.test.ts` | Daemon start constructs and starts the pipeline; shutdown stops it before lock release. |
| AC-018b.2, AC-018b.9 | `test/daemon-watch-integration.test.ts` | Real `fs.watch` end to end: edit a temp-workspace file, assert the pending version row lands in the store. The change-detection review notes no test ever exercises a real `fs.watch` (`start()` is untested; all tests drive `observe()` directly); this closes that gap. |
| AC-018b.4 | `test/store-bridge.test.ts` | Ordered write-through under interleaved ladder actions; injected flush failure is surfaced, not swallowed. |
| AC-018b.5 | `test/registration-service.test.ts` | Cold catch-up: pre-seeded store, files mutated "offline" in the fixture fs, boot triggers resync, ladder reconciles edit/move/delete (closes the review's "cold catch-up / resync-on-start ordering (H1)" gap). |
| AC-018b.6 | `test/daemon.test.ts` | Auto-brood-then-watch sequencing: events observed during a simulated brood are not processed until it settles; no double mint for the same path. |
| AC-018b.7 | `test/daemon.test.ts` | No-credentials boot: pipeline not constructed, health reports the watch leg dormant. |
| AC-018b.8 | `test/cli.test.ts` | Each of `brood`/`prune`/`review-matches` runs real mechanics and exits 0 against an injected store; exit-2 stub assertions removed. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md) : the PRD-018 program index.
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) : NEC-001, NEC-006.
- [`../../../notes/2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) : AUTHORITATIVE evidence: C1 (never instantiated; sync/async blocker) and H1 (no cold catch-up; brood/watch ordering race).
- [`../../../notes/2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) : H5, the daemon-side view of the same gap.
- [`../../../knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) : the ladder and the "Live watch vs cold catch-up" contract this epic makes real.
- [`./prd-018a-daemon-lock-and-lifecycle.md`](./prd-018a-daemon-lock-and-lifecycle.md) : the shutdown drain (`bootSettled`) this epic's sequencing builds on.
- [`./prd-018c-watcher-robustness-and-ignore-parity.md`](./prd-018c-watcher-robustness-and-ignore-parity.md) : the shared ignore predicate and watcher recovery that harden this wiring.
- [`./prd-018d-reassociation-ladder-correctness.md`](./prd-018d-reassociation-ladder-correctness.md) : ladder confidence and write atomicity for the pipeline this epic turns on.
- [`./prd-018g-enricher-correctness-and-concurrency.md`](./prd-018g-enricher-correctness-and-concurrency.md) : the brood/enricher arbitration that becomes load-bearing once this epic makes the race reachable.
