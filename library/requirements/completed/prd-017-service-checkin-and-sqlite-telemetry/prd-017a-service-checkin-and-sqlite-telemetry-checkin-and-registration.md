# PRD-017a: Check-in and Registration

> **Parent:** [PRD-017](./prd-017-service-checkin-and-sqlite-telemetry-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None to Deep Lake. Extends the existing static registry entry with the SQLite DB path and adds a runtime status record (binding time, last-seen, health).

---

## Goals

Make nectar a registered, self-announcing member of the fleet so doctor can locate its telemetry, know it should exist, and read a live liveness and health signal without nectar pushing anything. This implements the nectar side of `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` by extending the registration that PRD-004 already delivered: the existing `src/doctor-registry.ts` entry gains the runtime telemetry SQLite database path, and a new runtime status record carries check-in, binding time, last-seen, and health.

## Scope

- Extend `DoctorRegistryEntry` and `buildNectarRegistryEntry()` in `src/doctor-registry.ts` so nectar's registry entry declares the absolute path to its runtime telemetry SQLite database, alongside the existing `healthUrl`, `pidPath`, and probe and restart fields.
- Preserve the existing writer behavior: idempotent replace keyed by `name: "nectar"`, every other daemon's entry untouched, and the fail-loud `DoctorRegistryError` on a present-but-malformed registry file.
- Write a runtime status record on check-in: binding time (when nectar bound `127.0.0.1:3854`), current health, and an initial last-seen.
- Advance last-seen on a fixed heartbeat interval so liveness is derivable as an age of last-seen, independent of whether metrics changed.
- Source the health value from the same `PipelineStatus` signal nectar's `/health` reports (`src/health.ts`, `src/server.ts`), so doctor's `/health` probe and the polled status agree.
- Keep every runtime status write fail-soft: a status write error never blocks daemon boot or the nectar pipeline.

## Out of scope

- Metrics emission (PRD-017b) and log emission (PRD-017c).
- doctor's merge of static registry plus runtime status, its poll loop, and the SSE to hive (doctor PRD-001 and PRD-002).
- Re-specifying how the installer edits the registry file. PRD-004 owns the install-time file-edit mechanics; this sub-PRD extends the entry shape and adds the runtime status record.

---

## User stories and acceptance criteria

### US-017a.1 - Nectar's telemetry DB is discoverable in the registry

**As** doctor, **I want** nectar's registry entry to carry its SQLite DB path, **so that** I know nectar should exist and where to poll its telemetry.

- AC-017a.1.1 Given a completed registration, when the static registry is read, then nectar's entry declares its identity and the absolute path to its runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`.
- AC-017a.1.2 Given nectar is reinstalled or upgraded, when `registerWithDoctor()` runs again, then the entry is refreshed idempotently (keyed by `name: "nectar"`) rather than duplicated, the DB path remains stable, and every other daemon's entry is preserved.
- AC-017a.1.3 Given a present-but-malformed registry file, when registration runs, then it still fails loudly with `DoctorRegistryError` rather than clobbering the broken file, unchanged from PRD-004's behavior.

### US-017a.2 - Nectar checks in with binding time and health

**As** doctor, **I want** a runtime status record on check-in, **so that** I can merge live binding time and health with the static entry.

- AC-017a.2.1 Given nectar binds `127.0.0.1:3854`, when it checks in, then it writes a runtime status record with a binding time and a current health value readable read-only.
- AC-017a.2.2 Given nectar's `PipelineStatus` changes, when the status is next written, then the health field reflects the same value `/health` reports.

### US-017a.3 - Liveness is derivable from last-seen

**As** doctor, **I want** last-seen to advance on a heartbeat, **so that** a quiet-but-healthy nectar is not mistaken for a dead one.

- AC-017a.3.1 Given nectar is running and idle, when the heartbeat interval fires, then last-seen advances even though no metric changed.
- AC-017a.3.2 Given a nectar restart, when it checks in again, then binding time reflects the new process while the registry entry and DB path are unchanged.

---

## Technical considerations

- The registry extension is additive to `DoctorRegistryEntry`: add the telemetry SQLite DB path field and populate it in `buildNectarRegistryEntry()`. doctor's read-side loader must tolerate the new field, coordinated with doctor PRD-001.
- The runtime status write is an upsert keyed on nectar's service identity, never an append, so last-seen and health are a latest-wins snapshot.
- The health value is not recomputed here. It is read from the same `PipelineStatus` source `src/health.ts` and `src/server.ts` use for `/health`, so the two never disagree.
- The runtime status write is fail-soft even though the install-time registry edit stays fail-loud on a malformed file: a locked status DB, a permissions error, or a missing directory is caught, logged locally, and never propagated into boot or the pipeline.
- The telemetry store uses Node's built-in `node:sqlite` in WAL mode, so doctor's read-only open does not contend with nectar's writes.

## Files touched (anticipated)

- `src/doctor-registry.ts` - extend `DoctorRegistryEntry` and `buildNectarRegistryEntry()` with the SQLite DB path field.
- New `src/telemetry/checkin.ts` - the runtime status writer (binding time, last-seen heartbeat, health) built on Node's built-in `node:sqlite`.
- `src/health.ts` / `src/server.ts` (read-only) - source the health value from `PipelineStatus`.
- Tests under `test/telemetry/`.

## Test plan

- Unit: the registry entry records the DB path and is refreshed idempotently on re-registration (AC-017a.1.1, AC-017a.1.2).
- Unit: a present-but-malformed registry still throws `DoctorRegistryError` (AC-017a.1.3).
- Unit: check-in records binding time and a health value matching the `PipelineStatus` source (AC-017a.2).
- Unit: heartbeat advances last-seen with no metric change (AC-017a.3.1); restart updates binding time while the DB path is stable (AC-017a.3.2).
- Unit: a status write failure is fail-soft.

## Open questions

- [ ] Does the runtime status record live in the same local SQLite database as metrics and logs (single DB path in the registry), or a dedicated status file the merge reads first?
- [ ] Heartbeat cadence relative to doctor's roughly one-second poll: match it, or run slower since the poll drives freshness?

---

## Related

- Parent: [PRD-017](./prd-017-service-checkin-and-sqlite-telemetry-index.md)
- `../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` - static installer registry plus runtime SQLite status.
- `../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - doctor is the single source of truth and reads service SQLite read-only.
- [PRD-004: doctor daemon registry + hive portal daemon](../../completed/prd-004-doctor-registry-and-hive/prd-004-doctor-registry-and-hive-index.md) - the registration mechanics this sub-PRD extends.
- Sibling: [PRD-017b](./prd-017b-service-checkin-and-sqlite-telemetry-metrics-emission.md), [PRD-017c](./prd-017c-service-checkin-and-sqlite-telemetry-log-emission.md).
- `src/doctor-registry.ts`, `src/health.ts`, `src/server.ts`.
