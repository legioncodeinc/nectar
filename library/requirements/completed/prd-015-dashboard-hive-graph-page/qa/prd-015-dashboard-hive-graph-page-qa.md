# QA Report: PRD-015 Dashboard Hive Graph Page (PRD-vs-Corpus-vs-Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Wave-0 spec-QA gate audit of PRD-015 (index + 015a/015b/015c) against the Nectar knowledge corpus and the real hive dashboard code it cites, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass; PRD-015's implementation lands out-of-band in the `hive` repo (the page joins hive's owned dashboard module), and no hive or honeycomb source file was modified by this audit. Matches the bar and format of [`prd-013-recall-arm-hive-graph-qa.md`](../../../in-work/prd-013-recall-arm-hive-graph/qa/prd-013-recall-arm-hive-graph-qa.md). Every acceptance criterion and load-bearing claim was traced to the corpus ([`data/hive-graph-schema.md`](../../../../knowledge/private/data/hive-graph-schema.md), [`ai/identity-and-reassociation.md`](../../../../knowledge/private/ai/identity-and-reassociation.md)), to [`PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md) decisions #1/#9/#12/#34/#35, to [`PRD-003-016-WAVE-PLAN.md`](../../../PRD-003-016-WAVE-PLAN.md) (Wave E exit gate), and to the real files under `hive/src/dashboard/web/` plus `honeycomb/src/daemon/runtime/memories/recall.ts`.

