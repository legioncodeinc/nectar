# QA Report: PRD-007 Brooding Process (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Wave-0 corpus-conformance audit of PRD-007 (index + 007a/007b/007c/007d) against the Hivenectar knowledge corpus, the decisions ledger, and the dependency map, armed with quality-stinger + hivenectar-stinger. This is the spec-QA gate before implementation (wave plan Wave 0, blocker B-1): there is no implementation code for this PRD yet, so this audit verifies the DOCUMENT against its cited corpus sources, matching the bar and format of the PRD-005 and PRD-010 corpus-conformance reports. Every acceptance criterion and load-bearing claim was traced to `ai/brooding-pipeline.md` (the authoritative pipeline, buckets, prompts, and cost math), `ai/enricher-and-llm-model.md` (the `--force --model <new>` re-describe path), `PRD-DECISIONS-AND-DEFAULTS.md` (the locked decisions, especially #22), and `PRD-003-016-DEPENDENCY-MAP.md` (PRD-007's dependency profile).

**Related:**
- [`prd-007-brooding-process-index.md`](../prd-007-brooding-process-index.md)
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md)
- [`../../PRD-DECISIONS-AND-DEFAULTS.md`](../../PRD-DECISIONS-AND-DEFAULTS.md)
- [`../../PRD-003-016-DEPENDENCY-MAP.md`](../../PRD-003-016-DEPENDENCY-MAP.md)

---

## 1. Summary

PRD-007's pipeline substance is excellent: the discover→pre-check→bucket→describe→embed→persist→regenerate-projection order, the four buckets and their 4 KB / 100 KB / 256 KB thresholds, the batch/solo prompts, the resumability three-rule state machine, and the CLI surface (`brood`, `--force`, `--limit N`, `--dry-run`) all trace verbatim to `brooding-pipeline.md` and `enricher-and-llm-model.md` with zero hallucinated figures on the highest-risk numeric surface (the cost math: ~$3.05/2000 files = $0.65 input + $2.40 output, ~2.15M input tokens, ~318 calls; verified character-for-character). Every cited Honeycomb `file:line` span exists and is accurate, including two spans (`api.ts:247-248`, `api.ts:247-253`) that land exactly on the commented pipeline steps they claim to mirror. The module has **one open Critical**: PRD-007b (and the index's Defaults table) still register a fixed **`40`-file batch-size cap as a "DEFAULT — confirm before implementation,"** but decision #22 in `PRD-DECISIONS-AND-DEFAULTS.md`, dated the same review cycle and naming PRD-007b explicitly, already locked **DYNAMIC token-budget packing as superseding that fixed-40 default**; PRD-007b was never updated to reflect it, so an implementer confirming the "any value in 30-50" framing would build the wrong algorithm. This audit also found and **remediated in place** a large but purely mechanical defect class: 65 cross-PRD links assuming the pre-move `backlog/` location for PRD-002/005/006 (now `completed/`) and PRD-010/011/014 (now `in-work/`), 8 Honeycomb code references authored as non-resolving markdown links, and 2 further broken links (a fabricated in-repo path for a sibling-repo corpus doc, and a non-resolving stinger-guide path); all fixed and grep-verified at zero remaining. **Verdict: FAIL** (medium-and-above) on the one open Critical; the module would PASS cleanly once the batch-cap DEFAULT is reconciled with decision #22.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-007 index | PASS | PASS | PASS | PASS | WARNING (remediated: link-form + stale-slug + stinger-guide defects) | PASS |
| PRD-007a | PASS | PASS | PASS | PASS | WARNING (remediated: corpus-doc + link-form + stale-slug defects) | PASS |
| PRD-007b | PASS | **CRITICAL (C-1)** | PASS | PASS | WARNING (remediated: link-form + stale-slug defects); note N-1 | **FAIL** |
| PRD-007c | PASS | PASS | PASS | PASS | WARNING (remediated: stale-slug defects) | PASS |
| PRD-007d | PASS | PASS | PASS | PASS | WARNING (remediated: stale-slug defects) | PASS |

## 3. Critical Issues (must fix)

### C-1 (Correctness, 007b + index): the fixed `40`-file batch-size cap contradicts locked decision #22 (DYNAMIC packing)

