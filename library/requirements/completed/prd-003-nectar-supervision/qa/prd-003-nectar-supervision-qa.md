# QA Report: PRD-003 Nectar Supervision (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-003 (index + 003a/b/c) against the Nectar knowledge corpus, armed with quality-stinger + hivenectar-stinger. Verified the `/health` + PID/lock contract, the OS service unit, and the registry entry + watchdog-war guards against ADR-0002/0003, `overview.md`, and the cited doctor/honeycomb code.

**Related:**
- [`prd-003-nectar-supervision-index.md`](../prd-003-nectar-supervision-index.md)
- [`../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md`](../../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-003 (the nectar side of the supervision contract) **PASSES** to the medium-and-above standard with no content refine required. The `/health` coarse bit, the single-instance PID/lock, the launchd/systemd/schtasks service units, the OS-service names (decision #23), and the registry entry (3854, `~/.honeycomb/nectar.pid`, decision #19 next-boot supervision) all trace to the corpus, the locked decisions, and the doctor code. It correctly defers the registry schema to PRD-004a and the shutdown mechanism to PRD-002. The systemic honeycomb-link finding (W-1) applies here too.

## 2. Scorecard

| Axis | Status | Note |
|---|---|---|
| Completeness | PASS | 003a (health + PID/lock) + 003b (service unit) + 003c (registry entry + guards) cover the four supervision surfaces named in the index. |
| Correctness | PASS | Port 3854, `nectar.pid`/`.lock`, service names (`com.hivenectar.daemon`/`nectar`/`HivenectarDaemon`), startupGrace 60s, watchdog-war guards match code + decisions #19/#20/#23. |
| Alignment | PASS | Consumes PRD-004a registry; conforms to ADR-0002/0003; per-entry isolated incident state and pidPath guard match `remediation.ts`/`supervisor.ts`. |
| Gaps | PASS | `/health` `checks`-map shape, service unit names, and startupGraceMs flagged DEFAULT; no invented values. |
| Detrimental Patterns | WARNING | honeycomb code refs as markdown links (W-1). |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

**W-1 (systemic, deferred):** honeycomb code references as non-resolving markdown links (e.g. `prd-003b-os-service-unit.md` links `../../../../honeycomb/doctor/src/service/templates.ts` repeatedly; `prd-003c` links `../../../../honeycomb/doctor/src/config.ts`). Same finding and disposition as the consolidated report.

## 5. Suggestions (consider improving)

- **S-1 (structural, resolved in refine):** PRD-003 was missing its `qa/` subfolder. Created.
- **S-2:** `prd-003a-health-endpoint-and-pid-lock.md:43-62` presents a `checks`-map `/health` example and flags it DEFAULT, while PRD-001b (decision #20) locks a richer purpose-built body (brooding/enricher/projection/cost/embeddings/portkey fields). 003a correctly defers the body shape to PRD-001b, but the illustrative `checks` example could be read as a competing shape. Consider replacing the 003a example with a pointer to PRD-001b's locked body to remove any appearance of two shapes. Low severity (003a explicitly says PRD-001b owns the body).
- **S-3:** `prd-003c-registry-entry-and-watchdog-guards.md:56` carries a defensive note warning that "a sibling registry sample elsewhere shows hive's 3853 against the nectar row - that is a typo; the binding value is 3854." The current PRD-004a registry sample correctly uses 3854 for the nectar row, so the note guards against a typo that no longer exists. Harmless (it correctly asserts 3854 is binding) but could be trimmed. Low severity.

## 6. Plan Item (AC) Traceability

| Module AC (index) | Corpus / code source | Verdict |
|---|---|---|
| AC-1 `GET /health` returns 200 ok / 503 degraded coarse bit | 003a; PRD-001b; `server.ts:318-341`, `health.ts:42` | PASS |
| AC-2 writes `nectar.pid`/`.lock`; second start throws before bind | 003a; `assemble.ts:715-732` | PASS |
| AC-3 OS service unit starts on boot, restarts on crash | 003b; `doctor/src/service/templates.ts`, `service/index.ts:129-234` | PASS |
| AC-4 installer appends one registry entry (`healthUrl` 3854, `pidPath` nectar.pid) | 003c; PRD-004a schema; `doctor/src/config.ts` | PASS |
| AC-5 lock-held-and-healthy guard skips restart (no second nectar) | 003c; `remediation.ts:147-151`, `supervisor.ts:236-240` | PASS |

Decisions honored: #19 (next-boot supervision, no hot reload), #20 (purpose-built `/health` deferred to PRD-001b), #23 (OS service names). Defaults flagged: `/health` `checks` shape, service unit names, startupGraceMs.

## 7. Files Audited / Changed

- `prd-003-nectar-supervision-index.md` - audited, corpus-consistent. (audited)
- `prd-003a-health-endpoint-and-pid-lock.md` - audited (see S-2). (audited)
- `prd-003b-os-service-unit.md` - audited, corpus-consistent (carries W-1). (audited)
- `prd-003c-registry-entry-and-watchdog-guards.md` - audited (see S-3). (audited)
- `qa/` - created (was missing). (added)

**Verdict (as-audited): PASS** (medium-and-above), with one systemic Warning (W-1) documented and deferred.

## Remediation addendum (2026-07-01, the-smoker Wave B) — post-remediation verdict: PASS (clean at medium+)

- **W-1 resolved.** The open systemic Warning (honeycomb/doctor code refs as non-resolving markdown links) was remediated by library-worker-bee: 105 cross-repo code citations across `prd-003a` (39), `prd-003b` (38), and `prd-003c` (28) were converted from markdown links to canonical backtick file-path spans (the index carried 0 cross-repo code links). Of these, 60 were short-form spans promoted to the full repo-rooted `honeycomb/...` / `doctor/...` path (line ranges preserved) and 45 were full-form unwraps. Verified: grep for `](.../honeycomb` or `](.../doctor` code-link tokens in the PRD-003 folder returns zero (internal `../prd-004-...` folder links and `~/.honeycomb/...` runtime-path prose correctly untouched); `git diff --check` clean; the change is prose-neutral (no line ranges, numbers, DEFAULT flags, or open-question gaps altered; no new em/en dashes). W-1 is now closed across PRD-001/002/003.
- **Sub-medium (carried forward):** S-2 (003a illustrative `/health` `checks` example vs PRD-001b's locked body) and S-3 (stale defensive 3853/3854 note) remain low-severity suggestions, not blocking.

## Implementation verification addendum (2026-07-01, quality-worker-bee) — post-implementation verdict: PASS (medium-and-above)

**Scope note.** The audit above verified the PRD's *content* against the corpus before any AC-3/AC-4 code existed. This addendum is the distinct implementation-verification pass: it audits the branch `feature/prd-003-nectar-supervision` (worktree `hivenectar-worktrees/prd-003-nectar-supervision`) — the actual `src/service/*.ts`, `src/doctor-registry.ts`, and `src/cli.ts`/`src/index.ts` wiring — against this same PRD-003 index + 003a/b/c, per the security-then-quality ordering. A security review already ran against this branch and reported no medium+ findings, so this pass proceeds per the standard ordering.

### Verification method

- Read every new/changed source file (`src/service/{platform,templates,argv,command-runner,index}.ts`, `src/doctor-registry.ts`, the `src/cli.ts`/`src/index.ts` diffs) and every new test file.
- Cross-referenced the sibling `doctor` repo (`c:\Users\mario\GitHub\the-apiary\doctor\src\service\{platform,templates,argv,index}.ts`, `src/config.ts`, `src/registry.ts`, `src/remediation.ts`, `src/compose/index.ts`) line-by-line against the "mirrors" claims in the PRDs and in the code's own doc comments.
- Independently ran `npm run build && npm run typecheck && npm test` in the worktree (not just re-read the invoker's claimed numbers).
- Confirmed AC-1/AC-2 (unchanged in this branch, delivered under PRD-002) by re-reading `src/health.ts`, `src/lock.ts`, `src/server.ts`, `src/daemon.ts` against PRD-001b's locked body shape and PRD-003a's lock-guard contract.

### Independent verification run

```
npm run build       -> exit 0
npm run typecheck    -> exit 0
npm test             -> tests 124, pass 123, fail 0, cancelled 0, skipped 1, todo 0
```

The one skip is `DeepLakeHiveGraphStore live round-trip` (`test/hive-graph-deeplake.test.ts`), which self-reports "Deep Lake unreachable, skipping live round-trip" — a pre-existing, environment-gated skip unrelated to PRD-003. Matches the invoker's reported numbers exactly.

### AC / User-story traceability (this branch's code)

| ID | Criterion | Evidence | Verdict |
|---|---|---|---|
| AC-1 | `/health` 200 ok / 503 degraded coarse bit | `src/server.ts:35-46` (route + `healthHttpStatus` gate), `src/health.ts:12,110-112` — unchanged in this branch, delivered under PRD-002; body shape matches PRD-001b's locked `brooding`/`enricher`/`projection`/`cost`/`embeddings`/`portkey` fields exactly (`src/health.ts:14-43`) | PASS (pre-existing, reverified) |
| AC-2 | writes `nectar.pid`/`.lock`; second start throws before bind | `src/lock.ts:66-108`, `src/daemon.ts:83-98` (lock acquired at line 88, before `server.listen()` at line 95) — unchanged, delivered under PRD-002; `test/lock.test.ts` + `test/daemon.test.ts` exercise it | PASS (pre-existing, reverified) |
| AC-3 | OS service unit starts on boot, restarts on crash | `src/service/templates.ts` (`renderLaunchdPlist`/`renderSystemdUnit`/`renderScheduledTaskXml` all encode `RunAtLoad`/`WantedBy`/`LogonTrigger` + `KeepAlive`/`Restart=always`/`RestartOnFailure`), `src/service/index.ts:136-237` (`createServiceModule`), wired via `nectar install`/`uninstall`/`service-status` in `src/cli.ts:48-94`; `test/service-templates.test.ts`, `test/service-platform.test.ts`, `test/service-argv.test.ts`, `test/service-index.test.ts` | PASS |
| AC-4 | installer appends one registry entry (`healthUrl` 3854, `pidPath` nectar.pid) | `src/doctor-registry.ts:73-91` (`buildNectarRegistryEntry`), `:180-195` (`registerWithDoctor`, idempotent replace-by-name, fail-loud on a malformed file), wired in `src/cli.ts:48-73` (`runInstall`); `test/doctor-registry.test.ts` (6 cases incl. create/append/idempotent-replace/malformed-fail-loud) | PASS |
| AC-5 | lock-held-and-healthy guard skips restart (no second nectar) | Verified against the already-generic, already-shipped doctor mechanism: `doctor/src/remediation.ts:132-160` (`createRestartRung`, cooldown guard then lock-held-and-healthy guard, in that order) and `doctor/src/compose/index.ts:543-546` (`readDaemonPid: () => readDaemonPid(entry.pidPath)`, built **per registry entry**) — this is genuinely entry-scoped, so once nectar's entry (AC-4) lands in the registry, the guard reads `~/.honeycomb/nectar.pid`, not honeycomb's default, with **no doctor-side code change required**. No doctor commit exists on this branch, correctly | PASS (verified by reading the already-generic mechanism, not by a nectar-side or doctor-side code change) |

| User story | Evidence | Verdict |
|---|---|---|
| US-003a.1-4 | Unchanged this branch (PRD-002); reverified against `src/health.ts`, `src/lock.ts`, `src/daemon.ts` | PASS |
| US-003b.1 (restart-on-crash per platform) | `src/service/templates.ts` — `KeepAlive`+`ThrottleInterval=5` (launchd), `Restart=always`+`RestartSec=5` (systemd), `RestartOnFailure`+`Interval=PT1M`+`Count=999` (schtasks XML); asserted in `test/service-templates.test.ts:30-60` | PASS |
| US-003b.2 (start-on-boot per platform + exec's `daemon` verb) | `RunAtLoad`/`WantedBy=default.target`/`LogonTrigger` in the same templates; `NECTAR_RUN_COMMAND = "daemon"` (`src/service/templates.ts:23`) correctly diverges from doctor's `"run"` everywhere it is used, including the `sc.exe` `binPath` construction in `src/service/argv.ts:69` (`"${plan.execPath}" daemon`) — not a blind copy-paste | PASS |
| US-003b.3 (user scope default, no root/admin; unsupported platform is clean) | `src/service/platform.ts:150-183` (`resolveServicePlan`, fallback ordering identical to doctor's), `src/service/index.ts:149-158` (unsupported platform maps to `ok:false`, not a throw); `test/service-platform.test.ts` covers darwin/linux/win32 default + system-scope-fallback + unsupported-platform-throws | PASS |
| US-003b.4 (uninstall removes unit, does not resurrect) | `src/service/index.ts:197-235` (`uninstall`: runs uninstall argv, always removes the unit file even on a manager-command failure); `test/service-index.test.ts:93-119` | PASS |
| US-003c.1 (installer registers, does not restart doctor) | `src/cli.ts:48-73` (`runInstall` calls `registerWithDoctor`; no call anywhere restarts or HTTP-calls doctor) | PASS |
| US-003c.2 (rung reads nectar's own pidPath, probes nectar's own `/health`) | Delivered generically by `doctor/src/compose/index.ts:543-546` once AC-4's entry exists in the registry; confirmed the per-entry wiring is real (not a hard-coded honeycomb default) | PASS |
| US-003c.3 (skip does not increment failure count) | `doctor/src/remediation.ts:147-151` (`skipped: true`, `detail: "lock-held-and-healthy"`) — pre-existing generic mechanism, correctly not duplicated in nectar | PASS |
| US-003c.4 (cooldown is entry-local) | `doctor/src/remediation.ts:107-122` (`RestartRungDeps.lastRestartAt`/`markRestarted` injected per rung), built once per entry in `compose/index.ts` | PASS |

### Fidelity-to-pattern check (mirrors doctor, not blind copy)

Diffed nectar's `src/service/{platform,templates,argv,index}.ts` line-by-line against doctor's `src/service/{platform,templates,argv,index}.ts`. The structural mirror is exact (same function shapes, same guard ordering, same crash-safe posture); every place the two packages *should* diverge, they correctly do:

| Constant/behavior | nectar (this branch) | doctor (mirrored pattern) | Correct? |
|---|---|---|---|
| Service label | `com.hivenectar.daemon` | `com.legioncode.hivedoctor` | Diverges correctly |
| systemd unit name | `hivenectar.service` | `hivedoctor.service` | Diverges correctly |
| Windows task name | `HivenectarDaemon` | `HiveDoctor` | Diverges correctly |
| Run verb (unit exec + `sc` binPath) | `daemon` (`templates.ts:23`, `argv.ts:69`) | `run` | Diverges correctly everywhere, incl. the easy-to-miss `sc.exe` binPath string |
| `RESTART_SEC` / `WINDOWS_RESTART_INTERVAL` | `5` / `PT1M` | `5` / `PT1M` | Correctly identical (platform constraint, not per-daemon) |
| `healthUrl` port | `3854` (`src/config.ts:17`) | `3850` default | Diverges correctly |
| `pidPath` file name | `nectar.pid` (`src/config.ts:26`) | `daemon.pid` default | Diverges correctly |
| `startupGraceMs` | `60_000` (`src/doctor-registry.ts:50`) | `60_000` default | Correctly identical (PRD-003c default resolves to the doctor default) |
| `restartGiveUpThreshold` / `restartCooldownMs` | `3` / `5_000` | `3` / `5_000` | Correctly identical (per-daemon default, per PRD-003c table) |

No DEFAULT-flagged value from the sub-PRDs was altered, invented, or silently dropped; every one traces to a named constant with a citation back to the PRD or the mirrored doctor constant.

### Critical Issues (must fix)

None.

### Warnings (should fix)

**W-2: The schtasks XML-staging branch and the darwin/win32 install-uninstall integration paths are untested through `createServiceModule`.** `src/service/index.ts:162-176` computes the staged unit-file path for schtasks when `unitPath` is empty (`unitTarget = `${p.home}/.honeycomb/nectar/nectar-task.xml``) — this exact branch has no test coverage anywhere in the suite. `test/service-index.test.ts` constructs every `createServiceModule` call with `linuxEnv()` only (lines 41-49, and every call site through the file); the darwin/launchd and win32/schtasks paths are exercised only at the unit level (`resolveServicePlan` in `service-platform.test.ts`, `renderUnit`/`installCommands` in `service-templates.test.ts`/`service-argv.test.ts` taking a plan directly), never through the full `install()`/`uninstall()` integration that exercises the fs-write + argv-execution sequence together. This matters specifically because the untested branch is the one place nectar's `unitTarget` can diverge from `plan.unitPath` (schtasks only) — exactly the scenario doctor's own equivalent suite tests explicitly (`doctor/tests/service/service-module.test.ts:60-78`, "Windows: stages the Scheduled Task XML beside the workspace, then schtasks /Create"). Recommend porting an equivalent darwin + win32/schtasks case into `test/service-index.test.ts` (asserting the staged XML path and that `fs.writeFile` receives the rendered template, mirroring the linux case already there). Not blocking: the staging logic is a five-line, directly-readable branch, and its two collaborators (`renderUnit`, the argv builders) are independently well-tested; a code-review pass finds no defect in it. Flagging as should-fix, not must-fix.

### Suggestions (consider improving)

- **S-4:** No test exercises `src/cli.ts`'s `install`/`uninstall`/`service-status`/`daemon` dispatch or `runInstall`'s registry-then-service message composition directly (only the underlying `service/index.ts` and `doctor-registry.ts` modules are unit-tested). This is consistent with the pre-existing repo convention (no `cli.ts` test exists for any other command either), so it is not a regression introduced by this branch — noting it as a general opportunity, not specific to PRD-003.
- **S-5:** `src/service/argv.ts:71` builds the Windows `sc create` `binPath=` argument as `binPath=${binPath}` (no space after `=`) — this is copied verbatim from `doctor/src/service/argv.ts:88` and preserved faithfully rather than altered, which is the correct behavior for a fidelity audit (a silent "improvement" here would itself be a spec deviation). `sc.exe`'s own syntax historically wants a literal space after `binPath=`; if this is in fact a latent bug, it lives in doctor's own code first, predates this branch, and is out of scope for a nectar-side fix (the `sc` system-scope path is also the least-used one — the Windows default is `schtasks`, per US-003b.3). Surfacing for the user's awareness only; no code change recommended here.
- **S-2, S-3 (carried forward from the corpus-conformance pass):** unchanged, still low severity, still not blocking.

### Files audited (this pass)

- `src/service/platform.ts`, `src/service/templates.ts`, `src/service/argv.ts`, `src/service/command-runner.ts`, `src/service/index.ts` — audited against `doctor/src/service/{platform,templates,argv,index}.ts`. (audited, no changes made)
- `src/doctor-registry.ts` — audited against `doctor/src/registry.ts`, `doctor/src/config.ts`. (audited, no changes made)
- `src/cli.ts`, `src/index.ts` — audited for wiring + export completeness. (audited, no changes made)
- `src/health.ts`, `src/lock.ts`, `src/server.ts`, `src/daemon.ts` — reverified (unchanged this branch) against PRD-001b/003a. (audited, no changes made)
- `test/service-platform.test.ts`, `test/service-templates.test.ts`, `test/service-argv.test.ts`, `test/service-index.test.ts`, `test/doctor-registry.test.ts` — read in full; ran via `npm test`. (audited, no changes made)
- No source-behavior changes were made by this QA pass, per instruction; W-2/S-4/S-5 are reported back to the invoker rather than fixed.

**Verdict (this implementation-verification pass): PASS** (medium-and-above), with one Warning (W-2, test-coverage gap, should-fix) and two new Suggestions (S-4, S-5) documented. AC-1 through AC-5 and every US-003a/b/c acceptance line are genuinely implemented and code-verified, not merely claimed. The security-then-quality ordering was respected (security review already ran with no medium+ findings before this pass began).

### Remediation (2026-07-01, post-QA) — W-2 closed

Added four integration-level cases to `test/service-index.test.ts`, exercising the exact gap W-2 flagged: darwin install (asserts the launchd plist is written to `~/Library/LaunchAgents/com.hivenectar.daemon.plist` and `launchctl bootstrap`+`kickstart` run) and uninstall (`bootout` + plist removal), and win32/schtasks install (asserts the XML is staged at `~/.honeycomb/nectar/nectar-task.xml` when `plan.unitPath` is empty, and `schtasks /Create` + `/Run` run against that exact path) and uninstall (`/Delete` + staged-XML removal) — mirroring doctor's own equivalent coverage. Re-ran `npm run build && npm run typecheck && npm test`: 128 tests, 127 passed, 0 failed, 1 pre-existing environment-gated skip (unchanged). W-2 is now **Resolved**; S-4 and S-5 remain open as non-blocking suggestions (S-4 is a pre-existing repo-wide convention gap, not a regression; S-5 documents a doctor-owned fidelity note, out of scope for a nectar-side change).
