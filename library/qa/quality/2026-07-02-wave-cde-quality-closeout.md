# QA Report: Wave C/D/E Smoker Close-out

**Plan documents:** `library/requirements/in-work/prd-007-brooding-process/`, `prd-008-nectar-api-endpoints/`, `prd-012-manual-hive-graph-search/`, `prd-013-recall-arm-hive-graph/`, `prd-015-dashboard-hive-graph-page/`, `prd-016-enricher-steady-state/`
**Audit date:** 2026-07-02
**Base branch:** `main` in each repo
**Heads:** nectar `feature/smoker-wave-c-d-e` @ `7ddbd6a`; honeycomb `feature/prd-013-hive-graph-recall-arm` @ `8619d91`; hive `feature/prd-015-hive-graph-page` @ `c105171`
**Auditor:** quality-worker-bee
**Security ordering:** ran after `library/qa/security/2026-07-02-wave-cde-security-closeout.md`, which found zero medium-or-above issues and changed no code.

## Summary

Verdict: **PASS clean** at the medium-and-above close-out bar. All Wave C/D/E implementation AC groups traced to real source and AC-named tests, the three independent repo gates passed, and the ledger's VERIFIED rows are true against the branch deltas reviewed here.

No Critical or Warning findings were found, so no code, test, or PRD remediation commit was required beyond this report. The two known residuals are documented rather than hidden: the live enricher cycle does not auto-fire projection trigger #2 yet, and cosmetic-inherit can degrade to a fresh describe on cold boot when only latest-per-nectar is hydrated.

## Scorecard

| Category | Status | Notes |
| --- | --- | --- |
| Completeness | PASS | PRD-007, 008, 012, 013, 015, and 016 AC groups are implemented and covered by AC-named tests. |
| Correctness | PASS | Decision checks #17, #20, #22, #29, #31, #34, #36, #37, #38, and #39 conform in code. |
| Alignment | PASS | Nectar keeps zero runtime dependencies, imports no Honeycomb runtime code, and uses current nectar / hive graph naming in the deltas. |
| Gaps | PASS | Deliberate gaps remain unfilled: TLSH threshold, `review-matches` grammar, and Portkey client-side cache toggle. |
| Detrimental | PASS | Typecheck and test gates passed in all three repos; no `.only` or new test-weakening marker found in touched test areas. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

None.

## Findings Table

| ID | Severity | Area | Evidence | Disposition |
| --- | --- | --- | --- | --- |
| Q-1 | None | Branch-level implementation-vs-plan | All AC coverage rows below passed with source and test anchors. | PASS clean, no fix required. |
| Q-2 | Report-only | Enricher projection trigger residual | `src/enricher/cycle.ts:263-269` only schedules projection writes when `projectionWriter` and `projectionStore` are injected; ledger lines 572-579 document the live-cycle residual. | Documented residual, below medium because brood-end, rebuild endpoint, and CLI rebuild paths still regenerate projection. |
| Q-3 | Report-only | Cosmetic-inherit cold-boot residual | Ledger lines 576-579 document that latest-per-nectar hydration can force a fresh describe instead of cosmetic inherit on cold boot. | Documented residual, below medium because it affects cost/efficiency, not correctness of described output. |
| Q-4 | Report-only | Security low observations | Security report lines 41-74 records L1, L2, and L3 as Low / informational. | No quality remediation required. |

Relevant snippets:

```ts
if (wroteNew && deps.projectionWriter !== undefined && deps.projectionStore !== undefined) {
  try {
    const doc = buildProjectionFromStore(deps.projectionStore, deps.tenancy, {});
    deps.projectionWriter.scheduleWrite(doc);
  } catch {
    // fail-soft
  }
}
```

`src/enricher/cycle.ts:263-269`

```md
Two documented residuals, unchanged by this bridge: the enricher's projection trigger #2 is not auto-fired on the live cycle ... and cosmetic-inherit's `priorDescribedVersion` degrades to a fresh describe on a cold boot...
```

`library/ledger/EXECUTION_LEDGER.md:578`

## AC Coverage Counts

