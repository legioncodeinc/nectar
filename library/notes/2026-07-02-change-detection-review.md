# Change-Detection / Update-on-Change Review — 2026-07-02

Scope: `src/registration/*` (fs-watch, disk-fs, service, ladder, classify, copy-detect, tlsh, ignore, paths-safe, review-store, review-cli, prune-cli) and `src/poll-loop.ts`, audited against the mission statement ("update it upon change with NodeFS") and the identity spec (`library/knowledge/private/ai/identity-and-reassociation.md`, ADR-0001).

## Summary

The change-detection leg is well-factored and well-tested **as a library**: the debounced `WatchIntake`, the 5-step re-association ladder, copy provenance, prune, and review-matches all have unit coverage and honor the spec's deliberate gaps (unpinned TLSH thresholds, no nectar deletion outside `prune --confirm`). However, **none of it is wired into the running daemon** — no production code constructs `RegistrationService`, so nothing watches, nothing re-associates, prune and review-matches operate on nothing — which makes the "update it upon change" leg of the mission currently dead code. Beneath that headline, the design itself has real gaps a user would hit once wired: no cold catch-up on daemon start, ignore-contract drift between brooding (git-tracked semantics) and the watcher (segment rules), directory renames dropped silently, an unrecoverable watcher-error path, and a size-insensitive fuzzy-confidence mapping that will auto-carry the wrong nectar for tiny files (broken logic, not a tuning gap). Findings below are ordered by severity, each with file:line evidence.

---

## Critical

### C1. The entire update-on-change pipeline is never instantiated in production

- Evidence: `new RegistrationService(...)` appears **only in tests** (`test/registration-service.test.ts:62,75,101,129,145,173`, `test/security-remediation.test.ts:213`, `test/telemetry/metrics.test.ts:332`). `src/daemon.ts` never imports or constructs it; the daemon's worker boots with a no-op job source (`src/daemon.ts:366-367` — `source: options.jobSource ?? emptyJobSource`; `src/worker.ts:121-125`), so the `PollLoop` spins leasing nothing. `src/cli.ts:78-79` and `src/cli.ts:479-482` openly stub `prune` / `review-matches` as "durable wiring pending daemon integration."
- Failure mode: after brooding, no file edit, rename, move, delete, or copy is ever observed. The registry silently goes stale forever; `prune --confirm` deletes nothing; `review-matches` never has candidates. The mission's middle leg does not exist at runtime.
- Compounding blocker: `RegistrationService` consumes the **synchronous** `HiveGraphStore` (`src/registration/service.ts:93`, `src/registration/ladder.ts:87-88`), while the durable Deep Lake store is the async interface (`src/hive-graph/store.ts:111-149`). Even a one-line wiring change is not possible today; the service (or a sync/async bridge like the one brooding uses) is needed.
- Fix direction: wire `RegistrationService` + `createDiskRegistrationFs` + `createDefaultIgnore` + `createTlshFuzzyStep(DEFAULT_TUNABLE_FUZZY_CONFIG)` + `FilePendingReviewStore` into daemon `start()` (after brood settles — see H1), bridge to the async store, and start/stop it in the daemon lifecycle (`src/daemon.ts:523-559` / `572-580`). Until then, do not ship release notes claiming live update-on-change.

---

## High

### H1. No cold catch-up: offline changes are never reconciled, and there is no resync-on-start

- Evidence: `RegistrationService.start()` only starts the watcher (`src/registration/service.ts:133-135`); nothing calls `requestResync()` at boot. The daemon's only catch-up trigger is auto-brood, which fires **only when the project has no rows or no projection** (`src/daemon.ts:460-497`, `shouldAutoBrood` gating).
- Failure mode: the spec's hard case — "the daemon boots after the laptop was closed, the user moved and edited a dozen files offline" (`identity-and-reassociation.md`, "The re-association ladder" intro and "Live watch vs cold catch-up") — has no code path at all on an already-brooded project. Every offline edit/move is invisible until the next live watch event happens to touch that exact file. The carefully built AC-8 machinery (persisted fingerprints so fuzzy matching survives restart, `src/registration/service.ts:19-23`) is currently unreachable in exactly the scenario it was built for.
- Also a watching-before/after-brooding race: there is no ordering contract between `triggerAutoBrood()` (background, `src/daemon.ts:556`) and any future `service.start()`; brooding mints directly without the ladder (`src/brooding/pipeline.ts:343-345,406-408`), so a watcher running during brood can mint a path brood then re-inserts.
- Fix direction: call `requestResync()` immediately after `start()` (the resync settle already exists and dedupes through the same ladder), and sequence it after auto-brood completes; optionally a periodic resync on the poll loop as a watcher-loss backstop (see H4).