`prd-007b-bucketing-and-llm-call-shapes.md:56-58` (section header `### Batch size cap *(DEFAULT — confirm before implementation)*`) registers `40` files as the batch-size cap and frames it as an open choice: "an implementation may choose any value in the 30–50 band as long as the `BATCH_TOTAL_SIZE` (100 KB) cumulative cap is also respected." The same value is restated at `prd-007b:19`, `:206`, and in the index's "Defaults registered in this PRD" table at `prd-007-brooding-process-index.md:78`.

`PRD-DECISIONS-AND-DEFAULTS.md` decision #22 (Section A, "Decisions locked (already applied across all PRDs)") reads: "Batch size: DYNAMIC — pack files until estimated context (input tokens) approaches the batch budget, capped by the 100KB cumulative (`BATCH_TOTAL_SIZE`) + a max-files safety ceiling (the corpus's 30-50 band). Adapts to actual file sizes rather than counting files; preserves the cost math. **Replaces the fixed-40 default** | PRD-007b." This decision names PRD-007b explicitly as its target and explicitly supersedes the exact subsection cited above, yet PRD-007b's text was never updated. `PRD-DECISIONS-AND-DEFAULTS.md`'s own "What's next" section (line 143) still lists "007 ... batch cap" among defaults "STILL OPEN," which is itself stale relative to decision #22's "already applied" claim: the decisions ledger and PRD-007b disagree with each other and with themselves.

Impact: this is not a numeric quibble within the 30–50 band. The locked decision changes the *algorithm* (pack by cumulative estimated token budget until the file-size cap is approached, not by counting a fixed number of files), while PRD-007b's current text invites an implementer to simply pick a single fixed number ("any value in the 30-50 band"). An implementer following PRD-007b as written would build a fixed-count batcher, which is the design decision #22 explicitly rejected. The 30–50-file band and the cost math table (unaffected either way, since ~40 files/call remains a valid *average* under dynamic packing at ~2 KB/file) are not in question; only the "pick one fixed number and treat it as the cap" framing is wrong.

**Suggested remediation (not applied, substantive, per audit scope):** Rewrite `prd-007b:56-58` to describe the DYNAMIC packing algorithm verbatim from decision #22 (pack files into a batch until the estimated input-token budget approaches the per-call target, capped by `BATCH_TOTAL_SIZE` (100 KB cumulative) and a max-files safety ceiling drawn from the corpus's 30-50 band), and drop the "DEFAULT — confirm before implementation" framing for a fixed count (the *algorithm* is now locked; only the safety-ceiling's exact number within 30-50, if any, remains a tunable). Mirror the same correction in the index's Defaults table (`:78`) and its cross-references at `prd-007b:19`, `:206`, and `prd-007d:177`. Separately (out of this PRD's remediation scope, flagged for the decisions-ledger owner): `PRD-DECISIONS-AND-DEFAULTS.md:143` should drop "batch cap" from its "STILL OPEN" list now that #22 has locked the algorithm, and its own §B "Brooding (PRD-007)" default line (`:70`, "Batch size cap: 40 files") should be corrected or removed to match #22.

## 4. Warnings (should fix): all remediated in this pass

None open. All Warning-tier findings from this audit were clear mechanical defects (stale lifecycle-folder cross-links, link-form Honeycomb code refs, a fabricated corpus-doc path, and a non-resolving stinger-guide link), permitted for in-place fix under this audit's remediation policy, and are recorded in Section 8 (Remediation Log) with verification. None remain open.

## 5. Suggestions (consider improving) and sub-medium notes

- **N-1 (Alignment, cosmetic, 007b + index):** the corpus's bucketing table spells the binary-detection threshold "First **8KB**" (no space, `brooding-pipeline.md:59`), but PRD-007b's Bucketing table (`:38`), Thresholds table (`:52`), and the index's AC-4 (`prd-007-brooding-process-index.md:60`) all render it "First **8 KB**" (with a space). The claimed sections state they are carried "verbatim" / "exactly," and this is a spacing normalization, not a value change (the threshold is still 8 KB either way); sub-medium, no functional impact. Consider matching the corpus's exact spacing (`8KB`) the next time this section is touched, or note the normalization explicitly.

## 6. Plan Item (AC) Traceability

### PRD-007 index (11 module ACs)

