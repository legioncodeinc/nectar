# QA Report: PRD-009 Harness Exposure via Recall Extension (PRD-vs-Corpus-vs-Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Wave-0 spec-QA gate audit of PRD-009 (index + 009a) against the Nectar knowledge corpus and the real Honeycomb code it cites, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass: PRD-009 is a documentation-only PRD (it ships no code by design), so the audit's whole substance is whether its recorded decision, per-harness mapping, and tenancy invariant are true against `honeycomb/src/**` and the corpus. Matches the bar and format of [`prd-013-recall-arm-hive-graph-qa.md`](../../../in-work/prd-013-recall-arm-hive-graph/qa/prd-013-recall-arm-hive-graph-qa.md). Every acceptance criterion and load-bearing claim was traced to the honeycomb source (`honeycomb/src/daemon/runtime/memories/recall.ts`, `honeycomb/src/daemon/runtime/memories/api.ts`, `honeycomb/src/daemon/runtime/server.ts`, `honeycomb/src/daemon/runtime/capture/`, `honeycomb/src/connectors/`, `honeycomb/harnesses/`, `honeycomb/mcp/src/`), to [`PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md) decisions #7, #17, #21, #35, #38, and to the corpus at [`ADR-0002`](../../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md) and [`recall-integration.md`](../../../../knowledge/private/data/recall-integration.md).

