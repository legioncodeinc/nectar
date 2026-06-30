# PRD-006a: `node:fs.watch` Intake + Debounce

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M

## Overview

This sub-PRD owns the **disk-observation signal**: how hivenectar attaches `node:fs.watch` to the workspace, how each `(eventType, filename)` observation is filtered and routed, and how a burst of observations coalesces into one settled cycle through `setTimeout`/`clearTimeout` debounce. It mirrors Honeycomb's `file-watcher.ts` pattern deliberately and exclusively — `chokidar` is not a dependency (locked decision #4 in [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md)).

`fs.watch` delivers uncorrelated observations: an editor save that rewrites a file in place, a rename, a delete-then-recreate, and a copy all arrive as `(eventType, filename)` tuples with no inherent move/copy semantics. This sub-PRD's job is only to (a) capture those observations, (b) coalesce a burst into one settled cycle, and (c) hand the set of touched paths to the classifier (006b). It does **not** decide nectar outcomes — that is the ladder's job (006d). The corpus is explicit that "the watcher is only the signal that work is needed" ([`identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) § "Live watch vs cold catch-up").

> **Correction noted.** Several prose passages in the Hivenectar corpus say "chokidar." That is wrong against both decision #4 and the Honeycomb code: the watcher is `node:fs.watch` (`honeycomb/src/daemon/runtime/services/file-watcher.ts:341, 370`). This PRD uses `fs.watch` throughout; the corpus's "chokidar" references are to be corrected before implementation.

## Goals

- Mirror `node:fs.watch` directory-level intake (`file-watcher.ts:333-352`), so a delete-then-recreate write pattern still fires when the original inode is gone.
- Mirror the `setTimeout`/`clearTimeout` debounce scheduler (`file-watcher.ts:300-316`) so a burst of observations coalesces into one settled cycle.
- Pin the debounce window default at `500 ms` (`file-watcher.ts:177`), flagged as a default pending implementation confirmation.
- Mirror the "fire-and-forget with intent" settled handler (`file-watcher.ts:234-293`): all errors are caught internally and the watcher keeps running; the running cycle's promise is tracked so it can be drained.
- Define the workspace-scope and ignore contract (reuse CodeGraph discovery's ignore rules — no hivenectar-specific ignore list).

## Non-Goals

- Classifying an observation into new/changed/missing — 006b.
- Deciding a nectar outcome (carry / append / mint / review) — 006c, 006d.
- The brooding full-codebase discovery scan — PRD-007 (this sub-PRD is the live-watch intake; brooding is the cold extreme).
- The daemon worker loop that invokes the settled cycle on a lease — PRD-002.

## The watcher is `node:fs.watch`, mirroring `file-watcher.ts`

### Directory-level watch, not file-level

`file-watcher.ts:333-352` attaches `fs.watch` to the **directory**, not individual files, with a `watchedFiles` filter on the emitted `filename`. The comment block at `file-watcher.ts:320-331` states the rationale: a directory-level watch catches a "delete then recreate" write pattern (common in editors) even when the original inode is gone, and on Node 22 / Linux it is inotify-backed while Windows uses `ReadDirectoryChangesW`, "both stable enough for our use case given the 500ms debounce absorbs any missed events."

Hivenectar mirrors this. The watch attaches at the project workspace root and recurses into subdirectories (one `fs.FSWatcher` per watched directory, tracked in an array as `file-watcher.ts:188` does). Each emitted `(eventType, filename)` is normalized to an absolute path and filtered through the ignore contract (below) before being routed to the debounce scheduler. Observations whose `filename` is `null`/`undefined` (some platforms emit null filenames on directory-level events, per `file-watcher.ts:342-345`) trigger a full resync settle rather than a single-path classification.

### Why NOT chokidar

Decision #4 ([`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md)) records the rejection: chokidar is a new dependency, it diverges from Honeycomb's deliberate choice, and the marginal benefit is nil because the re-association ladder (006d) already reconstructs moves from uncorrelated events plus a missing-files set. Honeycomb's `file-watcher.ts` is the established, in-repo `fs.watch` pattern; importing Honeycomb's file-watcher module directly is also rejected (it would couple across the process boundary ADR-0002 established). Hivenectar therefore **mirrors the pattern** — same `fs.watch` + `setTimeout` shape, separate implementation, no cross-process import.

