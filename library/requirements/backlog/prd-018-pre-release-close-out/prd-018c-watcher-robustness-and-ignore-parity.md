# PRD-018c: Watcher robustness and ignore parity

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

Once [PRD-018b](./prd-018b-wire-update-on-change.md) turns the watch pipeline on, a set of design gaps becomes user-visible. The two legs of the mission disagree about what the codebase is: brooding discovery honors `.gitignore` but skips the segment and graph-ignore rules, while the watcher honors segment rules but not `.gitignore`; the result is `.env` and `dist/` flowing toward the LLM describe path from one side and operator-excluded files described from the other. Directory renames emit directory-level events the classifier silently drops, so every child keeps a stale path. A single watcher error (Linux inotify `ENOSPC` is routine on large repos) kills live updates permanently while the daemon reports healthy. Case-only renames on APFS/NTFS classify as copies, minting a duplicate nectar and stranding history. The ladder's step-2 no-op never refreshes stored mtime/size, so after one branch switch every future observation re-hashes thousands of files forever. And any git failure during brooding discovery silently degrades to a walk that ignores `.gitignore`, with no indication in the dry-run report.

This epic makes the observation layer trustworthy: one ignore contract everywhere, no silently dropped event classes, a watcher that recovers, and honest discovery. Source evidence: [`2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) H2, H3, H4, M1, M2 (plus M3 as a shared fix), and [`2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) M3.

---

## Goals

- One shared ignore predicate per workspace (gitignore semantics union `ALWAYS_IGNORED_SEGMENTS` union graph-ignore prefixes), injected into brooding discovery, the watch intake, and the resync path.
- Directory renames and moves trigger reconciliation (resync or scoped enumerate) instead of being dropped.
- A watcher error restarts the watcher with backoff, triggers a resync on re-attach, and surfaces watcher liveness in `/health`.
- Case-only renames on case-insensitive filesystems are recognized as renames, not copies.
- The step-2 identical-hash no-op refreshes stored mtime/size so the step-1 fast path stays fast.
- A git failure during discovery is loud (warn or abort), never a silent `.gitignore`-blind walk; the dry-run report prints its discovery source.

## Non-Goals

- Constructing the pipeline itself, the store bridge, and resync-on-start. [PRD-018b](./prd-018b-wire-update-on-change.md) owns the wiring; this epic hardens what it wired.
- The TLSH confidence mapping and ladder/review-store write atomicity. [PRD-018d](./prd-018d-reassociation-ladder-correctness.md).
- Brooding memory residency and per-batch persistence. [PRD-018e](./prd-018e-brooding-durability-and-scale.md); this epic touches discovery only for ignore parity and git-failure honesty.
- The debounce max-wait, symlink-contract divergence between watch and resync, and backslash-in-filename corruption. Batched in [PRD-018l](./prd-018l-docs-truth-pass-and-cleanup.md) under NEC-042.
- Re-loading `graph-ignore.json` on change (change-detection review L3). Low severity, not in the NEC list as its own item; may ride along with the shared-predicate refactor if trivial, but is not a gate.

---

## NEC-007: Ignore rules drift between brooding and watching, in both directions

**Issue.** Brooding discovery uses `git ls-files` without segment/graph-ignore rules; the watcher uses segment rules without `.gitignore`. Each leg observes files the other would exclude.

**Evidence** (change-detection review H2):

- Brooding discovery uses `git ls-files --cached --others --exclude-standard` (`src/brooding/discovery.ts:8-12,132-146`): it honors `.gitignore`, but the git path applies neither `ALWAYS_IGNORED_SEGMENTS` nor `.honeycomb/graph-ignore.json` (no `isIgnored` call between lines 136-145; the ignore predicate is used only in the walk fallback at 148-156).
- The watch intake uses only `createDefaultIgnore` (`src/registration/ignore.ts:28,98-112`: `.git`/`node_modules`/`.honeycomb` plus graph-ignore prefixes); it does not honor `.gitignore`.
- The module docstring (`ignore.ts:8-9`) already acknowledges the default is a stopgap.

