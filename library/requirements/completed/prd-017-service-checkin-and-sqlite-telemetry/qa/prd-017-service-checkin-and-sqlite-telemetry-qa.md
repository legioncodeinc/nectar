# QA Report: PRD-017 Service Check-in and SQLite Telemetry

**Plan document:** `library/requirements/in-work/prd-017-service-checkin-and-sqlite-telemetry/prd-017-service-checkin-and-sqlite-telemetry-index.md` (+ `prd-017a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md`, `prd-017b-service-checkin-and-sqlite-telemetry-metrics-emission.md`, `prd-017c-service-checkin-and-sqlite-telemetry-log-emission.md`)
**Audit date:** 2026-07-02
**Base branch:** `main`
**Head:** `main` @ `09f087b` (implementation landed across `25a4f13`, `3fb6f93`, `ac614b5`, amended in `7d6681b`)
**Auditor:** quality-worker-bee

## Retrospective-audit note

This is a **retrospective** pass: PRD-017 was implemented and merged to `main` ahead of its Wave-0 QA gate (fleet-realignment initiative), so this report audits the already-shipped code rather than gating a pending merge. It is held to the same medium-and-above PASS bar used for PRD-001 through PRD-004. Two post-implementation amendments are SIGNED OFF and accounted for as the current spec, not the stale PRD text: decision #33 (`library/requirements/PRD-DECISIONS-AND-DEFAULTS.md`) amends the heartbeat cadence 10s → **5s** (`DEFAULT_HEARTBEAT_INTERVAL_MS`) and the log retention policy from a 5,000-row cap → a **24h age bound** (`DEFAULT_LOG_MAX_AGE_MS`, timestamp-cutoff rotation). Both amendments are verified as landed in code (`src/telemetry/checkin.ts:39`, `src/telemetry/logs.ts:29`) and are judged against below, not the superseded literal PRD values.

