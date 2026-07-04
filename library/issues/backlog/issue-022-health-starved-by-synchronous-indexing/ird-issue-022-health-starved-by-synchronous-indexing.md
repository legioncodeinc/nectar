<!--
Path on disk (per AGENTS.md "Filename / folder conventions"):
  library/issues/backlog/issue-022-health-starved-by-synchronous-indexing/ird-issue-022-health-starved-by-synchronous-indexing.md
Lifecycle moves:
  backlog/ -> in-work/ -> completed/   (entire issue-022-... folder moves)
IRD number = GitHub issue number (#22). Single-scope: this IRD covers only issue #22.
-->

# IRD-022: /health never responds while indexing runs: brood prepare and registration resync execute synchronously on the event loop

> **Status:** Backlog
> **GitHub issue:** [legioncodeinc/nectar#22](https://github.com/legioncodeinc/nectar/issues/22) (OPEN, filed 2026-07-04)
> **Severity:** P1 (liveness contract broken: the daemon is unreachable for minutes while indexing a large repo, so doctor and the Hive dashboard treat it as down)
> **Scope:** Event-loop starvation of `/health` DURING indexing. The post-index CPU busy-loop is a separate failure mode owned by [IRD-023](../issue-023-post-index-cpu-busy-loop/ird-issue-023-post-index-cpu-busy-loop.md); the two share one investigation surface.

---

## Problem

`GET /health` on port 3854 times out indefinitely while a brood or registration cold resync runs on a large repository. The daemon is one Node process; `/health` is served by `node:http` on the same event loop that runs the indexing pipeline, and the pipeline contains multi-minute fully synchronous stretches during which the HTTP handler can never be scheduled. The socket accepts (kernel backlog) but the request is never serviced: exactly the reported Listen-but-timeout behavior. Fleet-status therefore omits nectar and the Hive dashboard stalls on "starting" forever.

## Field report

Environment: nectar 0.1.3 on Windows, honeycomb 0.2.3 fleet, ~85k-file repository.

- Memory ramps to ~868 MB while the tree walk runs, plateaus, then declines to ~670 MB (walk finished).
- Port 3854 shows a clean Listen; earlier `/health` connections went CloseWait and then cleared.
- A fresh `GET /health` still times out indefinitely, even after indexing completes (the post-completion leg is IRD-023).
- Consequence: fleet-status omits nectar; the Hive dashboard never clears "starting".

## Root cause (code-grounded, current main as of 2026-07-04)

`/health` is served by `node:http` on the daemon's single event loop (`src/server.ts:76,108`). Three pipeline stages monopolize that loop:

1. **Discovery blocks.** `spawnGitLsFiles` uses `spawnSync` (`src/brooding/discovery.ts:117-124`), and the walk fallback is a synchronous `readdirSync` generator (`src/registration/disk-fs.ts:100`).
2. **Content prep blocks hardest.** `prepareFiles` is a tight synchronous read+hash loop over every discovered file (`src/brooding/precheck.ts:126-133`); each `readContent` is a bare `readFileSync` (`src/registration/disk-fs.ts:70`) followed by hashing. On ~85k files this is minutes of uninterrupted synchronous work.
3. **The registration cold-catch-up resync is one macrotask.** `runCycle` (`src/registration/service.ts:290-320`) enumerates `fs.listPaths()` (sync walk) and runs `processOne` (statSync + readFileSync + hash + TLSH) for every path inside a while loop with no awaits and no yields. The function is `async` in name only on this path.

While any of these run, no I/O callback (including the HTTP request handler) can fire.

## Shipped mitigation (partial)

PRD-019 dormant-by-default (PR #21) means a fresh boot no longer indexes anything, so `/health` answers immediately at boot and the Hive gate clears. This fixes the boot-time case only: the moment a project is activated and a brood or cold resync starts on a large repo, the starvation recurs.

## Proposed remediation direction (proposed, not decided)

- Move discovery + prepare + resync work off the event loop (worker thread), or make the loops yield (async iteration with per-N-files awaits and async fs), or both.
- Bound the per-macrotask work so no single synchronous stretch exceeds a small budget.
- Add a regression test asserting `/health` answers within a bounded time WHILE a large synthetic brood/resync is in flight.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a large synthetic repo (tens of thousands of files) and an in-flight brood, when `GET /health` is issued at any point during discovery, prepare, or description, then it responds within a bounded time (target: under 250 ms) for the entire duration of the run. |
| AC-2 | Given a registration cold-catch-up resync over a large store, when `GET /health` is issued mid-resync, then it responds within the same bound; no single macrotask on the resync path exceeds the per-macrotask work budget. |
| AC-3 | Given the pipeline is restructured (worker thread and/or yielding loops), when the full brood completes, then its output (registered files, hashes, descriptions) is byte-equivalent to the pre-change synchronous pipeline. |
| AC-4 | A regression test exists in the suite that starts a large synthetic brood/resync and asserts `/health` latency stays within the bound while the work is in flight; the test fails against the pre-fix synchronous pipeline. |

## Related

- [IRD-023: post-index CPU busy-loop](../issue-023-post-index-cpu-busy-loop/ird-issue-023-post-index-cpu-busy-loop.md) - the sibling failure mode from the same field report; it starves `/health` AFTER indexing. One investigation surface, two distinct fixes.
- [IRD-024: non-gitignore exclude for committed dirs](../issue-024-non-gitignore-exclude-for-committed-dirs/ird-issue-024-non-gitignore-exclude-for-committed-dirs.md) - independent, but reduces the size of the workload this IRD makes preemptible.
- [`prd-019-project-scoped-brooding-activation`](../../../requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md) - the shipped dormant-by-default mitigation covering the boot-time case only.
- `src/server.ts:76,108` - the `/health` handler on the shared event loop.
- `src/brooding/discovery.ts:117-124` - `spawnSync` discovery.
- `src/brooding/precheck.ts:126-133` - the synchronous `prepareFiles` loop.
- `src/registration/disk-fs.ts:70,100` - `readFileSync` content reads and the synchronous walk generator.
- `src/registration/service.ts:290-320` - the single-macrotask `runCycle` resync.
