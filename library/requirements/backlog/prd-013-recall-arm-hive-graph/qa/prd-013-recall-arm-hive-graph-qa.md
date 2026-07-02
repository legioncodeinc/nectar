# QA Report: PRD-013 Recall Arm — `hive_graph_versions` (PRD-vs-Corpus-vs-Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Wave-0 spec-QA gate audit of PRD-013 (index + 013a/013b/013c) against the Nectar knowledge corpus and the real Honeycomb code it cites, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass — PRD-013's implementation lands out-of-band in the `honeycomb` repo (it extends honeycomb's fused recall); no honeycomb code was modified by this audit. Matches the bar and format of [`prd-005-hive-graph-catalog-tables-qa.md`](../../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md). Every acceptance criterion and load-bearing claim was traced to [`data/recall-integration.md`](../../../../knowledge/private/data/recall-integration.md) (the authoritative integration spec), [`PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md) decision #17, [`PRD-003-016-DEPENDENCY-MAP.md`](../../../PRD-003-016-DEPENDENCY-MAP.md), and the real files under `honeycomb/src/daemon/`.

**Related:**
- [`prd-013-recall-arm-hive-graph-index.md`](../prd-013-recall-arm-hive-graph-index.md)
- [`../../../../knowledge/private/data/recall-integration.md`](../../../../knowledge/private/data/recall-integration.md)
- [`../../../PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md)
- [`../../../PRD-003-016-DEPENDENCY-MAP.md`](../../../PRD-003-016-DEPENDENCY-MAP.md)
- [`../../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md`](../../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md)

---

## 1. Summary

PRD-013 is the load-bearing agent-facing integration and the most heavily code-cited module in the backlog. Its spec substance is excellent to a degree beyond the ordinary bar: every one of the roughly 30 cited Honeycomb symbols and line ranges (`RecallSource`, `readSource`, `ARM_CLASS_WEIGHT`, `kindOfSource`, the three arm builders, `fuseHits`, `SEMANTIC_ARMS`, `SemanticArmSpec`, `runSemanticArm(s)`, `embeddingColumnFor`, `idColumnFor`, `runArm`, `projectConjunctFor`, `buildProjectScopeConjunct`, `EMBEDDING_DIMS`, `assertEmbeddingDim`, the `Promise.all`/`arms` insertion points, and the two-branch `degraded` logic) was opened and verified against `honeycomb/src/daemon/runtime/memories/recall.ts`, `honeycomb/src/daemon/storage/vector.ts`, `honeycomb/src/daemon/storage/sql.ts`, and `honeycomb/src/daemon/runtime/recall/scope-clause.ts`, and matched **exactly**, down to the line, with a single exception (W-5 below). The SQL-safety floor (item 2 of this audit's scope) is fully conformant: every identifier routes through `sqlIdent`, the search term through `sqlLike`, the `MAX(seq)` latest-per-nectar subquery and `describe_status = 'described'` filter are present, the `project_id` conjunct threads through the shared `buildProjectScopeConjunct`, and the per-arm fail-soft contract (`runArm`/`runSemanticArm` swallow a non-`ok` result to `[]`) is verified against the actual (not the corpus's simplified) SQL shape. The module **PASSES with warnings** to the medium-and-above standard: there are **zero Critical findings** and **five Warnings** — four are documentation/cross-reference defects (all already remediated in this pass) and one is a genuine decision-conformance gap that is reported, not fixed: (W-1) PRD-013a asserts an operator-tunable `nectar_rrf_multiplier` per decision #17 but neither scopes an acceptance criterion for it nor reconciles it with `ARM_CLASS_WEIGHT` being a shared per-*kind* constant, and no such runtime-config mechanism exists anywhere in the honeycomb codebase today. (W-2) four `MASTER-PRD-INDEX.md` links used the wrong relative depth (fixed). (W-3) 22 honeycomb/scope-clause code citations were wrapped in non-resolving markdown links instead of plain backtick spans (fixed). (W-4) eight cross-links to PRD-005b/PRD-005c and PRD-014 used a stale `backlog/`-sibling path instead of the `completed/`/`in-work/` lifecycle folders those PRDs actually live in (fixed). (W-5) `resolveRecallLimit` was cited at the wrong line range — drifted-but-findable, now corrected. The PRD-009 folder-slug correction dated 2026-07-02 is confirmed live and correct; the dependency claims (HARD 005/014, SOFT data-presence 007/016, downstream 009) match `PRD-003-016-DEPENDENCY-MAP.md` verbatim; no invented DEFAULT values were found.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-013 index | PASS | PASS | PASS | PASS | WARNING (W-2, W-3, W-5) | PASS-with-warnings |
| PRD-013a | PASS | WARNING (W-1, W-5) | PASS | PASS | WARNING (W-2, W-3, W-4) | PASS-with-warnings |
| PRD-013b | PASS | PASS | PASS | PASS | WARNING (W-3, W-4) | PASS-with-warnings |
| PRD-013c | PASS | PASS | PASS | PASS | WARNING (W-3, W-4) | PASS-with-warnings |

## 3. Critical Issues (must fix)

None. Every cited honeycomb symbol exists; every cited line range is exact or (in one case) drifted-but-findable; the SQL-safety floor and the per-arm/per-embed fail-soft contracts are correctly specified; no fabricated values.

## 4. Warnings (should fix)

### W-1 (Correctness, 013a — REPORTED, not fixed): Decision #17's operator-tunable `nectar_rrf_multiplier` has no AC, design, or code path anywhere

[`PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md) decision #17 (locked) reads: *"Recall arm weight: `ARM_CLASS_WEIGHT` for hive_graph_versions = 1.0 (peer with distilled memory); operator-tunable via `nectar_rrf_multiplier` at runtime."* PRD-013a's "Weight `1.0`" section (`prd-013a-lexical-arm-builder-and-weight.md:87-89`) narrates the second half of that decision as if it already exists: *"an operator who finds Nectar hits dominating recall at the expense of session memory lowers the class via `~/.honeycomb/nectar.json` (`recall.nectar_rrf_multiplier`)."* This mechanism does not exist:

