# QA Report: PRD-012 Manual Hive Graph Search (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Wave-0 corpus-conformance audit of PRD-012 (index + 012a/012b) against the Nectar knowledge corpus and the cited Honeycomb code, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass (no implementation exists yet), matching the bar and format of the `prd-005-hive-graph-catalog-tables` report. Every acceptance criterion and load-bearing claim was traced to `data/recall-integration.md` (authoritative), `data/hive-graph-schema.md`, `MASTER-PRD-INDEX.md` (decisions #2/#3, the CLI table), the dependency map (D-6/D-7), and the real files under `honeycomb/src/daemon/runtime/memories/recall.ts`, `honeycomb/src/daemon/storage/{sql,vector,client}.ts`, `honeycomb/src/daemon/runtime/services/embed-client.ts`, `honeycomb/src/daemon/runtime/codebase/api.ts`, and `honeycomb/src/daemon/runtime/server.ts`.

**Related:**
- [`../prd-012-manual-hive-graph-search-index.md`](../prd-012-manual-hive-graph-search-index.md)
- [`../../../../knowledge/private/data/recall-integration.md`](../../../../knowledge/private/data/recall-integration.md)
- [`../../../PRD-003-016-DEPENDENCY-MAP.md`](../../../PRD-003-016-DEPENDENCY-MAP.md)
- [`../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md`](../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md)

---

## 1. Summary

PRD-012 is the operator-facing search module and is heavily code-cited (over 40 Honeycomb line-range citations across the three files). The spec substance is sound: the engine's guarded-lexical + `<#>`-vector two-arm design, the latest-per-nectar `MAX(seq)` subquery, the `describe_status = 'described'` filter, the `sqlIdent`/`sqlLike` guard discipline, the missing-table and embeddings-off fail-soft contracts, the CLI-and-endpoint identical-shape contract, and the dependency framing (HARD on 005/014, co-dependent with 008, explicitly no edge to 013 per D-7) all check out against the corpus and against the real Honeycomb code with essentially zero drift on every cited line range. The module **PASSES with warnings** at the medium-and-above standard: **zero Critical findings**, and **five medium Warnings**, three of which were mechanical documentation defects and have been **remediated in place during this audit** (per the remediation policy), and two of which are substantive spec gaps that are **reported, not fixed**, because they touch a DEFAULT flag pending user sign-off (the CLI command name) and an implied-but-missing mechanic (the semantic arm's mandatory two-step hydrate). Three Suggestions round out the report.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-012 index | PASS | PASS | PASS | PASS | WARNING (W-1, W-2); remediated | PASS-with-warnings (remediated) |
| PRD-012a | WARNING (W-5) | WARNING (W-3); remediated | PASS | WARNING (W-5) | WARNING (W-1); remediated; notes N-1, N-2, N-3 | PASS-with-warnings |
| PRD-012b | PASS | PASS | WARNING (W-4) | PASS | WARNING (W-1, W-2); remediated; note N-2 | PASS-with-warnings |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-1 (Detrimental Patterns, all three files, REMEDIATED): honeycomb code references as non-resolving markdown links

Every Honeycomb code citation across the index, 012a, and 012b was wrapped as a markdown link whose target used `../../../../honeycomb/...`. From `backlog/prd-012-manual-hive-graph-search/`, four `../` levels resolve to `nectar/`, so the target became `nectar/honeycomb/...`, which does not exist (`honeycomb/` is a sibling repository at the workspace root, not a subtree of `nectar/`). This is the same systemic class as the W-1/W-3 findings in the PRD-003 and PRD-005 reports; `AGENTS.md` and the hivenectar-stinger documentation-framework directive require cross-repo code citations to be plain backtick file-path spans, never markdown links.

Scale: 54 instances (index 10, 012a 36, 012b 8).

