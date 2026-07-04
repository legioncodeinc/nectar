<!--
Path on disk (per AGENTS.md "Filename / folder conventions"):
  library/issues/backlog/issue-023-post-index-cpu-busy-loop/ird-issue-023-post-index-cpu-busy-loop.md
Lifecycle moves:
  backlog/ -> in-work/ -> completed/   (entire issue-023-... folder moves)
IRD number = GitHub issue number (#23). Single-scope: this IRD covers only issue #23.
-->

# IRD-023: Post-index CPU busy-loop: per-batch known-path stat sweeps and per-event git check-ignore spawnSync keep the daemon hot after indexing

> **Status:** Backlog
> **GitHub issue:** [legioncodeinc/nectar#23](https://github.com/legioncodeinc/nectar/issues/23) (OPEN, filed 2026-07-04)
> **Severity:** P1 (the daemon pegs a core indefinitely after indexing a large repo and `/health` stays unresponsive, so the process looks hung rather than idle)
> **Scope:** Sustained CPU burn and `/health` starvation AFTER the index walk finishes. Starvation DURING indexing is owned by [IRD-022](../issue-022-health-starved-by-synchronous-indexing/ird-issue-022-health-starved-by-synchronous-indexing.md); the two share one investigation surface.

---

## Problem

After the index walk completes, the daemon does not settle into an idle steady state. CPU keeps climbing while memory stays flat or declines: the signature of a busy-loop, not of indexing. Every trickle of file-system events (editor autosave, build output, a log write) re-triggers work that scales with the size of the whole store rather than with the size of the event, and some of that work spawns a synchronous git process per path. `/health` stays unresponsive throughout.

## Field report

Environment: nectar 0.1.3 on Windows, honeycomb 0.2.3 fleet, ~85k-file repository.

- Memory ramps to ~868 MB during the walk, plateaus, then declines to ~670 MB (walk finished).
- Past the 900-second mark, CPU keeps climbing with flat/declining memory: a busy-loop, not indexing.
- `/health` remains unresponsive the entire time, so fleet-status omits nectar and the Hive dashboard stalls on "starting".

## Root cause (code-grounded, current main as of 2026-07-04): two named suspects

1. **Per-batch known-path sweeps scale with store size, not batch size.** Every registration cycle batch recomputes `knownPaths()` and `missingPaths()` (`src/registration/service.ts:303-312`, per the snapshot comment), and `missingPaths` performs an `existsOnDisk` stat for EVERY known path. With ~85k rows in the store, a single settled watch event (one file save) triggers ~85k synchronous `statSync` calls. Any trickle of events re-runs the sweep, keeping the CPU pegged indefinitely while the event loop starves. This matches the flat-memory, climbing-CPU signature exactly.
2. **Shared-ignore cache misses spawn git synchronously per path.** `createSharedIgnore`'s gitignore leg resolves a snapshot miss via `runGitCheckIgnore` = `spawnSync("git", ["check-ignore", ...])` per path (`src/registration/ignore.ts:187-199`, wired at `src/registration/ignore.ts:282-291`). Any watch-event storm over paths not in the ls-files snapshot (untracked build artifacts, temp files) spawns a synchronous git process per observation; on Windows each spawn is tens to hundreds of milliseconds of blocked loop.

Compounding: the recursive `fs.watch` intake on Windows can deliver high event volumes on large trees. Each settled event feeds suspect 1, and each raw observation can feed suspect 2 before debouncing, because the ignore test runs pre-debounce (`src/registration/fs-watch.ts:165-173`).

## Proposed remediation direction (proposed, not decided)

- Make the known/missing-path reconciliation incremental (indexes/dirty sets) instead of per-batch full sweeps: a single-path settle must be O(1)-ish, never O(store).
- Batch or cache negative check-ignore resolutions (and/or refresh the ls-files snapshot instead of per-path `spawnSync`); never spawn a process per watch event.
- Add a soak test: sustained single-file churn on a large synthetic store must keep CPU bounded and `/health` responsive.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a store with tens of thousands of known rows, when a single watch event settles, then the reconciliation work performed is proportional to the event (O(1)-ish), not to the store; no full `knownPaths`/`missingPaths` stat sweep runs per batch. |
| AC-2 | Given a storm of watch events over paths absent from the ls-files snapshot, when the shared ignore predicate resolves them, then no synchronous process is spawned per event: negative resolutions are cached or the snapshot is refreshed in bulk. |
| AC-3 | Given sustained single-file churn (steady autosave-rate writes) on a large synthetic store, when the soak runs for a sustained window, then daemon CPU stays bounded (no monotonic climb) and `GET /health` remains responsive within a fixed latency bound throughout. |
| AC-4 | A soak/regression test encoding AC-3 exists in the suite and fails against the pre-fix per-batch-sweep behavior. |

## Related

- [IRD-022: /health starved during indexing](../issue-022-health-starved-by-synchronous-indexing/ird-issue-022-health-starved-by-synchronous-indexing.md) - the sibling failure mode from the same field report; it starves `/health` DURING indexing. One investigation surface, two distinct fixes.
- [IRD-024: non-gitignore exclude for committed dirs](../issue-024-non-gitignore-exclude-for-committed-dirs/ird-issue-024-non-gitignore-exclude-for-committed-dirs.md) - independent, but shrinking the watched/known set reduces the constant factors here.
- `src/registration/service.ts:303-312` - the per-batch `knownPaths`/`missingPaths` sweep with an `existsOnDisk` stat per known row.
- `src/registration/ignore.ts:187-199,282-291` - `runGitCheckIgnore` via `spawnSync` on snapshot miss and its wiring.
- `src/registration/fs-watch.ts:165-173` - the pre-debounce ignore test that lets raw observations reach the spawn path.