**Related:**
- [`prd-009-harness-exposure-via-recall-index.md`](../prd-009-harness-exposure-via-recall-index.md)
- [`prd-009a-decision-record-and-propagation-verification.md`](../prd-009a-decision-record-and-propagation-verification.md)
- [`../../../PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md)
- [`../../../MASTER-PRD-INDEX.md`](../../../MASTER-PRD-INDEX.md)
- [`../../../in-work/prd-013-recall-arm-hive-graph/qa/prd-013-recall-arm-hive-graph-qa.md`](../../../in-work/prd-013-recall-arm-hive-graph/qa/prd-013-recall-arm-hive-graph-qa.md)

---

## 1. Summary

PRD-009's strategic substance is sound and verified: the "no nectar-side hooks" decision is recorded verbatim from `MASTER-PRD-INDEX.md` recorded decision #1 (quote confirmed exact against `MASTER-PRD-INDEX.md:235`), conforms to locked decision #7 (extend Honeycomb recall, no own hooks), and the connector/hook-config half of the per-harness mapping is impeccable: every connector citation (`claude-code.ts:137-165`, `codex.ts:48-99` with seams `:66-68`/`:71-82`/`:91-93`, `cursor.ts:83-136` with seams `:101-103`/`:106-120`/`:123-126`), the Claude Code `hooks/hooks.json` event list, the `arms`-array insertion point (`recall.ts:2113-2118`), the `recallMemories` entry point (`recall.ts:2064`), the arm builders (`recall.ts:319-383`), the `projectConjunctFor` conjunct (`recall.ts:2089`, threaded at `:2096-2101`), and the `harnesses/{hermes,openclaw,pi}` claim were all opened and matched against the real honeycomb files. The tenancy-invariant section quotes `prd-001c` accurately and correctly attributes the silent-failure mode to ADR-0002 negative consequence #2 (verified: it is the second item of the Negative list). However, the module **FAILS** the medium-and-above gate on **one Critical finding**: the PRD's central propagation chain, repeated in the Overview, one Goal, AC-2(c), AC-3, both mapping-table recall columns, and two user-story acceptance lines, asserts that every harness reaches `recallMemories` because "the `/api/hooks` route's handler invokes `recallMemories` (`api.ts:537`)". That chain is false against the code: the `/api/hooks` group's three handlers (capture / context / session-end) never invoke `recallMemories`; `api.ts:537` sits inside the `POST /api/memories/recall` handler of the separate `/api/memories` route group, whose agent-facing consumers are the MCP tool surface and the CLI (C-1 below). The single-shared-engine conclusion survives (every recall consumer does funnel through `recallMemories`), but the mechanical chain the acceptance criteria enshrine cannot be verified truthfully as written, and in a PRD whose only deliverable is the accuracy of these claims, that blocks ship. Alongside C-1: one substantive decision-conformance Warning reported (W-1, the tenancy enforcement-mechanism prose contradicts decision #21 as locked) and four mechanical defect classes fixed in place (W-2 through W-5: 41 non-resolving markdown-link wrappers, 12 lifecycle-stale cross-PRD links, a 10-site `server.ts:77` line drift, and a wrong connector class name). No invented DEFAULT values and no filled deliberate spec gaps were found; decision #35 naming residue is zero.

## 2. Verdict Scorecard (per file)

| File | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-009 index | PASS | **CRITICAL (C-1)** | WARNING (W-1) | PASS | WARNING (W-3, W-4; fixed) | **FAIL** |
| PRD-009a | PASS | **CRITICAL (C-1)** | WARNING (W-1) | PASS | WARNING (W-2, W-3, W-4, W-5; fixed) | **FAIL** |

## 3. Critical Issues (must fix)

### C-1 (Correctness, index + 009a, REPORTED, not fixed): the `/api/hooks` → `recallMemories` chain does not exist in the honeycomb code

The PRD's load-bearing mechanical claim, stated in the index Overview (`prd-009-harness-exposure-via-recall-index.md:27`), Goal 3 (`:37`), AC-3 (`:67`), the API-changes section (`:81`), and in 009a's rationale (`prd-009a-decision-record-and-propagation-verification.md:42`), mapping-table column (c) for all three harnesses (`:60-62`), the "What the mapping proves" paragraph (`:66`), US-009a.1's first acceptance (`:95`), US-009a.2's acceptance (`:101`), and the Implementation notes (`:118-119`), is:

> each harness's hook bundle POSTs to honeycomb's session-protected `/api/hooks` route ... and that route's handler invokes `recallMemories` (`api.ts:537`)

Traced against the code, the chain breaks at the handler step:

- The `/api/hooks` route group (`honeycomb/src/daemon/runtime/server.ts:74`, `{ path: "/api/hooks", protect: true, session: true }`) mounts exactly three handlers: `/capture` (registered by the capture handler, `honeycomb/src/daemon/runtime/capture/capture-handler.ts:72` `HOOKS_GROUP = "/api/hooks"`), plus `/context` and `/session-end` (`honeycomb/src/daemon/runtime/capture/attach.ts:172-173`). A repo search of `capture-handler.ts` and `attach.ts` for `recallMemories` returns **zero** matches; none of the three handlers invokes it.
- Worse for the claimed chain, the production `/api/hooks/context` handler is the **default empty-block renderer**: the composition root's `attachHooks` call (`honeycomb/src/daemon/runtime/assemble.ts:878-890`) passes no `contextHandler`, so `attach.ts:165` falls back to `defaultContextHandler` (`attach.ts:184`), which returns an empty context block.
- `api.ts:537` is real, but it lives inside the `POST /api/memories/recall` handler (`honeycomb/src/daemon/runtime/memories/api.ts:506-537`), mounted under the **`/api/memories`** route group (`api.ts:85` `MEMORIES_GROUP = "/api/memories"`; `server.ts:72`), a different session-protected group than `/api/hooks`.
- The paths by which an agent's harness actually reaches `recallMemories` today: (a) the MCP tool surface, whose `memory_search` and search tools route to `POST /api/memories/recall` (`honeycomb/mcp/src/handlers.ts:173-176, 267-270`; `honeycomb/mcp/src/tools.ts:97`), and (b) the CLI recall command (`honeycomb/src/commands/storage-handlers.ts:38, 175`). The hook lifecycle's session-start memory injection travels through `GET /api/memories/prime` (`honeycomb/src/hooks/shared/prime-renderer.ts:43` `PRIME_PATH = "/api/memories/prime"`), the 046c prime digest, which does not call `recallMemories` either.

What survives: the strategic conclusion is still correct. Recall **is** a single shared engine; `recallMemories` is invoked at exactly one production call site (`api.ts:537`), and every agent-facing consumer (MCP tools, CLI, dashboard) funnels through it, so a new `hive_graph_versions` arm added at `recall.ts:2113-2118` does propagate to every armed harness with no per-harness change. The decision (#7, no nectar hooks) is unaffected. What is wrong is the specific transport chain the PRD both narrates and bakes into AC-2(c), AC-3, and two user-story acceptance lines: `/api/hooks` is the **capture/context/session-end** loopback, not the recall path, and a verifier executing AC-3 as written would be forced to certify a route-to-handler linkage the code does not contain.

**This is a substantive correctness defect in a documentation-only PRD whose deliverable is precisely these claims: reported per the remediation policy, not fixed.** Recommended resolution (for the PRD author): rewrite the chain at all twelve cited sites to the true topology, hook bundles POST captured events to `/api/hooks/*` (`server.ts:74`) while agents query recall through the MCP/CLI surfaces that POST `/api/memories/recall` (`server.ts:72` → `api.ts:537`), and re-anchor AC-2(c)/AC-3 on "single production `recallMemories` call site, shared by every consumer" rather than on the false `/api/hooks` → `recallMemories` handler linkage. The propagation thesis needs no weakening, only a truthful transport description.

## 4. Warnings (should fix)

### W-1 (Alignment, index + 009a, REPORTED, not fixed): tenancy enforcement-mechanism prose contradicts decision #21 as locked

[`PRD-DECISIONS-AND-DEFAULTS.md`](../../../PRD-DECISIONS-AND-DEFAULTS.md) decision #21 (locked) reads: *"Tenancy enforcement: doctor-mediated assertion — doctor gains a Deep Lake scope-comparison capability and refuses to supervise a daemon whose org/workspace scope mismatches another registered daemon's... PRD-004 must document doctor's new scope-awareness"* with application sites listed as **PRD-001c, 004, 009a**. But the PRD-009 text still describes the mechanism as an open default with three candidates:

- `prd-009a-decision-record-and-propagation-verification.md:86`: "...which also flags the **enforcement mechanism** as a default for PRD-002/PRD-003 to confirm (a bootstrap-time org-equality check, a shared config file, or a doctor-mediated assertion)."
- `prd-009-harness-exposure-via-recall-index.md:44` (Non-Goals): "PRD-001c states the contract and flags the mechanism as a default."
- `prd-009-harness-exposure-via-recall-index.md:87` (Open questions): "The tenancy-verification mechanism is a flagged default owned by PRD-001c."

The PRD faithfully mirrors its source (`prd-001c-shared-infra-consumption.md:87` still carries the same DEFAULT block, in `completed/`), so this is drift between the decision ledger and both documents rather than an invention by PRD-009. But #21 names 009a as an application site, and the mechanism is no longer a three-option default: it is the doctor-mediated assertion, and the deciding owner is doctor/PRD-004, not "PRD-002/PRD-003 to confirm". **Reported, not fixed**: rewording the enforcement-owner prose is a substantive PRD-authoring change, and the matching stale block in `prd-001c` is outside this audit's write scope. Recommended resolution: update the three PRD-009 sites to state the locked doctor-mediated assertion (citing decision #21) and flag `prd-001c:87` to the PRD author for the same edit.

### W-2 (Detrimental Patterns, 009a, FIXED): 41 honeycomb code references wrapped in non-resolving markdown links

Every honeycomb code citation in 009a's body, mapping table, and Implementation notes was wrapped in a markdown link targeting `../../../../honeycomb/...`. From `backlog/prd-009-harness-exposure-via-recall/`, four `../` levels resolve to the `nectar` repo root, so the target was `nectar/honeycomb/...`; honeycomb is a sibling repo under `the-apiary/`, not a subdirectory of `nectar/`, so none of the 41 links ever resolved. Same systemic pattern as W-3 in the PRD-013 QA report (cross-repo code must be a backtick span, never a markdown link). The index file already used plain backtick spans throughout (0 defects).

**Remediation applied:** all 41 markdown-link wrappers in 009a were unwrapped to their plain backtick spans; no span text was altered. Re-verified: `rg -c "\]\([./]*honeycomb" *.md` now returns zero.

### W-3 (Detrimental Patterns, index + 009a, FIXED): 12 lifecycle-stale sibling links to PRD-001, PRD-005, PRD-013

Twelve links to PRD-001c, PRD-005, and PRD-013 used `../prd-00X-.../` sibling-folder paths, assuming those PRDs still live in `backlog/` alongside PRD-009. Per the current lifecycle layout (verified on disk), PRD-001 and PRD-005 are in `completed/` and PRD-013 is in `in-work/`.

Locations (now fixed): `prd-009-harness-exposure-via-recall-index.md:94` (PRD-013), `:95` (PRD-001c), `:96` (PRD-005); `prd-009a-decision-record-and-propagation-verification.md:76, 78 (×2, PRD-001c + PRD-005), 86, 106, 123, 132` (PRD-001c), `:124, 131` (PRD-013).

**Remediation applied:** `](../prd-001-three-daemon-topology/...)` → `](../../completed/prd-001-three-daemon-topology/...)` (7 sites); `](../prd-005-hive-graph-catalog-tables/...)` → `](../../completed/prd-005-hive-graph-catalog-tables/...)` (2 sites); `](../prd-013-recall-arm-hive-graph/...)` → `](../../in-work/prd-013-recall-arm-hive-graph/...)` (3 sites). Re-verified with a full relative-link resolution scan over both files: zero broken links remain.

### W-4 (Correctness, index + 009a, FIXED): the `/api/hooks` route cited at `server.ts:77` (actual: `:74`)

Ten citations placed the `/api/hooks` route group entry at `server.ts:77`. The actual entry `{ path: "/api/hooks", protect: true, session: true }` is at `honeycomb/src/daemon/runtime/server.ts:74`; line 77 is the `/api/sources` entry. Drifted-but-findable (the named route exists in the same `ROUTE_GROUPS` array three lines up). Note this fix corrects only the coordinate; the substantive claim built on the route is C-1.

Locations (now fixed): `prd-009-harness-exposure-via-recall-index.md:27, 67, 81`; `prd-009a-decision-record-and-propagation-verification.md:42, 60, 61, 62, 95, 101, 118`.

**Remediation applied:** `server.ts:77` → `server.ts:74` at all 10 sites. Re-verified: `rg -c "server\.ts:77"` returns zero; `rg -c "server\.ts:74"` returns 3 (index) + 7 (009a).

### W-5 (Correctness, 009a, FIXED): wrong Claude Code connector class name

`prd-009a-decision-record-and-propagation-verification.md:60` named the connector `ClaudeConnector.install()`. The actual exported class is `ClaudeCodeConnector` (`honeycomb/src/connectors/claude-code.ts:106` `export class ClaudeCodeConnector extends HarnessConnector`); its `install()` at `:137-165` matches the cited range exactly.

**Remediation applied:** `ClaudeConnector.install()` → `ClaudeCodeConnector.install()`. Re-verified: `rg -n "ClaudeConnector"` returns zero.

## 5. Suggestions (consider improving)

- **S-1 (staleness, index, FIXED):** the Related entry for PRD-013 carried the parenthetical "*(PRD-013 is authored alongside this index; the folder is created by the PRD-013 authoring pass.)*", which described a state that no longer exists (PRD-013 is authored, QA'd, and in `in-work/`). **Remediation applied:** the stale parenthetical was removed; the link and description are unchanged.
- **S-2 (citation precision, index + 009a, not fixed, sub-medium):** two citation ranges cover the start but not the full extent of the named construct: (a) the index (`prd-009-harness-exposure-via-recall-index.md:27`) cites `recallMemories` as `recall.ts:2064-2119`, which covers the signature through the `fuseHits` call, but the function body (rerank, dedup, recency, staleness stages) extends to `recall.ts:2244`; (b) 009a's `CursorConnector` citation `cursor.ts:83-136` covers the class head plus the four seams it names, but the class continues past line 136 with the flat-shape overrides the real Cursor `hooks.json` contract requires. Neither is wrong about where the construct starts, and both are findable by reading on, so this is a Suggestion per the line-drift standard and was not mechanically fixed (expanding a range is a context-judgment call, not an unambiguous corrected value).

## 6. Plan Item (AC) Traceability

### PRD-009 index (5 module-level ACs)

| AC | Corpus / code source | Verdict |
|---|---|---|
| AC-1: decision record, present tense, no nectar hooks, exposure solely via PRD-013's arm, rationale grounded in shared-engine citation | 009a §"The decision record"; decision #1 quote verified verbatim against `MASTER-PRD-INDEX.md:235`; decision #7 in `PRD-DECISIONS-AND-DEFAULTS.md`; `recall.ts:2064` (exact) | PASS (present tense holds; the rationale paragraph's transport chain carries C-1) |
| AC-2: per-harness map of (a) connector, (b) hook-config seam, (c) the single `recallMemories` call site | (a) `claude-code.ts:137-165`, `codex.ts:48-99`, `cursor.ts:83-136` (all exact); (b) `harnesses/claude-code/hooks/hooks.json` (event list verified), `codex.ts:66-68`, `cursor.ts:101-103` (exact); (c) `recall.ts:2064` + `api.ts:537` are real coordinates, but the claimed "via `/api/hooks`" linkage is false | **FAIL (C-1)** (columns (a) and (b) PASS; column (c)'s route chain does not trace) |
| AC-3: cites `recall.ts:2113-2118` insertion point; states propagation because every harness reaches recall through `/api/hooks` → `recallMemories` | `recall.ts:2113-2118` (exact); the `/api/hooks` → `recallMemories` linkage contradicted by `capture-handler.ts:72`, `attach.ts:165-184`, `api.ts:85` | **FAIL (C-1)** (insertion point PASS; the "because" clause is untrue as written) |
| AC-4: states the tenancy invariant, cites PRD-001c as owner, names the silent failure mode | 009a §"The tenancy-scope invariant"; quote verified against `prd-001c-shared-infra-consumption.md:83`; ADR-0002 negative consequence #2 verified (second Negative item, `ADR-0002:71`); `recall.ts:2089` `projectConjunctFor` (exact) | PASS (enforcement-mechanism prose carries W-1) |
| AC-5: no code, no table, no TODO/OPEN QUESTION, no invented defaults | `rg -in "TODO\|OPEN QUESTION\|TBD\|FIXME"`: only the AC's own text and the "Open questions: None" headers; no DDL, no endpoint; no value stated for any deliberate gap (TLSH thresholds, symbol nectars, `review-matches` flags all untouched) | PASS |

### PRD-009a user stories (3)

| Acceptance line | Source | Verdict |
|---|---|---|
| US-009a.1 acc-1: three harnesses map to the same `recallMemories` call site via the same `/api/hooks` route | mapping table `:60-62`; the shared-call-site half is true (`api.ts:537` is the sole production invocation), the `/api/hooks` transport is false | **FAIL (C-1)** |
| US-009a.1 acc-2: cites `recall.ts:2113-2118`; no connector/hook-config/bundle change required | `recall.ts:2113-2118` (exact); connectors verified unchanged-by-design | PASS |
| US-009a.2 acc: decision record cites shared engine + one loopback route + rejected alternatives | `recall.ts:2064` (exact); three rejected alternatives present (`:48-50`) and consistent with ADR-0002's process boundary; the "one loopback route (`server.ts:74`)" framing carries C-1 | PASS-with-C-1-note |
| US-009a.3 acc: invariant stated (same org/workspace, `project_id` filter), PRD-001c cited as owner, silent-failure mode named | `prd-001c:83` (quote exact); `prd-005c` tenancy model; "zero rows, no error, no `degraded` flag" consistent with `recall.ts:2089` server-side filtering | PASS |

## 7. Decision and dependency conformance (audit scope items 3-4)

- **Decision #7 (extend Honeycomb recall, NO own hooks):** PRD-009 is the decision record for #7 and applies it correctly; the decision itself, the collapse from four implementation sub-PRDs to one documentation sub-PRD, and the rejected alternatives all match `MASTER-PRD-INDEX.md:111, 235` verbatim. Conformant (the transport narration defect is C-1, not a decision breach).
- **Decision #17 as amended (arm weight + `nectar_rrf_multiplier` mechanism):** PRD-009 correctly scopes the entire arm (weight, `RecallSource`, builder, insertion) out to PRD-013 (`prd-009-harness-exposure-via-recall-index.md:42`) and makes no weight or multiplier claim of its own. No conflict.
- **Decision #21 (tenancy enforcement, doctor-mediated assertion):** **non-conformant as written**; see W-1. The invariant statement itself (same org/workspace, `project_id` filter, silent failure) is correct and corpus-grounded; only the enforcement-mechanism prose lags the locked decision.
- **Decision #35 (rename):** clean. `rg -i "hivenectar|hivedoctor|source.graph|source_graph|SourceGraph|thehive"` returns zero across both PRD files; the ADR-0002 link targets the renamed `ADR-0002-nectar-independent-daemon-supervised-by-doctor.md` filename (verified on disk).
- **Decision #38 (env decoupling):** N/A-conformant. PRD-009 names no environment variable and requires no honeycomb-owned env; nothing to flag.
- **No invented DEFAULTs / no filled deliberate gaps:** confirmed. The PRD states no numeric default of its own, does not restate the tenancy mechanism default (it defers to the owner, though to the stale version of it, W-1), and touches none of the three deliberate corpus gaps.
- **Lifecycle-stale link sweep (001-006, 010, 011, 014, 017 in `completed/`; 007, 012, 013, 016 in `in-work/`):** PRD-009's in-set cross-links are PRD-001c, PRD-005 (both `completed/`), and PRD-013 (`in-work/`); all 12 were stale sibling links and are now fixed (W-3). No links to the other moved PRDs exist in this module.
- **Corpus links:** both corpus targets (`recall-integration.md`, `ADR-0002`) resolve at the correct `../../../../knowledge/private/` depth from the QA folder and `../../../knowledge/private/` from the PRD files (verified by resolution scan).

## 8. Files Audited

- `prd-009-harness-exposure-via-recall-index.md`, audited and remediated (W-3, W-4, S-1 fixed; C-1, W-1 reported).
- `prd-009a-decision-record-and-propagation-verification.md`, audited and remediated (W-2, W-3, W-4, W-5 fixed; C-1, W-1, S-2 reported).

No corpus file, no other PRD folder, and no honeycomb source file was modified by this audit; all reads of `honeycomb/src/**`, `honeycomb/mcp/**`, `honeycomb/harnesses/**`, and `library/knowledge/private/**` were read-only verification. Only files inside `prd-009-harness-exposure-via-recall/` were edited, per the remediation policy.

**Overall verdict (as-audited, pre-remediation): FAIL** (medium-and-above). One Critical: the `/api/hooks` → `recallMemories` transport chain baked into AC-2(c), AC-3, and both files' narrative does not exist in the honeycomb code (C-1). Five Warnings: one substantive decision-conformance lag (W-1, tenancy enforcement prose vs. locked decision #21, reported) and four mechanical defect classes (W-2 41 non-resolving honeycomb link wrappers, W-3 12 lifecycle-stale cross-PRD links, W-4 the 10-site `server.ts:77` drift, W-5 the wrong connector class name), all fixed in this pass.

**Verdict: FAIL (as audited) -> PASS after remediation (2026-07-02).** The mechanical floor was cleaned in the audit pass (every link resolves, every line citation is exact, naming residue zero), and the two open items have now been remediated by the PRD-author pass documented in section 10: C-1's propagation chain is rewritten to the true `/api/memories/recall` transport across all twelve sites (both acceptance criteria included), and W-1's tenancy prose is aligned to locked decision #21 (with the matching `prd-001c` block corrected under a dated editorial note). Every C-1 site now describes the true chain and every citation resolves against the honeycomb source; the propagation thesis (a single shared `recallMemories` call site every consumer funnels through) is code-verified and survives intact. The decision record, the connector/hook-config mapping, and the tenancy invariant are exact against the code and corpus.

---

## 9. Remediation log (this pass, 2026-07-02)

All fixes were applied in place inside `prd-009-harness-exposure-via-recall/`; no corpus, no other PRD folder, and no honeycomb file was touched.

| Finding | Sev | Resolution |
|---|---|---|
| C-1 | Critical | **Not fixed; reported.** The `/api/hooks` → `recallMemories` chain (12 sites incl. AC-2(c), AC-3, US-009a.1/2 acceptances) requires a substantive PRD-authoring rewrite to the true topology (`/api/hooks` = capture/context/session-end; recall = MCP/CLI → `POST /api/memories/recall` → `api.ts:537`). |
| W-1 | Medium | **Not fixed; reported.** Three sites describe the tenancy enforcement mechanism as an open three-option default; decision #21 locked the doctor-mediated assertion and names 009a as an application site. Requires PRD-author prose update here and in `prd-001c`. |
| W-2 | Medium | 41 markdown-link wrappers around honeycomb code references in 009a unwrapped to plain backtick spans. |
| W-3 | Medium | 12 stale sibling links corrected: 7× PRD-001c and 2× PRD-005 → `../../completed/...`, 3× PRD-013 → `../../in-work/...`, across both files. |
| W-4 | Medium | 10 occurrences of `server.ts:77` corrected to `server.ts:74` (the actual `/api/hooks` `ROUTE_GROUPS` entry) across both files. |
| W-5 | Medium | 1 occurrence of `ClaudeConnector.install()` corrected to `ClaudeCodeConnector.install()` (009a mapping table). |
| S-1 | Sub-medium | Removed the stale "(PRD-013 is authored alongside this index...)" parenthetical from the index Related section. |
| S-2 | Sub-medium | **Not fixed; reported.** Two partial-extent citation ranges (`recall.ts:2064-2119` for a function ending at `:2244`; `cursor.ts:83-136` for a class extending past `:136`) left as documented notes. |

**Verification:** post-remediation, `rg -c "\]\([./]*honeycomb" *.md`, `rg -c "server\.ts:77" *.md`, `rg -n "\]\(\.\./prd-0" *.md`, `rg -n "ClaudeConnector" *.md`, and `rg -ni "hivenectar|hivedoctor|source.graph|SourceGraph|thehive" *.md` all return zero across both PRD files, and a full relative-link resolution scan over both files reports zero broken targets.

---

## 10. Remediation applied (2026-07-02, PRD-author pass)

This section records the PRD-authoring remediation of the two open items (C-1, W-1) that the audit pass reported but did not fix. All edits stayed inside `prd-009-harness-exposure-via-recall/` plus the single matching `prd-001c` block (task C); no honeycomb source, no corpus, and no other PRD folder was modified. Every rewritten citation was re-verified read-only against the honeycomb source.

### C-1 (Critical, Correctness): RESOLVED

The false `/api/hooks` -> `recallMemories` chain was rewritten to the true transport at all twelve cited sites. The true chain now enshrined: `recallMemories` (`recall.ts:2064`) is invoked at exactly one production call site, the `POST /api/memories/recall` handler (`api.ts:537`) under the `/api/memories` route group (`server.ts:72`; `MEMORIES_GROUP`, `api.ts:85`); every agent-facing recall consumer funnels through it (MCP tools `memory_search`/`hivemind_search` at `mcp/src/handlers.ts:176,270` + `mcp/src/tools.ts:97`; the CLI `recall` verb at `src/commands/storage-handlers.ts:38,175`); session-start memory injection is the separate `GET /api/memories/prime` digest (`prime.ts:151`); and the `/api/hooks` group (`server.ts:74`) carries only capture/context/session-end (`capture-handler.ts:210`, `attach.ts:172-173`), none of which invokes `recallMemories`. The propagation thesis is unchanged and still code-verified: one arm added at `recall.ts:2113-2118` propagates to every consumer through the single call site.

Sites rewritten (12): index Overview (`:27`), Goal 3 (`:37`), AC-2(c) (`:66`), AC-3 (`:67`), API-changes (`:81`); 009a rationale (`:42`), mapping-table column (c) for Claude Code / Codex / Cursor (3 rows), US-009a.1 story + acceptance (`:93`, `:95`), US-009a.2 acceptance (`:101`), Implementation notes (the `/api/hooks`/handler bullets). AC-2 text was tightened to name the true call site; column (b) (capture loopback) and the "What the mapping proves" paragraph were left intact because they were already true (hooks do carry captured events; column (c) identity still holds).

Verification greps (run in the PRD folder):
- `rg -n "via .?/api/hooks|/api/hooks.*→.*recallMemories" *.md` -> **0 false linkages** (the only `/api/hooks` mentions now explicitly state it does NOT invoke recall, plus one rejected-alternative line).
- `rg -c "server\.ts:72" *.md` -> **index 3, 009a 7** (the recall route group is now cited).
- `rg -n "server\.ts:74" *.md` -> all remaining hits are in the capture/context/session-end context only.
- New citations `api.ts:85`, `prime.ts:151`, `capture-handler.ts:210`, `attach.ts:172-173`, `mcp/src/handlers.ts:176,270`, `mcp/src/tools.ts:97`, `storage-handlers.ts:38,175` each verified against the honeycomb source.

### W-1 (Warning, Alignment): RESOLVED

The stale three-option tenancy default was replaced with the locked decision #21 posture (doctor-mediated assertion: doctor gains a Deep Lake scope-comparison capability and refuses to supervise a daemon whose org/workspace scope mismatches another registered daemon's; owned by doctor/PRD-004; application sites PRD-001c, 004, 009a) at all three PRD-009 sites (009a "Owner + enforcement" `:86`; index Non-Goals `:44`; index Open-questions `:87`), plus the matching Implementation-notes closing line in 009a (`:126`) for consistency. Per task C, the mirrored stale DEFAULT block in `prd-001c-shared-infra-consumption.md:87` was corrected to the same decision-#21 posture under a dated editorial note (`[2026-07-02: aligned to decision #21]`), changing nothing else in that file.

Verification greps:
- `rg -ni "three-option|PRD-002/PRD-003 to confirm|flags the mechanism as a default|flagged default" *.md` (PRD-009 folder) -> **0**.
- `rg -ni "bootstrap-time org-equality check, a shared config" prd-001c-shared-infra-consumption.md` -> **0** (block replaced).
- `rg -n "aligned to decision #21" prd-001c-shared-infra-consumption.md` -> **1** (the dated editorial note).

### Post-remediation verification (audit's own grep suite, re-run)

`rg -c "\]\([./]*honeycomb" *.md` -> 0; `rg -c "server\.ts:77" *.md` -> 0; `rg -n "\]\(\.\./prd-0" *.md` -> 0; `rg -n "ClaudeConnector" *.md` -> 0; `rg -ni "hivenectar|hivedoctor|source.graph|SourceGraph|thehive" *.md` -> 0. The mechanical floor remains clean and both substantive findings are closed.

**Post-remediation verdict: PASS (2026-07-02).**