### H2. Ignore-contract drift: brooding and the watcher use different ignore rules, in both directions

- Evidence: brooding discovery uses `git ls-files --cached --others --exclude-standard` (`src/brooding/discovery.ts:8-12,132-146`) — honors `.gitignore`, but the git path applies **neither** `ALWAYS_IGNORED_SEGMENTS` **nor** `.honeycomb/graph-ignore.json` (no `isIgnored` call between lines 136-145; the ignore predicate is only used in the walk fallback at 148-156). The watch intake uses only `createDefaultIgnore` (`src/registration/ignore.ts:28,98-112`: `.git`/`node_modules`/`.honeycomb` + graph-ignore prefixes) — it does **not** honor `.gitignore`.
- Failure modes (once C1 is wired):
  - Watcher registers gitignored files brooding would never touch: `dist/`, `coverage/`, logs, and notably `.env` — its content gets sha256'd, fingerprinted, persisted, and enrich-queued (`service.ts` -> `ladder.ts:126-128,375`), i.e. secrets flow toward the LLM describe path.
  - Brooding describes files the operator explicitly excluded via `graph-ignore.json`, and describes the committed `.honeycomb/nectars.json` projection itself (it is git-tracked; the git path skips the `.honeycomb` segment rule that protects the watcher).
  - Drift means a file can be watched-but-never-brooded or brooded-but-never-watched — the two legs of the mission disagree about what the codebase *is*.
- Fix direction: build one composed predicate per workspace — `gitignore-semantics (via git check-ignore or a cached ls-files set) ∪ ALWAYS_IGNORED_SEGMENTS ∪ graph-ignore prefixes` — and inject the same predicate into `discoverFiles`, `WatchIntake`, and the resync path. The module docstring (`ignore.ts:8-9`) already acknowledges the default is a stopgap.

### H3. Directory renames/moves are silently dropped (all children go stale)

- Evidence: on Linux inotify (and commonly macOS FSEvents), renaming a directory emits events for the **directory paths only**, not per child. The settled handler stats the path; `statPath` returns null for a directory (`src/registration/disk-fs.ts:28` `if (!st.isFile()) return null`), and `existsOnDisk` is false for dirs (`disk-fs.ts:39`). `classifyPath` then sees `existsOnDisk:false, known:false` → `null` → dropped (`src/registration/classify.ts:33-38`, `service.ts:231-233`). No resync is triggered.
- Failure mode: `mv src/auth src/identity` — every file under the directory keeps its stale path in the store; the new paths are unregistered until some unrelated per-file event or a (currently nonexistent, H1) resync. The re-association ladder never even gets a chance to carry the nectars, so the spec's move-reconstruction promise fails at directory granularity.
- Fix direction: in `processOne`, when a settled path either (a) exists but is a directory, or (b) is missing and is a **prefix** of known paths, request a resync (or a scoped enumerate of that subtree). Both signals are cheap to detect with the data already in hand (`knownPaths` set, one `statSync`).

### H4. Watcher error/death is unrecoverable — silent permanent staleness

- Evidence: `this.watcher.on("error", (err) => this.onError(err))` (`src/registration/fs-watch.ts:124`) and the service just logs it (`src/registration/service.ts:128`). After an error, Node's `FSWatcher` is typically dead; there is no re-`watch()`, no fallback to polling, no resync, no health-surface flag.
- Failure mode: on Linux, `ENOSPC` (inotify `max_user_watches` exhausted — routine on large repos), or the workspace root being renamed/recreated (git worktree churn, `EPERM`/`EBUSY` on Windows), kills live updates permanently while the daemon reports healthy. This is the classic fs.watch production pitfall and the code has no story for it.
- Fix direction: on watcher error, stop/close, retry `start()` with backoff, and `requestResync()` on successful re-attach; surface watcher liveness in `/health`. A slow periodic resync tick on the existing `PollLoop` is a cheap belt-and-braces backstop.

