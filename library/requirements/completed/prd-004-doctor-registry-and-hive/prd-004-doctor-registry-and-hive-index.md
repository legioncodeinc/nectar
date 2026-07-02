# PRD-004: doctor daemon registry + hive portal daemon

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None (nectar) — Additive config + a new sibling codebase (hive) in the honeycomb repo

---

## Overview

This is an **out-of-band PRD**. It specifies work in two other codebases, neither in nectar: **doctor** (its own repository) and **hive** (a new always-on portal daemon that lands in its own `hive` repository, implemented by hive's [`prd-001`](../../../../../hive/library/requirements/in-work/prd-001-hive-portal-daemon/prd-001-hive-portal-daemon-index.md)). It is foundational: it lands early, and every other supervised daemon (PRD-002's nectar daemon, the existing honeycomb daemon) supervises against the registry this PRD delivers. It realizes decision #1 of the Master PRD Index: the three-daemon topology split into (a) **doctor** — the minimal, rarely-updated supervisor that gains a *minimal* daemon registry but stays state-light; (b) **hive** — a new always-on portal daemon, updateable independently of doctor, that boots immediately on OS start and serves the unified dashboard, fetching data from each registered daemon's API through a server-side proxy (hive ADR-0002); and (c) **nectar + honeycomb** — the workload daemons, both supervised by doctor and both surfaced in hive's portal.

Today doctor is a one-directional `/health`-probe watchdog that supervises exactly one daemon (honeycomb at `:3850`). Its config (`doctor/src/config.ts:28-84`) holds a single daemon's `healthUrl`/`startupGraceMs`/`restartGiveUpThreshold`/`restartCooldownMs` and PID path (`daemonPidPath`), and its composition root (`doctor/src/compose/index.ts:190-534`) builds exactly one supervisor instance over that one daemon. This PRD generalizes that into N supervisor instances driven by a static registry file, and introduces hive as a third supervised daemon that owns the dashboard surface.

**This index covers the module scope.** Sub-PRD 004a owns the doctor registry + per-daemon supervisor instances; 004b owns the multi-daemon reporting surfaces (status page + CLI); 004c owns hive's bootstrap, always-on dashboard serving, and API aggregation; 004d owns hive's OS service unit and how installers edit the registry.

---

## Goals

- doctor supervises N named daemons (honeycomb, hive, nectar) from a single static registry file, spawning one independent supervisor instance per registered daemon.
- A restart, escalation, or incident for one daemon does NOT pollute any other daemon's state — each registry entry carries isolated incident + remediation state.
- doctor stays state-light and update-rare: registering a new daemon is a registry-file edit, not a code change to doctor.
- hive is a new always-on portal daemon that boots immediately on OS start, is updateable independently of doctor, and serves the unified dashboard from a copy of honeycomb's dashboard code that hive owns (copied and retired from honeycomb per hive ADR-0001), fetching each daemon's data through a server-side proxy (hive ADR-0002).
- The dashboard is up the moment the device boots, regardless of which workload daemon is healthy — there is one source of always-on UI truth.
- A new workload daemon registers itself in doctor's registry through its installer writing one registry entry; no runtime HTTP registration API exists.

## Non-Goals

- doctor does NOT gain portal/dashboard logic. hive owns the dashboard; doctor owns supervision only.
- doctor does NOT serve a runtime HTTP registration API. The registry is a static file edited by installers and read by doctor on boot (locked decision).
- hive does NOT own business/data logic for any workload. It is a portal + aggregation layer; every data row it renders comes from a registered daemon's own API.
- hive does NOT replace doctor's loopback comfort status page (`doctor/src/status-page/server.ts`). The two coexist: doctor's page is the supervisor's own read-only state; hive's is the unified workload dashboard.
- This PRD does NOT deliver the nectar daemon's `/health` + PID/lock file — that is PRD-003's deliverable. This PRD defines the registry contract PRD-003 registers into.
- This PRD does NOT define the Hive Graph dashboard page content — that is PRD-015. This PRD delivers the hive portal that hosts it.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-004a-doctor-registry-config-and-supervisor-instances`](./prd-004a-doctor-registry-config-and-supervisor-instances.md) | Registry schema + file load, per-daemon supervisor instantiation, isolated incident/remediation state | Draft |
| [`prd-004b-doctor-status-and-cli`](./prd-004b-doctor-status-and-cli.md) | Loopback status page multi-daemon reporting, CLI `status`/`diagnose`/`logs` over N daemons | Draft |
| [`prd-004c-hive-portal-daemon`](./prd-004c-hive-portal-daemon.md) | hive bootstrap, always-on dashboard serving (reusing `src/dashboard/web/`), API aggregation from each registered daemon | Draft |
| [`prd-004d-hive-service-unit-and-registration`](./prd-004d-hive-service-unit-and-registration.md) | hive OS service unit (launchd/systemd/schtasks), how hive/nectar installers edit the registry | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given doctor's registry file lists honeycomb + hive + nectar, when doctor boots, then it spawns one independent supervisor instance per registry entry, each probing its own `healthUrl` on its own `probeIntervalMs`. |
| AC-2 | Given two daemons are registered, when daemon A fails its `/health` and is restarted, then daemon B's incident log, remediation state, and consecutive-restart-failure count are untouched. |
| AC-3 | Given hive is registered and healthy, when the device boots, then hive serves the unified dashboard on its port without waiting for any workload daemon to be healthy. |
| AC-4 | Given hive is updateable independently of doctor, when hive is upgraded, then doctor's process is not restarted and its own supervisor instances keep running. |
| AC-5 | Given a new workload daemon ships, when its installer runs, then the installer appends one entry to the registry file and does NOT touch doctor's code or restart doctor to register. |
| AC-6 | Given doctor's loopback status page and CLI, when an operator runs `doctor status`, then the output reports every registered daemon's health, not just one. |

---

## Related

- **Authoritative brief:** [`library/requirements/MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — decision #1 (the three-daemon topology) and the PRD-004 entry.
- **Motivation ADRs:** [`ADR-0002-nectar-independent-daemon-supervised-by-doctor.md`](../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md) (the independence decision this expands), [`ADR-0003-three-daemon-topology-and-hive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) (records the three-daemon topology this PRD implements; supersedes ADR-0002's two-daemon framing), and [`ADR-0004-hive-portal-daemon-role-and-boundaries.md`](../../../knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) (records hive's role and the four binding boundaries 004c implements).
- **Mechanism ADRs (hive repo):** [`ADR-0001` retire honeycomb dashboard + copy-and-own](../../../../../hive/library/knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md) and [`ADR-0002` server-side BFF proxy](../../../../../hive/library/knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) refine how 004c's dashboard ownership + API aggregation are realized (copy-and-own, not runtime import; server-side proxy, not client-side federation).
- **Consumes/feeds:** [PRD-001](../prd-001-three-daemon-topology/prd-001-three-daemon-topology-index.md) (the topology contract), [PRD-003](../prd-003-nectar-supervision/prd-003-nectar-supervision-index.md) (nectar's registry entry, consumes this registry), [PRD-015](../prd-015-dashboard-hive-graph-page/prd-015-dashboard-hive-graph-page-index.md) (the dashboard page hive hosts).