| AC (index) | Corpus / ledger source | Verdict |
|---|---|---|
| AC-1 fixed discover→pre-check→bucket→describe→embed→persist→regenerate-projection order, mirroring `runGraphBuild` at `api.ts:234-261` | `brooding-pipeline.md` "The pipeline"; `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` | PASS (span verified: contains the doc-comment + full `runGraphBuild` aggregate→finalize→persist→push body) |
| AC-2 discovery reuses `git ls-files --cached --others --exclude-standard -z` verbatim, honors `.gitignore`, manual walk fallback | `brooding-pipeline.md` "File discovery" | PASS |
| AC-3 `content_hash` match → inherit nectar + description, no LLM call; only non-matches enter bucketing | `brooding-pipeline.md` "File discovery" | PASS |
| AC-4 four buckets + thresholds match `brooding-pipeline.md` exactly | `brooding-pipeline.md` "Bucketing" table | PASS (note N-1: cosmetic "8KB"/"8 KB" spacing) |
| AC-5 cost math verbatim (~$3.05/2000 files, $0.65/$2.40, ~2.15M tokens, ~318 calls, ~$15/~$0.30 scaling) | `brooding-pipeline.md` "The cost math" | PASS (character-for-character match, see §7) |
| AC-6 batch call shape (title ≤80 chars + 1-3 sentence description + 1-5 concepts); solo call shape (3-5 sentence description + primary symbol) | `brooding-pipeline.md` "The batch call" / "The solo call" | PASS (system prompt reproduced verbatim in 007b) |
| AC-7 resumable via `describe_status`, no lockfile, no partial-state marker | `brooding-pipeline.md` "Resumability" | PASS |
| AC-8 `brood --dry-run` runs discovery + bucketing, prints estimate, no LLM call | `brooding-pipeline.md` "Triggering brooding" | PASS |
| AC-9 `brood --force` re-describes every non-skipped file; `brood --limit N` caps pending files brooded | `brooding-pipeline.md` "Triggering brooding" | PASS |
| AC-10 brooding does not block daemon readiness (ADR-0007 reference), runs once per project | `brooding-pipeline.md` "What brooding does not do" | PASS |
| AC-11 every Honeycomb `file:line` citation and corpus citation resolves; no hallucinated numbers | see §7, §8 | PASS as remediated (2 broken corpus-doc links, 8 link-form Honeycomb refs, 1 broken stinger-guide link, and 65 stale-lifecycle-slug cross-PRD links found and fixed in this pass; see §8) |

### PRD-007a discovery + content-hash pre-check (3 user stories)

| US | Corpus source | Verdict |
|---|---|---|
| US-007a.1 a fresh clone broods for $0 | `brooding-pipeline.md` "File discovery" (content-hash inheritance) | PASS |
| US-007a.2 a non-git directory still broods via manual walk fallback + shared `~/.honeycomb/graph-ignore.json` | `brooding-pipeline.md` "File discovery" | PASS |
| US-007a.3 discovery honors `.gitignore` via the exact `git ls-files` command | `brooding-pipeline.md` "File discovery" | PASS |

### PRD-007b bucketing + LLM call shapes (3 user stories)

| US | Corpus source | Verdict |
|---|---|---|
| US-007b.1 small files batched ~40/call (38 calls) collapsing per-file cost | `brooding-pipeline.md` "Bucketing" + cost table | PASS as an *illustrative average*; see C-1 for the batch-size-cap *default framing* defect |
| US-007b.2 binary/oversized files skip the LLM call but mint a nectar | `brooding-pipeline.md` "Bucketing" table | PASS |
| US-007b.3 a 2000-file brood costs ~$3.05 total, matching the budget contract | `brooding-pipeline.md` "The cost math" | PASS |

### PRD-007c resumability state machine (3 user stories)

| US | Corpus source | Verdict |
|---|---|---|
| US-007c.1 a killed brood resumes without lost work (skip/re-enqueue/discover-fresh) | `brooding-pipeline.md` "Resumability" | PASS |
| US-007c.2 a crash leaves no stale state blocking resume (no lockfile) | `brooding-pipeline.md` "Resumability" | PASS |
| US-007c.3 a `failed` description is re-enqueueable on the next `brood` | `brooding-pipeline.md` "Resumability"; 007b's malformed-entry fallback | PASS |

### PRD-007d CLI surface + dry-run (5 user stories)

| US | Corpus source | Verdict |
|---|---|---|
| US-007d.1 `--dry-run` previews bucket counts + cost with zero LLM calls | `brooding-pipeline.md` "Triggering brooding" | PASS |
| US-007d.2 `--limit N` caps pending files brooded per invocation | `brooding-pipeline.md` "Triggering brooding" | PASS |
| US-007d.3 `--force --model <new>` is the model-swap re-describe path | `enricher-and-llm-model.md`:143 (exact quote verified) | PASS |
| US-007d.4 brooding triggers automatically on a fresh project (no `source_graph` rows / no projection) | `brooding-pipeline.md` "Triggering brooding" | PASS |
| US-007d.5 `--force` (no model swap) re-describes every non-skipped file | `brooding-pipeline.md` "Triggering brooding" | PASS |