| PRD | Planned AC rows audited | Covered | AC-named tests observed | Primary implementation anchors |
| --- | ---: | ---: | ---: | --- |
| PRD-007 Brooding | 26 | 26 | 29 | `src/brooding/pipeline-async.ts:196-428`, `src/brooding/bucketing.ts`, `test/brooding.test.ts` |
| PRD-016 Enricher | 31 | 31 | 31 | `src/enricher/cycle.ts:196-282`, `src/enricher/meaningful-change.ts`, `test/enricher.test.ts` |
| PRD-012 Search | 23 | 23 | 15 plus 7 CLI/API tests | `src/hive-graph/search.ts:32-379`, `src/api/loopback-client.ts`, `src/cli.ts`, `test/hive-graph-search.test.ts`, `test/search-cli.test.ts` |
| PRD-008 API | 26 | 26 | 41 API/router/bridge tests | `src/api/router.ts`, `src/api/hive-graph-api.ts:152-256`, `src/api/status-query.ts`, `test/api-router.test.ts`, `test/hive-graph-api.test.ts` |
| PRD-013 Recall arm | 28 | 28 | 26 | `honeycomb/src/daemon/runtime/memories/recall.ts:170`, `:408-430`, `:944-975`, `:2204-2238`, `nectar-recall-config.ts:73-115`, `hive-graph-recall-arm.test.ts` |
| PRD-015 Dashboard | 32 | 32 | 16 | `hive/src/dashboard/web/registry.tsx:151-231`, `hive-graph-projection.ts:58-74`, `wire.ts:2308-2388`, `pages/hive-graph.tsx:281-509`, dashboard tests |

Notes on counts:

- PRD-007 includes 11 module ACs plus sub-PRD acceptance rows from 007a, 007b, 007c, and 007d.
- PRD-008 includes 5 module ACs, 7 route-scaffolding ACs, 5 search-endpoint ACs, and 9 build/status/projection ACs.
- PRD-012 includes 6 module ACs, 10 engine ACs, and 7 CLI/endpoint ACs.
- PRD-013 includes 7 module ACs plus 7 each for 013a, 013b, and 013c.
- PRD-015 includes 7 module ACs, 7 route/page ACs, 10 file-graph ACs, and 8 search/status ACs.
- PRD-016 includes 7 module ACs, 8 queue/debounce ACs, 6 model/audit ACs, and 10 failure/observability ACs.

## Decision Conformance

| Decision | Result | Evidence |
| --- | --- | --- |
| #17 amended multiplier | PASS | Honeycomb reads `recall.nectar_rrf_multiplier` once, fail-soft defaults to 1.0, clamps `[0, 10]`, logs non-default once, and applies only to `hive_graph_versions`: `nectar-recall-config.ts:73-115`, `recall.ts:463-475`, `recall.ts:2235-2238`. |
| #20 health fields | PASS | `HealthBody` carries brooding, enricher, projection, cost, embeddings, and portkey slices; `assembleDaemon` surfaces the router and health state: `src/health.ts:14-43`, `src/health.ts:82-164`, `src/daemon.ts:602-623`. |
| #22 dynamic packing | PASS | Ledger verifies dynamic packing with 20k-token budget, 100 KB cap, and 50-file ceiling; tests assert it adapts to file size rather than fixed 40. |
| #29 model | PASS | `DEFAULT_ACTIVE_MODEL = "gemini-2.5-flash"` and `NECTAR_ACTIVE_MODEL` override: `src/portkey/config.ts:9-10`, `src/portkey/config.ts:83-88`. |
| #31 projection path/debounce | PASS | Existing projection path remains `.honeycomb/nectars.json`; projection write debounce is documented in Wave B artifacts and used by projection writer seams. |
| #34 defaults | PASS | Search default limit is 20 in Nectar and Honeycomb: `src/hive-graph/search.ts:32-49`, `honeycomb/.../recall.ts:129-130`; `/api/hive-graph` route path is `src/api/router.ts:27`. |
| #36 Nectar search | PASS | CLI tests prove `nectar search` is thin loopback with daemon-unreachable handling: `test/search-cli.test.ts:60-168`. |
| #37 hosted 768 | PASS | Hosted default is OpenAI `text-embedding-3-small` with output dimension 768: `src/embeddings/hosted-portkey.ts:36-51`. |
| #38 env decoupling | PASS | Nectar-owned env names are primary; Honeycomb env values are detection-only fallbacks: `src/portkey/config.ts:55-60`, `src/embeddings/config.ts:12-18`, `src/hive-graph/project-scope.ts:19-46`. |
| #39 projection transform | PASS | Hive fetches `GET /api/hive-graph/projection` and transforms client-side into `GraphWire`: `hive-graph-projection.ts:58-74`, `wire.ts:2308-2324`. |

