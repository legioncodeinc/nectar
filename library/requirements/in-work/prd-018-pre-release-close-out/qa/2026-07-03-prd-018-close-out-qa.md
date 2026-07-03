# QA Report: PRD-018 Pre-Release Close-out

> Category: QA Report | Version: 2.0 | Date: July 2026 | Status: Active

**Plan document:** `library/requirements/in-work/prd-018-pre-release-close-out/prd-018-pre-release-close-out-index.md` plus sub-PRDs `prd-018a` through `prd-018l`  
**Execution ledger:** `library/ledger/PRD-018-EXECUTION-LEDGER.md`  
**Security prerequisite:** `library/qa/security/2026-07-03-prd-018-close-out-security-audit.md` confirmed security-worker-bee ran first and remediated its High finding  
**Audit date:** 2026-07-03 (round 1 06:49, round 2 re-verification 07:15+)  
**Base branch:** `main`  
**Head:** `feature/prd-018-close-out` dirty working tree  
**Auditor:** quality-worker-bee

## Revision history

- **2.0 (2026-07-03, round 2):** All four round-1 findings re-verified as remediated (evidence below). Overall verdict revised from FAIL to PASS. Sub-PRD verdicts for 018h, 018i, and 018l revised from FAIL to PASS.
- **1.0 (2026-07-03, round 1):** Initial audit. FAIL with 2 Critical and 2 Warning findings.

## Summary

Overall verdict: **PASS**. Round 2 independently re-verified all four round-1 findings as remediated. The `embed_model` heal now recognizes the live backend's exact missing-column message (pinned by a unit test using the measured message), both live Deep Lake tests actually RAN and PASSED against the real backend (round-trip 25.6s, vector ordering probe 108.5s), docs-lint now executes fenced public-guide commands against `dist/cli.js`, the diff-added dash characters were swept to zero, and the untracked `nul` artifact is gone. No Critical or Warning findings remain.

Independent round 2 verification results: `npm run typecheck` passed cleanly. `npm test` exited 0 with **647 tests, 644 pass, 0 fail, 3 skipped**. The three skips are the documented platform baseline (two Windows-inapplicable permission-mode tests in the telemetry suite and one POSIX-only credentials-permission test); the two live Deep Lake tests appear as PASSING, not skipped, satisfying index AC-3 and AC-6.

## Scorecard

| Category | Status | Notes |
|---|---|---|
| Completeness | PASS | All index-level ACs satisfied; live gates for 018h/018i now run and pass; 018l command lint executes commands |
| Correctness | PASS | `embed_model` heal handles the measured live error shape; live ALTER performed; vector ordering confirmed similar-first on the real backend |
| Alignment | PASS | Deliberate spec gaps preserved; diff-added U+2013/U+2014 characters removed from changed docs |
| Gaps | PASS | Live tests fail loudly on `query`-kind errors after credentials load; skip is reserved for connection/timeout |
| Detrimental | PASS | No deleted tests; `nul` artifact removed; no new regressions observed in the round 2 run |

## Critical Issues (must fix)

None. Both round-1 Criticals are remediated and re-verified:

- [x] **REMEDIATED: Live Deep Lake additive schema heal misses the real `embed_model` error shape (AC-018i.2, index AC-3/AC-6)**, `src/hive-graph/deeplake-heal.ts:49-56,72-90`

  Round 2 verification: `missingColumnName()` now carries a JSON-escaped-quote-tolerant pattern for the live form `column "x" of relation "t" does not exist` (placed first so it wins), and `isMissingTableError()` excludes the column form before matching the relation text, so the ALTER branch fires and the CREATE branch never does. A unit test pinned to the exact measured live message asserts both classifications: `test/hive-graph-deeplake.test.ts:498-509` ("018i.2 the LIVE backend's missing-column error shape heals via ALTER, not CREATE (QA critical)"). The heal performed the live ALTER; the live round-trip test passed against the real table in this run (25602ms).

  ```ts
  // A missing-COLUMN failure on the live backend also mentions the relation
  // ('Column does not exist: column "x" of relation "t" does not exist'), so
  // exclude the column form first or the wrong heal branch (CREATE TABLE)
  // fires and the ALTER never happens (found by the PRD-018 close-out QA).
  if (missingColumnName(err) !== null) return false;
  ```

