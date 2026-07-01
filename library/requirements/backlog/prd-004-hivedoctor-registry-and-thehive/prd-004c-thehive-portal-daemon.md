# PRD-004c: thehive portal daemon — bootstrap, always-on dashboard serving, API aggregation

> **Codebase:** `honeycomb` repo → a new `thehive/` package (a new daemon). This is an out-of-band sub-PRD; it lands in the honeycomb repo, not hivenectar.

## Overview

**thehive** is a new always-on portal daemon — the single source of always-on UI truth. It boots immediately on OS start (supervised by hivedoctor like the other daemons), is updateable independently of hivedoctor, and serves the unified dashboard by **reusing honeycomb's existing dashboard code** (`src/dashboard/web/`) rather than rewriting it, and by **fetching data from each registered daemon's API** rather than owning any workload data itself. This is decision #1's part (b): the dashboard is up the moment the device boots, regardless of which workload daemon is healthy.

Today the dashboard lives inside the honeycomb daemon's HTTP server (`src/daemon/runtime/server.ts` mounts `/` as an unprotected route at `server.ts:108`) and is served alongside honeycomb's `/health` (`server.ts:319-341`) and `/api/*` groups (`server.ts:71-109`). When honeycomb is down, the dashboard is down. thehive lifts the dashboard surface into its own always-on process so it survives any single workload daemon's outage.

## Goals

- thehive is a standalone TS/Node + Hono daemon in the honeycomb repo, with its own OS process, own `/health`, own PID/lock, and own port.
- thehive serves the unified dashboard by reusing the existing `src/dashboard/web/` code (route registry, pages, shell) — no dashboard rewrite.
- thehive is always-on: it boots immediately on OS start (004d's service unit) and stays up independent of any workload daemon's health.
- thehive aggregates data by fetching each registered daemon's `/api/*` endpoints, so a workload daemon's pages hydrate from that daemon's own API through thehive.
- thehive is updateable independently of hivedoctor: upgrading thehive does not restart hivedoctor, and vice versa.

## Non-Goals

- thehive owns NO workload/data logic. Every row it renders comes from a registered daemon's API; thehive is a portal + aggregation layer.
- thehive does NOT host the loopback comfort status page — that stays hivedoctor's (`hivedoctor/src/status-page/server.ts`). thehive's dashboard is the workload surface; hivedoctor's page is the supervisor surface.
- thehive does NOT replace honeycomb's own dashboard server. honeycomb may still serve its dashboard directly when up; thehive is the always-on instance that is up even when honeycomb is not. (DEFAULT — confirm before implementation: whether honeycomb's in-process dashboard is later removed in favor of thehive-only is a follow-up decision, out of scope here.)
- thehive does NOT register new daemons at runtime. Registration is a file edit by installers (004d).
- This sub-PRD does NOT define dashboard *page content* (the Source Graph page is PRD-015). It delivers the thehive process + dashboard-serving + aggregation contract.

---

## User stories + acceptance criteria

### US-1 — Always-on dashboard

**As** an operator, **when** the device boots, **I** can open the dashboard immediately, even if no workload daemon is up yet.

| ID | Criterion |
|---|---|
| c-AC-1 | Given thehive's OS service unit (004d) is installed, when the device boots, then thehive starts and serves the dashboard on its port without waiting for honeycomb or hivenectar. |
| c-AC-2 | Given thehive is running but honeycomb is down, when an operator loads the dashboard, then the shell + navigation render (the always-on UI truth), and any panel whose data source is honeycomb shows that source as unreachable rather than blanking the whole dashboard. |

### US-2 — Reuses the existing dashboard code

**As** a maintainer, **when** thehive serves the dashboard, **I** see the SAME route registry + pages honeycomb uses, not a fork.

| ID | Criterion |
|---|---|
| c-AC-3 | Given the dashboard route registry (`src/dashboard/web/registry.tsx:196-218` `ROUTES`), when thehive serves the dashboard, then it renders the same registry entries (Dashboard, Projects, Harnesses, Memories, Memory Graph, Sync, Logs, ROI, Settings) — thehive imports and serves `ROUTES` rather than re-declaring it. |
| c-AC-4 | Given a dashboard page component (`src/dashboard/web/pages/*`, taking `PageProps` per `registry.tsx:91`), when thehive mounts it, then the page hydrates through the same `usePoll`/`wire` pattern the existing pages use (per the "how to add a page" contract at `registry.tsx:10-22`). |

### US-3 — API aggregation from each daemon

**As** the dashboard, **when** a page needs data, **I** fetch it from the owning daemon's `/api/*` endpoint via thehive.

| ID | Criterion |
|---|---|
| c-AC-5 | Given a registered daemon's `/api/*` surface (e.g. honeycomb's mounted groups at `src/daemon/runtime/server.ts:71-109`), when a dashboard page requests data owned by that daemon, then thehive proxies/fetches from that daemon's `/api/*` endpoint and returns the result. |
| c-AC-6 | Given thehive aggregates from N daemons, when one daemon's `/api/*` is unreachable, then thehive returns a fail-soft empty/unreachable result for that source and the rest of the dashboard keeps working (mirroring the graceful-degradation posture). |

### US-4 — Independent updateability

**As** an operator, **when** thehive is upgraded, **I** do not want hivedoctor to restart.

| ID | Criterion |
|---|---|
| c-AC-7 | Given thehive and hivedoctor are separate OS-level services (004d), when thehive is stopped/updated/started, then hivedoctor's process and its supervisor instances keep running, and hivedoctor simply observes thehive's `/health` go down and (within its grace window) come back. |

