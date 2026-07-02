# PRD-015b: File-graph visualization

> Parent: [`prd-015-dashboard-hive-graph-page-index.md`](./prd-015-dashboard-hive-graph-page-index.md)
> **Codebase:** the `hive` repo (the page lands in `hive/src/dashboard/web/`, the dashboard module hive owns and serves per hive ADR-0001).

## Overview

This sub-PRD owns the **file graph** that renders inside `HiveGraphPage`: an Obsidian-style interlink view where **each node is a nectar (a file)** and **each edge is a `derived_from_nectar` provenance link** — the durable "B was forked from A" relationship the minted-identity model produces and content-hash identity cannot. It reuses the existing `GraphWire` node/edge shape and the `GraphPage` interaction primitives (pan/zoom, kind filter, click-to-select → side panel) so the file graph is not a bespoke canvas: it is the same graph view over a different edge semantics.

The visualization rests on three grounded facts:

1. **The edge source is `derived_from_nectar`.** The `hive_graph` table carries a `derived_from_nectar TEXT NOT NULL DEFAULT ''` column — "Copy-paste provenance. Empty for an originally-minted file. Set to the source nectar when a new path appears whose content matches an existing file's current content (the copy event). Survives forever, even after both files diverge." ([`knowledge/private/data/hive-graph-schema.md:37,51`](../../../knowledge/private/data/hive-graph-schema.md)). The model is documented in [`knowledge/private/ai/identity-and-reassociation.md:52,180-188`](../../../knowledge/private/ai/identity-and-reassociation.md): "B is its own identity (N2), and yet it is permanently linked to A (N1) through `derived_from_nectar`." The projection denormalizes this column into its `derived` map: "the copy-paste provenance map. Keyed by the derived nectar, pointing at the source nectar and fork content hash." ([`knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) § The file format; `src/projection/format.ts` `ProjectionDerivedEntry`), so the edges hydrate from the projection, not a direct table read.
2. **The node/edge wire shape already exists.** `GraphWire` is `{ built, nodes: GraphNode[], edges: GraphEdge[], meta? }`, where `GraphNode = { id, label, kind }` and `GraphEdge = { from, to, kind }` (`hive/src/dashboard/web/wire.ts:199-208, 217-224`). The projection's `files` map (keyed by nectar ULID, each entry carrying "the latest described version's content hash, path, title, description"; `portable-registry.md` § The file format; `src/projection/format.ts` `ProjectionFileEntry`) maps onto it directly: `id` = the nectar (the `files` key), `label` = `files[id].path`, `kind` = a file category derived client-side from the path; `from`/`to` = nectars, `kind` = `derived_from`.
3. **The interaction is `GraphPage`'s.** The memory graph already implements pan/zoom over the SVG viewBox, a kind filter built from the snapshot's real kinds, click-to-select → side detail panel, and search-to-node focus (`graph.tsx:435-516`). The file graph reuses these; only the data source and the side-panel content differ.

## Goals

- Render the file graph as nectar nodes + `derived_from_nectar` edges, reusing the `GraphWire` shape (`wire.ts:199-208`) so no new wire schema is invented.
- Reuse the `GraphPage` interaction primitives — pan/zoom, kind filter, click-to-select → side panel, search-to-node — so the file graph behaves like the memory graph, just over file provenance.
- Hydrate the graph from PRD-008c's existing projection-read endpoint (`GET /api/hive-graph/projection`) through hive's aggregation `wire`, as a new `hiveGraphFileGraph(project)` method that fetches the projection and transforms it into the `GraphWire` shape client-side, mirroring `memoryGraph(project)` (`wire.ts:1467`). The file graph is a client-side projection of the committed `.honeycomb/nectars.json` payload; no new nectar route is introduced (decision #39).
- Render the honest empty state when the graph is unbuilt or nectar is unreachable (fail-soft `wire`), and the needs-selection state when no project is chosen — matching `GraphPage` (`graph.tsx:522-527`).
- Keep the canvas bounded: reuse the graph-memory-cap discipline (`capGraphForRender`) so a large repo never mounts an unbounded number of SVG nodes, the discipline that the removed codebase-graph view lacked (`registry.tsx:215-218`). The projection payload is complete (the latest-per-nectar denormalization carries no server-side truncation), so the client render cap is the sole density bound.

## Non-Goals

- The route entry + page shell — **015a**. This sub-PRD owns the graph canvas inside the page.
- The search box + status widgets — **015c**. The file graph exposes a search-to-node focus hook the search box drives, but the search box itself is 015c.
- The nectar projection-read endpoint (`GET /api/hive-graph/projection`) the graph hydrates from — **PRD-008c** ([`prd-008c-build-status-projection-endpoints`](../../in-work/prd-008-nectar-api-endpoints/prd-008c-build-status-projection-endpoints.md)). This sub-PRD consumes that existing endpoint's projection payload and transforms it into the graph client-side; it introduces no new nectar route (decision #39).
- The `derived_from_nectar` column or the copy-detection that sets it — **PRD-005** (schema) and **PRD-006** (the copy-event ladder step). This sub-PRD reads the column; it does not define or populate it.
- Symbol-level or directory nectars. The v1 identity model is file-granular (ADR-0001 non-goals); nodes are files, not symbols or directories.
- A merge/cluster view for dense fan-out (one file forked into many). The kind filter + the render cap handle density; a dedicated cluster view is out of scope for v1.

---

## User stories + acceptance criteria

### US-015b.1 — Files are nodes, provenance is edges
**As** an operator, **when** I open the file graph, **I** see one node per file (nectar) and an edge from each copied file to the file it was forked from, **so that** copy-paste provenance is visible at a glance.

| ID | Criterion |
|---|---|
| b-AC-1 | Given the projection's `files` map for the selected project (keyed by nectar ULID, each entry carrying `path`/`title`/`description` — `src/projection/format.ts` `ProjectionFileEntry`; [`portable-registry.md`](../../../knowledge/private/data/portable-registry.md) § The file format), when the file graph renders, then each node's `id` is the nectar (the `files` key), `label` is `files[id].path`, and `kind` is a file category derived client-side from the path, all carried in the existing `GraphNode` shape (`wire.ts:199-203`). |
| b-AC-2 | Given a projection `derived` entry (keyed by the derived nectar, carrying `from_nectar` — `src/projection/format.ts` `ProjectionDerivedEntry`; the `derived` map denormalized from `hive_graph.derived_from_nectar`, [`hive-graph-schema.md:37,51`](../../../knowledge/private/data/hive-graph-schema.md) / [`portable-registry.md`](../../../knowledge/private/data/portable-registry.md) § The file format), when the graph renders, then an edge `{ from: <derived nectar (the `derived` key)>, to: <from_nectar>, kind: "derived_from" }` is drawn in the existing `GraphEdge` shape (`wire.ts:204-208`). |
| b-AC-3 | Given a nectar absent from the projection's `derived` map (an originally-minted file, empty `derived_from_nectar`), when the graph renders, then that node has no outgoing provenance edge: it is a root, not linked. |

### US-015b.2 — The interaction matches the memory graph
**As** an operator familiar with `/graph`, **when** I use the file graph, **I** get the same pan/zoom, kind filter, and click-to-select behavior, **so that** no new interaction model is learned.

| ID | Criterion |
|---|---|
| b-AC-4 | Given the `GraphPage` interaction primitives (pan/zoom over the SVG viewBox, `layout`, `centerOn`, `findNode`, click-to-select, clear-selection — `graph.tsx:497-516`), when the file graph mounts, then it reuses them rather than re-implementing a canvas. |
| b-AC-5 | Given the snapshot carries real file kinds, when the operator toggles a kind chip, then the kind filter hides/shows that category's nodes — mirroring `GraphPage`'s `hiddenKinds` + `applyKindFilter` (`graph.tsx:442, 472-473, 488-495`). |
| b-AC-6 | Given the operator clicks a node, when the side detail panel opens, then it shows that file's nectar (the `files` key), path (`files[id].path`), description (`files[id].description`), and provenance (`derived[id].from_nectar` if present); the file-graph-specific content `GraphPage`'s memory-detail panel does not carry, all sourced from the projection payload (`src/projection/format.ts`). |

### US-015b.3 — Density is bounded honestly
**As** an operator on a large repo, **when** the file graph exceeds the render cap, **I** see an honest truncation notice, **so that** the canvas stays responsive and I know what was dropped.

| ID | Criterion |
|---|---|
| b-AC-7 | Given the fetched graph exceeds `MAX_RENDER_NODES`, when the client render cap fires, then `capGraphForRender` (`wire.ts:1813-1828`) bounds what is drawn and the page reports `capped` exactly as `GraphPage` does (`graph.tsx:477, 482`). |
| b-AC-8 | Given the projection payload is complete (the latest-per-nectar denormalization carries no server-side `meta.truncated`, per [`portable-registry.md`](../../../knowledge/private/data/portable-registry.md) § The file format), when the graph is bounded, then the ONLY density reduction is the client-side `capped` backstop (b-AC-7); the page reports no `serverTruncated` count for the file graph and never fabricates one (decision #39). |

### US-015b.4 — Empty + unreachable states are honest
**As** an operator, **when** no project is selected or nectar is down, **I** see an explicit state, **so that** the page never silently shows the wrong (or no) graph.

| ID | Criterion |
|---|---|
| b-AC-9 | Given no project is selected (`scope.project === undefined`), when the page renders, then it shows the needs-selection state and does NOT fetch — mirroring `GraphPage` (`graph.tsx:438-439, 449-456, 522-524`); no other project's file graph is ever shown. |
| b-AC-10 | Given nectar is unreachable, when the `wire.hiveGraphFileGraph(project)` call fails, then the graph degrades to `EMPTY_GRAPH` (`wire.ts:1785`) and the page renders the empty state; hive marks the source unreachable, not a blank dashboard ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) c-AC-6). |

---

## Implementation notes

### Node/edge mapping (reuse, do not invent)

The file graph is a client-side transform of the projection payload (`PortableProjection`, `src/projection/format.ts`) onto the existing `GraphWire` (`wire.ts:217-224`):

| `GraphWire` field | File-graph meaning | Source (projection payload) |
|---|---|---|
| `built` | whether nectar has described any files for the project | the projection has a non-empty `files` map ([`portable-registry.md`](../../../knowledge/private/data/portable-registry.md) § The file format) |
| `nodes[].id` | the nectar (ULID) | the `files` map key (`ProjectionFileEntry`, `src/projection/format.ts`) |
| `nodes[].label` | the file path | `files[id].path` (the projection carries the latest described version's path per nectar; `portable-registry.md` § What it contains) |
| `nodes[].kind` | a file category (e.g. extension / dir) | derived client-side from `files[id].path` for the kind filter |
| `edges[].from` | the derived (copied) nectar | the `derived` map key |
| `edges[].to` | the source nectar | that entry's `from_nectar` (`ProjectionDerivedEntry`, `src/projection/format.ts`) |
| `edges[].kind` | `"derived_from"` | constant |
| `meta` | (none) | the projection is complete; it carries no server-side truncation, so density is bounded solely by the client-side `capGraphForRender` cap (b-AC-7, b-AC-8) |

No new wire schema: the file graph IS a `GraphWire` built client-side over the projection's file provenance. The edge direction (`from` = derived, `to` = source) matches the identity model's framing: "B … is permanently linked to A … through `derived_from_nectar`" where B is the newer nectar ([`identity-and-reassociation.md:180-184`](../../../knowledge/private/ai/identity-and-reassociation.md)).

### Hydration

The page calls a new `wire.hiveGraphFileGraph(project)` method (mirroring `memoryGraph(project)`, `wire.ts:1467`) inside the `usePoll` lifecycle 015a establishes. That method fetches PRD-008c's existing projection-read endpoint (`GET /api/hive-graph/projection`, [`prd-008c-build-status-projection-endpoints`](../../in-work/prd-008-nectar-api-endpoints/prd-008c-build-status-projection-endpoints.md)) and transforms the returned `PortableProjection` (`src/projection/format.ts`) into a `GraphWire` client-side (nodes from `files`, edges from `derived`, per the mapping table above). hive's server-side proxy forwards the projection read over loopback to nectar, the owning daemon ([PRD-004c](../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) "API aggregation layer", hive ADR-0002). No new nectar route is added: the graph is a client-side view of the existing committed projection (decision #39). The poll interval reuses the graph-poll discipline (`GRAPH_POLL_MS` in `graph.tsx`): a light refresh, paused in background tabs (`isTabHidden()`, `graph.tsx:459`).

### Interaction reuse

The file graph reuses `GraphPage`'s pure interaction surface: the shared `layout(...)` function, `centerOn`, `findNode`, the kind-filter machinery, click-to-select → side panel, and the zoom/fit controls (`graph.tsx:471-516`). The side panel's *content* is file-graph-specific (nectar + path + description + `derived_from_nectar`), but the panel *mechanism* is shared. The search-to-node focus hook (`onSearch` → `findNode` → `setSelected` → `centerOn`, `graph.tsx:497-509`) is the seam 015c's search box drives to highlight matching nectars on the canvas.

### Density discipline (the lesson)

The removed codebase-graph view was "too dense to be useful" (`registry.tsx:215-218`). The file graph avoids the same fate by inheriting `GraphPage`'s client-side density control: the `capGraphForRender` backstop (`MAX_RENDER_NODES`, `wire.ts:1813-1828`; `graph.tsx:477`) bounds what is drawn. Because the projection payload is complete (no server-side `meta.truncated`; the memory graph's daemon-side bound has no analogue here), the client cap is the sole density reduction and is reported as such (`graph.tsx:477`); the kind filter (a user action) is never conflated with it.

## Related

- [`prd-015-dashboard-hive-graph-page-index.md`](./prd-015-dashboard-hive-graph-page-index.md) — module scope.
- [`prd-015a-route-registry-and-hivegraphpage`](./prd-015a-route-registry-and-hivegraphpage.md) — owns the page shell + hydration this canvas drops into.
- [`prd-015c-search-box-and-status-widgets`](./prd-015c-search-box-and-status-widgets.md) — owns the search box that drives this canvas's search-to-node focus.
- [`prd-008c-build-status-projection-endpoints`](../../in-work/prd-008-nectar-api-endpoints/prd-008c-build-status-projection-endpoints.md) — owns the projection-read endpoint (`GET /api/hive-graph/projection`) the file graph hydrates from and transforms client-side (decision #39).
- [`prd-005-hive-graph-catalog-tables`](../../completed/prd-005-hive-graph-catalog-tables/prd-005-hive-graph-catalog-tables-index.md) — owns the `hive_graph` table + the `derived_from_nectar` column.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — the `derived_from_nectar` provenance model the edges visualize.
- [`knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) — the authoritative `derived_from_nectar` column definition.

No open questions. The kind taxonomy (what `nodes[].kind` values the file category produces) is an implementation-time derivation from the projection's `files[id].path`, computed client-side, not a decision this PRD pins.