- A repo-wide search of `honeycomb/src` for `nectar_rrf_multiplier` and `nectar.json` returns **zero** matches — there is no code anywhere that reads such a key.
- `ARM_CLASS_WEIGHT` (`recall.ts:158-161`) is a single `Readonly<Record<RecallKind, number>>` keyed by the two-member `RecallKind` (`"memory" | "session"`), shared by every distilled arm. There is no per-`RecallSource` override seam today.
- PRD-013a's own prose acknowledges the tension in the very same paragraph: *"the weight is currently a per-`kind` constant, not per-`source`; introducing a distinct `hive_graph_versions` weight distinct from the distilled `memory` weight would require a `source`-keyed map (a wider change than this arm) — the default treats them as one distilled class."*
- The referenced config file, `~/.honeycomb/nectar.json`, is documented elsewhere in `PRD-DECISIONS-AND-DEFAULTS.md` §B as **nectar's own** daemon config (PRD-002), a separate process from the honeycomb daemon per ADR-0002's independent-daemon topology. No PRD (in either repo) describes a mechanism by which the honeycomb daemon's `recall.ts` would read a config file that belongs to a different, independently-supervised daemon's home directory.

Impact: an implementer building PRD-013a to its stated Acceptance Criteria (none of which mention `nectar_rrf_multiplier`) ships a correct arm at the fixed `1.0` weight, but decision #17's "operator-tunable at runtime" half is left unimplemented and undesigned, with no AC anywhere in the PRD-013 module that would catch the gap. This is a plan-vs-decision-ledger completeness gap, not a code defect (no code exists yet), so it does not block the arm from working correctly at its stated default — hence Warning, not Critical.

