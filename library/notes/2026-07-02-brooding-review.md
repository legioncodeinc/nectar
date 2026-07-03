# Brooding Pipeline Review — 2026-07-02

Scope: `src/brooding/*` plus its seams into `src/portkey/*`, `src/registration/ignore.ts`, the hive-graph store, and the daemon/API wiring that invokes the brood. Spec grounding: `library/knowledge/private/ai/brooding-pipeline.md` and `library/knowledge/private/ai/brooding-deep-dive/brooding-technical-specification.md`. Coverage baseline: `test/brooding.test.ts`.

## Summary

The brooding pipeline is well-factored and closely tracks the corpus in its constants, prompts, bucketing thresholds, cost reference table, CLI flags, and the three-rule resumability classifier — all of which are unit-tested. However, the implementation drifts from the spec on the single property the spec calls load-bearing: **incremental persistence**. Descriptions are accumulated in memory across the entire describe+embed stage and persisted only at the end, so a crash mid-brood loses all paid-for LLM work despite the code's own doc comments claiming otherwise. Around that core issue sit several problems that would bite a real user brooding a large repository: the daemon's enricher loop races the brood over the same `pending` rows (duplicate LLM spend, non-atomic `nextSeq`), whole-tree file bytes are held in memory for the duration of the run, a gateway outage or an output-token-truncated batch fans out into a solo-call retry storm, and the batch parser's positional fallback can silently attribute one file's description to another. Findings below are ordered by severity, each with file:line evidence and a fix direction. (Per the audit brief, the three deliberately-unspecified values — TLSH thresholds, symbol/directory nectars, review-matches sub-flag syntax — are not flagged.)

---

## Critical

### C1. Descriptions are accumulated in memory and persisted only after the entire describe+embed stage — a killed brood loses all paid LLM work

- Evidence: `src/brooding/pipeline.ts:434` (`describedByNectar` map), filled across the batch loop `pipeline.ts:439-460` and the solo loop `pipeline.ts:462-470`; embed at `pipeline.ts:472-478`; **first persist of any described row at `pipeline.ts:480-499`** (failed rows at `pipeline.ts:501-511`). Identical structure in the async pipeline: `src/brooding/pipeline-async.ts:321-357` (accumulate), `pipeline-async.ts:367-387` (persist).
- Spec contradiction: the tech spec states "Each [stage] produces a committed Deep Lake write before the next begins, which is what makes the pipeline resumable at every boundary" (`brooding-technical-specification.md:40`) and "Every write is committed before the next file is processed" (`:105`, restated at `:152`); `brooding-pipeline.md:126` says "Every nectar mint and every description write is a committed Deep Lake write, not an in-memory accumulation." The module's own header (`pipeline.ts:15-17`) repeats this claim — the code does the opposite for descriptions.
- Failure mode: the describe stage is the hours-long, most-fragile phase of a large brood (network, rate limits, laptop lid). Kill the process at 95% through Stage 4/5 and *zero* described rows exist; every file is still `pending`, so the next run re-describes everything — the full LLM cost is paid again. Resumability currently only protects against crashes *between* stages, not within the one stage that matters. A throwing embed provider (the `EmbedProvider` contract says never-rejects, `src/embeddings/provider.ts:44-52`, but a third-party implementation can violate it) would likewise reject `runBrood` after all spend and before any persist.
- Fix direction: persist each batch group's described+failed rows (and each solo result) immediately after the call returns, inside the Stage-4 loops; embed per chunk (or backfill embeddings afterward, matching the spec's `writeRows → embed` order). Keep the final projection regeneration where it is.

---

## High

### H1. The enricher loop races a running brood over the same `pending` rows: duplicate LLM calls and non-atomic seq collisions; auto-brood also bypasses the `/build` in-flight guard

