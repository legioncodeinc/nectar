# PRD-006: File Registration Protocol (Create / Move / Delete / Copy-Paste)

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L

## Overview

PRD-006 owns the **file-event intake** — the signal pipeline that turns disk change into the rows PRD-005's tables store and the re-association decisions the identity model requires. It is the hardest algorithm in the system: every create, edit, rename, move, delete, and copy-paste in the workspace is observed as an uncorrelated stream of `node:fs.watch` events, debounced into a settled burst, classified into the re-association ladder's input (new path / changed path / missing path), and resolved into a nectar decision — carry an existing nectar, append a version row, mint a fresh nectar, or flag a candidate for human review.

The defining constraint — locked decision #4 in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — is that **the watcher is `node:fs.watch` + `setTimeout`/`clearTimeout` debounce, mirroring Honeycomb's `file-watcher.ts`. NOT chokidar.** `fs.watch` delivers `(eventType, filename)` observations, not chokidar's correlated `add`/`change`/`unlink` stream, and it does not provide move semantics. This is not a loss: the re-association ladder's step-3 (exact content-hash match to a missing file) and step-4 (TLSH fuzzy match) **reconstruct moves from the uncorrelated event stream plus a missing-files set**, the same way Honeycomb's `scheduleSyncCycle` debounces a burst of identity-file edits into one sync cycle. The corpus mentions "chokidar" in several prose passages; that is wrong against both the decision and the code, and this PRD uses `fs.watch` and notes the correction where the cited corpus doc still carries the stale word.

The PRD resolves the watcher contract, the debounce window, and the copy-event detector against the real Honeycomb code. The ladder algorithm is carried from [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) (the 5-step ladder, copy-as-provenance) and the intake debounce from [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) (discovery + intake debounce). The watcher mirrors `honeycomb/src/daemon/runtime/services/file-watcher.ts:333-375` (the `fs.watch` + debounce pattern) and `:177-183` (the `debounceMs = 500` default); the "respond to file change" handler mirrors `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` (`runGraphBuild` — a parallel discover→extract→persist cycle that is fire-and-forget with internal error handling).

## Defaults registered in this PRD

Three values are defaults pending implementation confirmation. Each is flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| `debounceMs` | `500` | 006a | Mirrors `file-watcher.ts:177` (`debounceMs = 500`); the 500 ms window absorbs editor save bursts and missed events. |
| TLSH implementation | native addon OR WASM build | 006d | Both options flagged, no commitment; the corpus names both ("actual TLSH impl is a native addon or WASM build", `identity-and-reassociation.md`). |
| Prune grace period | `30 days` | 006d | Carried from `identity-and-reassociation.md` (`prune --confirm`, default 30-day grace). |

## Deliberate spec gaps preserved (NOT invented here)

Per the `hivenectar-stinger` guide 00 § Principle 3, two values remain unspecified on purpose. This PRD surfaces them as gaps, not numbers:

- **TLSH confidence thresholds** — `identity-and-reassociation.md` states the default is "configurable, default tuned during brooding" with **no numeric value**. 006d leaves the threshold configurable and empirically tuned; it pins no `0.75` / `0.4` / distance band.
- **`review-matches` sub-flag syntax** — the corpus names only the bare command `honeycomb nectar review-matches`. 006d specifies the command and its surface; the accept/reject flag syntax is a flagged implementation decision, not invented.

## Goals

- Mirror Honeycomb's `node:fs.watch` intake — directory-level watch, `setTimeout`/`clearTimeout` debounce, no chokidar — citing `file-watcher.ts:333-375` and `:177-183` as the pattern to mirror.
- Define how raw `(eventType, filename)` observations are classified into the re-association ladder's three input classes (new path / changed path / missing path) after the debounce window settles.
- Specify the copy-event detector: a new path whose content hash matches an existing file's current content mints a **fresh nectar** with `derived_from_nectar` + `fork_content_hash` (carried verbatim from `identity-and-reassociation.md`).
- Carry the 5-step re-association ladder verbatim from `identity-and-reassociation.md`, implement the move reconstruction (steps 3–4 over the missing-files set), and specify the confidence-scored review surface + conservative prune.
- Verify that `fs.watch`'s lack of correlated move semantics costs no capability — the ladder reconstructs moves from uncorrelated events + the missing-files set, exactly as the corpus describes.

## Non-Goals

