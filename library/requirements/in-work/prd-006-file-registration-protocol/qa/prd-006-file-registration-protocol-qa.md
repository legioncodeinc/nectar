# QA Report: PRD-006 File Registration Protocol (PRD-vs-Corpus Conformance + Plan-vs-Code Spot-Check)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-006 (index + 006a/006b/006c/006d) against the Hivenectar knowledge corpus, the cited Honeycomb code, and the in-band Hivenectar `src/registration/` implementation, armed with quality-stinger + hivenectar-stinger. This is primarily a PRD-vs-corpus/code pass matching the bar and format of the consolidated PRD-001-004 report and the PRD-005 report; because in-band code now exists for this module, a plan-vs-code spot-check is folded in (the PRD doc remains the primary audit target). Every acceptance criterion and load-bearing claim was traced to `ai/identity-and-reassociation.md` (the authoritative 5-step ladder, copy-as-provenance, confidence field), `ai/brooding-pipeline.md` (discovery + size-bucket), `MASTER-PRD-INDEX.md` decision #4, and the real files under `honeycomb/src/daemon/runtime/`.

**Related:**
- [`prd-006-file-registration-protocol-index.md`](../prd-006-file-registration-protocol-index.md)
- [`../../../knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md)
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)
- [`../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)
- [`../../completed/prd-005-source-graph-catalog-tables/qa/prd-005-source-graph-catalog-tables-qa.md`](../../completed/prd-005-source-graph-catalog-tables/qa/prd-005-source-graph-catalog-tables-qa.md)

---

## 1. Summary

PRD-006 is the hardest-algorithm module in the system, and its spec substance is excellent. The 5-step re-association ladder is carried verbatim from `identity-and-reassociation.md` (mermaid flowchart, step semantics, first-match-wins), the `classifyNewFile` copy detector and the `bestFuzzyMatch` TLSH pseudocode are carried character-for-character, decision #4 (`node:fs.watch` not chokidar) is honored and correctly cited, and every deliberate spec gap is preserved (no numeric TLSH threshold, no invented `review-matches` flag grammar). Every spot-checked Honeycomb `file:line` citation resolves with zero line drift (`file-watcher.ts` and `codebase/api.ts`), and the in-band `src/registration/` code conforms on the load-bearing decisions: the watcher is `node:fs.watch` with chokidar absent from the dependency tree, and the ladder implements all 5 steps. The C-2 corpus disagreement (the `confidence` column and `skipped-deleted` enum) is clean for this module: PRD-006 carries no stale "corpus should be updated" language.

