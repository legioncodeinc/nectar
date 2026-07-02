# QA Report: PRD-005 Hive Graph Catalog Tables (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-005 (index + 005a/005b/005c) against the Nectar knowledge corpus and the cited Honeycomb code, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass (no implementation exists yet), matching the bar and format of the consolidated PRD-001-004 report and the per-module prd-002/prd-003 reports. Every acceptance criterion and load-bearing claim was traced to `data/hive-graph-schema.md` (authoritative DDL), `MASTER-PRD-INDEX.md` decision #3, ADR-0001/ADR-0002, and the real files under `honeycomb/src/daemon/storage/`.

**Related:**
- [`prd-005-hive-graph-catalog-tables-index.md`](../prd-005-hive-graph-catalog-tables-index.md)
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-005 is the data-layer module and is the most heavily code-cited PRD after PRD-002. Its spec substance is excellent: both DDL blocks match the corpus character-for-character (including the additive `confidence REAL` column and the `skipped-deleted` `describe_status` value), all six cited Honeycomb symbols exist at the cited line ranges with zero drift, the tenancy model (`scope: tenant`, `project_id` as a soft column filter verified against `QueryScope`) is grounded, and every deliberate DEFAULT flag and v1 non-goal is preserved. The module **PASSES with warnings** to the medium-and-above standard: there are **zero Critical findings**, and **three medium Warnings**, all documentation/metadata defects rather than spec-correctness defects: (W-1) 005b's column-count prose and two acceptance criteria still say "twenty columns / sole nullable" but the DDL and `ColumnDef[]` now carry twenty-one columns with two nullable columns; (W-2) four `MASTER-PRD-INDEX.md` links use the wrong relative depth and do not resolve; (W-3) the systemic honeycomb code-reference-as-markdown-link issue (W-1 in the consolidated report) is present in the Related sections (19 tokens). The known open item C-2 is now effectively resolved on the corpus side (the corpus already carries both additive edits), leaving only a stale "should be updated" note in 005b, recorded below as an informational item.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-005 index | PASS | PASS | PASS | PASS | WARNING (W-2, W-3) | PASS-with-warnings |
| PRD-005a | PASS | PASS | PASS | PASS | WARNING (W-3); note N-2 | PASS-with-warnings |
| PRD-005b | PASS | WARNING (W-1) | PASS | PASS | WARNING (W-3); note N-1 | PASS-with-warnings |
| PRD-005c | PASS | PASS | PASS | PASS | WARNING (W-2, W-3); note N-3 | PASS-with-warnings |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-1 (Correctness, 005b): column-count prose and two ACs contradict the 21-column DDL and array

The additive `confidence REAL` column was added to the DDL block (`prd-005b-hive-graph-versions-table.md:48`) and the `ColumnDef[]` array (`prd-005b:114`), matching the corpus. Both artifacts now hold **twenty-one** columns with **two** nullable columns (`embedding FLOAT4[]` at `:47`/`:112` and `confidence REAL` at `:48`/`:114`). The surrounding count metadata was not updated to match, so the document contradicts itself:

- `prd-005b:62`: "Twenty columns. Nineteen are `NOT NULL` with a `DEFAULT`; `embedding` is the sole nullable column." Actual: 21 columns, 19 `NOT NULL DEFAULT`, 2 nullable (`embedding` and `confidence`).
- `prd-005b:181` (AC): "matches ... character-for-character (twenty columns; nineteen `NOT NULL DEFAULT`, one nullable `FLOAT4[]`)." The verbatim-match clause is true; the parenthetical count is wrong.
- `prd-005b:182` (AC): "`HIVE_GRAPH_VERSIONS_COLUMNS` has exactly twenty entries." The array has twenty-one entries, so this AC as written is not satisfiable by the correct array.

Impact: an implementer verifying against "exactly twenty entries" would either flag the correct 21-entry array as failing or delete `confidence` to satisfy the count, removing a corpus column. The DDL block and the `ColumnDef[]` array themselves are correct and match the corpus verbatim, so this blocks nothing at runtime, but the acceptance criteria must be internally consistent with the artifact they validate.

**Remediation:** In `prd-005b`, change "Twenty columns" to "Twenty-one columns" and "`embedding` is the sole nullable column" to "`embedding` and `confidence` are the two nullable columns" at `:62`; update AC at `:181` to "(twenty-one columns; nineteen `NOT NULL DEFAULT`, two nullable: `embedding FLOAT4[]` and `confidence REAL`)"; update AC at `:182` to "exactly twenty-one entries." Do not touch the DDL block or the array (they are correct).

