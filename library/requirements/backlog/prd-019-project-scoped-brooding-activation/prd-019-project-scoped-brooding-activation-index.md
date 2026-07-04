<!--
Schema v2 paths on disk:
  Index (this file):
    library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md
  Sub-feature PRDs alongside the index:
    library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019a-active-project-resolution-and-dormant-daemon.md
    library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019b-brooding-on-off-control.md
    library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019c-hive-dashboard-project-activation.md
    library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019d-ignore-contract-hardening.md
  QA report (authored by quality-worker-bee):
    library/requirements/backlog/prd-019-project-scoped-brooding-activation/qa/prd-019-project-scoped-brooding-activation-qa.md
  Lifecycle moves:
    backlog/ -> in-work/ -> completed/   (entire prd-019-project-scoped-brooding-activation/ folder moves)
-->

# PRD-019: Project-scoped brooding and activation control

> **Status:** Backlog
> **Priority:** P0 (data-safety regression: the daemon ingests unintended directories)
> **Effort:** L (8-20h)
> **Schema changes:** None in Deeplake. Adds one nectar-owned local state file (`~/.nectar/projects.json`) recording per-project brooding on/off. Consumes the existing shared `~/.deeplake/projects.json` folder bindings (the same surface Hive's folder-picker + Honeycomb's `bindFolderToProject` already write).

---

## Overview

Today the nectar daemon has no concept of "which project am I for." It broods and watches a single root resolved as `process.cwd()`:

- `src/daemon.ts:499` -> `const projectRoot = options.projectRoot ?? process.cwd();`
- `src/cli.ts:221` -> `const projectRoot = cliEnvStr("NECTAR_PROJECT_ROOT") ?? process.cwd();`

When the daemon runs as an installed OS service, none of the service unit templates set a working directory or pass a root (`src/service/templates.ts`: no `WorkingDirectory` in the launchd plist, no `WorkingDirectory=` in the systemd unit, no `<WorkingDirectory>` in the Scheduled Task, and the argv is just `node <cli> daemon`). So the daemon inherits the service manager's default cwd (`$HOME` on systemd user services, `/` on launchd, `C:\Windows\System32` on a Windows Scheduled Task) and broods **everything under it**. That is the "it is ingesting EVERYTHING in the directory it lands in" regression.

The fix mirrors what Honeycomb and Hive already do for capture scope: **nothing is sourced until the user adds a project by selecting a directory in Hive's dashboard.** That flow already exists and already persists to a surface nectar reads:

1. **The dashboard folder-pick -> bind flow is built.** Hive's `hive/src/dashboard/web/folder-picker.tsx` browses the daemon's dirs-only tree (`GET /api/diagnostics/fs/browse`) and posts the chosen absolute path to bind; the Projects page (`hive/src/dashboard/web/pages/projects.tsx`) lists active projects and runs the "+ Add" flow. Honeycomb's `honeycomb/src/daemon/runtime/projects/onboarding-api.ts` handles `POST /api/diagnostics/projects/bind` and writes the folder->project binding into `~/.deeplake/projects.json` through `bindFolderToProject`.
2. **Nectar already reads those bindings.** `src/hive-graph/project-scope.ts` loads `~/.deeplake/projects.json` (`loadProjectsCache`) and resolves a project id from the longest-prefix folder binding. Nectar just never used the bindings to decide *what to brood* - only *how to label* the single cwd it was already brooding.

PRD-019 turns the bound-folder set into nectar's **activation contract**: the daemon broods and watches exactly the bound, brooding-enabled project directories, and **nothing at all when there are none** (dormant, with an honest `/health` reason instead of a home-directory brood). It adds a per-project (and global) brooding on/off switch the operator controls from the same Projects page. It also closes the companion ignore-contract gap (issue #3) so the CLI discovery paths and the git-absent walk fallback honor `.gitignore` the way the daemon watch path already tries to.

**This index covers the module scope.** Sub-PRD 019a replaces cwd-as-root with active-project resolution and makes the daemon dormant-by-default and multi-root. 019b owns the brooding on/off control (per-project + global, persisted, API + CLI + `/health`). 019c owns the Hive dashboard surface (the nectar "needs a project" empty state and the per-project brooding toggle). 019d owns the ignore-contract hardening.

---

## Goals