- Evidence:
  - Brood Phase A writes `pending` rows for the *entire* describe set up front: `pipeline.ts:399-425`, `pipeline-async.ts:287-312`. The describe stage then runs for minutes-to-hours.
  - The daemon starts the enricher loop at boot (`src/daemon.ts:431-436`, started at `daemon.ts:532`) and fires auto-brood in the background concurrently (`daemon.ts:460-497`).
  - The enricher's pending-work selector picks exactly those rows every 30s: `WHERE describe_status IN ('pending', 'failed')` — `src/enricher/pending-query.ts:30-40`; default poll 30s (`src/enricher/config.ts`, `DEFAULT_ENRICHER_POLL_INTERVAL_MS = 30_000`).
  - `nextSeq` is a read-then-append (no atomicity): `src/hive-graph/deeplake-store.ts:379-389`, `src/hive-graph/memory-store.ts:47-53`. Both brood (`pipeline-async.ts:373`) and enricher compute `MAX(seq)+1` then append — concurrent writers produce duplicate `(nectar, seq)` rows and ambiguous latest-version resolution.
  - The HTTP `/build` route has a `broodInFlight` guard (`src/api/hive-graph-api.ts:160`, `:187-205`), but the daemon's boot auto-brood does not set or check it — a `POST /build` during the background auto-brood launches a second concurrent brood; both classify the same paths as `fresh` and double-mint identities for every file.