### W-2 (Detrimental Patterns, index + 005c): `MASTER-PRD-INDEX.md` links use the wrong relative depth and do not resolve

Four links to the decisions ledger use `../../../MASTER-PRD-INDEX.md`. From a file in `in-work/prd-005-hive-graph-catalog-tables/`, `../../../` resolves to `library/`, so the target is `library/MASTER-PRD-INDEX.md`, which does not exist. The file is at `library/requirements/MASTER-PRD-INDEX.md`, so the correct path is `../../MASTER-PRD-INDEX.md` (up to `requirements/`). Note the same files correctly use three levels for `../../../knowledge/...` (which does resolve, since `knowledge/` is under `library/`), so this is a per-target depth error, not a whole-file base error.

Locations:
- `prd-005-hive-graph-catalog-tables-index.md:9`
- `prd-005-hive-graph-catalog-tables-index.md:65`
- `prd-005c-tenancy-and-project-id-filter.md:9`
- `prd-005c-tenancy-and-project-id-filter.md:102`

This is the same class as finding R-1 in the consolidated PRD-001-004 report (a cross-link off by one `../`), which was remediated in the refine pass.

**Remediation:** Replace `](../../../MASTER-PRD-INDEX.md)` with `](../../MASTER-PRD-INDEX.md)` at the four locations. Re-run an internal link scan to confirm the ledger link resolves and no `knowledge/` link (which legitimately needs three levels) was changed.

### W-3 (Detrimental Patterns, all four files): honeycomb code references as non-resolving markdown links

The PRD body cites honeycomb code with canonical backtick file-path spans (for example `prd-005-...-index.md:13` uses `honeycomb/src/daemon/storage/client.ts:40-46` as a span). The **Related** sections diverge: they wrap the span in a markdown link whose target is `../../../../honeycomb/...`. From `in-work/prd-005-.../`, `../../../../` resolves to `library/`, so the target is `nectar/library/honeycomb/...`, which does not exist. This is the systemic W-1 finding from the consolidated report (Documentation Framework section 6 and `AGENTS.md` require cross-repo code to be a backtick file-path span, not a markdown link).

