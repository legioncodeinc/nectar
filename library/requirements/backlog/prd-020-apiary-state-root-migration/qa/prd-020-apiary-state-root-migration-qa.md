# QA Report: PRD-020 Apiary state-root migration

**Plan document:** `library/requirements/backlog/prd-020-apiary-state-root-migration/prd-020-apiary-state-root-migration-index.md` (plus sub-PRDs 020a / 020b / 020c)
**Grounding:** `library/knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md` (Resolved decisions, including the absolute-only env-root amendment)
**Audit date:** 2026-07-04
**Base branch:** `feature/apiary-root-and-activation` (HEAD `d3b19e2`; all implementation changes uncommitted in the working tree)
**Auditor:** quality-worker-bee

Ordering note: `security-worker-bee` ran before this audit per the orchestrator. Its remediations are present in the diff under review: absolute-only env roots (`src/apiary-root.ts:33-35`, `win32.isAbsolute` per the ADR amendment, with a regression test in `test/apiary-root.test.ts`), and the owner-only `0o700` state-dir mode (`src/state-migration.ts:87,125`, `src/registration/brooding-state.ts:176`). No 2026-07-04 security report file exists under nectar `library/qa/security/` (the audit appears to be recorded at the superproject level); noted as an observation, not an ordering violation.

## Summary

Pass with warnings. All four AC groups (index AC-1..8, a-AC-1..6, b-AC-1..7, c-AC-1..6) trace to implementation, and every automatable AC has a named passing test; `npm run build`, `npm run typecheck`, and the non-live suite (62 files, 706 tests, 703 pass / 0 fail / 3 platform-conditional skips) are green. Three Warnings: a present-but-malformed registry file aborts daemon boot inside the migration pass (harsher than the fail-soft boot posture 020b specifies), the registry refresh can briefly advertise a `telemetryDbPath` that does not exist yet when the SQLite move failed, and c-AC-6 (live doctor probe during the coordination window) remains unverified in-repo as the AC itself anticipates. None blocks ship; the first Warning is the one worth fixing before the branch merges.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | Every index / a / b / c AC implemented; all automatable ACs have AC-named passing tests |
| Correctness   | ⚠️ | Two edge-case deviations from 020b/020c posture (boot abort on malformed registry; transient stale `telemetryDbPath` after a failed SQLite move) |
| Alignment     | ✅ | ADR-0005 chain implemented verbatim, including the absolute-only amendment; non-moving surfaces untouched |
| Gaps          | ⚠️ | c-AC-6 deferred to manual/window verification; no explicit AC-8-named no-change assertion (covered by existing suites + inspection) |
| Detrimental   | ✅ | No data-integrity, secret, or build issues found |

## Gate outputs

- `npm run build` (tsc): pass.
- `npm run typecheck` (tsc --noEmit): pass.
- Non-live suite (`node --experimental-sqlite --test` over 62 files, excluding `hive-graph-search-live.test.ts`, `hive-graph-deeplake.test.ts`, `deeplake-transport.test.ts` per the orchestrator): 706 tests, 703 pass, 0 fail, 3 skipped (two POSIX-only permission tests skipped on win32, one symlink-permission skip).

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Malformed registry file aborts daemon boot inside the migration pass**, `src/state-migration.ts:167-178` + `src/daemon.ts:839-856`

  `runStateMigration` performs the c-AC-4 registry refresh via `registerWithDoctor`, which throws `DoctorRegistryError` on a present-but-malformed registry file. The daemon's `start()` calls `runStateMigration` with no try/catch, so a corrupt shared registry (a file any fleet product's installer writes) permanently blocks nectar's boot and prevents the migration marker from ever being written, even though every file move already succeeded. PRD-020b specifies the pass as fail-soft at the file level ("the daemon still boots"); c-AC-4's "fails loudly without being clobbered" is satisfied on the not-clobbering half, but bricking boot goes beyond loud. `test/state-migration.test.ts:225-247` proves the throw and non-clobber; nothing proves the daemon survives it. Recommended: catch the refresh failure in the boot path, log it loudly, boot anyway, and retry on the next boot.

  ```ts
  // src/state-migration.ts:169  (throws DoctorRegistryError upward)
  registerWithDoctor({ config: {...}, registryPath });
  // src/daemon.ts:843  (uncaught in start())
  runStateMigration({ config: {...}, log });
  ```

