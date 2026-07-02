# QA Report: Wave B PRD-010, PRD-011, PRD-014 Implementation Close-Out

**Plan documents:** `library/requirements/in-work/prd-010-portkey-gateway/`, `library/requirements/in-work/prd-011-portable-projection/`, `library/requirements/in-work/prd-014-embeddings-provider-switching/`
**Audit date:** 2026-07-02
**Base branch:** `main`
**Head:** `feature/smoker-wave-b-impl-and-wave0-qa` (`09f087b`)
**Auditor:** quality-worker-bee
**Security order:** security pass completed before this audit, with 3 Medium findings remediated and the suite green per orchestrator handoff.

## Summary

Verdict: **PASS**. The Wave B implementation satisfies all 16 module-level ACs for PRD-010, PRD-011, and PRD-014 at the declared dormant-but-wired bar, with the live PRD-011 rebuild CLI wired to `DeepLakeHiveGraphStore` rather than a throwaway in-memory store. No Critical, Warning, or Suggestion findings were found; the only ship-readiness note is procedural: the worktree is dirty and the newly added source/test files are untracked, so the orchestrator must include them in the ship commit.

## Finding Counts

| Severity | Count |
|---|---:|
| Critical | 0 |
| Warning | 0 |
| Suggestion | 0 |

## Scorecard

| Category | Status | Notes |
|---|---|---|
| Completeness | PASS | All 16 module ACs trace to code plus AC-named passing tests. Wave C deferrals are represented as seams, not fake live consumers. |
| Correctness | PASS | Defaults and corpus contracts hold: `.honeycomb/nectars.json`, 30s debounce, `gemini-2.5-flash`, provider default `local`, bare-hex sha256, and 768-dim guard. |
| Alignment | PASS | No client cache/guardrail toggle was added, no honeycomb import exists, one `buildPortkeyHeaders` is shared, and exports were added in `src/index.ts`. |
| Gaps | PASS | CLI rebuild verbs reach the durable Deep Lake store, missing `NECTAR_PROJECT_ID` exits 1 with a clear message, and security remediations did not invalidate any AC. |
| Detrimental | PASS | `npm run typecheck && npm run build && npm test` passed with 305 pass, 0 fail, 3 pre-existing skips; no package dependency diff and no existing `test/` files were weakened or deleted. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

None.

## Verification Results

