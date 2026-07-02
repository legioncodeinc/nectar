<!--
Schema v2 paths on disk:
  Index (this file):
    library/requirements/backlog/prd-015-dashboard-hive-graph-page/prd-015-dashboard-hive-graph-page-index.md
  Sub-feature PRDs alongside the index:
    library/requirements/backlog/prd-015-dashboard-hive-graph-page/prd-015a-route-registry-and-hivegraphpage.md
    library/requirements/backlog/prd-015-dashboard-hive-graph-page/prd-015b-file-graph-visualization.md
    library/requirements/backlog/prd-015-dashboard-hive-graph-page/prd-015c-search-box-and-status-widgets.md
  QA report (authored by quality-worker-bee):
    library/requirements/backlog/prd-015-dashboard-hive-graph-page/qa/prd-015-dashboard-hive-graph-page-qa.md
  Lifecycle moves:
    backlog/ -> in-work/ -> completed/   (entire prd-015-dashboard-hive-graph-page/ folder moves)
-->

# PRD-015: Dashboard Hive Graph page

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None (nectar) — the page consumes existing/new nectar API endpoints (PRD-008); it adds no Deep Lake table. The route registry + page component land in hive (a daemon in the honeycomb repo, per PRD-004c).
> **ClickUp:** *(delete line if not using ClickUp)*

---

## Overview

PRD-015 adds the dashboard surface for the Hive Graph: a **new page** at `/hive-graph`, hosted by **hive** (the always-on portal daemon, [PRD-004c](../prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md)), NOT a third graph crammed onto the existing `/graph` page. It is the operator-facing window onto nectar's file-identity + description corpus: the file graph (nodes = nectars, edges = `derived_from_nectar` provenance), a search box, and status/queue/cost widgets — each hydrating from nectar's PRD-008 endpoints through hive's API-aggregation layer.

Two facts from the honeycomb code fix the design:

1. **The dashboard now lives in hive, not the honeycomb daemon.** Per [decision #1](../../MASTER-PRD-INDEX.md) and [PRD-004c](../prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md), hive is the single source of always-on UI truth — it boots on OS start, reuses honeycomb's existing `src/dashboard/web/` code (route registry, pages, shell), and fetches each page's data from the owning daemon's `/api/*`. So this page's `RouteEntry` lands in the shared `ROUTES` list hive reads, and its data fetches route through hive's aggregation `wire` to nectar's `/api/hive-graph/*` endpoints (PRD-008).

2. **A new page, not a third graph on `/graph`.** The dashboard already had a codebase-graph view that was **removed for being too dense to be useful** ([`honeycomb/src/dashboard/web/registry.tsx:207-210`](../../../../honeycomb/src/dashboard/web/registry.tsx)); `/graph` now renders ONLY the memory/knowledge graph. Adding the Hive Graph as another graph on `/graph` repeats that density failure. The page is therefore its own route, `/hive-graph`, with its own kind filter and search so the file-provenance view never competes for canvas with the memory graph.

**This index covers the module scope.** Sub-PRD 015a owns the route-registry entry + the `HiveGraphPage` component hydrating via `usePoll`/`wire`; 015b owns the file-graph visualization (nectars as nodes, `derived_from_nectar` provenance as edges); 015c owns the search box (→ PRD-012) and the status/queue/cost widgets (→ PRD-008 endpoints, via hive aggregation).

---

## Goals

- Add ONE `RouteEntry` to the shared `ROUTES` list ([`registry.tsx:196-218`](../../../../honeycomb/src/dashboard/web/registry.tsx)) for `/hive-graph`, so the page appears in hive's sidebar + router outlet with no sidebar/router hand-edit (the 037c contract).
- Ship ONE page component (`HiveGraphPage`) taking the shared `PageProps` ([`registry.tsx:91`](../../../../honeycomb/src/dashboard/web/registry.tsx)) and hydrating via `usePoll`/`wire` — mirroring the existing `GraphPage` data-fetch pattern ([`graph.tsx:435-482`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)).
- Render the file graph: nodes are nectars (files), edges are `derived_from_nectar` provenance — reusing the existing `GraphWire` node/edge shape so the same pan/zoom/select interaction carries over.
- Render a search box that hits nectar's `/api/hive-graph/search` (PRD-012) and status/queue/cost widgets that hit nectar's `/api/hive-graph/status` + `/build` (PRD-008), all through hive's aggregation `wire`.
- Keep the page honest under the always-on posture: when nectar is down, hive renders the shell + this page's source as unreachable rather than blanking the dashboard (c-AC-2 from [PRD-004c](../prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md)).

## Non-Goals

- The nectar API endpoints the page calls (`/api/hive-graph/search`, `/status`, `/build`, the file-graph payload) — **PRD-008**. This PRD consumes them.
- The manual-search query semantics (lexical + semantic over `hive_graph_versions`) — **PRD-012**. This PRD wires the search box to PRD-012's endpoint; it does not define the ranking.
- The hive portal daemon + its API-aggregation layer — **PRD-004c**. This PRD consumes hive's `wire` client; it does not build hive.
- The `hive_graph` / `hive_graph_versions` table schemas and the `derived_from_nectar` column — **PRD-005**. This PRD reads `derived_from_nectar` as the edge source; it does not define it.
- The fused agent-facing recall arm — **PRD-013**. This page is the operator-facing search/graph surface, not the recall surface.
- A 3rd graph on `/graph`. The density-failure lesson ([`registry.tsx:207-210`](../../../../honeycomb/src/dashboard/web/registry.tsx)) rules this out; the Hive Graph is a separate route.
- Symbol-level or directory nectars in the graph. The Nectar v1 identity model is file-granular (ADR-0001 non-goals); the file graph renders file nectars only.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-015a-route-registry-and-hivegraphpage`](./prd-015a-route-registry-and-hivegraphpage.md) | One `RouteEntry` in `ROUTES` for `/hive-graph` + the `HiveGraphPage` component (takes `PageProps`, hydrates via `usePoll`/`wire`) in hive | Draft |
| [`prd-015b-file-graph-visualization`](./prd-015b-file-graph-visualization.md) | The file graph: nodes = nectars, edges = `derived_from_nectar` provenance; reuses `GraphWire` + the pan/zoom/select interaction from `GraphPage` | Draft |
| [`prd-015c-search-box-and-status-widgets`](./prd-015c-search-box-and-status-widgets.md) | Search box → PRD-012's `/api/hive-graph/search`; status/queue/cost widgets → PRD-008's `/api/hive-graph/status` + `/build`; all via hive's aggregation `wire` | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given hive is running and serving the shared `ROUTES` list ([`registry.tsx:196-218`](../../../../honeycomb/src/dashboard/web/registry.tsx)), when the operator navigates to `/hive-graph`, then the `HiveGraphPage` mounts via `matchRoute` ([`registry.tsx:230-240`](../../../../honeycomb/src/dashboard/web/registry.tsx)) and a "Hive Graph" nav item appears in the sidebar — added by ONE `RouteEntry`, with no sidebar or router hand-edit. |
| AC-2 | Given `HiveGraphPage` takes the shared `PageProps` ([`registry.tsx:91`](../../../../honeycomb/src/dashboard/web/registry.tsx)), when it mounts, then it hydrates via the shared `wire` + `usePoll` recipe (fetch-on-mount + interval + cleanup-on-unmount), mirroring `GraphPage` ([`graph.tsx:435-482`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). |
| AC-3 | Given the file-graph panel, when it renders, then each node is a nectar (a file) and each edge is a `derived_from_nectar` provenance link — and the page reuses the existing `GraphWire` node/edge shape ([`wire.ts:199-208`](../../../../honeycomb/src/dashboard/web/wire.ts)) so the pan/zoom/select interaction is shared with the memory graph. |
| AC-4 | Given the search box, when the operator submits a query, then it calls nectar's `/api/hive-graph/search` (PRD-012) through hive's aggregation `wire`, and the file graph highlights / filters to matching nectars. |
| AC-5 | Given the status/queue/cost widgets, when the page hydrates, then they read nectar's `/api/hive-graph/status` + `/build` (PRD-008) through hive's aggregation `wire`, surfacing queue depth, `describe_status` counts, and the cost counter. |
| AC-6 | Given nectar is down but hive is up, when the operator opens `/hive-graph`, then hive renders the shell + page chrome with the source marked unreachable, rather than blanking the dashboard (c-AC-2 from [PRD-004c](../prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md)). |
| AC-7 | Given the codebase-graph density failure ([`registry.tsx:207-210`](../../../../honeycomb/src/dashboard/web/registry.tsx)), when the Hive Graph is added, then it is a NEW route (`/hive-graph`), NOT a third graph on `/graph`; the `/graph` page still renders only the memory graph. |

---

## Defaults to flag — "DEFAULT — confirm before implementation"

| Item | Default | Why it's a default |
|---|---|---|
| Route | `/hive-graph` | A path-like hash key matching the registry convention (`/graph`, `/memories`, `/sync`). Flagged so an operator who prefers `/files` or `/source` changes only this value. |
| Page label | `Hive Graph` | The nav label + per-route document title source ([`registry.tsx:87-88, OQ-2`](../../../../honeycomb/src/dashboard/web/registry.tsx)). Flagged so it can be tightened (e.g. `Files`, `File Graph`). |
| Icon | **DEFAULT — pick from hive's icon set at implementation.** | Icons are inline-SVG `ReactNode`s stroked in `currentColor` ([`registry.tsx:88-89, 96-100`](../../../../honeycomb/src/dashboard/web/registry.tsx)), matching the no-new-dependency posture. The specific glyph (e.g. a file-tree or git-fork shape) is an implementation-time pick from the existing inline-SVG idiom, not a decision this PRD pins. |

---

## Data model changes

None. The page consumes nectar's existing/new endpoints; it reads `derived_from_nectar` from the `hive_graph` table (PRD-005) as the edge source but adds no column.

---

## API changes

None in nectar. The page consumes PRD-008's `/api/hive-graph/*` endpoints through hive's aggregation `wire`. The new `wire` methods the page needs (`hiveGraphFileGraph`, `hiveGraphSearch`, `hiveGraphStatus`) are specified in the sub-PRDs below as consumers of PRD-008 endpoints; they are additions to hive's aggregation client (PRD-004c's `wire`), not new nectar routes.

---

## Open questions

None. The route, label, and icon are flagged defaults (above), not open questions. The endpoint shapes the page consumes are owned by PRD-008; the manual-search semantics by PRD-012.

---

## Related

- [`library/requirements/MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-015 entry and decision #1 (hive hosts the dashboard).
- [`prd-004c-hive-portal-daemon`](../prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) — owns hive (the always-on portal that hosts this page) + its API-aggregation `wire`.
- [`prd-001-three-daemon-topology`](../prd-001-three-daemon-topology/prd-001-three-daemon-topology-index.md) — the three-daemon topology; hive serves on port 3853 (locked port contract).
- [`prd-008-nectar-api-endpoints`](../prd-008-nectar-api-endpoints/prd-008-nectar-api-endpoints-index.md) — owns the `/api/hive-graph/*` endpoints this page calls. *(PRD-008 is authored alongside this index.)*
- [`prd-012-manual-hive-graph-search`](../prd-012-manual-hive-graph-search/prd-012-manual-hive-graph-search-index.md) — owns the manual-search query semantics the search box consumes. *(PRD-012 is authored alongside this index.)*
- [`prd-005-hive-graph-catalog-tables`](../prd-005-hive-graph-catalog-tables/prd-005-hive-graph-catalog-tables-index.md) — owns the `hive_graph` table + the `derived_from_nectar` column the file-graph edges read.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — the `derived_from_nectar` provenance model the edges visualize.
- [`knowledge/private/dashboard/adding-a-page.md`](../../../../honeycomb/library/knowledge/private/dashboard/adding-a-page.md) — the documented "how to add a page" procedure (referenced at [`registry.tsx:21`](../../../../honeycomb/src/dashboard/web/registry.tsx)).
