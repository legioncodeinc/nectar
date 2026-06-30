# PRD-015a: Route registry entry + SourceGraphPage component

> Parent: [`prd-015-dashboard-source-graph-page-index.md`](./prd-015-dashboard-source-graph-page-index.md)
> **Codebase:** `honeycomb` repo → thehive (per [PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md), thehive reuses `src/dashboard/web/`). This is an out-of-band sub-PRD; the route + component land in the honeycomb repo's shared dashboard module, which thehive imports and serves.

## Overview

This sub-PRD owns the **wiring**: one `RouteEntry` in the shared `ROUTES` list and one `SourceGraphPage` component that hydrates through the shared `wire`/`usePoll` recipe. It does NOT own the file-graph rendering (015b) or the search/widgets (015c); it owns the seam those features drop into — the route + the page shell that holds them.

The wiring is one entry because that is the dashboard's extension contract. `ROUTES` ([`honeycomb/src/dashboard/web/registry.tsx:196-218`](../../../../honeycomb/src/dashboard/web/registry.tsx)) is an ordered list of `RouteEntry` objects that BOTH the sidebar (for nav items) and the router outlet (to mount the active page) read ([`registry.tsx:6-9`](../../../../honeycomb/src/dashboard/web/registry.tsx)). Adding a page is "ONE `RouteEntry` in `ROUTES` in nav order: `{ route, label, icon, component }`. The sidebar renders the nav item; the outlet routes the hash to the component. Done." ([`registry.tsx:10-22`](../../../../honeycomb/src/dashboard/web/registry.tsx)). thehive serves the same `ROUTES` list unchanged ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-3), so the entry automatically appears in thehive's sidebar + outlet.

## Goals