- [ ] **Registry refresh can advertise a `telemetryDbPath` that does not exist yet**, `src/state-migration.ts:165-178`

  `shouldRefreshRegistry` is true whenever any legacy state exists, including when the telemetry SQLite move FAILED (`failed.length > 0`). The refreshed entry derives `telemetryDbPath` from the new runtime dir (`src/doctor-registry.ts:134-146`), so doctor is pointed at a path that will not exist until the next boot's retry succeeds, while the daemon itself falls back to the legacy DB via `resolveStateReadPath` (`src/daemon.ts:851-855`). This contradicts the 020c implementation note "the registry refresh must run AFTER the telemetry SQLite has moved ... so `telemetryDbPath` never points at a path that does not exist yet". Transient (heals on the retry boot), but doctor would report a missing DB during the window. Recommended: skip or defer the refresh for the entry's DB pointer when `telemetry/nectar.sqlite` is in `failed`.

- [ ] **c-AC-6 unverified in-repo (doctor probe end-to-end during the window)**, `prd-020c-service-unit-and-doctor-registry-adoption.md:54`

  The AC itself calls for "manual or integration verification against a real doctor build during the window"; no evidence of that verification exists in this repo (no integration test, no recorded manual run). The write-side contract (c-AC-3) and refresh mechanics (c-AC-4) are tested, so the risk is contained, but the AC should not be marked done until the cross-repo probe is exercised and recorded (the superproject execution ledger is the natural home).

## Suggestions (consider improving)

- [ ] **Stale `~/.honeycomb` doc comments on moved surfaces**, `src/lock.ts:18`, `src/api/daemon-api-wiring.ts:86`, `src/hive-graph/search.ts:42`, `src/hive-graph/search-types.ts:59`, `src/enricher/config.ts:4,35`

  020a's implementation note asked for the code to stop asserting the superseded shared-dir design; `config.ts` and `config-file.ts` were updated, but these comments still describe `~/.honeycomb/nectar.pid` / `~/.honeycomb/nectar.json` for state that now lives under `~/.apiary/nectar/`.

- [ ] **Service state-dir derivation ignores `NECTAR_RUNTIME_DIR`**, `src/service/index.ts:42-44`, `src/service/templates.ts:31-34`

  `serviceStateDir` / `launchdLogDir` honor only `plan.apiaryHome`, hardcoding `<home>/.apiary/nectar` otherwise. 020c's solution text says the plan should honor `APIARY_HOME` / `NECTAR_RUNTIME_DIR` at install time the same way the daemon does at runtime. No AC requires the `NECTAR_RUNTIME_DIR` leg (c-AC-1/2 test only the default and `APIARY_HOME`), so this is a nice-to-have alignment with the narrative, not a gap.

- [ ] **Failed-SQLite fallback makes the telemetry DB a legacy WRITE target**, `src/daemon.ts:851-855`

  When the SQLite migration fails, `resolveStateReadPath` hands the daemon the legacy DB path and the daemon then writes to it, while 020b states "Writes NEVER target the legacy location after 020a lands. The fallback is read-only." Continuity over purity is a defensible tradeoff here (better than forking telemetry history), but it deserves either a comment acknowledging the exception or a follow-up to converge with the stated rule.

- [ ] **No explicit AC-8-named no-change assertions**, `prd-020a-apiary-root-helper-and-path-adoption.md:60`

  020a asked for the non-moving literals (`DEFAULT_PROJECTION_REL_PATH`, `GRAPH_IGNORE_FILE`, `ALWAYS_IGNORED_SEGMENTS`, the `~/.deeplake` surface) to be listed as explicit no-change assertions. They are unchanged (verified by inspection: `src/projection/format.ts:13`, `src/registration/ignore.ts:44,47`) and pinned indirectly by existing suites, but no test names AC-8.

## Plan Item Traceability