**This is a substantive disagreement between the PRD and the decision it is supposed to fully apply — reported per the remediation policy, not fixed.** Recommended resolution (for the PRD author, not this audit): either (a) add an explicit Non-Goal stating the multiplier mechanism is deferred to a future PRD and strike or soften the "operator... lowers the class via `nectar_rrf_multiplier`" prose to describe it as aspirational/future rather than an existing lever, or (b) add a Goal + AC that actually scopes the config-read mechanism (which cross-daemon config file, which process reads it, at what cadence) before this sub-PRD enters implementation.

### W-2 (Detrimental Patterns, index + 013a — FIXED): `MASTER-PRD-INDEX.md` links used the wrong relative depth

Four links used `../../../MASTER-PRD-INDEX.md`. From a file in `backlog/prd-013-recall-arm-hive-graph/`, three `../` levels resolve to `library/`, so the target was `library/MASTER-PRD-INDEX.md`, which does not exist — the file lives at `library/requirements/MASTER-PRD-INDEX.md` (two levels up). The same files correctly used two levels elsewhere in the very same document (e.g. the index's own Related section), confirming this was a per-occurrence depth slip, not a whole-file convention error. Same defect class as W-2 in the PRD-005 QA report.

Locations (now fixed): `prd-013-recall-arm-hive-graph-index.md:10, 12`; `prd-013a-lexical-arm-builder-and-weight.md:29, 197`.

**Remediation applied:** `](../../../MASTER-PRD-INDEX.md)` → `](../../MASTER-PRD-INDEX.md)` at all four sites. Re-verified: `grep -rn "\.\./\.\./\.\./MASTER-PRD-INDEX" *.md` now returns zero.

### W-3 (Detrimental Patterns, all four files — FIXED): honeycomb/scope-clause code references as non-resolving markdown links

Every PRD-013 file cites honeycomb code in its body with the canonical backtick file-path span (e.g. `` `recall.ts:319-337` ``), but every file's **Related** section wrapped the full-form span in a markdown link whose target was `../../../../honeycomb/...`. From `backlog/prd-013-recall-arm-hive-graph/`, four `../` levels resolve to the `nectar` repo root, so the target was `nectar/honeycomb/...` — honeycomb is a sibling repo under `the-apiary/`, not a subdirectory of `nectar/`, so the link never resolved. This is the same systemic pattern as W-3 in the PRD-005 QA report (Documentation Framework §6 / `AGENTS.md` require cross-repo code as a backtick span, never a markdown link).

Token counts (all `honeycomb/src/...`; one `honeycomb/src/daemon/runtime/recall/scope-clause.ts` in 013a):

| File | Broken link tokens | Lines |
|---|---|---|
| `prd-013-recall-arm-hive-graph-index.md` | 6 | 71-76 |
| `prd-013a-lexical-arm-builder-and-weight.md` | 6 | 11, 198, 199, 200, 201, 202 |
| `prd-013b-semantic-arm-over-embedding.md` | 5 | 138, 139, 140, 141, 142 |
| `prd-013c-graceful-bm25-fallback.md` | 5 | 85, 86, 87, 88, 89 |
| **Total** | **22** | |

**Remediation applied:** every markdown-link wrapper around a full-form `honeycomb/...` backtick span was dropped, keeping only the backtick span (identical recipe to the PRD-005 remediation). Re-verified: `grep -rnE "\]\([./]*honeycomb[^)]*\)" *.md` now returns zero.

### W-4 (Detrimental Patterns, 013a/013b/013c — FIXED): lifecycle-stale sibling links to PRD-005b/c and PRD-014

Eight links to PRD-005b, PRD-005c, and PRD-014 used a `../prd-00X-.../` sibling-folder path, which assumes those PRDs still live in `backlog/` alongside PRD-013. Per `PRD-003-016-DEPENDENCY-MAP.md` §3, PRD-005 moved to `completed/` and PRD-014 moved to `in-work/` on 2026-07-02 (lifecycle-equals-location). The index file (`prd-013-recall-arm-hive-graph-index.md:67-69`) already used the correct `../../completed/...` / `../../in-work/...` prefixes; the three sub-PRD files did not, so the same document set was internally inconsistent about where its own dependencies live.

Locations (now fixed):
- `prd-013a-lexical-arm-builder-and-weight.md:136, 194` → PRD-005b; `:195` → PRD-005c.
- `prd-013b-semantic-arm-over-embedding.md:30, 66, 135` → PRD-005b; `:136` → PRD-014 index.
- `prd-013c-graceful-bm25-fallback.md:83` → PRD-014c.

**Remediation applied:** `](../prd-005-hive-graph-catalog-tables/...)` → `](../../completed/prd-005-hive-graph-catalog-tables/...)` (6 sites); `](../prd-014-embeddings-provider-switching/...)` → `](../../in-work/prd-014-embeddings-provider-switching/...)` (2 sites). Re-verified against the actual folder layout (`ls backlog/ completed/ in-work/`): PRD-005 confirmed in `completed/`, PRD-014 confirmed in `in-work/`, PRD-009 confirmed in `backlog/` (its own sibling-style link was already correct and untouched).

### W-5 (Correctness, index + 013a — FIXED): `resolveRecallLimit` cited at the wrong line range

Three citations named the function `resolveRecallLimit` at `recall.ts:128-129`. The actual `resolveRecallLimit` function is at `recall.ts:303-308`; lines 128-129 are `DEFAULT_RECALL_LIMIT`'s doc-comment + declaration (the constant the function returns as its default, not the function itself), and `MAX_RECALL_LIMIT` (the function's ceiling) is a separate declaration at line 131, outside the cited range. This is drifted-but-findable per the audit's line-drift standard — the named symbol exists in the same file, just not where cited.