- [x] **REMEDIATED: Credential-loaded live probes skip on `TransportError` instead of failing (AC-018h.1, AC-018h.2, index AC-6)**, `test/hive-graph-search-live.test.ts:148-152`, `test/hive-graph-deeplake.test.ts:833-836`

  Round 2 verification: both live suites now skip only on `TransportError` kinds `connection` and `timeout`; a `query`-kind error after credentials load propagates and fails the gate, with a comment citing this QA finding. Both live tests ran and passed in this round 2 run: "DeepLakeHiveGraphStore live round-trip" (25602ms) and "018h-AC-1 live Deep Lake vector ordering probe ranks the near vector first" (108506ms), confirming the near vector outranks the far vector against real operator semantics.

  ```ts
  if (err instanceof TransportError && (err.kind === "connection" || err.kind === "timeout")) {
    t.skip(`Deep Lake unreachable, skipping vector ordering probe: ${err.message}`);
    return;
  }
  throw err;
  ```

## Warnings (should fix)

None. Both round-1 Warnings are remediated and re-verified:

- [x] **REMEDIATED: Docs-lint does not prove documented commands exit 0 (AC-018l.2, index AC-7)**, `test/docs-lint.test.ts:113-176`

  Round 2 verification: a new executable layer ("AC-018l.2 (executable) every fenced public-guide command dispatches; local happy paths exit 0") spawns `dist/cli.js` under an isolated HOME with a fake `~/.deeplake/credentials.json` fixture and a real git project fixture. `nectar --help` and `nectar brood --dry-run` assert exit 0 (dry-run also asserts the discovery-source line per AC-018c.11); every other fenced guide command is executed and must dispatch to real mechanics (the output must never contain "unknown command"), with credentialed happy paths delegated to `test/cli.test.ts` verb tests and `daemon`/`install`/`uninstall` excluded with documented pointers to their owning suites. The test passed in the round 2 run.

- [x] **REMEDIATED: Added documentation lines introduced U+2013/U+2014 dash characters**, changed markdown across `library/knowledge/**`

  Round 2 verification: a diff-only scan of added lines (`git diff -U0 -- '*.md'` filtered to `^+` lines containing U+2013 or U+2014) returned zero matches. The ledger records 24 added dash lines across 17 changed docs replaced with hyphens; the independent scan confirms none remain in the diff's added lines.

## Suggestions (consider improving)

- [x] **REMEDIATED: Remove the untracked `nul` artifact before commit**

  Round 2 verification: the file no longer exists at the repo root and no longer appears in `git status --short`.

## Plan Item Traceability

### Program-Level Acceptance Criteria

| ID | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| INDEX-AC-1 | Every NEC-001 through NEC-042 checked off with landed change | PASS | `library/ledger/PRD-018-EXECUTION-LEDGER.md:21-149` | All rows done or waived; round-1 reopened items re-closed with verified remediations |
| INDEX-AC-2 | `npm run typecheck` clean | PASS | `npm run typecheck` | Passed cleanly in round 2 |
| INDEX-AC-3 | Full `npm test` green including sub-PRD tests | PASS | round 2 run: 647 tests, 644 pass, 0 fail, 3 platform skips | Both live Deep Lake tests ran and passed |
| INDEX-AC-4 | Mission leg 2 watch-edit-reassociate integration test | PASS | `test/daemon-watch-integration.test.ts:66-114` | Real `fs.watch` create/edit path covered |
| INDEX-AC-5 | Mission leg 1 brood-kill-resume integration-style tests | PASS | `test/brooding.test.ts:785-974` | Sync and async durability tests present and passing |
| INDEX-AC-6 | Mission leg 3 search-orders-similar-first live test | PASS | `test/hive-graph-search-live.test.ts:65-157` | Ran against the real backend in round 2 (108.5s); near vector ranked first |
| INDEX-AC-7 | Public docs teach only commands that run | PASS | `test/docs-lint.test.ts:113-176` | Executable layer runs guide commands against `dist/cli.js` |