## Cross-Cutting Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Nectar zero runtime dependency invariant | PASS | `package.json` has only `devDependencies` and no `dependencies`. |
| No Honeycomb import in Nectar runtime | PASS | Search found Honeycomb references only in prose/comments describing mirrored patterns; no source import from Honeycomb. |
| Naming residue | PASS | No `Hivenectar`, `source_graph`, `SourceGraph`, `thehive`, or `Hivedoctor` residue found in Nectar `src`/`test` deltas. |
| Deliberate gaps unfilled | PASS | Search found no implementation of TLSH threshold constants, no invented `review-matches` grammar, and no Portkey client cache toggle. |
| Test weakening | PASS | No `.only`, `.todo`, or new skip marker found in Honeycomb or Hive touched test areas. Nectar skip markers are the pre-existing live Deep Lake credential/unreachable skips in `test/hive-graph-deeplake.test.ts`. |
| Ledger evidence | PASS | Wave C/D/E VERIFIED rows match source and test gates; obsolete Wave D build dormancy row is superseded by the Bridge closure lines 568-579. |

## Independent Test Counts

| Repo | Command | Result |
| --- | --- | --- |
| nectar | `npm run typecheck && npm test` | PASS. `tsc --noEmit` clean; 452 tests, 449 pass, 0 fail, 3 skipped. |
| honeycomb | `npx tsc --noEmit && npx vitest run tests/daemon/runtime/memories && npm run audit:sql` | PASS. 35 test files, 429 tests passed; SQL audit scanned 285 files and found all interpolations guarded. |
| hive | `npm run typecheck && npm test` | PASS. `tsc --noEmit` clean; 33 test files, 244 tests passed. |

## Plan Item Traceability