Locations (now fixed): `prd-013-recall-arm-hive-graph-index.md:23`; `prd-013a-lexical-arm-builder-and-weight.md:149, 199`.

**Remediation applied:** the two prose citations naming `resolveRecallLimit` now point to `recall.ts:303-308`; the combined Related-section citation list was widened from `128-129` to `129, 131, ..., 303-308` so it covers `DEFAULT_RECALL_LIMIT`, `MAX_RECALL_LIMIT`, and `resolveRecallLimit` explicitly. Re-verified: `grep -rn "128-129" *.md` now returns zero.

## 5. Suggestions (consider improving)

- **S-1 (code-health, 013a — FIXED):** `buildHiveGraphVersionsArmSql`'s code sketch (`prd-013a-lexical-arm-builder-and-weight.md:101-130`) declared `const pathCol = sqlIdent("path");` but never referenced `pathCol` anywhere in the returned SQL string (the actual projection is `source`/`id`/`text`/`created_at`, matching `rowsToRankedArm`'s four-column contract — `path` is not one of them). This was almost certainly inherited from the corpus's illustrative (explicitly "simplified") SQL in `recall-integration.md`, which does project `v.path AS path`. Dead code in a spec snippet is not a functional defect, but it would trip a Biome `noUnusedVariable`-class lint the moment it was copied into real TypeScript. **Remediation applied:** the unused declaration was removed; the rest of the snippet is untouched and still produces byte-identical SQL.
- **S-2 (citation precision, 013a/013b — not fixed, sub-medium):** two citation ranges cover only part of the named construct rather than the whole thing: (a) 013a's "within-arm `seen` set" is cited as `recall.ts:976-980`, but the `seen` declaration (`const seen = new Set<string>();`) is actually at line 975, one line before the cited range starts — the *usage* of `seen` is correctly within 976-980. (b) 013b's `fetchCandidateEmbeddings` is cited as `recall.ts:1096-1110`, which covers only the function signature and its id-bucketing loop; the function's full body (including the `Promise.all` batch fetch) extends to line 1131. Neither citation is wrong about where the construct *starts*, and both are trivially findable by reading a few lines further, so this is left as a Suggestion rather than a Warning and was not mechanically fixed (expanding a citation range is a judgment call about how much context to include, not an unambiguous corrected value the way a wrong-folder link or wrong-function line is).

## 6. Plan Item (AC) Traceability

### PRD-013 index (8 ACs)