`security-worker-bee` has already run for this cycle (per `library/ledger/EXECUTION_LEDGER.md`'s "Phase 2 close-out, security review" entry): one medium finding against hivenectar (unrestricted telemetry directory permissions) was remediated in commit `3fb6f93` (`mkdirSync(..., { mode: 0o700 })` + a `chmodSync` for pre-existing directories), with a further hardening pass in `ac614b5` (fail-soft health sampling, SQLite handle cleanup on a failed open, broader bearer-token redaction). No ordering violation; this audit proceeds.

## Summary

PRD-017 (service check-in + SQLite telemetry) is **cleanly and completely implemented** against the index PRD's 10 module ACs and all 17 sub-PRD ACs (017a/017b/017c), including both decision-#33 amendments. Every AC traces to concrete code and a passing, AC-labeled test; `npm run typecheck` is clean and the full suite is 247/247 passing (3 expected skips: 2 Windows-only POSIX-mode tests, 1 pre-existing live-Deep-Lake skip unrelated to this PRD). One Warning is raised, not a defect in this PRD's own code but a live-wiring gap it inherits: the registration pipeline (`RegistrationService`/`wrapStoreWithMetrics`) is never constructed on the live daemon boot path (`src/daemon.ts`/`src/cli.ts`), so all five `service_metrics` counters read `0` against a running daemon today, not only the two (`descriptionsGenerated`/`embeddingsComputed`) the implementation's own code comments already flag as dormant pending PRD-007/PRD-016. **Verdict: PASS-with-warnings** at the medium+ bar (the one Warning does not block ship; it is pre-existing, cross-PRD, and already transparently documented in the ledger and in-code comments).

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 10 module ACs + 17 sub-PRD ACs (017a×7, 017b×5, 017c×5) implemented and tested; both decision-#33 amendments (5s heartbeat, 24h log age bound) landed and verified. |
| Correctness   | ✅ | `npm run typecheck` clean; full suite 247/247 passing, 3 expected skips; telemetry-scoped run (68 tests) 66/66 passing, 2 expected Windows skips. |
| Alignment     | ✅ | File layout, naming, and schema match the PRD's "Files expected to change" table and the pinned Contract B schema (`service_status`/`service_metrics`/`service_logs`) byte-for-byte. |
| Gaps          | ⚠️ | All 5 metrics counters are dormant in the live daemon today because the registration pipeline that would drive them is never constructed in `daemon.ts`/`cli.ts`: a PRD-006 wiring gap this PRD inherits, not one it introduces. |
| Detrimental   | ✅ | Fail-soft discipline is thorough and independently tested at every write site (checkin, metrics, log write, log rotation, DB open); no dependency added; SQL is fixed-literal DDL/DML, never interpolated. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **All five `service_metrics` counters are dormant in the live daemon (inherited PRD-006 wiring gap, not a PRD-017 defect)**, `src/daemon.ts:90-149`, `src/cli.ts:142`

  `daemon.ts`'s `assembleDaemon()`/`start()` never constructs a `RegistrationService` or calls `telemetry.wrapStore()` on a live `SourceGraphStore`; `cli.ts:142` calls `assembleDaemon()` with no `jobSource`/handlers that would wire the registration pipeline in. `RegistrationService` and `wrapStoreWithMetrics` exist, are correctly implemented, and are exhaustively unit/integration-tested in isolation (`test/telemetry/metrics.test.ts`), but neither is reachable from a real `hivenectar daemon` process today. AC-4 ("given hivenectar is doing pipeline work, when hivedoctor polls... it observes live metrics") is therefore only provably true in tests, not in production, until a future PRD wires the registration pipeline into daemon boot. The implementation's own code comments in `metrics.ts:152-163` already flag this dormancy for `descriptionsGenerated`/`embeddingsComputed` specifically (correctly attributing it to PRD-007/PRD-016 not existing yet); this finding widens the same observation to all 5 counters, since the root cause is one level higher: the whole pipeline isn't attached to the daemon, not just the two enricher-dependent counters. This is not a regression or omission within PRD-017's own scope (wiring the registration pipeline into daemon startup is PRD-006's job, a non-goal PRD-017 correctly did not attempt), and it is already transparently documented in `library/ledger/EXECUTION_LEDGER.md`'s "QA addendum" note. Recorded here for completeness so a future reader of this report does not have to rediscover it. Suggested: track as a follow-up on whichever PRD ultimately wires `RegistrationService` into `daemon.ts`'s live boot path (likely PRD-006's own integration pass or a later daemon-composition PRD), not as rework on PRD-017.

  ```ts
  // src/daemon.ts:90: assembleDaemon() constructs the worker, telemetry facade,
  // and HTTP server, but never a RegistrationService or telemetry.wrapStore(store).
  export function assembleDaemon(options: AssembleOptions = {}): AssembledDaemon {
    const config = resolveConfig(options);
    ...
    const worker = new HiveantennaeWorker({ source: options.jobSource ?? emptyJobSource, ... });
  ```

## Suggestions (consider improving)

- [ ] **`deeplake_connected`/`deeplake_last_comm` are always NULL**, `src/telemetry/checkin.ts:81-97`

  Documented in the module doc as an intentional approximation (hivenectar's `DeepLakeSourceGraphStore` is a stateless per-call HTTP client with no in-process "am I connected" signal today), and the PRD's own data-model section anticipates this could be populated later without a schema change. No action needed now; noted for a future PRD that adds real Deep Lake connectivity tracking.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-1 | Registry entry declares telemetry SQLite DB path on install | ✅ | `src/hivedoctor-registry.ts:53-121` (`HivedoctorRegistryEntry.telemetryDbPath`, `buildHivenectarRegistryEntry`); `test/hivedoctor-registry.test.ts:35-43` | |
| AC-2 | Runtime status records binding time + initial health, read-only readable | ✅ | `src/telemetry/checkin.ts:63-73` (`CheckinWriter.checkin`); `test/telemetry/checkin.test.ts:18-35`; `test/daemon.test.ts:144-168` | |
| AC-3 | Last-seen advances on heartbeat even when idle | ✅ | `src/telemetry/checkin.ts:75-79`; `test/telemetry/checkin.test.ts:50-69`; `test/daemon.test.ts:202-222` | |
| AC-4 | Hivedoctor observes live metrics from pipeline work without a push | ⚠️ | `src/telemetry/metrics.ts` (writer + `wrapStoreWithMetrics`); `test/telemetry/metrics.test.ts:297-347` (integration proof in isolation) | Mechanism is correctly built and tested; not reachable from the live daemon today (see Warning above). |
| AC-5 | Logs pollable with a verbosity level per row | ✅ | `src/telemetry/logs.ts:80-89`; `test/telemetry/logs.test.ts:25-40` | |
| AC-6 | Restart resets since-restart counters; registry entry/DB path stable | ✅ | `src/telemetry/metrics.ts:73-79` (fresh `MetricsWriter` per `start()`); `src/daemon.ts:136-143`; `test/telemetry/metrics.test.ts:73-94`; `test/daemon.test.ts:170-200` | |
| AC-7 | Telemetry write/open failure is fail-soft, never blocks boot or pipeline | ✅ | `src/telemetry/index.ts:136-147` (`createTelemetry` open-failure fallback); every writer's own try/catch (`checkin.ts:81-97`, `metrics.ts:110-135`, `logs.ts:79-106`); `test/telemetry/checkin.test.ts:93-102`, `metrics.test.ts:96-105`, `logs.test.ts:145-153`, `checkin-service.test.ts:82-105`, `integration.test.ts:51-67` | |
| AC-8 | Log store rotates out old rows once bounded | ✅ | `src/telemetry/logs.ts:91-106` (age-bound rotation, decision #33) | `test/telemetry/logs.test.ts:42-69` |
| AC-9 | Hivedoctor opens DB read-only, WAL mode, no lock contention | ✅ | `src/telemetry/db.ts:84-111` (`PRAGMA journal_mode = WAL`); `test/telemetry/db.test.ts:125-139`; `test/telemetry/integration.test.ts:69-122` (live concurrent reader while hivenectar writes) | |
| AC-10 | No secret/PII/source/description content in any metric or log row | ✅ | `src/telemetry/metrics.ts` (counters only, no free-text column); `src/telemetry/logs.ts:42-58` (redaction + oversized-line drop); `test/telemetry/metrics.test.ts:238-295`; `test/telemetry/logs.test.ts:88-143` | |
| AC-017a.1.1 | Registry entry declares identity + absolute telemetry DB path | ✅ | `src/hivedoctor-registry.ts:101-121`; `test/hivedoctor-registry.test.ts:35-38` | |
| AC-017a.1.2 | Reinstall/upgrade refreshes idempotently, DB path stable, other entries preserved | ✅ | `src/hivedoctor-registry.ts:210-225`; `test/hivedoctor-registry.test.ts:118-133` | |
| AC-017a.1.3 | Present-but-malformed registry fails loudly (`HivedoctorRegistryError`), unchanged from PRD-004 | ✅ | `src/hivedoctor-registry.ts:141-172`; `test/hivedoctor-registry.test.ts:160-179` | Explicitly left different from hivedoctor's own fail-soft posture, per the PRD's own note; behavior verified unchanged. |
| AC-017a.2.1 | Check-in writes binding time + current health, readable read-only | ✅ | `src/telemetry/checkin.ts:69-73`; `test/telemetry/checkin.test.ts:18-35` | |
| AC-017a.2.2 | Health field matches the same `PipelineStatus` `/health` reports | ✅ | `src/daemon.ts:140-143` (`telemetry.startCheckin(() => health.pipelineStatus, ...)`); `test/telemetry/checkin.test.ts:37-48`; `test/daemon.test.ts:144-168` (asserts the live `/health` HTTP response and the checked-in row agree) | |
| AC-017a.3.1 | Heartbeat advances last-seen with no other metric change | ✅ | `src/telemetry/checkin.ts:75-79`; `test/telemetry/checkin.test.ts:50-69`; `test/daemon.test.ts:202-222` | |
| AC-017a.3.2 | Restart: new binding time, registry entry/DB path unchanged | ✅ | `src/daemon.ts:132-143` (fresh `Telemetry`/`CheckinWriter` per `start()`); `test/telemetry/checkin.test.ts:71-91`; `test/daemon.test.ts:170-200` | |
| AC-017b.1.1 | Hivedoctor reads current values for all 5 counters since restart | ✅ | `src/telemetry/metrics.ts:22-28,81-83` (`MetricsSnapshot`); `test/telemetry/metrics.test.ts:41-71` | |
| AC-017b.1.2 | Metrics table is a latest-wins snapshot, not an append log | ✅ | `src/telemetry/metrics.ts:110-135` (single `id=1` upsert); `test/telemetry/metrics.test.ts:23-39,41-71` | |
| AC-017b.2.1 | Each counter increments once per unit of work, no double counting | ✅ | `src/telemetry/metrics.ts:165-185` (`wrapStoreWithMetrics`); `src/registration/service.ts:253-270` (`incrementFilesRegistered` at the ladder completion point); `test/telemetry/metrics.test.ts:107-180,297-347` | |
| AC-017b.3.1 | Restart resets since-restart counters to zero | ✅ | `src/telemetry/metrics.ts:73-79`; `src/daemon.ts:136` (fresh `MetricsWriter` per `start()`); `test/telemetry/metrics.test.ts:73-94`; `test/daemon.test.ts:170-200` | |
| AC-017b.4.1 | No token/credential/source/description/PII in a metrics row | ✅ | `src/telemetry/metrics.ts` (pure-integer columns only); `test/telemetry/metrics.test.ts:238-295` | |
| AC-017c.1.1 | Log rows carry a timestamp and a verbosity level | ✅ | `src/telemetry/logs.ts:80-89`; `test/telemetry/logs.test.ts:25-40` | |
| AC-017c.2.1 | Log table rotates oldest rows out once bounded | ✅ | `src/telemetry/logs.ts:91-106` (age-bound rotation, decision #33: 24h, superseding the original 5,000-row cap) | `test/telemetry/logs.test.ts:42-69` |
| AC-017c.2.2 | Store size bounded by retention policy, not total lines ever emitted | ✅ | Same as above | `test/telemetry/logs.test.ts:42-69` (250 writes, 11 rows survive under a 10s test bound) |
| AC-017c.3.1 | Every log row carries a verbosity level | ✅ | `src/telemetry/db.ts:142-149` (`CHECK (level IN (...))`); `src/telemetry/logs.ts:25-26,110-117` | `test/telemetry/db.test.ts:114-115` (rejects an out-of-set level) |
| AC-017c.3.2 | No token/credential/auth-header/source/description/PII in a log row; unredactable lines dropped | ✅ | `src/telemetry/logs.ts:42-58` (denylist redaction + `MAX_LOG_MESSAGE_LENGTH` drop); `test/telemetry/logs.test.ts:88-143` | |
| Amendment #33.a | Heartbeat cadence amended 10s → 5s | ✅ | `src/telemetry/checkin.ts:31-39` (`DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000`, with rationale comment citing decision #33) | No direct unit assertion of the literal constant, but `test/daemon.test.ts:202-222` and `test/telemetry/checkin-service.test.ts` exercise the interval-driven heartbeat behavior the constant feeds; the value itself is a one-line, low-risk literal, visually confirmed against the decision record. |
| Amendment #33.b | Log retention amended from 5,000-row cap → 24h age bound | ✅ | `src/telemetry/logs.ts:8-9,28-29,91-106` (`DEFAULT_LOG_MAX_AGE_MS`, ts-cutoff `DELETE ... WHERE ts < ?`) | `test/telemetry/logs.test.ts:42-69` (age-bound rotation under sustained writes), `test/telemetry/logs.test.ts:71-82` (fail-soft against a non-parseable clock), `test/telemetry/logs.test.ts:84-86` (asserts the constant equals `24 * 60 * 60 * 1000`) |
| NG-1 | No change to Deep Lake schema/durable nectar state | ✅ | Confirmed: no `source-graph/model.ts` or Deep Lake DDL changes in the PRD-017 commits; telemetry lives only in local SQLite | |
| NG-2 | No sensitive data emitted | ✅ | Covered by AC-10/AC-017b.4.1/AC-017c.3.2 above | |
| NG-3 | Does not build hivedoctor's poller/merge/SoT/SSE | ✅ | Confirmed: no hivedoctor-side code touched in this repo; this repo is the write side only | |
| NG-4 | Does not build a human-facing dashboard/health page | ✅ | Confirmed: no dashboard/UI code added | |
| NG-5 | No push channel from hivenectar to hivedoctor (pull-only) | ✅ | Confirmed: hivenectar only writes to its own local SQLite; no outbound HTTP/SSE client to hivedoctor exists in this repo | |
| NG-6 | Does not replace PRD-004's registration mechanics | ✅ | `src/hivedoctor-registry.ts` extends (not replaces) the existing writer; idempotent-replace and fail-loud-on-malformed behavior is unchanged and re-verified (`test/hivedoctor-registry.test.ts:160-179`) | |

## Files Changed

- `.github/workflows/release.yaml` (M, commit `ac614b5`), split into a read-only gate job and a minimal OIDC publish job; unrelated to telemetry mechanics but landed in the same remediation commit.
- `package.json` (M, commit `25a4f13`), wires `--experimental-sqlite` into `test`/`start`/`daemon` npm scripts.
- `src/cli.ts` (unchanged by PRD-017 itself; confirmed via inspection it never constructs `RegistrationService`, the basis for the Warning above).
- `src/daemon.ts` (M, commit `25a4f13`), wires telemetry check-in/heartbeat/log-tap into `start()`/`shutdown()`, fail-soft throughout.
- `src/hivedoctor-registry.ts` (M, commit `25a4f13`), adds `telemetryDbPath` to `HivedoctorRegistryEntry` and `buildHivenectarRegistryEntry()`.
- `src/index.ts` (M, commits `25a4f13`, `7d6681b`), exports the new telemetry surface.
- `src/registration/service.ts` (M, commit `25a4f13`), adds the optional `metrics` sink and the `incrementFilesRegistered()` call site.
- `src/telemetry/checkin.ts` (A, commit `25a4f13`; M, commits `ac614b5`, `7d6681b`), the check-in/heartbeat writer; amended for decision #33 (5s default) and fail-soft health sampling.
- `src/telemetry/db.ts` (A, commit `25a4f13`; M, commits `3fb6f93`, `ac614b5`), the shared `node:sqlite` plumbing and schema; amended for the 0o700 directory security fix and fail-soft handle cleanup on open failure.
- `src/telemetry/index.ts` (A, commit `25a4f13`; M, commit `7d6681b`), the composed fail-soft `Telemetry` facade.
- `src/telemetry/logs.ts` (A, commit `25a4f13`; M, commits `ac614b5`, `7d6681b`), the bounded log writer and redaction; amended for decision #33 (24h age bound) and broader bearer-token redaction.
- `src/telemetry/metrics.ts` (A, commit `25a4f13`), the metrics snapshot writer and `wrapStoreWithMetrics`.
- `src/service/{argv,index,platform}.ts` (M, commit `7d6681b`), unrelated fleet service-naming amendment (decision #32) landed in the same commit as the telemetry amendments.
- `test/daemon.test.ts` (M, commit `25a4f13`), adds the telemetry-integration daemon tests.
- `test/hivedoctor-registry.test.ts` (M, commit `25a4f13`), adds the `telemetryDbPath` registry tests.
- `test/telemetry/checkin.test.ts`, `test/telemetry/checkin-service.test.ts`, `test/telemetry/db.test.ts`, `test/telemetry/integration.test.ts`, `test/telemetry/logs.test.ts`, `test/telemetry/metrics.test.ts`, `test/telemetry/test-helpers.ts` (A, commit `25a4f13`; several M in `ac614b5`/`7d6681b`), the full telemetry test suite (68 tests).
- `library/requirements/PRD-DECISIONS-AND-DEFAULTS.md`, `PRD-003-016-WAVE-PLAN.md`, `PRD-003-016-DEPENDENCY-MAP.md` (M, commit `7d6681b`), record decisions #29-#33 and the PRD-017 backlog→in-work lifecycle move.
