# Consolidated QA Report: PRD-001 to PRD-004 Corpus Conformance

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

A single consolidated audit of the first four Hivenectar PRD modules (PRD-001 through PRD-004, 20 files) against the knowledge corpus at `library/knowledge/private/`. Produced with quality-stinger + hivenectar-stinger as a PRD-vs-corpus conformance pass (there is no implementation code yet, so the audit verifies each acceptance criterion and load-bearing description against its cited corpus/code source rather than plan-vs-code). Runs after the refine pass and the docs-scoped security scan.

**Per-module reports:**
- [`prd-001 qa`](../backlog/prd-001-three-daemon-topology/qa/prd-001-three-daemon-topology-qa.md)
- [`prd-002 qa`](../backlog/prd-002-hivenectar-daemon/qa/prd-002-hivenectar-daemon-qa.md)
- [`prd-003 qa`](../backlog/prd-003-hivenectar-supervision/qa/prd-003-hivenectar-supervision-qa.md)
- [`prd-004 qa`](../backlog/prd-004-hivedoctor-registry-and-thehive/qa/prd-004-hivedoctor-registry-and-thehive-qa.md)

---

## 1. Summary

All four modules **PASS** to the medium-and-above standard. The PRDs are exceptionally well-grounded: every module acceptance criterion traces to a corpus doc or a Honeycomb code citation, the six locked MASTER-PRD-INDEX decisions and the ~26 PRD-DECISIONS decisions are honored, high-risk numeric surfaces (ports, `/health` shape, 768-dim, poll interval, cost example) are verbatim-accurate against the corpus, and every deliberate spec gap is preserved (no invented TLSH threshold, no `review-matches` sub-flag grammar, no symbol/directory nectars). One systemic Warning (honeycomb code references written as non-resolving markdown links) is documented and deferred by the refine-not-rewrite scope; a precise remediation recipe is below.

## 2. Verdict Scorecard (per module)

| Module | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-001 | PASS | PASS | PASS | PASS | WARNING (W-1) | PASS |
| PRD-002 | PASS | PASS | PASS | PASS | WARNING (W-1) | PASS |
| PRD-003 | PASS | PASS | PASS | PASS | WARNING (W-1) | PASS |
| PRD-004 | PASS | PASS | PASS | PASS | PASS | PASS |

## 3. Findings resolved in the refine pass (medium-and-above)

| ID | Module | Finding | Fix |
|---|---|---|---|
| R-1 | PRD-004 index | Corpus link to ADR-0002 used `../../knowledge/...` (one `../` short); resolved to a nonexistent `requirements/knowledge/...` path | Corrected to `../../../knowledge/...` |
| R-2 | PRD-004 index | Cross-PRD link to PRD-003 used stale folder slug `prd-003-hivedoctor-supervision-of-hivenectar/` | Corrected to `prd-003-hivenectar-supervision/` |
| R-3 | PRD-001a | `hivenoctor` typo (x3, lines 101/118/137) for the load-bearing `hivedoctor` component name | Corrected to `hivedoctor` |
| R-4 | PRD-001a, index | ADR-0003 treated as to-be-created with a proposed slug `three-daemon-topology`; the corpus already has `ADR-0003-three-daemon-topology-and-thehive-portal.md` (Status: Active) | Updated references to the created file; resolved the slug DEFAULT; aligned the prescribed status to the framework's `Active` |
| R-5 | PRD-001 (index, 001a), PRD-004 (index, 004c) | ADR-0004 and the corpus `thehive-portal-daemon.md` were uncited despite thehive being central | Added citations (index Related sections; 001a thehive-role; 004c design references) |
| R-6 | PRD-002, PRD-003, PRD-004 | Missing `qa/` subfolder required by the requirements README | Created `qa/` in each |

## 4. Open Warning (W-1): honeycomb code refs as non-resolving markdown links

**Severity:** Warning (should fix). **Status:** documented, deferred by the refine-not-rewrite scope.

**What:** PRD-001, PRD-002, and PRD-003 cite cross-repo Honeycomb code using markdown links whose visible text is a backtick span (e.g. `honeycomb/src/daemon/index.ts:166-187`) wrapped around a parenthesized relative target (e.g. `../../../../honeycomb/src/daemon/index.ts`). From the standalone `hivenectar` repo, a `../../../../honeycomb/...` target resolves to `hivenectar/honeycomb/...`, which does not exist (honeycomb is a sibling submodule under `the-hive/`, not a child of `hivenectar/`). Approximately 649 such link tokens exist across PRD-001/002/003.