**Failure mode.** The watcher registers gitignored files brooding would never touch: `dist/`, `coverage/`, logs, and notably `.env`, whose content gets sha256'd, fingerprinted, persisted, and enrich-queued (`service.ts` into `ladder.ts:126-128,375`), meaning secrets flow toward the LLM describe path. In the other direction, brooding describes files the operator excluded via `graph-ignore.json`, and describes the committed `.honeycomb/nectars.json` projection itself (it is git-tracked; the git path skips the `.honeycomb` segment rule that protects the watcher). A file can be watched-but-never-brooded or brooded-but-never-watched.

**Fix direction.** Build one composed predicate per workspace: gitignore semantics (via `git check-ignore` or a cached `ls-files` set) union `ALWAYS_IGNORED_SEGMENTS` union graph-ignore prefixes. Inject the same predicate into `discoverFiles`, `WatchIntake`, and the resync path. Two design points to settle in implementation:

1. Gitignore semantics must work without spawning git per event: a cached tracked/untracked-eligible set refreshed on resync (with `git check-ignore` as the per-path fallback for cache misses) keeps the hot path cheap, and degrades per NEC-039's rules when git is unavailable.
2. Descent-time pruning: thread the predicate into `createDiskRegistrationFs`/`walk` so ignored directories are pruned during traversal rather than filtered after. The review's M3 documents the cost of the current shape: `walk()` recurses unconditionally (`src/registration/disk-fs.ts:51-67`) and the filter applies only per yielded path in `runCycle` (`src/registration/service.ts:193-196`), so every resync traverses all of `node_modules/` and `.git/`. The brooding walk fallback has the same shape and shares the fix.

---

## NEC-008: Directory renames are silently dropped

**Issue.** Directory-level watch events are discarded by the classifier, so a directory rename leaves every child at a stale path with no resync fallback.

**Evidence** (change-detection review H3):

- On Linux inotify (and commonly macOS FSEvents), renaming a directory emits events for the directory paths only, not per child.
- The settled handler stats the path; `statPath` returns null for a directory (`src/registration/disk-fs.ts:28`, `if (!st.isFile()) return null`), and `existsOnDisk` is false for dirs (`disk-fs.ts:39`).
- `classifyPath` then sees `existsOnDisk:false, known:false`, returns `null`, and the event is dropped (`src/registration/classify.ts:33-38`, `service.ts:231-233`). No resync is triggered.

**Failure mode.** `mv src/auth src/identity`: every file under the directory keeps its stale path in the store; the new paths are unregistered until an unrelated per-file event or a resync. The ladder never gets a chance to carry the nectars, so the spec's move-reconstruction promise fails at directory granularity.

**Fix direction.** In `processOne`, when a settled path either (a) exists but is a directory, or (b) is missing and is a prefix of known paths, request a resync (or a scoped enumerate of that subtree). Both signals are cheap with the data already in hand: the `knownPaths` set and one `statSync`. Prefer the scoped enumerate when the affected subtree is identifiable, falling back to a full resync; either way the ladder does the actual reconciliation, so directory moves become batch carries.

---

## NEC-009: A watcher error kills the watcher permanently

**Issue.** An `fs.watch` error is only logged; there is no restart, no poll fallback, and no health flag, so live updates die silently while the daemon reports healthy.

**Evidence** (change-detection review H4):

- `this.watcher.on("error", (err) => this.onError(err))` (`src/registration/fs-watch.ts:124`) and the service just logs it (`src/registration/service.ts:128`). After an error, Node's `FSWatcher` is typically dead; there is no re-`watch()`, no fallback to polling, no resync, no health-surface flag.

**Failure mode.** On Linux, `ENOSPC` (inotify `max_user_watches` exhausted, routine on large repos), or the workspace root being renamed/recreated (git worktree churn, `EPERM`/`EBUSY` on Windows), kills live updates permanently. This is the classic `fs.watch` production pitfall and the code has no story for it.