| AC (index) | Corpus / code source | Verdict |
|---|---|---|
| `"hive_graph_versions"` is a member of `RecallSource` (`recall.ts:169`); `readSource` recognizes it | `recall.ts:169` (exact), `:385-389` (exact) | PASS |
| `buildHiveGraphVersionsArmSql` mirrors `buildMemoriesArmSql` | `recall.ts:319-337` (exact) | PASS |
| Lexical arm carries `MAX(seq)`, `describe_status='described'`, `project_id` conjunct | `recall-integration.md` § "The added guarded arm"; `scope-clause.ts:355-401` | PASS |
| `ARM_CLASS_WEIGHT` scores the arm as distilled `memory` | `recall.ts:158-161` (exact), `:164-166` (exact) | PASS; see W-1 for the unimplemented operator-tuning half of decision #17 |
| Arm runs in `Promise.all` + `arms` array; `fuseHits` dedups | `recall.ts:2096-2101, 2113-2118` (exact), `:403-457` (exact) | PASS |
| Injected `EmbedClient`, 768-dim → semantic-arm spec runs `<#>` cosine | `recall.ts:868-888` (exact), `storage/vector.ts:35` (exact) | PASS |
| Embeddings off → lexical arm alone, `degraded: true` | `recall.ts:1013, 2106` (exact) | PASS |
| Table absent → arm empty only, other arms still answer | `recall.ts:826-842` (exact) | PASS |

### PRD-013a lexical arm (7 ACs)