- **Dormant by default.** A freshly installed nectar daemon with no bound projects broods nothing, watches nothing, and never falls back to `process.cwd()`, `$HOME`, `/`, or `System32`. `/health` states plainly that there are no active projects.
- **Activation by directory selection.** Adding a project through Hive's existing folder-pick -> bind flow (which writes `~/.deeplake/projects.json`) is the ONE trigger that starts nectar sourcing that directory. No new "which folder" mechanism is invented; nectar reads the shared binding surface it already reads.
- **Brood only active projects.** The daemon runs its watch + brood + enrich legs against the set of bound, brooding-enabled project directories, each resolved to its own tenancy project id (`resolveProjectScope`), not a single cwd.
- **Operator on/off control.** The user can turn brooding on or off per project, and globally, from the Projects page (and the CLI). The state is persisted in a nectar-owned file and survives restarts. Turning a project off stops its watch/brood without unbinding it or deleting any data.
- **Ignore parity everywhere (issue #3).** The CLI discovery paths pass the shared ignore predicate, and the git-absent walk fallback honors a real `.gitignore` parse, so a non-git (or git-erroring) root is no longer gitignore-blind.

## Non-Goals

- **Building the folder-pick / bind / browse surface.** That is Hive PRD-059b/c/d + Honeycomb's `onboarding-api.ts`, already shipped. This PRD consumes the bindings and the browse/bind endpoints; it does not rebuild them.
- **Changing the shared `~/.deeplake/projects.json` schema.** Nectar keeps reading it as-is (ADR-0002: nectar never requires a honeycomb-owned surface to change shape for it). Nectar-specific brooding state lives in a separate nectar-owned file.
- **Cross-device project import semantics.** The import-existing flow (Hive PRD-059d) is orthogonal; a bound imported project is just another active project to nectar.
- **The service unit templates.** Pinning `NECTAR_PROJECT_ROOT` into the installed unit was the rejected alternative (see Alternatives). This PRD makes the root question moot by making the daemon multi-root and dormant-by-default, so the unit stays root-agnostic.
- **Per-file or per-glob brooding exclusion beyond the ignore contract.** The ignore contract (segments + `graph-ignore.json` + `.gitignore`) is the exclusion surface; a per-project custom allowlist is out of scope for v1.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-019a-active-project-resolution-and-dormant-daemon`](./prd-019a-active-project-resolution-and-dormant-daemon.md) | Replace `projectRoot = process.cwd()` with an active-project set resolved from `~/.deeplake/projects.json`; make the daemon multi-root and dormant-by-default; surface "no active projects" on `/health`; refuse pathological roots. | Draft |
| [`prd-019b-brooding-on-off-control`](./prd-019b-brooding-on-off-control.md) | Per-project + global brooding on/off, persisted in `~/.nectar/projects.json`; nectar API endpoints + CLI verbs to read/toggle; `/health` reflects each project's brooding state. | Draft |
| [`prd-019c-hive-dashboard-project-activation`](./prd-019c-hive-dashboard-project-activation.md) | The nectar "needs a project" empty state (reusing `FolderPicker`) and the per-project brooding toggle + status on Hive's Projects/Hive-Graph surface, wired through hive's aggregation `wire` to nectar's 019b endpoints. | Draft |
| [`prd-019d-ignore-contract-hardening`](./prd-019d-ignore-contract-hardening.md) | Pass the shared ignore predicate on every CLI discovery path; make the git-absent walk fallback honor a real `.gitignore` parse so a non-git / git-erroring root is not gitignore-blind. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given a fresh install with an empty (or absent) `~/.deeplake/projects.json`, when the nectar daemon starts (including as an OS service with cwd `$HOME` / `/` / `System32`), then it broods nothing and watches nothing, and `/health` reports zero active projects with a machine-readable reason - never a brood of the cwd. |
| AC-2 | Given the operator adds a project by selecting a directory in Hive's dashboard (the existing folder-pick -> `POST /api/diagnostics/projects/bind` flow that writes `~/.deeplake/projects.json`), when nectar next reconciles its active set, then that directory becomes an active project and nectar begins brooding + watching it, scoped to that directory's resolved tenancy project id. |
| AC-3 | Given two or more bound, brooding-enabled projects, when the daemon runs, then it broods + watches each bound directory independently under its own project id, and no directory outside the bound set is ever discovered. |
| AC-4 | Given an active project, when the operator turns brooding OFF for it (Projects page toggle or CLI), then its watch + brood legs stop, no new nectars are minted for it, and the binding + all existing Deeplake data are untouched; turning it back ON resumes sourcing. |
| AC-5 | Given a global brooding OFF switch, when it is set, then no project broods regardless of per-project state, and `/health` reflects the global pause; clearing it restores each project to its own per-project state. |
| AC-6 | Given a bound root that is NOT a git repository (or where `git ls-files` errors), when nectar discovers files there, then `.gitignore` is honored via a real gitignore parse in the walk fallback, and every CLI discovery path applies the same shared ignore predicate the daemon watch path uses. |
| AC-7 | Given a bind or unbind happens while the daemon is running, when nectar reconciles, then a newly bound project starts and an unbound project stops within one reconcile cycle, with no daemon restart required. |

---

## Resolved decisions (confirmed 2026-07-04)

These were flagged defaults; the operator has now confirmed each. Implementation follows these values.

| Item | Decision | Rationale |
|---|---|---|
| Nectar-owned brooding-state file | `~/.nectar/projects.json` | Nectar is a separately-installable product (ADR-0002); `~/.honeycomb` may not exist if honeycomb is not installed, so nectar's own state lives under its own `~/.nectar/` directory (created on first write), never in the shared `~/.deeplake/projects.json`. |
| New active project's initial brooding state | **ON** (adding a project starts sourcing it) | The ask is "brood only active projects"; adding a project activates it immediately. |
| Global brooding switch default | **ON** (per-project state governs) | The global switch is an emergency pause, not the primary control; per-project toggles are the day-to-day control. |
| Reconcile trigger | Poll `~/.deeplake/projects.json` + `~/.nectar/projects.json` on the existing worker cadence, plus an explicit reconcile on the 019b toggle API call | No new watch dependency; reuses the daemon's poll loop. |
| Pathological-root guard | Refuse to activate a bound root that resolves to `$HOME`, a filesystem root, or `%WINDIR%\System32` | Defense in depth even for an explicitly bound folder. |

---

## Data model changes

None in Deeplake. Nectar adds one local, nectar-owned JSON file, `~/.nectar/projects.json`, recording per-project brooding on/off and the global switch (schema owned by 019b). It reads (never writes) the shared `~/.deeplake/projects.json` bindings. `~/.nectar/` is a new nectar-owned directory (created on first write), decoupled from the `~/.honeycomb` runtime dir so nectar's state never depends on honeycomb being installed.

---

## API changes

Nectar gains a small brooding-control surface on its own daemon (owned by 019b), consumed by Hive's dashboard through hive's aggregation `wire` (019c):

- `GET /api/hive-graph/projects` - the active-project set with each project's brooding state (active / paused, per-project vs global).
- `POST /api/hive-graph/projects/brooding` - set per-project or global brooding on/off.

No change to Honeycomb's `onboarding-api.ts` endpoints; nectar consumes `GET /api/diagnostics/fs/browse` + `POST /api/diagnostics/projects/bind` as-is for the activation flow.

---

## Alternatives considered

- **Pin `NECTAR_PROJECT_ROOT` into the installed service unit (rejected as the primary fix).** It only re-targets the single-root daemon at one repo, does not give the user an add/remove-projects experience, does not match the Honeycomb pattern, and still broods a whole tree by cwd. PRD-019's multi-root + dormant-by-default design supersedes it, and the unit stays root-agnostic.
- **A nectar-owned directory registry separate from `~/.deeplake/projects.json` (rejected).** It would duplicate the folder-pick / bind UX Hive already ships and split the source of truth for "which folders." Reading the shared binding surface (which nectar already reads for scope) keeps one source of truth.
- **Refuse to run unless cwd is a git repo (rejected).** A weaker guard than explicit activation: it still broods whatever git repo the cwd happens to be, which is not necessarily the project the user wants, and it silently does nothing useful in a non-repo. Explicit activation is the honest contract.

---

## Open questions

- Should turning brooding OFF also pause the enricher for that project's already-pending rows, or only stop new discovery? (Leaning: stop new discovery + watch; leave already-pending enrichment to drain, since it is cheap and finite. Confirm in 019b.)
- When a project is unbound in the dashboard, should nectar prune its projection / offer to, or leave the data intact (matching Honeycomb's unbind, which leaves the registry untouched)? (Leaning: leave intact; pruning stays the explicit `prune` verb. Confirm in 019a.)

---

## Related

- [`prd-007-brooding-process`](../../completed/prd-007-brooding-process/prd-007-brooding-process-index.md) - the brood pipeline that this PRD scopes to active projects; `discovery.ts` is the discovery seam 019d hardens.
- [`prd-006-file-registration-protocol`](../../completed/prd-006-file-registration-protocol/prd-006-file-registration-protocol-index.md) - the watch/registration intake this PRD makes multi-root and gates on activation.
- [`prd-018-pre-release-close-out`](../../in-work/prd-018-pre-release-close-out/prd-018-pre-release-close-out-index.md) - PRD-018c defined the shared ignore predicate (`createSharedIgnore`); 019d extends its use to the CLI + git-absent walk.
- [`prd-008-nectar-api-endpoints`](../../completed/prd-008-nectar-api-endpoints/prd-008-nectar-api-endpoints-index.md) - the `/api/hive-graph/*` surface 019b extends with the projects + brooding-control endpoints.
- [`prd-015-dashboard-hive-graph-page`](../../completed/prd-015-dashboard-hive-graph-page/prd-015-dashboard-hive-graph-page-index.md) - the hive-hosted dashboard surface 019c extends with activation + the brooding toggle.
- `src/hive-graph/project-scope.ts` - the existing `~/.deeplake/projects.json` reader + `resolveProjectScope` ladder this PRD builds the active set on.
- `hive/src/dashboard/web/folder-picker.tsx`, `hive/src/dashboard/web/pages/projects.tsx` - the folder-pick -> bind + Projects surfaces reused by 019c.
- `honeycomb/src/daemon/runtime/projects/onboarding-api.ts` - the `bind` / `bind-existing` / `unbind` + `bindFolderToProject` writer for `~/.deeplake/projects.json` (the shared binding surface).
- [`ADR-0002-nectar-independent-daemon-supervised-by-doctor`](../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md) - nectar and honeycomb are separate, separately-installable products; constrains where nectar state may live (a nectar-owned file, not the shared `~/.deeplake/projects.json`).