- The tables this protocol writes — PRD-005 (`hive_graph`, `hive_graph_versions`).
- The brooding pipeline (one-time full-codebase mint + describe) — PRD-007. Brooding is the ladder's cold-catch-up extreme; this PRD defines the live-watch intake + the ladder shared by both modes.
- The enricher loop that fills `title`/`description`/`embedding` after the ladder appends a `pending` version row — PRD-016.
- The portable projection (`.honeycomb/nectars.json`) the ladder consults on a fresh clone — PRD-011.
- The daemon process, worker harness, and CLI scaffolding — PRD-002 (this PRD specifies the algorithm the worker runs; PRD-002 owns the worker loop).
- Symbol-level / directory nectars — deferred to v2 (deliberate spec gap, ADR-0001 non-goals).

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-006a-fswatch-intake-and-debounce](./prd-006a-fswatch-intake-and-debounce.md) | `node:fs.watch` intake + `setTimeout` debounce (mirrors `file-watcher.ts`) | Draft |
| [prd-006b-event-to-ladder-step-classification](./prd-006b-event-to-ladder-step-classification.md) | Raw `(eventType, filename)` → new path / changed path / missing path classification | Draft |
| [prd-006c-copy-event-detection](./prd-006c-copy-event-detection.md) | New path whose hash matches existing current content → mint fresh nectar + `derived_from_nectar` | Draft |
| [prd-006d-reassociation-ladder](./prd-006d-reassociation-ladder.md) | The 5-step ladder + TLSH fuzzy step + confidence-scored review surface + prune | Draft |

## Acceptance Criteria

- [ ] The watcher is `node:fs.watch` (directory-level) + `setTimeout`/`clearTimeout` debounce; `chokidar` is NOT a dependency. The pattern mirrors `file-watcher.ts:333-375` (watch attachment + `scheduleSyncCycle` debounce) and `file-watcher.ts:177-183` (`debounceMs = 500`).
- [ ] A burst of `(eventType, filename)` events within the debounce window coalesces into one settled cycle, mirroring `scheduleSyncCycle` (`file-watcher.ts:300-316`); the settled handler catches all errors internally and the watcher keeps running (the `runSyncCycle` fire-and-forget-with-intent pattern at `file-watcher.ts:234-293`).
- [ ] The classification (006b) maps every debounced path to exactly one of: new path (no known nectar), changed path (known path, content differs), or missing path (known nectar, no file on disk) — the three inputs the ladder consumes.
- [ ] The copy detector (006c) mints a **fresh nectar N2** and sets `hive_graph.derived_from_nectar = N1` + `fork_content_hash = H1` when a new path's content matches an existing file's current content; the logic matches `classifyNewFile` in `identity-and-reassociation.md`.
- [ ] The ladder (006d) carries all 5 steps verbatim from `identity-and-reassociation.md`: (1) path+mtime+size exact, (2) path match + content changed, (3) exact content-hash match to a missing file, (4) TLSH fuzzy match to a missing file, (5) mint new — first match wins.
- [ ] Step-4 fuzzy matches carry a `confidence` field; matches below the high-confidence band are surfaced to `honeycomb nectar review-matches` for human confirmation, NOT auto-claimed (re-association does not guess).
- [ ] The TLSH confidence threshold is configurable and empirically tuned; **no numeric threshold is pinned** (deliberate spec gap preserved).
- [ ] The `review-matches` command is specified; its accept/reject flag syntax is flagged as a default-pending-implementation, not invented.
- [ ] Pruning is a separate, explicit, human-triggered operation (`honeycomb nectar prune --confirm`, 30-day grace default); the ladder never deletes or reuses nectars.
- [ ] Every Honeycomb `file:line` citation and every corpus citation resolves to its cited source (no hallucinated line numbers, helpers, or thresholds).

## Related

- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — the 5-step ladder + copy-as-provenance (carried verbatim into 006c/006d).
- [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — discovery + intake debounce.
- [`knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../../knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md) — the identity decision forcing the ladder + the no-guess / no-delete contract.
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) decision #4 — the locked `fs.watch`-not-chokidar decision.
- `honeycomb/src/daemon/runtime/services/file-watcher.ts:333-375` — the `fs.watch` intake + debounce pattern to mirror.
- `honeycomb/src/daemon/runtime/services/file-watcher.ts:177-183, 234-316` — `debounceMs = 500` default, `runSyncCycle` settled handler, `scheduleSyncCycle` debounce scheduler.
- `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` — `runGraphBuild` as the parallel "respond to file change" discover→persist template.