**Fix direction.** On watcher error: stop and close the watcher, retry `start()` with exponential backoff (bounded; repeated failure parks the watcher in a degraded state rather than looping hot), and call `requestResync()` on successful re-attach so the outage window is reconciled. Surface watcher liveness in `/health` (running / restarting / degraded), extending the watch-leg status field 018b introduces. As a belt-and-braces backstop, add the slow periodic resync tick on the existing `PollLoop` that the 018b fix direction reserved for this epic; the cadence must be slow enough that the descent-pruned walk (NEC-007 point 2) makes it cheap.

---

## NEC-034: Case-only renames on case-insensitive filesystems classify as copies

**Issue.** All path comparisons are case-sensitive string equality, but on APFS/NTFS the old casing still stats successfully after a case-only rename, so the ladder classifies the rename as a copy: a duplicate nectar is minted and the original is stranded.

**Evidence** (change-detection review M1):

- Comparisons are case-sensitive string equality: `knownPaths.has(relPath)` (`src/registration/service.ts:232`, `classify.ts:33`), the `latestVersionByPath` map keys, and step 3's guard `!deps.existsOnDisk(sourcePath)` (`src/registration/ladder.ts:145`).
- On APFS/NTFS, after `mv Foo.ts foo.ts`, `statSync("Foo.ts")` still succeeds (`disk-fs.ts:35-42`), so the old path never reads as missing.
- The new casing misses steps 1/2 (unknown path), matches by hash, sees the "source" still on disk, and is classified a copy: a fresh nectar is minted with provenance (`ladder.ts:153-154`); the original nectar's path stays `Foo.ts` forever, never carried, never missing, and never prunable (`prune-cli.ts:57` uses the same `existsOnDisk`).

**Failure mode.** Description history is stranded on a nectar whose path no longer exists as written, plus a duplicate identity for the same file. Both daemons' platforms' default filesystems (macOS, Windows) are affected.

**Fix direction.** Detect filesystem case sensitivity per workspace (probe once at service construction: create a temp file, stat the case-flipped name), and on case-insensitive volumes compare paths case-folded in `classifyPath`, `knownPaths`, and step-3's exists check, while preserving on-disk casing in stored rows. The fold applies to comparison keys only; stored paths keep their true casing so the projection and recall surfaces are unaffected.

---

## NEC-035: Step-2 no-op never refreshes stored mtime/size

**Issue.** When path and hash both match, the ladder returns a no-op without updating the stored `mtimeObserved`/`sizeBytes`, so any mtime-only change (touch, branch switch) permanently defeats the step-1 fast path.

**Evidence** (change-detection review M2):

- The identical-hash branch returns a no-op without updating stored `mtimeObserved`/`sizeBytes` (`src/registration/ladder.ts:131-135`).
- Every subsequent observation of that file fails the step-1 comparison (`ladder.ts:117-121`) and re-reads plus re-hashes the full content.

**Failure mode.** After one `git checkout` branch flip touching thousands of files, every future resync or cycle hashes all of them, every time; exactly the cost step 1 exists to avoid (spec: "It covers the vast majority of files on a typical boot").

**Fix direction.** On the step-2 identical-hash branch, refresh the stored stat: update the latest version row's mtime/size in place as a metadata touch (not a new version row), or record the fresh stat in a cheap side column. The write pattern must respect whatever durable-write decision [PRD-018g](./prd-018g-enricher-correctness-and-concurrency.md) makes for NEC-017 (no new fire-and-forget in-place UPDATE precedent on an append-only table without that epic's sign-off).

---

## NEC-039: Any git error silently degrades discovery to a `.gitignore`-blind walk

**Issue.** Every git failure mode, including `ENOBUFS` at the 64MB `maxBuffer`, collapses into the walk fallback, which does not honor `.gitignore`; the dry-run report never says which discovery source ran.

**Evidence** (brooding review M3):

