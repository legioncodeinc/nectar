# PRD-001: Three-Daemon Topology

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M
> **Schema changes:** None (this PRD defines process topology and role boundaries; it changes no Deep Lake table — PRD-005 owns the data layer)

---

## Overview

PRD-001 is the foundational contract every other Hivenectar PRD conforms to. It nails down the **three-daemon topology** locked in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) decision #1 — the split of the always-on surface into three roles, plus the workload daemons that run under them:

- **hivedoctor** — the minimal, rarely-updated supervisor. It gains a *minimal* daemon registry (a static config file, edited by installers, decision #1) listing the daemons it supervises, but stays state-light and is updated only when a new daemon registers. It does NOT gain portal logic.
- **thehive** — a new always-on **portal daemon**. It boots on OS start, serves the unified dashboard by fetching from each registered daemon's API, and is updateable independently of hivedoctor. It is the single source of always-on UI truth regardless of which workload daemon is healthy.
- **hivenectar** + **honeycomb** — the two **workload daemons**, both supervised by hivedoctor, both surfaced in thehive's portal.

This realizes the user's three-part ask — a stable supervisor, an updateable always-on portal that boots with the device, and process-isolated workload daemons — and replaces the two-daemon framing in [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) with a three-daemon topology recorded in a new **ADR-0003** (triggered by this PRD).

The decision is a **process-layer** topology change only. The data layer is unchanged: hivenectar reads and writes the **same Deep Lake tables** (`source_graph`, `source_graph_versions`), scoped by the same `org`/`workspace`/`project` tenancy, and composes with honeycomb via the shared recall engine. Independence is at the process boundary; the shared substrate is preserved. This PRD owns the role boundaries and the hivenectar process surface; thehive and the hivedoctor registry are owned by [PRD-004](../prd-004-hivedoctor-registry-and-thehive/prd-004-hivedoctor-registry-and-thehive-index.md).

---

## Goals

- Define the **four roles** (hivedoctor, thehive, hivenectar, honeycomb) and their boundaries precisely enough that every later PRD conforms to exactly one of them.
- Establish the **invariant** that independence is process-layer only — no shared in-process state crosses any of the four boundaries, while the data layer (Deep Lake tables, recall union, Portkey, embeddings, CodeGraph) is shared.
- Trigger an **ADR-0003** recording the three-daemon topology, superseding the two-daemon framing in ADR-0002's "independent daemon supervised by hivedoctor" decision without disturbing ADR-0002's load-bearing invariants (shared data layer, process-layer-only independence).
- Specify hivenectar's own **process surface**: OS process, single-instance PID/lock, `/health` endpoint, Deep Lake client, and tenancy scope — modeled on honeycomb's existing composition root and lifecycle.
- Specify the **shared-infra consumption contract**: the Portkey, embeddings, CodeGraph, and recall seams hivenectar reaches through its own clients, and the deploy-time tenancy invariant that keeps its rows readable by honeycomb's recall engine.
- Lock the **port assignment** and **PID/lock file paths** for the new daemons so every downstream PRD (PRD-002 daemon, PRD-003 supervision, PRD-004 thehive/registry, PRD-008 API, PRD-015 dashboard) cites one contract.

## Non-Goals

- The hivedoctor daemon registry implementation and the thehive daemon implementation — **PRD-004** (out-of-band to the hivedoctor/hive projects). This PRD only defines the role boundaries and consumes the registry as a given.
- hivenectar's daemon bootstrap sequence, composition root, and CLI surface — **PRD-002**. This PRD defines the *contract* the daemon conforms to (process, lock, health, tenancy); it does not design the worker harness.
- hivenectar's OS service unit and watchdog-war guards — **PRD-003**.
- The Deep Lake table schemas — **PRD-005**. This PRD states the tables are shared and the tenancy is `org`/`workspace`/`project`; PRD-005 owns the DDL.
- The recall arm that reads hivenectar's rows — **PRD-013**.
- The dashboard page hosted in thehive — **PRD-015**.

---

## Features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-001a-three-daemon-topology-adr-and-roles`](./prd-001a-three-daemon-topology-adr-and-roles.md) | The ADR-0003 trigger + the four-role contract (hivedoctor / thehive / hivenectar / honeycomb boundaries) | Draft |
| [`prd-001b-hivenectar-process-and-health`](./prd-001b-hivenectar-process-and-health.md) | hivenectar's own process, single-instance PID/lock, `/health` endpoint, Deep Lake client, tenancy scope | Draft |
| [`prd-001c-shared-infra-consumption`](./prd-001c-shared-infra-consumption.md) | The Portkey / embeddings / CodeGraph / recall seams hivenectar consumes, and the deploy-time tenancy invariant | Draft |

---

## Acceptance Criteria

- [ ] An **ADR-0003** exists at `knowledge/private/architecture/ADR-0003-<three-daemon-topology-slug>.md` recording the three-daemon topology; its header marks it as **superseding ADR-0002's two-daemon framing** while preserving ADR-0002's load-bearing invariants (shared Deep Lake tables, process-layer-only independence).
- [ ] The four roles (hivedoctor, thehive, hivenectar, honeycomb) each have a one-paragraph boundary statement naming what they own and what they explicitly do NOT own; no two roles own the same concern (no overlapping process-boundary, registry, portal, or storage responsibilities).
- [ ] The PRD states, and the ADR-0003 records, that **no in-process state is shared across any of the four roles** — each daemon is a separate OS process with its own lifecycle, failure domain, and release cadence.
- [ ] hivenectar's process surface (port, PID/lock paths, `/health` contract, Deep Lake client, tenancy scope) is specified with a Honeycomb code citation for every claim, and the port and paths are flagged as **"DEFAULT — confirm before implementation."**
- [ ] The shared-infra consumption contract names each seam (Portkey, embeddings, CodeGraph, recall) hivenectar reaches through its own client, and states the deploy-time tenancy invariant (both daemons point at the same Deep Lake org/workspace) that keeps hivenectar's rows readable by honeycomb's recall engine.
- [ ] The port map is consistent with the real Honeycomb code: 3850 honeycomb, 3851 embeddings, 3852 hivedoctor status page are all occupied; thehive and hivenectar use free ports with no collision.

---

## Port + path contract (locked for every downstream PRD)

> **This block is the single source of truth for ports and PID/lock paths.** PRD-002, PRD-003, PRD-004, PRD-008, and PRD-015 cite it instead of re-deriving.

| Daemon / surface | Port | Code citation (occupied) | Status |
|---|---|---|---|
| honeycomb daemon | 3850 | [`honeycomb/src/shared/constants.ts:14`](../../../../honeycomb/src/shared/constants.ts) `DAEMON_PORT = 3850` | Occupied |
| embeddings daemon | 3851 | [`honeycomb/embeddings/src/index.ts:68`](../../../../honeycomb/embeddings/src/index.ts) `EMBED_PORT = 3851` | Occupied |
| hivedoctor status page | 3852 | [`honeycomb/hivedoctor/src/status-page/server.ts:93`](../../../../honeycomb/hivedoctor/src/status-page/server.ts) `DEFAULT_STATUS_PAGE_PORT = 3852` | Occupied |
| **thehive portal** | **3853** | **CONFIRMED** (hivedoctor status page occupies 3852) | |
| **hivenectar daemon** | **3854** | **CONFIRMED** (next free after thehive=3853) | |

> **Why these defaults differ from the original brief.** The brief proposed thehive=3852 / hivenectar=3853 reasoning "3852 is the next free." The Honeycomb code proves 3852 is **already taken** by hivedoctor's status page (`hivedoctor/src/status-page/server.ts:93`, `DEFAULT_STATUS_PAGE_PORT = 3852`). Assigning thehive to 3852 produces a runtime `EADDRINUSE` collision. The next genuinely free ports are 3853 (thehive) and 3854 (hivenectar). This is flagged as a default pending confirmation; if the operator prefers a different free port, only this table changes.

| Daemon | PID file | Lock file | Mirrors |
|---|---|---|---|
| honeycomb | `~/.honeycomb/daemon.pid` | `~/.honeycomb/daemon.lock` | [`honeycomb/src/daemon/runtime/assemble.ts:184,186,715-731`](../../../../honeycomb/src/daemon/runtime/assemble.ts) — `LOCK_FILE_NAME = "daemon.lock"`, `PID_FILE_NAME = "daemon.pid"` under `~/.honeycomb` |
| **thehive** | `~/.honeycomb/thehive.pid` | `~/.honeycomb/thehive.lock` | **DEFAULT — confirm before implementation** |
| **hivenectar** | `~/.honeycomb/hivenectar.pid` | `~/.honeycomb/hivenectar.lock` | **DEFAULT — confirm before implementation** |

The `~/.honeycomb` runtime dir is the honeycomb convention: `LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb"` ([`honeycomb/src/daemon/runtime/auth/credentials-store.ts:71`](../../../../honeycomb/src/daemon/runtime/auth/credentials-store.ts)), resolved via `join(homedir(), LEGACY_CREDENTIALS_DIR_NAME)` ([`honeycomb/src/daemon/runtime/assemble.ts:688-690`](../../../../honeycomb/src/daemon/runtime/assemble.ts)). thehive and hivenectar place their own `*.pid` / `*.lock` siblings in the same dir so a single `ls ~/.honeycomb/*.pid` enumerates every live daemon — mirroring how hivedoctor already reads `~/.honeycomb/daemon.pid` ([`honeycomb/hivedoctor/src/config.ts:53,155`](../../../../honeycomb/hivedoctor/src/config.ts)).

---

## Related

- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — decision #1 (the three-daemon topology) and the PRD-001 brief this expands.
- [`knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) — the two-daemon decision this PRD's ADR-0003 supersedes (process-layer framing) while preserving its invariants.
- [`knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../../knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md) — the identity-model decision, unaffected by topology.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the recall composition preserved across the process boundary.
- [`prd-005-source-graph-catalog-tables`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — owns the shared data layer (tables + tenancy) this PRD states as shared.
- [PRD-004](../prd-004-hivedoctor-registry-and-thehive/prd-004-hivedoctor-registry-and-thehive-index.md) — owns the hivedoctor registry + thehive portal daemon (out-of-band, hivedoctor/hive projects).
