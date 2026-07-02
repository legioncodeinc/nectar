# PRD-017: Hivenectar Service Check-in and SQLite Telemetry Emission

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None to Deep Lake. Additive local SQLite tables for non-sensitive telemetry (metrics, logs) plus a runtime status entry recorded through hivedoctor's registration surfaces.

---

## Overview

The fleet realignment makes hivedoctor the supervisor and single source of truth for fleet telemetry, and the-hive portal the only human-facing surface. Under that model every service, including hivenectar (the source-graph "nectar" workload daemon on `127.0.0.1:3854`), is a supervised participant: it must announce itself to hivedoctor and expose its own non-sensitive telemetry in a place hivedoctor can poll cheaply. Two locked hivedoctor decisions govern how that happens: `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` (services write non-sensitive telemetry to their own local SQLite, hivedoctor polls on roughly a one-second interval plus a `/health` probe and is the sole source of truth relaying one SSE to the-hive, with no service-to-hivedoctor SSE) and `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` (a static installer registry declares who should exist and where each service's SQLite database lives, while each service writes runtime status such as check-in, binding time, last-seen, and health into its runtime SQLite for hivedoctor to merge).

Hivenectar is partway there. From PRD-004's registration work it already ships a hivedoctor registry writer, `src/hivedoctor-registry.ts` (`registerWithHivedoctor()`, `buildHivenectarRegistryEntry()`), that appends or idempotently replaces one entry keyed by `name: "hivenectar"` in `~/.honeycomb/hivedoctor.daemons.json`, carrying `healthUrl`, `pidPath`, and the probe and restart fields. What hivenectar does not yet do is record its runtime telemetry SQLite database path in that registry entry, write a runtime status row (binding time, last-seen heartbeat, current health), or emit metrics and logs to a local SQLite surface shaped for hivedoctor's poller.

This PRD closes that gap. It makes hivenectar a first-class supervised service: it extends the existing registry writer to record its SQLite database path and writes runtime check-in status per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`, and it writes non-sensitive metrics and logs to its own local SQLite for hivedoctor to poll per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. It reuses hivenectar's built-ins-only ethos: the telemetry store uses Node's built-in `node:sqlite` (available on Node >=22.5 behind `--experimental-sqlite`), so no external dependency is added, mirroring honeycomb's local-queue precedent. This is the hivenectar sibling of honeycomb's PRD-071 and follows the same contract.

---

## Goals

- Extend hivenectar's existing hivedoctor registry writer (`src/hivedoctor-registry.ts`) so its registry entry also records the on-disk path to hivenectar's runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`.
- Write and refresh hivenectar's runtime status (binding time, last-seen heartbeat, current health) so hivedoctor can merge a live view of hivenectar without hivenectar pushing to hivedoctor.
- Emit non-sensitive metrics to hivenectar's own local SQLite: files registered, nectars minted, descriptions generated, source-graph versions written, and embeddings computed, all since the last restart.
- Emit non-sensitive logs, carrying a verbosity level, to hivenectar's own local SQLite, bounded and rotated so the store never grows without limit.
- Use Node's built-in `node:sqlite` for the telemetry store so hivenectar adds no external dependency, consistent with its built-ins-only design and hivedoctor's minimal-footprint ethos.
- Keep the telemetry and check-in write path fail-soft so a telemetry error never blocks the nectar pipeline or daemon boot, aligning with hivedoctor's fail-soft posture even though the existing registry writer fails loudly on a present-but-malformed registry file.

## Non-Goals

- Any change to the two Deep Lake tables (`source_graph`, `source_graph_versions`) or to durable nectar state. Telemetry lives only in local SQLite and is an operational, non-durable, non-sensitive surface, so it does not violate FR-8 (durable state goes in Deep Lake, not sidecars).
- Emitting sensitive data: no tokens, credential values, raw authorization headers, org secrets, source-file contents, LLM description bodies, or PII in metrics or logs (per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`).
- Building the poller, the merge, the single source of truth, or the SSE to the-hive. Those belong to hivedoctor (PRD-001 and PRD-002) and the-hive (PRD-005).
- Building any human-facing dashboard or health page. The read surface is the-hive's job.
- A push channel from hivenectar to hivedoctor. Transport is pull, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.
- Replacing PRD-004's registration mechanics. This PRD extends the existing registry entry and adds runtime status, it does not re-specify how the registry file is edited at install.

---

## Code-grounded current state

| Area | Current code fact | Implication for this PRD |
|---|---|---|
| Registry writer already ships | `src/hivedoctor-registry.ts` exposes `registerWithHivedoctor()` and `buildHivenectarRegistryEntry()`, writing an entry with `name`, `healthUrl`, `pidPath`, and the probe and restart fields to `~/.honeycomb/hivedoctor.daemons.json`, idempotently keyed by `name: "hivenectar"`. | This PRD extends the `HivedoctorRegistryEntry` shape and the writer to also record the runtime telemetry SQLite database path, rather than introducing a second registration path. |
| Registry writer fails loud on malformed input | `readExistingRegistry()` throws `HivedoctorRegistryError` on a present-but-unparseable registry, deliberately refusing to clobber a real misconfiguration. | The new runtime status and telemetry writes are additive and fail-soft, so they do not weaken the existing fail-loud guard on the install-time file edit, but they never propagate a telemetry error into boot or the pipeline. |
| Built-ins only, no external deps | Per AGENTS.md, the daemon uses only `node:http`, `node:fs`, `node:net`, and `node:os`, with `typescript` and `@types/node` the only devDependencies. | The telemetry store uses Node's built-in `node:sqlite` (Node >=22.5, `--experimental-sqlite`), a built-in and not an external dependency, keeping the zero-runtime-dependency posture intact. |
| Daemon binds loopback, serves `/health` | The daemon binds `127.0.0.1:3854` and serves `/health` from `src/health.ts` (`PipelineStatus`) and `src/server.ts`. | The runtime status row's health field derives from the same health source hivedoctor's `/health` probe reads, so the polled status and the probe never disagree. Telemetry is a local file read by hivedoctor read-only, adding no network exposure. |
| Nectar pipeline produces countable work | Hivenectar registers files, mints daemon-minted ULID nectars, generates LLM descriptions (the enricher and brooding loop), writes `source_graph_versions`, and computes embeddings across PRD-006, PRD-007, PRD-016, PRD-005, and PRD-014. | These pipeline stages are the natural non-sensitive since-restart metric set. Exact counter identifiers are not asserted here as existing symbols and are marked DEFAULT (confirm before implementation). |
| Durable state discipline | AGENTS.md and FR-8 require durable state in Deep Lake, not sidecars; `.honeycomb/nectars.json` is a regenerable projection, not a sidecar. | Telemetry is operational, non-durable, and non-sensitive, so it follows the local-SQLite precedent (like honeycomb's local queue), not the Deep Lake durable-state rule. |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-017a-check-in-and-registration`](./prd-017a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md) | Extend the existing `src/hivedoctor-registry.ts` entry to record the SQLite DB path, plus runtime status writes: binding time, last-seen heartbeat, current health, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` | Draft |
| [`prd-017b-metrics-emission`](./prd-017b-service-checkin-and-sqlite-telemetry-metrics-emission.md) | Non-sensitive metrics to local SQLite: files registered, nectars minted, descriptions generated, source-graph versions, embeddings computed, all since restart, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` | Draft |
| [`prd-017c-log-emission`](./prd-017c-service-checkin-and-sqlite-telemetry-log-emission.md) | Non-sensitive logs to local SQLite with verbosity levels, bounded and rotated, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given hivenectar is installed, when the installer runs its registration path (`registerWithHivedoctor()`), then hivenectar's static registry entry declares its identity and the on-disk path to its runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. |
| AC-2 | Given hivenectar starts and binds `127.0.0.1:3854`, when it checks in, then its runtime status records a binding time and an initial health value that hivedoctor can read read-only. |
| AC-3 | Given hivenectar is running, when the heartbeat interval fires, then the last-seen value advances even if nothing else changed, so hivedoctor can distinguish quiet from dead. |
| AC-4 | Given hivedoctor polls hivenectar's local SQLite on its interval, when hivenectar is doing pipeline work, then hivedoctor observes live metrics (files registered, nectars minted, descriptions generated, source-graph versions, embeddings computed, since restart) without hivenectar pushing anything. |
| AC-5 | Given hivenectar emits logs, when hivedoctor polls the log table, then it sees recent non-sensitive log lines each carrying a verbosity level. |
| AC-6 | Given hivenectar restarts, when the since-restart counters are next read, then they have reset to reflect the new process lifetime while the registry entry and DB path remain stable. |
| AC-7 | Given the telemetry SQLite write fails or is unavailable, when hivenectar runs, then the nectar pipeline and daemon boot are unaffected and the failure is fail-soft. |
| AC-8 | Given the log store reaches its bound, when new logs are written, then old rows are rotated out so the store stays bounded. |
| AC-9 | Given hivedoctor reads hivenectar's SQLite, when it opens the database, then it does so read-only and observes no lock contention that stalls hivenectar's own writes (WAL mode, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`). |
| AC-10 | Given any metric or log row, when it is written, then it contains no token, credential value, raw authorization header, org secret, source-file content, LLM description body, or PII. |

---

## Data model changes

No Deep Lake schema change. This PRD adds local telemetry surfaces in hivenectar's own SQLite (Node's built-in `node:sqlite`), plus a runtime status entry recorded through hivedoctor's registration surface.

- Runtime status (per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`): hivenectar's check-in record carrying binding time, last-seen heartbeat, and current health. hivedoctor merges this with the static registry entry. Detailed in PRD-017a.
- `hivenectar_metrics` (local SQLite, latest-wins snapshot): counters since restart such as files registered, nectars minted, descriptions generated, source-graph versions written, and embeddings computed. Detailed in PRD-017b.
- `hivenectar_logs` (local SQLite, bounded and rotated): non-sensitive log lines with a timestamp and a verbosity level. Detailed in PRD-017c.

The static registry entry (extended from `HivedoctorRegistryEntry` in `src/hivedoctor-registry.ts`) records hivenectar's identity and the absolute path to the local SQLite database so hivedoctor knows where to poll, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. hivedoctor opens that database read-only, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.

---

## Files expected to change

| File | Expected change |
|---|---|
| `src/hivedoctor-registry.ts` | Extend `HivedoctorRegistryEntry` and `buildHivenectarRegistryEntry()` to record the runtime telemetry SQLite DB path in hivenectar's entry, preserving the existing idempotent-replace and fail-loud-on-malformed behavior, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. |
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
- Integration: a hivedoctor-style read-only reader opens hivenectar's SQLite in WAL mode and reads metrics and logs while hivenectar continues writing without lock stalls (AC-9).
- Live proof: install hivenectar, confirm the registry entry and DB path exist, start the daemon, and confirm an external read-only poll sees binding time, advancing last-seen, live metrics, and recent logs.

---

## Open questions

- [ ] Should the runtime status row live in the same local SQLite database as metrics and logs, or a dedicated status file that hivedoctor's registry merge reads first? Leaning toward one database with separate tables to keep a single DB path in the registry.
- [ ] Heartbeat cadence: match hivedoctor's roughly one-second poll, or run slower to reduce write churn given the poll is what drives freshness?
- [ ] Metric source of truth: which existing pipeline symbols (if any) expose files registered, nectars minted, descriptions generated, source-graph versions, and embeddings computed, versus adding fresh in-process counters? DEFAULT: add fresh since-restart counters on the existing pipeline paths, confirm before implementation.
- [ ] Retention bound for `hivenectar_logs`: cap by row count, byte size, or age, and what default keeps the store small enough for a one-second read cycle?

---

## Related

- `../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - telemetry transport and single source of truth (services write local SQLite, hivedoctor polls read-only).
- `../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` - static installer registry plus runtime SQLite status.
- [PRD-004: hivedoctor daemon registry + thehive portal daemon](../../completed/prd-004-hivedoctor-registry-and-thehive/prd-004-hivedoctor-registry-and-thehive-index.md) - the registration this PRD extends (the `src/hivedoctor-registry.ts` writer).
- [ADR-0003: three-daemon topology and thehive portal](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md) - the topology that makes hivenectar a supervised workload daemon.
- [ADR-0004: thehive portal daemon role and boundaries](../../../knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - the portal role that consumes fleet telemetry through hivedoctor.
- `../../../../../honeycomb/library/requirements/backlog/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md` - the honeycomb sibling PRD; this PRD mirrors its contract for hivenectar.
- `../../../../../hivedoctor/library/requirements/backlog/prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md` - hivedoctor registration and telemetry ingestion (the poll and merge side).
- `../../../../../hivedoctor/library/requirements/backlog/prd-002-telemetry-sot-sse-and-schema/prd-002-telemetry-sot-sse-and-schema-index.md` - hivedoctor source-of-truth, SSE, and telemetry schema.
- `../../../../../the-hive/library/requirements/backlog/prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md` - the-hive health rail and health page, the eventual reader of this telemetry.
- `src/hivedoctor-registry.ts` - the existing registry writer extended by PRD-017a.
- `src/health.ts`, `src/server.ts` - the `PipelineStatus` and `/health` source for the check-in health value.
