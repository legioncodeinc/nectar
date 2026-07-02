# QA Report: PRD-008 Hivenectar Daemon API Endpoints (PRD-vs-Corpus/Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Wave-0 corpus-conformance audit of PRD-008 (index + 008a/008b/008c) against the Hivenectar knowledge corpus, `MASTER-PRD-INDEX.md`, the dependency map, and the real honeycomb source under `honeycomb/src/daemon/runtime/`. This is a spec-QA gate: **no implementation code exists for this PRD**, matching the bar and format of `library/requirements/completed/prd-005-source-graph-catalog-tables/qa/prd-005-source-graph-catalog-tables-qa.md`. Armed with quality-stinger + hivenectar-stinger.

**Related:**
- [`../prd-008-hivenectar-api-endpoints-index.md`](../prd-008-hivenectar-api-endpoints-index.md)
- [`../../../MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md)
- [`../../../PRD-003-016-DEPENDENCY-MAP.md`](../../../PRD-003-016-DEPENDENCY-MAP.md)
- [`../../../PRD-003-016-WAVE-PLAN.md`](../../../PRD-003-016-WAVE-PLAN.md)
- [`prd-005-source-graph-catalog-tables-qa.md`](../../../completed/prd-005-source-graph-catalog-tables/qa/prd-005-source-graph-catalog-tables-qa.md): the format/bar precedent

**Plan document:** `library/requirements/backlog/prd-008-hivenectar-api-endpoints/` (index + 008a/008b/008c)
**Audit date:** 2026-07-02
**Base:** N/A (documentation-only pass; no branch diff, this is PRD-vs-source conformance)
**Auditor:** quality-worker-bee

---

## 1. Summary

PRD-008 is well-cited against honeycomb's `mountGraphApi`/`resolveScope`/`recallMemories` code (all `codebase/api.ts` and `memories/recall.ts` citations verified byte-accurate against the real source, zero drift), and its dependency-map claims are correct (D-7's "no 008 -> 013 edge" holds; the 012b co-dependency is stated accurately). However, the module **does not PASS** at medium-and-above: it carries **one Critical** finding that blocks confident implementation. The entire doc set frames the route-group mount as living on hivenectar's "Hono app" and types `daemon.group()` as returning a literal `Hono` router, but hivenectar's real, already-implemented daemon (`src/server.ts`, `src/daemon.ts`) is a zero-runtime-dependency `node:http` server with only `/health`, and no PRD-008 file or corpus doc defines what the `ROUTE_GROUPS`-equivalent actually is against that real surface. One **Warning** is newly reported (the `describe_status` status-endpoint breakdown collapses the schema's six-value enum into four buckets and misdescribes this as "no new values invented"). During this pass, four classes of mechanical defect were found and **remediated in place** per the granted remediation policy: 89 honeycomb code citations wrapped as broken-relative-depth markdown links (promoted to canonical backtick spans), roughly 15 honeycomb `server.ts` line-range citations that pointed at the wrong or an unrelated line span, 6 lifecycle-stale sibling-PRD links (PRD-002/005 now in `completed/`, PRD-011 now in `in-work/`), and 3 instances of a misattributed "decision #4" (that master-index decision is the file-watcher choice, not the mirror-not-import principle, which is `ADR-0002`). No corpus, honeycomb, `src/`, or other-PRD file was touched.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-008 index | PASS | WARNING (C-1 framing) | PASS | PASS | WARNING (remediated: W-2, W-3, W-4) | BLOCKED pending C-1 |
| PRD-008a | FAIL (C-1) | WARNING (C-1) | PASS | PASS | WARNING (remediated: W-2, W-3, W-4) | BLOCKED pending C-1 |
| PRD-008b | PASS | PASS | PASS | PASS | WARNING (remediated: W-3) | PASS-with-warnings |
| PRD-008c | PASS | WARNING (W-1) | PASS | PASS | WARNING (remediated: W-3) | PASS-with-warnings |

## 3. Critical Issues (must fix)

- [ ] **C-1: PRD-008 assumes hivenectar's daemon has "a Hono app"; the real, already-implemented daemon is a zero-dependency `node:http` server with no routing abstraction.** `prd-008-hivenectar-api-endpoints-index.md:12,22`; `prd-008a-route-group-scaffolding.md:7,76,122`

  Five places in the doc set state or type that the route group mounts "on the hivenectar daemon's Hono app" or that `daemon.group()` returns a literal `Hono` router:
  - index Overview (`:12`): "the `/api/source-graph/*` route group mounted on the daemon's Hono app the same way honeycomb scaffolds `ROUTE_GROUPS`"
  - index Goals (`:22`): "Mount the `/api/source-graph` route group on the hivenectar daemon's Hono app"
  - 008a Overview (`:7`): "This sub-PRD owns the mounting of the `/api/source-graph` route group on the hivenectar daemon's Hono app"
  - 008a's TypeScript contract (`:76`): `group(path: string): Hono | undefined;`
  - 008a AC-008a.2.1 (`:122`): "then `daemon.group(\"/api/source-graph\")` returns a `Hono` router (not `undefined`)"

  This repo's own `src/server.ts` (read directly for this audit) is explicit that this framing does not hold today:

  ```ts
  /**
   * The hivenectar HTTP surface.
   * ...
   * Implemented on `node:http` (zero runtime dependencies, mirroring
   * hivedoctor's built-ins-only ethos) rather than importing honeycomb's Hono
   * runtime, honoring the process-boundary rule in ADR-0002 / decision #4. The
   * daemon API route groups (`/api/source-graph/*`) are PRD-008 and mount after
   * `/health`.
   */
  ```

  and `package.json`'s `devDependencies` are only `typescript` + `@types/node` (no `hono`, no runtime deps at all, matching `AGENTS.md`'s "Zero runtime dependencies by design" invariant). This is not a stale-doc guess: `prd-002a-hivenectar-bootstrap-and-composition-root.md` (the already-implemented, QA-passed PRD-002 spec) itself specified binding "the Hono app to `127.0.0.1:3854` via `@hono/node-server`"; the shipped implementation diverged from that spec and shipped `node:http` instead, and neither `prd-002a` nor the corpus (`library/knowledge/private/overview.md` has zero Hono/node:http mentions) records that deviation. PRD-008 was authored against the stale Hono assumption (which itself traces to `MASTER-PRD-INDEX.md:103`, out of this audit's remediation scope) and never reconciled it against the real, shipped daemon.

  Impact: AC-008a.2.1 as literally written is not satisfiable without either (a) adding `hono` as a runtime dependency to hivenectar, directly contradicting the zero-runtime-dependency invariant `AGENTS.md` states is a load-bearing design decision, or (b) hivenectar building its own minimal router/dispatch abstraction and mislabeling its return type `Hono` (a real class from the `hono` package hivenectar does not import). Either way, an implementer cannot satisfy this AC as written without a decision this PRD does not make. AC-008a.1.1-1.3, AC-008a.2.2-2.3, and AC-008a.3.1 all depend on the same undefined `group()` accessor and inherit the same gap; 008b and 008c's handlers attach to that same accessor, so the gap propagates through the whole PRD-008 surface (recorded as a Note against every affected row in Section 7's traceability table rather than repeated here).

  **Not fixed** (substantive architecture decision, outside this Bee's remit; `library-worker-bee` or the PRD author must resolve it, per the "report, don't fix" / "the plan is source of truth" principle). Suggested remediation for the PRD author: either (1) define hivenectar's own minimal `RouteGroups`-equivalent dispatch shape against the real `node:http` server (a lightweight path-prefix router+middleware-chain the daemon's own code implements, with its own return type, not `Hono`), and update every "Hono app" / `Hono` reference in the four files accordingly; or (2) if hivenectar is meant to actually add `hono` as a runtime dependency going forward (reversing PRD-002's `node:http` implementation), record that as an explicit, user-authorized decision (parallel to the six locked decisions in `MASTER-PRD-INDEX.md`) before PRD-008 enters implementation, and reconcile `prd-002a` + `overview.md` to match.

## 4. Warnings (should fix)

- [ ] **W-1: The `/status` endpoint's `describeStatus` breakdown collapses the schema's six-value `describe_status` enum into four buckets and misclaims "no new values invented."** `prd-008c-build-status-projection-endpoints.md:90-96,184`

  `data/source-graph-schema.md:109` documents `describe_status` as one of **six** values: `pending`, `described`, `failed`, `skipped-too-large`, `skipped-binary`, `skipped-deleted` (the three distinct skip reasons are load-bearing: `skipped-deleted` is explicitly "distinct from `failed`... so the enricher doesn't keep retrying a file that's gone"). PRD-008c's response shape only has **four** buckets:

  ```json
  { "describeStatus": { "described": 1842, "pending": 12, "failed": 3, "skipped": 143 } }
  ```

  and the Implementation Notes section states: "The status breakdown enumerates the column's values (`described` / `pending` / `failed` / `skipped`), carried from `knowledge/private/data/source-graph-schema.md`; no new values invented here." This is not accurate: a plain `skipped` bucket does not appear in the schema's enum; it is an unstated aggregation of three distinct values, and the PRD does not record that aggregation as a decision (whether the three skip reasons should each get their own counter, matching the schema 1:1, or whether collapsing them is intentional for the operator-facing summary).

  Suggested remediation: either enumerate all six values in the response shape (`skippedTooLarge`, `skippedBinary`, `skippedDeleted` alongside `described`/`pending`/`failed`), or keep the four-bucket summary but correct the Implementation Notes to say the `skipped` bucket sums the three `skipped-*` schema values (a stated aggregation, not a verbatim carry-over).

## 5. Suggestions (consider improving)

None.

## 6. Verified clean (no findings)

- **D-7 / no 008 -> 013 edge:** confirmed against `PRD-003-016-DEPENDENCY-MAP.md:314,757`. PRD-008's Non-Goals (`prd-008-hivenectar-api-endpoints-index.md`) and 008b's Non-Goals plus its "Standalone, not fused" section correctly declare PRD-013 (the fused recall arm) a Non-Goal and explicitly distinct from the standalone search endpoint. No 008 -> 013 dependency edge is asserted anywhere in the four files.
- **012b co-dependency:** the dependency map (`:293,301`) states 008b and 012b are co-dependent and "land together." PRD-008 index Overview/Goals and 008b's Overview/Non-Goals state this correctly and consistently (008b delegates to PRD-012a's `searchSourceGraph` engine; 012b owns the CLI and is the parallel client of the same engine). The `searchSourceGraph(query, scope, limit?, deps?)` signature and the `{ hits, sources, degraded }` result shape 008b assumes match `prd-012a-lexical-semantic-search-over-source-graph.md:13,38` exactly.
- **`codebase/api.ts` and `memories/recall.ts` citations:** every one of the roughly 30 distinct line-range citations to `codebase/api.ts` (`mountGraphApi`, `resolveScope`, the `/build` handler, `NO_ORG_BODY`, the catch-as-data-body pattern) and `memories/recall.ts` (`DEFAULT_RECALL_LIMIT`/`resolveRecallLimit` at `:129,303-308`, the empty-query floor at `:2070-2073`, the honest `degraded` signal at `:2106`, the per-arm fail-soft rationale at `:24-35`) was checked byte-for-byte against the real honeycomb source. **Zero drift**: every citation lands exactly on the claimed content.
- **DEFAULT flag:** the one registered default (route group path `/api/source-graph` with inherited session-protect middleware, flagged in 008a) is present, correctly marked **DEFAULT, confirm before implementation**, and left unfilled (the Goals section uses `session: <per default>` rather than hardcoding `true`/`false`). No deliberate gap was silently resolved.
- **Documentation-framework header convention:** PRD-008's `> **Status:** / **Priority:** / **Effort:**` header matches the already-QA-passed PRD-005 precedent (PRDs use this header, not the knowledge-doc `Category | Version | Date | Status` block). Not a defect.

## 7. Plan Item (AC) Traceability

### PRD-008 index (5 ACs + 7 Non-Goals)

| # | Requirement | Status | Source | Notes |
|---|---|---|---|---|
| AC-1 | `/api/source-graph` route group mounted, `protect: true`, mirrors `ROUTE_GROUPS` + scaffolding loop | ⚠️ | `server.ts:68-106`, `:306-328` (citations corrected this pass) | Citations now accurate; underlying mechanism assumes Hono (C-1) |
| AC-2 | `mountSourceGraphApi(daemon, options)` attaches handlers once after `createDaemon(...)`, mirrors `mountGraphApi` | ✅ | `codebase/api.ts:304-347` | Citation verified exact |
| AC-3 | Every endpoint inherits permission middleware; unfilled path -> root 501, never 404-with-no-auth | ⚠️ | `server.ts:385-400` (corrected) | Citation now accurate; underlying `group()`/501-scaffold mechanism assumes Hono (C-1) |
| AC-4 | `/search` delegates to PRD-012's engine, returns CLI-identical shape | ✅ | `prd-012a...md:13,38` | Signature + result shape verified to match |
| AC-5 | `/build`, `/status`, projection endpoints resolve scope per-request, storage via injected client only | ✅ | `codebase/api.ts:309-310`; `server.ts:13-16` | Citations verified exact |
| NG-1 | Search engine: PRD-012 | ✅ | dependency map `:293` | Correctly scoped |
| NG-2 | Recall arm: PRD-013 | ✅ | dependency map D-7 `:314,757` | Correctly scoped; no 008->013 edge (verified) |
| NG-3 | Daemon bootstrap / `/health` / `/api/status`: PRD-002 | ✅ | n/a | Correctly scoped |
| NG-4 | Brooding pipeline: PRD-007 | ✅ | n/a | Correctly scoped |
| NG-5 | Projection format: PRD-011 | ✅ | n/a | Correctly scoped |
| NG-6 | Deep Lake table schemas: PRD-005 | ✅ | n/a | Correctly scoped |
| NG-7 | Dashboard page: PRD-015 (thehive) | ✅ | n/a | Correctly scoped |

### PRD-008a route-group scaffolding (7 ACs)

| # | Requirement | Status | Source | Notes |
|---|---|---|---|---|
| AC-008a.1.1 | `ROUTE_GROUPS`-equivalent list contains `{ path: "/api/source-graph", protect: true }` | ⚠️ | `server.ts:68-106` (corrected) | Citation accurate; mechanism assumes Hono (C-1) |
| AC-008a.1.2 | Permission middleware mounted on root at `/api/source-graph/*` | ⚠️ | `server.ts:306-328` (corrected) | Citation accurate; mechanism assumes Hono (C-1) |
| AC-008a.1.3 | Unfilled path falls through to root 501 scaffold | ⚠️ | `server.ts:385-400` (corrected) | Citation accurate; mechanism assumes Hono (C-1) |
| AC-008a.2.1 | `daemon.group(...)` returns a `Hono` router | ❌ | `server.ts:205-214` (corrected) | **C-1**: literal `Hono` type is not satisfiable against the real zero-dependency `node:http` daemon without adding a runtime dependency the repo's own `AGENTS.md` forbids |
| AC-008a.2.2 | Unknown group path -> `daemon.group(path)` returns `undefined` | ⚠️ | `server.ts:210,214` (corrected) | Behavior-level claim is fine; return-type framing inherits C-1 |
| AC-008a.2.3 | Handler registers at full path, inherits mounted middleware | ⚠️ | `server.ts:324-328` (corrected) | Citation accurate; mechanism assumes Hono (C-1) |
| AC-008a.3.1 | `mountSourceGraphApi` no-ops (no throw) on unknown group | ✅ | `codebase/api.ts:305-306` | Architecture-agnostic; holds regardless of C-1's resolution |
| NG-a1 | Individual endpoint behavior: 008b/008c | ✅ | n/a | Correctly scoped |
| NG-a2 | Daemon bootstrap / `createDaemon` / socket bind: PRD-002 | ✅ | n/a | Correctly scoped |
| NG-a3 | Permission-middleware implementation: daemon's `permissionMiddleware` | ✅ | `middleware/permission.ts` (exists) | Correctly scoped |
| NG-a4 | `runtime-path` middleware: daemon | ✅ | `middleware/runtime-path.ts` (exists) | Correctly scoped |

### PRD-008b search endpoint (5 ACs)

| # | Requirement | Status | Source | Notes |
|---|---|---|---|---|
| AC-008b.1.1 | Delegates to `searchSourceGraph`, returns result unchanged | ✅ | `codebase/api.ts:304-347` | Verified |
| AC-008b.1.2 | Empty query -> `{ hits: [], sources: [], degraded: true }` | ✅ | `recall.ts:2070-2073` | Byte-exact match to real source |
| AC-008b.1.3 | `limit` passed through; default 20 | ✅ | `recall.ts:129,303-308` | Byte-exact match (`DEFAULT_RECALL_LIMIT`, `resolveRecallLimit`) |
| AC-008b.2.1 | No resolvable scope -> `NO_ORG_BODY` 400 before engine | ✅ | `codebase/api.ts:319-320` | Byte-exact match |
| AC-008b.3.1 | Engine throws -> `{ error: "search_failed", reason }` 500 | ✅ | `codebase/api.ts:324-329` | Byte-exact match |
| NG-b1 | Search engine internals: PRD-012a | ✅ | n/a | Correctly scoped |
| NG-b2 | CLI surface: PRD-012b | ✅ | n/a | Correctly scoped |
| NG-b3 | Recall arm fusion: PRD-013 | ✅ | dependency map D-7 | Correctly scoped, no edge |
| NG-b4 | Route-group scaffolding: 008a | ✅ | n/a | Correctly scoped |
| NG-b5 | Query-vector embedding mechanics: PRD-012a | ✅ | `services/embed-client.ts` (exists) | Correctly scoped |

### PRD-008c build/status/projection endpoints (9 ACs)

| # | Requirement | Status | Source | Notes |
|---|---|---|---|---|
| AC-008c.1.1 | `/build` invokes PRD-007 pipeline with scope + flags | ✅ | `codebase/api.ts:318-330` | Verified shape (`runGraphBuild` pattern) |
| AC-008c.1.2 | Pipeline failure -> `{ error: "build_failed", reason }` 500 | ✅ | `codebase/api.ts:324-329` | Byte-exact match |
| AC-008c.1.3 | `force: true` re-describes every file | ✅ | `ai/brooding-pipeline.md` | Consistent with cited corpus doc |
| AC-008c.2.1 | `/status` returns `queueDepth`, `describeStatus`, `costSpentUsd` | ⚠️ | `data/source-graph-schema.md:109` | **W-1**: `describeStatus` breakdown is a 4-bucket collapse of the schema's 6-value enum, mislabeled as verbatim |
| AC-008c.2.2 | Missing table -> degraded status, never 500 | ✅ | `recall.ts:24-35` | Per-arm fail-soft rationale accurately grounds the analogy |
| AC-008c.2.3 | Aggregate counts only, no full scan | ✅ | `server.ts:330-383` (corrected) | Citation now accurate (`/health` + `/api/status` handlers) |
| AC-008c.3.1 | `GET /projection` returns current projection via PRD-011 | ✅ | n/a | Correctly scoped to PRD-011 |
| AC-008c.3.2 | `POST /projection/rebuild` returns `{ regenerated, nectarsCount, generatedAt }` | ✅ | n/a | Correctly scoped to PRD-011 |
| AC-008c.3.3 | Rebuild regenerates from Deep Lake, honors projection-not-sidecar | ✅ | `data/portable-registry.md` | Consistent with cited corpus doc |
| NG-c1 | Brooding pipeline mechanics: PRD-007 | ✅ | n/a | Correctly scoped |
| NG-c2 | Enricher steady-state loop: PRD-016 | ✅ | n/a | Correctly scoped |
| NG-c3 | Projection format/write/rebuild logic: PRD-011 | ✅ | n/a | Correctly scoped |
| NG-c4 | Dashboard page: PRD-015 | ✅ | n/a | Correctly scoped |
| NG-c5 | Search endpoint: 008b | ✅ | n/a | Correctly scoped |
| NG-c6 | Route-group scaffolding: 008a | ✅ | n/a | Correctly scoped |

## 8. Remediation log (mechanical defects fixed in place this pass)

Per this audit's remediation policy, the following mechanical defects were fixed directly in the four PRD-008 files (index, 008a, 008b, 008c). No corpus, honeycomb, `src/`, test, or other-PRD-folder file was touched. C-1 and W-1 (substantive) were **not** fixed, only reported.

| Finding | Sev | Resolution |
|---|---|---|
| W-2: 89 honeycomb code citations wrapped as markdown links with a broken relative path | Warning | `../../../../honeycomb/...` (4 levels) resolves to the non-existent `nectar/honeycomb/...` on this disk layout; the correct depth is 5 levels, but per `AGENTS.md` a cross-repo code citation must be a plain backtick span, never a markdown link, regardless of depth. All 89 instances across the 4 files were unwrapped to canonical `` `honeycomb/src/daemon/runtime/....ts:LN-LN` `` backtick spans; short-form spans that omitted the `honeycomb/` prefix (ambiguous, since hivenectar has its own `src/server.ts`) were promoted to the full path derived from each link's own target. Verified: `grep -c '\]\((\.\./)+honeycomb' *.md` = 0 across all 4 files; a full link-resolution sweep (89 links) confirms every one now correctly identifies the intended honeycomb source path in prose (cross-repo backtick spans are not disk-resolvable by design, matching the convention `honeycomb/src/...` citations already use elsewhere in this corpus). |
| W-3: roughly 15 distinct `honeycomb/src/daemon/runtime/server.ts` line-range citations pointed at the wrong or an unrelated span | Warning | Each was checked against the real file and corrected: `71-96` to `68-106` (full `ROUTE_GROUPS` array), `60-64` to `57-61` (`RouteGroupSpec` interface), `72-73` to `69-70` (the actual `/health`/`/api/status` entries), `74-77` to `72-74` (`/api/memories`/`/memory`/`/api/hooks`), `87` to `84` (`/api/graph` entry), `202-210` to `205-214` (the `group()` doc-comment + signature), `206-210` to `210,214`, `202-316` to `205-328`, `284-296` to `293-305` (the actual a-AC-6/FR-2/FR-8 comment block), `288-296` to `385-400` (the real `notFound`/501 handler), `288-296, 312-316` to `297-305, 385-400`, `303-311` to `315-323` (the runtime-path-ahead-of-permission block), `312-316` to `324-328` (the `groups.set(...)` registration), `255-258` to `254-263` (the `mountPermission` thunk + its inputs), `318-341` to `330-383` (the full `/health` + `/api/status` handlers). All corrections verified line-by-line against `honeycomb/src/daemon/runtime/server.ts` as it exists on disk. |
| W-4: 6 lifecycle-stale sibling-PRD cross-links | Warning | PRD-002 and PRD-005 moved `backlog/` to `completed/`; PRD-011 moved `backlog/` to `in-work/`, both after PRD-008's citing text was authored. Corrected `../prd-002-hivenectar-daemon/...` to `../../completed/prd-002-hivenectar-daemon/...` (index `:75`, 008a `:137,156`), `../prd-005-source-graph-catalog-tables/...` to `../../completed/prd-005-source-graph-catalog-tables/...` (index `:76`), `../prd-011-portable-projection/...` to `../../in-work/prd-011-portable-projection/...` (index `:78`, 008c `:194`). Verified: a full link-resolution sweep across all 4 files now reports zero broken links (was 95 broken: 89 depth errors plus 6 lifecycle-stale). |
| W-5: "decision #4" misattributed as the mirror-not-import principle | Warning | `MASTER-PRD-INDEX.md`'s decision #4 is "Watcher: `node:fs.watch`, mirror Honeycomb" (the file-watcher/chokidar choice), unrelated to route groups. The mirror-not-import-across-the-process-boundary principle PRD-008 actually invokes is `ADR-0002`. Corrected 3 instances (index `:72`, 008a `:137,157`) to cite `ADR-0002` instead of "decision #4." |

**Verification:** a full link-resolution sweep (Python script checking every `](...)` target against disk) across all 4 PRD-008 files reports zero broken links post-remediation (was 95: 89 wrong-depth honeycomb links plus 6 lifecycle-stale sibling links). `grep` for `](.../honeycomb` markdown-link tokens returns zero. `grep` for the corrected `server.ts` line ranges confirms no stale citation remains. `git diff --stat` on the four files shows only line-level edits (72/58/38/26 lines changed across index/008a/008b/008c respectively); no line was added or removed, and no prose beyond the cited spans, link targets, and the three "decision #4" mentions was touched.

## 9. Files Audited

- `prd-008-hivenectar-api-endpoints-index.md`: audited + remediated (W-2, W-3, W-4, W-5; carries C-1 framing).
- `prd-008a-route-group-scaffolding.md`: audited + remediated (W-2, W-3, W-4, W-5; carries C-1).
- `prd-008b-search-endpoint.md`: audited + remediated (W-2, W-3).
- `prd-008c-build-status-projection-endpoints.md`: audited + remediated (W-2, W-3, W-4); carries W-1.

No corpus, honeycomb, `src/`, test, or other-PRD-folder file was modified by this audit.

**Overall verdict (as-audited): BLOCKED pending C-1.** Zero additional Criticals beyond C-1. One Warning open (W-1, `describe_status` enum collapse). Four classes of mechanical Warning (W-2 through W-5, covering 89 + 15 + 6 + 3 = 113 individual defects) were remediated in place during this pass and are closed. The route-group mounting mechanism, permission-inheritance seam, and 501-scaffold behavior PRD-008a specifies are honeycomb-faithful in every detail except that they assume machinery (a Hono app) hivenectar's real, already-shipped daemon does not have, and the repo's own zero-runtime-dependency invariant argues against introducing. This PRD should not enter implementation until C-1 is resolved (either hivenectar's own router abstraction is specified, or adding `hono` is explicitly authorized) and W-1's `describe_status` breakdown is reconciled with the six-value schema enum.

---

## Orchestrator remediation addendum (2026-07-02, the-smoker run)

`library-worker-bee` remediated the two open substantive findings (C-1, W-1) under a run-orchestrator decision, editing only the four PRD-008 files (index + 008a/008b/008c) and this QA report. No corpus, honeycomb, `src/`, test, or other-PRD-folder file was touched. The prior mechanical remediations (W-2 through W-5) remain closed and were not re-opened.

### C-1 CLOSED (router-seam reframing over `node:http`)

**Decision applied (not re-litigated):** consistent with the repo's locked zero-runtime-dependency invariant (`AGENTS.md`), the route group mounts on hivenectar's OWN router seam over `node:http`, not a literal Hono app. PRD-008a now DEFINES a minimal in-repo `RouteGroup` abstraction (plus the `mountSourceGraphApi(daemon, options)` attach point) layered over the existing `node:http` request handler in `src/server.ts`. It MIRRORS honeycomb's `ROUTE_GROUPS` + `mountGraphApi` pattern across the process boundary (`ADR-0002`, mirror-not-import) while honoring the zero-dependency invariant. Honeycomb citations were retained as the mirrored-pattern source; they no longer read as claims about hivenectar's own stack.

**Rationale recorded in the PRD:** a new "Reconciliation with PRD-002a" implementation note in 008a states that PRD-002a's original spec sketched a Hono-based daemon (bound via `@hono/node-server`), the shipped PRD-002 implementation diverged to zero-dependency `node:http`, and PRD-008 follows the shipped reality. PRD-002a and the corpus were left untouched, exactly as scoped.

Every C-1 spot the report flagged, before -> after:
- index Overview (`:12`): "mounted on the daemon's Hono app" -> "mounted through hivenectar's own in-repo router seam layered over the existing `node:http` request handler (`src/server.ts`) the same way honeycomb scaffolds `ROUTE_GROUPS` on its Hono app," plus the `RouteGroup`/`mountSourceGraphApi` definition and the `ADR-0002` / `AGENTS.md` mirror-not-import framing.
- index Goals (`:22`): "on the hivenectar daemon's Hono app" -> "through hivenectar's own in-repo router seam over `node:http` (`src/server.ts`)."
- 008a Overview (`:7`): "on the hivenectar daemon's Hono app" -> "through hivenectar's own in-repo router seam layered over the existing `node:http` request handler (`src/server.ts`)," with an explicit "DEFINES a minimal `RouteGroup` abstraction ... does not import honeycomb's Hono runtime" clause.
- 008a `group()` type (`:76`): `group(path: string): Hono | undefined;` -> `group(path: string): RouteGroup | undefined;` with a preceding comment ("the in-repo router seam over node:http; NOT the Hono class") and a new paragraph defining `RouteGroup` as hivenectar's zero-dependency analogue of honeycomb's Hono `basePath` router.
- 008a AC-008a.2.1 (`:122`): "returns a `Hono` router (not `undefined`)" -> "returns a `RouteGroup` (hivenectar's in-repo router seam over `node:http`, `src/server.ts`), not `undefined`, mirroring honeycomb's `basePath`-router accessor contract ... without importing Hono."

**AC satisfiability restored:** index AC-1 now mounts the group "through the in-repo router seam over `node:http` (`src/server.ts`)"; index AC-3 now states the group inherits protection middleware "which 008a scaffolds ... since the shipped daemon has none today beyond the unprotected `/health`," unfilled paths return the root 501 scaffold, and `/health` stays unprotected exactly as shipped. 008a's Goal, Non-Goal, and permission-inheritance section were reconciled to say 008a scaffolds the protection-middleware mount (none exists today) while the RBAC/authenticator policy internals stay the mirrored honeycomb pattern. The mermaid handle label and the US-008a.2 heading were updated from "basePath router" to "`RouteGroup` handle" for consistency.

**Files/sections touched:** index (Overview `:12`, Goals `:22`, Acceptance Criteria AC-1 + AC-3); 008a (Overview `:7`, `:9`; mermaid handle label; Goals; Non-Goals; Permission-middleware inheritance section; `group()` accessor contract + type `:76`; US-008a.2 heading + AC-008a.2.1 `:122`; Implementation notes new "Reconciliation with PRD-002a" bullet). 008b required no change (it carried no Hono-on-hivenectar framing).

### W-1 CLOSED (six-value `describe_status` enum carried verbatim)

The `/status` endpoint's `describeStatus` breakdown now carries the REAL six-value enum verbatim (`pending`, `described`, `failed`, `skipped-too-large`, `skipped-binary`, `skipped-deleted`), matching `data/source-graph-schema.md:109` and the `DescribeStatus` union at `src/source-graph/model.ts:38-53`. The collapsed 4-bucket `{ described, pending, failed, skipped }` response was replaced with the six per-value counters (the prior `skipped: 143` decomposed into `skipped-too-large: 40` + `skipped-binary: 61` + `skipped-deleted: 42`). The false "no new values invented here" claim was corrected to be true: it now states the breakdown reports one counter per real enum value carried verbatim, keeps the three `skipped-*` reasons distinct (noting `skipped-deleted` is load-bearing), and specifies that any operator-facing rollup of the three `skipped-*` counts must be labeled explicitly as an aggregate of those three real values, not a new enum value.

**Files/sections touched (008c):** the status endpoint "What it does" (`:71`), the `200 OK` response JSON (`:90-96`), the `describeStatus` bullet (`:99`), AC-008c.2.1 (`:162`), and the "`describe_status` values" implementation note (`:184`).

**Post-remediation verdict: PASS, clean at medium-and-above.**