- Add ONE `RouteEntry` for `/source-graph` to `ROUTES` ([`registry.tsx:196-218`](../../../../honeycomb/src/dashboard/web/registry.tsx)) in nav order, so the page appears in thehive's sidebar and routes via `matchRoute` ([`registry.tsx:230-240`](../../../../honeycomb/src/dashboard/web/registry.tsx)) with no sidebar/router hand-edit.
- Ship ONE `SourceGraphPage` component taking the shared `PageProps` ([`registry.tsx:91`](../../../../honeycomb/src/dashboard/web/registry.tsx)) — the same contract every page (Dashboard, Memories, Graph, …) satisfies.
- Hydrate the page through the shared `wire` + the `usePoll` recipe (fetch-on-mount + interval + cleanup-on-unmount), mirroring `GraphPage` ([`graph.tsx:435-482`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)) — never constructing a `wire` client of its own.
- Route every data fetch through thehive's aggregation `wire`, which maps each request to the owning daemon (hivenectar's `/api/source-graph/*`, PRD-008) — per [PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-5/c-AC-6.
- Render an honest empty state when hivenectar is unreachable (thehive's fail-soft), so the always-on shell never blanks.

## Non-Goals

- The file-graph node/edge rendering and interaction — **015b**. This sub-PRD owns the page shell + hydration; 015b owns what renders inside it.
- The search box and status widgets — **015c**.
- The hivenectar `/api/source-graph/*` endpoints — **PRD-008**.
- The thehive portal + its aggregation `wire` implementation — **PRD-004c**.
- The `ROUTES` / `RouteEntry` / `PageProps` / `matchRoute` machinery itself — that already exists ([`registry.tsx:83-94, 196-240`](../../../../honeycomb/src/dashboard/web/registry.tsx)); this sub-PRD consumes it.

---

## User stories + acceptance criteria

### US-015a.1 — One registry entry wires the page
**As** a maintainer, **when** I add the Source Graph page, **I** add ONE `RouteEntry` to `ROUTES` and the sidebar + router pick it up, **so that** there is no sidebar edit and no router edit.

| ID | Criterion |
|---|---|
| a-AC-1 | Given `ROUTES` ([`registry.tsx:196-218`](../../../../honeycomb/src/dashboard/web/registry.tsx)), when the `RouteEntry` `{ route: "/source-graph", label: "Source Graph", icon: <SourceGraphIcon/>, component: SourceGraphPage }` is added in nav order, then thehive's sidebar renders a "Source Graph" nav item and the outlet routes `#/source-graph` to `SourceGraphPage`. |
| a-AC-2 | Given `matchRoute` ([`registry.tsx:230-240`](../../../../honeycomb/src/dashboard/web/registry.tsx)), when the operator navigates to an unknown hash, then the page falls back to the Dashboard default ([`registry.tsx:221, 239`](../../../../honeycomb/src/dashboard/web/registry.tsx)) — `/source-graph` is matched only on its exact route. |
| a-AC-3 | Given the entry is in the shared `ROUTES`, when thehive serves the dashboard ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-3), then the page appears in thehive without a thehive-specific registry fork. |

### US-015a.2 — The page hydrates like every other page
**As** the dashboard shell, **when** the outlet mounts `SourceGraphPage`, **I** pass it the shared `wire` + `daemonUp` + `assetBase` (the `PageProps`), **so that** the page hydrates identically whether served by honeycomb or thehive.

| ID | Criterion |
|---|---|
| a-AC-4 | Given `SourceGraphPage({ wire, daemonUp, assetBase }: PageProps)` ([`registry.tsx:91`](../../../../honeycomb/src/dashboard/web/registry.tsx)), when it mounts, then it hydrates via the shared `wire` and the `usePoll` recipe (immediate fetch + interval + cleanup-on-unmount), mirroring `GraphPage` ([`graph.tsx:449-469`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). |
| a-AC-5 | Given the page needs data owned by hivenectar, when it calls a `wire` method, then the request routes through thehive's aggregation `wire` to hivenectar's `/api/source-graph/*` (PRD-008), per [PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-5. |
| a-AC-6 | Given hivenectar is unreachable, when the `wire` call fails, then the page degrades to its empty state (the `wire` is fail-soft) and thehive marks the source unreachable, not a blank dashboard ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-6). |

### US-015a.3 — The page renders inside the shared frame
**As** an operator, **when** I open `/source-graph`, **I** see a page with consistent chrome — title + content capped at the readable max-width — **so that** it matches every other page.

| ID | Criterion |
|---|---|
| a-AC-7 | Given the page renders inside `<PageFrame title="Source Graph">` ([`page-frame.tsx`](../../../../honeycomb/src/dashboard/web/page-frame.tsx)), when it mounts, then it carries no chrome of its own — the shell owns sidebar/header, the page owns content (the 037c AC-1 contract). |

---

## Implementation notes

### The registry entry

Add the entry to `ROUTES` ([`registry.tsx:196-218`](../../../../honeycomb/src/dashboard/web/registry.tsx)) in nav order. The natural slot is after the Memory Graph (`/graph`) and before `/sync`, grouping the two graph surfaces — but the density-failure lesson ([`registry.tsx:207-210`](../../../../honeycomb/src/dashboard/web/registry.tsx)) is precisely why this is a *separate* route, not a sibling view *on* `/graph`:

```ts
{ route: "/source-graph", label: "Source Graph", icon: SourceGraphIcon, component: SourceGraphPage },
```

`RouteEntry` is `{ route, label, icon, component, dynamic? }` ([`registry.tsx:83-94`](../../../../honeycomb/src/dashboard/web/registry.tsx)). The Source Graph entry is **static** (no `dynamic` group) — it is one top-level route, not a per-installed-harness group like `/harnesses` ([`registry.tsx:205`](../../../../honeycomb/src/dashboard/web/registry.tsx)). Because thehive imports and serves the same `ROUTES` ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-3), the entry needs no thehive-side duplicate.

**Icon (DEFAULT — pick at implementation):** icons are inline-SVG `ReactNode`s stroked in `currentColor`, 16px, matching the `Icon` helper ([`registry.tsx:96-100`](../../../../honeycomb/src/dashboard/web/registry.tsx)) and the no-new-dependency posture ([`registry.tsx:24-27`](../../../../honeycomb/src/dashboard/web/registry.tsx)). Pick a glyph that reads as "file provenance" (e.g. a file-tree or git-fork outline) from the existing inline-SVG idiom; the sidebar tints it by row color, so no per-icon color logic.

**Label (DEFAULT):** `Source Graph` ([`registry.tsx:87-88`](../../../../honeycomb/src/dashboard/web/registry.tsx) — the nav + per-route document-title source).

### The component

`SourceGraphPage` takes the shared `PageProps` ([`registry.tsx:91`](../../../../honeycomb/src/dashboard/web/registry.tsx); interface at [`page-frame.tsx:32-39`](../../../../honeycomb/src/dashboard/web/page-frame.tsx)) and hydrates the `usePoll` way. The template is `GraphPage` ([`graph.tsx:435-482`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)): a `React.useEffect` keyed on the dashboard-selected project (gated on `project === undefined` exactly as `graph.tsx:449-456`), an immediate `tick()` + `setInterval` poll, an `alive` guard against late-resolving fetches, `isTabHidden()` background-tab pause, and cleanup (`clearInterval`) on unmount/scope-switch ([`graph.tsx:457-469`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). `SourceGraphPage` replicates this lifecycle over its own `wire` methods (015b/015c).

Like `GraphPage`, the page wraps its content in `<PageFrame title="Source Graph">` and renders the honest empty state when its fetch degrades — the shell owns the daemon-down swap (D-5/D-9, [`page-frame.tsx:10-17`](../../../../honeycomb/src/dashboard/web/page-frame.tsx)), so the page assumes up and degrades internally on a failed fetch.

### The wire seam

The page never constructs a `wire` client; it reads the shared `PageProps.wire` ([`registry.tsx:13-16`](../../../../honeycomb/src/dashboard/web/registry.tsx); [`page-frame.tsx:32-34`](../../../../honeycomb/src/dashboard/web/page-frame.tsx)). When served by thehive, that `wire` is thehive's aggregation client, which routes each request to the owning daemon ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) "API aggregation layer"). The new `wire` methods the page calls — `sourceGraphFileGraph(project)` (015b), `sourceGraphSearch(query, project)` (015c), `sourceGraphStatus(project)` (015c) — are additions to thehive's aggregation `wire`, each mapped to a hivenectar `/api/source-graph/*` endpoint (PRD-008). They mirror the existing `memoryGraph(project)` / `recall(query, project)` method shapes ([`wire.ts:1461, 1479`](../../../../honeycomb/src/dashboard/web/wire.ts)).

### Project scope

The page keys its fetches on the dashboard-selected project (`useScope()` → `scope.project`, as `GraphPage` does at [`graph.tsx:438-439, 449-456`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)) and renders a needs-selection state when no project is selected — never showing another project's file graph. This is the same `project_id` scoping the recall arms enforce server-side ([`recall.ts:2089`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)); the page enforces it client-side by not fetching without a project.

## Related

- [`prd-015-dashboard-source-graph-page-index.md`](./prd-015-dashboard-source-graph-page-index.md) — module scope.
- [`prd-015b-file-graph-visualization`](./prd-015b-file-graph-visualization.md) — owns the graph the page shell holds.
- [`prd-015c-search-box-and-status-widgets`](./prd-015c-search-box-and-status-widgets.md) — owns the search + widgets.
- [`prd-004c-thehive-portal-daemon`](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) — owns thehive + the aggregation `wire` this page reads.
- [`prd-008-hivenectar-api-endpoints`](../prd-008-hivenectar-api-endpoints/prd-008-hivenectar-api-endpoints-index.md) — owns the endpoints the `wire` methods hit.

No open questions. The route, label, and icon are flagged defaults in the parent index.
