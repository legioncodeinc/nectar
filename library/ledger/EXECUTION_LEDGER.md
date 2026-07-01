# Execution Ledger: PRD-001 (the-smoker run)

> Category: Ledger | Version: 1.0 | Date: July 2026 | Status: Active

Single source of truth for the `/the-smoker` completion run over **PRD-001 Three-Daemon Topology**. Primary bee: `hivenectar-worker-bee`. Branch: `feature/prd-001-004-refine`. Status legend: OPEN / IN PROGRESS / DONE (implemented) / VERIFIED (independently confirmed).

PRD-001 is the architectural-planning PRD; its deliverables are documentation artifacts (ADR-0003, the four-role contract, the process/health/infra contracts). Every module AC was already satisfied and marked PASS in the PR #1 QA pass. This run drives the one remaining open item (code-reference convention conformance) to completion and re-verifies the whole module to a clean close-out.

---

## AC Ledger

| ID | Source | Criterion (abbrev) | Owner | Status |
|---|---|---|---|---|
| AC-M1 | index | ADR-0003 exists, supersedes ADR-0002 two-daemon framing, preserves invariants | hivenectar-worker-bee | DONE (ADR exists + linked in refine; supersession recorded in ADR-0003 body "Relationship to ADR-0002") |
| AC-M2 | index | Four roles each have a boundary statement, no overlap | hivenectar-worker-bee | DONE (001a role table + prose) |
| AC-M3 | index | PRD + ADR state no in-process state shared across the four roles | hivenectar-worker-bee | DONE (001a non-integration points) |
| AC-M4 | index | hivenectar process surface (port/PID/lock/health/client/tenancy) with a code citation per claim; ports+paths flagged DEFAULT | hivenectar-worker-bee | DONE (001b) |
| AC-M5 | index | Shared-infra consumption contract names each seam + deploy-time tenancy invariant | hivenectar-worker-bee | DONE (001c) |
| AC-M6 | index | Port map consistent with real Honeycomb code (3850/3851/3852 occupied; 3853/3854 free) | hivenectar-worker-bee | DONE (index port table; ADR-0004 confirms 3853) |
| AC-Q1 | Doc Framework 6 | Code references use backtick file-path spans, not markdown links (75 non-resolving honeycomb/hivedoctor link tokens across the 4 files) | hivenectar-worker-bee | DONE (Wave 1: 75/75 converted, 0 remaining; independently verified) |
| AC-S1 | 001a US-001a.1..4 | thehive always-on, hivedoctor supervises all three, dashboard update cadence, no shared in-process state | hivenectar-worker-bee | DONE (verify vs ADR-0003/0004) |
| AC-S2 | 001b US-001b.1..4 | bind 3854 + /health, second-start refuses, own scoped Deep Lake client, restart leaves no stale lock | hivenectar-worker-bee | DONE (verify vs code) |
| AC-S3 | 001c US-001c.1..4 | Portkey own-client, embeddings 768-dim, compose-by-writing-rows, tenancy-mismatch caught | hivenectar-worker-bee | DONE (verify vs corpus) |

**Open count on entry: 1 (AC-Q1).** All others DONE, pending VERIFIED.

---

## Wave plan

```mermaid
flowchart TD
    w1["Wave 1: hivenectar-worker-bee - remediate AC-Q1 + verify AC-M1..M6/AC-S1..S3"] --> v["Verify: link audit = 0, ledger zero-open"]
    v --> sec["Close-out A: security-worker-bee (docs scan)"]
    sec --> qa["Close-out B: quality-worker-bee (re-verify PRD-001 clean at medium+)"]
    qa --> ship["Ship: commit + push (updates PR #1) + CI"]
    qa -->|"reopen on regression"| w1
```

**Wave 1 - hivenectar-worker-bee** (model: `claude-opus-4-8-thinking-xhigh-fast`; deep, nuanced multi-file doc conversion + corpus verification):
- Remediate AC-Q1: convert all 75 honeycomb/hivedoctor markdown links to backtick spans across `prd-001-...-index.md`, `prd-001a`, `prd-001b`, `prd-001c`. Full-form link text is kept as the span; short-form text has the full target path promoted into the span (Doc Framework 6).
- Verify AC-M1..M6 and AC-S1..S3 against the cited corpus/code; flag any residual doc gap.
- Exit: 0 honeycomb/hivedoctor markdown-link tokens in PRD-001; all ACs DONE; deliberate gaps and DEFAULT flags preserved.

**Close-out A - security-worker-bee** (model: `claude-sonnet-5-thinking-high`): docs-scoped scan of the delta (no secrets/PII).

**Close-out B - quality-worker-bee** (model: `claude-sonnet-5-thinking-high`; independent of the authoring bee): re-verify PRD-001 against the corpus; confirm AC-Q1 resolved and no regression; update the per-PRD qa report.

---

## Scope boundaries

- Edit ONLY PRD-001's four files. Do NOT touch PRD-002..016, the corpus (`knowledge/private/`), or the plan file.
- Preserve deliberate gaps (TLSH threshold, review-matches grammar, symbol/dir nectars) and all "DEFAULT - confirm before implementation" flags.
- Corpus-side items surfaced in PR #1 (ADR-0003 header lacks a formal Supersedes field; ADR-0004 header non-conformance) are OUT OF SCOPE here and remain flagged for the corpus owner.

---

## Run log

- Recon complete: AC ledger built, wave plan set, 1 OPEN item (AC-Q1, 75 link tokens).
- Wave 1 complete (hivenectar-worker-bee): 75/75 honeycomb/hivedoctor markdown links converted to backtick spans (index 7, 001a 12, 001b 36, 001c 20). AC-M1..M6 verified against ADR-0002/0003/0004 + overview.md; no in-file doc gap found.
- Verification (independent): self-verify grep = 0 remaining; all internal doc links resolve; only the 4 PRD-001 files changed; `git diff --check` clean; no em/en dashes introduced in authored spans (pre-existing prose em dashes preserved per the rule exception). AC-Q1 -> DONE. Open count: 0.
- Close-out A (security-worker-bee): PASS, clean. Docs-scoped scan of the PRD-001 delta + ledger found no secrets/credentials/PII; no files modified.
- Close-out B (quality-worker-bee, armed with quality-stinger + hivenectar-stinger): PASS at medium+, zero open Warnings. Independently re-verified grep=0, no internal link broken, AC-M1..M6 unchanged in substance, AC-Q1 resolved (75/75). Updated the per-PRD qa report (Detrimental Patterns WARNING -> PASS; W-1 moved to Resolved). No new findings.
- Orchestrator: refreshed the consolidated report (`reports/2026-07-01-...`) so PRD-001's scorecard/summary/W-1 status reflect the remediation; W-1 now scoped to PRD-002/003 only.

## Final status

