# PRD-004: hivedoctor daemon registry + thehive portal daemon

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None (hivenectar) — Additive config + a new sibling codebase (thehive) in the honeycomb repo

---

## Overview

This is an **out-of-band PRD**. It specifies work in two other codebases, neither in hivenectar: **hivedoctor** (its own repository) and **thehive** (a new always-on portal daemon that lands in its own `the-hive` repository, implemented by the-hive's [`prd-001`](../../../../../the-hive/library/requirements/in-work/prd-001-thehive-portal-daemon/prd-001-thehive-portal-daemon-index.md)). It is foundational: it lands early, and every other supervised daemon (PRD-002's hivenectar daemon, the existing honeycomb daemon) supervises against the registry this PRD delivers. It realizes decision #1 of the Master PRD Index: the three-daemon topology split into (a) **hivedoctor** — the minimal, rarely-updated supervisor that gains a *minimal* daemon registry but stays state-light; (b) **thehive** — a new always-on portal daemon, updateable independently of hivedoctor, that boots immediately on OS start and serves the unified dashboard, fetching data from each registered daemon's API through a server-side proxy (the-hive ADR-0002); and (c) **hivenectar + honeycomb** — the workload daemons, both supervised by hivedoctor and both surfaced in thehive's portal.

Today hivedoctor is a one-directional `/health`-probe watchdog that supervises exactly one daemon (honeycomb at `:3850`). Its config (`hivedoctor/src/config.ts:28-84`) holds a single daemon's `healthUrl`/`startupGraceMs`/`restartGiveUpThreshold`/`restartCooldownMs` and PID path (`daemonPidPath`), and its composition root (`hivedoctor/src/compose/index.ts:190-534`) builds exactly one supervisor instance over that one daemon. This PRD generalizes that into N supervisor instances driven by a static registry file, and introduces thehive as a third supervised daemon that owns the dashboard surface.

**This index covers the module scope.** Sub-PRD 004a owns the hivedoctor registry + per-daemon supervisor instances; 004b owns the multi-daemon reporting surfaces (status page + CLI); 004c owns thehive's bootstrap, always-on dashboard serving, and API aggregation; 004d owns thehive's OS service unit and how installers edit the registry.

---

## Goals

- hivedoctor supervises N named daemons (honeycomb, thehive, hivenectar) from a single static registry file, spawning one independent supervisor instance per registered daemon.
- A restart, escalation, or incident for one daemon does NOT pollute any other daemon's state — each registry entry carries isolated incident + remediation state.
- hivedoctor stays state-light and update-rare: registering a new daemon is a registry-file edit, not a code change to hivedoctor.
- thehive is a new always-on portal daemon that boots immediately on OS start, is updateable independently of hivedoctor, and serves the unified dashboard from a copy of honeycomb's dashboard code that thehive owns (copied and retired from honeycomb per the-hive ADR-0001), fetching each daemon's data through a server-side proxy (the-hive ADR-0002).
- The dashboard is up the moment the device boots, regardless of which workload daemon is healthy — there is one source of always-on UI truth.
- A new workload daemon registers itself in hivedoctor's registry through its installer writing one registry entry; no runtime HTTP registration API exists.

## Non-Goals

- hivedoctor does NOT gain portal/dashboard logic. thehive owns the dashboard; hivedoctor owns supervision only.
- hivedoctor does NOT serve a runtime HTTP registration API. The registry is a static file edited by installers and read by hivedoctor on boot (locked decision).
- thehive does NOT own business/data logic for any workload. It is a portal + aggregation layer; every data row it renders comes from a registered daemon's own API.
- thehive does NOT replace hivedoctor's loopback comfort status page (`hivedoctor/src/status-page/server.ts`). The two coexist: hivedoctor's page is the supervisor's own read-only state; thehive's is the unified workload dashboard.
- This PRD does NOT deliver the hivenectar daemon's `/health` + PID/lock file — that is PRD-003's deliverable. This PRD defines the registry contract PRD-003 registers into.
- This PRD does NOT define the Source Graph dashboard page content — that is PRD-015. This PRD delivers the thehive portal that hosts it.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-004a-hivedoctor-registry-config-and-supervisor-instances`](./prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) | Registry schema + file load, per-daemon supervisor instantiation, isolated incident/remediation state | Draft |
| [`prd-004b-hivedoctor-status-and-cli`](./prd-004b-hivedoctor-status-and-cli.md) | Loopback status page multi-daemon reporting, CLI `status`/`diagnose`/`logs` over N daemons | Draft |
| [`prd-004c-thehive-portal-daemon`](./prd-004c-thehive-portal-daemon.md) | thehive bootstrap, always-on dashboard serving (reusing `src/dashboard/web/`), API aggregation from each registered daemon | Draft |
| [`prd-004d-thehive-service-unit-and-registration`](./prd-004d-thehive-service-unit-and-registration.md) | thehive OS service unit (launchd/systemd/schtasks), how thehive/hivenectar installers edit the registry | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given hivedoctor's registry file lists honeycomb + thehive + hivenectar, when hivedoctor boots, then it spawns one independent supervisor instance per registry entry, each probing its own `healthUrl` on its own `probeIntervalMs`. |
| AC-2 | Given two daemons are registered, when daemon A fails its `/health` and is restarted, then daemon B's incident log, remediation state, and consecutive-restart-failure count are untouched. |
| AC-3 | Given thehive is registered and healthy, when the device boots, then thehive serves the unified dashboard on its port without waiting for any workload daemon to be healthy. |
| AC-4 | Given thehive is updateable independently of hivedoctor, when thehive is upgraded, then hivedoctor's process is not restarted and its own supervisor instances keep running. |
| AC-5 | Given a new workload daemon ships, when its installer runs, then the installer appends one entry to the registry file and does NOT touch hivedoctor's code or restart hivedoctor to register. |
| AC-6 | Given hivedoctor's loopback status page and CLI, when an operator runs `hivedoctor status`, then the output reports every registered daemon's health, not just one. |

---

## Related

- **Authoritative brief:** [`library/requirements/MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — decision #1 (the three-daemon topology) and the PRD-004 entry.
- **Motivation ADRs:** [`ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) (the independence decision this expands), [`ADR-0003-three-daemon-topology-and-thehive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md) (records the three-daemon topology this PRD implements; supersedes ADR-0002's two-daemon framing), and [`ADR-0004-thehive-portal-daemon-role-and-boundaries.md`](../../../knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) (records thehive's role and the four binding boundaries 004c implements).
- **Mechanism ADRs (the-hive repo):** [`ADR-0001` retire honeycomb dashboard + copy-and-own](../../../../../the-hive/library/knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-thehive.md) and [`ADR-0002` server-side BFF proxy](../../../../../the-hive/library/knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) refine how 004c's dashboard ownership + API aggregation are realized (copy-and-own, not runtime import; server-side proxy, not client-side federation).
- **Consumes/feeds:** [PRD-001](../prd-001-three-daemon-topology/prd-001-three-daemon-topology-index.md) (the topology contract), [PRD-003](../prd-003-hivenectar-supervision/prd-003-hivenectar-supervision-index.md) (hivenectar's registry entry, consumes this registry), [PRD-015](../prd-015-dashboard-source-graph-page/prd-015-dashboard-source-graph-page-index.md) (the dashboard page thehive hosts).