### Sub-PRD Verdicts

| Sub-PRD | Verdict | Failing AC IDs | Notes |
|---|---|---|---|
| 018a daemon lock and lifecycle | PASS | None | Lock ownership, stale reclaim, PID identity, async build, shutdown drain, and service-template evidence spot-checked |
| 018b wire update-on-change | PASS | None | Daemon pipeline construction, StoreBridge, resync, and real watch integration spot-checked |
| 018c watcher robustness and ignore parity | PASS | None | Shared ignore, watcher recovery, directory/case/stat-refresh coverage spot-checked |
| 018d reassociation ladder correctness | PASS | None | TLSH evidence gate and tunable bands preserved; review-store tests present |
| 018e brooding durability and scale | PASS | None | Per-batch, per-solo, throwing embed, async pipeline, and changed-content resume verified |
| 018f brooding batch-call robustness | PASS | None | Transport failure, max token sizing, truncation split, timeout, and positional fallback tests present |
| 018g enricher correctness and concurrency | PASS | None | Version-bump append decision and Jaccard gate wiring verified |
| 018h recall ranking and error honesty | PASS | None | Round 2: live ordering probe ran and passed; skip discipline tightened to connection/timeout only |
| 018i embeddings and projection integrity | PASS | None | Round 2: heal recognizes the measured live error, live ALTER performed, live round-trip passed |
| 018j API security and registry hardening | PASS | None | Scope override refusal, non-loopback open-gate refusal, and registry atomic write evidence spot-checked by tests/security report |
| 018k first-run experience and config | PASS | None | Prereq guidance, health dormancy, `nectar.json` loader, env precedence, and fail-soft warnings spot-checked |
| 018l docs truth pass and cleanup | PASS | None | Round 2: executable command lint added; diff-added dash characters swept to zero |

### Risk-Weighted NEC Sample

| ID | Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| NEC-001 | Update-on-change pipeline constructed by daemon | PASS | `src/daemon.ts:692-735`, `src/registration/store-bridge.ts:63-140` | Pipeline, bridge, fuzzy step, review store, and resync are wired |
| NEC-002 | Failed daemon start cannot delete survivor lock | PASS | `src/lock.ts:249-281`, `test/daemon.test.ts:222-243` | Ownership-checked release and survivor-lock regression present |
| NEC-003 | Brooding persists paid work per batch/solo | PASS | `src/brooding/pipeline.ts:477-612`, `src/brooding/pipeline-async.ts:334-461`, `test/brooding.test.ts:785-974` | Sync and async variants covered |
| NEC-004 | Public docs teach only commands that run | PASS | `test/docs-lint.test.ts:113-176` | Round 2: commands executed, not just grepped |
| NEC-005 | Live `<#>` ordering probe proves similar-first | PASS | `test/hive-graph-search-live.test.ts:65-157` | Round 2: probe ran (108.5s) and the near vector ranked first |
| NEC-017 | Enricher write-back uses version-bump append | PASS | `src/enricher/store-adapter.ts:16-24`, `src/enricher/cycle.ts:197-199` | In-place durable update retired for described writes |
| NEC-026 | Jaccard cosmetic-change gate wired | PASS | `src/enricher/cycle.ts:293-311`, `src/enricher/content-cache.ts:1-16` | Gate uses bounded prior-content cache; cold-boot degradation documented |
| NEC-041 | `~/.honeycomb/nectar.json` loader implemented | PASS | `src/config-file.ts:1-18`, `src/enricher/config.ts:45-58` | Env-over-file precedence and fail-soft loader present |
| NEC-023 | First-run Option A plus guided prompt | PASS | `src/brood-prereqs.ts:76-89`, `src/health.ts:17-24`, `test/fixes.test.ts:235-303` | Missing prereqs surfaced in logs/health and guidance |
| PRD-018i schema | `embed_model` column added via heal | PASS | `src/hive-graph/schema.ts:64-67`, `src/hive-graph/deeplake-heal.ts:49-56,72-90`, `test/hive-graph-deeplake.test.ts:498-509` | Round 2: live message shape recognized; live ALTER performed and round-trip passed |
| Gap preservation | TLSH bands tunable, not pinned | PASS | `src/registration/tlsh.ts:251-271`, `src/daemon.ts:695-698` | Defaults remain in `DEFAULT_TUNABLE_FUZZY_CONFIG` |
| Gap preservation | `review-matches` flag grammar not invented | PASS | `src/cli.ts:987-988`, `src/registration/review-cli.ts` | Existing safe prompt path retained |
| Gap preservation | No symbol/directory nectars minted | PASS | `src/hive-graph/model.ts:31-32`, `src/projection/inherit.ts:41-44`, `src/registration/ladder.ts:452-455` | `directory` remains reserved; writes mint `kind: "file"` |

