# QA Report: PRD-019c Hive dashboard project activation and brooding toggle (hive-surface slice)

**Plan document:** `nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019c-hive-dashboard-project-activation.md`
**Audit date:** 2026-07-04
**Base branch:** `main` (audit target is the uncommitted working tree of the hive repo)
**Head:** hive `feature/apiary-root-and-nectar-activation` (HEAD `de1350c`, all changes uncommitted)
**Auditor:** quality-worker-bee

**Scope note:** this report covers ONLY the hive-repo surface PRD-019c specifies (the dashboard panel, the two `wire` methods, and their tests, implemented in `hive/src/dashboard/web/`). The nectar-side slices (019a active-project resolution, 019b endpoints and store, 019d ignore contract) are audited in a sibling report by the nectar-side QA agent; nothing in this file speaks to those.

Ordering check: `security-worker-bee` ran first for this branch (report at `hive/library/qa/security/2026-07-04-security-audit.md`); its dashboard-relevant findings for this surface were XSS-clean, zod-fail-soft-clean, and one documented posture finding (F-4, CSRF on the pre-existing local-mode POST surface, explicitly deferred as a systemic follow-up). Correct order; no violation.

## Summary

Pass. All seven acceptance criteria (c-AC-1 through c-AC-7) are implemented with AC-named passing tests, the existing `FolderPicker` is consumed rather than forked, the two wire methods land on hive's aggregation client with the fail-soft unreachable posture the PRD requires, and the toggle placement follows the PRD's preferred option (the Hive Graph page, nectar's own page). Gates are green (`npm run typecheck` clean, `npm test` 384/384). No Critical findings, no Warnings; one Suggestion (pre-hydration control state).

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅     | c-AC-1..7 all traced to code with AC-named tests |
| Correctness   | ✅     | Re-list-after-ack (never optimistic-only), unreachable disables controls, wire shapes match the 019b contract exactly |
| Alignment     | ✅     | `FolderPicker` reused (not forked), placement on the Hive Graph page per the PRD's preferred option, BFF proxy path honored (hive ADR-0002) |
| Gaps          | ✅     | Fail-soft wire, zod `.catch()` at every level; one minor pre-hydration edge (Suggestion) |
| Detrimental   | ✅     | No regressions: page's pre-existing 015 tests still pass; shell wire mocks extended, not altered |

## Critical Issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

- [ ] **Disable panel controls until first hydration**, `hive/src/dashboard/web/pages/hive-graph.tsx` (NectarProjectsPanel, `controlsDisabled = projectsWire.unreachable || busyKey !== null`)

  Before the first `nectarProjects()` poll resolves, the panel state is `EMPTY_NECTAR_PROJECTS` (`unreachable: false`, `globalBrooding: "on"`) with `hydrated === false`, so the global "Pause all brooding" button renders enabled while the body shows "loading...". An operator clicking in that window issues a write derived from the assumed default rather than nectar's actual state. Include `!hydrated` in `controlsDisabled`. Low impact (the window is one poll round-trip and the write itself round-trips through nectar's persisted truth), which is why this is a Suggestion, not a Warning.

## Plan Item Traceability

