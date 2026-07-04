# PRD-019c: Hive dashboard project activation and brooding toggle

> **Parent:** [PRD-019](./prd-019-project-scoped-brooding-activation-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

---

## Problem

The user should add a nectar project by selecting a directory in Hive's dashboard, and turn brooding on/off there. Hive already has the folder-pick -> bind flow and a Projects page, but they were built for Honeycomb capture scope (PRD-059b/c/d) and know nothing about nectar's brooding state. There is no nectar empty-state and no brooding toggle.

## Solution

Reuse Hive's existing surfaces; add a thin nectar-aware layer that talks to nectar's 019b endpoints through hive's aggregation `wire`.

### Empty state (needs a project)

On the Hive Graph page (`hive/src/dashboard/web/pages/hive-graph.tsx`, from PRD-015) and/or a nectar section of the Projects page, when nectar reports `activeProjects: 0` (019a `/health`), render a "needs a project" empty state that mounts the existing `FolderPicker` (`hive/src/dashboard/web/folder-picker.tsx`). The picker already browses the daemon's dirs-only tree and posts `projects/bind`; on `onBound` the page re-lists and nectar's next reconcile activates the bound folder. No new picker is built. This mirrors the existing `needs-project.tsx` gate pattern.

### Per-project brooding toggle + status

Extend the nectar-facing project view (the Hive Graph page's status area, or a nectar column on the Projects page) so each active project shows its brooding state (`active` / `paused` / `global-paused`) from nectar's `GET /api/hive-graph/projects`, with a toggle that calls `POST /api/hive-graph/projects/brooding`. A global "pause all brooding" control maps to `{ global: "paused" }`.

### Wire additions (hive's aggregation client)

Add to `hive/src/dashboard/web/wire.ts` (consumers of nectar's 019b endpoints, proxied through hive per hive ADR-0002):

- `nectarProjects(): Promise<NectarProjectsWire>` -> `GET /api/hive-graph/projects`.
- `setNectarBrooding(body): Promise<NectarBroodingAckWire>` -> `POST /api/hive-graph/projects/brooding`.

Fail-soft to an empty/unreachable shape when nectar is down (matching the existing wire posture and PRD-015 AC-6: hive renders the shell with the source marked unreachable, never a blank dashboard).

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given nectar reports zero active projects, when the operator opens the nectar surface in Hive, then a "needs a project" empty state renders the existing `FolderPicker`, and there is no fabricated project list. |
| c-AC-2 | Given the operator picks a folder and binds it via the picker, when the bind ack returns `bound: true`, then the page re-lists and (after nectar's reconcile) the folder appears as an active, brooding project. |
| c-AC-3 | Given an active project row, when it renders, then it shows the project's brooding state from `GET /api/hive-graph/projects`, and a toggle control. |
| c-AC-4 | Given the operator flips a project's brooding toggle, when the `POST .../brooding` ack returns, then the row reflects the new state after a re-list, driven by nectar's persisted truth (never optimistic-only). |
| c-AC-5 | Given a global "pause all brooding" control, when the operator activates it, then every project row shows `global-paused` and nectar stops all brooding; clearing it restores per-project states. |
| c-AC-6 | Given nectar is down but hive is up, when the operator opens the nectar surface, then hive renders the shell + the surface with nectar marked unreachable (PRD-015 AC-6), and the toggle is disabled rather than throwing. |
| c-AC-7 | Given every value rendered, then names/paths/states render as escaped text (React default) and no token/secret rides any browse/bind/brooding body (inherited security posture). |

## Implementation notes

- Do NOT fork `FolderPicker` or `ProjectsPage`; consume them. The nectar layer is a status/toggle addition plus two `wire` methods.
- The bind endpoint is Honeycomb's (`/api/diagnostics/projects/bind`), writing the shared `~/.deeplake/projects.json`. The brooding endpoints are nectar's (`/api/hive-graph/projects*`). Both are reached through hive's proxy `wire`, keeping the browser off direct daemon access (hive ADR-0002).
- Prefer surfacing the toggle on the Hive Graph page (nectar's own page) to avoid overloading the Honeycomb-centric Projects page; a nectar column on Projects is the alternative. Flag the placement in review.

## Related

- `hive/src/dashboard/web/folder-picker.tsx` - the reused picker.
- `hive/src/dashboard/web/pages/projects.tsx`, `hive/src/dashboard/web/needs-project.tsx` - the list + empty-state patterns to mirror.
- `hive/src/dashboard/web/pages/hive-graph.tsx` - the nectar page (PRD-015) this surface extends.
- `hive/src/dashboard/web/wire.ts` - the aggregation client the two nectar methods are added to.
- [`prd-019b-brooding-on-off-control`](./prd-019b-brooding-on-off-control.md) - the nectar endpoints this UI consumes.
- [`prd-015-dashboard-hive-graph-page`](../../completed/prd-015-dashboard-hive-graph-page/prd-015-dashboard-hive-graph-page-index.md) - the hosting page + the unreachable-source contract.