- Failure mode: during any real (non-test) brood on a daemon, the enricher describes the same files in parallel — duplicated cost, duplicated version rows, seq collisions; two concurrent broods duplicate every identity.
- Fix direction: a shared in-process brood/enricher mutex (pause the enricher while a brood is active, or have the enricher skip rows younger than the brood's start), and route the auto-brood through the same in-flight guard the API uses.

### H2. Unbounded memory: every discovered file's full bytes are read and retained for the entire run — including known-binary and >256KB files that will never be described

- Evidence: `prepareFile` reads full content and keeps it on `PreparedFile.bytes` (`src/brooding/precheck.ts:56-72`); `prepareFiles` does this for the whole tree (`precheck.ts:75-82`). Those `PreparedFile` objects stay referenced through bucketing (`pipeline.ts:429-432`), `nectarByPrepared` (`pipeline.ts:400`), and `describedByNectar` (`pipeline.ts:434`) until Stage 6 completes.
  - `classifyBucket` skips known-binary extensions *without any content dependence* (`src/brooding/bucketing.ts:41-42`), yet `prepareFile` has already read the entire file — a git-tracked 2GB `.mp4` is fully buffered just to sha256 it. Skip-too-large files (>256KB) are likewise fully read and retained.
- Failure mode: brooding a large monorepo (the spec's own 100K-file scaling case, `brooding-pipeline.md:120`) holds roughly the whole tree's bytes resident simultaneously; a handful of big tracked assets can OOM the daemon.
- Fix direction: short-circuit known-binary extensions before reading; stream-hash (crypto supports incremental update) reading only the first 8KB for the NUL sniff; drop `bytes` for skip buckets; process/persist in chunks so buffers are released (dovetails with C1's per-batch persistence).

### H3. Batch failure amplification: transport errors and output-truncated batches fan out into a solo-call retry storm; `maxTokens` default can truncate full batches

- Evidence:
  - A whole-call transport error marks *every* target failed (`src/brooding/describe.ts:159-163`), and the pipeline then retries each failed nectar **solo** (`pipeline.ts:447-459`; async `pipeline-async.ts:334-346`). The spec reserves the solo retry for *malformed entries* (`brooding-technical-specification.md:84`), not whole-call failures. With Portkey down or rate-limiting, a 2000-file repo's 38 batches become 38 × (3 batch attempts + up to 50 solo calls × 3 attempts each) ≈ thousands of doomed requests — and under a 429, the solo storm makes the rate limiting worse.
  - Batch calls set no `maxTokens`, so `PORTKEY_DEFAULT_MAX_TOKENS = 4096` applies (`src/portkey/transport.ts:18`, applied at `transport.ts:163`). The corpus estimates batch output at 2–4K tokens (`brooding-technical-specification.md:65`) — a full 50-file batch sits at/above the cap, the JSON array truncates mid-stream, `extractJson` finds no closing `]` (`describe.ts:98-119`), the whole batch is marked failed, and all ~50 files re-run solo. `finish_reason` is never inspected (`transport.ts:121-143`), so truncation is indistinguishable from garbage.
  - The 15s per-attempt timeout (`transport.ts:34`) is tight for a ~20K-token-input / multi-K-token-output batch completion and can produce the same systematic all-failed → solo-storm path.
- Fix direction: on transport-level batch failure, mark rows `failed` (re-enqueueable next run / enricher) instead of solo-retrying; size `max_tokens` from the batch's file count; check `finish_reason` and split-retry the batch (halving) on truncation; raise the batch-call timeout.

### H4. Batch response parsing can silently attribute the wrong description to a file; the spec's array-length validation is missing

- Evidence: `describeBatchGroup` matches entries by `nectar` but falls back to positional `entries[i]` (`describe.ts:180-185`). If the model returns entries without echoed `nectar` fields and omits or reorders one entry, file *i* receives file *j*'s title/description/concepts and is persisted as `described` — permanently wrong search index content, undetectable downstream. The tech spec requires: "The validator checks both the per-entry structure and the array length: a response with the wrong number of entries is treated as malformed" (`brooding-technical-specification.md:84`). No length check exists.
- Fix direction: only use positional fallback when `entries.length === targets.length`; otherwise treat unmatched (no-nectar) entries as malformed (solo retry path). Optionally sanity-check that a positional entry's `path`-like fields don't contradict the target.

---

## Medium

### M1. Duplicate file contents collapse to a single nectar on projection inherit, producing duplicate seq-0 version rows and orphaned identities

- Evidence: `buildContentHashIndex` maps `content_hash → (nectar, entry)` with last-writer-wins (`src/projection/load.ts:271-279`). Repos routinely contain byte-identical files (empty `__init__.py`, license copies, re-export stubs). On a fresh clone, every such path hash-matches the *same* index entry, and `inheritFromProjection` emits one `InheritRow` per path all carrying the same nectar and `seq: 0` (`src/projection/inherit.ts:118-136` — the `existing` set is never updated inside the loop). `runBrood` guards the identity insert but appends every version row (`pipeline.ts:341-346`; async `pipeline-async.ts:231-236`): one nectar ends up with N seq-0 rows at different paths (ambiguous `latestVersion`), and the other originally-minted nectars for those duplicates are orphaned — their identity and description silently lost on the clone.
- Fix direction: index `content_hash → nectar[]`, consume one nectar per matched path (and mint fresh when duplicates outnumber projection entries); track nectars assigned within the inherit loop.

### M2. A re-run of `brood` never refreshes a changed file: the resume classifier ignores content hash

- Evidence: `classifyResume` looks only at the latest row's `describeStatus` (`src/brooding/resumability.ts:55-68`), keyed by path (`pipeline.ts:351-368`). A file edited after a successful brood (daemon/watcher not running) fails the projection pre-check (new hash) and survives — then rule 1 skips it because its path has a `described` row. Its description stays stale forever (absent `--force`), the store keeps the old `contentHash`, and every subsequent brood re-reads, re-hashes, and re-skips it.
- Note: the spec's rule 1 (`brooding-pipeline.md:128`) is written for resuming an *interrupted* brood; treating it as a path-level skip regardless of content is an interpretation that leaves explicit re-broods unable to repair a stale index (the watcher/enricher is the intended change path, but it cannot cover edits made while the daemon was off if the projection is also stale/lost).
- Fix direction: in the resume partition, treat `latest.contentHash !== prepared.contentHash` as `re-enqueue` even when the latest status is `described`.

### M3. Silent walk fallback on *any* git failure ignores `.gitignore` — cost blowup and secret-file exposure

- Evidence: `spawnGitLsFiles` collapses every failure mode — git missing, non-zero exit, and notably `ENOBUFS` when `ls-files` output exceeds the 64MB `maxBuffer` (`src/brooding/discovery.ts:56`, `:77-98`) — into `{ available: false }`, and `discoverFiles` silently walks instead (`discovery.ts:148-160`). The walk honors only `.git`/`node_modules`/`.honeycomb` plus `graph-ignore.json` (`src/registration/ignore.ts:28`, `:98-112`) — **not `.gitignore`**. Gitignored `dist/`, `coverage/`, virtualenvs, and secret files like `.env` are then read, sent to the LLM, described, and persisted. On a big repo this can multiply the brood cost by orders of magnitude; the dry-run report never prints the discovery source (`src/brooding/cli.ts:158-174`), so the user cannot tell it happened. (The walk also enumerates `node_modules` fully before filtering — `src/registration/disk-fs.ts:44-68` yields everything; `discovery.ts:156` filters after — a pure perf cost.)
- Fix direction: distinguish "git not present" (walk is fine) from "git present but errored" (warn loudly or abort); surface `source` in the dry-run report; prune ignored directories inside the walk.

### M4. Dry-run/reporting cost math ignores resumability, and actual usage is discarded in favor of the estimate

- Evidence: `planBrood` buckets *all* pre-check survivors without applying `classifyResume` (`pipeline.ts:213-229`), so `--dry-run` on an interrupted or partially-limited brood quotes the full original cost, not the remaining cost — undermining its stated purpose as the pre-commit sanity check (`brooding-pipeline.md:147`). Meanwhile the run's per-call `usage` returned by the transport (`describe.ts:127`, `:196`) is never read by the pipeline (`pipeline.ts:441-470`), and the daemon records the *estimate* as spend (`daemon.ts:443-451`, `health.addBroodCost({ tokens: result.estimate.inputTokens, usd: result.estimate.totalUsd })`). The estimate also omits per-call system-prompt/JSON-envelope overhead (`src/brooding/cost.ts:93-96`) — minor, but it means `/health` cost is a modeled number presented as spend.
- Fix direction: apply the resume partition in `planBrood` (a read-only `latestVersionByPath` pass); sum real `usage` from describe results for `BroodResult` and health accounting.

---

## Low

### L1. `KNOWN_BINARY_EXTENSIONS` misclassifications

- `"lock"` (`src/brooding/constants.ts:75`) marks `yarn.lock` / `Cargo.lock` / `Gemfile.lock` — plain text — as `skipped-binary`. Skipping lockfiles may be a fine cost decision, but the terminal status is semantically wrong (the spec's list is binary *formats*, `brooding-technical-specification.md:60`) and `--force` can never re-describe them (`resumability.ts:40-42`). A `skipped-lockfile`-style status or a plain size rule would be honest.
- `"ds_store"` is unreachable: `extOf(".DS_Store")` returns `""` because `extname` of a dotfile is empty (`src/hive-graph/paths.ts:25-28`). Harmless (the NUL sniff catches it) but dead config.

### L2. POSIX filenames containing a literal backslash are corrupted by discovery

- `spawnGitLsFiles` rewrites `\` → `/` in every path (`discovery.ts:95`), so a legal POSIX filename like `a\b.ts` becomes `a/b.ts`, fails to stat, and is silently dropped. Git emits forward slashes on Windows already; the replacement should be Windows-only (or dropped).

### L3. Full-table hydration for cheap checks; quadratic failed-row lookup

- `evaluateAutoBrood` / `evaluateAutoBroodAsync` list *all* latest versions just to test emptiness (`cli.ts:113-117`, `:126-134`), and `existingNectarSet` hydrates the same list again per brood (`pipeline.ts:172-176`, `pipeline-async.ts:108-112`) — two full scans over Deep Lake per run on large stores. The failed-row persist loop does a linear scan of `nectarByPrepared` per failed nectar (`pipeline.ts:502-503`) — O(F×N). Both are perf-only.

---

## Test coverage notes (`test/brooding.test.ts`)

Covered well: verbatim discovery args, thresholds, prompts, and cost-reference figures (`:133-135`, `:201-206`, `:261-295`); bucketing exclusivity and dynamic packing (`:208-252`); inherit-on-hash-match (`:154-186`); the three resume rules, `--force` protection, and a two-run resume (`:337-374`); no-lockfile invariant (`:376-387`); dry-run makes no calls/writes (`:391-411`); `--limit` and `--force` end-to-end (`:415-455`); stage ordering (`:468-507`); flag parsing (`:527-540`).

Not covered (matching the findings above): mid-run crash persistence (C1), enricher/brood or concurrent-brood races (H1), memory behavior on large/binary files (H2), transport-failure and truncated-batch fan-out (H3), positional-fallback misattribution with a wrong-length response (H4 — the existing malformed-entry test at `:323-333` uses nectar-keyed entries only), duplicate-content inherit (M1), changed-content re-brood (M2), git-error → walk degradation (M3), and the async pipeline (`runBroodAsync` is untested in this file; only `runBrood` is driven).
