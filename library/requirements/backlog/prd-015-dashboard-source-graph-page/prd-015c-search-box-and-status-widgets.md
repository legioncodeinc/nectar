# PRD-015c: Search box + status widgets

> Parent: [`prd-015-dashboard-source-graph-page-index.md`](./prd-015-dashboard-source-graph-page-index.md)
> **Codebase:** `honeycomb` repo → thehive (the page lands in the shared `src/dashboard/web/` module thehive serves).

## Overview

This sub-PRD owns the two control surfaces on `SourceGraphPage` that sit alongside the file graph (015b): a **search box** that runs manual source-graph search, and a row of **status/queue/cost widgets** that report hivenectar's pipeline state. Both hydrate from hivenectar's PRD-008 endpoints through thehive's aggregation `wire` — they consume endpoints, they do not define them.

- The **search box** hits hivenectar's `/api/source-graph/search` (the endpoint PRD-008 mounts, semantics owned by PRD-012 — lexical + semantic search over `source_graph_versions`, latest described version per nectar, scoped to the source-graph table). Its on-page job is twofold: drive the file graph's search-to-node focus (015b's canvas hook), and render a results list of matching nectars with their descriptions.
- The **status/queue/cost widgets** hit hivenectar's `/api/source-graph/status` (queue depth, `describe_status` counts, cost counter) and `/api/source-graph/build` (trigger a brood, modeled on honeycomb's `/api/graph/build`). They are the operator's at-a-glance read on "what is hivenectar describing, what is queued, what has it cost."

Both are scoped to the dashboard-selected project (no cross-project leakage, matching 015a/015b) and both degrade to an unreachable state when hivenectar is down — thehive's always-on shell stays up regardless ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-2/c-AC-6).

## Goals

- Render a search box that submits a query to hivenectar's `/api/source-graph/search` (PRD-008) through thehive's aggregation `wire`, and drives the file graph's search-to-node focus (015b) plus a results list of matching nectars.
- Render status/queue/cost widgets that read hivenectar's `/api/source-graph/status` (queue depth, `describe_status` counts, cost counter) and expose a build trigger to `/api/source-graph/build` — all through thehive's aggregation `wire`.
- Hydrate the widgets via the shared `usePoll` recipe so they stay fresh without a manual refresh, and pause in background tabs (matching `GraphPage`'s poll discipline).
- Keep every fetch scoped to the selected project and fail-soft when hivenectar is unreachable.

## Non-Goals

- The search query semantics (lexical + semantic ranking over `source_graph_versions`, latest-per-nectar) — **PRD-012**. This sub-PRD wires the box to PRD-012's endpoint; it does not define the ranking.
- The `/api/source-graph/search`, `/status`, `/build` endpoint implementations — **PRD-008**.
- The brooding process the `/build` trigger launches — **PRD-007**. This sub-PRD exposes the trigger; it does not define the pipeline.
- The file graph canvas and its node/edge rendering — **015b**. The search box only drives 015b's search-to-node focus hook; it does not render the graph.
- The route entry + page shell — **015a**.
- The cost-accounting model behind the cost counter (the ~$3.05/2000-files budget) — **PRD-007** + the brooding cost math. This sub-PRD surfaces the counter the endpoint returns; it does not compute cost.

---

## User stories + acceptance criteria

### US-015c.1 — Search the source graph
**As** an operator, **when** I type a query in the search box, **I** get matching files (nectars + descriptions) and the matching node focuses on the file graph, **so that** I can find "where is the login logic" semantically.

| ID | Criterion |
|---|---|
| c-AC-1 | Given the search box, when the operator submits a query, then it calls `wire.sourceGraphSearch(query, project)` — routed by thehive's aggregation `wire` to hivenectar's `/api/source-graph/search` (PRD-008/PRD-012), mirroring the `recall(query, project)` shape ([`wire.ts:1479`](../../../../honeycomb/src/dashboard/web/wire.ts)). |
| c-AC-2 | Given search returns matching nectars, when the results render, then each result shows the nectar's file path + its description (the `source_graph_versions` description text) — the file-description results PRD-012 returns. |
| c-AC-3 | Given a selected result, when the operator clicks it, then the file graph's search-to-node focus hook fires (015b's `findNode` → `setSelected` → `centerOn`, [`graph.tsx:497-509`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)) so the canvas centers on that nectar. |
| c-AC-4 | Given no project is selected, when the page renders, then the search box is disabled / shows the needs-selection state alongside the graph (015b-AC-9) — it does not query another project's table. |

### US-015c.2 — Status / queue / cost at a glance
**As** an operator, **when** I open the page, **I** see how many files are described, how many are queued, and what the run has cost, **so that** I can tell if hivenectar is keeping up.