- Requested suite: `npm run typecheck && npm run build && npm test` passed. Test runner summary: 308 tests, 305 pass, 0 fail, 3 skipped.
- Lints: no linter errors found for the edited source areas.
- Dependency check: `git diff main -- package.json` was empty, so zero new runtime dependencies were added.
- Existing test regression check: `git diff main -- test/` was empty. All Wave B tests are new untracked files; no pre-existing tests were weakened or deleted.
- Honeycomb import posture: `rg 'from ".*honeycomb'` over TypeScript files returned no matches.
- Deliberate gap check: no `portkey.cache`, `portkey.cacheEnabled`, `portkey.guardrails`, or client cache/guardrail env toggle exists in `src/`.
- CLI error check: both `node --experimental-sqlite dist/cli.js rebuild-projection` and `node --experimental-sqlite dist/cli.js project --rebuild-projection` with `NECTAR_PROJECT_ID` unset printed a clear message and exited `1`.
- Worktree note: audit included untracked implementation and test files. They must be staged/committed before PR creation.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Test Evidence | Notes |
|---|---|---|---|---|---|
| 010-AC-1 | Portkey-enabled brooding/enricher calls POST to `https://api.portkey.ai/v1/chat/completions` with headers from `buildPortkeyHeaders`. | PASS | `src/portkey/headers.ts:10-42`, `src/portkey/transport.ts:149-210` | `test/portkey-gateway.test.ts:37-67` | Satisfied at the transport seam; brood/enricher callers land in Wave C by design. |
| 010-AC-2 | No explicit model resolves to `gemini-2.5-flash`. | PASS | `src/portkey/config.ts:9-10`, `src/portkey/transport.ts:95-99`, `src/portkey/transport.ts:160-165` | `test/portkey-gateway.test.ts:75-126` | Decision #29 default preserved. |
| 010-AC-3 | `brood --force --model <new>` resets non-skipped rows to `pending` and re-description stamps the new model. | PASS | `src/portkey/describe-model.ts:11-24`, `src/portkey/describe-model.ts:77-91` | `test/portkey-gateway.test.ts:128-162` | Pure reset/stamp seam is present; `brood` command mechanics remain PRD-007 Wave C. |
| 010-AC-4 | Produced descriptions stamp `hive_graph_versions.describe_model`. | PASS | `src/portkey/describe-model.ts:34-60`, `src/portkey/describe-model.ts:94-108` | `test/portkey-gateway.test.ts:164-175` | `describeModel` is written by the shared stamp patch. |
| 010-AC-5 | No client vault key toggles semantic cache or guardrails; behavior remains Portkey-server-side via config id. | PASS | `src/portkey/config.ts:91-101`, `src/portkey/headers.ts:26-40` | `test/portkey-gateway.test.ts:177-192` | Decision #6 preserved. Search found no cache or guardrail toggle surface. |
| 011-AC-1 | Brooding completion writes a complete `.honeycomb/nectars.json` atomically. | PASS | `src/projection/write.ts:52-73`, `src/projection/write.ts:84-150` | `test/projection-ac.test.ts:131-166` | Brooding trigger lands in Wave C; atomic writer is implemented and tested. |
| 011-AC-2 | Enricher cycle with new descriptions rewrites the projection atomically with substituted versions. | PASS | `src/projection/write.ts:84-150`, `src/projection/store-adapter.ts:53-79` | `test/projection-ac.test.ts:168-205` | Enricher trigger lands in Wave C; debounced writer and source overlay are implemented. |
| 011-AC-3 | `rebuild-projection` regenerates from latest described `hive_graph_versions`, scoped to project, and writes atomically. | PASS | `src/cli.ts:148-195`, `src/projection/write.ts:169-186`, `src/hive-graph/deeplake-store.ts:440-474` | `test/projection-ac.test.ts:207-228`, `test/wave2-integration.test.ts:193-239` | Live CLI path uses `DeepLakeHiveGraphStore` and `rebuildProjectionAsync`, not an empty in-memory store. |
| 011-AC-4 | Future projection version is ignored with warning/fallback semantics. | PASS | `src/projection/load.ts:145-152`, `src/projection/load.ts:214-260` | `test/projection-ac.test.ts:230-238` | Validation returns typed ignore reason and never partially loads. |
| 011-AC-5 | Project triple mismatch is ignored and never partially loaded. | PASS | `src/projection/load.ts:133-160`, `src/projection/load.ts:214-260` | `test/projection-ac.test.ts:240-264` | Includes invalid nectar whole-document rejection as partial-load protection. |
| 011-AC-6 | Fresh clone with current projection can inherit nectar and description with zero LLM calls and zero fuzzy matches. | PASS | `src/projection/load.ts:270-279`, `src/projection/inherit.ts:99-139` | `test/projection-ac.test.ts:266-309` | Boot-time caller is deferred to Wave C; inheritance seam produces Deep Lake rows without LLM/fuzzy paths. |
| 011-AC-7 | Rebuild output is byte-identical modulo `generated_at`. | PASS | `src/projection/format.ts:96-125`, `src/projection/generate.ts:70-94` | `test/projection-ac.test.ts:311-332`, `test/wave2-integration.test.ts:241-259` | Stable key ordering and sorted nectar iteration are present. |
| 014-AC-1 | No explicit provider selection defaults to local nomic. | PASS | `src/embeddings/config.ts:87-117`, `src/embeddings/provider.ts:31-39`, `src/embeddings/provider.ts:92-117` | `test/embeddings-provider.test.ts:29-47` | Provider selector default `local` preserved. |
| 014-AC-2 | Cohere-via-Portkey opt-in POSTs to the Portkey embeddings endpoint using shared headers and host. | PASS | `src/embeddings/config.ts:102-114`, `src/embeddings/cohere-portkey.ts:153-210`, `src/portkey/headers.ts:16-24` | `test/embeddings-cohere.test.ts:45-113` | Decision #30 config values are `embed-v4.0` and `output_dimension: 768`; the known Cohere accepted-set caveat is not re-raised. |
| 014-AC-3 | Non-768 vectors are discarded by `embed.dim_rejected` guard and never stored as valid recall data. | PASS | `src/embeddings/guard.ts:21-87`, `src/embeddings/provider.ts:97-110`, `src/hive-graph/model.ts:117-123` | `test/embeddings-guard.test.ts:17-92` | Guard applies to both local and Cohere providers and leaves `null` for BM25 fallback. |
| 014-AC-4 | Embeddings off or unavailable leaves embedding NULL and recall falls back to BM25 over title/description with no error. | PASS | `src/embeddings/provider.ts:55-67`, `src/embeddings/local-nomic.ts:85-146`, `src/embeddings/cohere-portkey.ts:147-210` | `test/embeddings-provider.test.ts:67-115`, `test/embeddings-cohere.test.ts:115-175` | Recall consumer lands later, but provider null contract and fail-soft paths hold at this wave's seam. |