| AC (013a) | Source | Verdict |
|---|---|---|
| `RecallSource` union member; `readSource` returns it, not `"sessions"` | `recall.ts:169, 385-389` | PASS |
| Builder mirrors `buildMemoriesArmSql`: `sqlIdent`/`sqlLike`/bare-numeric `LIMIT`; projects `source`/`id`/`text`/`created_at` | `recall.ts:319-337`; `sql.ts:42-105` (guard helpers) | PASS |
| `MAX(seq)` + `describe_status='described'` + `project_id` conjunct matches the corpus SQL shape | `recall-integration.md` § "The added guarded arm" | PASS (functionally equivalent to the corpus's simplified SQL; the outer `v.seq = latest.max_seq` join transitively enforces `describe_status='described'` on `v` since `seq` is unique per nectar) |
| Every column exists in the PRD-005b DDL | `prd-005b-hive-graph-versions-table.md:35-58` (verbatim DDL) | PASS — `nectar`, `seq`, `title`, `description`, `concepts`, `describe_status`, `described_at` all present |
| `kindOfSource("hive_graph_versions")` → `"memory"`, no code change needed; RRF contribution `1.0/(60+rank)` | `recall.ts:141` (`RRF_K`), `:158-161`, `:164-166` (all exact) | PASS; weight value correct, tunability mechanism gap is W-1 |
| Runs in `Promise.all` + `arms` array; `fuseHits` dedups by `source+id` | `recall.ts:2096-2101, 2113-2118, 403-457` (exact) | PASS |
| Table absent → `runArm` returns `[]` for this arm only | `recall.ts:826-842` (exact) | PASS |

### PRD-013b semantic arm (7 ACs)

| AC (013b) | Source | Verdict |
|---|---|---|
| `SEMANTIC_ARMS` entry with correct table/idColumn/embeddingColumn/textColumn/timestampColumn/hydrateFilter | `recall.ts:868-888` (exact); columns verified against `prd-005b` DDL | PASS |
| `SemanticArmSpec.source` type widened to include the new source | `recall.ts:852` (exact) | PASS — current type is `Extract<RecallSource, "memories" \| "sessions">`, confirmed needs widening exactly as specified |
| Injected `EmbedClient`, 768-dim → `runSemanticArm` runs `<#>` via `vectorSearch` | `recall.ts:925-984` (exact), `:943-953` (exact pool.run call) | PASS |
| Non-768 vector short-circuits to `null` before the arm runs | `recall.ts:1025` (exact) | PASS |
| `embeddingColumnFor` → `"embedding"`; `idColumnFor` → `"nectar"` | `recall.ts:1041-1045` (exact), `:1073-1075` (exact) | PASS — both proposed edits are valid, minimal, and consistent with the existing ternary-to-if/if/return restructuring shown |
| Semantic + lexical hits fuse into one `source+nectar` dedup; within-arm `seen` set collapses duplicate version-row matches | `recall.ts:403-457` (exact), `:975-980` (see S-2, `seen` declared at 975 not 976) | PASS |
| Missing embedding column / query error → `runSemanticArm` returns `[]` for this arm only | `recall.ts:955-959` (exact) | PASS |

### PRD-013c graceful fallback (7 ACs)

| AC (013c) | Source | Verdict |
|---|---|---|
| No `EmbedClient` → lexical runs, semantic contributes nothing, `degraded: true` | `recall.ts:1013` (exact), `:2106` (exact) | PASS |
| Embed returns null → lexical-only, no exception propagates | `recall.ts:1017-1022` (exact) | PASS |
| Non-768 vector → whole semantic path short-circuits to `null` | `recall.ts:1025` (exact) | PASS |
| `recallMode === "keyword"` → semantic skipped by intent, `degraded: false` | `recall.ts:2084, 2097, 2106` (all exact) | PASS |
| Table absent → `runArm` returns `[]`, recall returns 200 not 500 | `recall.ts:826-842` (exact), `:2044-2047` (within the cited comment block) | PASS |
| Embedding column missing/query error → `runSemanticArm` returns `[]` for this arm only | `recall.ts:955-959` (exact) | PASS |
| Lexical-only recall surfaces matching described files, no quality cliff | `recall-integration.md` § "Fusion with the other arms" | PASS |

## 7. Decision and dependency conformance (audit scope items 3-4)

- **Decision #17 (`ARM_CLASS_WEIGHT` = 1.0, peer with distilled memory):** the `1.0` value and its "peer with distilled memory" framing are correctly applied (`prd-013a-lexical-arm-builder-and-weight.md:79-89`), matching `recall.ts:158-161` exactly. **The PRD does not contradict decision #17's value; it under-specifies decision #17's tunability clause** — see W-1.
- **PRD-009 slug (corrected 2026-07-02):** confirmed. `prd-013-recall-arm-hive-graph-index.md:70` links `../prd-009-harness-exposure-via-recall/prd-009-harness-exposure-via-recall-index.md`, which resolves to the real folder (`backlog/prd-009-harness-exposure-via-recall/`, confirmed on disk). `PRD-003-016-DEPENDENCY-MAP.md` D-8 independently confirms this correction as RESOLVED.
- **Lifecycle-stale link sweep (001-006 in `completed/`, 010/011/014/017 in `in-work/`):** PRD-013's only in-set cross-links to that population are PRD-005 (→ `completed/`) and PRD-014 (→ `in-work/`); both were stale in the sub-PRD files and are now fixed (W-4). No links to PRD-001/002/003/004/006/010/011/017 exist in this module.
- **Documentation-framework conformance:** backtick code-ref convention now holds with zero non-resolving markdown-link wrappers (W-3, fixed); no invented DEFAULT values (both flagged defaults — `ARM_CLASS_WEIGHT = 1.0` and the per-arm `LIMIT` — match `PRD-DECISIONS-AND-DEFAULTS.md` §B "Recall arm (PRD-013)" verbatim).
- **Dependency claims vs. `PRD-003-016-DEPENDENCY-MAP.md` §4/§5:** PRD-013's Non-Goals/Related sections correctly reflect HARD deps on PRD-005 (table) and PRD-014 (768-dim vector), SOFT data-presence deps on PRD-007/PRD-016 (real hits need brooded/enriched rows — PRD-013 does not claim this as a build gate, only an end-to-end-value note, matching the map's "the arm code needs only the table to pass its fail-soft ACs" framing), and the downstream HARD dependent PRD-009. No discrepancy found.

## 8. Files Audited