### H5. Tiny-file fuzzy confidence is broken: unrelated small files auto-carry the wrong nectar

- Evidence: confidence is `1 - distance/MAX_DISTANCE` with fixed `MAX_DISTANCE = 801` (`src/registration/tlsh.ts:42,154-158`). A file of N bytes yields only N−2 trigrams, so two **completely unrelated** ~10-byte files (each occupying ≤8 of 128 buckets; quartiles all 0, so the body is an occupancy bitmap) have body distance ≤ 6×16 = 96, length distance 0 (same size bucket), checksum 1 → distance ≤ 97 → confidence ≥ 0.879, above the operator default `highConfidence: 0.85` (`tlsh.ts:191-194`). The floor `MIN_FUZZY_BYTES = 3` (`tlsh.ts:170`) only blocks ≤2-byte content; the tie guard (`tlsh.ts:229-231,237`) only helps when two candidates tie exactly.
- Failure mode: delete a tiny file (a `.gitkeep`-sized stub, a tiny config) and create any other tiny file of similar size → step 4 **auto-carries** the missing nectar and its description history onto unrelated content (`ladder.ts:167-189`). The spec is explicit that this is the worst outcome: "A mis-association is worse than a new nectar because it corrupts the history chain" (`identity-and-reassociation.md`, "What re-association explicitly does not do"). Mid-size files (~30-300 bytes) land in the review band instead → review-queue spam. This is not the deliberately-unspecified threshold; it is the confidence *mapping* being size-insensitive (the effective max distance for small inputs is far below 801, so the normalized score is inflated).
- Fix direction: normalize distance by an input-size-aware achievable maximum (or gate: require a minimum trigram count, e.g. raise the abstain floor to ~50-100 bytes), and/or scale confidence by evidence mass. Keep the band edges tunable as spec'd — fix the score, not the threshold.

---

## Medium

### M1. Case-only renames on case-insensitive filesystems (macOS/Windows defaults) mint a duplicate and strand history

- Evidence: all path comparisons are case-sensitive string equality — `knownPaths.has(relPath)` (`src/registration/service.ts:232`, `classify.ts:33`), `latestVersionByPath` map keys, and step 3's guard `!deps.existsOnDisk(sourcePath)` (`src/registration/ladder.ts:145`). On APFS/NTFS, after `mv Foo.ts foo.ts`, `statSync("Foo.ts")` still succeeds (`disk-fs.ts:35-42`), so the old path never reads as missing.
- Failure mode: the new casing misses step 1/2 (unknown path), matches by hash, sees the "source" still on disk → classified a **copy** → fresh nectar minted with provenance (`ladder.ts:153-154`); the original nectar's path stays `Foo.ts` forever — never carried, never missing, and never prunable (`prune-cli.ts:57` uses the same `existsOnDisk`). Description history is stranded on a nectar whose path no longer exists as written.
- Fix direction: detect filesystem case sensitivity per workspace (probe once), and on case-insensitive volumes compare paths case-folded in `classifyPath`/`knownPaths`/step-3's exists check (while preserving on-disk casing in stored rows).

### M2. Step-2 "touch" no-op never refreshes mtime/size — the step-1 fast path degrades permanently

- Evidence: when the path matches and the hash is identical, the ladder returns a no-op without updating the stored `mtimeObserved`/`sizeBytes` (`src/registration/ladder.ts:131-135`).
- Failure mode: any mtime-only change (touch, `git checkout` branch flips, rsync) leaves the stored mtime stale forever; every subsequent observation of that file fails the step-1 comparison (`ladder.ts:117-121`) and re-reads + re-hashes the full content. After one branch switch touching thousands of files, every future resync/cycle hashes all of them, every time — exactly the cost step 1 exists to avoid (spec: "It covers the vast majority of files on a typical boot").
- Fix direction: on the step-2 identical-hash branch, update the latest version row's mtime/size in place (a metadata touch, not a new version row) or append nothing but record the fresh stat in a cheap side column.