## Files Changed

- `src/cli.ts` (M), wires `rebuild-projection` and `project --rebuild-projection` to the durable Deep Lake projection rebuild path and updates usage/error text.
- `src/daemon.ts` (M), resolves Portkey and embeddings provider state once at assembly and reflects it in health.
- `src/embeddings/cohere-portkey.ts` (A, untracked at audit time), adds Cohere-via-Portkey embeddings provider with timeouts, retries, config model/dimension, shared headers, and fail-soft null behavior.
- `src/embeddings/config.ts` (A, untracked at audit time), resolves `off | local | cohere` provider selector with `local` default and Cohere config values.
- `src/embeddings/guard.ts` (A, untracked at audit time), adds 768-dim guard and `embed.dim_rejected` sink seam.
- `src/embeddings/http.ts` (A, untracked at audit time), adds shared fetch/sleep seams for embedding transports.
- `src/embeddings/index.ts` (A, untracked at audit time), exports the embeddings module surface and re-exports the unified Portkey headers.
- `src/embeddings/local-nomic.ts` (A, untracked at audit time), adds fail-soft local nomic loopback HTTP provider.
- `src/embeddings/provider.ts` (A, untracked at audit time), adds provider strategy switch and wraps computing providers with the dim guard.
- `src/health.ts` (M), adds `portkey.enabled` and `embeddings.provider` to the health body.
- `src/index.ts` (M), exports Portkey, projection, embeddings, health, and store seams required by the wave.
- `src/portkey/config.ts` (A, untracked at audit time), resolves Portkey enablement, config id, key, and `gemini-2.5-flash` active model default without cache/guardrail toggles.
- `src/portkey/describe-model.ts` (A, untracked at audit time), adds `describe_model` stamping and force re-description reset helpers.
- `src/portkey/headers.ts` (A, untracked at audit time), adds the single shared Portkey base URL, endpoint constants, and `buildPortkeyHeaders`.
- `src/portkey/transport.ts` (A, untracked at audit time), adds bounded Portkey chat-completions transport with usage parsing and safe error messages.
- `src/projection/format.ts` (A, untracked at audit time), defines portable projection shape, bare-hex sha256 validation, and canonical serialization.
- `src/projection/generate.ts` (A, untracked at audit time), builds projection documents from selected store rows.
- `src/projection/inherit.ts` (A, untracked at audit time), builds fresh-clone inheritance rows from validated projection and disk hashes.
- `src/projection/load.ts` (A, untracked at audit time), validates projection version, tenancy, ULID, content hashes, file size, and dangerous keys.
- `src/projection/store-adapter.ts` (A, untracked at audit time), adapts sync and async hive-graph stores into projection sources, including latest-described overlay.
- `src/projection/write.ts` (A, untracked at audit time), implements atomic projection writes, 30s debounce, sync rebuild, and async Deep Lake rebuild.
- `src/hive-graph/deeplake-store.ts` (M), adds async `listLatestDescribedVersions` over the durable Deep Lake seam.
- `src/hive-graph/memory-store.ts` (M), adds sync `listLatestDescribedVersions` for tests and local dev.
- `src/hive-graph/store.ts` (M), adds `listLatestDescribedVersions` to both store seams.
- `test/embeddings-cohere.test.ts` (A, untracked at audit time), AC tests for Cohere-via-Portkey endpoint, headers, config values, retries, and fail-soft behavior.
- `test/embeddings-guard.test.ts` (A, untracked at audit time), AC tests for 768-dim rejection across local and Cohere providers.
- `test/embeddings-provider.test.ts` (A, untracked at audit time), AC tests for provider default, selector routing, off state, and local fail-soft behavior.
- `test/portkey-gateway.test.ts` (A, untracked at audit time), AC tests for Portkey URL/headers, default model, force re-description reset, describe-model stamp, no cache/guardrail toggles, retries, and safe errors.
- `test/projection-ac.test.ts` (A, untracked at audit time), AC tests for projection atomic write, debounce, rebuild, validation, inheritance, and byte-determinism.
- `test/security-remediation-wave-b.test.ts` (A, untracked at audit time), regression tests for M1 timeouts, M2 projection size ceiling, and M3 dangerous-key rejection.
- `test/wave2-integration.test.ts` (A, untracked at audit time), integration tests for unified Portkey headers, latest-described store scans, async Deep Lake projection rebuild, byte-determinism, and health provider bits.