| # | Plan requirement | Status | Implementation location | Notes |
| --- | --- | --- | --- | --- |
| 007-AC-1..11 | Brooding order, discovery, projection precheck, buckets, cost math, call shapes, resumability, dry-run, force/limit, background readiness, citation fidelity | PASS | `src/brooding/pipeline-async.ts:196-428`; `src/brooding/discovery.ts`; `src/brooding/bucketing.ts`; `test/brooding.test.ts` | Dynamic packing conforms to decision #22. |
| 007a | Fresh-clone inheritance, non-git fallback, `.gitignore` honoring | PASS | `src/brooding/precheck.ts`; `src/brooding/discovery.ts`; `test/brooding.test.ts` | No LLM call on hash-match inheritance. |
| 007b | Batch/solo/skip bucketing and cost math | PASS | `src/brooding/bucketing.ts`; `src/brooding/cost.ts`; `src/brooding/describe.ts`; `test/brooding.test.ts` | Dynamic, not fixed-40. |
| 007c | Resume via `describe_status`, no lockfile, failed rows retry | PASS | `src/brooding/resumability.ts`; `src/brooding/pipeline-async.ts:238-312`; `test/brooding.test.ts` | State derives from table rows. |
| 007d | `brood` dry-run, limit, force, model override, auto-trigger | PASS | `src/brooding/cli.ts`; `src/daemon.ts`; `test/wave-c-integration.test.ts`; `test/bridge-ac.test.ts` | Mutating brood runs daemon-side after bridge closure. |
| 016-AC-1..7 | Queue selection, debounce, Jaccard inherit, model stamping, failure handling, alert, logs | PASS | `src/enricher/cycle.ts:196-282`; `src/enricher/loop.ts`; `src/enricher/meaningful-change.ts`; `test/enricher.test.ts` | Projection-trigger residual is documented below medium. |
| 016a | Latest pending work, 500ms intake debounce, Jaccard 0.85 threshold | PASS | `src/enricher/pending-query.ts`; `src/enricher/jaccard.ts`; `src/enricher/meaningful-change.ts`; `test/enricher.test.ts` | Cold-boot cosmetic inherit residual documented. |
| 016b | Portkey call, `describe_model`, embedding or BM25 fallback | PASS | `src/enricher/describe.ts`; `src/enricher/cycle.ts:127-164`; `src/portkey/config.ts`; `test/enricher.test.ts` | Default model is `gemini-2.5-flash`. |
| 016c | Malformed retry, split oversized batch, skipped-deleted, persistent alert, observability | PASS | `src/enricher/failure.ts`; `src/enricher/observability.ts`; `src/enricher/cycle.ts:184-282`; `test/enricher.test.ts` | Alert halt/ack/reset covered. |
| 012-index/012a | Search engine lexical, semantic, latest-described, guards, missing table, embedding fallback | PASS | `src/hive-graph/search.ts:32-379`; `test/hive-graph-search.test.ts` | Vector path scores then hydrates. |
| 012b | `nectar search` thin loopback client and endpoint/CLI shape identity | PASS | `src/api/loopback-client.ts`; `src/cli.ts`; `test/search-cli.test.ts` | No daemon-core or Deep Lake import in client module. |
| 008-index/008a | `/api/hive-graph` protected route group, group accessor, inherited gate, 501 scaffold | PASS | `src/api/router.ts`; `src/daemon.ts:602-623`; `test/api-router.test.ts` | Own `node:http` router seam, no Hono dependency. |
| 008b | Search endpoint delegates to `searchHiveGraph`, scope failure 400, engine failure data body | PASS | `src/api/hive-graph-api.ts:162-178`; `test/hive-graph-api.test.ts` | Same result shape as CLI JSON. |
| 008c | Build, status, projection read, projection rebuild | PASS | `src/api/hive-graph-api.ts:180-255`; `src/api/status-query.ts`; `test/hive-graph-api.test.ts`; `test/bridge-ac.test.ts` | Live build dormancy closed by async brood bridge. |
| 013-index/013a | Fourth lexical recall arm, source recognition, class weight, multiplier | PASS | `honeycomb/src/daemon/runtime/memories/recall.ts:170`, `:408-430`, `:463-475`, `:2204-2238`; `nectar-recall-config.ts:73-115`; `hive-graph-recall-arm.test.ts` | Multiplier scales only `hive_graph_versions`. |
| 013b | Semantic arm over `embedding`, 768-dim guard, rerank fetch columns | PASS | `honeycomb/src/daemon/runtime/memories/recall.ts:926-975`, `:1125-1134`, `:1191-1201`; `hive-graph-recall-arm.test.ts` | Existing vector/hydrate path reused. |
| 013c | BM25-only fallback and per-arm fail-soft | PASS | `honeycomb/src/daemon/runtime/memories/recall.ts:2204-2238`; `tests/daemon/runtime/memories/hive-graph-recall-arm.test.ts` | Missing table does not wipe sibling arms. |
| 015-index/015a | One `/hive-graph` route entry, page frame, shared wire/poll | PASS | `hive/src/dashboard/web/registry.tsx:151-231`; `pages/hive-graph.tsx:281-509`; `registry.test.ts`; `hive-graph-page.test.tsx` | Not a third graph on `/graph`. |
| 015b | Projection-to-file graph transform, nodes/edges, side panel, cap | PASS | `hive-graph-projection.ts:58-74`; `pages/hive-graph.tsx:348-504`; `hive-graph-projection.test.ts` | Decision #39 uses projection endpoint, no new file-graph endpoint. |
| 015c | Search panel, status widgets, build trigger, nectar-down degradation | PASS | `wire.ts:2308-2388`; `pages/hive-graph.tsx:120-180`, `:183-230`, `:233-278`; `hive-graph-wire.test.ts`; `hive-graph-page.test.tsx` | 501/409/success build acks surfaced honestly. |

## Files Changed

### nectar