| #      | Plan Requirement | Status | Implementation Location | Notes |
|--------|------------------|--------|--------------------------|-------|
| c-AC-1 | Zero active projects renders a "needs a project" empty state mounting the existing `FolderPicker`; no fabricated list | ✅ | `hive/src/dashboard/web/pages/hive-graph.tsx` (NectarProjectsPanel empty branch, `data-testid="nectar-needs-project"` + `<FolderPicker wire={wire} onBound={onBound} />`) | Test `c-AC-1` also asserts no project row renders |
| c-AC-2 | Bind ack `bound: true` triggers a re-list; the folder appears as an active brooding project after nectar's reconcile | ✅ | `hive-graph.tsx` (`onBound` -> `reList`); picker posts bind via the shared wire | Test `c-AC-2` drives the real `FolderPicker` DOM (select, name, bind) and asserts the row + `brooding` badge appear and `nectarProjects` was called at least twice |
| c-AC-3 | Active row shows the brooding state from `GET /api/hive-graph/projects` plus a toggle | ✅ | `hive-graph.tsx` (row render: badge via `broodingLabel`/`broodingBadgeTone` with exhaustive `never` checks; `data-testid="nectar-brooding-toggle"`) | Tests `c-AC-3` (page) and `c-AC-3` (wire, GET endpoint) |
| c-AC-4 | Toggle write reflects the new state after a re-list, driven by nectar's persisted truth, never optimistic-only | ✅ | `hive-graph.tsx` (`runBroodingWrite`: applies the ack read-model, then unconditionally `reList()`) | Tests `c-AC-4` (page: badge flips to `paused` from the re-listed state) and `c-AC-4` (wire: POST body `{ projectId, brooding }`) |
| c-AC-5 | Global pause shows every row `global-paused` and stops all brooding; clearing restores per-project states | ✅ | `hive-graph.tsx` (Panel `right` global button posting `{ global: "paused" | "on" }`) | Test `c-AC-5` covers pause and restore. The "nectar stops all brooding" half is nectar-side (019b b-AC-5), sibling report's scope |
| c-AC-6 | Nectar down: shell + surface render with nectar marked unreachable (PRD-015 AC-6); toggle disabled, never a throw | ✅ | `hive-graph.tsx` (`data-testid="nectar-projects-unreachable"` message; `controlsDisabled` includes `unreachable`; `runBroodingWrite` early-returns on unreachable) | Tests `c-AC-6` (page: global toggle `disabled === true`) and `c-AC-6` (wire: degrades to `UNREACHABLE_NECTAR_PROJECTS`); shell-level posture covered by the updated `shell-connectivity-gate` suite |
| c-AC-7 | Every value renders as escaped text; no token/secret in browse/bind/brooding bodies | ✅ | `hive-graph.tsx` (names/paths/labels as React text children only; no `dangerouslySetInnerHTML`); `wire.ts` (POST body is exactly `{ projectId, brooding }` or `{ global }` plus fixed session headers) | Test `c-AC-7` injects `<img src=x onerror=...>` as name and path and asserts textContent-only rendering; security audit independently confirmed the XSS and secrets posture |
| N-1    | Wire addition: `nectarProjects(): Promise<NectarProjectsWire>` -> `GET /api/hive-graph/projects`, fail-soft | ✅ | `hive/src/dashboard/web/wire.ts` (endpoint `hiveGraphProjects`; method with `NectarProjectsBodySchema.safeParse`, non-ok/parse-fail/throw all degrade to `UNREACHABLE_NECTAR_PROJECTS`) | Shapes (`globalBrooding`, `projects[{ projectId, name, path, brooding, watcher, counts }]`) match the 019b contract field-for-field |
| N-2    | Wire addition: `setNectarBrooding(body): Promise<NectarBroodingAckWire>` -> `POST /api/hive-graph/projects/brooding`, fail-soft | ✅ | `wire.ts` (endpoint `hiveGraphBrooding`; ack parsed with the same schema; degrades to unreachable) | Body union matches 019b's two zod-validated forms exactly |
| N-3    | Reached through hive's BFF proxy, browser never talks to daemons directly (hive ADR-0002) | ✅ | Both endpoints are same-origin `/api/hive-graph/*` paths; hive's proxy owns the nectar prefix (pre-existing routing, unchanged) | |
| NG-1   | Do NOT fork `FolderPicker` or `ProjectsPage`; consume them | ✅ | `hive-graph.tsx` imports `FolderPicker` from `../folder-picker.js`; `folder-picker.tsx` is untouched in the diff; `projects.tsx` untouched | Honored |
| NG-2   | Placement: prefer the Hive Graph page; flag in review | ✅ | Panel mounted at the top of `HiveGraphPage`, above the existing needs-selection/graph content | Preferred option taken; flagged here per the PRD's instruction |

## Files Changed (this slice)

- `hive/src/dashboard/web/pages/hive-graph.tsx` (M), adds `NectarProjectsPanel` (poll, empty state + FolderPicker, per-project rows with badge + toggle, global pause) above the existing PRD-015 content
- `hive/src/dashboard/web/wire.ts` (M), adds the two nectar endpoints, the zod fail-soft wire schemas (`.catch()` at every level), `EMPTY_NECTAR_PROJECTS` / `UNREACHABLE_NECTAR_PROJECTS`, and the `nectarProjects` / `setNectarBrooding` client methods
- `hive/tests/dashboard/hive-graph-page.test.tsx` (M), adds the seven `c-AC-*` page tests (plus wire-mock plumbing)
- `hive/tests/dashboard/hive-graph-wire.test.ts` (M), adds `c-AC-3`/`c-AC-4`/`c-AC-6` wire tests for the two new methods
- `hive/tests/dashboard/shell-connectivity-gate.test.tsx` (M), extends the shell wire mock with the new methods so the PRD-015 AC-6 shell posture stays covered

## Gate outputs

- `npm run typecheck` (hive repo): clean (exit 0).
- `npm test` (hive repo): 56 files, 384 tests passed, 0 failed.

## Verdict

The hive-surface slice of PRD-019c passes cleanly: no Critical, no Warning, one opt-in Suggestion. End-to-end behavior against a live nectar (reconcile activating a bound folder, global pause actually stopping brooding) depends on the 019a/019b nectar slices and is the sibling nectar-side report's scope.