Test names cite the AC they prove; all listed tests pass in the gate run above.

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-1 | Fresh install creates all nectar state under `~/.apiary/nectar/`, nothing nectar-owned in `~/.honeycomb` | ✅ | `src/apiary-root.ts:44-74`, `src/config.ts:112-115`, `src/state-migration.ts:125` | Composed from a-AC/b-AC tests; the registry-entry exception now follows the ADR window contract (new file when the fleet root exists), which supersedes AC-1's "sole exception" wording per c-AC-3 |
| AC-2 | `APIARY_HOME` drives the root; `NECTAR_RUNTIME_DIR` still wins for nectar's state dir | ✅ | `src/config.ts:112-115` | `test/config.test.ts` "a-AC-2 resolveConfig default runtimeDir follows APIARY_HOME/nectar"; `test/apiary-root.test.ts` "a-AC-4" |
| AC-3 | Upgrade migrates the four files; second boot idempotent; no failed-migrate deletion | ✅ | `src/state-migration.ts:118-183` | `test/state-migration.test.ts` b-AC-1 / b-AC-2 / b-AC-3 |
| AC-4 | Crash-safe: no state loss, legacy pid still guards, retry completes | ✅ | `src/state-migration.ts:48-58,85-96` | b-AC-3 / b-AC-4 / b-AC-7 tests |
| AC-5 | Readers fall back to legacy when new absent; post-migration writes land new-only | ✅ | `src/state-migration.ts:28-36`, `src/config-file.ts:96-106`, `src/telemetry-usage/emit.ts:206-248` | b-AC-5 + fixes.test.ts a-AC-5 pair + telemetry-usage a-AC-5 pair; see Suggestion on the failed-SQLite write nuance |
| AC-6 | launchd log dir under the resolved state dir; no `.honeycomb` literal in templates; index.ts creates exactly that dir | ✅ | `src/service/templates.ts:31-34`, `src/service/index.ts:228-233` | `test/service-templates.test.ts` "c-AC-1"; `test/service-index.test.ts` AC-018l.9 (updated) + c-AC-2 |
| AC-7 | Registry entry values carry new paths; file target per window contract | ✅ | `src/doctor-registry.ts:111-116,134-146`, `src/state-migration.ts:165-178` | b-AC-1 registry assertions + doctor-registry c-AC-3 pair |
| AC-8 | Non-moving surfaces byte-identical (`~/.deeplake`, projection path, graph-ignore, segments) | ✅ | `src/projection/format.ts:13`, `src/registration/ignore.ts:44,47` | Verified by inspection + existing suites; no explicit AC-8-named assertion (Suggestion) |
| a-AC-1 | Default root `<home>/.apiary`, state dir `<home>/.apiary/nectar`, never cwd | ✅ | `src/apiary-root.ts:44-69` | `test/apiary-root.test.ts` a-AC-1 + the absolute-only security test |
| a-AC-2 | `APIARY_HOME` flows to all four adoption sites; blank treated as unset | ✅ | `src/config.ts:112-115`, `src/config-file.ts:76-79`, `src/telemetry/db.ts:40-43`, `src/telemetry-usage/emit.ts:169-172` | a-AC-2 tests in apiary-root + config suites |
| a-AC-3 | Linux XDG only when explicitly set; skipped on darwin/win32 | ✅ | `src/apiary-root.ts:53-57` | `test/apiary-root.test.ts` a-AC-3 |
| a-AC-4 | `NECTAR_RUNTIME_DIR` precedence preserved for runtimeDir/pid/lock | ✅ | `src/config.ts:112-115,124-128` | `test/apiary-root.test.ts` a-AC-4 |
| a-AC-5 | Defaults under `~/.apiary/nectar/`; no stray legacy derivation outside the migration/fallback modules | ✅ | `src/apiary-root.ts:72-74` (single source), grep-verified | fixes.test.ts + telemetry-usage.test.ts a-AC-5 tests; `doctor-registry.ts` uses `legacyRuntimeDir` per the c-AC-3 window contract (deliberate) |
| a-AC-6 | Existing test seams behave identically | ✅ | seams unchanged (`options.dir`, `deps.dir`, `overrides.runtimeDir`, `telemetryDbPathForRuntimeDir`) | Proven by the full pre-existing suite passing against the new defaults |
| b-AC-1 | All four files migrate with identical contents; legacy gone; marker written | ✅ | `src/state-migration.ts:118-183` | named test |
| b-AC-2 | Re-run performs no writes / no overwrites | ✅ | `src/state-migration.ts:127-129,136` | named test |
| b-AC-3 | Failed copy leaves legacy intact, no temp as final name, boot survives, retry works | ✅ | `src/state-migration.ts:85-96,138-162` | named test |
| b-AC-4 | Live legacy pid refuses boot; stale legacy pid proceeds | ✅ | `src/state-migration.ts:48-58`, wired at `src/daemon.ts:839-844` | named test |
| b-AC-5 | CLI/config readers fall back transparently, never migrate | ✅ | `src/state-migration.ts:28-36`, `src/cli.ts:664-670` | named test |
| b-AC-6 | Allow-list only; non-nectar legacy files byte-identical | ✅ | `src/state-migration.ts:11-16,133-136` | named test |
| b-AC-7 | Partial migration completes; readers resolve each file from wherever it is | ✅ | `src/state-migration.ts:133-141` | named test |
| c-AC-1 | Plist log paths under `~/.apiary/nectar/logs`; dir created; no `.honeycomb` literal | ✅ | `src/service/templates.ts:31-34,86-90`, `src/service/index.ts:228-233` | named tests |
| c-AC-2 | `APIARY_HOME` at install: log dir under the pinned root; unit carries the env pin | ✅ | `src/service/platform.ts:71-107,230-234`, `src/service/templates.ts:88-116,141-165` | named tests across templates/platform/index suites |
| c-AC-3 | Fresh install entry: new paths; file per window contract; other entries preserved | ✅ | `src/doctor-registry.ts:111-116,261-275` | named tests |
| c-AC-4 | Upgrade refresh idempotent; malformed registry fails loudly, not clobbered | ✅ | `src/state-migration.ts:165-178` | named tests; see Warning on the boot-abort consequence |
| c-AC-5 | Windows LocalSystem opt-in pins the installing user's root | ✅ | `src/service/argv.ts:79-91`, `src/service/templates.ts:177-199` | named tests (argv + templates + index) |
| c-AC-6 | Doctor probe succeeds end-to-end during the window | 🟦 | n/a (cross-repo) | Deferred to manual/integration verification per the AC's own text; not exercised in this repo (Warning). 2026-07-04: the orchestrator accepted this deferral for the migration window (remediation pass); no code change required. |
| NG (index) | `~/.deeplake/`, projection path, graph-ignore, segments untouched; fleet-shared files not moved by nectar | ✅ | `src/state-migration.ts:11-16` allow-list | b-AC-6 test + inspection |