**Related:**
- [`prd-015-dashboard-hive-graph-page-index.md`](../prd-015-dashboard-hive-graph-page-index.md)
- [`../../../PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md)
- [`../../../PRD-003-016-WAVE-PLAN.md`](../../../PRD-003-016-WAVE-PLAN.md)
- [`../../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md`](../../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md)
- [`../../../in-work/prd-013-recall-arm-hive-graph/qa/prd-013-recall-arm-hive-graph-qa.md`](../../../in-work/prd-013-recall-arm-hive-graph/qa/prd-013-recall-arm-hive-graph-qa.md)

---

## 1. Summary

PRD-015's spec substance is strong: the route/label/identifier surface is fully decision-#35 conformant (zero Hivenectar / source-graph / thehive residue; `hive-graph` route, `HiveGraphPage`/`HiveGraphIcon`/`hiveGraph*` identifiers), the route `/hive-graph` and label "Hive Graph" match decision #34/§B exactly, the port-3853 claim matches decision #12, the not-a-third-graph-on-`/graph` constraint (the wave-plan Wave E exit-gate AC) is carried both as module AC-7 and as an explicit Non-Goal grounded in the real density-failure comment, and the corpus claims (the `derived_from_nectar TEXT NOT NULL DEFAULT ''` column, its verbatim purpose text, the "B is its own identity (N2), and yet it is permanently linked to A (N1)" provenance framing, and the ~$3.05/2000-files cost attribution to PRD-007) all trace verbatim to their sources. Every cited dashboard symbol (`RouteEntry`, `ROUTES`, `matchRoute`, `PageProps`, `usePoll`, `GraphWire`/`GraphNode`/`GraphEdge`/`GraphMetaSchema`, `memoryGraph`, `recall`, `kpis`, `buildGraph`, `EMPTY_GRAPH`, `MAX_RENDER_NODES`, `capGraphForRender`, `useScope`, `isTabHidden`, `GRAPH_POLL_MS`, `findNode`/`centerOn`, `NeedsProjectSelection`) exists and was verified in the real module, and the `graph.tsx` line citations were exact to the line. However, the module was authored against the pre-rename world and had drifted on four systemic fronts, all remediated in this pass: (W-2) all 79 dashboard code references cited the RETIRED `honeycomb/src/dashboard/web/` location as non-resolving markdown links, when the module lives at `hive/src/dashboard/web/` per hive ADR-0001 (copy-and-own; honeycomb's copy retired); (W-3) eight prose sites asserted the superseded hosting mechanism ("a daemon in the honeycomb repo", "hive imports and serves" the honeycomb module), contradicting PRD-004c's reconciled copy-and-own state; (W-4) four sites specified the superseded client-side federation ("hive's aggregation client... routes each request to the owning daemon") instead of hive ADR-0002's server-side BFF proxy (`hive/src/daemon/proxy.ts`); (W-5) 25 cross-PRD links assumed pre-move `backlog/` siblings for PRDs 001/004/005 (now `completed/`) and 007/012 (now `in-work/`). Also fixed: (W-6) drifted `registry.tsx`/`wire.ts`/`page-frame.tsx` line citations (the hive registry gained Projects/Health/ROI entries; `wire.ts` shifted +6/+9), (W-7) retired-hash-router residue (`#/hive-graph`, "unknown hash", "routes the hash"; routing is path-based per PRD-003c), and (W-8) a `hive_graph.path` column attribution (the `path` column lives on `hive_graph_versions`, not `hive_graph`). One substantive gap is REPORTED, not fixed: (W-1) the file-graph nodes/edges endpoint 015b hydrates from (`hiveGraphFileGraph` → a `GraphWire` payload) is attributed to PRD-008, but PRD-008's authored scope is search/build/status/projection only; no PRD owns that endpoint today. **Verdict: PASS-with-warnings** at medium-and-above (zero Criticals; W-1 open, W-2..W-8 remediated in place).

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-015 index | PASS | WARNING (W-3, W-6, W-7; fixed) | PASS | WARNING (W-1, resolved 2026-07-02) | WARNING (W-2, W-5; fixed) | PASS-with-warnings |
| PRD-015a | PASS | WARNING (W-3, W-4, W-6, W-7; fixed) | PASS | PASS | WARNING (W-2, W-5; fixed) | PASS-with-warnings |
| PRD-015b | PASS | WARNING (W-6, W-8; fixed) | PASS | WARNING (W-1, resolved 2026-07-02) | WARNING (W-2, W-5; fixed) | PASS-with-warnings |
| PRD-015c | PASS | WARNING (W-4, W-6; fixed) | PASS | PASS | WARNING (W-2, W-5; fixed) | PASS-with-warnings |

## 3. Critical Issues (must fix)

None. Every cited dashboard and daemon symbol exists in the real code; the decision-#34/#35 route/label/identifier surface is exactly conformant; the corpus quotes are verbatim; no invented DEFAULT values and no filled deliberate gaps were found.

## 4. Warnings (should fix)

### W-1 (Gaps, index + 015b, RESOLVED 2026-07-02): the file-graph nodes/edges endpoint has no owning PRD

PRD-015b hydrates its canvas from "nectar's file-graph endpoint (PRD-008)" via a new `wire.hiveGraphFileGraph(project)` method returning a `GraphWire`-shaped nodes/edges payload (`prd-015b-file-graph-visualization.md` §Hydration, b-AC-10; index §API changes). PRD-015's Non-Goals correctly delegate the endpoint to PRD-008 ("The nectar API endpoints the page calls (`/api/hive-graph/search`, `/status`, `/build`, the file-graph payload) — PRD-008"). But PRD-008 as authored does not own it:

- PRD-008's index scopes exactly four concerns: search, build trigger, status, and projection CRUD (`prd-008-nectar-api-endpoints-index.md:14`), across sub-PRDs 008a (route-group scaffolding), 008b (`/search`), 008c (`/build`, `/status`, projection read/regenerate) (`:44-46`).
- A search of the whole PRD-008 module for `file-graph`, `nodes`, `edges`, `GraphWire`, and `derived_from` returns **zero** matches. No PRD-008 acceptance criterion produces a nodes/edges payload.

Impact: if PRD-008 lands as authored, PRD-015b's core ACs (b-AC-1/b-AC-2/b-AC-10) have no upstream data source; the graph either cannot hydrate or must be derived client-side from the projection read (a design decision no PRD has made). This is a cross-PRD contract hole, not a defect inside PRD-015's own text (015b even hedges "`/api/hive-graph/file-graph` (or equivalent)"), so it is a Warning here and the remediation belongs to the PRD author: either (a) add a file-graph endpoint (nodes from the latest described version rows, edges from `hive_graph.derived_from_nectar`, `meta` truncation counts mirroring `GraphMetaSchema`) to PRD-008c's scope, or (b) respecify 015b to synthesize the graph from the projection read, and say which. **Reported for `library-worker-bee` / the PRD-008 author; not fixable from inside this folder.**

**W-1 remediation (2026-07-02, RESOLVED, branch (b)):** resolved by respec, not by a new endpoint. The projection document (`src/projection/format.ts` `PortableProjection`; [`data/portable-registry.md`](../../../../knowledge/private/data/portable-registry.md) § The file format) carries every field the file graph needs: the `files` map (keyed by nectar ULID, each entry carrying `path`/`title`/`description`) supplies node `id`/`label` and the side-panel content, and the `derived` map (keyed by the derived nectar, carrying `from_nectar`) supplies the provenance edges. The decision rule therefore fired on its preferred branch: the projection carries the full node/edge field set, so PRD-015b was respecified to hydrate the file graph from PRD-008c's EXISTING projection-read endpoint (`GET /api/hive-graph/projection`) as a client-side transform, adding **zero** new nectar API surface and leaving PRD-008's authored scope intact (recorded as decision #39 in [`PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md)). Because the projection is complete (latest-per-nectar, no server-side truncation), b-AC-8 was respecified so the client-side `capGraphForRender` cap is the sole density bound and no `serverTruncated` count is fabricated. Sites updated: `prd-015b` (Goals, Non-Goals, overview facts, b-AC-1/b-AC-2/b-AC-3/b-AC-6/b-AC-8, the node/edge mapping table, §Hydration, §Density, Related, closing note), the `prd-015` index (§Non-Goals, §API changes), and `prd-015a` (§The wire seam). The `hiveGraphFileGraph(project)` wire-method name is unchanged (a hive-side aggregation client method, now backed by the projection read). **No PRD-008 scope change: the concurrent Wave D worker implementing PRD-008 need NOT be informed.**

### W-2 (Detrimental Patterns, all four files, FIXED): 79 dashboard code refs cited the retired `honeycomb/src/dashboard/web/` as non-resolving markdown links

Every dashboard code citation was wrapped in a markdown link targeting `../../../../honeycomb/src/dashboard/web/...`. The target failed twice over: (1) from `backlog/prd-015-dashboard-hive-graph-page/`, four `../` levels resolve to the nectar repo root, and honeycomb is a sibling repo under `the-apiary/`, so the path never resolved (the same systemic class as W-3 in the PRD-013 QA report; cross-repo code must be a backtick span, never a markdown link); and (2) the pointed-at module no longer exists there: honeycomb's `src/dashboard/` has no `web/` folder (verified on disk), because the dashboard was copied and owned into the `hive` repo and retired from honeycomb per hive ADR-0001 (see [`prd-004c-hive-portal-daemon.md`](../../../completed/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md) header + implementation note). The live module is `hive/src/dashboard/web/` (registry.tsx, wire.ts, page-frame.tsx, pages/graph.tsx all verified present).

Token counts (pre-fix, from `git diff`): index 14, 015a 30, 015b 25, 015c 10; **total 79**. Two further honeycomb links rode the same fix: the `recall.ts:2089` daemon-code link in 015a §Project scope (correct repo, wrong form; now the full-form span `honeycomb/src/daemon/runtime/memories/recall.ts:2089`) and the index's `adding-a-page.md` link (that doc genuinely still lives at `honeycomb/library/knowledge/private/dashboard/adding-a-page.md`, verified on disk; now a full-form backtick span). 81 links unwrapped in all.

**Remediation applied:** every markdown-link wrapper dropped, keeping the backtick span; every `honeycomb/src/dashboard/web` path token repointed to `hive/src/dashboard/web`; both sub-PRD `Codebase:` headers and the index's schema-changes line now name the `hive` repo. Re-verified: `rg -c 'honeycomb/src/dashboard'` and `rg -n '\]\((\.\./)+honeycomb'` both return zero across the four files.

### W-3 (Correctness, index + 015a, FIXED): hosting-model prose contradicted PRD-004c's reconciled copy-and-own state

Eight sites asserted the superseded mechanism: the index header called hive "a daemon in the honeycomb repo"; the index overview said hive "reuses honeycomb's existing `src/dashboard/web/` code"; 015a's Codebase header said "the route + component land in the honeycomb repo's shared dashboard module, which hive imports and serves"; 015a said "hive serves the same `ROUTES` list unchanged", "Because hive imports and serves the same `ROUTES`... the entry needs no hive-side duplicate", and a user story hydrated "identically whether served by honeycomb or hive". PRD-004c (completed, the owning PRD) reconciled all of this: hive is a first-class product in its own `hive` repo; it OWNS a copy of the dashboard (copied from honeycomb and retired there, hive ADR-0001); there is no cross-repo runtime import and no second live copy (`prd-004c-hive-portal-daemon.md:3,7,9,16,48,82`). Decisions #1/#9's "reuses honeycomb dashboard code" survive as the copy's provenance, so the decision itself is not contradicted; the import-at-runtime mechanism is.

**Remediation applied:** all eight sites corrected to the copy-and-own framing with explicit hive ADR-0001 attribution (index header + overview fact 1; 015a Codebase header, §Overview c-AC-3 sentence, a-AC-3, §The registry entry closing sentence, US-015a.2 rationale; 015b/015c Codebase headers). The load-bearing consequences the PRD draws (one `RouteEntry` is the whole wiring; no sidebar/router hand-edit; the entry lands once) are unchanged and remain true.

### W-4 (Correctness, 015a + 015c, FIXED): client-side federation mechanism superseded by hive ADR-0002's server-side BFF proxy

Four sites specified that the page's `wire` "routes each request to the owning daemon" / maps requests "to nectar's host (its registry entry's `healthUrl` host)" as a CLIENT behavior. Per hive ADR-0002 (and PRD-004c's reconciled c-AC-5 + §API aggregation), the browser `wire` fetches hive's own origin same-origin, exactly as honeycomb's in-process dashboard did; hive's SERVER (`hive/src/daemon/proxy.ts`, verified on disk) owns the federation, forwarding each `/api/hive-graph/*` request over loopback to nectar. The earlier client-side federation was explicitly superseded because it forced CORS onto every workload daemon.

**Remediation applied:** 015a Goal 4 and §The wire seam, and 015c §Wire seam lead + closing sentence, now state the same-origin `wire` + server-side proxy split with ADR-0002 attribution. The generic "through hive's aggregation `wire`" shorthand in ACs is retained (it names PRD-004c's own section and the ACs it cites are themselves annotated as reconciled).

### W-5 (Detrimental Patterns, all four files, FIXED): 25 lifecycle-stale cross-PRD links

25 links used `../prd-0XX-.../` sibling-folder paths, assuming those PRDs still live in `backlog/` alongside PRD-015. Per the on-disk lifecycle folders (verified: `ls backlog/ completed/ in-work/`): PRD-001, PRD-004, PRD-005 are in `completed/`; PRD-007, PRD-012 are in `in-work/`. Counts (from `git diff`): PRD-004c 19, PRD-001 1, PRD-005 2, PRD-012 2, PRD-007 1. The PRD-008 sibling links (4 sites) were already correct (PRD-008 is a genuine `backlog/` sibling) and were untouched. Same defect class as W-4 in the PRD-013 QA report.

**Remediation applied:** `](../prd-004-...` → `](../../completed/prd-004-...` (19), `](../prd-001-...` → `](../../completed/prd-001-...` (1), `](../prd-005-...` → `](../../completed/prd-005-...` (2), `](../prd-012-...` → `](../../in-work/prd-012-...` (2), `](../prd-007-...` → `](../../in-work/prd-007-...` (1). Re-verified with a full link-resolution scan: every remaining markdown link in the four files resolves on disk (zero BROKEN).

### W-6 (Correctness, all four files, FIXED): drifted line citations in `registry.tsx`, `wire.ts`, and `page-frame.tsx`

The hive copy of `registry.tsx` gained the Projects, Health, and ROI route entries, and `wire.ts` gained interface members, so the honeycomb-era line citations drifted. Every cited symbol was re-verified in `hive/src/dashboard/web/` and the citations corrected (drifted-but-findable throughout; no symbol was missing):

| Citation | Was | Now (verified) |
|---|---|---|
| `ROUTES` | `registry.tsx:196-218` | `registry.tsx:204-231` |
| `matchRoute` | `registry.tsx:230-240` | `registry.tsx:243-253` |
| Dashboard default fallback | `registry.tsx:221, 239` | `registry.tsx:234, 252` |
| density-failure comment | `registry.tsx:207-210` | `registry.tsx:215-218` |
| `RouteEntry` shape | `registry.tsx:83-94` | `registry.tsx:84-95` |
| `component: React.ComponentType<PageProps>` | `registry.tsx:91` | `registry.tsx:92` |
| `/harnesses` dynamic entry | `registry.tsx:205` | `registry.tsx:210-213` |
| icon doc + `Icon` helper | `registry.tsx:88-89, 96-100` | `registry.tsx:89-90, 98-104` |
| sidebar+outlet both read `ROUTES` | `registry.tsx:6-9` | `registry.tsx:4-8` |
| shared-wire "never createWireClient" | `registry.tsx:13-16` | `registry.tsx:11-13` |
| `memoryGraph` | `wire.ts:1461` | `wire.ts:1467` |
| `recall` | `wire.ts:1479` | `wire.ts:1485` |
| `kpis` | `wire.ts:1442` | `wire.ts:1448` |
| `buildGraph` (interface / impl) | `wire.ts:1608` / `2123` | `wire.ts:1614` / `2132` |
| `EMPTY_GRAPH` | `wire.ts:1779` | `wire.ts:1785` |
| `capGraphForRender` | `wire.ts:1807-1815` | `wire.ts:1813-1828` |
| `PageProps` interface | `page-frame.tsx:32-39` | `page-frame.tsx:32-51` (gained `pollinating` + `healthReasons`) |

Citations verified EXACT and left untouched: `registry.tsx:10-22` (how-to-add contract), `:21` (adding-a-page pointer), `:24-27` (no-new-dependency icon posture), `:87-88` (label doc, 037c OQ-2); every `graph.tsx` citation (`435-482`, `449-469`, `438-439`, `449-456`, `457-469`, `442`, `459`, `471-516`, `472-473`, `477`, `480-484`, `488-495`, `497-509`, `497-516`, `522-524`, `522-527`); `wire.ts:199-203`, `:204-208`, `:199-208`, `:210-216`, `:217-224`; `page-frame.tsx:32-34`, `:10-17`; `recall.ts:2089` (`const projectClause = projectConjunctFor(request);`, exact).

### W-7 (Correctness, index + 015a, FIXED): retired-hash-router residue

Four sites still spoke the hash-router dialect: a-AC-1 routed "`#/hive-graph`", a-AC-2 keyed on "an unknown hash", 015a's overview quoted the registry contract as "the outlet routes the hash to the component" (the live comment says "routes the path", `hive/src/dashboard/web/registry.tsx:15`), and the index's route DEFAULT called `/hive-graph` "a path-like hash key". The hash router is retired: hive's routing is path-based History-API routing, server-routed per PRD-003c (`hive/src/dashboard/web/router.tsx:2-16`, "This RETIRES `useHashRoute` / `routeFromHash`"), and `RouteEntry.route` is "the real, server-served path" (`registry.tsx:78`).

**Remediation applied:** a-AC-1 now routes "the `/hive-graph` path" with the PRD-003c/router.tsx grounding, a-AC-2 says "an unknown path", the overview quote matches the live comment verbatim ("routes the path"), and the DEFAULT row says "a real, server-served path". The flagged-DEFAULT status of the route value itself is unchanged.

### W-8 (Correctness, 015b, FIXED): `nodes[].label` sourced from a nonexistent `hive_graph.path` column

015b's node/edge mapping table sourced `nodes[].label` from `hive_graph.path`. The `hive_graph` DDL has no `path` column (columns: `nectar`, `kind`, `created_at`, `derived_from_nectar`, `fork_content_hash`, `org_id`, `workspace_id`, `project_id`, `last_update_date`; [`hive-graph-schema.md:33-43`](../../../../knowledge/private/data/hive-graph-schema.md)). `path` lives on `hive_graph_versions` (`hive-graph-schema.md:69`), is carried per version row, and is mutable across rows for the same nectar (that is how moves are recorded, `:96`); the label therefore comes from the nectar's LATEST version row, the same latest-per-nectar discipline PRD-012/PRD-013 use. `nodes[].id` = `hive_graph.nectar` and the edge mapping from `derived_from_nectar` were verified correct and untouched.

**Remediation applied:** the mapping-table row now reads "the nectar's latest `hive_graph_versions.path` row (`hive-graph-schema.md:69,96`...)".

## 5. Suggestions (consider improving)

- **S-1 (completeness, index + 015a, FIXED):** the index §API changes and 015a §The wire seam enumerated three new `wire` methods (`hiveGraphFileGraph`, `hiveGraphSearch`, `hiveGraphStatus`) but omitted `hiveGraphBuild()`, which 015c c-AC-8 specifies as a fourth. Both enumerations now include it.
- **S-2 (stale sibling doc, REPORTED, outside write scope):** [`PRD-003-016-WAVE-PLAN.md`](../../../PRD-003-016-WAVE-PLAN.md) §Cross-repo caveat still says 004c/004d/015 land in "the honeycomb repo (the new `hive` package)"; superseded by hive being a first-class repo (PRD-004c header, hive ADR-0001). Not fixable from inside this PRD folder; flagged for the wave plan's owner.
- **S-3 (citation precision, 015b, not fixed, sub-medium):** b-AC-7 cites `graph.tsx:477, 482` for "reports `capped` exactly as `GraphPage` does"; line 477 (the `capGraphForRender` destructure) is exact, but 482 is a comment line, and the operative combined-report line is 484 (`const truncated = serverTruncated || capped;`). Findable within the cited neighborhood; left as a note rather than a judgment-call widening (same treatment as S-2 in the PRD-013 QA report).

## 6. Plan Item (AC) Traceability

### PRD-015 index (7 ACs)

| AC | Corpus / code / decision source | Verdict |
|---|---|---|
| AC-1 route via one `RouteEntry`, sidebar item, `matchRoute` mount | `hive/src/dashboard/web/registry.tsx:204-231` (`ROUTES`), `:243-253` (`matchRoute`), `:14-15` (one-entry contract) | PASS (line cites fixed, W-6) |
| AC-2 `PageProps` + `wire`/`usePoll` hydration mirroring `GraphPage` | `registry.tsx:92`, `page-frame.tsx:32-51` + `:12-17` (`usePoll` recipe), `graph.tsx:435-482` | PASS |
| AC-3 nodes = nectars, edges = `derived_from_nectar`, reuse `GraphWire` | `hive-graph-schema.md:37,51`; `identity-and-reassociation.md:180-188`; `wire.ts:199-208` | PASS |
| AC-4 search box → `/api/hive-graph/search` (PRD-012) via `wire` | `prd-008b-search-endpoint` + PRD-012 index (in-work, verified); `wire.ts:1485` (`recall` shape mirrored) | PASS |
| AC-5 status/queue/cost widgets → `/status` + `/build` (PRD-008) | `prd-008-nectar-api-endpoints-index.md:14,25` (status fields verbatim: queue depth, `describe_status` counts, cost counter) | PASS |
| AC-6 nectar down → shell + unreachable source, not a blank | PRD-004c c-AC-2 (`prd-004c-hive-portal-daemon.md:40`) + the fail-soft generalization (`:90`) | PASS |
| AC-7 NEW route, not a third graph on `/graph` | `registry.tsx:215-218` (density-failure comment, verbatim); wave plan §Wave E exit gate ("the page is not a third graph on `/graph`") | PASS |

### PRD-015a (7 ACs)

| AC | Source | Verdict |
|---|---|---|
| a-AC-1 one `RouteEntry`, sidebar + path-routed outlet | `registry.tsx:204-231`, `router.tsx:2-16` (path routing) | PASS (post W-7 fix) |
| a-AC-2 unknown path → Dashboard default; exact match only | `registry.tsx:234, 252` (`DEFAULT_ROUTE` + fallback), `:243-253` | PASS |
| a-AC-3 entry in hive's owned `ROUTES`, no second registry | PRD-004c c-AC-3 as reconciled (hive ADR-0001 copy-and-own) | PASS (post W-3 fix) |
| a-AC-4 `PageProps` + `usePoll` recipe mirroring `GraphPage` | `registry.tsx:92`; `graph.tsx:449-469` (exact: effect, `tick`, interval, cleanup) | PASS |
| a-AC-5 wire method → proxied to nectar `/api/hive-graph/*` | PRD-004c c-AC-5 (reconciled, server-side proxy `hive/src/daemon/proxy.ts`) | PASS (post W-4 fix) |
| a-AC-6 nectar unreachable → empty state + unreachable source | PRD-004c c-AC-6; `wire.ts` fail-soft pattern (`EMPTY_GRAPH`, `wire.ts:1785`) | PASS |
| a-AC-7 renders inside `<PageFrame title="Hive Graph">`, no own chrome | `page-frame.tsx:57-66` + the 037c AC-1 contract (`page-frame.tsx:8-10`) | PASS |

### PRD-015b (10 ACs)

| AC | Source | Verdict |
|---|---|---|
| b-AC-1 node `id`/`label`/`kind` in the `GraphNode` shape | `wire.ts:199-203` (exact); label source fixed to latest `hive_graph_versions.path` (W-8) | PASS |
| b-AC-2 edge from non-empty `derived_from_nectar` in `GraphEdge` shape | `hive-graph-schema.md:37,51` (verbatim); `wire.ts:204-208` (exact) | PASS |
| b-AC-3 empty `derived_from_nectar` → root node, no provenance edge | `hive-graph-schema.md:51` ("Empty for an originally-minted file") | PASS |
| b-AC-4 reuse pan/zoom/`layout`/`centerOn`/`findNode`/select primitives | `graph.tsx:497-516` (all symbols verified: `findNode:118`, `centerOn:126`, etc.) | PASS |
| b-AC-5 kind chips mirror `hiddenKinds` + `applyKindFilter` | `graph.tsx:442, 472-473, 488-495` (exact) | PASS |
| b-AC-6 side panel shows nectar/path/description/provenance | file-graph-specific content, mechanism shared with `GraphPage`'s panel | PASS |
| b-AC-7 client cap via `capGraphForRender` + `capped` report | `wire.ts:1813-1828` (fixed, W-6); `graph.tsx:477` (exact; see S-3 on `482`) | PASS |
| b-AC-8 projection is complete → client `capped` is the sole density bound (respec, W-1/decision #39) | `graph.tsx:477` (client cap); [`portable-registry.md`](../../../../knowledge/private/data/portable-registry.md) § The file format (no server-side truncation in the projection) | PASS |
| b-AC-9 no project → needs-selection, no fetch | `graph.tsx:438-439, 449-456, 522-524` (exact; `NeedsProjectSelection`) | PASS |
| b-AC-10 fetch failure → `EMPTY_GRAPH` + unreachable source | `wire.ts:1785` (fixed); PRD-004c c-AC-6 | PASS; data source is PRD-008c's projection read (W-1 resolved, decision #39) |

### PRD-015c (8 ACs)

| AC | Source | Verdict |
|---|---|---|
| c-AC-1 search box → `wire.hiveGraphSearch` → `/api/hive-graph/search` | PRD-008b + PRD-012 (semantics); mirrors `recall` (`wire.ts:1485`, fixed) | PASS |
| c-AC-2 results show path + description (`hive_graph_versions`) | PRD-012's result shape (latest described version per nectar) | PASS |
| c-AC-3 result click → 015b's `findNode` → `setSelected` → `centerOn` | `graph.tsx:497-509` (exact) | PASS |
| c-AC-4 no project → search disabled, no cross-project query | matches 015b b-AC-9 + the recall arms' server-side `project_id` scoping (`recall.ts:2089`, exact) | PASS |
| c-AC-5 widgets → `wire.hiveGraphStatus` → `/status` fields | PRD-008's status surface (`prd-008-nectar-api-endpoints-index.md:25`: queue depth + `describe_status` counts + cost counter, verbatim) | PASS |
| c-AC-6 `usePoll` refresh, background-tab pause | `graph.tsx:459` (`isTabHidden()`, exact); `page-frame.tsx` `usePoll` | PASS |
| c-AC-7 status fetch fails → unreachable, not stale/zeroed | PRD-004c c-AC-6 fail-soft | PASS |
| c-AC-8 build trigger → `wire.hiveGraphBuild()` mirroring `buildGraph()` | `wire.ts:1614, 2132` (fixed, W-6); `/api/hive-graph/build` is PRD-008c's (`prd-008-...-index.md:25,46`) | PASS |

## 7. Decision and dependency conformance (audit scope items 2-4)

- **Decision #1 / #9 (hive stack, dashboard reuse):** conformant. hive as the always-on portal hosting the page, TS/Node + Hono, dashboard code originating from honeycomb; the PRD now states the reuse through the hive-ADR-0001 copy-and-own refinement PRD-004c already reconciled to (W-3 fixed), so the decision text and the mechanism text no longer diverge.
- **Decision #34 / §B Dashboard (route + label):** exact. Route `/hive-graph` and label "Hive Graph" match §B "Dashboard (PRD-015)" verbatim, and both are carried as flagged DEFAULTs consistent with #34's "015 route/label follow the same adopt-as-documented posture at their waves".
- **Decision #35 (rename):** clean. Zero `Hivenectar` / `source-graph` / `source graph` / `SourceGraph` / `source_graph` / `thehive` tokens in the PRD text (grep-verified); the route is `hive-graph`, tables are `hive_graph`/`hive_graph_versions`, identifiers are `HiveGraphPage` / `HiveGraphIcon` / `hiveGraphFileGraph` / `hiveGraphSearch` / `hiveGraphStatus` / `hiveGraphBuild`; the line citations that drifted after the rename-era restructure are fixed (W-2, W-6).
- **Decision #12 (ports):** conformant. The index's Related entry claims "hive serves on port 3853 (locked port contract)", matching #12's `hive=3853` exactly.
- **Wave-plan AC (not a third graph on `/graph`):** conformant. Module AC-7 states it as an acceptance criterion, the Non-Goals rule it out explicitly, and both ground it in the real removal comment (`hive/src/dashboard/web/registry.tsx:215-218`: "the codebase-graph view was removed from the dashboard (it was too dense to be useful); this page now shows ONLY the memory/knowledge graph"), satisfying the Wave E exit-gate wording.
- **Lifecycle link sweep (001-006/010/011/014/017 in `completed/`; 007/012/013/016 in `in-work/`; 008/009 in `backlog/`):** PRD-015's cross-links to that population are PRD-001, PRD-004, PRD-005 (→ `completed/`), PRD-007, PRD-012 (→ `in-work/`), and PRD-008 (`backlog/` sibling, already correct). The 25 stale links are fixed (W-5); no links to PRD-002/003/006/009/010/011/013/014/016/017 exist in this module.
- **No invented DEFAULTs, deliberate gaps preserved:** the three flagged DEFAULTs (route, label, icon) match §B or defer honestly (icon is an implementation-time pick from the existing inline-SVG idiom, `registry.tsx:24-27`); the kind taxonomy and the `/status` payload field set are explicitly deferred to PRD-008; no symbol-level or directory nectars (ADR-0001 non-goals honored in both Non-Goals sections); no TLSH/review-matches gap is touched by this PRD.

## 8. Files Audited

- `prd-015-dashboard-hive-graph-page-index.md`, audited and remediated (W-2, W-3, W-5, W-6, W-7, S-1 fixed; W-1 reported).
- `prd-015a-route-registry-and-hivegraphpage.md`, audited and remediated (W-2, W-3, W-4, W-5, W-6, W-7, S-1 fixed).
- `prd-015b-file-graph-visualization.md`, audited and remediated (W-2, W-3 header, W-5, W-6, W-8 fixed; W-1 reported; S-3 reported).
- `prd-015c-search-box-and-status-widgets.md`, audited and remediated (W-2, W-3 header, W-4, W-5, W-6 fixed).

No corpus file, no other PRD folder, and no hive/honeycomb source file was modified by this audit; all reads of `hive/src/**`, `honeycomb/src/**`, and `library/knowledge/private/**` were read-only verification. Only files inside `prd-015-dashboard-hive-graph-page/` were edited, per the remediation policy.

**Overall verdict (as-audited, pre-remediation): PASS-with-warnings** (medium-and-above). Zero Critical findings. Eight Warnings: seven mechanical/drift defect classes (W-2 79 retired-path code refs as non-resolving markdown links, W-3 superseded hosting-model prose, W-4 superseded client-side federation prose, W-5 25 lifecycle-stale links, W-6 drifted line citations, W-7 retired-hash-router residue, W-8 a wrong column attribution), all remediated in this pass, and one substantive cross-PRD gap (W-1, the unowned file-graph endpoint) reported, not fixed. All 32 ACs across the four files trace to real code, the corpus, or the owning PRD; the decision-#34/#35 surface is exactly conformant; no fabricated values.

**Post-remediation verdict: PASS-with-warnings, no open Warnings.** W-2 through W-8 and S-1 are fixed in place (see the remediation log). W-1 was RESOLVED 2026-07-02 by respec (decision #39): 015b hydrates the file graph from PRD-008c's existing projection read (`GET /api/hive-graph/projection`) as a client-side transform, adding no new nectar API surface and leaving PRD-008's scope intact (see the W-1 remediation note in §4 and the §9 log). S-2 flags a stale sibling-doc claim in the wave plan, still outside this folder's write scope; S-3 is sub-medium.

---

## 9. Remediation log (this pass, 2026-07-02)

All fixes were applied in place inside `prd-015-dashboard-hive-graph-page/`; no corpus file, no other PRD folder, and no hive or honeycomb source file was touched.

| Finding | Sev | Resolution |
|---|---|---|
| W-1 | Medium | **RESOLVED 2026-07-02 (decision #39), branch (b).** Respecified 015b to hydrate the file graph from PRD-008c's EXISTING projection read (`GET /api/hive-graph/projection`) as a client-side transform — the projection carries every node/edge field (`files` map → nodes, `derived` map → edges). Zero new nectar API surface; PRD-008 scope unchanged (Wave D worker need not be informed). See the W-1 remediation note in §4. |
| W-2 | Medium | 79 `honeycomb/src/dashboard/web` markdown links unwrapped to backtick spans and repointed to `hive/src/dashboard/web` (index 14, 015a 30, 015b 25, 015c 10); the `recall.ts:2089` and `adding-a-page.md` links unwrapped to full-form cross-repo spans (81 links total). |
| W-3 | Medium | 8 hosting-model prose sites corrected to hive ADR-0001 copy-and-own (hive is a first-class repo; honeycomb's dashboard copy retired; no runtime import). |
| W-4 | Medium | 4 federation-mechanism sites corrected to hive ADR-0002's server-side BFF proxy (`hive/src/daemon/proxy.ts`; the `wire` is same-origin). |
| W-5 | Medium | 25 lifecycle-stale sibling links corrected: 20 → `../../completed/` (PRD-004 19, PRD-001 1) plus PRD-005 2, and 3 → `../../in-work/` (PRD-012 2, PRD-007 1). PRD-008's 4 sibling links verified correct, untouched. |
| W-6 | Medium | 17 distinct drifted citation ranges corrected across `registry.tsx` (10), `wire.ts` (6, +6/+9 shift), `page-frame.tsx` (1); every `graph.tsx` citation verified exact and untouched. |
| W-7 | Medium | 4 hash-router residue sites corrected to path-based routing per PRD-003c (`#/hive-graph` → the `/hive-graph` path; "unknown hash" → "unknown path"; the registry quote now matches `registry.tsx:15` verbatim; "path-like hash key" → "real, server-served path"). |
| W-8 | Medium | `nodes[].label` source corrected from the nonexistent `hive_graph.path` to the nectar's latest `hive_graph_versions.path` row (`hive-graph-schema.md:69,96`). |
| S-1 | Sub-medium | `hiveGraphBuild()` added to the wire-method enumerations in the index §API changes and 015a §The wire seam. |
| S-2 | Sub-medium | **Not fixed; reported.** Wave plan §Cross-repo caveat still places 015 in "the honeycomb repo (the new hive package)"; outside this folder's write scope. |
| S-3 | Sub-medium | **Not fixed; reported.** b-AC-7's `graph.tsx:477, 482` covers the destructure but cites a comment line where 484 is the operative combined-report line. |

**Verification:** post-remediation, `rg -c 'honeycomb/src/dashboard'`, `rg -n '\]\((\.\./)+honeycomb'`, `rg -n '\]\(\.\./prd-00(1|4|5|7)'`, `rg -n '\]\(\.\./prd-012'`, `rg -n '#/hive-graph|hive_graph\.path|registry\.tsx:(91|196-218|230-240|207-210)|wire\.ts:(1442|1461|1479|1608|1779)'`, and `rg -n 'Hivenectar|source-graph|thehive|SourceGraph'` all return zero across the four PRD files, and a full link-resolution scan of every remaining markdown link reports zero broken targets.
