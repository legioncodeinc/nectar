# PRD-001a: Three-Daemon Topology — ADR-0003 Trigger and Four-Role Contract

> Parent: [`prd-001-three-daemon-topology-index.md`](./prd-001-three-daemon-topology-index.md)

## Overview

This sub-PRD defines the **role boundaries** that the three-daemon topology introduces and triggers the **ADR-0003** that records the decision. It expands decision #1 of [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) into four precisely-scoped roles — **hivedoctor** (supervisor), **thehive** (portal), **hivenectar** (workload), **honeycomb** (workload) — each owning a distinct concern with no overlap. It also defines the **explicit non-integration points**: no in-process state crosses any of the four boundaries, while the data layer and shared infrastructure remain common substrate.

ADR-0002 framed the topology as "hivenectar, an independent daemon supervised by hivedoctor" — a **two-daemon** framing (hivedoctor + honeycomb, with hivenectar joining honeycomb). The three-daemon topology introduces a third always-on daemon (thehive) that ADR-0002 did not anticipate, and reclassifies the always-on UI surface out of the honeycomb daemon and into thehive. ADR-0003 supersedes that two-daemon framing **without** disturbing ADR-0002's load-bearing invariants: independence remains process-layer only, and the shared Deep Lake substrate, recall union, and Portkey/embeddings/CodeGraph consumption are unchanged.

## Goals

