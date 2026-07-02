# PRD-015a: Route registry entry + HiveGraphPage component

> Parent: [`prd-015-dashboard-hive-graph-page-index.md`](./prd-015-dashboard-hive-graph-page-index.md)
> **Codebase:** the `hive` repo (per [PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) + hive ADR-0001, hive owns the dashboard code, copied from honeycomb and retired there). This is an out-of-band sub-PRD; the route + component land in `hive/src/dashboard/web/`, the dashboard module hive owns and serves.

## Overview

This sub-PRD owns the **wiring**: one `RouteEntry` in the shared `ROUTES` list and one `HiveGraphPage` component that hydrates through the shared `wire`/`usePoll` recipe. It does NOT own the file-graph rendering (015b) or the search/widgets (015c); it owns the seam those features drop into — the route + the page shell that holds them.

The wiring is one entry because that is the dashboard's extension contract. `ROUTES` (`hive/src/dashboard/web/registry.tsx:204-231`) is an ordered list of `RouteEntry` objects that BOTH the sidebar (for nav items) and the router outlet (to mount the active page) read (`registry.tsx:4-8`). Adding a page is "ONE `RouteEntry` in `ROUTES` in nav order: `{ route, label, icon, component }`. The sidebar renders the nav item; the outlet routes the path to the component. Done." (`registry.tsx:10-22`). hive serves the `ROUTES` list it owns ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-3, reconciled to copy-and-own per hive ADR-0001), so the entry automatically appears in hive's sidebar + outlet.

## Goals

- Add ONE `RouteEntry` for `/hive-graph` to `ROUTES` (`registry.tsx:204-231`) in nav order, so the page appears in hive's sidebar and routes via `matchRoute` (`registry.tsx:243-253`) with no sidebar/router hand-edit.
- Ship ONE `HiveGraphPage` component taking the shared `PageProps` (`registry.tsx:92`) — the same contract every page (Dashboard, Memories, Graph, …) satisfies.
- Hydrate the page through the shared `wire` + the `usePoll` recipe (fetch-on-mount + interval + cleanup-on-unmount), mirroring `GraphPage` (`graph.tsx:435-482`) — never constructing a `wire` client of its own.
- Route every data fetch through the shared `wire` (same-origin to hive), whose server-side proxy (`hive/src/daemon/proxy.ts`, hive ADR-0002) forwards each request to the owning daemon (nectar's `/api/hive-graph/*`, PRD-008) — per [PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-5/c-AC-6.
- Render an honest empty state when nectar is unreachable (hive's fail-soft), so the always-on shell never blanks.

## Non-Goals

- The file-graph node/edge rendering and interaction — **015b**. This sub-PRD owns the page shell + hydration; 015b owns what renders inside it.
- The search box and status widgets — **015c**.
- The nectar `/api/hive-graph/*` endpoints — **PRD-008**.
- The hive portal + its aggregation `wire` implementation — **PRD-004c**.
- The `ROUTES` / `RouteEntry` / `PageProps` / `matchRoute` machinery itself — that already exists (`registry.tsx:84-95, 204-253`); this sub-PRD consumes it.

---

## User stories + acceptance criteria

### US-015a.1 — One registry entry wires the page
**As** a maintainer, **when** I add the Hive Graph page, **I** add ONE `RouteEntry` to `ROUTES` and the sidebar + router pick it up, **so that** there is no sidebar edit and no router edit.

| ID | Criterion |
|---|---|
| a-AC-1 | Given `ROUTES` (`registry.tsx:204-231`), when the `RouteEntry` `{ route: "/hive-graph", label: "Hive Graph", icon: <HiveGraphIcon/>, component: HiveGraphPage }` is added in nav order, then hive's sidebar renders a "Hive Graph" nav item and the outlet routes the `/hive-graph` path to `HiveGraphPage` (path-based History routing per PRD-003c; the hash router is retired: `hive/src/dashboard/web/router.tsx:2-16`). |
| a-AC-2 | Given `matchRoute` (`registry.tsx:243-253`), when the operator navigates to an unknown path, then the page falls back to the Dashboard default (`registry.tsx:234, 252`) — `/hive-graph` is matched only on its exact route. |
| a-AC-3 | Given the entry is in hive's `ROUTES` (the copy hive owns per hive ADR-0001; honeycomb's is retired), when hive serves the dashboard ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-3 as reconciled), then the page appears in hive with no second registry to edit. |

### US-015a.2 — The page hydrates like every other page
**As** the dashboard shell, **when** the outlet mounts `HiveGraphPage`, **I** pass it the shared `wire` + `daemonUp` + `assetBase` (the `PageProps`), **so that** the page hydrates exactly like every other page hive serves.

| ID | Criterion |
|---|---|
| a-AC-4 | Given `HiveGraphPage({ wire, daemonUp, assetBase }: PageProps)` (`registry.tsx:92`), when it mounts, then it hydrates via the shared `wire` and the `usePoll` recipe (immediate fetch + interval + cleanup-on-unmount), mirroring `GraphPage` (`graph.tsx:449-469`). |
| a-AC-5 | Given the page needs data owned by nectar, when it calls a `wire` method, then the request routes through hive's aggregation `wire` to nectar's `/api/hive-graph/*` (PRD-008), per [PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-5. |
| a-AC-6 | Given nectar is unreachable, when the `wire` call fails, then the page degrades to its empty state (the `wire` is fail-soft) and hive marks the source unreachable, not a blank dashboard ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-6). |

