# PRD-015b: File-graph visualization

> Parent: [`prd-015-dashboard-source-graph-page-index.md`](./prd-015-dashboard-source-graph-page-index.md)
> **Codebase:** `honeycomb` repo → thehive (the page lands in the shared `src/dashboard/web/` module thehive serves).

## Overview

This sub-PRD owns the **file graph** that renders inside `SourceGraphPage`: an Obsidian-style interlink view where **each node is a nectar (a file)** and **each edge is a `derived_from_nectar` provenance link** — the durable "B was forked from A" relationship the minted-identity model produces and content-hash identity cannot. It reuses the existing `GraphWire` node/edge shape and the `GraphPage` interaction primitives (pan/zoom, kind filter, click-to-select → side panel) so the file graph is not a bespoke canvas: it is the same graph view over a different edge semantics.

The visualization rests on three grounded facts:

1. **The edge source is `derived_from_nectar`.** The `source_graph` table carries a `derived_from_nectar TEXT NOT NULL DEFAULT ''` column — "Copy-paste provenance. Empty for an originally-minted file. Set to the source nectar when a new path appears whose content matches an existing file's current content (the copy event). Survives forever, even after both files diverge." ([`knowledge/private/data/source-graph-schema.md:37,51`](../../../knowledge/private/data/source-graph-schema.md)). The model is documented in [`knowledge/private/ai/identity-and-reassociation.md:52,180-188`](../../../knowledge/private/ai/identity-and-reassociation.md): "B is its own identity (N2), and yet it is permanently linked to A (N1) through `derived_from_nectar`."
2. **The node/edge wire shape already exists.** `GraphWire` is `{ built, nodes: GraphNode[], edges: GraphEdge[], meta? }`, where `GraphNode = { id, label, kind }` and `GraphEdge = { from, to, kind }` ([`honeycomb/src/dashboard/web/wire.ts:199-208, 217-224`](../../../../honeycomb/src/dashboard/web/wire.ts)). The file graph maps onto it directly: `id` = the nectar, `label` = the file path, `kind` = a file category; `from`/`to` = nectars, `kind` = `derived_from`.
3. **The interaction is `GraphPage`'s.** The memory graph already implements pan/zoom over the SVG viewBox, a kind filter built from the snapshot's real kinds, click-to-select → side detail panel, and search-to-node focus ([`graph.tsx:435-516`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). The file graph reuses these; only the data source and the side-panel content differ.

## Goals

- Render the file graph as nectar nodes + `derived_from_nectar` edges, reusing the `GraphWire` shape ([`wire.ts:199-208`](../../../../honeycomb/src/dashboard/web/wire.ts)) so no new wire schema is invented.
- Reuse the `GraphPage` interaction primitives — pan/zoom, kind filter, click-to-select → side panel, search-to-node — so the file graph behaves like the memory graph, just over file provenance.
- Hydrate the graph from hivenectar's file-graph endpoint (PRD-008) through thehive's aggregation `wire`, as a new `sourceGraphFileGraph(project)` method mirroring `memoryGraph(project)` ([`wire.ts:1461`](../../../../honeycomb/src/dashboard/web/wire.ts)).
- Render the honest empty state when the graph is unbuilt or hivenectar is unreachable (fail-soft `wire`), and the needs-selection state when no project is chosen — matching `GraphPage` ([`graph.tsx:522-527`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)).
- Keep the canvas bounded: reuse the graph-memory-cap discipline (`capGraphForRender` + the daemon's `meta.truncated` honesty) so a large repo never mounts an unbounded number of SVG nodes — the discipline that the removed codebase-graph view lacked ([`registry.tsx:207-210`](../../../../honeycomb/src/dashboard/web/registry.tsx)).

## Non-Goals

- The route entry + page shell — **015a**. This sub-PRD owns the graph canvas inside the page.
- The search box + status widgets — **015c**. The file graph exposes a search-to-node focus hook the search box drives, but the search box itself is 015c.
- The hivenectar `/api/source-graph/file-graph` (or equivalent) endpoint that produces the nodes/edges payload — **PRD-008**. This sub-PRD specifies the wire shape it consumes.
- The `derived_from_nectar` column or the copy-detection that sets it — **PRD-005** (schema) and **PRD-006** (the copy-event ladder step). This sub-PRD reads the column; it does not define or populate it.
- Symbol-level or directory nectars. The v1 identity model is file-granular (ADR-0001 non-goals); nodes are files, not symbols or directories.
- A merge/cluster view for dense fan-out (one file forked into many). The kind filter + the render cap handle density; a dedicated cluster view is out of scope for v1.

---

## User stories + acceptance criteria

### US-015b.1 — Files are nodes, provenance is edges
**As** an operator, **when** I open the file graph, **I** see one node per file (nectar) and an edge from each copied file to the file it was forked from, **so that** copy-paste provenance is visible at a glance.

| ID | Criterion |
|---|---|
| b-AC-1 | Given the `source_graph` table's rows for the selected project, when the file graph renders, then each node's `id` is the nectar, `label` is the file path, and `kind` is a file category — all carried in the existing `GraphNode` shape ([`wire.ts:199-203`](../../../../honeycomb/src/dashboard/web/wire.ts)). |
| b-AC-2 | Given a row whose `derived_from_nectar` is non-empty ([`source-graph-schema.md:37,51`](../../../knowledge/private/data/source-graph-schema.md)), when the graph renders, then an edge `{ from: <derived nectar>, to: <derived_from_nectar>, kind: "derived_from" }` is drawn in the existing `GraphEdge` shape ([`wire.ts:204-208`](../../../../honeycomb/src/dashboard/web/wire.ts)). |
| b-AC-3 | Given a row whose `derived_from_nectar` is empty (an originally-minted file), when the graph renders, then that node has no outgoing provenance edge — it is a root, not linked. |

### US-015b.2 — The interaction matches the memory graph
**As** an operator familiar with `/graph`, **when** I use the file graph, **I** get the same pan/zoom, kind filter, and click-to-select behavior, **so that** no new interaction model is learned.

| ID | Criterion |
|---|---|
| b-AC-4 | Given the `GraphPage` interaction primitives (pan/zoom over the SVG viewBox, `layout`, `centerOn`, `findNode`, click-to-select, clear-selection — [`graph.tsx:497-516`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)), when the file graph mounts, then it reuses them rather than re-implementing a canvas. |
| b-AC-5 | Given the snapshot carries real file kinds, when the operator toggles a kind chip, then the kind filter hides/shows that category's nodes — mirroring `GraphPage`'s `hiddenKinds` + `applyKindFilter` ([`graph.tsx:442, 472-473, 488-495`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). |
| b-AC-6 | Given the operator clicks a node, when the side detail panel opens, then it shows that file's nectar, path, description, and provenance (`derived_from_nectar` if set) — the file-graph-specific content `GraphPage`'s memory-detail panel does not carry. |

### US-015b.3 — Density is bounded honestly
**As** an operator on a large repo, **when** the file graph exceeds the render cap, **I** see an honest truncation notice, **so that** the canvas stays responsive and I know what was dropped.

| ID | Criterion |
|---|---|
| b-AC-7 | Given the fetched graph exceeds `MAX_RENDER_NODES`, when the client render cap fires, then `capGraphForRender` ([`wire.ts:1807-1815`](../../../../honeycomb/src/dashboard/web/wire.ts)) bounds what is drawn and the page reports `capped` exactly as `GraphPage` does ([`graph.tsx:477, 482`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). |
| b-AC-8 | Given hivenectar's file-graph payload carries `meta.truncated` (server-side drop counts), when the daemon bounded the snapshot, then the page surfaces `serverTruncated` distinctly from the client `capped` backstop — never conflating server truncation with a client render cap ([`graph.tsx:480-484`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). |

### US-015b.4 — Empty + unreachable states are honest
**As** an operator, **when** no project is selected or hivenectar is down, **I** see an explicit state, **so that** the page never silently shows the wrong (or no) graph.

| ID | Criterion |
|---|---|
| b-AC-9 | Given no project is selected (`scope.project === undefined`), when the page renders, then it shows the needs-selection state and does NOT fetch — mirroring `GraphPage` ([`graph.tsx:438-439, 449-456, 522-524`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)); no other project's file graph is ever shown. |
| b-AC-10 | Given hivenectar is unreachable, when the `wire.sourceGraphFileGraph(project)` call fails, then the graph degrades to `EMPTY_GRAPH` ([`wire.ts:1779`](../../../../honeycomb/src/dashboard/web/wire.ts)) and the page renders the empty state; thehive marks the source unreachable, not a blank dashboard ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) c-AC-6). |

---

## Implementation notes

### Node/edge mapping (reuse, do not invent)

The file graph maps directly onto the existing `GraphWire` ([`wire.ts:217-224`](../../../../honeycomb/src/dashboard/web/wire.ts)):

| `GraphWire` field | File-graph meaning | Source |
|---|---|---|
| `built` | whether hivenectar has described any files for the project | the file-graph endpoint (PRD-008) |
| `nodes[].id` | the nectar (ULID) | `source_graph.nectar` ([`source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md)) |
| `nodes[].label` | the file path | `source_graph.path` |
| `nodes[].kind` | a file category (e.g. extension / dir) | derived for the kind filter |
| `edges[].from` | the derived (copied) nectar | a row with non-empty `derived_from_nectar` |
| `edges[].to` | the source nectar | that row's `derived_from_nectar` value |
| `edges[].kind` | `"derived_from"` | constant |
| `meta` | server truncation counts | the endpoint's `meta` (mirrors `GraphMetaSchema`, [`wire.ts:210-216`](../../../../honeycomb/src/dashboard/web/wire.ts)) |

No new wire schema: the file graph IS a `GraphWire` over file provenance. The edge direction (`from` = derived, `to` = source) matches the identity model's framing — "B … is permanently linked to A … through `derived_from_nectar`" where B is the newer nectar ([`identity-and-reassociation.md:180-184`](../../../knowledge/private/ai/identity-and-reassociation.md)).

### Hydration

The page calls a new `wire.sourceGraphFileGraph(project)` method — mirroring `memoryGraph(project)` ([`wire.ts:1461`](../../../../honeycomb/src/dashboard/web/wire.ts)) — inside the `usePoll` lifecycle 015a establishes. thehive's aggregation `wire` routes the call to hivenectar's file-graph endpoint (PRD-008) ([PRD-004c](../prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) "API aggregation layer"). The poll interval reuses the graph-poll discipline (`GRAPH_POLL_MS` in `graph.tsx`) — a light refresh, paused in background tabs (`isTabHidden()`, [`graph.tsx:459`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)).

### Interaction reuse

The file graph reuses `GraphPage`'s pure interaction surface: the shared `layout(...)` function, `centerOn`, `findNode`, the kind-filter machinery, click-to-select → side panel, and the zoom/fit controls ([`graph.tsx:471-516`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). The side panel's *content* is file-graph-specific (nectar + path + description + `derived_from_nectar`), but the panel *mechanism* is shared. The search-to-node focus hook (`onSearch` → `findNode` → `setSelected` → `centerOn`, [`graph.tsx:497-509`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)) is the seam 015c's search box drives to highlight matching nectars on the canvas.

### Density discipline (the lesson)

The removed codebase-graph view was "too dense to be useful" ([`registry.tsx:207-210`](../../../../honeycomb/src/dashboard/web/registry.tsx)). The file graph avoids the same fate by inheriting `GraphPage`'s two-layer density control: the daemon-side `meta.truncated` bound (honest server counts) and the client-side `capGraphForRender` backstop (`MAX_RENDER_NODES`, [`wire.ts:1807-1815`](../../../../honeycomb/src/dashboard/web/wire.ts); [`graph.tsx:477`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)), reported as two distinct reductions ([`graph.tsx:480-484`](../../../../honeycomb/src/dashboard/web/pages/graph.tsx)). The kind filter (a user action) is never conflated with either truncation.

## Related

- [`prd-015-dashboard-source-graph-page-index.md`](./prd-015-dashboard-source-graph-page-index.md) — module scope.
- [`prd-015a-route-registry-and-sourcegraphpage`](./prd-015a-route-registry-and-sourcegraphpage.md) — owns the page shell + hydration this canvas drops into.
- [`prd-015c-search-box-and-status-widgets`](./prd-015c-search-box-and-status-widgets.md) — owns the search box that drives this canvas's search-to-node focus.
- [`prd-008-hivenectar-api-endpoints`](../prd-008-hivenectar-api-endpoints/prd-008-hivenectar-api-endpoints-index.md) — owns the file-graph endpoint producing the `GraphWire` payload.
- [`prd-005-source-graph-catalog-tables`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — owns the `source_graph` table + the `derived_from_nectar` column.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — the `derived_from_nectar` provenance model the edges visualize.
- [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the authoritative `derived_from_nectar` column definition.

No open questions. The kind taxonomy (what `nodes[].kind` values the file category produces) is an implementation-time derivation from the file-graph payload owned by PRD-008, not a decision this PRD pins.