## 7. High-risk surfaces verified verbatim / against source

- **Four buckets + thresholds** (`BATCH_FILE_SIZE`=4 KB, `BATCH_TOTAL_SIZE`=100 KB, `MAX_DESCRIBE_SIZE`=256 KB, NUL-in-first-8KB binary detection): matches `brooding-pipeline.md:57-64` exactly (see N-1 for a cosmetic spacing nit).
- **Batch system prompt**: PRD-007b:69-75 reproduces `brooding-pipeline.md:70-77` character-for-character (title ≤80 chars / 1-3 sentence description / 1-5 concepts / JSON array in input order).
- **Cost math table** (2000-file breakdown): file counts (~200/~20/~1500/~280/2000), avg sizes (2 KB/20 KB), tokens/file (~500/~5000), calls (38/280/318), total input tokens (~750K/~1.4M/~2.15M) all match `brooding-pipeline.md:99-105` exactly.
- **Dollar figures**: $0.65 input (2.15M × $0.30/M), $2.40 output (~950K × $2.50/M), $0 embedding-by-default, $3.05 total, $15/10000-file, $0.30/200-file; all match `brooding-pipeline.md:109-116` exactly, including the pricing-tier rationale parenthetical.
- **Resumability quotes**: the three rules ("Files already brooded have `describe_status != 'pending'` and are skipped," etc.) match `brooding-pipeline.md:128-130` verbatim.
- **CLI command block**: all four `honeycomb hivenectar brood [flags]` invocations and their one-line comments match `brooding-pipeline.md:141-144` verbatim.
- **`--force --model <new>` citation**: `enricher-and-llm-model.md:143` states "An operator who swaps models and wants to re-describe everything runs `honeycomb hivenectar brood --force --model <new>`, which sets all non-skipped rows back to `pending`." Matches the PRD-007d:74/:82 citation exactly.
- **Honeycomb code citations** (all verified against `honeycomb/src/daemon/runtime/codebase/api.ts` and `honeycomb/src/daemon/storage/catalog/projects.ts` on disk):
  - `api.ts:234-261`: contains the `runGraphBuild` doc-comment + the full aggregate→finalize→persist→push body; matches the "discover→extract→persist composition" claim (with one extra step, the cloud push, not misleading).
  - `api.ts:247-248`: exactly the "1. Aggregate: discover → tree-sitter extract" comment + its statement; matches PRD-007a's specific claim with zero drift (unlike the analogous PRD-010 W-1 finding, no drift found here).
  - `api.ts:247-253`: exactly steps 1 (aggregate), 2 (finalize), 3 (persist); matches PRD-007b's "extract→finalize→persist" claim with zero drift.
  - `projects.ts:34-49`: the "Lazy-create + heal (D-6)" doc-comment (no DDL pre-step, `withHeal` + `buildCreateTableSql`); matches the "lazy-create + withHeal pattern" claim.
  - `projects.ts:152-218`: `PROJECTS_COLUMNS`, `PROJECTS_TABLES` (`defineGroup`, `update-or-insert`, `scope: "tenant"`); matches the "catalog-group registration" claim.
- **Dependency profile**: PRD-007's own Non-Goals correctly name all five HARD upstream deps (005 tables, 002 daemon/CLI, 010 Portkey, 014 embeddings, 011 projection) and the one SOFT dep (006 discovery reuse), matching `PRD-003-016-DEPENDENCY-MAP.md`'s PRD-007 profile exactly; no dependency mismatch found.
- **Locked-decision cross-references**: the index's "decision #3 lazy-create, #4 fs.watch mirror, #5 embeddings switch, #6 Portkey cache server-side" paraphrases all four correctly against `PRD-DECISIONS-AND-DEFAULTS.md` §A.

## 8. Remediation Log (mechanical defects fixed in this pass)

Per the audit's remediation policy, clear mechanical defects (stale lifecycle-folder link depths, link-form code refs) were fixed in place inside `prd-007-brooding-process/` only; no corpus file, other PRD folder, or `src/`/`test/` file was touched. All fixes verified by re-running the link-resolution scan below to zero remaining broken links.

