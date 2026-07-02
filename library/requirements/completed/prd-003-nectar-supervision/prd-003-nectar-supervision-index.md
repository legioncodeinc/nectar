# PRD-003: Nectar supervision by doctor

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None
> **Codebase:** `nectar` repo (this project) — the nectar-side of the supervision contract. The doctor-side registry that consumes this PRD is PRD-004 (out-of-band, lands in the `doctor` repo).

---

## Overview

This PRD is how nectar **becomes a supervised daemon**. Per the locked topology (decision #1, [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)), doctor gains a minimal daemon registry — owned by PRD-004 — and nectar is one entry in it. This PRD is the **nectar side of that contract**: it specifies the four things nectar must provide and do so that doctor can probe it, restart it, and keep it alive across a reboot exactly as it does honeycomb today.

The four surfaces, each modeled on the existing honeycomb and doctor code:

1. A **`/health` endpoint** answering the coarse `ok`/`degraded` bit doctor classifies on — sub-PRD 003a.
2. A **PID/lock file** at the path doctor's restart rung reads to respect nectar's single-instance guard — sub-PRD 003a.
3. An **OS service unit** (launchd / systemd / schtasks) that starts nectar on boot and restarts it on crash — sub-PRD 003b.
4. A **registry entry** (nectar's `healthUrl`/`pidPath`/`probeInterval` row) appended to doctor's registry, plus confirmation that the watchdog-war guards in the restart rung read nectar's *own* PID file rather than honeycomb's shared default — sub-PRD 003c.

This PRD **consumes** the registry (PRD-004 builds it) and **conforms to** the process surface PRD-001b already locked (port 3854, `~/.honeycomb/nectar.pid`/`.lock`, the coarse health bit). It does not redefine those; it implements them on the nectar side and wires them into the supervision contract.

---

## Goals

- nectar answers `GET /health` over loopback on port 3854 with the coarse `ok`/`degraded` status doctor's probe classifies on, mirroring honeycomb's `/health` route.
- nectar writes a single-instance PID file and lock file at paths doctor's restart rung reads, distinct from honeycomb's `daemon.pid`/`daemon.lock` so the two daemons coexist in `~/.honeycomb`.
- nectar ships an OS service unit (launchd LaunchAgent / systemd `--user` unit / Windows Scheduled Task) that starts it on boot and restarts it on crash, modeled on doctor's own self-registration templates.
- nectar's installer appends one entry to doctor's registry file so doctor polls nectar alongside honeycomb and hive at the next doctor boot.
- The watchdog-war guards in the restart rung read nectar's own `pidPath`, never honeycomb's shared default, so a restart never double-binds against a healthy nectar.

## Non-Goals

- The doctor registry schema, per-daemon supervisor construction, and isolated incident state — **PRD-004a** (out-of-band, doctor codebase). This PRD consumes the registry; it does not build it.
- doctor's status page / CLI multi-daemon reporting — **PRD-004b**.
- hive's portal daemon and its own service unit — **PRD-004c/004d**.
- nectar's composition root, bootstrap sequence, and graceful shutdown signal handling — **PRD-002** (the shutdown path that removes the PID/lock is its contract; this PRD states the requirement).
- nectar's Deep Lake client, tenancy scoping, and daemon API endpoints — **PRD-001b, PRD-005, PRD-008**.
- The remediation ladder's rung 2 (reinstall) and escalation rung — doctor owns those; this PRD only consumes rung 1 (restart) against nectar's PID file.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-003a-health-endpoint-and-pid-lock`](./prd-003a-health-endpoint-and-pid-lock.md) | `/health` endpoint answering `ok`/`degraded` + PID/lock file writing | Draft |
| [`prd-003b-os-service-unit`](./prd-003b-os-service-unit.md) | launchd/systemd/schtasks unit definition + install | Draft |
| [`prd-003c-registry-entry-and-watchdog-guards`](./prd-003c-registry-entry-and-watchdog-guards.md) | nectar's registry entry + watchdog-war guards against its own single-instance lock | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given nectar is running, when doctor probes `GET http://127.0.0.1:3854/health`, then it receives a `200` with a coarse `status: "ok"|"degraded"` body (a `503` + `degraded` when a sub-dependency is down). |
| AC-2 | Given nectar boots, when it acquires its single-instance lock, then it writes `~/.honeycomb/nectar.pid` and `~/.honeycomb/nectar.lock`, and a second start throws before binding port 3854. |
| AC-3 | Given the OS boots (or the user logs in), when the registered service unit runs, then nectar starts; when it crashes, the OS restarts it. |
| AC-4 | Given nectar's installer runs, then it appends one entry to `~/.honeycomb/doctor.daemons.json` naming nectar with `healthUrl: http://127.0.0.1:3854/health` and `pidPath: ~/.honeycomb/nectar.pid`. |
| AC-5 | Given nectar is healthy and its lock is held, when doctor's restart rung checks, then it skips the restart (lock-held-and-healthy guard) — it does not start a second nectar that would hit the single-instance lock and exit. |

---

## Open questions

None. The `/health` response shape, OS service unit names, and startup grace are flagged **DEFAULT — confirm before implementation** in the sub-PRDs below.

---

## Related

- [`prd-001b-nectar-process-and-health`](../prd-001-three-daemon-topology/prd-001b-nectar-process-and-health.md) — the locked process surface this PRD implements (port 3854, PID/lock filenames, coarse health bit).
- [`prd-004a-doctor-registry-config-and-supervisor-instances`](../prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) — the registry this PRD consumes (schema, per-daemon supervisor, watchdog-war guards).
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — decision #1 (the three-daemon topology) and the PRD-003 entry.
- `ADR-0002` (`library/knowledge/private/architecture/`) — the independence decision: nectar is an independent daemon supervised by doctor.