- Define each of the four roles with a boundary statement naming what it owns and what it explicitly does NOT own.
- Specify the **hivedoctor minimal daemon registry** at the contract level: a static config file, edited by installers, updated only when a new daemon registers (decision #1) — the registry *implementation* is PRD-004.
- Specify the **thehive portal daemon** at the contract level: always-on, boots on OS start, serves the unified dashboard by fetching from each registered daemon's API, updateable independently of hivedoctor — the *implementation* is PRD-004c.
- Trigger **ADR-0003** recording the three-daemon topology, superseding ADR-0002's two-daemon framing while preserving its invariants.
- State the **non-integration points** explicitly: no shared in-process state across any of the four roles.

## Non-Goals

- The hivedoctor registry implementation (config schema, per-daemon supervisor instances, isolated incident state) — **PRD-004a**.
- The thehive daemon bootstrap, dashboard-hosting, and API-aggregation implementation — **PRD-004c**.
- The OS service units (launchd/systemd/schtasks) that boot each daemon — **PRD-003** (hivenectar) and **PRD-004d** (thehive).
- hivenectar's own process internals — [`prd-001b`](./prd-001b-hivenectar-process-and-health.md).
- The shared-infra consumption seams — [`prd-001c`](./prd-001c-shared-infra-consumption.md).

---

## The ADR-0003 trigger

PRD-001 triggers a new ADR, created at [`knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md). The ADR's required shape (per the repo's ADR convention and ADR-0002's own header structure):

- **Status:** Active (the [`documentation-framework`](../../../knowledge/private/standards/documentation-framework.md) status set is Active / Draft / Archived / Canonical).
- **Date:** 2026-06-30 (the PRD-001 authoring date).
- **Supersedes:** the **two-daemon framing** in ADR-0002 (i.e. "hivedoctor + honeycomb, with hivenectar joining as a supervised independent daemon"). **Does NOT supersede ADR-0002 in full** — ADR-0002's load-bearing invariants are preserved verbatim.
- **Preserved invariants (carried unchanged from ADR-0002):**
  - Independence is **process-layer only.** The data layer is unchanged.
  - hivenectar reads and writes the **same Deep Lake tables** (`source_graph`, `source_graph_versions`), scoped by the same `org_id`/`workspace_id`/`project_id` tenancy.
  - The recall composition is a **data-layer** integration over shared Deep Lake tables, not a process-layer one.
  - Portkey, the embeddings daemon (nomic-embed-text-v1.5), and CodeGraph remain shared infrastructure hivenectar consumes.
- **What ADR-0003 adds over ADR-0002:**
  - A **third always-on daemon, thehive**, which owns the unified dashboard surface (previously implicit in the honeycomb daemon's dashboard).
  - The **minimal daemon registry** in hivedoctor — hivenectar + thehive register alongside honeycomb so hivedoctor supervises all three.
  - The **stability/velocity split**: hivedoctor (rarely updated) holds the registry and supervision; thehive (independently updateable) holds the always-on UI. This realizes the user's explicit ask that dashboard updates never force a supervisor update.

The ADR's "alternatives rejected" section reuses ADR-0002's rejected Option A (worker inside honeycomb) and Option C (separate data store), and adds the two topology alternatives decision #1 records: (i) moving the portal into hivedoctor (rejected — forces every dashboard update through the component we want to update rarely); (ii) keeping hivedoctor as a one-daemon watchdog with no registry (rejected — leaves no single always-on dashboard truth and no registration model).

> **RESOLVED.** ADR-0003 has been created at [`knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md) (Status: Active); the slug is decided, not a pending default. thehive's role and the four binding boundaries it introduces are recorded in a companion [`ADR-0004-thehive-portal-daemon-role-and-boundaries.md`](../../../knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md), which this PRD's thehive-role section (below) conforms to.

---

## The four-role contract

Each role owns exactly one concern. The table is the authority; the prose beneath it elaborates the boundary each row draws.

| Role | Kind | Owns | Does NOT own |
|---|---|---|---|
| **hivedoctor** | Supervisor (always-on, rarely updated) | The watch loop, the remediation ladder, the minimal daemon registry (static config), per-daemon incident + remediation state | Portal/dashboard logic, any workload, any Deep Lake table |
| **thehive** | Portal daemon (always-on, independently updateable) | The unified dashboard UI, API aggregation from each registered daemon, boots-on-OS-start | Supervision, any workload's process lifecycle, any Deep Lake table |
| **hivenectar** | Workload daemon (supervised) | The semantic-memory pipeline (watch → re-associate → mint/enrich → embed), its own Deep Lake client + auth + scoping, its own `/health` + PID/lock | The dashboard, supervision of other daemons, honeycomb's tables |
| **honeycomb** | Workload daemon (supervised) | Session capture, the shared recall engine, its own Deep Lake client + auth + scoping, its own `/health` + PID/lock | The semantic-memory pipeline, supervision of other daemons |

### hivedoctor — minimal supervisor + registry

hivedoctor today is a one-directional `/health`-probe watchdog that supervises exactly one daemon (honeycomb at `:3850`). The supervisor probes `GET /health` on a fixed interval, classifies the result, and runs the remediation ladder (restart → reinstall → uninstall-hivemind → escalate) when the probe is unhealthy (`hivedoctor/src/supervisor.ts:144-343` — `createSupervisor`, the `tick` watch loop, the `heal` function; `hivedoctor/src/config.ts:28-84` — the single-daemon `HiveDoctorConfig` with `healthUrl`, `daemonPidPath`, `probeIntervalMs`).

The three-daemon topology generalizes this minimal contract: hivedoctor gains a **minimal daemon registry** — a named list of supervised daemons (honeycomb, thehive, hivenectar), each with its own `healthUrl` / `pidPath` / `probeInterval` / `startupGrace` / restart thresholds, each with isolated incident + remediation state. Per decision #1, the registry is a **static config file, edited by installers** — there is no runtime registration API. hivedoctor is updated only when a new daemon registers (an installer edits the config), and it otherwise stays state-light.

> The registry *implementation* — the config schema, the per-daemon supervisor instances spawned by the composition root (`hivedoctor/src/compose/index.ts:190-534` — `createHiveDoctor`), and the isolated incident state — is **PRD-004a**, owned out-of-band by the hivedoctor project. This PRD defines only the *contract* (the registry exists, is static, is installer-edited) and consumes it.

**hivedoctor explicitly does NOT own portal logic.** This is the load-bearing distinction from the rejected "move the portal into hivedoctor" alternative: if the dashboard lived in hivedoctor, every dashboard update would force a supervisor update, killing the velocity/stability split the user asked for.

### thehive — always-on portal daemon

thehive is a new always-on daemon that owns the unified dashboard surface. It:

- **Boots on OS start**, supervised by hivedoctor like the other daemons (its OS service unit is PRD-004d).
- **Serves the unified dashboard** by fetching data from each registered daemon's API (honeycomb's, hivenectar's), so there is one source of always-on UI truth regardless of which workload daemon is healthy.
- Is **updateable independently** of hivedoctor — a dashboard update ships as a thehive release, never a hivedoctor release.
- Reuses honeycomb's existing dashboard code at `honeycomb/src/dashboard/web/` — the route registry (`honeycomb/src/dashboard/web/registry.tsx:83-94` — `RouteEntry`; `honeycomb/src/dashboard/web/registry.tsx:196-218` — the static routes), the page components (`pages/*.tsx`), and the `PageProps` shell.

Per decision #1, thehive becomes the single always-on UI truth: the dashboard is up the moment the device boots, regardless of whether a workload daemon is up yet. thehive does NOT own any workload's process lifecycle (that is hivedoctor's) and does NOT own any Deep Lake table (that is each workload daemon's).

> The thehive *implementation* — bootstrap, dashboard-hosting, API-aggregation layer — is **PRD-004c**, owned out-of-band by the hive project. PRD-015 lands the Source Graph page in thehive's dashboard.

### hivenectar — workload daemon

hivenectar is the workload daemon this project ships. It owns the semantic-memory pipeline (watch → re-associate → mint/enrich → embed), its own Deep Lake client, auth context, scoping, and observability, its own `/health` endpoint, and its own PID/lock. It is supervised by hivedoctor and surfaced in thehive's portal. Its full process surface is [`prd-001b`](./prd-001b-hivenectar-process-and-health.md); its daemon bootstrap is PRD-002.

### honeycomb — workload daemon

honeycomb is the existing workload daemon. It owns session capture, the shared recall engine, and its own Deep Lake client + auth + scoping. It is supervised by hivedoctor and surfaced in thehive's portal. PRD-001 states honeycomb only as a peer workload daemon; it does not modify honeycomb's process.

---

## The non-integration points

The four roles share **no in-process state**. Each boundary below is explicit:

1. **No shared in-process memory.** Every daemon is a separate OS process. A `SIGKILL` or OOM in hivenectar's description pipeline does not affect honeycomb's serving path, and vice versa — the process-isolated failure domain ADR-0002 established for hivenectar/honeycomb now extends to thehive and hivedoctor as well.
2. **No shared process control.** hivedoctor supervises; the daemons do not supervise each other. hivenectar does not start or restart honeycomb, and honeycomb does not start hivenectar. Coordination crosses the process boundary only via hivedoctor's `/health` probe + remediation ladder.
3. **No shared API client.** thehive reaches each workload daemon over its HTTP API; it does not import the daemon's in-process client. hivenectar reaches Deep Lake through its **own** client (PRD-001b), not honeycomb's.
4. **No shared code import across the process boundary for live runtime behavior.** hivenectar reuses honeycomb's *patterns* (the composition root, the health contract, the recall arm shape) but does not import honeycomb's runtime modules — per decision #4 in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md), the file-watcher pattern is mirrored, not imported, precisely to preserve this boundary. thehive reuses honeycomb's *dashboard code* (`src/dashboard/web/`) by copy/fork into the thehive project, not by importing honeycomb's daemon bundle.

What IS shared is the **data layer** (Deep Lake tables + tenancy, PRD-005) and **shared infrastructure** (Portkey, embeddings daemon, CodeGraph, the recall engine, PRD-001c) — both reached over the network by each daemon's own client, never in-process.

---

## User stories

### US-001a.1 — Operator sees one always-on dashboard
**As an** operator, **when** the device boots, **I** see thehive's dashboard up immediately, **so that** the UI is available regardless of whether a workload daemon has finished booting.

- Acceptance: thehive binds its port (3853, DEFAULT) on OS start and serves the dashboard shell before any workload daemon is confirmed healthy.
- Acceptance: the dashboard fetches each registered daemon's API; a workload daemon being down degrades its panel, not the whole dashboard.

### US-001a.2 — hivedoctor supervises all three daemons independently
**As an** operator, **when** hivenectar crashes, **I** see hivedoctor restart it without affecting honeycomb or thehive, **so that** one workload's failure does not take down the others.

- Acceptance: hivedoctor's registry contains one entry each for honeycomb, thehive, and hivenectar, each with isolated incident + remediation state.
- Acceptance: a hivenectar incident does not appear in honeycomb's incident log.

### US-001a.3 — Dashboard updates ship without a supervisor update
**As a** developer, **when** I ship a dashboard change, **I** release a thehive update, **not** a hivedoctor update, **so that** the rarely-updated supervisor stays stable.

- Acceptance: thehive's release cadence is independent of hivedoctor's; hivedoctor is touched only when a new daemon registers (an installer edits the registry config).

### US-001a.4 — No shared in-process state across daemons
**As a** maintainer, **when** I read the topology, **I** see four separate processes with no in-process coupling, **so that** the failure domain of each is isolated.

- Acceptance: the four-role contract (table above) shows no two roles own the same concern; the non-integration points section lists the four explicit boundaries.

---

## Implementation notes

- The supervisor watch loop + remediation ladder hivedoctor generalizes from: `hivedoctor/src/supervisor.ts:144-343` (`createSupervisor`, `tick`, `heal`).
- The single-daemon config the registry generalizes from: `hivedoctor/src/config.ts:28-84` (`HiveDoctorConfig`, `DEFAULTS`, `resolveConfig`).
- The composition root that today spawns one supervisor (and PRD-004a generalizes to N): `hivedoctor/src/compose/index.ts:190-534` (`createHiveDoctor`).
- The dashboard code thehive reuses: `honeycomb/src/dashboard/web/registry.tsx` (route registry + `RouteEntry`), plus `pages/*.tsx`.
- The daemon entry/lifecycle pattern both workload daemons mirror: `honeycomb/src/daemon/index.ts:108-217` (`createServer`, `runDaemon`, `runAssembledDaemon`, the SIGINT/SIGTERM handlers).
- The remediation ladder's restart rung (the contract hivenectar's supervision consumes, PRD-003): `hivedoctor/src/supervisor.ts:227-259` (rung-1 restart + the give-up-after-N advance).

No open questions. The ADR-0003 slug is resolved (the ADR is created; see above); the port and path defaults live in the parent index's contract table.