- `library/ledger/EXECUTION_LEDGER.md` (M), records Wave C/D/E execution, bridge closure, residuals, and verification counts.
- `library/qa/security/2026-07-02-wave-cde-security-closeout.md` (A), prior security report with zero medium-or-above findings.
- `library/qa/quality/2026-07-02-wave-cde-quality-closeout.md` (A), this close-out report.
- `library/requirements/PRD-DECISIONS-AND-DEFAULTS.md` (M), records signed decisions through #39.
- `library/requirements/completed/prd-009-harness-exposure-via-recall/**` (A/R), moves PRD-009 to completed with QA artifacts.
- `library/requirements/completed/prd-010-portkey-gateway/**`, `prd-011-portable-projection/**`, `prd-014-embeddings-provider-switching/**` (R), lifecycle moves to completed.
- `library/requirements/in-work/prd-007-brooding-process/**`, `prd-008-nectar-api-endpoints/**`, `prd-012-manual-hive-graph-search/**`, `prd-013-recall-arm-hive-graph/**`, `prd-015-dashboard-hive-graph-page/**`, `prd-016-enricher-steady-state/**` (R/A), lifecycle moves and QA remediation records.
- `src/api/daemon-api-wiring.ts` (A), wires live build/search/status/projection mechanics into the daemon.
- `src/api/hive-graph-api.ts` (A), implements `/api/hive-graph` handlers.
- `src/api/loopback-client.ts` (A), implements the thin loopback client for `nectar search`.
- `src/api/router.ts` (A), provides the zero-dependency protected route-group seam.
- `src/api/status-query.ts` (A), implements aggregate status reads and fail-soft status fallback.
- `src/brooding/**` (A), implements brooding discovery, precheck, bucketing, describe, cost, resumability, CLI behavior, and async durable bridge.
- `src/cli.ts` (M), adds brood/search/build/projection command wiring and daemon mechanics.
- `src/daemon.ts` (M), wires route groups, auto-brood, boot projection load, enricher loop, and health fields.
- `src/enricher/**` (A), implements pending selection, cycle processing, model call, Jaccard inheritance, failure state, observability, and store adapters.
- `src/health.ts` (M), adds Wave C health slices.
- `src/hive-graph/search-types.ts` (A), defines search engine dependencies and result types.
- `src/hive-graph/search.ts` (A), implements standalone hive-graph search.
- `src/index.ts` (M), exports the new API, brooding, enricher, and search surfaces.
- `src/server.ts` (M), exposes the route-group seam over `node:http`.
- `src/telemetry/index.ts` and `src/telemetry/metrics.ts` (M), add async store metrics wrapping.
- `test/api-router.test.ts` (A), covers PRD-008a route-group ACs.
- `test/bridge-ac.test.ts` (A), covers async brood bridge and live wiring.
- `test/brooding.test.ts` (A), covers PRD-007 ACs.
- `test/enricher.test.ts` (A), covers PRD-016 ACs.
- `test/hive-graph-api.test.ts` (A), covers PRD-008b/008c and endpoint contracts.
- `test/hive-graph-search.test.ts` (A), covers PRD-012a.
- `test/search-cli.test.ts` (A), covers PRD-012b.
- `test/wave-c-integration.test.ts` (A), covers Wave C integration seams.

### honeycomb

- `src/daemon/runtime/assemble.ts` (M), resolves and threads the Nectar RRF multiplier at boot.
- `src/daemon/runtime/memories/api.ts` (M), passes the multiplier into recall.
- `src/daemon/runtime/memories/nectar-recall-config.ts` (A), implements fail-soft multiplier config.
- `src/daemon/runtime/memories/recall.ts` (M), adds the `hive_graph_versions` lexical and semantic recall arms.
- `tests/daemon/runtime/memories/dedup.test.ts`, `recall.test.ts`, `rerank-cohere.test.ts`, `rerank.test.ts` (M), update fake arm buckets so missing new arm stays empty.
- `tests/daemon/runtime/memories/hive-graph-recall-arm.test.ts` (A), covers PRD-013 ACs and multiplier behavior.

### hive

- `src/dashboard/web/hive-graph-projection.ts` (A), transforms projection documents into `GraphWire`.
- `src/dashboard/web/pages/graph.tsx` (M), supports shared graph primitives.
- `src/dashboard/web/pages/hive-graph.tsx` (A), implements the Hive Graph page.
- `src/dashboard/web/registry.tsx` (M), adds the `/hive-graph` route entry.
- `src/dashboard/web/wire.ts` (M), adds hive-graph wire methods for projection, search, status, and build.
- `tests/dashboard/copy-map.test.ts` (M), updates copied file expectations.
- `tests/dashboard/hive-graph-page.test.tsx` (A), covers page behavior.
- `tests/dashboard/hive-graph-projection.test.ts` (A), covers projection transform.
- `tests/dashboard/hive-graph-wire.test.ts` (A), covers wire behavior.
- `tests/dashboard/registry.test.ts` (M), covers route matching and `/graph` separation.