The module **PASSES with warnings** to the medium-and-above standard: **zero Critical findings** and **two medium Warnings**, both link-hygiene defects (not spec-correctness defects), each identical in class to warnings already remediated on PRD-005: (W-1) seven `../../../MASTER-PRD-INDEX.md` links use the wrong relative depth and resolve to a nonexistent `library/MASTER-PRD-INDEX.md`; (W-2) six Honeycomb code references in Related sections are written as non-resolving markdown links instead of canonical backtick file-path spans. Five sub-medium notes are recorded, including two genuine plan-vs-code divergences (the watcher's per-directory-array vs single-recursive shape, and where the step-1 fast path is resolved) that the implementer should reconcile before the module is marked done.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-006 index | PASS | PASS | PASS (note N-2) | PASS | WARNING (W-1, W-2); note N-1 | PASS-with-warnings |
| PRD-006a | PASS | PASS | PASS (note N-3) | PASS | WARNING (W-1, W-2) | PASS-with-warnings |
| PRD-006b | PASS | PASS | PASS (note N-4) | PASS | WARNING (W-2) | PASS-with-warnings |
| PRD-006c | PASS | PASS | PASS (note N-5) | PASS | PASS | PASS |
| PRD-006d | PASS | PASS | PASS | PASS | WARNING (W-1); note N-1 | PASS-with-warnings |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-1 (Detrimental Patterns; index, 006a, 006d): `MASTER-PRD-INDEX.md` links use the wrong relative depth and do not resolve

Seven links to the decisions ledger use `../../../MASTER-PRD-INDEX.md`. From a file in `in-work/prd-006-file-registration-protocol/`, `../../../` resolves to `library/`, so the target is `library/MASTER-PRD-INDEX.md`, which does not exist. The file is at `library/requirements/MASTER-PRD-INDEX.md`, so the correct path is `../../MASTER-PRD-INDEX.md` (up to `requirements/`). Note the same files correctly use three `../` for `../../../knowledge/...` (which resolves, since `knowledge/` is under `library/`), so this is a per-target depth error, not a whole-file base error. This is exactly the same class as PRD-005 W-2 and the consolidated report's R-1.

Locations (link target `../../../MASTER-PRD-INDEX.md`):

| File | Lines |
|---|---|
| `prd-006-file-registration-protocol-index.md` | 11, 76 |
| `prd-006a-fswatch-intake-and-debounce.md` | 9, 40, 122 |
| `prd-006d-reassociation-ladder.md` | 176, 226 |
| **Total** | **7** |

The link is load-bearing: decision #4 (the fs.watch-not-chokidar lock) is the defining constraint of the whole module, and a reader following the citation gets a broken link.

**Remediation:** Replace `](../../../MASTER-PRD-INDEX.md)` with `](../../MASTER-PRD-INDEX.md)` at the seven locations. Re-run an internal link scan to confirm the ledger link resolves and that no `../../../knowledge/...` link (which legitimately needs three levels) was changed. Verify with `grep -rn '](\.\./\.\./\.\./MASTER-PRD-INDEX' *.md` returning zero in the PRD folder.

### W-2 (Detrimental Patterns; index, 006a, 006b): Honeycomb code references as non-resolving markdown links

The PRD body cites Honeycomb code with canonical backtick file-path spans (for example `prd-006-...-index.md:13` uses `` `honeycomb/src/daemon/runtime/services/file-watcher.ts:333-375` `` as a plain span). The **Related** sections diverge: they wrap the span in a markdown link whose target is `../../../../honeycomb/...`. From `in-work/prd-006-.../`, `../../../../` resolves to `library/`, so the target is `hivenectar/library/honeycomb/...`, which does not exist (honeycomb is a sibling repo, not a child of `library/`). This is the systemic finding from the consolidated report (W-1) and PRD-005 (W-3): the Documentation Framework section 6 and `AGENTS.md` require cross-repo code to be a backtick file-path span, not a markdown link.

Link-form Honeycomb token counts (all `honeycomb/src/...`; zero `hivedoctor/...`, consistent with PRD-005's note that PRD-006 carries no hivedoctor references):

| File | Link-form honeycomb tokens | Lines |
|---|---|---|
| `prd-006-...-index.md` | 3 | 77, 78, 79 |
| `prd-006a-fswatch-intake-and-debounce.md` | 2 | 123, 124 |
| `prd-006b-event-to-ladder-step-classification.md` | 1 | 118 |
| `prd-006c-copy-event-detection.md` | 0 | (none) |
| `prd-006d-reassociation-ladder.md` | 0 | (none) |
| **Total** | **6** | |

All six visible spans are already full-form (they start with `honeycomb/`, e.g. `` `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` ``), so no path promotion is needed.

**Remediation (same recipe as PRD-005 W-3):** For each Related-section entry, drop the markdown-link wrapper `](../../../../honeycomb/...)` and keep only the backtick span. Re-run `grep -rn '](\.\./\.\./\.\./\.\./honeycomb' *.md` in the PRD folder and confirm it drops to zero, then `git diff` to confirm only link wrappers (not span content) changed. Do not edit the PRD body spans (already conformant). Preserve any pre-existing em dashes in those lines per the repo's no-em-dashes exception for pre-existing content.

## 5. Suggestions (consider improving) and sub-medium notes

- **N-1 (Detrimental Patterns; index:27, 006d:111, 006d:158): non-resolving `.agents` stinger-guide cross-tree links.** Three links to the deliberate-spec-gap rationale point at `../../../../../.agents/skills/hivenectar-stinger/guides/00-principles.md`. From `in-work/prd-006-.../`, `../../../../../` resolves above the hivenectar repo root, and the directory is named `.agents`, but the guide actually lives at `.cursor/skills/hivenectar-stinger/guides/00-principles.md` (repo root `.cursor/`, four levels up: `../../../../.cursor/skills/hivenectar-stinger/guides/00-principles.md`), or in the user home `.agents/`. Broken on both depth and directory name. Same family as PRD-005 N-3. Low severity; the surrounding prose (do not invent a TLSH number, do not invent flag grammar) is correct and the gaps are genuinely preserved. Consider repointing to the in-repo `.cursor/skills/...` path or dropping the link and keeping the plain-text citation.

- **N-2 (Alignment; index:13): "intake debounce" attributed to `brooding-pipeline.md`, which contains no debounce content.** The index states the ladder is carried from `identity-and-reassociation.md` "and the intake debounce from `brooding-pipeline.md` (discovery + intake debounce)." `brooding-pipeline.md` documents discovery (git ls-files, ignore contract, size buckets) but contains no debounce/500 ms content; the debounce is grounded in `honeycomb/src/daemon/runtime/services/file-watcher.ts` (which the same sentence and 006a correctly cite). The corpus itself cross-references `brooding-pipeline.md` for the debounce (at `identity-and-reassociation.md:232` "The watcher debounces (see `brooding-pipeline.md`)"), so the PRD is echoing a corpus-side imprecision rather than fabricating. No functional impact. Consider softening the index attribution to "the intake debounce from `file-watcher.ts` (discovery contract from `brooding-pipeline.md`)."

- **N-3 (plan-vs-code divergence; 006a:36, AC 006a:106 vs `src/registration/fs-watch.ts:67`): watcher shape.** PRD-006a describes the watch as "one `fs.FSWatcher` per watched directory, tracked in an array" that "recurses into subdirectories," attributing the array pattern to `file-watcher.ts:188`. Two nuances: (a) Honeycomb's `file-watcher.ts` is non-recursive (it watches the single workspace directory plus explicit `extraWatchPaths`, comment at `file-watcher.ts:323` says "recursive=false dir-level watch"), so the recursion is Hivenectar's own design need, not something Honeycomb's watcher does (the `:188` array-of-watchers citation is itself accurate); (b) the in-band implementation uses a single recursive watcher, `watch(this.root, { recursive: true }, ...)` at `fs-watch.ts:67`, not an array of one-watcher-per-directory. Functionally sound (arguably cleaner), but the AC wording "one `FSWatcher` per watched directory, tracked in an array" is not satisfied by the single-recursive-watcher implementation. Reconcile the AC prose with the chosen implementation (either document the recursive single-watcher approach, or note per-directory watchers as a fallback for platforms without reliable `recursive: true`).

- **N-4 (plan-vs-code divergence; AC 006b:103 vs `src/registration/classify.ts` and `ladder.ts:81-87`): where the step-1 fast path lives.** PRD-006b states the classifier resolves the step-1 fast path (mtime+size exact match to `UNCHANGED`) itself, and AC 006b:103 asserts "UNCHANGED paths never reach the ladder." The in-band `classify.ts` does not perform the mtime+size check; it classifies only into `new-path` / `changed-path` / `missing-path` / null (exists-and-known -> `changed-path`), and the step-1 fast path is instead resolved inside the ladder at `ladder.ts:81-87` (returns `{ step: 1, action: "noop" }` without reading content). The end-to-end behavior matches the corpus (step 1 short-circuits without hashing), but the PRD's "resolved in the classifier" location claim contradicts the implementation. Reconcile the AC (either move the mtime+size fast path into the classifier as specified, or update the PRD to state step 1 is resolved as the ladder's first rung).

- **N-5 (Alignment, forward-reference not grounded in the copy corpus section; 006c:72): copy description inheritance.** PRD-006c says the copy's initial version "may be inherited from N1's current description via the meaningful-change heuristic (PRD-016) since the content is identical at copy time." The corpus copy section (`identity-and-reassociation.md:174-188`) mints a fresh nectar with `derived_from_nectar` / `fork_content_hash` and does not describe inheriting the source description; the in-band `ladder.ts` copy path (`mintOrCopy`) mints with `describeStatus: "pending"` and enqueues enrichment, and does not inherit the description. The inheritance is a forward-looking design note hedged with "may" and deferred to PRD-016, so it is not a fabrication, but it is not grounded in the copy corpus section and is not implemented. Consider marking it explicitly as a PRD-016 open option rather than expected copy behavior.

## 6. Plan Item (AC) Traceability

### PRD-006 index (10 ACs)

| AC (index) | Corpus / code source | Verdict |
|---|---|---|
| Watcher is `node:fs.watch` (dir-level) + `setTimeout`/`clearTimeout` debounce; chokidar not a dependency; mirrors `file-watcher.ts:333-375` + `:177-183` | `MASTER-PRD-INDEX.md:15` (decision #4); `file-watcher.ts:333-352` (attach), `:341/:370` (fs.watch), `:177` (debounceMs=500); `package.json` (no chokidar) | PASS (decision + code verified; chokidar absent) |
| A burst coalesces into one settled cycle (`scheduleSyncCycle` `file-watcher.ts:300-316`); settled handler catches errors, watcher keeps running (`runSyncCycle` `:234-293`) | `file-watcher.ts:300-316`, `:234-293` | PASS (both ranges verified; quoted `scheduleSyncCycle` matches with comments elided) |
| Classification maps every debounced path to exactly one of new / changed / missing (006b) | `identity-and-reassociation.md` § "Live watch vs cold catch-up"; `classify.ts:29-39` | PASS |
| Copy detector mints fresh nectar N2 with `derived_from_nectar = N1` + `fork_content_hash = H1`; matches `classifyNewFile` | `identity-and-reassociation.md:158-182`; `copy-detect.ts:19-33` | PASS (verbatim logic; row shape matches) |
| Ladder carries all 5 steps verbatim; first match wins | `identity-and-reassociation.md:71-144` (flowchart + steps) | PASS (mermaid + step semantics verbatim) |
| Step-4 fuzzy matches carry `confidence`; below high band -> `review-matches`, not auto-claimed | `identity-and-reassociation.md:138` (confidence field, review surface) | PASS |
| TLSH threshold configurable and empirically tuned; no numeric threshold pinned | `identity-and-reassociation.md:138` ("configurable, default tuned during brooding") | PASS (deliberate gap preserved; no number) |
| `review-matches` specified; accept/reject flag syntax flagged as default, not invented | `MASTER-PRD-INDEX.md:200, 212`; `identity-and-reassociation.md:138` | PASS (gap preserved) |
| Prune is separate, explicit, human-triggered (`prune --confirm`, 30-day grace); ladder never deletes/reuses | `identity-and-reassociation.md:210-216`; `MASTER-PRD-INDEX.md:199` | PASS (verbatim "30-day grace") |
| Every Honeycomb + corpus citation resolves (no hallucinated lines/helpers/thresholds) | spot-checks in section 8 | PASS on the file:line accuracy (all verified with zero drift); the link-form wrappers and ledger/guide link depth are broken separately, see W-1, W-2, N-1 |

### PRD-006a fs.watch intake + debounce (8 ACs)

| AC (006a) | Source | Verdict |
|---|---|---|
| Watcher uses `node:fs.watch` at directory level (one `FSWatcher` per dir, tracked in an array), mirrors `file-watcher.ts:333-352`; chokidar not in dep tree | `file-watcher.ts:333-352`, `:188`; `fs-watch.ts:67`; `package.json` | PASS on fs.watch + chokidar-absent; the "one FSWatcher per directory in an array" shape diverges from the in-band single recursive watcher, see N-3 |
| `null`/`undefined` filename triggers a full resync settle (`file-watcher.ts:342-345`) | `file-watcher.ts:342-345` | PASS (citation exact; the in-band `fs-watch.ts:68` returns on null, a minor implementation choice) |
| Debounce scheduler cancels-and-reschedules per observation so a burst coalesces (`file-watcher.ts:300-316`) | `file-watcher.ts:300-316`; `fs-watch.ts:48-62` | PASS |
| `debounceMs` defaults to 500 (`file-watcher.ts:177`), injectable, flagged DEFAULT | `file-watcher.ts:177`; `fs-watch.ts:24, 38` | PASS |
| Settled handler catches all errors, watcher keeps running (`runSyncCycle` `:234-293`); running promise tracked (`currentCyclePromise` `:312-314`) | `file-watcher.ts:234-293, 186, 312-314` | PASS (all ranges verified) |
| Settled handler follows `runGraphBuild` discover->resolve->persist (`codebase/api.ts:234-261`); per-path persist failure logged, cycle continues | `api.ts:239-265` (aggregate `:248`, persist `:253`) | PASS (composition verified; JSDoc "adds NO new graph logic" matches) |
| Observations filtered through the CodeGraph ignore contract; no hivenectar-specific ignore list | `brooding-pipeline.md:49` (git ls-files + graph-ignore.json) | PASS |
| Re-association never crosses `project_id` boundary | `identity-and-reassociation.md:233` | PASS |

### PRD-006b event -> ladder-step classification (8 ACs)

| AC (006b) | Source | Verdict |
|---|---|---|
| Every settled path classifies into exactly one of NEW/CHANGED/MISSING (or drops as UNCHANGED via step-1 fast path); pure function of (path, disk stat, known-nectars) | `identity-and-reassociation.md` § Step 1/3; `classify.ts:29-39` | PASS on the three-class mapping; the UNCHANGED-in-classifier claim diverges from the code, see N-4 |
| Step-1 fast path resolved in the classifier; UNCHANGED never reaches the ladder | `identity-and-reassociation.md:88-92` | Divergent: corpus semantics honored, but in-band step 1 lives in `ladder.ts:81-87`, not the classifier, see N-4 |
| Missing-files set built as the set diff (Deep Lake known paths vs disk), keyed by nectar, carrying latest hash + TLSH | `identity-and-reassociation.md:105-107`; `ladder.ts:140-144` (`missingCandidates`) | PASS |
| A path touched many times in one burst classifies once, at settle (pending set is a `Set<string>`) | `identity-and-reassociation.md:232`; `fs-watch.ts:34` (`Map` per path) | PASS |
| Editor delete-then-recreate within one burst classifies NEW/CHANGED at settle | `file-watcher.ts:320-331` (dir-level watch rationale) | PASS |
| Rename arrives as two uncorrelated observations; missing-files set + step 3 reconstruct the move | `identity-and-reassociation.md:194-204` | PASS |
| All lookups scoped by `org_id` + `workspace_id` + `project_id` (PRD-005c) | `identity-and-reassociation.md:233`; `ladder.ts` (tenancy threaded) | PASS |
| Cold catch-up uses same classifier + missing-files set, seeded once at boot; brooding is degenerate all-NEW | `identity-and-reassociation.md:192-206`; `brooding-pipeline.md` | PASS |

### PRD-006c copy-event detection (6 ACs)

| AC (006c) | Source | Verdict |
|---|---|---|
| Copy detector runs on every NEW path after steps 3 and 4 miss (ordering load-bearing) | `identity-and-reassociation.md:148-172`; `ladder.ts:104-136` (byHash + existsOnDisk gate, then `mintOrCopy`) | PASS |
| Detection logic matches `classifyNewFile` verbatim: hash match to existing current content -> copy; else mint | `identity-and-reassociation.md:159-171`; `copy-detect.ts:19-33` | PASS (code verbatim; comment reworded "B" -> "the new path", no semantic change) |
| On copy, mint fresh N2 (never carry source nectar) + `derived_from_nectar = N1` + `fork_content_hash = H1` | `identity-and-reassociation.md:174-182`; `ladder.ts:207-232` (`mintOrCopy`) | PASS |
| `knownNectars` lookup keyed by latest content hash, scoped by tenancy | `identity-and-reassociation.md:162`; `copy-detect.ts:24` (`latestVersionByHash`) | PASS |
| Accepted ambiguity documented; no disambiguation in v1; `derived_kind` future enrichment not shipped | `identity-and-reassociation.md:188` | PASS |
| A copy never carries the source's nectar | `identity-and-reassociation.md:184-186`; `ladder.ts:114-115` (source present -> mint) | PASS |

### PRD-006d re-association ladder (11 ACs)

| AC (006d) | Source | Verdict |
|---|---|---|
| Ladder carries all 5 steps verbatim; first match wins | `identity-and-reassociation.md:71-144`; `ladder.ts:76-137` | PASS |
| Step 1 fast path resolved in classifier; ladder receives only CHANGED and NEW | `identity-and-reassociation.md:88-92` | PASS as spec; note the in-band code resolves step 1 in the ladder (N-4) |
| Step 2 appends a version row (`seq = prev+1`, title/description/embedding NULL, `describe_status='pending'`), enqueues enrich | `identity-and-reassociation.md:94-103`; `ladder.ts:99-101, 174-180` | PASS |
| Step 3 consults missing-files set, carries on exact `sha256` match, appends new-path row, no enrich, removes from set | `identity-and-reassociation.md:105-115`; `ladder.ts:104-113, 182-205` | PASS |
| Step 4 computes TLSH, compares (size-bucketed +/-20%), produces scored `confidence` match | `identity-and-reassociation.md:117-140`; `brooding-pipeline.md:120`; `ladder.ts:118-133` (injected `FuzzyStep`) | PASS (`bestFuzzyMatch` pseudocode verbatim; size-bucket cited) |
| Step 4 high band carries + enrich; below-high surfaces to `review-matches`; no-match falls to step 5 | `identity-and-reassociation.md:138`; `ladder.ts:122-136` | PASS |
| TLSH threshold configurable + empirically tuned; no numeric threshold pinned | `identity-and-reassociation.md:138`; `ladder.ts:12-16` (threshold not in ladder) | PASS (gap preserved; `0.75`/`0.4` appear only inside explicit negations) |
| TLSH impl (native addon OR WASM) flagged DEFAULT; algorithm identical either way | `identity-and-reassociation.md:122` ("native addon or WASM build") | PASS (both options flagged, neither committed) |
| `review-matches` lists candidates with confidence + diff preview, accept/reject each; flag syntax flagged, not invented | `identity-and-reassociation.md:138`; `MASTER-PRD-INDEX.md:200, 212` | PASS (no `--accept`/`--reject`/`--all` committed) |
| `prune --confirm` is the sole deletion path; ladder never deletes/reuses; 30-day grace DEFAULT; bare `prune` is preview | `identity-and-reassociation.md:210-216`; `MASTER-PRD-INDEX.md:199` | PASS ("30-day grace" verbatim; ladder append-only) |
| All lookups scoped by `org_id` + `workspace_id` + `project_id` | `identity-and-reassociation.md:233` | PASS |

## 7. Deliberate items preserved (NOT flagged as gaps)

Confirmed present and intentional, not defects:

- **TLSH confidence threshold, NOT pinned.** 006d leaves the threshold configurable and empirically tuned; the strings `0.75` / `0.4` / "distance band" appear only inside explicit negations ("no `0.75`, no `0.4`, no distance band"). The in-band `ladder.ts` hardcodes no number; the threshold lives in an injected `FuzzyStep`. Correct.
- **`review-matches` accept/reject flag grammar, NOT invented.** 006d specifies the bare command and its surface (list candidates, accept/reject, confidence + diff preview) and explicitly declines to commit `--accept`/`--reject`/`--all`. Correct.
- **`debounceMs = 500` DEFAULT.** Flagged DEFAULT and grounded in `file-watcher.ts:177`; matches decision #4's "default 500ms." Intentional, not a fabrication.
- **TLSH implementation (native addon OR WASM) DEFAULT.** Both options flagged, neither committed, grounded in `identity-and-reassociation.md:122`. Intentional.
- **Prune grace period 30 days DEFAULT.** Grounded in `identity-and-reassociation.md:214` and `MASTER-PRD-INDEX.md:199`. Intentional.
- **C-2 disposition clean for this module.** PRD-006 carries no "corpus should be updated" language and no `skipped-deleted` prose; the corpus `source-graph-schema.md` already carries `confidence` and the enum. No live disagreement to record.
- **Symbol-level / directory nectars** deferred to v2 (ADR-0001 non-goal), correctly stated as a non-goal.

## 8. High-risk surfaces verified verbatim / against source

- **Decision #4** (`MASTER-PRD-INDEX.md:15`): `node:fs.watch` + `setTimeout` debounce, `file-watcher.ts:333-375`, default 500ms, chokidar NOT a dependency, corpus "chokidar" refs to be corrected, ladder steps 3/4 reconstruct moves. Matches the PRD's framing exactly.
- **`file-watcher.ts` citations, all verified with zero drift:** `:177` (`debounceMs = 500`), `:186` + `:312-314` (`currentCyclePromise`), `:188` (`watchers: fs.FSWatcher[]`), `:234-293` (`runSyncCycle`), `:239-240` (cycle-start log), `:247-253` (per-target error logging), `:254-258`/`:288-292` ("watcher keeps running" comment at `:289`), `:300-316` (`scheduleSyncCycle`, quoted body matches with comments elided), `:320-331` (directory-level watch rationale, "delete then recreate", inotify/ReadDirectoryChangesW, "500ms debounce absorbs any missed events" at `:331`), `:333-352` (attach), `:341`/`:370` (`fs.watch(...)` calls), `:342-345` (null-filename handling).
- **`codebase/api.ts` citations verified:** `runGraphBuild` at `:239` (JSDoc `:233-238`), `buildAggregateSnapshot` at `:248`, `writeSnapshotAtomic` at `:253`; JSDoc "composes the already-built pieces ... adds NO new graph logic. Returns the build result as data" (`:236-237`) matches the PRD's "composes already-built pieces end-to-end and returns the result as data."
- **`identity-and-reassociation.md` verbatim carries:** the 5-step ladder mermaid + step text (`:71-144`), `classifyNewFile` (`:159-171`), the copy `source_graph` row shape (`:174-182`), `bestFuzzyMatch` pseudocode (`:121-136`), the confidence field (`:138`), the no-guess/no-delete contract (`:210-216, 228-234`), the "30 days" grace (`:214`).
- **`brooding-pipeline.md` verbatim carries:** git ls-files ignore contract (`:49`), size-bucket +/-20% and the O(N x M) / 100K-under-a-minute / minhash-v2 notes (`:120`).
- **In-band `src/registration/` conformance:** `fs-watch.ts:12,67` uses `node:fs` `watch` (`{recursive:true}`), chokidar absent from `package.json`; `ladder.ts:76-137` implements all 5 steps (step 1 `:81-87`, step 2 `:94-102`, step 3 `:104-113`, step 4 `:118-133`, step 5 `:135-136`); `copy-detect.ts:19-33` and `classify.ts:29-39` match the corpus logic. Divergences recorded as N-3 (watcher shape) and N-4 (step-1 location).

All spot-checked symbol/line ranges exist with no drift. No fabricated values, no invented thresholds, no invented flag grammar.

## 9. Files Audited

- `prd-006-file-registration-protocol-index.md` - audited (carries W-1, W-2; notes N-1, N-2).
- `prd-006a-fswatch-intake-and-debounce.md` - audited (carries W-1, W-2; note N-3).
- `prd-006b-event-to-ladder-step-classification.md` - audited (carries W-2; note N-4).
- `prd-006c-copy-event-detection.md` - audited (note N-5).
- `prd-006d-reassociation-ladder.md` - audited (carries W-1; note N-1).

Corpus (`library/knowledge/private/`), Honeycomb code, and the in-band `src/registration/` + `src/source-graph/` code were read for verification only. No PRD content, corpus, code, or any file outside this PRD's `qa/` folder was modified by this audit (report-only, per quality-stinger).

**Overall verdict (as-audited): PASS-with-warnings** (medium-and-above). Zero Critical findings. Two medium Warnings, both link-hygiene defects with grounded remediation recipes and both identical in class to warnings already remediated on PRD-005: W-1 (seven broken `../../../MASTER-PRD-INDEX.md` links, correct depth is `../../`), W-2 (six Honeycomb code refs as non-resolving markdown links in Related sections). Five sub-medium notes, including two genuine plan-vs-code divergences (N-3 watcher shape, N-4 step-1 location) the implementer should reconcile before the module is marked done. The spec substance passes cleanly: the 5-step ladder, `classifyNewFile`, and `bestFuzzyMatch` are carried verbatim from the corpus, decision #4 is honored, every deliberate spec gap is preserved, and every spot-checked Honeycomb `file:line` citation is truthful with no line drift.

## Remediation addendum (2026-07-01, the-smoker Wave B) — post-remediation verdict: PASS (clean at medium+)

Both medium Warnings and the cheap broken-link note were remediated in place (no spec substance, DDL, or code touched):

- **W-1 resolved:** all 7 `](../../../MASTER-PRD-INDEX.md)` links corrected to `](../../MASTER-PRD-INDEX.md)` (index x2, 006a x3, 006d x2). `../../../knowledge/...` links left unchanged (they resolve).
- **W-2 resolved:** all 6 honeycomb code refs in the Related sections unwrapped from markdown links to backtick file-path spans (index 3, 006a 2, 006b 1). Grep for `](.../honeycomb` in the PRD folder now returns zero.
- **N-1 resolved:** the 3 non-resolving `.agents` stinger-guide links (index:27, 006d:111, 006d:158) converted to plain-text citations ("per the `hivenectar-stinger` guide 00 § Principle 3").
- **Deferred (sub-medium, carried forward, not blocking):** N-2 (corpus-echoed "intake debounce" attribution), N-3 (watcher shape: PRD AC describes per-directory array; in-band `fs-watch.ts:67` uses a single recursive watcher), N-4 (step-1 fast path: PRD says classifier; in-band resolves it at `ladder.ts:81-87`), N-5 (copy-description-inheritance forward note). N-3/N-4 are plan-vs-code doc drift for the PRD-006 implementer to reconcile; recorded for the implementation pass.
