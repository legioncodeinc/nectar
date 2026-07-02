# PRD-017: Nectar Service Check-in and SQLite Telemetry Emission

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None to Deep Lake. Additive local SQLite tables for non-sensitive telemetry (metrics, logs) plus a runtime status entry recorded through doctor's registration surfaces.

---

## Overview

The fleet realignment makes doctor the supervisor and single source of truth for fleet telemetry, and hive portal the only human-facing surface. Under that model every service, including nectar (the hive-graph "nectar" workload daemon on `127.0.0.1:3854`), is a supervised participant: it must announce itself to doctor and expose its own non-sensitive telemetry in a place doctor can poll cheaply. Two locked doctor decisions govern how that happens: `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` (services write non-sensitive telemetry to their own local SQLite, doctor polls on roughly a one-second interval plus a `/health` probe and is the sole source of truth relaying one SSE to hive, with no service-to-doctor SSE) and `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` (a static installer registry declares who should exist and where each service's SQLite database lives, while each service writes runtime status such as check-in, binding time, last-seen, and health into its runtime SQLite for doctor to merge).

Nectar is partway there. From PRD-004's registration work it already ships a doctor registry writer, `src/doctor-registry.ts` (`registerWithDoctor()`, `buildNectarRegistryEntry()`), that appends or idempotently replaces one entry keyed by `name: "nectar"` in `~/.honeycomb/doctor.daemons.json`, carrying `healthUrl`, `pidPath`, and the probe and restart fields. What nectar does not yet do is record its runtime telemetry SQLite database path in that registry entry, write a runtime status row (binding time, last-seen heartbeat, current health), or emit metrics and logs to a local SQLite surface shaped for doctor's poller.

This PRD closes that gap. It makes nectar a first-class supervised service: it extends the existing registry writer to record its SQLite database path and writes runtime check-in status per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`, and it writes non-sensitive metrics and logs to its own local SQLite for doctor to poll per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. It reuses nectar's built-ins-only ethos: the telemetry store uses Node's built-in `node:sqlite` (available on Node >=22.5 behind `--experimental-sqlite`), so no external dependency is added, mirroring honeycomb's local-queue precedent. This is the nectar sibling of honeycomb's PRD-071 and follows the same contract.

---

## Goals

- Extend nectar's existing doctor registry writer (`src/doctor-registry.ts`) so its registry entry also records the on-disk path to nectar's runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`.
- Write and refresh nectar's runtime status (binding time, last-seen heartbeat, current health) so doctor can merge a live view of nectar without nectar pushing to doctor.
- Emit non-sensitive metrics to nectar's own local SQLite: files registered, nectars minted, descriptions generated, hive-graph versions written, and embeddings computed, all since the last restart.
- Emit non-sensitive logs, carrying a verbosity level, to nectar's own local SQLite, bounded and rotated so the store never grows without limit.
- Use Node's built-in `node:sqlite` for the telemetry store so nectar adds no external dependency, consistent with its built-ins-only design and doctor's minimal-footprint ethos.
- Keep the telemetry and check-in write path fail-soft so a telemetry error never blocks the nectar pipeline or daemon boot, aligning with doctor's fail-soft posture even though the existing registry writer fails loudly on a present-but-malformed registry file.

## Non-Goals

- Any change to the two Deep Lake tables (`hive_graph`, `hive_graph_versions`) or to durable nectar state. Telemetry lives only in local SQLite and is an operational, non-durable, non-sensitive surface, so it does not violate FR-8 (durable state goes in Deep Lake, not sidecars).
- Emitting sensitive data: no tokens, credential values, raw authorization headers, org secrets, source-file contents, LLM description bodies, or PII in metrics or logs (per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`).
- Building the poller, the merge, the single source of truth, or the SSE to hive. Those belong to doctor (PRD-001 and PRD-002) and hive (PRD-005).
- Building any human-facing dashboard or health page. The read surface is hive's job.
- A push channel from nectar to doctor. Transport is pull, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.
- Replacing PRD-004's registration mechanics. This PRD extends the existing registry entry and adds runtime status, it does not re-specify how the registry file is edited at install.

---

## Code-grounded current state

| Area | Current code fact | Implication for this PRD |
|---|---|---|
| Registry writer already ships | `src/doctor-registry.ts` exposes `registerWithDoctor()` and `buildNectarRegistryEntry()`, writing an entry with `name`, `healthUrl`, `pidPath`, and the probe and restart fields to `~/.honeycomb/doctor.daemons.json`, idempotently keyed by `name: "nectar"`. | This PRD extends the `DoctorRegistryEntry` shape and the writer to also record the runtime telemetry SQLite database path, rather than introducing a second registration path. |
| Registry writer fails loud on malformed input | `readExistingRegistry()` throws `DoctorRegistryError` on a present-but-unparseable registry, deliberately refusing to clobber a real misconfiguration. | The new runtime status and telemetry writes are additive and fail-soft, so they do not weaken the existing fail-loud guard on the install-time file edit, but they never propagate a telemetry error into boot or the pipeline. |
| Built-ins only, no external deps | Per AGENTS.md, the daemon uses only `node:http`, `node:fs`, `node:net`, and `node:os`, with `typescript` and `@types/node` the only devDependencies. | The telemetry store uses Node's built-in `node:sqlite` (Node >=22.5, `--experimental-sqlite`), a built-in and not an external dependency, keeping the zero-runtime-dependency posture intact. |
| Daemon binds loopback, serves `/health` | The daemon binds `127.0.0.1:3854` and serves `/health` from `src/health.ts` (`PipelineStatus`) and `src/server.ts`. | The runtime status row's health field derives from the same health source doctor's `/health` probe reads, so the polled status and the probe never disagree. Telemetry is a local file read by doctor read-only, adding no network exposure. |
| Nectar pipeline produces countable work | Nectar registers files, mints daemon-minted ULID nectars, generates LLM descriptions (the enricher and brooding loop), writes `hive_graph_versions`, and computes embeddings across PRD-006, PRD-007, PRD-016, PRD-005, and PRD-014. | These pipeline stages are the natural non-sensitive since-restart metric set. Exact counter identifiers are not asserted here as existing symbols and are marked DEFAULT (confirm before implementation). |
| Durable state discipline | AGENTS.md and FR-8 require durable state in Deep Lake, not sidecars; `.honeycomb/nectars.json` is a regenerable projection, not a sidecar. | Telemetry is operational, non-durable, and non-sensitive, so it follows the local-SQLite precedent (like honeycomb's local queue), not the Deep Lake durable-state rule. |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-017a-check-in-and-registration`](./prd-017a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md) | Extend the existing `src/doctor-registry.ts` entry to record the SQLite DB path, plus runtime status writes: binding time, last-seen heartbeat, current health, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` | Draft |
| [`prd-017b-metrics-emission`](./prd-017b-service-checkin-and-sqlite-telemetry-metrics-emission.md) | Non-sensitive metrics to local SQLite: files registered, nectars minted, descriptions generated, hive-graph versions, embeddings computed, all since restart, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` | Draft |
| [`prd-017c-log-emission`](./prd-017c-service-checkin-and-sqlite-telemetry-log-emission.md) | Non-sensitive logs to local SQLite with verbosity levels, bounded and rotated, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given nectar is installed, when the installer runs its registration path (`registerWithDoctor()`), then nectar's static registry entry declares its identity and the on-disk path to its runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. |
| AC-2 | Given nectar starts and binds `127.0.0.1:3854`, when it checks in, then its runtime status records a binding time and an initial health value that doctor can read read-only. |
| AC-3 | Given nectar is running, when the heartbeat interval fires, then the last-seen value advances even if nothing else changed, so doctor can distinguish quiet from dead. |
| AC-4 | Given doctor polls nectar's local SQLite on its interval, when nectar is doing pipeline work, then doctor observes live metrics (files registered, nectars minted, descriptions generated, hive-graph versions, embeddings computed, since restart) without nectar pushing anything. |
| AC-5 | Given nectar emits logs, when doctor polls the log table, then it sees recent non-sensitive log lines each carrying a verbosity level. |
| AC-6 | Given nectar restarts, when the since-restart counters are next read, then they have reset to reflect the new process lifetime while the registry entry and DB path remain stable. |
| AC-7 | Given the telemetry SQLite write fails or is unavailable, when nectar runs, then the nectar pipeline and daemon boot are unaffected and the failure is fail-soft. |
| AC-8 | Given the log store reaches its bound, when new logs are written, then old rows are rotated out so the store stays bounded. |
| AC-9 | Given doctor reads nectar's SQLite, when it opens the database, then it does so read-only and observes no lock contention that stalls nectar's own writes (WAL mode, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`). |
| AC-10 | Given any metric or log row, when it is written, then it contains no token, credential value, raw authorization header, org secret, source-file content, LLM description body, or PII. |

---

## Data model changes

No Deep Lake schema change. This PRD adds local telemetry surfaces in nectar's own SQLite (Node's built-in `node:sqlite`), plus a runtime status entry recorded through doctor's registration surface.

- Runtime status (per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`): nectar's check-in record carrying binding time, last-seen heartbeat, and current health. doctor merges this with the static registry entry. Detailed in PRD-017a.
- `nectar_metrics` (local SQLite, latest-wins snapshot): counters since restart such as files registered, nectars minted, descriptions generated, hive-graph versions written, and embeddings computed. Detailed in PRD-017b.
- `nectar_logs` (local SQLite, bounded and rotated): non-sensitive log lines with a timestamp and a verbosity level. Detailed in PRD-017c.

The static registry entry (extended from `DoctorRegistryEntry` in `src/doctor-registry.ts`) records nectar's identity and the absolute path to the local SQLite database so doctor knows where to poll, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. doctor opens that database read-only, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.

---

## Files expected to change

| File | Expected change |
|---|---|
| `src/doctor-registry.ts` | Extend `DoctorRegistryEntry` and `buildNectarRegistryEntry()` to record the runtime telemetry SQLite DB path in nectar's entry, preserving the existing idempotent-replace and fail-loud-on-malformed behavior, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. |
| New `src/telemetry/` module | Local SQLite telemetry writer (metrics snapshot, bounded log table) built on Node's built-in `node:sqlite`, and a check-in / heartbeat writer for the runtime status row. |
| Pipeline touchpoints (file registration, minting, enricher/brooding, versions, embeddings) | Increment the since-restart counters on the existing pipeline paths without changing pipeline behavior. Exact counter wiring is DEFAULT, confirm before implementation. |
| `src/health.ts` / `src/server.ts` (read-only consumption) | Source the current health value for the check-in record from the same `PipelineStatus` signal `/health` reports; no behavior change to `/health` itself. |
| `test/telemetry/` | Cover the DB-path registry extension, metrics snapshot mapping, log rotation bound, heartbeat advance, since-restart reset, fail-soft, and no-sensitive-data assertions. |

---

## Test plan

- Unit: the extended registry entry records the SQLite DB path and remains idempotent on re-registration (AC-1), preserving the existing fail-loud-on-malformed guard.
- Unit: check-in records binding time and a health value matching the `PipelineStatus` source (AC-2).
- Unit: the heartbeat advances last-seen on interval even with no other change (AC-3).
- Unit: a restart resets the since-restart counters while the registry entry and DB path are unchanged (AC-6).
- Unit: the log table rotates when it reaches its bound (AC-8).
- Unit: telemetry write failure is fail-soft and does not throw into the pipeline path (AC-7).
- Unit: no row contains sensitive material (AC-10), asserted against a denylist of secret-shaped fields and source or description bodies.
- Integration: a doctor-style read-only reader opens nectar's SQLite in WAL mode and reads metrics and logs while nectar continues writing without lock stalls (AC-9).
- Live proof: install nectar, confirm the registry entry and DB path exist, start the daemon, and confirm an external read-only poll sees binding time, advancing last-seen, live metrics, and recent logs.

---

## Open questions

- [ ] Should the runtime status row live in the same local SQLite database as metrics and logs, or a dedicated status file that doctor's registry merge reads first? Leaning toward one database with separate tables to keep a single DB path in the registry.
- [ ] Heartbeat cadence: match doctor's roughly one-second poll, or run slower to reduce write churn given the poll is what drives freshness?
- [ ] Metric source of truth: which existing pipeline symbols (if any) expose files registered, nectars minted, descriptions generated, hive-graph versions, and embeddings computed, versus adding fresh in-process counters? DEFAULT: add fresh since-restart counters on the existing pipeline paths, confirm before implementation.
- [ ] Retention bound for `nectar_logs`: cap by row count, byte size, or age, and what default keeps the store small enough for a one-second read cycle?

---

## Related

- `../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - telemetry transport and single source of truth (services write local SQLite, doctor polls read-only).
- `../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` - static installer registry plus runtime SQLite status.
- [PRD-004: doctor daemon registry + hive portal daemon](../../completed/prd-004-doctor-registry-and-hive/prd-004-doctor-registry-and-hive-index.md) - the registration this PRD extends (the `src/doctor-registry.ts` writer).
- [ADR-0003: three-daemon topology and hive portal](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) - the topology that makes nectar a supervised workload daemon.
- [ADR-0004: hive portal daemon role and boundaries](../../../knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) - the portal role that consumes fleet telemetry through doctor.
- `../../../../../honeycomb/library/requirements/backlog/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md` - the honeycomb sibling PRD; this PRD mirrors its contract for nectar.
- `../../../../../doctor/library/requirements/backlog/prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md` - doctor registration and telemetry ingestion (the poll and merge side).
- `../../../../../doctor/library/requirements/backlog/prd-002-telemetry-sot-sse-and-schema/prd-002-telemetry-sot-sse-and-schema-index.md` - doctor source-of-truth, SSE, and telemetry schema.
- `../../../../../hive/library/requirements/backlog/prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md` - hive health rail and health page, the eventual reader of this telemetry.
- `src/doctor-registry.ts` - the existing registry writer extended by PRD-017a.
- `src/health.ts`, `src/server.ts` - the `PipelineStatus` and `/health` source for the check-in health value.
