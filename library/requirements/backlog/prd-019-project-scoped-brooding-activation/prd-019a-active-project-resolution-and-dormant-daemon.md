# PRD-019a: Active-project resolution and the dormant-by-default daemon

> **Parent:** [PRD-019](./prd-019-project-scoped-brooding-activation-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M-L

---

## Problem

The daemon's brood + watch scope is a single root defaulting to the process working directory:

- `src/daemon.ts:499` -> `const projectRoot = options.projectRoot ?? process.cwd();`
- The auto-brood trigger broods that one root (`triggerAutoBrood`, `src/daemon.ts:596-642`), and the watch leg registers that one root (`buildRegistration` / `startRegistrationPipeline`, `src/daemon.ts:675-737`), both under a single tenancy (`waveCTenancy`, `src/daemon.ts:498`).

As an installed service the cwd is the service manager's default (`$HOME` / `/` / `System32`) because `src/service/templates.ts` sets no working directory and passes no root. The result is a full-tree brood of an unintended directory.

## Solution

Introduce an **active-project set** as the daemon's scope, replacing the single `projectRoot`. An active project is a folder binding read from the shared `~/.deeplake/projects.json` (via the existing `loadProjectsCache`, `src/hive-graph/project-scope.ts:107`) whose per-project brooding flag (019b) is ON and whose global switch is not paused.

The daemon becomes **multi-root** and **dormant-by-default**:

- With no bound projects, the daemon boots, binds its port, serves `/health`, and runs no brood and no watcher. It NEVER falls back to `process.cwd()`.
- For each active project, the daemon stands up an independent brood + watch + enrich context rooted at the bound directory, scoped to that directory's tenancy project id (`resolveProjectScope({ cwd: boundPath, expect })`, `src/hive-graph/project-scope.ts:297`).
- A **project supervisor** reconciles the running contexts against the active set on the daemon's existing poll cadence (`src/poll-loop.ts`) and on demand (the 019b toggle API triggers a reconcile). Newly active projects start; newly inactive ones stop and drain; the daemon never restarts.

### Reconcile loop

```
activeSet = { binding in projects.json
              : brooding(binding.projectId) == ON
                and globalBrooding != PAUSED
                and not isPathologicalRoot(binding.path) }

for p in activeSet - running:      start(p)   // hydrate mirror, start watcher, request cold-catch-up resync, arm auto-brood
for p in running - activeSet:       stop(p)    // stop watcher, drain bridge writes, release the per-project context
```

Each running context reuses the current single-root machinery (the `RegistrationService` from `buildRegistration`, the `triggerAutoBrood` body, the enricher loop) parameterized by `(root, tenancy)` instead of the module-level `projectRoot` / `waveCTenancy`.

### Pathological-root guard

Even an explicitly bound folder is refused (and surfaced on `/health`) when it resolves to `$HOME`, a filesystem root (`/`, a Windows drive root), or `%WINDIR%\System32`. Defense in depth against a mis-bind.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given `~/.deeplake/projects.json` has no bindings (or is absent/malformed, which `loadProjectsCache` reads as empty), when the daemon starts, then no `RegistrationService` is constructed, no `triggerAutoBrood` runs, and `/health` reports `activeProjects: 0` with reason `no-active-projects`. |
| a-AC-2 | Given the daemon's cwd is `$HOME` (or `/` or `System32`) and there are no bindings, when it starts, then it does NOT discover or brood any file under that cwd. |
| a-AC-3 | Given one bound, brooding-enabled project, when the daemon reconciles, then it stands up exactly one brood + watch context rooted at the bound path and scoped to `resolveProjectScope({ cwd: boundPath })`'s project id, matching the label the CLI would resolve. |
| a-AC-4 | Given two bound, brooding-enabled projects, when the daemon reconciles, then each runs an independent context under its own project id, and discovery for one never enumerates paths under the other (or under any unbound directory). |
| a-AC-5 | Given a project is bound (or unbound) while the daemon runs, when the next reconcile cycle fires, then the corresponding context starts (or stops + drains) with no daemon restart. |
| a-AC-6 | Given a binding whose path resolves to a guarded root (`$HOME` / filesystem root / `System32`), when the daemon reconciles, then it does NOT activate that root and `/health` lists it as `refused: pathological-root`. |
| a-AC-7 | Given a context is stopped (unbind or brooding-off), when it tears down, then its watcher stops and its bridge writes drain before the context is released, and no partial write is left mid-flight (mirrors the shutdown drain in `src/daemon.ts`). |

## Implementation notes

- Keep `options.projectRoot` as an explicit single-root override for tests and for a power-user `NECTAR_PROJECT_ROOT` (documented as an override that bypasses activation). Absent that override, the active set drives scope. This preserves the existing test seams while changing the default from "cwd" to "the bound set."
- Reuse `resolveProjectScope` unchanged for per-project tenancy; pass `expect: { org, workspace }` from `~/.deeplake/credentials.json` so a tenancy-mismatched cache reads empty (the existing guard).
- The supervisor owns a `Map<projectId, RunningContext>`; each `RunningContext` holds the same objects `assembleDaemon` builds today (registration pipeline, brood guard, enricher loop) but per project. The shared brood guard becomes per-context so two projects can brood concurrently without one blocking the other (confirm concurrency budget in review).
- `/health` gains an `activeProjects` slice: count, and per-project `{ projectId, path, brooding: "active"|"paused"|"global-paused", watcher: WatcherState }`.

## Related

- `src/hive-graph/project-scope.ts` - `loadProjectsCache`, `resolveProjectScope` (the active-set + tenancy source).
- `src/daemon.ts:498-737` - the single-root wiring this sub-PRD generalizes.
- `src/health.ts` - the `/health` body the `activeProjects` slice extends.
- [`prd-019b-brooding-on-off-control`](./prd-019b-brooding-on-off-control.md) - supplies the per-project + global brooding flags the reconcile loop reads.