Link-form honeycomb token counts (all `honeycomb/src/...`; zero `doctor/...`, consistent with the consolidated report's note that PRD-005 carries no doctor references):

| File | Link-form honeycomb tokens | Lines |
|---|---|---|
| `prd-005-...-index.md` | 6 | 66, 67, 68, 69, 70, 71 |
| `prd-005a-hive-graph-table.md` | 4 | 129, 130, 131, 132 |
| `prd-005b-hive-graph-versions-table.md` | 4 | 195, 196, 197, 198 |
| `prd-005c-tenancy-and-project-id-filter.md` | 5 | 103, 104, 105, 106, 107 |
| **Total** | **19** | |

**Remediation (same recipe as the consolidated report):** For each Related-section entry whose visible text is already a full-form backtick span starting with `honeycomb/` (all 19 here are full-form, e.g. `` `honeycomb/src/daemon/storage/schema.ts:28-100` ``), drop the markdown-link wrapper and keep only the backtick span. No path promotion is needed because every visible span is already full-form. Re-run `grep -rhoE '\]\(\.\./\.\./\.\./\.\./honeycomb[^)]*\)' *.md | wc -l` in the PRD folder and confirm it drops to zero, then `git diff` to confirm only link wrappers (not span content) changed. Do not edit the PRD body spans (already conformant).

## 5. Suggestions (consider improving) and sub-medium notes

- **N-1 (informational, C-2 disposition update):** The consolidated report tracked C-2 as two known corpus/PRD disagreements (the `confidence` column and the `skipped-deleted` enum value). The corpus `data/hive-graph-schema.md` now already carries both: `confidence REAL` at `hive-graph-schema.md:78` (with rationale at `:104`) and `skipped-deleted` at `hive-graph-schema.md:81` and `:107`. PRD-005b's DDL matches the corpus verbatim, so **there is no longer a disagreement to record**; the corpus-side edit is effectively complete. The only residue is that PRD-005b's prose still reads as if the corpus lacks these: the blockquote at `prd-005b:60` says "The corpus's `hive-graph-schema.md` should be updated to match (additive schema change)" and both `:60` and `:84` label the columns "(added per QA finding)." These notes are now stale. Sub-medium; consider softening to past tense ("carried in the corpus DDL as of the July 2026 revision") so the note documents history rather than implying a pending corpus edit. Per audit scope, the corpus was not modified.
- **N-2 (Alignment, descriptive inaccuracy, 005a):** `prd-005a:85` states that `HIVE_GRAPH_COLUMNS` "mirrors the structure of `CODEBASE_COLUMNS` ... tenant-identity columns first, row identity next." `CODEBASE_COLUMNS` does place `org_id`/`workspace_id` first (`product.ts:216-219`), but `HIVE_GRAPH_COLUMNS` places row identity (`nectar`, `kind`, `created_at`) first and the tenancy columns later (`prd-005a:68-82`). The ordering claim is inaccurate for the array it describes. No functional impact (column order does not affect the load-time guard or catalog correctness). Sub-medium; consider rewording to "mirrors the tenant-scoped `CODEBASE_COLUMNS` convention (explicit `org_id`/`workspace_id`/`project_id`, `as const` + `Object.freeze`)" without asserting a specific column order.
- **N-3 (non-resolving cross-tree link, 005c):** `prd-005c:84` links `[`hivenectar-stinger` guide 00 § Principle 1](../../../../../.agents/skills/hivenectar-stinger/guides/00-principles.md)`. From `in-work/prd-005-.../`, `../../../../../` resolves to the repo root, so the target is `.agents/skills/hivenectar-stinger/...`, which does not exist in this tree (the stinger guides live under `.cursor/skills/hivenectar-stinger/` in this repo, or in the user home `.agents/`). Same family as W-3 but a stinger-guide target rather than honeycomb code. Low severity; the sentence's substance (do not invent SQL-helper names outside the corpus) is sound and `sqlStr`/`sqlLike` are correctly not invented. Consider dropping the broken link and keeping the plain-text citation, or repointing it to the in-repo skill path.

## 6. Plan Item (AC) Traceability

### PRD-005 index (6 ACs)

| AC (index) | Corpus / code source | Verdict |
|---|---|---|
| Both DDL blocks verbatim; every column name and SQL type cross-checks | `hive-graph-schema.md:32-43` (hive_graph), `:65-87` (versions) | PASS (both blocks match character-for-character, incl. `confidence` and `skipped-deleted`) |
| Each `ColumnDef[]` satisfies the load-time guard (identifiers, no duplicates, NOT NULL has DEFAULT or nullable) | `schema.ts:80-100`; nullable exemption `schema.ts:73-74` | PASS |
| Both tables `scope: tenant` with `org_id`/`workspace_id`/`project_id`, mirroring `CODEBASE_COLUMNS` | `product.ts:216-241`; `types.ts:74` | PASS |
| `hive-graph` group appended to `CATALOG`; `REGISTRY = buildRegistry(CATALOG)` picks up patterns | `catalog/index.ts:45-59`, `:62` | PASS (planned edit; both sites verified; group name is a preserved DEFAULT) |
| Both tables self-create on first write via `withHeal`; no DDL pre-step | `heal.ts:286-313` | PASS (create-then-heal-then-one-retry matches the PRD claim exactly) |
| `project_id` documented as a soft `WHERE` filter, verified against `QueryScope` (org + workspace only) | `client.ts:41-46` | PASS (no `project` field; `workspace` doc-comment reads "Target workspace/partition") |

### PRD-005a hive_graph (6 ACs)

| AC (005a) | Source | Verdict |
|---|---|---|
| Verbatim DDL matches source (nine columns, all TEXT NOT NULL DEFAULT) | `hive-graph-schema.md:32-43` | PASS |
| `HIVE_GRAPH_COLUMNS` has exactly nine entries in declaration order | `prd-005a:68-82` | PASS (9 entries) |
| Array passes `validateColumnDefs("HIVE_GRAPH", ...)` | `schema.ts:80-100` | PASS |
| `CatalogTable` declares `scope: tenant`, `embeddingColumns: []`, write pattern | `types.ts:80-95`; pattern is a preserved DEFAULT | PASS |
| Record spread into `hive-graph` group appended to `CATALOG` | `catalog/index.ts:45-59` | PASS (planned edit) |
| First write → one `buildCreateTableSql` + one retry in `withHeal` | `heal.ts:286-313` | PASS |

### PRD-005b hive_graph_versions (7 ACs)

| AC (005b) | Source | Verdict |
|---|---|---|
| Verbatim DDL matches source | `hive-graph-schema.md:65-87` | PASS on the verbatim match; the parenthetical "twenty columns" count is wrong (see W-1) |
| `HIVE_GRAPH_VERSIONS_COLUMNS` has exactly twenty entries incl. `embedding` `"FLOAT4[]"` | `prd-005b:96-126` | FAIL as written (array has 21 entries; array is correct, AC count is wrong) - see W-1 |
| Array passes `validateColumnDefs`; nullable `embedding` exempt | `schema.ts:80-100`, `:73-74` | PASS (nullable `confidence` also exempt) |
| `CatalogTable` declares `embeddingColumns: ["embedding"]`, `scope: tenant`, write pattern | `types.ts:80-95` | PASS |
| `defineTable` embedding-column assertion passes | `types.ts:107-122` (assertion loop `:109-116`) | PASS (`"embedding"` present in `columns`) |
| First write → one `buildCreateTableSql` + one retry in `withHeal` | `heal.ts:286-313` | PASS |
| `embedding` documented 768-dim `FLOAT4[]`, nullable, matches `sessions`/`memory` embeddings | `hive-graph-schema.md:103`; ADR-0001 (768-dim tied to schema) | PASS |

### PRD-005c tenancy + project_id soft-filter (6 ACs)

| AC (005c) | Source | Verdict |
|---|---|---|
| Both tables `scope: tenant`; carry `org_id`/`workspace_id`/`project_id` as `TEXT NOT NULL DEFAULT ''` | `prd-005a`, `prd-005b`; `hive-graph-schema.md` tenancy section | PASS |
| Neither table carries `agent_id` or `visibility` | verbatim DDL of both tables | PASS |
| `QueryScope` cited as evidence `project` is not a partition axis; `workspace` is the partition | `client.ts:41-46` | PASS |
| Boot sequence has no per-project DDL; tables self-create via `withHeal` at the workspace partition | `heal.ts:286-313`; MASTER decision #3 | PASS |
| Every documented reader query applies the three-column scope filter with values through the SQL guards | `sql.ts` (`sqlStr`/`sqlLike`, named in corpus) | PASS (no invented helper names) |
| The "auto-create per org>workspace>project" reframing recorded verbatim from decision #3 | `MASTER-PRD-INDEX.md:13` (decision #3) | PASS |

## 7. Deliberate items preserved (NOT flagged as gaps)

Confirmed present and intentional, not defects: the catalog group name `hive-graph` (DEFAULT), the `update-or-insert` (005a) and `append-only` (005b) write patterns (DEFAULT), and `CatalogScope: tenant` for both tables (DEFAULT), each carrying "DEFAULT - confirm before implementation." Symbol-level and directory-level nectars are a stated v1 non-goal (`kind` reserves the `'directory'` namespace). The additive `confidence REAL` column and the `skipped-deleted` `describe_status` value are self-declared documented additive changes that now match the corpus verbatim; they are not treated as defects.

## 8. High-risk surfaces verified verbatim / against source

- `hive_graph` DDL: 9 columns, all `TEXT NOT NULL DEFAULT`, matches `hive-graph-schema.md:32-43`.
- `hive_graph_versions` DDL: 21 columns (19 `NOT NULL DEFAULT`, 2 nullable: `embedding FLOAT4[]`, `confidence REAL`), matches `hive-graph-schema.md:65-87`.
- `ColumnDef` interface at `schema.ts:28-33`; load-time guard at `schema.ts:80-100`; nullable exemption documented at `schema.ts:73-74`.
- `WritePattern` at `types.ts:60`; `CatalogScope` at `types.ts:74`; `CatalogTable` at `types.ts:80-95`; `defineTable` at `types.ts:107-122`.
- `CODEBASE_COLUMNS` at `product.ts:216-241` (tenant columns first at `:216-219`); `codebase` table entry at `product.ts:313-319` (`select-before-insert` at `:316`, `scope: "tenant"` at `:318`).
- `CATALOG` aggregation at `catalog/index.ts:45-59`; `REGISTRY = buildRegistry(CATALOG)` at `:62`.
- `withHeal` at `heal.ts:286-313` (missing-table classify, `buildCreateTableSql` at `:305`, `healColumnsTolerant` at `:308`, exactly one retry at `:312`).
- `QueryScope` at `client.ts:41-46` (org required, workspace optional, no project field).
- 768-dim tied to schema per ADR-0001; embedding dimensionality matches `sessions.message_embedding` / `memory.summary_embedding`.

All six cited symbol/line ranges exist with no drift. No fabricated values, no invented SQL-helper names.

## 9. Files Audited

- `prd-005-hive-graph-catalog-tables-index.md` - audited (carries W-2, W-3). (audited)
- `prd-005a-hive-graph-table.md` - audited (carries W-3; note N-2). (audited)
- `prd-005b-hive-graph-versions-table.md` - audited (carries W-1, W-3; note N-1). (audited)
- `prd-005c-tenancy-and-project-id-filter.md` - audited (carries W-2, W-3; note N-3). (audited)

No PRD content, corpus, or code was modified by this audit (report-only, per quality-stinger).

**Overall verdict (as-audited): PASS-with-warnings** (medium-and-above). Zero Critical findings. Three medium Warnings, all documentation/metadata defects with grounded remediation recipes: W-1 (005b column-count prose and two ACs contradict the 21-column artifact), W-2 (four broken `MASTER-PRD-INDEX.md` links), W-3 (19 honeycomb code refs as non-resolving markdown links). The spec substance (verbatim DDL, `ColumnDef[]` arrays, tenancy model, `withHeal` lazy-create, `project_id` soft-filter) passes cleanly, and all cited Honeycomb code is truthful with no line drift. C-2 is effectively resolved on the corpus side (informational note N-1).

**Post-remediation verdict: PASS (clean at medium-and-above).** See the addendum below; all three Warnings were remediated in the same `/the-smoker` Wave A run.

---

## 10. Remediation addendum (2026-07-01, the-smoker Wave A)

All medium Warnings and the two link-defect sub-medium notes were remediated in place in the PRD-005 files (the DDL blocks and `ColumnDef[]` arrays were correct and were NOT touched). The corpus was not modified.

| Finding | Sev | Resolution |
|---|---|---|
| W-1 | Medium | `prd-005b:62` prose updated to "Twenty-one columns ... `embedding` (`FLOAT4[]`) and `confidence` (`REAL`) are the two nullable columns"; AC at `:181` updated to "twenty-one columns; nineteen `NOT NULL DEFAULT`, two nullable: `embedding` `FLOAT4[]` and `confidence` `REAL`"; AC at `:182` updated to "exactly twenty-one entries ... including `embedding` as `"FLOAT4[]"` and `confidence` as `"REAL"`". Also corrected the related "sole nullable column" phrasing in the `## The embedding column` section. |
| W-2 | Medium | All four `](../../../MASTER-PRD-INDEX.md)` links corrected to `](../../MASTER-PRD-INDEX.md)` (index Overview + Related; 005c Overview + Related). `../../../knowledge/...` links left unchanged (they resolve correctly). |
| W-3 | Medium | All 19 honeycomb code refs in the Related sections unwrapped from markdown-link form to canonical backtick file-path spans (index 6, 005a 4, 005b 4, 005c 5). Pre-existing prose em dashes in those lines were preserved per the repo's no-em-dashes exception for pre-existing content. |
| N-1 | Sub-medium | Stale "should be updated to match" wording in `prd-005b:60` changed to state the corpus already carries `confidence REAL`; "(added per QA finding)" labels on the `confidence` note and `skipped-deleted` enum softened to reflect that the corpus and PRD now agree. |
| N-3 | Sub-medium | The non-resolving `hivenectar-stinger` guide markdown link in `prd-005c:84` converted to a plain-text citation. |
| N-2 | Sub-medium | Left as-is (purely descriptive, no functional impact); noted for a future authoring pass. |

**Verification:** `grep` for `](.../honeycomb` and `](.../doctor` markdown-link tokens across the PRD-005 folder returns zero (excluding the QA report's own descriptive text and the legitimate ADR-0002 knowledge-doc link whose filename contains "doctor"); `grep` for `../../../MASTER-PRD-INDEX` returns zero in the PRD files; the column-count prose and ACs are internally consistent with the 21-column artifact. All PRD-005 acceptance criteria now verify PASS with no medium-or-above finding open.