- `prd-013-recall-arm-hive-graph-index.md` — audited and remediated (W-2, W-3, W-5).
- `prd-013a-lexical-arm-builder-and-weight.md` — audited and remediated (W-1 reported only; W-2, W-3, W-4, W-5, S-1 fixed).
- `prd-013b-semantic-arm-over-embedding.md` — audited and remediated (W-3, W-4 fixed; S-2 reported only).
- `prd-013c-graceful-bm25-fallback.md` — audited and remediated (W-3, W-4 fixed).

No corpus file, no other PRD folder, and no honeycomb source file was modified by this audit — all reads of `honeycomb/src/**` and `library/knowledge/private/**` were read-only verification. Only files inside `prd-013-recall-arm-hive-graph/` were edited, per the remediation policy.

**Overall verdict (as-audited, pre-remediation): PASS-with-warnings** (medium-and-above). Zero Critical findings. Five Warnings: four mechanical documentation defects (W-2 broken `MASTER-PRD-INDEX.md` links, W-3 22 honeycomb/scope-clause code refs as non-resolving markdown links, W-4 8 lifecycle-stale PRD-005/PRD-014 links, W-5 a drifted `resolveRecallLimit` line citation) and one substantive decision-conformance gap (W-1, the unimplemented `nectar_rrf_multiplier` operator-tuning mechanism from decision #17) that is reported, not fixed, per the remediation policy. All ~30 cited honeycomb symbol/line pairs were opened and verified; 29/29 ACs across the four files trace cleanly to real, existing code or to the authoritative corpus doc with no fabricated values.

**Post-remediation verdict: PASS (clean at medium-and-above), one open item.** W-2, W-3, W-4, W-5, and S-1 are remediated in place inside this pass (see the remediation log below). W-1 and S-2 remain open by design — W-1 requires a PRD-authoring decision (scope the multiplier mechanism or defer it explicitly) that is outside this Bee's remit; S-2 is sub-medium and does not block anything.

---

## 9. Remediation log (this pass, 2026-07-02)

All fixes were applied in place inside `prd-013-recall-arm-hive-graph/`; no corpus, no other PRD folder, and no honeycomb file was touched.

| Finding | Sev | Resolution |
|---|---|---|
| W-2 | Medium | 4 occurrences of `](../../../MASTER-PRD-INDEX.md)` corrected to `](../../MASTER-PRD-INDEX.md)` across the index and 013a. |
| W-3 | Medium | 22 honeycomb/scope-clause markdown-link wrappers unwrapped to plain backtick spans across all four files (index 6, 013a 6, 013b 5, 013c 5). |
| W-4 | Medium | 8 stale `../prd-005-hive-graph-catalog-tables/...` and `../prd-014-embeddings-provider-switching/...` sibling links corrected to `../../completed/...` (6×, PRD-005b/c) and `../../in-work/...` (2×, PRD-014) across 013a/013b/013c. |
| W-5 | Medium | 3 occurrences of the `resolveRecallLimit` citation corrected from `recall.ts:128-129` to `recall.ts:303-308` (or widened to `129, 131, ..., 303-308` in the combined Related-section list) in the index and 013a. |
| S-1 | Sub-medium | Removed the unused `pathCol` declaration from the `buildHiveGraphVersionsArmSql` code sketch in 013a; the SQL output is unchanged. |
| W-1 | Medium | **Not fixed — reported.** Requires a PRD-authoring decision on how (or whether) to scope the `nectar_rrf_multiplier` mechanism; recorded for `library-worker-bee` / the PRD author. |
| S-2 | Sub-medium | **Not fixed — reported.** Two citation ranges cover the start but not the full extent of the named construct; left as a documented note rather than a judgment-call expansion. |

**Verification:** `grep -rn "\.\./\.\./\.\./MASTER-PRD-INDEX"`, `grep -rnE "\]\([./]*honeycomb[^)]*\)"`, `grep -rnE "\]\(\.\./prd-005-hive-graph-catalog-tables|\.\./prd-014-embeddings-provider-switching[^)]*\)"`, `grep -rn "128-129"`, and `grep -rn "pathCol"` all return zero across the four PRD-013 files post-remediation.