---

## Implementation notes

### Daemon bootstrap (Hono, modeled on honeycomb's server)

thehive is a TS/Node + Hono daemon. Its HTTP server mirrors honeycomb's `createDaemon` shape (`src/daemon/runtime/server.ts:226-421`): construct a `Hono` app, mount the dashboard surface, implement `/health`, and bind a socket in a `startThehive` entrypoint (the production `listen()` analogue of honeycomb's `startDaemon`, called only in production per `server.ts:20-21`). thehive's `/health` is a cheap liveness endpoint modeled on honeycomb's `/health` (`server.ts:319-341`) — coarse `status` + `uptimeMs` + `version`, no heavy query — so hivedoctor's probe (004a's per-entry `healthUrl`) gets a fast ok/degraded answer.

**Port (CONFIRMED):** thehive serves on **3853**. This is the next genuinely-free port after hivedoctor's loopback status page, which binds **3852** (`hivedoctor/src/status-page/server.ts:93` `DEFAULT_STATUS_PAGE_PORT = 3852`). Honeycomb occupies 3850 (daemon) and 3851 (embeddings). hivenectar takes 3854 (see PRD-001b). There is no port conflict — 3853 was free.

**PID/lock (DEFAULT — confirm before implementation):** thehive writes `~/.honeycomb/thehive.pid` / `~/.honeycomb/thehive.lock` — the single-instance guard hivedoctor's restart rung respects via the registry entry's `pidPath` (004a, `hivedoctor/src/remediation.ts:111, 147-151`).

### Reusing the dashboard code (no rewrite)

thehive imports honeycomb's dashboard module rather than forking it. The route registry is the single extension point: `ROUTES` (`src/dashboard/web/registry.tsx:196-218`) is an ordered list of `RouteEntry` (`registry.tsx:83-94`) that BOTH the sidebar and the router outlet read (`registry.tsx:6-9`). thehive mounts the same shell that consumes `ROUTES` + `matchRoute` (`registry.tsx:230-240`) + `DEFAULT_ROUTE` (`registry.tsx:221`), so every existing page (Dashboard, Projects, Harnesses, Memories, Memory Graph, Sync, Logs, ROI, Settings) renders through thehive unchanged. Adding the Source Graph page (PRD-015) is then one `RouteEntry` in `ROUTES` (`registry.tsx:10-22`) — and it automatically appears in thehive because thehive reads the same list (c-AC-3).

This delivers c-AC-4 too: every page component takes `PageProps` (`registry.tsx:91`) and hydrates via the shared `wire` client + `usePoll` (`registry.tsx:13-16`); thehive passes its own `wire` (the API-aggregation client below) down, so the pages work identically whether served by honeycomb or thehive.

### API aggregation layer

thehive's `wire` client (the `PageProps.wire` the pages hydrate through) is an aggregation client that routes each request to the owning daemon. Today honeycomb's dashboard `wire` calls honeycomb's own `/api/*` in-process. thehive's `wire` instead maps a request to the registered daemon that owns it (honeycomb's `/api/memories`, `/api/graph`, etc. per `server.ts:74-107`; hivenectar's `/api/source-graph/*` per PRD-008) and fetches that daemon's `/api/*` endpoint, returning the result to the page. This is c-AC-5/c-AC-6: the dashboard surface is unified, the data is federated.

The registry (004a) is the routing table for this aggregation: each registry entry's `healthUrl` host tells thehive where that daemon's `/api/*` lives (the `/health` and `/api/*` share a host/port — honeycomb mounts both at `server.ts:71-109` + `:319`). A daemon absent from the registry, or failing `/health`, yields the fail-soft unreachable result for its pages (c-AC-2/c-AC-6).

### Independent updateability + supervision

thehive is supervised by hivedoctor exactly like the others: it has a registry entry (004a) with its own `healthUrl`/`pidPath`/intervals, hivedoctor probes it on every tick, and hivedoctor's restart rung restarts it if it crashes. Because thehive and hivedoctor are separate OS-level services (004d), upgrading thehive (stopping + repackaging + restarting thehive's service) does not touch hivedoctor's process — hivedoctor simply observes thehive's `/health` transition within the entry's `startupGraceMs` (004a) and resumes confirming health (c-AC-7). The watchdog-war guards (`hivedoctor/src/remediation.ts:124-160`) apply to thehive the same way they apply to honeycomb.

## Related

- [`prd-004d-thehive-service-unit-and-registration.md`](./prd-004d-thehive-service-unit-and-registration.md) — thehive's OS service unit + registry entry.
- [`prd-004a-hivedoctor-registry-config-and-supervisor-instances.md`](./prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) — the registry thehive's aggregation routes over.
- [`prd-004-hivedoctor-registry-and-thehive-index.md`](./prd-004-hivedoctor-registry-and-thehive-index.md) — module scope.
- **Design references (corpus):** [`ADR-0004-thehive-portal-daemon-role-and-boundaries.md`](../../../knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) (the four binding boundaries this sub-PRD implements: always-on + boot-order, API-aggregation-not-Deep-Lake, dashboard ownership + honeycomb code reuse, independent update cadence) and [`thehive-portal-daemon.md`](../../../knowledge/private/architecture/thehive-portal-daemon.md) (the full thehive design reference).
- **Topology ADR:** [`ADR-0003-three-daemon-topology-and-thehive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md) (the three-daemon topology that introduces thehive).
- **Dashboard-page consumer:** PRD-015 (the Source Graph page that lands in thehive's dashboard).