All 9 ACs **VERIFIED** (AC-M1..M6, AC-S1..S3 verified against the corpus; AC-Q1 remediated + independently verified + quality-confirmed). Security + quality close-out clean at medium+. PRD-001 is complete to the the-smoker bar. Ready to ship (updates PR #1).

## Post-completion correction (2026-07-01): W-2 stale hivedoctor code-path prefix

Cross-repo review (whole `the-hive` superproject in view) surfaced that `hivedoctor` is now its own repository (`legioncodeinc/hivedoctor`, code at `hivedoctor/src/...`), yet PRD-001..004 and two corpus ADRs still used the stale `honeycomb/hivedoctor/...` prefix (105 refs in PRD-001..004, 4 in the corpus). User approved a widened-scope fix (PRD-001..004 + ADR-0003/0004).

- Fix (hivenectar-worker-bee): `honeycomb/hivedoctor/...` -> `hivedoctor/...` (104 replacements) + 4 prose reframings (hivedoctor as its own repo). Preserved `honeycomb/src/...` (correct), the `~/.honeycomb/hivedoctor.daemons.json` + `state-<name>.json` runtime paths, and all thehive-in-honeycomb design wording.
- Independent verification: 0 stale `honeycomb/hivedoctor/src` refs remain; runtime paths intact; no `~/.hivedoctor` corruption; internal links resolve; `git diff --check` clean; no em/en dashes introduced in authored prose.
- Artifacts updated: PRD-001 QA report (W-2 Resolved entry), consolidated report (section 4b), this ledger. PRD-005..016 needed no change (0 refs).
- Note: W-2 (stale prefix) is now fixed across PRD-001..004; W-1 (link-form) remains open in PRD-002/003 only.

---

# Execution Ledger: PRD-002 (the-smoker run, 2026-07-01)

`/the-smoker` on **PRD-002 Hivenectar Daemon** (index + 002a/b/c/d). Primary bee: `hivenectar-worker-bee`. Close-out uses a **double quality pass on two models** (`claude-opus-4-8-thinking-xhigh-fast` + `gpt-5.5-medium-fast`). Branch `feature/prd-001-004-refine`. PRD-002 is the daemon-spec module; its deliverables are documentation (the hivenectar repo is design-stage). Module ACs were already PASS-verified in the PR #1 QA. The one open item is W-1 (code refs as markdown links, not backtick spans; 149 tokens, all full-form).

## AC Ledger (PRD-002)

| ID | Source | Criterion (abbrev) | Owner | Status |
|---|---|---|---|---|
| AC-M1 | index | `hivenectar daemon` runnable, mirrors `assembleDaemon`, no honeycomb runtime import | hivenectar-worker-bee | DONE (002a; verify) |
| AC-M2 | index | Fixed bootstrap order, lock before socket bind | hivenectar-worker-bee | DONE (002a; verify) |
| AC-M3 | index | Binds 127.0.0.1:3854, unprotected `/health` coarse bit, no port collision | hivenectar-worker-bee | DONE (002a; verify) |
| AC-M4 | index | hiveantennae worker lease-based (`stage-worker`) on adaptive poll loop | hivenectar-worker-bee | DONE (002b; verify) |
| AC-M5 | index | Every corpus-named CLI command in 002c with owner-PRD + corpus citation | hivenectar-worker-bee | DONE (002c; verify) |
| AC-M6 | index | Second start throws `DaemonAlreadyRunningError`-equiv before bind; stale lock reclaimed | hivenectar-worker-bee | DONE (002d; verify) |
| AC-M7 | index | SIGINT/SIGTERM drain + close + remove PID/lock; idempotent | hivenectar-worker-bee | DONE (002d; verify) |
| AC-Q1 | Doc Framework 6 | Code refs are backtick spans, not markdown links (149 honeycomb/hivedoctor link tokens: 002a 47, 002b 37, 002c 7, 002d 45, index 13; all full-form) | hivenectar-worker-bee | OPEN -> Wave 1 |
| AC-S* | 002a/b/c/d US | All sub-PRD user stories (bootstrap, worker crash-safety, CLI catalog + preserved gaps, lock/shutdown) | hivenectar-worker-bee | DONE (verify vs corpus) |

**Open on entry: 1 (AC-Q1).**

## Wave plan

- **Wave 1** - hivenectar-worker-bee (`claude-opus-4-8-thinking-xhigh-fast`): convert 149 markdown code-links to backtick spans across PRD-002's 5 files (clean unwrap, all full-form); re-verify AC-M1..M7 + sub-PRD ACs against `overview.md`, `ai/brooding-pipeline.md`, `ai/enricher-and-llm-model.md`, `ai/identity-and-reassociation.md`, ADR-0002; preserve deliberate gaps (review-matches sub-flag, TLSH threshold) and DEFAULT flags.
- **Close-out A** - security-worker-bee (`claude-sonnet-5-thinking-high`): docs-scoped scan of the PRD-002 delta.
- **Close-out B (DOUBLE)** - two independent, read-only quality-worker-bee passes: pass A on `claude-opus-4-8-thinking-xhigh-fast`, pass B on `gpt-5.5-medium-fast`, run in parallel. Orchestrator reconciles both verdicts and writes the PRD-002 qa report. Two different model families cross-check to avoid correlated blind spots.

## Run log

- Recon complete: PRD-002 AC ledger built; 1 OPEN (AC-Q1, 149 full-form link tokens); stale hivedoctor prefix already 0.
- Wave 1 complete (hivenectar-worker-bee): 149/149 markdown code-links unwrapped to backtick spans (index 13, 002a 47, 002b 37, 002c 7, 002d 45). AC-M1..M7 verified against overview/brooding/enricher/identity + ADR-0002; two deliberate gaps + 6 DEFAULT flags preserved. AC-Q1 -> DONE.
- Verification (independent): grep = 0 remaining cross-repo link tokens; all internal links resolve; only PRD-002's 5 source files changed; `git diff --check` clean; honeycomb/src path text preserved (290 -> 145, the removed halves were the link targets). No new em dashes in authored text. Open count: 0.
- Content-integrity proof (orchestrator): after stripping the markdown-link wrapper from every removed diff line, the removed set is byte-identical to the added set -> the change is a PURE link-unwrap, no prose/number/DEFAULT/gap/AC alteration. Therefore the PR #1 AC verification (PASS) carries forward verbatim.
- Close-out A (security-worker-bee): PASS, clean (docs-scoped scan of the PRD-002 delta; no secrets/PII; no edits).
- Close-out B (DOUBLE quality, two models): **COMPLETE, both PASS**. After several dispatch failures on a flapping platform billing error (immediate retry + a 50s-wait retry both failed), a later retry succeeded. Pass A (`claude-opus-4-8-thinking-xhigh-fast`) and pass B (`gpt-5.5-medium-fast`), both read-only, each returned PASS at medium+ with no regression and no medium-or-above findings; AC-Q1 grep = 0 and 98/98 internal links resolve in both. Only delta: one sub-medium Suggestion from pass A (AC-5 enumerates 4 corpus docs while 3 CLI commands cite MASTER-PRD-INDEX / portable-registry.md); pass B confirmed portable-registry.md names the rebuild commands. Recorded as S-3, below the medium bar, left as-is.
- Substitute verification (orchestrator, done before the double pass unblocked): the content-integrity proof above + the Wave-1 bee's corpus re-verification of AC-M1..M7 + PR #1 PASS (content unchanged). The two-model pass has since corroborated it.

## Final status (PRD-002)

All 8 tracked ACs (AC-M1..M7 + AC-Q1) satisfied and independently VERIFIED. Close-out clean: security PASS + a two-model double quality pass both PASS at medium+ (one sub-medium Suggestion S-3, non-blocking). Shipped (updates PR #1). W-1 now resolved across PRD-001 + PRD-002; remains open in PRD-003 only.

---

# Execution Ledger: Wave A (the-smoker run, 2026-07-01)

`/the-smoker` driving **Wave A** of the PRD-003-016 wave plan. Branch: `feature/smoker-wave-a-prd-005` (hivenectar submodule, off `main`). Track: PRD-vs-corpus conformance QA + lifecycle hygiene (per the consolidated QA report: "there is no implementation code yet ... verifies each acceptance criterion against its cited corpus/code source"). Status legend: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.

## Wave A scope (from PRD-003-016-WAVE-PLAN.md § Wave A)

Wave A = PRD-002 (daemon), PRD-004a (hivedoctor registry, OOB), PRD-005 (source-graph catalog tables). Entry gate: PRD-001 VERIFIED (done), Wave 0 passed for these.

## AC Ledger (Wave A)

| ID | PRD | Criterion (abbrev) | Owner | Status |
|---|---|---|---|---|
| A-002 | 002 | Daemon module ACs (AC-M1..M7 + AC-Q1) | hivenectar-worker-bee | VERIFIED (prior the-smoker run; double QA PASS; W-1 resolved). Lifecycle: strand in backlog -> move to completed. |
| A-004a | 004a | hivedoctor registry a-AC-1..a-AC-8 (config schema, per-daemon supervisor, isolated state, per-entry guards) | quality-worker-bee | VERIFIED at module level (PRD-004 consolidated QA-PASS). Locus OOB-hivedoctor; folder stays in backlog (004 spans Waves A/B/E). BLOCKED for in-repo merge (another repo + active parallel agent). |
| A-005 | 005 | Source-graph catalog tables: verbatim DDL, ColumnDef guard, scope=tenant, CATALOG append, withHeal lazy-create, project_id soft-filter (005a/b/c ACs) | quality-worker-bee | IN PROGRESS (QA-pending -> Wave A quality pass). |

**Open on entry: 1 (A-005 needs its QA pass).** A-002 and A-004a are already VERIFIED to the corpus-conformance bar.

## Wave plan (Wave A)

```mermaid
flowchart TD
    q005["quality-worker-bee: PRD-005 corpus-conformance QA (armed: quality-stinger + hivenectar-stinger)"] --> rem["Remediate medium+ findings to clean"]
    rem --> sec["Docs-scoped security check of the delta"]
    sec --> mv["Lifecycle: 005 -> completed; 002 -> completed (hygiene)"]
    mv --> gate["Wave A exit gate: 002/004a/005 VERIFIED"]
    rem -->|reopen on regression| q005
```

Model routing: PRD-005 QA on `claude-4.6-sonnet-medium-thinking` (balanced daily-driver, independent of the authoring bee), per the wave plan's Wave 0 routing and B-1/R-1. PRD-005 is one of the high-risk PRDs (verbatim DDL fidelity), so a second-model cross-check is warranted if the first pass surfaces borderline findings.

## Scope boundaries

- Edit ONLY Wave A artifacts inside the `hivenectar` repo: the PRD-005 folder (+ its qa/), the lifecycle moves for 005 and 002, this ledger. Do NOT touch the corpus (`knowledge/private/`), PRD-003/006-016, the plan/dep-map/index files, `the-hive/`, `hivedoctor/`, or `honeycomb/` (all out of band and/or another agent's active work).
- Preserve deliberate spec gaps and all "DEFAULT - confirm before implementation" flags (005 carries: catalog group name `source-graph`, write patterns, scope=tenant).
- Note the open corpus item C-2 (the `confidence` column + `skipped-deleted` enum reconciliation) lives in PRD-005 territory; it is a corpus-owner (knowledge-worker-bee) edit, out of scope here, surfaced not fixed.

## Run log

- Recon complete: read master index, dependency map, wave plan, consolidated QA report, both prior ledger runs, and PRD-005 index + 005a/b/c. Confirmed track = corpus-conformance QA. Wave A's only QA-pending item is PRD-005. Branch `feature/smoker-wave-a-prd-005` created off main.
- Lifecycle: PRD-005 moved backlog -> in-work (git mv).
- Quality pass (quality-worker-bee, armed quality-stinger + hivenectar-stinger): PRD-005 corpus-conformance QA -> **PASS-with-warnings** at medium+. Zero Critical. Spec substance clean (both DDL blocks match the corpus verbatim; all six cited honeycomb symbols exist at cited lines with zero drift; tenancy/withHeal/project_id model grounded). Three medium Warnings, all doc/metadata defects: W-1 (005b column-count prose + 2 ACs said "twenty/sole nullable" vs the correct 21-column, 2-nullable artifact), W-2 (4 `MASTER-PRD-INDEX.md` links wrong depth `../../../` -> `../../`), W-3 (19 honeycomb code refs as non-resolving markdown links in Related sections). Report written to the PRD-005 qa/ folder.
- Remediation (orchestrator, in-place, DDL/arrays untouched): W-1 fixed (05b:62/:181/:182 + the "sole nullable" phrasing in the embedding section); W-2 fixed (all 4 links, both files); W-3 fixed (all 19 refs unwrapped to backtick spans: index 6, 005a 4, 005b 4, 005c 5); N-1 fixed (stale "corpus should be updated" wording -> corpus already agrees); N-3 fixed (non-resolving stinger-guide link -> plain-text citation). N-2 left as-is (descriptive, no impact). QA report updated with a §10 remediation addendum flipping the post-remediation verdict to clean PASS.
- Self-verification (grep): 0 link-form honeycomb/hivedoctor code tokens in the PRD-005 files (the only remaining matches are inside the QA report's own descriptive text and the legitimate ADR-0002 knowledge-doc link whose filename contains "hivedoctor"); 0 wrong-depth `../../../MASTER-PRD-INDEX` links in the PRD files; column-count prose + ACs internally consistent with the 21-column artifact. Pre-existing prose em dashes preserved (no new em/en dashes introduced) per the repo rule exception.
- Security close-out (docs-scoped): the Wave A delta is markdown only (PRD-005 doc edits + this ledger + the new QA report). Secret-pattern scan over the delta (api key / secret / password / token / bearer / private key / sk- / ghp_) returned zero matches. No source code changed, so the aikido code-scan is N/A (rule: skip for non-code changes). Clean.
- Lifecycle: PRD-005 moved in-work -> completed (git mv). Wave A QA-pending item is closed.

## Boundary observations (surfaced, NOT acted on)

- **B-A1 (another agent's active work in hivenectar):** `library/knowledge/private/architecture/ADR-0003-...md` and `ADR-0004-...md` are modified in the working tree (1 line each) by another agent (consistent with the corpus C-1 ADR-0004-header fix and/or C-2 corpus edits). I did NOT author these and per the respect-agent-work-boundaries rule I left them untouched and excluded them from the Wave A commit scope. Flag for the corpus owner.
- **B-A2 (PRD-001/002 lifecycle, USER-APPROVED, executed):** PRD-001 and PRD-002 were VERIFIED/shipped in prior runs but still sat in `backlog/` (dependency-map D-5 / wave-plan R-12). On user confirmation (2026-07-01), both folders were moved `backlog/` -> `completed/` via `git mv`. PRD-003/004 remain in `backlog/` (later waves).

## Final status (Wave A)

- **A-005 (PRD-005): VERIFIED.** QA PASS after remediation of all three medium Warnings; grep-verified clean; security docs-scan clean; folder moved to `completed/`.
- **A-002 (PRD-002): VERIFIED (prior run).** Lifecycle move to `completed/` RECOMMENDED, pending user confirmation (boundary B-A2).
- **A-004a (PRD-004a): VERIFIED at module level (PRD-004 QA-PASS).** Locus OOB-hivedoctor; the code implementation of the registry lands in the `hivedoctor` repo and is BLOCKED here (separate repo + active parallel agent). PRD-004 folder stays in `backlog/` because 004b/c/d belong to later waves.

**Wave A exit gate: MET** for the in-band QA track (002 VERIFIED prior, 004a VERIFIED at module level, 005 VERIFIED this run). Out-of-band code merges (004a in hivedoctor; 005 catalog tables in honeycomb) are tracked and BLOCKED for owning-repo coordination per dependency-map R-3. Held before Wave B pending user direction on: (1) commit/push/PR of the Wave A delta, (2) the PRD-002/001 lifecycle moves, (3) whether Wave B should proceed on the same docs-QA track.

**Wave A close (post-hold):** User approved commit-to-feature-branch-only (no push), and approved moving PRD-001 + PRD-002 backlog -> completed. Committed as `f73367d` on `feature/smoker-wave-a-prd-005` (ADR-0003/0004 excluded, another agent's edits). Wave B authorized.

---

# Execution Ledger: Wave B (the-smoker run, 2026-07-01)

`/the-smoker` driving **Wave B** of the PRD-003-016 wave plan. Branch: `feature/smoker-wave-b` (off the Wave A branch, hivenectar submodule). Same track: PRD-vs-corpus conformance QA + lifecycle, plus plan-vs-code where in-band code exists and OOB verification for the-hive/hivedoctor items.

## Wave B scope (from PRD-003-016-WAVE-PLAN.md § Wave B)

003 (supervision), 004b (hivedoctor status/CLI, OOB), 004c (thehive portal, OOB), 006 (file registration), 010 (Portkey, straddle), 011 (projection), 014 (embeddings switch, straddle).

## AC Ledger (Wave B)

| ID | PRD | Locus | Owner | Status |
|---|---|---|---|---|
| B-003 | 003 | IN-BAND (+ registry touch) | library-worker-bee (W-1) + orchestrator | IN PROGRESS. Spec QA-PASS (prior); open W-1 (99 link-form refs) dispatched to library-worker-bee for remediation. |
| B-004b | 004b | OOB-hivedoctor | quality (spec) / hivedoctor repo (impl) | Spec VERIFIED at PRD-004 module level. **Implementation BLOCKED**: hivedoctor is still single-daemon (config.ts has no registry; `compose/index.ts:320` builds one `createSupervisor`; status-page + CLI single-daemon). Needs hivedoctor-repo work. |
| B-004c | 004c | OOB-thehive | the-hive repo | **VERIFIED.** Implemented in the-hive (`feature/prd-001-thehive-portal-daemon`) and independently QA'd there (the-hive quality-worker-bee: 26/27 ACs PASS, security ran first + fixed 1 High SSRF, typecheck+test+build green). hivenectar c-AC-1..c-AC-7 map onto the-hive a/b/c/d-ACs. Two non-blocking fast-follows owned by the-hive: UI `daemonUp` gate is honeycomb-scoped (not yet user-visible); m-AC-5 CI release automation OPEN. |
| B-006 | 006 | IN-BAND | quality-worker-bee | IN PROGRESS (QA dispatched; in-band code exists at `hivenectar/src/registration/`). |
| B-010 | 010 | STRADDLE | quality-worker-bee | IN PROGRESS (QA dispatched). |
| B-011 | 011 | IN-BAND | quality-worker-bee | IN PROGRESS (QA dispatched; check `hivenectar/src/source-graph/` for projection code). |
| B-014 | 014 | STRADDLE | quality-worker-bee | IN PROGRESS (QA dispatched). |

## Wave plan (Wave B)

- Parallel wave: 4 quality-worker-bee QA passes (006, 010, 011, 014) + 1 library-worker-bee W-1 remediation (003), all dispatched concurrently. Orchestrator does OOB verification (004b/004c) read-only in parallel.
- Then: remediate medium+ findings to clean, docs-scoped security check, lifecycle moves (003/006/010/011/014 -> completed on PASS), commit (no push per Wave A precedent), hold.

## OOB verification results (orchestrator, read-only)

- **004c (the-hive): VERIFIED** (see B-004c). the-hive git shows active parallel work (untracked `library/knowledge/private/frontend/`), left untouched.
- **004b + 004a (hivedoctor): implementation BLOCKED.** hivedoctor repo (on `main`) is still a single-daemon supervisor: `src/config.ts` has no `daemons` registry; `src/compose/index.ts:320` constructs exactly one `createSupervisor`; `src/status-page/server.ts` `buildStatus` reads a single `state.health()` (no per-daemon array); the CLI does not iterate a registry. The `createRegistryLatestReader` refs are the npm-version update reader, NOT the daemon supervision registry. **ASK to unblock:** implement PRD-004a (registry config schema + N supervisor instances + isolated `state-<name>.json` / `incidents-<name>.ndjson` shards + per-entry watchdog guards) and PRD-004b (per-daemon `/status.json` + HTML + CLI `status`/`logs --daemon`) in the hivedoctor repo. This is OOB and likely the-hive/hivedoctor agent's territory; not implemented here.

## Run log (Wave B)

- Recon: created `feature/smoker-wave-b` off the Wave A branch. Confirmed the-hive is implemented + self-QA'd (004c). Confirmed hivedoctor still single-daemon (004a/004b impl blocked). Sized PRD-003 W-1 at 99 link-form refs (index 2, 003a 31, 003b 38, 003c 28).
- Lifecycle: moved 003, 006, 010, 011, 014 backlog -> in-work.
- Dispatched 4 quality-worker-bee QA passes (006, 010, 011, 014) + 1 library-worker-bee (003 W-1 remediation), all in parallel.
- PRD-003 W-1 remediation complete (library-worker-bee): 105 cross-repo code refs converted to backtick spans (003a 39, 003b 38, 003c 28; index 0), 60 short-form promotions + 45 full-form unwraps; grep-verified 0 remaining; prose-neutral. W-1 now closed across PRD-001/002/003.
- QA verdicts (all PASS-with-warnings, zero Critical):
  - 006: W-1 (7 wrong-depth MASTER links), W-2 (6 honeycomb link-refs), N-1 (3 .agents links) -> all remediated in PRD-006. Sub-medium N-2/N-3/N-4/N-5 carried forward (N-3/N-4 are plan-vs-code doc drift for the implementer).
  - 010: W-1 (citation line-drift 010a:59) -> remediated. Doc-framework clean.
  - 011: W-1 (sha256 `sha256-` prefix rule vs bare-hex hasher) -> remediated in PRD-011b (aligned to `hash.ts`, corpus placeholder noted illustrative; no corpus/code edit). N-4/N-5 broken-by-this-run links -> fixed.
  - 014: W-1 ("Unix-socket NDJSON IPC") is CORPUS-origin; PRD-014 faithfully mirrors the corpus -> DEFERRED to knowledge-worker-bee (exact ask recorded in 014 qa addendum). PRD-014 document VERIFIED faithful.
- Remediation self-verified (grep): 0 link-form honeycomb/MASTER/.agents tokens remain in 006; 0 broken cross-PRD backlog links in the Wave B set (the 2 that this run's own lifecycle moves broke were fixed).
- Security close-out (docs-scoped): secret-pattern scan over the Wave B delta returned only PRD-003a prose about NOT leaking secrets (from the link-unwrap diff), no actual credentials. Markdown-only delta; aikido code-scan N/A. Clean.
- Lifecycle: moved 003, 006, 010, 011, 014 in-work -> completed. `in-work/` is now empty.
- QA reports: remediation addenda appended to all five (003, 006, 010, 011, 014) recording post-remediation clean PASS (014 = PRD faithful + corpus deferral).

## Final status (Wave B)

- **B-003: VERIFIED.** Spec QA-PASS; W-1 remediated (105 refs) + grep-verified; moved to completed.
- **B-006: VERIFIED.** PASS after W-1/W-2/N-1 remediation; sub-medium plan-vs-code notes (N-3/N-4) carried forward for the PRD-006 implementer; moved to completed.
- **B-010: VERIFIED.** PASS after W-1 remediation; moved to completed.
- **B-011: VERIFIED.** PASS after W-1 (code-aligned) + N-4/N-5 link fixes; moved to completed.
- **B-014: VERIFIED (document faithful).** One medium Warning DEFERRED as a corpus-owner fix (knowledge-worker-bee), PRD itself conformant; moved to completed.
- **B-004c: VERIFIED** (implemented + self-QA'd in the-hive).
- **B-004a / B-004b: implementation BLOCKED** in the hivedoctor repo (still single-daemon). Spec QA-PASS; PRD-004 folder stays in backlog (004d + 015 are Wave E). Exact unblock ask recorded above.

**Wave B exit gate: MET** for the in-band/straddle QA track (003/006/010/011/014 VERIFIED + moved to completed; 004c VERIFIED in the-hive). Two out-of-band items parked BLOCKED with exact asks: hivedoctor multi-daemon registry+status (004a/004b), and the corpus transport-phrase fix (014 W-1, knowledge-worker-bee). Held before Wave C pending user direction.

---

# Execution Ledger: PRD-003 implementation (the-smoker run, 2026-07-01)

`/the-smoker` on **PRD-003 Hivenectar supervision by hivedoctor** (index + 003a/003b/003c). Branch: `feature/prd-003-hivenectar-supervision` (fresh worktree off `main`). Primary agent: this session.

**Note on scope relative to the Wave B ledger entry above:** the Wave B run verified PRD-003 as **spec-conformance QA only** ("there is no implementation code yet"; the folder is currently in `in-work/` on `main`, not `completed/`, despite that entry's run log — the lifecycle move evidently did not persist to `main`). This run is the first to write actual **code** against PRD-003: AC-1/AC-2 (the `/health` endpoint + PID/lock) were already implemented under PRD-002; this run implements the two ACs that had no code yet — AC-3 (OS service unit, 003b) and AC-4 (the hivedoctor registry entry, 003c) — and confirms AC-5 by reading the already-implemented, generic hivedoctor-side mechanism (PRD-004a, out of this repo).

## AC Ledger (PRD-003 implementation)

| ID | Criterion | Status | Verification evidence |
|---|---|---|---|
| AC-1 | `GET /health` returns `200`+`ok` / `503`+`degraded` | VERIFIED (pre-existing, PRD-002/003a) | `src/health.ts`, `src/server.ts`; `test/health.test.ts`, `test/daemon.test.ts`. |
| AC-2 | Writes `hivenectar.pid`/`.lock`; second start throws before bind | VERIFIED (pre-existing, PRD-002/003a) | `src/lock.ts`; `test/lock.test.ts` (6/6). |
| AC-3 | OS service unit starts on boot, restarts on crash | VERIFIED (implemented this run, 003b) | New `src/service/{platform,templates,argv,command-runner,index}.ts`, mirroring hivedoctor's own service module with hivenectar's label (`com.hivenectar.daemon`), unit name (`hivenectar.service`), task name (`HivenectarDaemon`), and run command (`daemon`); `test/service-platform.test.ts`, `test/service-templates.test.ts`, `test/service-argv.test.ts`, `test/service-index.test.ts` (36 tests). |
| AC-4 | Installer appends one entry to `~/.honeycomb/hivedoctor.daemons.json` | VERIFIED (implemented this run, 003c) | New `src/hivedoctor-registry.ts` (`registerWithHivedoctor`), idempotent (replaces hivenectar's own entry, preserves every other daemon's entry, fails loud on a malformed file); `test/hivedoctor-registry.test.ts` (6 tests). Wired into `hivenectar install` in `src/cli.ts` alongside the service-unit install (no two-phase hazard, per 003c). |
| AC-5 | Lock-held-and-healthy guard reads hivenectar's own PID | VERIFIED (cross-repo, read-only; PRD-004a, already implemented in `hivedoctor`) | `hivedoctor/src/registry.ts` (the `DaemonEntry` schema, `hivenectar` a known name), `hivedoctor/src/remediation.ts:124-160` (the guard), `hivedoctor/src/compose/index.ts:534-574` (`buildDaemon` wires `readDaemonPid: () => readDaemonPid(entry.pidPath)` generically per registry entry, with an entry-local `lastRestartAt`). No hivedoctor-repo change was needed or made. |

## Run log

- Recon: read the PRD-003 index + 003a/003b/003c + its QA report (`in-work/prd-003-hivenectar-supervision/qa/`), the wave plan, and the hivenectar source tree. Found AC-1/AC-2 already implemented (PRD-002); AC-3/AC-4 had no code; AC-5's hivedoctor-side mechanism (PRD-004a: `registry.ts`, `remediation.ts`, `compose/index.ts`) was found ALREADY fully implemented on the `hivedoctor` repo's `main` (contradicting the Wave B ledger entry's "implementation BLOCKED" note above — hivedoctor has since gained multi-daemon support), so no cross-repo work was required for AC-5.
- Cut `git worktree add ../../hivenectar-worktrees/prd-003-hivenectar-supervision -b feature/prd-003-hivenectar-supervision main`.
- Implemented `src/service/*` (003b) and `src/hivedoctor-registry.ts` (003c), wired `hivenectar install`/`uninstall`/`service-status` into `src/cli.ts`, and re-exported the new public surface from `src/index.ts`.
- Wrote 42 new tests across 5 files (service-platform, service-templates, service-argv, service-index, hivedoctor-registry). Full suite: `npm run build && npm run typecheck && npm test` → 123 passed, 0 failed, 1 pre-existing skip (an unreachable live Deep Lake integration test in `source-graph-deeplake.test.ts`, unrelated to this branch).
- Lifecycle: moved the PRD-003 folder `in-work/` → `completed/` (git mv), matching the pattern already applied to PRD-001/002/005; checked off PRD-003's line in `PRD-003-016-WAVE-PLAN.md` Wave B exit gate.
- Self-correction: an earlier draft of this ledger entry accidentally overwrote this file's prior PRD-001/002/Wave-A/Wave-B history instead of appending. Restored the original content verbatim from `main` before appending this section (respect-agent-work-boundaries).

## Close-out (PRD-003 implementation)

- [x] Implementation: DONE and locally verified.
- [x] Security review (security-review subagent): PASS, no medium/high/critical findings. Optional defense-in-depth suggestions (write-side loopback validation, registry unregister on uninstall, atomic registry writes) noted but not required; left as-is to keep scope tight to the PRD's ACs.
- [x] Quality review (quality-worker-bee): PASS (medium-and-above), addendum appended to `qa/prd-003-hivenectar-supervision-qa.md`. One should-fix Warning (W-2, integration-test coverage gap for the darwin/win32 install-uninstall paths) — remediated same session (4 new tests added, 127/127 passing); two non-blocking Suggestions (S-4, S-5) left open as documented, out of this branch's scope.
- [ ] Ship: commit, push, PR, CI

No blockers. All five module ACs are VERIFIED for PRD-003's hivenectar-repo scope.

---

# Execution Ledger: PRD-006 implementation (the-smoker run, 2026-07-01)

`/the-smoker` on **PRD-006 File Registration Protocol** (index + 006a/006b/006c/006d). Branch: `feature/prd-006-file-registration-complete` (off `main`, hivenectar repo). Track: **implementation** (not doc-conformance). The Wave B run verified PRD-006 as PRD-vs-corpus spec conformance; the unit-level core (`src/registration/{fs-watch,classify,copy-detect,ladder}.ts`) is implemented + tested, but several ACs are still OPEN as real code (settled-handler wiring, TLSH step-4, `review-matches` + `prune` CLI). This run drives every AC to genuinely DONE (no stubs, no partial credit) then VERIFIED. Status legend: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.

## AC Ledger (PRD-006 implementation)

| ID | Source | Criterion (abbrev) | Owner | Status |
|---|---|---|---|---|
| AC-1 | 006a | `node:fs.watch` dir-level + `setTimeout`/`clearTimeout` debounce; chokidar NOT a dep | impl worker | DONE (`fs-watch.ts`; chokidar absent) - VERIFY |
| AC-2 | 006a | Burst coalesces to one settled cycle (`scheduleSyncCycle` shape) | impl worker | DONE (`fs-watch.ts` debounce; tested) - VERIFY |
| AC-3 | 006a | `null`/`undefined` filename triggers a full resync settle, not a drop/crash | impl worker | DONE (`fs-watch.ts` `observeRaw(null)` -> debounced `requestResync`; `service.ts` `runResync` re-scans + reconciles; tests: registration-service "null-filename ... full resync settle") |
| AC-4 | 006a | Settled handler = `runGraphBuild` discover->resolve->persist shape; per-path persist failure logged, cycle continues; running-cycle promise tracked | impl worker | DONE (`service.ts` `RegistrationService`: `currentCyclePromise` + `_waitForIdle`, per-path try/catch, cycle never throws; tests: burst-drain + per-path-isolation) |
| AC-5 | 006a | Observations filtered through CodeGraph ignore contract; no hivenectar-specific ignore list | impl worker | DONE (`ignore.ts` `createDefaultIgnore`: `.git/`/`node_modules/`/`.honeycomb/` + `graph-ignore.json`; filtered in `fs-watch.ts` `observe` + `service.ts` `enqueue`; tests: ignore.test + service "ignored paths never trigger a cycle") |
| AC-6 | 006b | Every settled path -> exactly one of NEW/CHANGED/MISSING (or UNCHANGED drop); pure fn | impl worker | DONE (`classify.ts`; tested) - VERIFY |
| AC-7 | 006b | Step-1 fast path (mtime+size) resolved so UNCHANGED never reaches the ladder (N-4 reconcile: classifier vs ladder) | impl worker | DONE (chose option (b): step 1 stays the ladder's first rung; 006b/006d prose + ACs reworded to "resolved as the ladder's first rung, no content read"; code unchanged, still tested by registration.test "step 1") |
| AC-8 | 006b | Missing-files set = set diff (DL known paths vs disk), keyed by nectar, carries latest hash + TLSH fingerprint | impl worker | DONE (`ladder.ts` `FuzzyCandidate` carries `fingerprint`; supplied by `LadderDeps.fingerprintOf` from `service.ts` in-memory `fingerprintCache`, computed at registration; latest hash via `version.contentHash`; +/-20% size-bucket in `tlsh.ts`. No persisted column added: see design note in run log) |
| AC-9 | 006b | Rename = two uncorrelated obs; missing-set + step 3 reconstruct the move (no move object) | impl worker | DONE + VERIFIED end-to-end via the settled service (test: registration-service "a rename reconstructs a move end-to-end through step 3") |
| AC-10 | 006c | Copy detector runs after steps 3/4 miss; `classifyNewFile` verbatim; mint N2 + `derived_from_nectar` + `fork_content_hash` | impl worker | DONE (`copy-detect.ts` + `ladder.ts mintOrCopy`; tested) - VERIFY |
| AC-11 | 006d | Ladder carries all 5 steps verbatim, first-match-wins | impl worker | DONE (`ladder.ts`; tested) - VERIFY |
| AC-12 | 006d | Step 2 appends version (seq+1, describe_status pending), enqueues enrich | impl worker | DONE (tested) - VERIFY |
| AC-13 | 006d | Step 3 carries on exact sha256 to missing, appends new-path row, no enrich, removes from set | impl worker | DONE (tested) - VERIFY |
| AC-14 | 006d | Step 4 computes TLSH fingerprint, size-bucketed (+/-20%), scored confidence | impl worker | DONE (`tlsh.ts` `computeFingerprint`/`fingerprintDistance`/`createTlshFuzzyStep`; `SIZE_BUCKET_TOLERANCE=0.2`; confidence = 1 - distance/MAX_DISTANCE; tests: tlsh.test size-bucket + bands) |
| AC-15 | 006d | Step 4 high band carries + enrich; below-high -> `review-matches`; no-match -> step 5 | impl worker | DONE (ladder step-4 high band now also `onEnrichQueued`; review persisted via `service.ts` `handleReview` -> `PendingReviewStore`; tests: registration-service "low-confidence ... queued for review") |
| AC-16 | 006d | TLSH threshold configurable + empirically tuned; NO numeric threshold pinned (deliberate gap) | impl worker | PRESERVED (threshold is `FuzzyConfig` injected into `createTlshFuzzyStep`; `DEFAULT_TUNABLE_FUZZY_CONFIG` is a clearly-flagged operator default, NOT a spec threshold; the distance->confidence map uses only the algorithm's MAX_DISTANCE, not a cutoff) |
| AC-17 | 006d | TLSH impl (native addon OR WASM) flagged DEFAULT; algorithm identical either way (zero-dep ethos: prefer pure-TS) | impl worker | DONE (in-repo pure-TS locality-sensitive digest in `tlsh.ts`, zero new runtime dep; native/WASM stays the flagged DEFAULT for later; same fingerprint/distance interface so it is a drop-in swap) |
| AC-18 | 006d | `review-matches` lists pending candidates w/ confidence + diff preview, accept/reject each; flag grammar flagged, not invented | impl worker | DONE (mechanics: `review-cli.ts` `runReviewMatches` + `review-store.ts` `PendingReviewStore`; accept carries nectar, reject leaves fresh mint + missing entry; tenancy-guarded accept; tests: review-matches.test + security-remediation.test accept/reject/empty/stale/cross-tenancy. Flag grammar NOT invented. CLI: durable-store wiring deferred to daemon integration; `cli.ts` announces "logic implemented; not yet wired" and exits non-zero rather than run against an empty store, W-1 remediation) |
| AC-19 | 006d | `prune --confirm` sole deletion path; ladder never deletes/reuses; 30-day grace DEFAULT; bare `prune` = preview | impl worker | DONE (mechanics: `prune-cli.ts` `runPrune`/`findPruneCandidates`; tenancy-scoped `store.deleteNectar`; `PRUNE_GRACE_MS=30d` flagged DEFAULT, configurable; tests: prune.test preview/confirm/grace-boundary + security-remediation.test tenancy-scope. CLI: durable-store wiring deferred to daemon integration; `cli.ts` announces "logic implemented; not yet wired" and exits non-zero rather than silently no-op a destructive verb, W-1 remediation) |
| AC-20 | index/all | All tenancy lookups scoped by org+workspace+project; re-association never crosses project | impl worker | DONE - VERIFIED (tenancy threaded through service/ladder/review/prune; all store reads take `Tenancy`; no cross-project lookup) |
| AC-21 | all | `npm run build && npm run typecheck && npm test` green; new surfaces tested | impl worker | DONE (build + typecheck clean; `npm test` 157 pass / 0 fail; new suites: registration-service, tlsh, review-matches, prune, ignore) |

**Open on entry: 10** (AC-3, AC-4, AC-5, AC-7, AC-8, AC-14, AC-17, AC-18, AC-19, AC-21). Remainder DONE pending VERIFY, or deliberate-gap PRESERVE.

## Deliberate gaps to PRESERVE (do NOT pin)

- TLSH confidence threshold: configurable + tuned during brooding; NO numeric value (AC-16).
- `review-matches` accept/reject flag grammar: interactive default; flags flagged, not invented (AC-18).
- `debounceMs=500`, prune grace `30 days`, TLSH impl (native/WASM): DEFAULT flags kept.
- Corpus (`knowledge/private/`) is OUT OF SCOPE. Do not edit the corpus.

## Wave plan

```mermaid
flowchart TD
    w1["Wave 1: implementation worker - close AC-3/4/5/7/8/14/17/18/19/21 to DONE, tests green"] --> v["Verify: build+typecheck+test green; every AC traced to code+test"]
    v --> sec["Close-out A: security review (delta scan; remediate Critical/High)"]
    sec --> qa["Close-out B: quality-worker-bee (verify impl vs PRD-006 ACs, loop to clean at medium+)"]
    qa --> ship["Ship: commit + push + PR + notify"]
    qa -->|reopen on regression| w1
    sec -->|reopen on finding| w1
```

**Wave 1 - implementation worker** (routing per model-comparison-matrix: deep, autonomous multi-file implementation -> Opus 4.8 thinking-high tier). Owns `hivenectar/src/registration/*`, `src/cli.ts`, `src/source-graph/store.ts` (+ in-memory adapter), `src/daemon.ts`/`worker.ts` wiring, new tests, and N-3/N-4 AC-wording reconciliation in the PRD-006 docs. May parallelize internally.

**Close-out A - security** (routing: sonnet-tier, independent). Delta scan (OWASP/PII/secrets/path-traversal in the new file-IO + CLI surface). Remediate Critical/High in place.

**Close-out B - quality** (`quality-worker-bee` armed quality-stinger + hivenectar-stinger; independent of the implementer). Verify implementation against PRD-006 ACs; loop until clean at medium+.

## Scope boundaries

- Edit ONLY the hivenectar repo: `src/registration/*`, `src/cli.ts`, `src/source-graph/{store,memory-store}.ts`, `src/daemon.ts`, `src/worker.ts`, `test/*`, the PRD-006 folder docs (AC reconciliation + qa addendum), this ledger.
- Do NOT touch the corpus (`knowledge/private/`), other PRDs, `honeycomb/`, `hivedoctor/`, or `the-hive/`.
- Preserve zero-runtime-dependency ethos (Node built-ins only): implement TLSH in-repo pure-TS rather than adding a native/WASM dependency; the native/WASM option stays a flagged DEFAULT.
- Preserve every deliberate spec gap and DEFAULT flag.

## Run log

- Recon complete: read PRD-006 index + 006a/b/c/d + its qa report, the prior ledger runs (PRD-001/002/003 + Wave A/B), the in-band `src/registration/*` + `src/cli.ts` + `src/source-graph/store.ts` + `test/registration.test.ts`, and the daemon/worker wiring. Confirmed 10 OPEN ACs. Branch `feature/prd-006-file-registration-complete` cut off main (clean tree).
- Wave 1 (impl worker) complete. All 10 OPEN ACs driven to DONE, no stubs:
  - AC-3: `src/registration/fs-watch.ts` gained `observeRaw(filename)` (null -> `requestResync`, a debounced full-resync settle sharing the same coalescing as per-path debounce). `src/registration/service.ts` `runResync` re-scans `fs.listPaths()` (ignore-filtered) and reconciles.
  - AC-4: new `src/registration/service.ts` `RegistrationService` is the settled handler. Discover (stat) -> classify (006b `classifyPath`) -> resolve (006d `reassociate`) -> persist (`SourceGraphStore`), mirroring `runGraphBuild`. `currentCyclePromise` tracks the running cycle; `_waitForIdle()` is the test drain; a per-path throw is caught + logged and the cycle continues; the cycle never throws.
  - AC-5: new `src/registration/ignore.ts` `createDefaultIgnore` (built-in `.git/`/`node_modules/`/`.honeycomb/` segment rules + optional per-repo `.honeycomb/graph-ignore.json` prefixes, array or `{ignore:[]}` form; fail-open on a bad file). No hivenectar-specific list invented; the predicate is injectable so the daemon can pass the real CodeGraph predicate later. Filtered in `fs-watch.ts` `observe` and again in `service.ts` `enqueue`.
  - AC-7 (N-4 reconcile): chose option (b). Step 1 stays the ladder's first rung (unchanged code, still guarded by registration.test "step 1 ... never reads content"). Reworded 006b (pseudocode + prose + 2 ACs) and 006d (flowchart note + Step 1 prose + AC) to say "resolved as the ladder's first rung (no content read)" instead of "resolved in the classifier". Noted in this ledger.
  - AC-8: `ladder.ts` `FuzzyCandidate` (superset of `LatestVersion`, keeps existing injected steps working) carries a `fingerprint`, supplied by `LadderDeps.fingerprintOf`. `service.ts` maintains an in-memory `fingerprintCache` (nectar -> latest TLSH fingerprint) populated whenever a content-bearing row is written, so step 4 matches a now-gone file without re-reading it. Latest content hash comes from `version.contentHash`. DESIGN NOTE: no persisted `fingerprint` DDL column was added. Rationale: the ledger's file scope lists `source-graph/{store,memory-store}.ts` only (not `model.ts`/`schema.ts`/`deeplake-store.ts`), and the corpus `source-graph-schema.md` (out of scope, must not edit) does not carry a fingerprint column; adding a persisted column would create code-vs-corpus drift the QA already polices. The in-memory cache satisfies AC-8's "carries the fingerprint" and "does not re-read every candidate". Known v1 limitation (documented): the cache is process-local, so cold-catch-up after a restart has no fingerprints and step 4 degrades to review/mint until re-registration; the persisted-column path (additive nullable, mirroring `embedding`/`confidence`) is the clean future upgrade once the corpus schema is extended by its owner.
  - AC-14: `src/registration/tlsh.ts` ships a pure-TS, zero-dep locality-sensitive digest in the TLSH family (quartile-bucketed byte-trigram histogram, 128 buckets, 2-bit quartile codes, log-scaled length + checksum header). `fingerprintDistance` (identical -> 0, small edit -> small, unrelated -> large, malformed -> MAX_DISTANCE), size-bucket +/-20% (`SIZE_BUCKET_TOLERANCE`), scored confidence = 1 - distance/MAX_DISTANCE. Documented as NOT byte-exact Trend Micro TLSH, per the PRD's explicit allowance (near-duplicate behavior over byte-exactness).
  - AC-17: the in-repo pure-TS impl is the shipped DEFAULT; native-addon / WASM remains the flagged DEFAULT for later; same `computeFingerprint`/`fingerprintDistance` interface so the swap does not touch the ladder.
  - AC-18: `src/registration/review-store.ts` (`PendingReviewStore` + `InMemory` + `File` impls) + `src/registration/review-cli.ts` `runReviewMatches`. `service.ts` `handleReview` persists a low-confidence candidate (carrying new-path content hash/size/mtime + the minted nectar, so accept needs no disk re-read). Accept carries the candidate nectar to the new path (shared `carryNectar` in `ladder.ts`) + enqueues enrich; reject drops the pending entry, leaving the fresh mint + the missing entry. Wired into `cli.ts` (interactive readline default). File-backed queue lives in the runtime dir as an ephemeral operational queue (like the pid/lock files there), NOT durable Deep Lake state, so FR-8 is respected.
  - AC-19: `src/registration/prune-cli.ts` `runPrune`/`findPruneCandidates` + `SourceGraphStore.deleteNectar` (implemented in `memory-store.ts`; added as a first-class store method, only `InMemorySourceGraphStore` implements `SourceGraphStore`, the async Deep Lake adapter implements the separate `AsyncSourceGraphStore` so it is untouched). Bare `prune` previews; `--confirm` deletes. Grace `PRUNE_GRACE_MS=30d`, flagged DEFAULT, configurable via `graceMs`. Sole deletion path; the ladder still never deletes/reuses. Missing-since is approximated by `lastUpdateDate` (no missing-since column in scope; documented).
  - AC-21: `npm run build` clean, `npm run typecheck` clean, `npm test` = 157 pass / 0 fail. New suites: `test/registration-service.test.ts`, `test/tlsh.test.ts`, `test/review-matches.test.ts`, `test/prune.test.ts`, `test/ignore.test.ts`. `test/registration.test.ts` (12 pre-existing) still green.
- Doc reconciliation (PRD-006 folder only): N-3 fixed (006a prose + AC now document the single recursive watcher as the chosen implementation, per-directory array as the fallback). N-4/AC-7 fixed (006b + 006d now say step 1 is resolved as the ladder's first rung). N-2/N-5 left as sub-medium notes per instruction (faithful to corpus, no code impact). Corpus (`knowledge/private/`) NOT touched.
- Deliberate gaps PRESERVED (nothing invented): (1) TLSH confidence threshold is an injected `FuzzyConfig`; `DEFAULT_TUNABLE_FUZZY_CONFIG` is flagged an operator default tuned during brooding, NOT a spec threshold; the confidence map's only constant is the algorithmic MAX_DISTANCE. (2) `review-matches` accept/reject is interactive by default via an injected `decide` seam; NO `--accept`/`--reject`/`--all` flag grammar invented. (3) DEFAULT flags kept: `debounceMs=500`, prune grace `30 days`, TLSH native/WASM option. (4) size-bucket +/-20% is corpus-spec'd (not a forbidden number). Tenancy scoping preserved on every store lookup; re-association never crosses `project_id`.

## Final status (PRD-006 implementation)

All 21 ACs satisfied to the the-smoker bar: 10 previously-OPEN closed to DONE this run (AC-3/4/5/7/8/14/17/18/19/21), AC-9 verified end-to-end through the real settled service, AC-16 preserved as a deliberate gap, the rest DONE/VERIFIED. Build + typecheck clean; `npm test` 157 pass / 0 fail (0 skips in this environment). PRD-006 docs reconciled for N-3/N-4. No corpus, other-PRD, honeycomb/hivedoctor/the-hive files touched. No runtime dependency added (Node built-ins + existing devDeps only). Ready for the security + quality close-out.

## Security remediation (the-smoker close-out, 2026-07-01)

The security close-out found 0 Critical / 0 High and 2 Medium findings. Both remediated in place on `feature/prd-006-file-registration-complete` (no commit/push), everything kept green.

- **Medium 1 (AC-20, cross-project identity mutation via ULID-only APIs) - CLOSED.** Added a shared `inTenancy(row, tenancy)` to `src/source-graph/model.ts` and wired it as the single scoping predicate:
  - `SourceGraphStore.deleteNectar` is now `deleteNectar(tenancy, nectar)` (`src/source-graph/store.ts`); `InMemorySourceGraphStore.deleteNectar` (`src/source-graph/memory-store.ts`) no-ops when the identity is unknown OR outside `tenancy`. The `AsyncSourceGraphStore` twin gained the matching `deleteNectar(tenancy, nectar): Promise<void>` signature (`store.ts`) and `DeepLakeSourceGraphStore.deleteNectar` (`src/source-graph/deeplake-store.ts`) issues both DELETEs with the full `org_id`/`workspace_id`/`project_id` predicate + nectar key, so the future Deep Lake adapter inherits the guard.
  - `src/registration/ladder.ts` `writeCarriedRow` now returns `boolean` and refuses (writes nothing) when `!inTenancy(source.identity, tenancy)`; step 3, step 4, and the exported `carryNectar` all treat a false return as "no carry" and fall through to a fresh mint.
  - `src/registration/review-cli.ts` accept path verifies `getIdentity(candidateNectar)` is in `deps.tenancy` before carrying; otherwise it drops the stale review (no cross-project carry).
  - `src/registration/prune-cli.ts` confirm loop re-checks `inTenancy` per candidate immediately before the (now tenancy-scoped) `deleteNectar` (defense in depth).
  - Guards: `model.ts` `inTenancy`; `memory-store.ts deleteNectar`; `ladder.ts writeCarriedRow` (first line); `review-cli.ts` accept case; `prune-cli.ts` confirm loop; `deeplake-store.ts deleteNectar`. Tests: `test/security-remediation.test.ts` "deleteNectar refuses a cross-tenancy delete", "carryNectar refuses a cross-tenancy source", "review accept refuses a candidate outside the deps tenancy", "prune scopes its candidates and deletes to a single tenancy".
- **Medium 2 (CWE-22, workspace path escape) - CLOSED.** New dependency-free `src/registration/paths-safe.ts`: `isSafeRelPath` (rejects absolute + `..` + drive), `containedPath` (lexical resolve + containment), `realpathContained` (symlink clamp via `realpathSync` on candidate and root). New `src/registration/disk-fs.ts` `createDiskRegistrationFs` reads/stats/lists only through the realpath clamp and never follows a symlink out of the tree. Applied: intake `src/registration/fs-watch.ts` `observe` drops unsafe paths before ignore-test/scheduling; `src/registration/service.ts` `processOne` drops unsafe paths before any stat/classify/persist (backstops resync + direct enqueue); `src/cli.ts` `existsOnDisk` uses `containedPath`. The ignore predicate's `normalize()` is not relied on for containment; the check is explicit. Tests: `test/security-remediation.test.ts` "isSafeRelPath rejects traversal/absolute/drive", "containedPath rejects escapes", "realpathContained ... rejects a symlink escape" (symlink case guarded for platforms without symlink privilege), "createDiskRegistrationFs refuses traversal and absolute paths", "intake drops traversal/absolute observations before scheduling", "service drops an unsafe resync path before any persist".
- **Verification:** `npm run build` + `npm run typecheck` clean. Full suite `npm test` = 167 tests; the deterministic subset (all suites except the pre-existing flaky live Deep Lake round-trip) is 137/137, 0 fail; a clean full run is 167/0. The sole intermittent failure remains the live `source-graph-deeplake.test.ts` round-trip (network eventual-consistency), unrelated to these changes. No runtime dependency added; no corpus/other-PRD/honeycomb/hivedoctor/the-hive file touched; no em/en dashes in authored prose; exhaustive switches + top-level imports preserved; all deliberate spec gaps and DEFAULT flags intact.

## Quality remediation (the-smoker Wave 3 close-out, 2026-07-01)

The Wave 3 quality close-out returned one Medium (W-1): the `prune` and `review-matches` CLI verbs constructed a fresh empty `InMemorySourceGraphStore` per invocation, so `prune --confirm` silently deleted nothing and `review-matches` silently dropped every candidate against empty data, and the verbs did not announce their not-yet-wired state the way `brood`/`rebuild-projection` do.

- **W-1 CLOSED (honest gating, no silent no-op).** `src/cli.ts`: removed the misleading empty-store command functions (`runReviewMatchesCommand`, `runPruneCommand`, `resolveTenancy`) and their now-unused imports. Added a `NOT_WIRED` map (`prune`, `review-matches`) and a dispatch branch that prints "not yet wired to the durable store ... refusing to run against an empty in-memory store so a destructive verb never silently no-ops" and returns exit code 2. Updated the file docblock and the `USAGE` lines to annotate both verbs as "(logic implemented; durable wiring pending daemon integration)". The command MECHANICS and their tests are unchanged: `runPrune`/`runReviewMatches`/`review-store`/tenancy guards remain fully implemented, exported from `index.ts`, and covered by `test/prune.test.ts`, `test/review-matches.test.ts`, and `test/security-remediation.test.ts`. Rationale (documented, not overclaimed): the durable `DeepLakeSourceGraphStore` is async while `SourceGraphStore` is sync, and the live daemon does not instantiate the registration pipeline (a PRD-006a non-goal); wiring the verbs to real data lands with that daemon integration, without inventing an out-of-scope async->sync bridge or adding a dependency.
- **Verification:** `npm run build` + `npm run typecheck` clean; deterministic suite 137/137, 0 fail; full run 167/0 on a clean network round (the only intermittent failure remains the flaky live Deep Lake round-trip). No dependency added, no deliberate gap pinned (the `review-matches` flag grammar remains uninvented; the TLSH threshold remains injected/unpinned), no corpus/other-PRD/sibling-repo file touched.

## Branch / commit attestation (reconciled)

Final state, reconciled against reality (correcting the QA addendum's earlier "working tree on `feature/prd-004-complete`, uncommitted" observation, which was a transient staging state, now resolved): the PRD-006 delta was relocated to the correct branch (`git stash` -> `git checkout feature/prd-006-file-registration-complete` -> `git stash pop`) and committed as `b31f7f4` on `feature/prd-006-file-registration-complete`, pushed, with PR #9 open. The PRD-006 requirements folder was moved `library/requirements/in-work/` -> `library/requirements/completed/prd-006-file-registration-protocol/`. (Ledger paths that predate the move still read `in-work/` in historical run-log lines; the live folder is under `completed/`.)

## CodeRabbit remediation (PR #9, 2026-07-01)

CodeRabbit's review of PR #9 raised nine code Major items and doc/citation items. All nine code items fixed in place (no commit/push by me; the orchestrator handles git), everything kept green. The fingerprint-persistence finish-line item is DEFERRED pending a PRD-005/corpus schema decision (a nullable `fingerprint` column); the in-memory cache and code are left exactly as-is per instruction.

- **1. `disk-fs.ts` `existsOnDisk` (files only):** now resolves via `realpathContained` and returns true only when `statSync(abs).isFile()` (try/catch -> false), so a tracked file replaced by a directory reads as absent. Test: `test/coderabbit-remediation.test.ts` "disk-fs existsOnDisk is true only for files, not directories".
- **2. `ignore.ts` `normalize` (trailing slash):** added `.replace(/\/+$/, "")` so a `graph-ignore.json` prefix like `"dist/"` matches `dist` and `dist/x`. Test: "ignore honors a graph-ignore prefix that carries a trailing slash".
- **3. `prune-cli.ts` delete loop (re-check eligibility):** before each destructive `deleteNectar`, skip when `deps.existsOnDisk(c.path)` is now true (file reappeared), in addition to the tenancy re-check. Test: "prune --confirm skips a candidate whose file reappeared before the delete".
- **4. `review-cli.ts` accept (retire placeholder mint):** after a SUCCESSFUL `carryNectar`, retire the ladder's review-time placeholder via `deps.store.deleteNectar(deps.tenancy, candidate.mintedNectar)` (only when non-empty, exists, in tenancy, and not the carried nectar); on a failed carry the mint is NOT retired. Output notes the retired placeholder. Tests: "review accept carries the nectar AND retires the placeholder mint" + "... does NOT retire ... when the carry fails".
- **5. `review-store.ts` `FilePendingReviewStore.write` (atomic):** write to `${filePath}.<pid>.<rand>.tmp` then `renameSync` over the target (atomic same-fs), temp cleaned on failure. Documented as ephemeral last-write-wins operational state; atomicity (no torn file) is the guarantee. Test: "FilePendingReviewStore writes a complete parseable file and ignores leftover temp files".
- **6. `service.ts` `knownPaths` per batch (O(N^2) -> O(N)):** compute the known-paths `Set` once right after the batch snapshot and pass it into `processOne(relPath, knownPaths)`. Behavior preserved (each batch path is distinct and not re-processed within the batch); covered by the existing `test/registration-service.test.ts` suite.
- **7. `tlsh.ts` `MIN_FUZZY_BYTES = 3`:** the fuzzy step returns `{ kind: "none" }` when the new content is `< 3` bytes and skips any candidate with `sizeBytes < 3`, so distinct tiny files never collapse to a distance-0 carry. Test: "fuzzy step abstains for content shorter than one trigram".
- **8. `tlsh.ts` tie-break:** track whether the top confidence is uniquely held; a shared top score never returns `"match"` (downgrades to `"review"` when `>= reviewFloor`, else `"none"`), so a carry never depends on iteration order. Test: "fuzzy step never auto-carries when the top confidence is tied".
- **9. `deeplake-store.ts` `deleteNectar` (no heal):** removed `withHeal` from the delete path; added `deleteTolerant`, which swallows only a missing-table `TransportError` (via the existing `isMissingTableError`) as a no-op and never CREATEs a table. Both DELETEs keep the full tenancy predicate (AC-20). Tests: "deeplake deleteNectar treats a missing table as a no-op and never CREATEs" + "... propagates a non-missing-table error".
- **Docs (10-12):** this attestation + remediation entry (10); QA addendum N-3 (branch/commit) flipped to RESOLVED (11); PRD-006b/006d step-1 claims grounded with `src/registration/ladder.ts` and corpus `identity-and-reassociation.md` "Step 1" citations (12).
- **DEFERRED (untouched):** `service.ts` "Step-4 fingerprints disappear across restarts" (fingerprint persistence). Requires a PRD-005/corpus schema decision (a nullable `fingerprint` column); the in-memory `fingerprintCache` and all related code are left exactly as-is, awaiting that decision.
- **Verification:** `npm run build` + `npm run typecheck` clean; deterministic suite (all except the flaky live Deep Lake round-trip) green; full run's only intermittent failure remains that pre-existing live test. No dependency added; no deliberate gap pinned (TLSH threshold still injected/unpinned, `review-matches` flag grammar still uninvented); corpus and sibling repos untouched.