**Remediation applied:** Every `[`<visible>`](../../../../honeycomb/...)` markdown link across the three files was unwrapped to a bare backtick span. Where the visible text was already full-form (starting with `honeycomb/`), the wrapper was dropped unchanged. Where the visible text was short-form (e.g. `` `recall.ts:24-35` ``, `` `embed-client.ts:271-275` ``, `` `codebase/api.ts:324-329` ``, `` `server.ts:255-258` ``), the citation was promoted to the full repo-relative path derived from the link's own href (e.g. `` `honeycomb/src/daemon/runtime/memories/recall.ts:24-35` ``), matching the canonical form the majority of citations already used. Verified: `grep -c ']\([./]*honeycomb' *.md` now returns 0 across all three files.

### W-2 (Detrimental Patterns, index + 012b, REMEDIATED): lifecycle-stale sibling-PRD links

Three sibling-PRD relative links assumed a `backlog/`-sibling location that is no longer current, because the target PRDs moved lifecycle folders after PRD-012 was authored:

- `prd-012-manual-hive-graph-search-index.md` linked `../prd-005-hive-graph-catalog-tables/...` (PRD-005 moved to `completed/` after its Wave A QA pass) and `../prd-014-embeddings-provider-switching/...` (PRD-014 moved to `in-work/` after its Wave B QA pass).
- `prd-012b-cli-and-endpoint.md` linked `../prd-002-nectar-daemon/prd-002c-nectar-cli-surface.md` eight times (PRD-002 moved to `completed/`).

None of the three resolved from the PRD-012 folder's current position.

**Remediation applied:** Corrected to `../../completed/prd-005-hive-graph-catalog-tables/prd-005-hive-graph-catalog-tables-index.md`, `../../in-work/prd-014-embeddings-provider-switching/prd-014-embeddings-provider-switching-index.md`, and `../../completed/prd-002-nectar-daemon/prd-002c-nectar-cli-surface.md` (eight occurrences) respectively. Verified: a full relative-link resolution scan across all three PRD-012 files now reports 52/52 `.md` links resolving to an existing file, zero broken.

### W-3 (Correctness, 012a, REMEDIATED): wrong decision number cited for the mirror-not-import principle

`prd-012a-lexical-semantic-search-over-hive-graph.md:164` (Implementation notes) read: "Per decision #4 (`MASTER-PRD-INDEX.md`), the nectar engine mirrors the recall arm-builder pattern in its own code; it does not import honeycomb's `recall.ts`." `MASTER-PRD-INDEX.md`'s decision #4 is "Watcher: `node:fs.watch`, mirror Honeycomb" (the file-watcher choice for PRD-006), which is unrelated to the recall arm-builder pattern. The correct citation is **decision #2**, "Recall: mirror the per-arm guarded-query pattern; correct the corpus's 'UNION ALL' prose" (`MASTER-PRD-INDEX.md:13`), which is exactly the "mirror, do not import, per-arm guarded query" principle the sentence describes.

**Remediation applied:** Changed "Per decision #4" to "Per decision #2" at `prd-012a:164`. No other content on the line was touched.

### W-4 (Alignment, 012b, NOT FIXED, reported for the DEFAULT sign-off): the proposed CLI command breaks the established operational-verb namespace

`prd-012b-cli-and-endpoint.md` specifies the command as bare `nectar search <query> [--limit N] [--json]` and its own "Entry binary / namespace" paragraph (`prd-012b:40`) describes this as "**the operational-verb namespace** (reaches the daemon over loopback `:3854`), mirroring the `brood`/`prune`/`review-matches`/`rebuild-projection` posture in `prd-002c`." But every one of those four sibling commands is namespaced under **`honeycomb nectar <verb>`**, not bare `nectar <verb>`: confirmed both in `MASTER-PRD-INDEX.md`'s CLI table (`:206-214`: `honeycomb nectar brood`, `honeycomb nectar prune --confirm`, `honeycomb nectar review-matches`, `honeycomb nectar rebuild-projection`) and in the completed, QA-passed `prd-002c-nectar-cli-surface.md` (`:7, 16, 50-53`), which draws an explicit two-binary line: the **bare** `nectar` binary owns only the `daemon` lifecycle verb (direct composition-root invocation, no running daemon required); the **`honeycomb nectar <verb>`** sub-command namespace owns every operational verb that reaches an already-running daemon over loopback, exactly the posture `search` needs (it is not a lifecycle verb; it queries a live daemon). `MASTER-PRD-INDEX.md`'s own CLI table entry for PRD-012 (`:215`, "`nectar search` (proposed)") already carries this same bare-binary framing, so the inconsistency traces back to the master index and was carried forward into PRD-012b rather than reconciled against the later, more detailed, already-QA-passed PRD-002c.

Impact: this is a DEFAULT flag explicitly pending user confirmation (`prd-012b:140`, "DEFAULT — confirm before implementation... `nectar search <query>`... From the corpus's proposed command, confirm"), so per the audit's remediation policy this is a substantive naming disagreement to report, not to silently rename. If left as bare `nectar search`, an implementer would either (a) add a third precedent-breaking bare-binary operational verb, or (b) have to special-case `search`'s dispatch wiring outside the `honeycomb nectar <verb>` namespace 002c already built. Recommend the DEFAULT sign-off resolve this explicitly to `honeycomb nectar search <query>` for consistency with the corpus's own established namespace, unless there is a reason (not stated anywhere in the corpus) for `search` to be the sole read-only exception.

### W-5 (Completeness, 012a, NOT FIXED, substantive spec gap): the semantic arm's mandatory hydrate step is never described

`prd-012a`'s semantic-arm walkthrough (`:98-106`, AC-012a.2.1) describes a single conceptual step: embed the query, then "run the `<#>` cosine match over `embedding` under the latest-per-nectar subquery + scope, ordered by ascending distance." It explicitly commits to reusing the existing engine unforked: "The semantic arm uses the same `<#>` vector-match engine the recall engine's `SEMANTIC_ARMS` use (`vectorSearch` via the existing engine, not a fork — D-5)." But `vectorSearch`'s own SQL builder is documented as returning **scored IDs only, never row content**: `honeycomb/src/daemon/storage/vector.ts:217-218` states `buildVectorSearchSql` "Selects the ID column and the `<#>` cosine score ONLY (no content, e-AC-4)", and the `ScoredId` interface (`vector.ts:180-185`) carries only `id` and `score`. The real `runSemanticArm` PRD-012a cites as its template (`recall.ts:925-984`, cited in the PRD as `925-961`, which only covers the pre-hydrate portion) performs a **second, separate guarded query** (`buildSemanticHydrateSql`, invoked at `recall.ts:966`) to fetch the matched IDs' `title`/`description`/etc. text before the entries can be merged into the ranked result.

Because PRD-012a commits to reusing `vectorSearch` unforked, this two-step "score via vector match, then hydrate via a second guarded query" pattern is architecturally mandatory, not optional, yet the PRD's semantic-arm description and its 3-step walkthrough (`:102-104`) never mention it. An implementer following the prose literally could reasonably attempt a single `<#>`-plus-column-projection query, which the reused engine does not support in one statement.

**Recommended remediation (reported, not applied; a content addition beyond "clear mechanical defect"):** Add a fourth step to the semantic-arm walkthrough describing the hydrate query: after `vectorSearch` returns scored IDs, run a second guarded `storage.query` joining those IDs back to `hive_graph_versions` (re-applying the tenancy scope, mirroring `buildSemanticHydrateSql`'s defense-in-depth re-filter) to fetch `title`/`description`/`path`/`concepts`/`content_hash`, then merge into `HiveGraphHit[]` preserving the vector-search rank order.

## 5. Suggestions (consider improving)

- **N-1 (informational, 012a):** The `runSemanticArm` citation (`prd-012a:15, 100, 140`) reads `` `recall.ts:925-961` ``, but the actual function spans `925-984` (the hydrate step this report's W-5 flags lives in `962-984`). Widening the cited range to `925-984` would have surfaced the hydrate step to anyone who opened the citation, and is a natural companion fix if W-5 is remediated.
- **N-2 (informational, 012a + 012b):** `HiveGraphHit` is referenced three times as the engine's return-row type (`012a:43, 94`; `012b:42`) but is never declared as an explicit interface block, unlike `HiveGraphSearchDeps`, which is declared in full (`012a:33-36`). The six fields are recoverable from prose (`012a:94`: `id`, `path`, `title`, `body`, `concepts`, `content_hash`) and from the endpoint's example JSON (`012b:67-70`, which additionally shows `source`), so this is not a grounding gap, just a missing consolidated type declaration that would help an implementer.
- **N-3 (informational, 012a):** The lexical arm SQL (`012a:90`) uses a single `:pattern` placeholder shared across `title`, `description`, and `concepts`. The authoritative corpus source it claims to carry (`recall-integration.md:55-59`) uses **two** distinct placeholders: `:pattern` for `title`/`description` and a separate `:concept_pattern` for `concepts`. The two are likely functionally equivalent (the same escaped term substituted twice under different names), but the corpus's choice to split them is unexplained in either document; worth a one-line confirmation at implementation time that `concepts`' JSON-array-string shape does not need distinct escaping from the free-text `title`/`description` fields.

## 6. Plan Item (AC) Traceability

### PRD-012 index (6 acceptance criteria)

| AC (index) | Corpus / code source | Verdict |
|---|---|---|
| Guarded lexical arm over `title + description + concepts`; guarded `<#>` vector arm over `embedding` when available; both scoped by `org_id`/`workspace_id`/`project_id` and filtered to the latest described version per nectar | `recall-integration.md:34-64`; `hive-graph-schema.md:62-113` | PASS |
| Latest-per-nectar `MAX(seq)` subquery + `describe_status = 'described'` filter | `recall-integration.md:46-54, 137` | PASS |
| Every identifier through `sqlIdent`, search term through `sqlLike`, mirroring `recall.ts:319-383` | `honeycomb/src/daemon/storage/sql.ts:42-105`; `recall.ts:319-383` (verified verbatim, no drift) | PASS |
| Missing `hive_graph_versions` table degrades to `{ hits: [], sources: [], degraded: true }`, never a 500, mirroring `recall.ts:24-35` | `recall.ts:24-35` (header rationale, verified verbatim) | PASS |
| Embeddings off / query embed null → lexical-only + `degraded: true`, mirroring `recall.ts:2106` | `recall.ts:2103-2106` (verified: `const degraded = keywordOnly ? false : semanticRun === null;`) | PASS |
| CLI and endpoint return the identical result shape | `prd-012b:84-95` (mermaid + prose); consistent between both files | PASS |

### PRD-012a `searchHiveGraph` engine (10 acceptance criteria, US-012a.1 to US-012a.4)

| AC | Corpus / code source | Verdict |
|---|---|---|
| AC-012a.1.1 guarded `ILIKE` over `title`/`description`/`concepts`, `sqlLike` + `sqlIdent` | `recall.ts:319-337` (`buildMemoriesArmSql`, verified verbatim) | PASS |
| AC-012a.1.2 latest-per-nectar + `describe_status='described'` | `recall-integration.md:46-54` | PASS |
| AC-012a.1.3 literal `%`/`_` escaped, never a wildcard | `sql.ts:77-86` (`sqlLike`, verified) | PASS |
| AC-012a.2.1 embed query, `<#>` cosine match under latest-per-nectar + scope | `recall.ts:925-984`; `vector.ts:228-250` (`buildVectorSearchSql`) | WARNING: the mandatory hydrate step this pattern requires (see W-5) is not described |
| AC-012a.2.2 non-768 vector → client returns `null`, arm skipped | `embed-client.ts:271-275` (`b-AC-5` dim guard, verified verbatim) | PASS |
| AC-012a.2.3 both arms fuse by reciprocal rank, dedup by `source + id` | `recall.ts:403-457` (`fuseHits`, verified verbatim) | PASS |
| AC-012a.3.1 embeddings off / null → semantic arm skipped, lexical runs alone | `recall.ts:2091-2106` | PASS |
| AC-012a.3.2 lexical-only run returns `degraded: true` | `recall.ts:2106` | PASS |
| AC-012a.4.1 missing table → empty/degraded floor, never a 500 | `recall.ts:24-35` | PASS |
| AC-012a.4.2 empty query → empty/degraded floor | `recall.ts:2070-2073` (verified verbatim: the `term === ""` guard) | PASS |

### PRD-012b CLI + endpoint (7 acceptance criteria, US-012b.1 to US-012b.3)

| AC | Corpus / code source | Verdict |
|---|---|---|
| AC-012b.1.1 CLI reaches daemon over loopback, renders ranked hits | `prd-002c` (thin-client posture, verified after link fix) | PASS |
| AC-012b.1.2 `--limit N` passed through; default 20 | `recall.ts:129` (`DEFAULT_RECALL_LIMIT = 20`, verified verbatim) | PASS |
| AC-012b.1.3 `--json` emits raw engine JSON | Internally consistent with the endpoint contract (`:63-74`) | PASS |
| AC-012b.2.1 dashboard `POST`s to endpoint; handler delegates, returns identical JSON | `prd-008b-search-endpoint.md:7, 40, 132` (cross-checked, read-only; consistent) | PASS |
| AC-012b.2.2 `degraded: true` renders the same signal as the CLI footer | Internally consistent | PASS |
| AC-012b.3.1 CLI reaches daemon over loopback `:3854`, never imports daemon core/DeepLake | `prd-002c:16, 53` (verified after link fix) | PASS, but see W-4 (the specific command name contradicts the namespace this AC's posture is grounded in) |
| AC-012b.3.2 daemon-not-running reports a clear error, no local-index fallback | Consistent with the thin-client posture; no honeycomb code contradicts it | PASS |

## 7. Dependency and non-goal framing check (task requirement #2)

Confirmed against `PRD-003-016-DEPENDENCY-MAP.md:424-455` and D-7 (`:757`):

- **008 co-dependency stated correctly.** Both the PRD-012 index (Non-Goals, Related) and `prd-012b` (Overview, "The endpoint contract," Related) correctly frame `/api/hive-graph/search` as the handler PRD-008b mounts, landing together, matching the dependency map's "HARD (co-dependent)" classification verbatim. Cross-checked (read-only) against `prd-008b-search-endpoint.md`, which states the identical relationship from its side.
- **No 012 → 013 dependency claimed.** PRD-012's Non-Goals explicitly and repeatedly frame PRD-013 as the separate fused-recall arm ("distinct from PRD-013"), never as a dependency. The dependency map's D-7 confirms this is by design: "PRD-012 and PRD-013 both independently mirror the honeycomb `recall.ts` arm builders; that is a shared pattern, not a 012 → 013 dependency." No PRD-012 file links to or claims to depend on the PRD-013 folder (confirmed: zero references to `prd-013` anywhere in the PRD-012 folder).
- **Dependency claims match the map exactly.** HARD on 005 (table) and 014 (embed client); HARD-co-dependent on 008; downstream dependents 008 and 015: all four match `PRD-003-016-DEPENDENCY-MAP.md:432-436` verbatim.

## 8. DEFAULT flags and deliberate-gap check (task requirement #3)

- **Search result default LIMIT 20** (`prd-012a:175`, index `:65`) and **CLI command `nectar search <query>`** (`prd-012b:140`, index `:66`) both carry the `[DEFAULT — confirm before implementation]` marker and remain unsigned, matching `PRD-003-016-DEPENDENCY-MAP.md:776` (B-7) and `PRD-DECISIONS-AND-DEFAULTS.md:106-107, 143`, which both list PRD-012's two defaults as still open (not among the decisions #29-#33 already signed off). No default was silently filled.
- **Deliberate spec gaps preserved.** No mention of a TLSH confidence threshold, `review-matches` sub-flag grammar, or symbol/directory nectars anywhere in the PRD-012 folder; `review-matches` appears only as the name of a sibling CLI verb, never with an invented sub-flag grammar.

## 9. Documentation-framework and lifecycle-link sweep (task requirement #3, continued)

- **Backtick code refs:** non-conformant before remediation (W-1); conformant after (all 54 honeycomb citations are now bare backtick spans).
- **Resolving links:** two link families were stale (W-2: PRD-005/014/002 lifecycle moves); all 52 `.md`-to-`.md` links in the folder now resolve.
- **Lifecycle-stale sweep for 001-006 (completed/) and 010/011/014/017 (in-work/):** the sweep specifically caught PRD-005 (completed/) and PRD-002 (completed/) and PRD-014 (in-work/) references, all now corrected. No reference to PRD-001, 003, 004, 006, 010, 011, or 017 exists anywhere in the PRD-012 folder, so there was nothing further to check for those numbers.

## 10. High-risk surfaces verified verbatim / against source

- `sqlStr`/`sqlLike`/`sqlIdent` at `honeycomb/src/daemon/storage/sql.ts:42-105`: exact semantics match the guard-discipline claims in all three PRD-012 files.
- `buildMemoriesArmSql`/`buildMemoryArmSql`/`buildSessionsArmSql` at `recall.ts:319-383`: the exact template PRD-012a's lexical arm mirrors; verified verbatim, zero line drift despite the current `recall.ts` having grown to 2,244 lines with many PRDs (027, 044c, 047b/c/d, 049b, 058a, 062a/d, 063c) layered on since PRD-012 was authored.
- `fuseHits` (RRF) at `recall.ts:403-457`: verified verbatim.
- `runSemanticArm` at `recall.ts:925-984`: verified to exist at the cited start line; the PRD's cited end line (961) undercites the function by 23 lines, the exact lines carrying the hydrate step this report's W-5 flags.
- `recallMemories`'s empty-query guard at `recall.ts:2070-2073` and honest-degraded signal at `recall.ts:2106`: both verified verbatim.
- `DEFAULT_RECALL_LIMIT = 20` / `MAX_RECALL_LIMIT = 200` at `recall.ts:129, 131`; `resolveRecallLimit` at `recall.ts:303-308`: verified verbatim.
- `EmbedClient` interface at `embed-client.ts:80-83`; `DaemonEmbedClient` null-on-every-failure-mode implementation at `embed-client.ts:240-287`: verified verbatim.
- `EMBEDDING_DIMS = 768` at `honeycomb/src/daemon/storage/vector.ts:35`; `buildVectorSearchSql`'s scored-IDs-only projection at `vector.ts:217-250`: verified verbatim; this is the source of W-5.
- `mountGraphApi`'s resolve-scope/delegate/failure-as-data handler shape at `codebase/api.ts:304-330`, `NO_ORG_BODY` pattern at `:319-320`: verified verbatim as the model PRD-012b's endpoint contract mirrors.
- Permission-middleware wiring at `server.ts:255-258`: verified verbatim.
- `MASTER-PRD-INDEX.md` decisions #2 (`:13`) and #3 (`:15`) and the CLI table (`:203-215`): verified; decision #2 is the correct citation for the "mirror, do not import" principle (W-3); the CLI table's own `nectar search` entry is the root of the W-4 namespace inconsistency.

All cited symbol/line ranges exist. No fabricated values, no invented SQL-helper names, no filled-in deliberate gaps.

## 11. Files Audited

- `prd-012-manual-hive-graph-search-index.md`: audited; carried W-1, W-2 (both remediated).
- `prd-012a-lexical-semantic-search-over-hive-graph.md`: audited; carried W-1, W-3 (both remediated); carries W-5 (reported); notes N-1, N-2, N-3.
- `prd-012b-cli-and-endpoint.md`: audited; carried W-1, W-2 (both remediated); carries W-4 (reported); note N-2.

No corpus file, no other PRD folder, and no honeycomb source file was modified by this audit (report-only outside the PRD-012 folder, per quality-stinger and the task's remediation policy). All edits were confined to `library/requirements/backlog/prd-012-manual-hive-graph-search/`.

**Overall verdict (as-audited, post-remediation): PASS-with-warnings** (medium-and-above). Zero Critical findings. Of five medium Warnings, three mechanical documentation defects (W-1, W-2, W-3) were remediated in place during this audit; two substantive findings (W-4, the CLI namespace inconsistency on an open DEFAULT; W-5, the undocumented mandatory hydrate step in the semantic arm) are reported for the implementer/driver to resolve before PRD-012 enters implementation, since both require a content or naming decision beyond a mechanical fix. Three Suggestions (N-1, N-2, N-3) are recorded for optional improvement. Dependency framing (HARD 005/014, co-dependent 008, no 012→013 edge), DEFAULT-flag discipline, and deliberate-gap preservation all check out cleanly.

---

## 12. Remediation log (this audit, 2026-07-02)

| Finding | Sev | Resolution |
|---|---|---|
| W-1 | Medium | All 54 honeycomb code-reference markdown links across the three PRD-012 files unwrapped to bare backtick spans; short-form citations promoted to the full `honeycomb/src/...` path. Verified zero residual `](.../honeycomb...)` tokens. |
| W-2 | Medium | Three stale sibling-PRD links corrected to their current lifecycle location: PRD-005 → `../../completed/prd-005-hive-graph-catalog-tables/...` (index); PRD-014 → `../../in-work/prd-014-embeddings-provider-switching/...` (index); PRD-002c → `../../completed/prd-002-nectar-daemon/prd-002c-nectar-cli-surface.md` (012b, 8 occurrences). Verified 52/52 `.md` links now resolve. |
| W-3 | Medium | `prd-012a:164` "Per decision #4" corrected to "Per decision #2" (the actual `MASTER-PRD-INDEX.md` decision covering the per-arm mirror-not-import pattern). |
| W-4 | Medium | Not fixed. Reported in Section 4 for the DEFAULT sign-off decision (touches an explicitly unconfirmed CLI-name default; renaming it is a design decision, not a mechanical defect). |
| W-5 | Medium | Not fixed. Reported in Section 4 as a spec-completeness gap (the recommended fix is a content addition, a fourth walkthrough step, beyond the "clear mechanical defect" remediation scope of this audit). |
| N-1, N-2, N-3 | Sub-medium | Not fixed; recorded as Suggestions for a future authoring pass. |

**Verification commands run:** a Python link-resolution scan over all `.md`-to-`.md` links in the folder (52/52 resolve); `grep -c ']\([./]*honeycomb'` across the three files (0/0/0); a manual re-read of the corrected `decision #2` citation against `MASTER-PRD-INDEX.md:13`.

---

## Orchestrator remediation addendum (2026-07-02, the-smoker run)

- **W-5 CLOSED.** PRD-012a's semantic-arm walkthrough (step 3) now documents the mandatory two-step shape the reused engine imposes: `vectorSearch` returns scored row identifiers only, so the arm scores first and hydrates the matched rows' content through a second guarded query, exactly as the real `runSemanticArm` does.
- **W-4 PARKED (user decision, blocks 012b implementation only).** The CLI-name DEFAULT (`nectar search <query>` vs the operational-verb namespace consistency question) is folded into the pending Wave C/D DEFAULT sign-off ask in the execution ledger; it is a naming decision, not a doc defect.

**Post-remediation verdict: PASS at medium-and-above, with W-4 riding the sign-off ask.**