- `spawnGitLsFiles` collapses every failure mode (git missing, non-zero exit, and notably `ENOBUFS` when `ls-files` output exceeds the 64MB `maxBuffer`, `src/brooding/discovery.ts:56`, `:77-98`) into `{ available: false }`, and `discoverFiles` silently walks instead (`discovery.ts:148-160`).
- The walk honors only `.git`/`node_modules`/`.honeycomb` plus `graph-ignore.json` (`src/registration/ignore.ts:28`, `:98-112`), not `.gitignore`. The walk also enumerates `node_modules` fully before filtering (`src/registration/disk-fs.ts:44-68` yields everything; `discovery.ts:156` filters after), the same descent-pruning defect as NEC-007 point 2.
- The dry-run report never prints the discovery source (`src/brooding/cli.ts:158-174`), so the user cannot tell the degradation happened.

**Failure mode.** Gitignored `dist/`, `coverage/`, virtualenvs, and secret files like `.env` are read, sent to the LLM, described, and persisted. On a big repo this can multiply the brood cost by orders of magnitude, invisibly.

**Fix direction.** Distinguish "git not present" (the walk fallback is legitimate) from "git present but errored" (warn loudly, or abort the brood with a clear error; for `ENOBUFS` specifically, switch to streaming or raise the buffer rather than degrading). Surface `source` (git vs walk, and why) in the dry-run report and in the brood result. Prune ignored directories inside the walk (shared fix with NEC-007). Once the NEC-007 shared predicate lands, the walk fallback's blast radius shrinks (segment plus graph-ignore rules always apply), but the loud-failure behavior is still required because gitignore semantics are only fully available from git itself.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-018c.1 | Given a workspace with a `.gitignore` entry, an `ALWAYS_IGNORED_SEGMENTS` match, and a `graph-ignore.json` prefix, when brooding discovery, the watch intake, and a resync each evaluate the same paths, then all three exclude exactly the same set (the composed predicate is shared, not reimplemented). |
| AC-018c.2 | Given a gitignored file (for example `.env`), when the watcher observes an edit to it, then no version row is appended and no content is fingerprinted or enrich-queued. |
| AC-018c.3 | Given a `graph-ignore.json`-excluded file that is git-tracked, when a brood runs via the git discovery path, then the file is not described; and the committed `.honeycomb/nectars.json` is never described by any discovery path. |
| AC-018c.4 | Given a resync or brooding walk over a workspace containing `node_modules/`, then ignored directories are pruned at descent time (no recursion into them), not filtered after enumeration. |
| AC-018c.5 | Given a directory rename observed as a directory-level event, when the settled path is a directory or is missing while being a prefix of known paths, then a resync (or scoped enumerate of that subtree) is requested, and after it completes every child's nectar is carried to its new path. |
| AC-018c.6 | Given a watcher error, when the error fires, then the watcher is closed and restarted with backoff, a `requestResync()` runs on successful re-attach, and `/health` reflects the watcher state (running / restarting / degraded) throughout. |
| AC-018c.7 | Given repeated watcher restart failures exceeding the backoff bound, then the watcher parks in a degraded state visible in `/health`, and the periodic resync backstop continues to reconcile changes. |
| AC-018c.8 | Given a case-insensitive filesystem (probed per workspace), when a file is renamed only by case, then the ladder classifies it as a rename (nectar carried, path updated to the new casing) and no duplicate nectar is minted; on a case-sensitive filesystem behavior is unchanged. |
| AC-018c.9 | Given a step-2 observation (same path, same hash, changed mtime/size), then the stored mtime/size are refreshed without a new version row, and the next observation of the unchanged file passes the step-1 fast path without re-hashing. |
| AC-018c.10 | Given git is present but `git ls-files` fails (non-zero exit or `ENOBUFS`), when discovery runs, then the failure is surfaced loudly (warning or abort per the chosen policy), never a silent `.gitignore`-blind walk; given git is genuinely absent, the walk fallback runs with the shared predicate applied. |
| AC-018c.11 | Given `nectar brood --dry-run`, then the report states the discovery source (git or walk) and, when degraded, the reason. |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/registration/ignore.ts` | modify | The composed shared predicate: gitignore semantics union segments union graph-ignore; construction per workspace |
| `src/brooding/discovery.ts` | modify | Apply the shared predicate on the git path; distinguish git-absent from git-errored; surface discovery source; streaming or raised buffer for `ENOBUFS` |
| `src/registration/disk-fs.ts` | modify | Thread the predicate into `walk` for descent-time pruning; directory-awareness support for NEC-008 |
| `src/registration/service.ts` | modify | Directory-event resync trigger in `processOne`; watcher restart-with-backoff orchestration; case-fold comparison keys on insensitive volumes |
| `src/registration/fs-watch.ts` | modify | Error path supports close-and-restart; expose watcher state |
| `src/registration/classify.ts` | modify | Case-folded `known` lookup; directory signal pass-through |
| `src/registration/ladder.ts` | modify | Step-2 stat refresh; case-folded step-3 exists check |
| `src/registration/prune-cli.ts` | modify | Case-folded `existsOnDisk` check so carried case-renames are not prunable ghosts |
| `src/brooding/cli.ts` | modify | Dry-run report prints discovery source and degradation reason |
| `src/health.ts` | modify | Watcher liveness field (extends 018b's watch-leg status) |
| `test/ignore.test.ts` | modify | Shared-predicate composition and parity cases |
| `test/registration-service.test.ts` | modify | Directory-rename resync; watcher error/recovery; case-only rename |
| `test/registration.test.ts` | modify | Step-2 stat refresh; case-folded ladder steps |
| `test/brooding.test.ts` | modify | Git-error loudness; dry-run source line; predicate applied on the git path |
| `test/disk-fs.test.ts` (or the suite covering `disk-fs.ts`) | modify/create | Descent-time pruning |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018c.1, AC-018c.2, AC-018c.3 | `test/ignore.test.ts` | Parity matrix: gitignored / segment-ignored / graph-ignored paths against discovery, intake, and resync; asserts identical exclusion (closes the review's "gitignore-vs-watch ignore parity (H2)" gap). |
| AC-018c.4 | `test/disk-fs.test.ts` | Walk over a fixture tree with `node_modules/` asserts no descent into pruned directories (syscall or visit count). |
| AC-018c.5 | `test/registration-service.test.ts` | Directory rename delivered as a dir-level event triggers resync; children carried (closes the "directory rename events (H3)" gap). |
| AC-018c.6, AC-018c.7 | `test/registration-service.test.ts` | Injected watcher error: restart with backoff, resync on re-attach, health state transitions; exhausted backoff parks degraded (closes the "watcher error/recovery (H4)" gap). |
| AC-018c.8 | `test/registration-service.test.ts` | Case-only rename on a simulated case-insensitive fs classifies as rename, not copy (closes the "case-insensitive paths (M1)" gap). |
| AC-018c.9 | `test/registration.test.ts` | Touch/branch-switch churn: step-2 refresh recorded; second observation takes the step-1 path with no content read (closes the "mtime-only churn re-hashing (M2)" gap). |
| AC-018c.10, AC-018c.11 | `test/brooding.test.ts` | Git-present-but-errored discovery warns or aborts (including simulated `ENOBUFS`); git-absent walks with the predicate; dry-run report includes the source line (closes the brooding review's "git-error walk degradation (M3)" gap). |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md) : the PRD-018 program index.
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) : NEC-007, NEC-008, NEC-009, NEC-034, NEC-035, NEC-039.
- [`../../../notes/2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) : AUTHORITATIVE evidence: H2, H3, H4, M1, M2, and M3 (descent pruning, shared fix).
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) : M3, the git-failure walk degradation this epic makes loud.
- [`../../../knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) : the move-reconstruction and step-1 fast-path contracts NEC-008/NEC-035 restore.
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) : the discovery contract NEC-039 hardens.
- [`./prd-018b-wire-update-on-change.md`](./prd-018b-wire-update-on-change.md) : the wiring this epic hardens; owns resync-on-start.
- [`./prd-018g-enricher-correctness-and-concurrency.md`](./prd-018g-enricher-correctness-and-concurrency.md) : owns the durable write pattern NEC-035's stat refresh must conform to.
- [`./prd-018l-docs-truth-pass-and-cleanup.md`](./prd-018l-docs-truth-pass-and-cleanup.md) : NEC-042 batch (debounce max-wait, symlink contract, backslash paths) deferred from this surface.