| ID | Criterion |
|---|---|
| c-AC-5 | Given the page mounts, when the widgets hydrate, then they call `wire.sourceGraphStatus(project)` — routed to hivenectar's `/api/source-graph/status` (PRD-008) — and render queue depth, `describe_status` counts (described / pending / failed), and the cost counter. |
| c-AC-6 | Given the `usePoll` lifecycle (015a), when the interval fires, then the widgets refresh their counts without a manual reload, paused in background tabs (`isTabHidden()`, [`graph.tsx:459`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). |
| c-AC-7 | Given the status fetch fails (hivenectar unreachable), when the `wire` call degrades, then the widgets show the source as unreachable (thehive fail-soft, [PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-6), not stale or zeroed numbers. |

### US-015c.3 — Trigger a build
**As** an operator, **when** I want to (re-)describe the codebase, **I** trigger a build from the page, **so that** I do not have to drop to the CLI.

| ID | Criterion |
|---|---|
| c-AC-8 | Given a build action on the page, when the operator invokes it, then it calls `wire.sourceGraphBuild()` — routed to hivenectar's `/api/source-graph/build` (PRD-008), modeled on honeycomb's `buildGraph()` ([`wire.ts:1608`](../../../../honeycomb/src/dashboard/web/wire.ts)) — and acknowledges the trigger; the status widgets reflect the new queue depth on the next poll. |

---

## Implementation notes

### Wire seam (three new methods, all aggregation-routed)

The page reads the shared `PageProps.wire` (015a) — thehive's aggregation client when served by thehive. Three new methods mirror existing shapes:

| New `wire` method | Mirrors | Routes to (PRD-008) |
|---|---|---|
| `sourceGraphSearch(query, project)` | `recall(query, project)` ([`wire.ts:1479`](../../../../honeycomb/src/dashboard/web/wire.ts)) | `/api/source-graph/search` |
| `sourceGraphStatus(project)` | the project-scoped status reads (e.g. `kpis(project)`, [`wire.ts:1442`](../../../../honeycomb/src/dashboard/web/wire.ts)) | `/api/source-graph/status` |
| `sourceGraphBuild()` | `buildGraph()` ([`wire.ts:1608`](../../../../honeycomb/src/dashboard/web/wire.ts)) | `/api/source-graph/build` |

Each is an addition to thehive's aggregation `wire` (PRD-004c's client), mapping the request to hivenectar's host (its registry entry's `healthUrl` host, where `/api/*` lives). No new hivenectar route is invented here; the endpoints are PRD-008's.

### Search box → graph focus

The search box's selected-result handler calls into the file graph's focus hook. `GraphPage` already factors this as `onSearch` → `findNode(rendered, raw)` → `setSelected` → `centerOn` ([`graph.tsx:497-509`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). `SourceGraphPage` lifts the same `selected`/`setSelected` + `transform`/`setTransform` state 015a establishes and exposes a focus callback the search box invokes on result click (c-AC-3). The search box renders its own results list (nectar + path + description); the canvas focus is the cross-feature seam.

### Widget hydration + scope

The status widgets hydrate on the same `usePoll` lifecycle as the graph (015a): immediate fetch + interval + cleanup, keyed on the selected project, gated on `project === undefined` (no fetch without a project — c-AC-4/c-AC-7). The queue-depth / `describe_status` / cost fields come straight from the `/api/source-graph/status` payload (PRD-008); the page does not compute them. The cost counter surfaces the accumulated cost the endpoint returns — the brooding cost math (`~$3.05/2000 files`) lives in PRD-007 and the endpoint, not here.

### Build trigger

The build action mirrors `buildGraph()` ([`wire.ts:1608, 2123`](../../../../honeycomb/src/dashboard/web/wire.ts)) — a fire-and-acknowledge call returning a build acknowledgment; the status widgets pick up the new queue depth on the next poll. The page does not block on the build (brooding is a long-running pipeline, PRD-007); it acknowledges the trigger and reports progress through the status widgets.

## Related

- [`prd-015-dashboard-source-graph-page-index.md`](./prd-015-dashboard-source-graph-page-index.md) — module scope.
- [`prd-015a-route-registry-and-sourcegraphpage`](./prd-015a-route-registry-and-sourcegraphpage.md) — owns the page shell + `usePoll` lifecycle these controls hydrate on.
- [`prd-015b-file-graph-visualization`](./prd-015b-file-graph-visualization.md) — owns the canvas the search box focuses.
- [`prd-008-hivenectar-api-endpoints`](../prd-008-hivenectar-api-endpoints/prd-008-hivenectar-api-endpoints-index.md) — owns the `/api/source-graph/search`, `/status`, `/build` endpoints.
- [`prd-012-manual-source-graph-search`](../prd-012-manual-source-graph-search/prd-012-manual-source-graph-search-index.md) — owns the search semantics the search box consumes.
- [`prd-007-brooding-process`](../prd-007-brooding-process/prd-007-brooding-process-index.md) — owns the brooding pipeline the `/build` trigger launches + the cost math the counter surfaces.
- [`prd-004c-thehive-portal-daemon`](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) — owns thehive's aggregation `wire` these fetches route through.

No open questions. The widget layout (panel order / sizing) follows the existing dashboard panel rhythm (`Panel` / `PageFrame`, no new design token — D-3/D-9 in [`page-frame.tsx`](../../../../honeycomb/src/dashboard/web/page-frame.tsx)); the exact field set the `/status` payload returns is owned by PRD-008, not pinned here.