### US-015a.3 — The page renders inside the shared frame
**As** an operator, **when** I open `/hive-graph`, **I** see a page with consistent chrome — title + content capped at the readable max-width — **so that** it matches every other page.

| ID | Criterion |
|---|---|
| a-AC-7 | Given the page renders inside `<PageFrame title="Hive Graph">` (`page-frame.tsx`), when it mounts, then it carries no chrome of its own — the shell owns sidebar/header, the page owns content (the 037c AC-1 contract). |

---

## Implementation notes

### The registry entry

Add the entry to `ROUTES` (`registry.tsx:204-231`) in nav order. The natural slot is after the Memory Graph (`/graph`) and before `/sync`, grouping the two graph surfaces — but the density-failure lesson (`registry.tsx:215-218`) is precisely why this is a *separate* route, not a sibling view *on* `/graph`:

```ts
{ route: "/hive-graph", label: "Hive Graph", icon: HiveGraphIcon, component: HiveGraphPage },
```

`RouteEntry` is `{ route, label, icon, component, dynamic? }` (`registry.tsx:84-95`). The Hive Graph entry is **static** (no `dynamic` group) — it is one top-level route, not a per-installed-harness group like `/harnesses` (`registry.tsx:210-213`). Because hive owns and serves `ROUTES` directly ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-3 as reconciled; honeycomb's copy is retired per hive ADR-0001), the entry lands once, in hive's registry; there is no second copy to keep in sync.

**Icon (DEFAULT — pick at implementation):** icons are inline-SVG `ReactNode`s stroked in `currentColor`, 16px, matching the `Icon` helper (`registry.tsx:98-104`) and the no-new-dependency posture (`registry.tsx:24-27`). Pick a glyph that reads as "file provenance" (e.g. a file-tree or git-fork outline) from the existing inline-SVG idiom; the sidebar tints it by row color, so no per-icon color logic.

**Label (DEFAULT):** `Hive Graph` (`registry.tsx:87-88` — the nav + per-route document-title source).

### The component

`HiveGraphPage` takes the shared `PageProps` (`registry.tsx:92`; interface at `page-frame.tsx:32-51`) and hydrates the `usePoll` way. The template is `GraphPage` (`graph.tsx:435-482`): a `React.useEffect` keyed on the dashboard-selected project (gated on `project === undefined` exactly as `graph.tsx:449-456`), an immediate `tick()` + `setInterval` poll, an `alive` guard against late-resolving fetches, `isTabHidden()` background-tab pause, and cleanup (`clearInterval`) on unmount/scope-switch (`graph.tsx:457-469`). `HiveGraphPage` replicates this lifecycle over its own `wire` methods (015b/015c).

Like `GraphPage`, the page wraps its content in `<PageFrame title="Hive Graph">` and renders the honest empty state when its fetch degrades — the shell owns the daemon-down swap (D-5/D-9, `page-frame.tsx:10-17`), so the page assumes up and degrades internally on a failed fetch.

### The wire seam

The page never constructs a `wire` client; it reads the shared `PageProps.wire` (`registry.tsx:11-13`; `page-frame.tsx:32-34`). The `wire` fetches hive's own origin same-origin; hive's SERVER-side proxy (`hive/src/daemon/proxy.ts`, hive ADR-0002) forwards each `/api/hive-graph/*` request over loopback to nectar, the owning daemon ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) "API aggregation layer", reconciled to the server-side BFF proxy). The new `wire` methods the page calls — `hiveGraphFileGraph(project)` (015b), `hiveGraphSearch(query, project)` (015c), `hiveGraphStatus(project)` + `hiveGraphBuild()` (015c) — are additions to the shared `wire`, each backed by a proxied nectar `/api/hive-graph/*` endpoint (PRD-008). `hiveGraphFileGraph` in particular consumes PRD-008c's existing projection read (`GET /api/hive-graph/projection`) and transforms the projection into the `GraphWire` shape client-side — no new nectar route (decision #39). They mirror the existing `memoryGraph(project)` / `recall(query, project)` method shapes (`wire.ts:1467, 1485`).

### Project scope

The page keys its fetches on the dashboard-selected project (`useScope()` → `scope.project`, as `GraphPage` does at `graph.tsx:438-439, 449-456`) and renders a needs-selection state when no project is selected — never showing another project's file graph. This is the same `project_id` scoping the recall arms enforce server-side (`honeycomb/src/daemon/runtime/memories/recall.ts:2089`); the page enforces it client-side by not fetching without a project.

## Related

- [`prd-015-dashboard-hive-graph-page-index.md`](./prd-015-dashboard-hive-graph-page-index.md) — module scope.
- [`prd-015b-file-graph-visualization`](./prd-015b-file-graph-visualization.md) — owns the graph the page shell holds.
- [`prd-015c-search-box-and-status-widgets`](./prd-015c-search-box-and-status-widgets.md) — owns the search + widgets.
- [`prd-004c-hive-portal-daemon`](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) — owns hive + the aggregation `wire` this page reads.
- [`prd-008-nectar-api-endpoints`](../prd-008-nectar-api-endpoints/prd-008-nectar-api-endpoints-index.md) — owns the endpoints the `wire` methods hit.

No open questions. The route, label, and icon are flagged defaults in the parent index.
