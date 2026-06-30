# PRD-003: Hivenectar supervision by hivedoctor

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None
> **Codebase:** `hivenectar` repo (this project) — the hivenectar-side of the supervision contract. The hivedoctor-side registry that consumes this PRD is PRD-004 (out-of-band, lands in the `honeycomb` repo's `hivedoctor/` package).

---

## Overview

This PRD is how hivenectar **becomes a supervised daemon**. Per the locked topology (decision #1, [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)), hivedoctor gains a minimal daemon registry — owned by PRD-004 — and hivenectar is one entry in it. This PRD is the **hivenectar side of that contract**: it specifies the four things hivenectar must provide and do so that hivedoctor can probe it, restart it, and keep it alive across a reboot exactly as it does honeycomb today.

The four surfaces, each modeled on the existing honeycomb/hivedoctor code:

1. A **`/health` endpoint** answering the coarse `ok`/`degraded` bit hivedoctor classifies on — sub-PRD 003a.
2. A **PID/lock file** at the path hivedoctor's restart rung reads to respect hivenectar's single-instance guard — sub-PRD 003a.
3. An **OS service unit** (launchd / systemd / schtasks) that starts hivenectar on boot and restarts it on crash — sub-PRD 003b.
4. A **registry entry** (hivenectar's `healthUrl`/`pidPath`/`probeInterval` row) appended to hivedoctor's registry, plus confirmation that the watchdog-war guards in the restart rung read hivenectar's *own* PID file rather than honeycomb's shared default — sub-PRD 003c.

This PRD **consumes** the registry (PRD-004 builds it) and **conforms to** the process surface PRD-001b already locked (port 3854, `~/.honeycomb/hivenectar.pid`/`.lock`, the coarse health bit). It does not redefine those; it implements them on the hivenectar side and wires them into the supervision contract.

---

## Goals

- hivenectar answers `GET /health` over loopback on port 3854 with the coarse `ok`/`degraded` status hivedoctor's probe classifies on, mirroring honeycomb's `/health` route.
- hivenectar writes a single-instance PID file and lock file at paths hivedoctor's restart rung reads, distinct from honeycomb's `daemon.pid`/`daemon.lock` so the two daemons coexist in `~/.honeycomb`.
- hivenectar ships an OS service unit (launchd LaunchAgent / systemd `--user` unit / Windows Scheduled Task) that starts it on boot and restarts it on crash, modeled on hivedoctor's own self-registration templates.
- hivenectar's installer appends one entry to hivedoctor's registry file so hivedoctor polls hivenectar alongside honeycomb and thehive at the next hivedoctor boot.
- The watchdog-war guards in the restart rung read hivenectar's own `pidPath`, never honeycomb's shared default, so a restart never double-binds against a healthy hivenectar.

## Non-Goals

- The hivedoctor registry schema, per-daemon supervisor construction, and isolated incident state — **PRD-004a** (out-of-band, hivedoctor codebase). This PRD consumes the registry; it does not build it.
- hivedoctor's status page / CLI multi-daemon reporting — **PRD-004b**.
- thehive's portal daemon and its own service unit — **PRD-004c/004d**.
- hivenectar's composition root, bootstrap sequence, and graceful shutdown signal handling — **PRD-002** (the shutdown path that removes the PID/lock is its contract; this PRD states the requirement).
- hivenectar's Deep Lake client, tenancy scoping, and daemon API endpoints — **PRD-001b, PRD-005, PRD-008**.
- The remediation ladder's rung 2 (reinstall) and escalation rung — hivedoctor owns those; this PRD only consumes rung 1 (restart) against hivenectar's PID file.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-003a-health-endpoint-and-pid-lock`](./prd-003a-health-endpoint-and-pid-lock.md) | `/health` endpoint answering `ok`/`degraded` + PID/lock file writing | Draft |
| [`prd-003b-os-service-unit`](./prd-003b-os-service-unit.md) | launchd/systemd/schtasks unit definition + install | Draft |
| [`prd-003c-registry-entry-and-watchdog-guards`](./prd-003c-registry-entry-and-watchdog-guards.md) | hivenectar's registry entry + watchdog-war guards against its own single-instance lock | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given hivenectar is running, when hivedoctor probes `GET http://127.0.0.1:3854/health`, then it receives a `200` with a coarse `status: "ok"|"degraded"` body (a `503` + `degraded` when a sub-dependency is down). |
| AC-2 | Given hivenectar boots, when it acquires its single-instance lock, then it writes `~/.honeycomb/hivenectar.pid` and `~/.honeycomb/hivenectar.lock`, and a second start throws before binding port 3854. |
| AC-3 | Given the OS boots (or the user logs in), when the registered service unit runs, then hivenectar starts; when it crashes, the OS restarts it. |
| AC-4 | Given hivenectar's installer runs, then it appends one entry to `~/.honeycomb/hivedoctor.daemons.json` naming hivenectar with `healthUrl: http://127.0.0.1:3854/health` and `pidPath: ~/.honeycomb/hivenectar.pid`. |
| AC-5 | Given hivenectar is healthy and its lock is held, when hivedoctor's restart rung checks, then it skips the restart (lock-held-and-healthy guard) — it does not start a second hivenectar that would hit the single-instance lock and exit. |

---

## Open questions

None. The `/health` response shape, OS service unit names, and startup grace are flagged **DEFAULT — confirm before implementation** in the sub-PRDs below.

---

## Related

- [`prd-001b-hivenectar-process-and-health`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md) — the locked process surface this PRD implements (port 3854, PID/lock filenames, coarse health bit).
- [`prd-004a-hivedoctor-registry-config-and-supervisor-instances`](../prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) — the registry this PRD consumes (schema, per-daemon supervisor, watchdog-war guards).
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — decision #1 (the three-daemon topology) and the PRD-003 entry.
- `ADR-0002` (`library/knowledge/private/architecture/`) — the independence decision: hivenectar is an independent daemon supervised by hivedoctor.