## Files Changed

Implementation files relevant to PRD-020 (the same working tree also carries PRD-019; see that report):

- `library/knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md` (M), mirror re-synced with the resolved decisions + absolute-only amendment
- `src/apiary-root.ts` (A), the `resolveApiaryRoot` / `nectarStateDir` / `legacyRuntimeDir` helper implementing the ADR chain (absolute-only env roots)
- `src/cli.ts` (M), `review-matches` pending-reviews fallback read; daemon wiring (see PRD-019 report)
- `src/config-file.ts` (M), default dir via `nectarStateDir`; legacy fallback read via `resolveStateReadPath`
- `src/config.ts` (M), `resolveConfig` default runtimeDir becomes `nectarStateDir()`; `RUNTIME_DIR_NAME` re-documented as the legacy name
- `src/daemon.ts` (M), boot ordering: legacy-pid guard, migration, telemetry path re-resolution, pending-reviews fallback (plus PRD-019 wiring)
- `src/doctor-registry.ts` (M), `defaultDoctorRegistryPath` implements the ADR registry window contract
- `src/index.ts` (M), exports the apiary-root helper surface
- `src/service/argv.ts` (M), `sc` binPath carries `APIARY_HOME` via cmd wrapper when pinned
- `src/service/index.ts` (M), log/staging dirs derive from the resolved state dir
- `src/service/platform.ts` (M), `ServiceEnvironment`/`ServicePlan` carry the optional installer-pinned `apiaryHome`
- `src/service/templates.ts` (M), `launchdLogDir` under `<state-dir>/logs`; env pin rendered into launchd/systemd/schtasks units
- `src/state-migration.ts` (A), the one-time additive migration, legacy-pid guard, `resolveStateReadPath`, and the c-AC-4 registry refresh
- `src/telemetry/db.ts` (M), `defaultTelemetryDbPath` via `nectarStateDir`
- `src/telemetry-usage/emit.ts` (M), ledger fallback read + new-root-first `install-id` read
- `test/apiary-root.test.ts` (A), a-AC-1..4 + the absolute-only security regression
- `test/config.test.ts` (M), a-AC-2 resolveConfig adoption
- `test/doctor-registry.test.ts` (M), c-AC-3 write-target pair
- `test/fixes.test.ts` (M), a-AC-5 config-file fallback pair
- `test/service-argv.test.ts` (M), c-AC-5 sc binPath pin
- `test/service-index.test.ts` (M), c-AC-2 install render + updated log-dir assertions
- `test/service-platform.test.ts` (M), c-AC-2 plan carry
- `test/service-templates.test.ts` (M), c-AC-1 no-literal scan, c-AC-2 env pins, c-AC-5 task XML
- `test/state-migration.test.ts` (A), b-AC-1..7 + c-AC-4 pair
- `test/telemetry-usage.test.ts` (M), a-AC-5 install-id ordering pair
- `test/telemetry/db.test.ts` (M), default path under `~/.apiary/nectar`
