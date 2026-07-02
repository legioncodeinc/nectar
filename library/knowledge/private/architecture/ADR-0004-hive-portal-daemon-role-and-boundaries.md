# ADR-0004, hive portal daemon: role, boundaries, and the always-on contract

> **Status:** Accepted · **Date:** 2026-06-30
> **Supersedes:** none · **Superseded by:** none
> **Owners:** platform, hive, daemon
> **Related:** `ADR-0003-three-daemon-topology-and-hive-portal.md`, `ADR-0002-nectar-independent-daemon-supervised-by-doctor.md`, `../../../requirements/MASTER-PRD-INDEX.md`, `../../../requirements/backlog/prd-004-doctor-registry-and-hive/`, `../../../requirements/backlog/prd-015-dashboard-hive-graph-page/`
> **Refined by:** [hive ADR-0001, retire honeycomb dashboard and copy-and-own into hive](../../../../../hive/library/knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md), which supersedes decision #3's reuse-by-runtime-import mechanism with copy-and-own plus honeycomb dashboard retirement (hive is now a first-class product of hive repository, separate from honeycomb); and [hive ADR-0002, server-side BFF proxy for dashboard federation](../../../../../hive/library/knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md), which fixes decision #2's aggregation mechanism as a server-side proxy (browser same-origin to hive) rather than client-side federation.

## Context

ADR-0003 decided that the always-on portal surface would be split out of doctor (the supervisor) into a new daemon, **hive**, in order to preserve a stability/velocity split: doctor stays minimal and rare-to-update while hive absorbs the fast-moving dashboard surface. That ADR recorded *that* hive exists and *why* it is separate from doctor. It did not record what hive *is* — its role, its boundaries, the load-bearing properties that make it a distinct architectural component rather than "another daemon that happens to serve HTTP."

Four questions were left open and are consequential enough to warrant their own ADR, because each is hard or expensive to reverse and each shapes what engineers build into (or keep out of) hive for years:

1. **What is the always-on guarantee, and what boot ordering makes it real?** "The dashboard is up the moment the device boots" is the property that justifies hive's existence. If hive depends on a workload daemon being healthy to serve its shell, it is not always-on — it is "on when Honeycomb is up," which is what we already had.
2. **Does hive read Deep Lake directly, or aggregate from each daemon's API?** This is the seam that determines whether hive is a thin portal or a second data-plane consumer. It shapes every dashboard route and every fail-soft behavior.
3. **What does hive own in the dashboard, and does it reuse Honeycomb's existing dashboard code or fork it?** Affects whether portal iteration is fast (reuse) or duplicated work (fork).
4. **What is the update-cadence boundary?** Concretely: can hive ship a dashboard change without an doctor release, and vice versa? If not, the stability/velocity split ADR-0003 named does not actually exist.

The research in `MASTER-PRD-INDEX.md` and PRD-004c/004d grounds each answer in the real Honeycomb code; this ADR records the decisions.

## Decision drivers

- **Always-on as a real property, not a slogan.** The dashboard shell must render before any workload daemon is confirmed healthy. This forces hive to be a supervised daemon in its own right (booted by the OS service manager alongside doctor), not a child of a workload.
- **Workload independence.** Honeycomb and Nectar evolve on their own cadences and fail independently. hive must render useful content when one or both are down — partial data, not a blank page.
- **Stability/velocity split (from ADR-0003).** doctor changes rarely; hive changes often. The boundary between them must be crisp enough that a portal update never forces a supervisor release.
- **No second data plane.** hive must not become a second Deep Lake client with its own tenancy scope and query surface — that would duplicate the workload daemons' storage contracts and create a new drift source. It is a *portal*, not a *store*.
- **Reuse over fork.** Honeycomb already ships a working dashboard (`src/dashboard/web/` — registry, pages, wire). Forking it into hive would duplicate working code and diverge over time.

> **Refined by hive ADR-0001 (2026-07):** this driver still holds, but hive ADR-0001 realizes it through copy-and-own rather than reuse-by-runtime-import. Because hive lives in hive repository (separate from honeycomb) and honeycomb's dashboard is retired, a one-time copy with ownership transfer replaces a live shared module. This is neither a runtime-shared reuse nor a divergent fork: honeycomb deletes its copy, so there is nothing to diverge from.

## Decision

hive is the **always-on portal daemon** of the three-daemon topology. Four binding decisions define it.

### 1. Always-on + boot-order contract

hive is a supervised daemon in its own right, booted by the OS service manager (launchd/systemd/schtasks) on device start, exactly as doctor and the workload daemons are. It is **not** a child process of a workload daemon and **not** gated on any workload's `/health`. The dashboard shell renders the moment hive's socket is bound — before Honeycomb or Nectar is confirmed healthy. Concretely: hive serves a static shell + a per-daemon status grid that degrades gracefully (a daemon that has not yet answered `/health` renders as "starting," not as a broken page).