### M3. Resync walks the entire ignored tree (node_modules) before filtering

- Evidence: `walk()` recurses unconditionally (`src/registration/disk-fs.ts:51-67`); the ignore filter is applied only afterwards, per yielded path, in `runCycle` (`src/registration/service.ts:193-196`).
- Failure mode: every full resync (null-filename event, and the fix for H1/H3/H4 will add more) does a complete readdir traversal of `node_modules/` and `.git/` — tens of thousands of wasted syscalls per settle on a normal JS repo.
- Fix direction: thread the ignore predicate into `createDiskRegistrationFs`/`walk` and prune ignored directories at descent time (the brooding walk fallback has the same shape and would share the fix).

### M4. Registry updates are multi-write and non-atomic

- Evidence: mint = `insertIdentity` then `appendVersion` (`src/registration/ladder.ts:370-374`); edit = `appendVersion` then `touchIdentity` (`ladder.ts:275-276`); carry = same pair (`ladder.ts:312-313`); review-accept = carry → `pendingReviews.remove` → `deleteNectar(minted)` (`src/registration/review-cli.ts:88-115`).
- Failure mode: a crash between writes leaves (a) an identity with zero version rows, (b) a version row whose identity's `lastUpdateDate` is stale — which feeds prune eligibility directly (`src/registration/prune-cli.ts:58-61`), or (c) after an accepted review, two identities pointing at one path (carry landed, placeholder delete didn't). None of these self-heal explicitly.
- Fix direction: batch each ladder action into a single store transaction (the async Deep Lake store bridge from C1 is the right place), or add an idempotent sweep (orphan identities, stale lastUpdateDate) to the resync cycle.

### M5. `FilePendingReviewStore` loses updates under the intended daemon+CLI concurrency

- Evidence: each mutation is read-whole-file → modify → atomic-rename write (`src/registration/review-store.ts:128-140`, write at 111-126). The comment (109-110) is honest that only torn-file atomicity is guaranteed, not read-modify-write serialization — but the *stated purpose* of the file store is "a separate `review-matches` CLI process can see candidates a daemon queued" (`review-store.ts:12-14`), i.e. exactly two concurrent writers.
- Failure mode: daemon `add()` racing CLI `remove()` → either the accepted/rejected candidate resurrects, or a freshly queued candidate is silently dropped.
- Fix direction: an append-only journal (one JSON line per add/resolve, compacted by the CLI), or an advisory lock file around the read-modify-write, mirroring the daemon's existing single-instance lock pattern.

### M6. Review queue grows without bound and duplicates per re-observation

- Evidence: every ladder pass that lands in the review band mints a **new** candidate id (`src/registration/service.ts:285-299`, `mintNectar()` per add); `add()` dedupes by id only (`review-store.ts:128-131`). `skip` keeps entries forever (`review-cli.ts:132-134`); there is no TTL and no dedup by `(candidateNectar, newPath)`.
- Failure mode: a file that keeps being edited while its review is pending enqueues a fresh (now partly stale — each carries its own `mintedNectar`) candidate per settle; the operator sees N near-identical reviews for one path, and accepting an old one carries stale hash/mtime metadata (`review-cli.ts:88-100`).
- Fix direction: dedupe/replace by `(candidateNectar, newPath)` on add, and drop pending entries whose `newPath`'s latest content hash no longer matches `contentHash` at review time.

### M7. Step-4 candidate scan is O(known-files) disk stats per new file

- Evidence: `missingCandidates` filters `listLatestVersions` by a live `existsOnDisk` stat per known path (`src/registration/ladder.ts:224-228`), invoked per unmatched new file (`ladder.ts:162`).
- Failure mode: a batch of M genuinely-new files in an N-file repo costs M×N `statSync` calls (plus M×N tenancy list materializations) inside one settle cycle — a `git checkout` of a large new feature branch stalls the cycle for seconds-to-minutes.
- Fix direction: compute the missing set once per batch in `runCycle` (it already snapshots `knownPaths`, `service.ts:204`) and pass it into `ladderDeps`.

---

## Low

### L1. Debounce has no max-wait: a hot file never settles