## Files Changed

The audit ran against a dirty working tree on `feature/prd-018-close-out`. Round 1 measured **127 tracked files changed, 8809 insertions, 952 deletions**, plus untracked PRD-018 close-out artifacts and new source/test files; round 2 additionally touched `src/hive-graph/deeplake-heal.ts`, `test/hive-graph-deeplake.test.ts`, `test/hive-graph-search-live.test.ts`, `test/docs-lint.test.ts`, the 17 dash-swept docs, and the ledger run log. No deleted tracked tests were present in `git diff --name-status`; the round-1 `nul` artifact was removed.

High-level footprint reviewed:

- `src/daemon.ts`, `src/lock.ts`, `src/server.ts`, `src/poll-loop.ts`, `src/service/*`, `src/doctor-registry.ts`: daemon lifecycle, lock, shutdown, service, and registry work for 018a/018j/018l.
- `src/registration/*`: watch pipeline wiring, shared ignore, disk fs, ladder, TLSH, review store, store bridge, debounce, symlink, case, and review-match mechanics for 018b/018c/018d/018l.
- `src/brooding/*`: brooding durability, memory, batch-failure handling, parsing, prompt hardening, docs security remediation, and discovery cleanup for 018e/018f/018l.
- `src/enricher/*`: concurrency guard integration, durable version-bump append, working-set refresh, Jaccard gate, inherited-row re-embed, content cache, and projection trigger for 018g/018i.
- `src/hive-graph/*`, `src/embeddings/*`, `src/api/*`, `src/config-file.ts`, `src/brood-prereqs.ts`, `src/health.ts`: recall error honesty, `embed_model` provenance and live-shape heal, config loader, API hardening, first-run health, limit handling for 018h/018i/018j/018k/018l.
- `test/*.test.ts`: broad regression coverage added or extended, including `test/daemon-watch-integration.test.ts`, `test/docs-lint.test.ts` (now with the executable command layer), `test/hive-graph-search-live.test.ts` (strict skip discipline), `test/store-bridge.test.ts`, and `test/ulid.test.ts`.
- `library/knowledge/**`, `README.md`, `AGENTS.md`: docs truth pass, security prompt-hardening doc sync, and the round-2 dash sweep.
- Untracked: `library/ledger/PRD-018-EXECUTION-LEDGER.md`, `library/qa/security/2026-07-03-prd-018-close-out-security-audit.md`, `src/brood-guard.ts`, `src/brood-prereqs.ts`, `src/config-file.ts`, `src/enricher/content-cache.ts`, `src/registration/store-bridge.ts`, multiple new tests, and this QA report.