| Finding | Files affected | Count | Fix |
|---|---|---|---|
| Stale lifecycle-folder cross-links: `../prd-002-hivenectar-daemon/` (now `completed/`) | index, 007c, 007d | 17 | Rewritten to `../../completed/prd-002-hivenectar-daemon/` |
| Stale lifecycle-folder cross-links: `../prd-005-source-graph-catalog-tables/` (now `completed/`) | index, 007a, 007b, 007c | 17 | Rewritten to `../../completed/prd-005-source-graph-catalog-tables/` |
| Stale lifecycle-folder cross-links: `../prd-006-file-registration-protocol/` (now `completed/`) | index, 007d | 5 | Rewritten to `../../completed/prd-006-file-registration-protocol/` |
| Stale lifecycle-folder cross-links: `../prd-010-portkey-gateway/` (now `in-work/`) | index, 007b, 007d | 11 | Rewritten to `../../in-work/prd-010-portkey-gateway/` |
| Stale lifecycle-folder cross-links: `../prd-011-portable-projection/` (now `in-work/`) | index, 007a, 007c, 007d | 9 | Rewritten to `../../in-work/prd-011-portable-projection/` |
| Stale lifecycle-folder cross-links: `../prd-014-embeddings-provider-switching/` (now `in-work/`) | index, 007b | 6 | Rewritten to `../../in-work/prd-014-embeddings-provider-switching/` |
| Honeycomb code refs authored as non-resolving markdown links (`](../../../../honeycomb/...)`), the systemic defect class from the PRD-001-004 and PRD-005 reports | index, 007a, 007b | 8 | Markdown-link wrapper dropped, kept as the plain backtick span (e.g. `` `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` ``) |
| Fabricated in-repo link to a sibling-repo corpus doc: `[`knowledge/private/data/codebase-graph.md`](../../../knowledge/private/data/codebase-graph.md)`; no such file exists in this repo's `library/knowledge/`. The file lives at `honeycomb/library/knowledge/private/data/codebase-graph.md` in the sibling Honeycomb repo, per `brooding-pipeline.md`'s "documented in the main corpus's `data/codebase-graph.md`" | 007a | 2 (`:134`, `:147`) | Converted to a plain-text cross-repo citation: `` `honeycomb/library/knowledge/private/data/codebase-graph.md` (the main Honeycomb corpus, not this repo's tree) `` |
| Non-resolving `hivenectar-stinger` guide link: `[...](../../../../../../.agents/skills/hivenectar-stinger/guides/00-principles.md)`; same class as the PRD-005 N-3 finding. The skill lives at `.cursor/skills/hivenectar-stinger/` in this monorepo, not `.agents/skills/` | index | 1 (`:82`) | Converted to a plain-text citation (link wrapper dropped, per the PRD-005 N-3 precedent) |

**Verification (re-run after remediation):**
- `grep -c '\](\.\./prd-00[256]-\|\](\.\./prd-01[014]-' *.md` inside the folder returns 0 for every stale-lifecycle-slug pattern.
- `grep -c '\](\.\./\.\./\.\./\.\./honeycomb' *.md` returns 0.
- An exhaustive resolve-check over every `](...)`-form relative markdown link in all 5 files (`realpath -m` against each target, checked for file existence) returns zero unresolved targets.
- `git diff --stat` for the folder shows exactly 64 line changes across all 5 files (32 insertions / 32 deletions net of the above, link-only edits; no prose, table, quote, or numeric content was altered).

No corpus file (`library/knowledge/`), no other PRD folder, and no `src/`/`test/` file was modified. C-1 (the batch-cap contradiction) was intentionally left unmodified per the "substantive findings are reported, not fixed" remediation policy.

## 9. Deliberate items preserved (NOT flagged as gaps)

- **Discovery-command DEFAULT** (`git ls-files --cached --others --exclude-standard -z`, PRD-007a) remains correctly open and unconfirmed. No locked decision supersedes it (unlike the batch-size cap), so its "DEFAULT — confirm before implementation" framing is accurate as written.
- **The three corpus-wide deliberate spec gaps** (TLSH confidence thresholds, symbol/directory nectars, `review-matches` sub-flag syntax) are correctly named as out-of-scope for PRD-007 (owned by PRD-006d and ADR-0001's v2 deferral) and no value is invented for any of them.
- **`describe_status` scope discipline**: PRD-007b correctly limits its "four valid terminal values a brood produces" to `described`/`failed`/`skipped-too-large`/`skipped-binary`, correctly excluding `skipped-deleted` (an enricher-only value per `enricher-and-llm-model.md`'s failure-modes table, since a file must exist to be discovered by a full-codebase brood) and `pending` (non-terminal). Verified against the corpus schema's full six-value enum at `data/source-graph-schema.md:109`.
- **`api.ts:234-261`'s extra scope**: the cited range includes one step (the 014c cloud push) beyond the "discover→extract→persist" composition the AC claims to mirror. This is over-inclusion, not misattribution: the composition being mirrored is genuinely present in the cited range, so it is not flagged as a citation defect.

## 10. Files Audited

- `prd-007-brooding-process-index.md`: audited; remediated (17+17+5+11+9+6 stale-slug links across all six targets it references, 3 link-form Honeycomb refs, 1 stinger-guide link). Carries C-1's Defaults-table restatement.
- `prd-007a-discovery-and-content-hash-precheck.md`: audited; remediated (stale-slug links to PRD-005/011, 3 link-form Honeycomb refs, 2 broken corpus-doc links).
- `prd-007b-bucketing-and-llm-call-shapes.md`: audited; remediated (stale-slug links to PRD-005/010/014, 2 link-form Honeycomb refs). Carries **C-1** (open, not remediated) and N-1.
- `prd-007c-resumability-state-machine.md`: audited; remediated (stale-slug links to PRD-002/005/011/016).
- `prd-007d-cli-surface-and-dry-run.md`: audited; remediated (stale-slug links to PRD-002/006/010/011). References C-1's default at `:177` but does not restate the value itself.

Only mechanical link defects inside `prd-007-brooding-process/` were fixed (Section 8). No corpus, other PRD folder, or code was modified. The `qa/` folder was created to hold this report.

**Overall verdict: FAIL** (medium-and-above), gated on the single open Critical (C-1: the fixed-40 batch-size-cap DEFAULT contradicts the locked, PRD-007b-targeted decision #22). Zero Warnings remain open (all were mechanical and remediated in this pass, see Section 8). One sub-medium Suggestion (N-1, cosmetic) does not affect the verdict. Once C-1 is resolved, by rewriting PRD-007b's batch-size-cap subsection (and the index's Defaults table) to describe DYNAMIC token-budget packing per decision #22 instead of a fixed default pending confirmation, PRD-007 would PASS cleanly at the medium-and-above standard: every other acceptance criterion, user story, cost figure, and code citation traces to its corpus source with no hallucination.

---

## Corpus-side and cross-PRD asks (for the driver / decisions-ledger owner, not this Bee's remediation scope)

1. **Resolve C-1** by updating PRD-007b (owning agent: `library-worker-bee`) to describe DYNAMIC batch packing per decision #22, and re-run this QA pass afterward.
2. **`PRD-DECISIONS-AND-DEFAULTS.md`** carries two stale references to the superseded fixed-40 default that should be reconciled with decision #22 in the same pass: §B's "Brooding (PRD-007)" line (`:70`, "Batch size cap: 40 files") and the "What's next" section's "STILL OPEN" list (`:143`, which still names "batch cap" as an open default for PRD-007 even though #22 claims it is "already applied").
3. **`PRD-003-016-DEPENDENCY-MAP.md`**'s PRD-007 profile (`:279`, "DEFAULT-confirm flags carried: ... batch size cap 40") carries the same stale value and should be updated once C-1 is resolved.

These three are outside this audit's remediation scope (they live outside `prd-007-brooding-process/`) and are surfaced here for the driver to route to the appropriate owning agent.

---

## Orchestrator remediation addendum (2026-07-02, the-smoker run)

**C-1 CLOSED.** The fixed-40 batch-size-cap DEFAULT was reconciled with locked decision #22 (dynamic token-budget packing, 100 KB cumulative cap, max-files safety ceiling within the corpus's 30-50 band) across: the index Defaults table row, PRD-007b's goal line, the "Batch packing" section (retitled LOCKED, no longer a confirm-flag), AC-012-style acceptance line, and the Open-questions note. The corpus's "~40 files/call" figures were preserved verbatim where they are the cost-math illustration. The two out-of-folder carriers of the stale value were fixed in the same pass: `PRD-DECISIONS-AND-DEFAULTS.md` section B (Brooding) and `PRD-003-016-DEPENDENCY-MAP.md` (PRD-007 profile flags line).

**Post-remediation verdict: PASS, clean at medium-and-above.**