This is the load-bearing property. Anything that makes hive's shell depend on a workload being up destroys the reason hive exists.

### 2. API aggregation, not direct Deep Lake access

hive does **not** read Deep Lake directly. It does not hold a Deep Lake client, does not resolve tenancy scope, and does not run queries. It fetches data from each registered daemon's HTTP API — `/api/*` on honeycomb and nectar — and aggregates the responses into the unified dashboard. The aggregation layer is fail-soft per daemon: if honeycomb's API is unreachable, the honeycomb-sourced dashboard sections render empty or "daemon unreachable," while the nectar-sourced sections still render.

This keeps hive a thin portal. The workload daemons own their data contracts, their tenancy scoping, and their query surfaces; hive owns only the presentation + aggregation seam. A new workload daemon joins the dashboard by exposing an API hive aggregates — not by sharing a Deep Lake client.

> **Refined by hive ADR-0002 (2026-07):** the aggregation BOUNDARY here (no Deep Lake client, every row from a daemon's `/api/*`, fail-soft per daemon) is unchanged. hive [`ADR-0002`](../../../../../hive/library/knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) fixes the MECHANISM: aggregation is a SERVER-SIDE proxy on hive (the browser fetches hive same-origin; hive proxies over loopback to the owning daemon), not a client-side federated `wire` fetching each daemon's origin from the browser. This removes the CORS allowance every workload daemon would otherwise owe and keeps the loopback-trust decision server-side.

### 3. Dashboard ownership + reuse of Honeycomb's dashboard code

hive owns the unified dashboard: every dashboard route (the existing honeycomb pages plus the new Hive Graph page per PRD-015) lives in hive. It reuses Honeycomb's existing dashboard code — the route registry (`honeycomb/src/dashboard/web/registry.tsx`), the page components (`pages/*`), the `wire` data-fetch abstraction — rather than forking it. hive's `wire` implementation routes each request to the owning daemon's API (per decision 2) instead of honeycomb's in-process handlers, but the component layer is shared.

The Hive Graph page (PRD-015) lands in hive and fetches from nectar's `/api/hive-graph/*` endpoints (PRD-008) through hive's aggregation `wire` — not directly into nectar's Deep Lake tables.

> **Refined by hive ADR-0001 (2026-07):** the reuse-by-runtime-import mechanism named in this decision is superseded by copy-and-own. hive is now a first-class product of hive repository, separate from honeycomb, and honeycomb's dashboard is retired, so hive copies `honeycomb/src/dashboard/web/*` into hive and owns the result rather than importing honeycomb's dashboard module at runtime. See hive ADR-0001 and PRD-001b's file-by-file copy-map. The dashboard-ownership half of this decision (hive owns the unified dashboard) is unchanged.

### 4. Update-cadence boundary

hive is **independently updateable** of both doctor and the workload daemons. A dashboard change ships as a hive release; it does not require an doctor release, a honeycomb release, or a nectar release. Conversely, doctor's rare updates do not force a hive redeploy. The three release trains are decoupled. This is the velocity half of the stability/velocity split ADR-0003 named — this decision makes it operationally real.

## Consequences

**Positive.**

- The dashboard is up the moment the device boots, regardless of workload health. Operators get a status surface during outages, not after them.
- hive stays a thin portal: no Deep Lake client, no tenancy scope, no query surface to maintain. New workload daemons join via an API contract, not a shared client.
- Portal iteration velocity is decoupled from supervisor stability. Dashboard changes ship at hive's cadence.
- Reusing Honeycomb's dashboard code avoids a fork and keeps the component layer consistent across the portal surface.
- Fail-soft per daemon means a nectar outage does not blank the Honeycomb dashboard sections, and vice versa.

**Negative.**

- hive introduces a network hop on every dashboard data fetch (portal → workload API → response). For data-heavy pages this adds latency versus direct Deep Lake access. Mitigated by the workload daemons owning their own read APIs (which they already do) and by hive caching aggressively at the aggregation layer.
- hive must implement an aggregation layer (`wire` per-daemon routing + fail-soft + partial-render). This is real surface area, owned by PRD-004c.
- The reuse-not-fork decision couples hive's dashboard layer to Honeycomb's `registry.tsx` / `pages/*` module shape. A breaking change in honeycomb's dashboard module API forces a coordinated hive update. Mitigated by treating the dashboard module as a shared, stable interface (changes are additive).
- One more daemon to package, install, supervise, and update — already acknowledged in ADR-0003's consequences.

**Reversibility.** Largely reversible at the architecture level (hive's routes could be folded back into honeycomb if the always-on portal proves unnecessary) but expensive at the operational level (it is now a deployed, supervised, registered daemon with its own release train). The API-aggregation decision is the most reversible — hive could gain a Deep Lake client later without changing the dashboard component layer — but doing so abandons the "thin portal" property and is discouraged.

## Alternatives considered and rejected

### Put the portal in doctor (REJECTED)

Rejected in ADR-0003 and rejected again here. Coupling dashboard velocity to the most stability-sensitive daemon erases the stability/velocity split. Every portal update would force an doctor release, and an doctor bug would take down the dashboard. The whole point of hive is that these two release trains are separate.

### Let hive read Deep Lake directly (REJECTED)

Rejected because it makes hive a second data-plane consumer. hive would need its own Deep Lake client, its own tenancy scope resolution, its own query surface, and its own schema awareness — duplicating the workload daemons' storage contracts and creating a new drift source (hive and honeycomb disagreeing on how to read the `sessions` table). The API-aggregation decision keeps hive thin and keeps the data contracts owned by exactly one component each.

### Fork Honeycomb's dashboard code into hive (REJECTED)

Rejected because forks diverge. Honeycomb's dashboard is a working, evolving surface; a fork would duplicate the code and force hive to manually port every honeycomb dashboard improvement. The reuse decision (shared component layer, hive-owned `wire`) captures the benefits of a single dashboard codebase while respecting the process boundary.

> **Refined by hive ADR-0001 (2026-07):** copy-and-own (hive ADR-0001) is distinct from the fork rejected here. A fork keeps two live, diverging copies; copy-and-own is a one-time ownership transfer paired with honeycomb dashboard retirement, so honeycomb keeps no dashboard copy and there is nothing to diverge from. The "manually port every honeycomb dashboard improvement" cost does not arise, because honeycomb no longer has a dashboard to improve.

### Make hive a child process of a workload daemon (REJECTED)

Rejected because it violates the always-on guarantee. If hive is a child of honeycomb, the dashboard dies when honeycomb dies — which is exactly the failure mode hive exists to survive. hive must be a top-level supervised daemon, booted by the OS service manager, sibling to the workloads.

### Let hive host workload logic too (REJECTED)

Rejected because it blurs the workload/portal boundary. hive must remain a portal — it presents and aggregates, it does not do work. Putting brooding, recall, or any workload logic inside hive would recreate the colocation problem ADR-0002 solved, just at a different layer.

## Relationship to ADR-0003 and the corpus

ADR-0003 decided *that* hive exists and *why* it is separate from doctor. This ADR decides *what* hive is: the always-on portal that aggregates from daemon APIs (not Deep Lake), owns the dashboard (reusing honeycomb's code), and ships on its own release cadence. The two ADRs are complementary — neither supersedes the other.

Corpus references that describe the dashboard as living in the Honeycomb daemon are superseded by ADR-0003 + this ADR jointly: the dashboard lives in hive. References that describe hive reading Deep Lake directly (none currently exist in the corpus, but would be tempting to introduce) are pre-emptively rejected by this ADR.

## Implementation notes

- hive's bootstrap, dashboard serving, and API-aggregation contract are specified in `library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004c-hive-portal-daemon.md`.
- hive's OS service unit + registration are in `prd-004d-hive-service-unit-and-registration.md`.
- The Hive Graph page (the first hive-hosted page beyond honeycomb's existing surface) is in `library/requirements/backlog/prd-015-dashboard-hive-graph-page/`.
- The dashboard code hive reuses lives at `honeycomb/src/dashboard/web/registry.tsx` (route registry + `PageProps` + "how to add a page") and `honeycomb/src/dashboard/web/pages/*` (page components).
- hive binds port 3853 (confirmed in PRD-001b), writes `~/.honeycomb/hive.pid` + `.lock`, and is registered in doctor's daemon registry (`~/.honeycomb/doctor.daemons.json`) per PRD-004a.

## References

- `ADR-0003-three-daemon-topology-and-hive-portal.md` — the topology decision this expands.
- `ADR-0002-nectar-independent-daemon-supervised-by-doctor.md` — the independence decision that started the multi-daemon topology.
- `library/requirements/MASTER-PRD-INDEX.md` — the research that grounded the topology + hive decisions in real Honeycomb code.
- `library/requirements/backlog/prd-004-doctor-registry-and-hive/` — hive's PRD folder (004a–d).
- `library/requirements/backlog/prd-015-dashboard-hive-graph-page/` — the first hive-hosted dashboard page.
- `honeycomb/src/dashboard/web/registry.tsx` — the dashboard route registry hive reuses.
- `doctor/src/supervisor.ts` + `doctor/src/service/index.ts` — the supervision + OS-service model hive is a sibling of.
