# thehive Portal Daemon — design reference

> Category: Architecture | Version: 1.0 | Date: June 2026 | Status: Active

The full design detail for **thehive**, the always-on portal daemon of the Hivenectar three-daemon topology: its component breakdown, the API-aggregation protocol mechanics, the dashboard route inventory, and its deployment/lifecycle model. This is the narrative companion to [ADR-0004](ADR-0004-thehive-portal-daemon-role-and-boundaries.md) (which records the decisions) and [PRD-004c/004d](../../../requirements/backlog/prd-004-hivedoctor-registry-and-thehive/) (which specify the build). Read ADR-0004 first for the *why*; this doc is the *what* and *how*.

**Related:**
- [`ADR-0004-thehive-portal-daemon-role-and-boundaries.md`](ADR-0004-thehive-portal-daemon-role-and-boundaries.md)
- [`ADR-0003-three-daemon-topology-and-thehive-portal.md`](ADR-0003-three-daemon-topology-and-thehive-portal.md)
- [`../../../requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md`](../../../requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md)
- [`../../../requirements/backlog/prd-015-dashboard-source-graph-page/`](../../../requirements/backlog/prd-015-dashboard-source-graph-page/)

---

## What thehive is, in one paragraph

thehive is a TypeScript/Node + Hono daemon that serves the unified dashboard for the Hivenectar ecosystem. It is one of three daemon roles in the topology decided by ADR-0003: hivedoctor supervises, thehive portals, and the workload daemons (honeycomb, hivenectar) do the work. thehive boots on OS start as a supervised daemon in its own right (sibling to the workloads, not a child of any of them), renders the dashboard shell the moment its socket binds — before any workload daemon is confirmed healthy — and populates that shell by fetching data from each registered daemon's HTTP API. It holds no Deep Lake client, runs no queries, and resolves no tenancy scope. It is a thin portal: presentation plus an aggregation seam.

## The four binding properties (from ADR-0004)

These are the load-bearing decisions; this doc expands each into design detail.

1. **Always-on + boot-order contract** — thehive serves the shell before any workload is healthy.
2. **API aggregation, not direct Deep Lake access** — thehive fetches from daemon APIs; it is not a data-plane consumer.
3. **Dashboard ownership + reuse** — thehive owns the unified dashboard and reuses honeycomb's `registry.tsx` / `pages/*` rather than forking.
4. **Update-cadence boundary** — thehive ships independently of hivedoctor and the workloads.

---

## Component breakdown

```mermaid
flowchart TD
    subgraph thehive["thehive (port 3853)"]
        shell["dashboard shell<br/>(static HTML + assets)"]
        server["Hono HTTP server<br/>(dashboard + aggregation routes)"]
        agg["aggregation layer<br/>(per-daemon wire routing + fail-soft)"]
        cache["aggregation cache<br/>(per-route TTL)"]
        shell --> server
        server --> agg
        agg --> cache
    end
    os["OS service manager"] --> thehive
    thehive -->|hivedoctor registry read| reg["~/.honeycomb/hivedoctor.daemons.json"]
    agg -->|"GET /api/* honeycomb :3850"| honeycomb["honeycomb daemon"]
    agg -->|"GET /api/* hivenectar :3854"| hivenectar["hivenectar daemon"]
    honeycomb -. unreachable .-x agg
    hivenectar -. unreachable .-x agg
```