**Why it is a finding:**
- The Documentation Framework (Canonical, section 6) states code is cited as a backtick file-path span (`` `src/path/file.ts:42` ``), not a markdown link.
- `AGENTS.md` reiterates: cross-repo code is a file-path backtick span.
- The corpus (`knowledge/private`, 0 link-form / 12 span-form) and PRD-005 already use the canonical backtick-span form. PRD-001/002/003 diverge from the rest of the repo; PRD-004's sub-PRDs already conform.

**Why deferred, not swept in this pass:**
- The correct remediation is nuanced, not a single blind unwrap. About half the link texts are short-form (e.g. `` `recall.ts:24-35` ``, `` `templates.ts` ``, `` `registry.tsx:91` ``) where the full path lives only in the link target; unwrapping them naively would lose path context. The compliant fix promotes the target path into the span, preserving the line range from the text.
- At ~649 instances this is rewrite-scale. The user selected "refine in place, not rewrite" for this cycle, and intended the worker bees (unavailable this run due to a platform billing block) to own this authoring.

**Recommended remediation (scoped follow-up, ideally library-worker-bee once unblocked):**
1. For each markdown link whose parenthesized target matches `.../honeycomb/...`: if the visible text is already a backtick span whose content starts with `honeycomb/` (full-form), drop the link wrapper and keep the span.
2. If the visible text is short-form, replace it with a backtick span built from the target path (with the `../../../../honeycomb/` prefix normalized to `honeycomb/`) plus the line range parsed from the original visible text.
3. Re-run the internal link audit (backtick spans are not links, so the count of link-form honeycomb refs should drop to zero) and a `git diff` review to confirm no non-honeycomb link was touched.
4. Apply the identical treatment to `hivedoctor/...` links (a sibling package inside the honeycomb submodule) which share the same non-resolving shape.

## 5. Corpus-side observations (out of edit scope)

These live in `library/knowledge/private/` and were not edited (the corpus is the read-only source of truth for this pass; the user declined pre-applying corpus edits). Flag for the corpus owner (knowledge-worker-bee):

- **C-1:** `ADR-0004-thehive-portal-daemon-role-and-boundaries.md` uses a non-standard header (`> **Status:** Accepted . **Date:** 2026-06-30`, middle-dot separators) and status `Accepted`, which is not in the Documentation Framework status set (Active/Draft/Archived/Canonical). ADR-0003 correctly uses the universal header with `Active`. Recommend aligning ADR-0004's header for internal consistency.
- **C-2 (informational):** The two known corpus/PRD disagreements recorded in `PRD-DECISIONS-AND-DEFAULTS.md` section C (the `confidence` column and the `skipped-deleted` enum) live in PRD-005/PRD-006 territory, not in PRD-001-004, so they are out of scope for this audit. They remain open corpus edits per that document.

## 6. High-risk surfaces verified verbatim against the corpus

- Ports: 3850 (honeycomb), 3851 (embeddings), 3852 (hivedoctor status), 3853 (thehive), 3854 (hivenectar) - consistent across all four modules, ADR-0004, and PRD-DECISIONS decision #12.
- `/health` body: PRD-001b's purpose-built shape matches PRD-DECISIONS decision #20 (revised).
- Embedding dimension 768 (PRD-001c) matches `enricher-and-llm-model.md` and the schema `FLOAT4[]` contract.
- Worker poll interval 30s (PRD-002b) matches `enricher-and-llm-model.md`.
- `/health` cost example ($3.05, 2,150,000 tokens in PRD-001b) matches `brooding-pipeline.md` cost math.
- Deliberate gaps preserved: TLSH threshold unpinned; `review-matches` sub-flag grammar not invented (PRD-002c); symbol/directory nectars out of scope.

## 7. Files in scope

20 PRD files audited across PRD-001 (index + a/b/c), PRD-002 (index + a/b/c/d), PRD-003 (index + a/b/c), PRD-004 (index + a/b/c/d). Changed in the refine pass: `prd-001-...-index.md`, `prd-001a-...md`, `prd-004-...-index.md`, `prd-004c-...md`, plus new `qa/` folders in PRD-002/003/004. The corpus (`library/knowledge/private/`) and PRD-005 through PRD-016 were not modified.

**Overall verdict: 4/4 modules PASS** (medium-and-above), with one systemic Warning (W-1) documented and deferred with a remediation recipe, and two corpus-side observations flagged for the corpus owner.