### The `fs.watch` contract — what it does and does not give

| Gives | Does NOT give |
|---|---|
| `(eventType: 'change' \| 'rename', filename: string \| null)` per observation | Correlated add/change/unlink stream (chokidar's model) |
| The touched `filename` (relative to the watched dir) | Move/rename semantics (no "this file was renamed from X to Y") |
| A near-real-time signal that disk changed | The post-change file content (the settled cycle reads it) |

The ladder's step-3 and step-4 (006d) **reconstruct moves** from this uncorrelated stream: a rename arrives as a `rename` observation at the old path (→ missing) plus an observation at the new path (→ new), and the missing-files set carries the old path until the new path's content hash matches it. This is documented in `identity-and-reassociation.md` § "Live watch vs cold catch-up": "the daemon debounces the path, refreshes the missing-files set, hashes the new path when needed, and lets step 3 carry the nectar when the new content matches a missing file's latest hash."

## The debounce scheduler

`file-watcher.ts:300-316` defines `scheduleSyncCycle`: if a handle is already pending, `clearTimeout` it and reschedule, so a burst of edits coalesces into one cycle:

```ts
function scheduleSyncCycle(): void {
    if (debounceHandle !== null) {
        clock.clearTimeout(debounceHandle);
    }
    debounceHandle = clock.setTimeout(() => {
        debounceHandle = null;
        currentCyclePromise = runSyncCycle().finally(() => {
            currentCyclePromise = null;
        });
    }, debounceMs);
}
```

Hivenectar mirrors this exactly. Every qualifying observation calls the scheduler; the scheduler always (re)sets a single `setTimeout(debounceMs)` handle. The touched path is appended to a per-cycle "pending paths" set (Hivenectar's addition over Honeycomb's identity-file sync, which keys off a fixed canonical set). When the timer fires, the settled handler runs once over the accumulated set.

### Debounce window — DEFAULT

> **`debounceMs = 500` — DEFAULT — confirm before implementation.**

The default mirrors `file-watcher.ts:177` (`debounceMs = 500` in the `createFileWatcherService` destructure) and the comment at `file-watcher.ts:331` ("the 500ms debounce absorbs any missed events"). The 500 ms window absorbs an editor save burst (many editors write a temp file then rename, generating several observations within tens of milliseconds) and covers the small event-loss window inherent to `fs.watch` on some platforms. It is exposed as a service dependency (as `file-watcher.ts:177` does), so an operator or test can override it via the daemon config or the injected `clock`. The value is flagged, not pinned by the corpus.

### The settled handler — fire-and-forget with intent

`file-watcher.ts:234-293` (`runSyncCycle`) is the settled handler. Its shape is the template Hivenectar mirrors:

1. Log the cycle start (`file-watcher.ts:239-240`).
2. Do the work (Honeycomb: sync harness copies + git commit; Hivenectar: classify the pending paths per 006b, then resolve each via the ladder per 006d).
3. Catch every error internally and log it; **the watcher keeps running** (`file-watcher.ts:254-258, 288-292` comment: "Commit failure logged, watcher keeps running").

The running cycle's promise is stored in `currentCyclePromise` (`file-watcher.ts:186, 312-314`) "so tests can await it via `_waitForIdle()`" — in production it is fire-and-forget because `runSyncCycle` catches all errors. Hivenectar keeps the same pattern: the daemon worker's `_waitForIdle()` drains I/O in tests; in production the settled handler's internal try/catch is the only error surface. This is the "fire-and-forget with intent" discipline the code comment cites.

## The "respond to file change" handler mirrors `runGraphBuild`

The settled handler's body — discover → resolve → persist — mirrors `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` (`runGraphBuild`), the parallel "respond to file change" template in the CodeGraph surface. `runGraphBuild` composes already-built pieces end-to-end and returns the result as data; it adds no new graph logic. The shape Hivenectar mirrors:

1. **Aggregate** (analogous to `buildAggregateSnapshot`, `api.ts:248`) — for each pending path: stat the file, read content, compute `sha256(content)` and the TLSH fingerprint, and fetch the latest known version of that path + the missing-files set from Deep Lake (PRD-005 tables).
2. **Classify + resolve** (006b → 006c/006d) — map each path to new/changed/missing, then run the ladder per path.
3. **Persist atomically** (analogous to `writeSnapshotAtomic`, `api.ts:253`) — append the resulting `source_graph_versions` rows and update `source_graph` via the PRD-005 write patterns; regenerate the projection (PRD-011) at cycle end.

The handler never throws out of the cycle: a persist failure for one path is logged and the cycle continues with the next path, mirroring `runSyncCycle`'s per-target error logging at `file-watcher.ts:247-253`.

## Workspace scope and the ignore contract

Hivenectar does not maintain its own ignore list. Discovery (brooding, PRD-007) reuses the CodeGraph's `git ls-files --cached --others --exclude-standard -z` discovery plus the `~/.honeycomb/graph-ignore.json` per-repo ignore file (carried from [`brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "File discovery"). The live-watch intake honors the **same** ignore contract: an observation whose path matches the CodeGraph ignore rules (or sits outside the project workspace root) is dropped before reaching the scheduler — it never triggers a ladder cycle. "If a file is in the CodeGraph's discovery set, it is in Hivenectar's; if it is not, it is not" (`brooding-pipeline.md`). A hivenectar-specific ignore list would be a drift source and is a non-goal.

The watch root is the project workspace directory resolved by the daemon's tenancy scope (PRD-001/PRD-003 resolve `org`/`workspace`/`project_id`); re-association never crosses project boundaries (`identity-and-reassociation.md` § "What re-association explicitly does not do").

## Acceptance Criteria

- [ ] The watcher uses `node:fs.watch` attached at the directory level (one `FSWatcher` per watched directory, tracked in an array), mirroring `file-watcher.ts:333-352`; `chokidar` is NOT present in the dependency tree.
- [ ] A `null`/`undefined` `filename` observation triggers a full resync settle (mirrors `file-watcher.ts:342-345`), not a crash.
- [ ] The debounce scheduler (`scheduleSyncCycle` shape) cancels-and-reschedules on each qualifying observation so a burst coalesces into one cycle (mirrors `file-watcher.ts:300-316`).
- [ ] `debounceMs` defaults to `500` (mirrors `file-watcher.ts:177`), is injectable via the service deps, and is flagged **DEFAULT — confirm before implementation**.
- [ ] The settled handler catches all errors internally and the watcher keeps running (mirrors `runSyncCycle` at `file-watcher.ts:234-293`); the running cycle promise is tracked for test drain (`currentCyclePromise` pattern, `file-watcher.ts:312-314`).
- [ ] The settled handler follows the `runGraphBuild` discover→resolve→persist shape (`codebase/api.ts:234-261`); a per-path persist failure is logged and the cycle continues.
- [ ] Observations are filtered through the CodeGraph ignore contract before reaching the scheduler; no hivenectar-specific ignore list exists.
- [ ] Re-association never crosses the `project_id` boundary (`identity-and-reassociation.md`).

## Related

- [PRD-006 index](./prd-006-file-registration-protocol-index.md) — module scope + decision #4 context.
- [PRD-006b](./prd-006b-event-to-ladder-step-classification.md) — the classifier this intake feeds.
- [PRD-006d](./prd-006d-reassociation-ladder.md) — the ladder the settled handler invokes.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) § "Live watch vs cold catch-up" — the watcher-is-only-the-signal contract + the missing-files reconstruction rationale.
- [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) § "File discovery" — the CodeGraph ignore contract reused.
- [`MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md) decision #4 — the locked `fs.watch`-not-chokidar decision.
- [`honeycomb/src/daemon/runtime/services/file-watcher.ts:177-183, 234-316, 333-375`](../../../../honeycomb/src/daemon/runtime/services/file-watcher.ts) — the `fs.watch` + debounce pattern mirrored in full.
- [`honeycomb/src/daemon/runtime/codebase/api.ts:234-261`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts) — `runGraphBuild`, the parallel "respond to file change" template.