- Evidence: every observation clears and re-arms the per-path timer (`src/registration/fs-watch.ts:104-116`, 500 ms default at :39).
- Failure mode: a file appended to more often than every 500 ms (a live log, a build artifact being streamed) starves indefinitely; registration happens only when writes pause. Suggested fix: cap total deferral (e.g. fire after 10× debounce regardless).

### L2. In-root file symlinks: watched but invisible to resync

- Evidence: `walk()` skips **every** symlink (`src/registration/disk-fs.ts:59`), including symlinks whose target is inside the root, while `statPath`/`existsOnDisk` accept them via `realpathContained` (`disk-fs.ts:19-27,35-42`).
- Failure mode: a symlinked file registered via a live watch event will never be re-listed by a resync; behavior differs by which path discovered it. Pick one contract (suggest: skip symlinks in both, matching git's treatment of symlinks as non-content).

### L3. `graph-ignore.json` is read once at construction

- Evidence: prefixes are loaded when `createDefaultIgnore` is called and captured in the closure (`src/registration/ignore.ts:98-103`).
- Failure mode: edits to the ignore file take effect only on daemon restart, and — ironically — the edit event itself is under `.honeycomb/` and thus ignored. Suggest reloading on resync.

### L4. `PollLoop`: an external `runOnce()` racing the pump inflates backoff

- Evidence: a pump tick that arrives while an externally invoked `runOnce()` is in flight gets `false` from the in-flight guard (`src/poll-loop.ts:98-99`) and treats it as idle (`poll-loop.ts:129-135`), stepping toward the ceiling even though work just ran. Cosmetic — the next real tick resets to floor. Otherwise the loop is solid (generation guard correctly prevents double-scheduling across stop/start; `test/poll-loop.test.ts` covers the core).

### L5. Stat/read tear inside a settle

- Evidence: `sizeBytes`/`mtimeObserved` are captured at stat time; content is read later at hash time (`src/registration/service.ts:253-258`, `disk-fs.ts:29-33`).
- Failure mode: an editor atomic-save (write temp + rename) landing between stat and read produces a version row with the new content hash but the old size/mtime. It self-corrects on the next observation (via the step-2 path), but the recorded metadata for that version is wrong. Suggest re-stat after read and retry once on mismatch. (The atomic-save pattern itself is otherwise handled well: the temp file created-and-deleted inside the debounce window classifies to null, `classify.ts:8-9,38`.)

### L6. Step-3 source selection is iteration-order-dependent with duplicate content

- Evidence: `latestVersionByHash` returns the first latest-version match in store order (`src/hive-graph/memory-store.ts:102-107`); the ladder then branches move-vs-copy on **that one** path's disk presence (`src/registration/ladder.ts:143-154`).
- Failure mode: two identical-content files A (still on disk) and B (deleted); a new file with that content should be a step-3 carry of B, but if the lookup returns A the event is classified a copy and B's nectar goes unclaimed. Suggest: when the hash matches multiple latest versions, prefer a missing-path match before concluding "copy."

---

## Test-coverage notes (what IS covered vs. not)

Covered well (`test/registration.test.ts`, `test/registration-service.test.ts`, `test/ignore.test.ts`, `test/poll-loop.test.ts`, `test/tlsh.test.ts`, `test/prune.test.ts`, `test/review-matches.test.ts`): debounce burst-collapse and path normalization; null-filename → resync settle; ignore filtering (segments, both graph-ignore forms, malformed fail-open); all five ladder steps including move reconstruction end-to-end, copy provenance, fuzzy high/review bands, fingerprint persistence across restart (AC-8); per-path failure isolation; prune preview/confirm/grace/present-file; review accept/reject/stale; poll-loop backoff, overlap guard, idempotent start/stop.

Not covered (mirrors the findings): no test ever exercises a **real** `fs.watch` (`start()` is untested; all tests drive `observe()` directly), watcher error/recovery (H4), directory rename events (H3), case-insensitive paths (M1), cold catch-up / resync-on-start ordering (H1), gitignore-vs-watch ignore parity (H2), tiny-file fuzzy behavior at the default bands (H5 — `tlsh.test.ts` uses ~100+-byte fixtures), concurrent `FilePendingReviewStore` writers (M5), or mtime-only churn re-hashing (M2).