| Component | Responsibility | Notes |
|---|---|---|
| **OS service unit** | Boots thehive on device start; restarts on crash | launchd `com.thehive.daemon` / systemd `thehive` / schtasks `TheHiveDaemon` (PRD-004d). Sibling to hivedoctor's unit, not a child of a workload. |
| **Dashboard shell** | Static HTML + assets rendered before any API call | The always-on guarantee: the shell + a daemon-status grid render the moment the socket binds. API data populates async. |
| **Hono HTTP server** | Serves the shell + the dashboard routes + the aggregation routes | Modeled on honeycomb's `src/daemon/runtime/server.ts` (Hono, route groups, unprotected `/health`). |
| **Aggregation layer** | Per-daemon `wire` routing — each dashboard request is dispatched to the owning daemon's API | The seam from ADR-0004 decision 2. Fail-soft per daemon: unreachable → empty section + "daemon unreachable" badge, never a 500. |
| **Aggregation cache** | Per-route TTL cache of aggregated responses | Mitigates the network-hop latency ADR-0004 acknowledges. Invalidation is TTL-based (thehive is a portal, not a source of truth — stale-then-refresh is acceptable). |
| **hivedoctor registry reader** | Reads `~/.honeycomb/hivedoctor.daemons.json` to know which daemons exist + their API base URLs | Read on boot + on a slow poll. thehive does not own the registry (hivedoctor does); it consumes it. |

---

## The API-aggregation protocol (the seam)

This is the most consequential design element — the contract that keeps thehive thin while letting it render data from any registered daemon.

### Request flow

1. A browser hits a thehive dashboard route (e.g. `/source-graph`).
2. thehive's Hono server matches the route to a `PageProps` component (reused from honeycomb's `registry.tsx`).
3. The component calls `wire.<method>(...)` to fetch its data.
4. thehive's `wire` implementation routes the call to the **owning daemon's** API — not to an in-process handler. For `/source-graph` data, that's `GET http://127.0.0.1:3854/api/source-graph/*` (hivenectar).
5. The aggregation cache is checked first (per-route TTL); on miss, the HTTP fetch fires.
6. On success, the response is cached + returned. On unreachable, the fail-soft path returns an empty payload + a degradation flag the component renders as "daemon unreachable."

### The `wire` abstraction

thehive reuses honeycomb's `wire` interface (the data-fetch abstraction honeycomb's dashboard components already call against). The difference is the *implementation*: honeycomb's `wire` resolves to in-process handlers; thehive's `wire` resolves to per-daemon HTTP routes. The component layer does not know which — it calls `wire.memoryGraph(project)` and gets back data either way. This is what "reuse without forking" means concretely: same component code, different `wire` backend.

### Per-daemon routing table

| Dashboard route | Owning daemon | Daemon API |
|---|---|---|
| `/` (Dashboard) | honeycomb | `:3850/api/*` |
| `/projects` | honeycomb | `:3850/api/*` |
| `/harnesses` | honeycomb | `:3850/api/*` |
| `/memories` | honeycomb | `:3850/api/*` |
| `/graph` (memory graph) | honeycomb | `:3850/api/*` |
| `/sync`, `/logs`, `/roi`, `/settings` | honeycomb | `:3850/api/*` |
| `/source-graph` (PRD-015, NEW) | hivenectar | `:3854/api/source-graph/*` |

The existing honeycomb routes are served by proxying to honeycomb's API. The new `/source-graph` route (PRD-015) is the first hivenectar-owned route. Future hivenectar-owned pages (or pages from future workload daemons) extend this table.

### Fail-soft contract

- A daemon unreachable on a given route → that route's section renders empty + a "daemon unreachable" badge. thehive never returns a 500 for a workload outage.
- A daemon returning an error payload → the section renders the error inline (operator-facing, not a broken page).
- thehive's own `/health` is independent — it reports `ok` as long as thehive's server is up, regardless of workload daemon health.

---

## Dashboard ownership + code reuse

thehive owns the unified dashboard: every route a user visits lives here, including the existing honeycomb pages (proxied) and the new Source Graph page (PRD-015). The component layer — the React components in `pages/*`, the route registry in `registry.tsx`, the `PageProps` shape — is **reused from honeycomb**, not forked. Concretely:

- **Route registry**: thehive imports/mirrors honeycomb's `ROUTES` array (`honeycomb/src/dashboard/web/registry.tsx:196-218`) and extends it with the new `/source-graph` entry.
- **Page components**: the existing honeycomb pages render unchanged in thehive (their `wire` calls hit honeycomb's API via thehive's aggregation). The new `SourceGraphPage` is a thehive-authored component that calls `wire` for hivenectar data.
- **`PageProps`**: the `{ wire, daemonUp, assetBase }` shape is preserved (thehive's `wire` is a different implementation, same interface).

The "how to add a page" contract documented at `honeycomb/library/knowledge/private/dashboard/adding-a-page.md` applies: write a `function MyPage({ wire, ... })`, add a `RouteEntry`, done — except the `wire` now routes cross-daemon.

---

## Deployment + lifecycle

### Boot ordering

```mermaid
sequenceDiagram
    participant OS as OS service manager
    participant HD as hivedoctor
    participant TH as thehive
    participant HB as honeycomb
    participant HN as hivenectar
    OS->>HD: boot (service unit)
    OS->>TH: boot (service unit, sibling)
    OS->>HB: boot (service unit)
    OS->>HN: boot (service unit)
    TH->>TH: bind socket 3853
    TH->>TH: render shell + status grid (NO workload dependency)
    Note over TH: dashboard is LIVE before any workload /health
    HD->>TH: probe /health (registry entry)
    HD->>HB: probe /health (registry entry)
    HD->>HN: probe /health (registry entry)
    TH->>HB: GET /api/* (populate dashboard, fail-soft)
    TH->>HN: GET /api/* (populate dashboard, fail-soft)
```

All four daemons are siblings under the OS service manager. There is no parent-child dependency. thehive renders its shell the instant its own socket binds; workload data populates as each workload comes healthy.

### Process surface

| Property | Value | Source |
|---|---|---|
| Port | 3853 | PRD-001b (confirmed) |
| PID file | `~/.honeycomb/thehive.pid` | PRD-004d |
| Lock file | `~/.honeycomb/thehive.lock` | PRD-004d (single-instance guard) |
| OS service unit | launchd `com.thehive.daemon` / systemd `thehive` / schtasks `TheHiveDaemon` | PRD-004d (mirrors honeycomb naming) |
| `/health` | `ok`/`degraded` — independent of workload health | ADR-0004 decision 1 |
| Registry entry | one row in `~/.honeycomb/hivedoctor.daemons.json` | PRD-004a (thehive is supervised like the others) |
| Stack | TypeScript/Node + Hono (reuses honeycomb's dashboard code) | PRD-004c, ADR-0004 decision 3 |

### Update cadence

thehive is a **separate release train** from hivedoctor, honeycomb, and hivenectar. A dashboard change ships as a thehive release (new bundle + restart of thehive's service unit); it does not touch hivedoctor or the workloads. Conversely, an hivedoctor release does not redeploy thehive. This is the operational realization of the stability/velocity split (ADR-0003 + ADR-0004 decision 4).

---

## What thehive explicitly is NOT

- **Not a Deep Lake client.** No storage client, no tenancy scope, no queries. (ADR-0004 decision 2.)
- **Not a supervisor.** It does not probe `/health`, restart daemons, or own incident state — that's hivedoctor.
- **Not a workload.** It does not brood, enrich, recall, or run any Hivenectar/honeycomb logic. It presents + aggregates.
- **Not a child of a workload.** It is a top-level supervised daemon, sibling to the workloads, so a workload outage does not take it down.
- **Not a fork of honeycomb's dashboard.** It reuses the component layer; only the `wire` backend differs.

---

## Forward pointers

- **The decisions** (always-on, aggregation, ownership, cadence) → [`ADR-0004`](ADR-0004-thehive-portal-daemon-role-and-boundaries.md).
- **The build spec** (bootstrap, Hono server, aggregation `wire`, service unit, registration) → [`prd-004c`](../../../requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md) + [`prd-004d`](../../../requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004d-thehive-service-unit-and-registration.md).
- **The first thehive-hosted page** (Source Graph) → [`prd-015`](../../../requirements/backlog/prd-015-dashboard-source-graph-page/).
- **The reused dashboard code** → `honeycomb/src/dashboard/web/registry.tsx` + `honeycomb/src/dashboard/web/pages/*`.
- **The topology thehive sits inside** → [`ADR-0003`](ADR-0003-three-daemon-topology-and-thehive-portal.md).
