# ADR-0004, thehive portal daemon: role, boundaries, and the always-on contract

> **Status:** Accepted · **Date:** 2026-06-30
> **Supersedes:** none · **Superseded by:** none
> **Owners:** platform, thehive, daemon
> **Related:** `ADR-0003-three-daemon-topology-and-thehive-portal.md`, `ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md`, `../../../requirements/MASTER-PRD-INDEX.md`, `../../../requirements/backlog/prd-004-hivedoctor-registry-and-thehive/`, `../../../requirements/backlog/prd-015-dashboard-source-graph-page/`

## Context

ADR-0003 decided that the always-on portal surface would be split out of hivedoctor (the supervisor) into a new daemon, **thehive**, in order to preserve a stability/velocity split: hivedoctor stays minimal and rare-to-update while thehive absorbs the fast-moving dashboard surface. That ADR recorded *that* thehive exists and *why* it is separate from hivedoctor. It did not record what thehive *is* — its role, its boundaries, the load-bearing properties that make it a distinct architectural component rather than "another daemon that happens to serve HTTP."

Four questions were left open and are consequential enough to warrant their own ADR, because each is hard or expensive to reverse and each shapes what engineers build into (or keep out of) thehive for years:

1. **What is the always-on guarantee, and what boot ordering makes it real?** "The dashboard is up the moment the device boots" is the property that justifies thehive's existence. If thehive depends on a workload daemon being healthy to serve its shell, it is not always-on — it is "on when Honeycomb is up," which is what we already had.
2. **Does thehive read Deep Lake directly, or aggregate from each daemon's API?** This is the seam that determines whether thehive is a thin portal or a second data-plane consumer. It shapes every dashboard route and every fail-soft behavior.
3. **What does thehive own in the dashboard, and does it reuse Honeycomb's existing dashboard code or fork it?** Affects whether portal iteration is fast (reuse) or duplicated work (fork).
4. **What is the update-cadence boundary?** Concretely: can thehive ship a dashboard change without an hivedoctor release, and vice versa? If not, the stability/velocity split ADR-0003 named does not actually exist.

The research in `MASTER-PRD-INDEX.md` and PRD-004c/004d grounds each answer in the real Honeycomb code; this ADR records the decisions.

## Decision drivers

- **Always-on as a real property, not a slogan.** The dashboard shell must render before any workload daemon is confirmed healthy. This forces thehive to be a supervised daemon in its own right (booted by the OS service manager alongside hivedoctor), not a child of a workload.
- **Workload independence.** Honeycomb and Hivenectar evolve on their own cadences and fail independently. thehive must render useful content when one or both are down — partial data, not a blank page.
- **Stability/velocity split (from ADR-0003).** hivedoctor changes rarely; thehive changes often. The boundary between them must be crisp enough that a portal update never forces a supervisor release.
- **No second data plane.** thehive must not become a second Deep Lake client with its own tenancy scope and query surface — that would duplicate the workload daemons' storage contracts and create a new drift source. It is a *portal*, not a *store*.
- **Reuse over fork.** Honeycomb already ships a working dashboard (`src/dashboard/web/` — registry, pages, wire). Forking it into thehive would duplicate working code and diverge over time.

## Decision

thehive is the **always-on portal daemon** of the three-daemon topology. Four binding decisions define it.

### 1. Always-on + boot-order contract

thehive is a supervised daemon in its own right, booted by the OS service manager (launchd/systemd/schtasks) on device start, exactly as hivedoctor and the workload daemons are. It is **not** a child process of a workload daemon and **not** gated on any workload's `/health`. The dashboard shell renders the moment thehive's socket is bound — before Honeycomb or Hivenectar is confirmed healthy. Concretely: thehive serves a static shell + a per-daemon status grid that degrades gracefully (a daemon that has not yet answered `/health` renders as "starting," not as a broken page).

This is the load-bearing property. Anything that makes thehive's shell depend on a workload being up destroys the reason thehive exists.

### 2. API aggregation, not direct Deep Lake access

thehive does **not** read Deep Lake directly. It does not hold a Deep Lake client, does not resolve tenancy scope, and does not run queries. It fetches data from each registered daemon's HTTP API — `/api/*` on honeycomb and hivenectar — and aggregates the responses into the unified dashboard. The aggregation layer is fail-soft per daemon: if honeycomb's API is unreachable, the honeycomb-sourced dashboard sections render empty or "daemon unreachable," while the hivenectar-sourced sections still render.

This keeps thehive a thin portal. The workload daemons own their data contracts, their tenancy scoping, and their query surfaces; thehive owns only the presentation + aggregation seam. A new workload daemon joins the dashboard by exposing an API thehive aggregates — not by sharing a Deep Lake client.

### 3. Dashboard ownership + reuse of Honeycomb's dashboard code

thehive owns the unified dashboard: every dashboard route (the existing honeycomb pages plus the new Source Graph page per PRD-015) lives in thehive. It reuses Honeycomb's existing dashboard code — the route registry (`honeycomb/src/dashboard/web/registry.tsx`), the page components (`pages/*`), the `wire` data-fetch abstraction — rather than forking it. thehive's `wire` implementation routes each request to the owning daemon's API (per decision 2) instead of honeycomb's in-process handlers, but the component layer is shared.

The Source Graph page (PRD-015) lands in thehive and fetches from hivenectar's `/api/source-graph/*` endpoints (PRD-008) through thehive's aggregation `wire` — not directly into hivenectar's Deep Lake tables.

### 4. Update-cadence boundary

thehive is **independently updateable** of both hivedoctor and the workload daemons. A dashboard change ships as a thehive release; it does not require an hivedoctor release, a honeycomb release, or a hivenectar release. Conversely, hivedoctor's rare updates do not force a thehive redeploy. The three release trains are decoupled. This is the velocity half of the stability/velocity split ADR-0003 named — this decision makes it operationally real.

## Consequences

**Positive.**

- The dashboard is up the moment the device boots, regardless of workload health. Operators get a status surface during outages, not after them.
- thehive stays a thin portal: no Deep Lake client, no tenancy scope, no query surface to maintain. New workload daemons join via an API contract, not a shared client.
- Portal iteration velocity is decoupled from supervisor stability. Dashboard changes ship at thehive's cadence.
- Reusing Honeycomb's dashboard code avoids a fork and keeps the component layer consistent across the portal surface.
- Fail-soft per daemon means a hivenectar outage does not blank the Honeycomb dashboard sections, and vice versa.

**Negative.**

- thehive introduces a network hop on every dashboard data fetch (portal → workload API → response). For data-heavy pages this adds latency versus direct Deep Lake access. Mitigated by the workload daemons owning their own read APIs (which they already do) and by thehive caching aggressively at the aggregation layer.
- thehive must implement an aggregation layer (`wire` per-daemon routing + fail-soft + partial-render). This is real surface area, owned by PRD-004c.
- The reuse-not-fork decision couples thehive's dashboard layer to Honeycomb's `registry.tsx` / `pages/*` module shape. A breaking change in honeycomb's dashboard module API forces a coordinated thehive update. Mitigated by treating the dashboard module as a shared, stable interface (changes are additive).
- One more daemon to package, install, supervise, and update — already acknowledged in ADR-0003's consequences.

**Reversibility.** Largely reversible at the architecture level (thehive's routes could be folded back into honeycomb if the always-on portal proves unnecessary) but expensive at the operational level (it is now a deployed, supervised, registered daemon with its own release train). The API-aggregation decision is the most reversible — thehive could gain a Deep Lake client later without changing the dashboard component layer — but doing so abandons the "thin portal" property and is discouraged.

## Alternatives considered and rejected

### Put the portal in hivedoctor (REJECTED)

Rejected in ADR-0003 and rejected again here. Coupling dashboard velocity to the most stability-sensitive daemon erases the stability/velocity split. Every portal update would force an hivedoctor release, and an hivedoctor bug would take down the dashboard. The whole point of thehive is that these two release trains are separate.

### Let thehive read Deep Lake directly (REJECTED)

Rejected because it makes thehive a second data-plane consumer. thehive would need its own Deep Lake client, its own tenancy scope resolution, its own query surface, and its own schema awareness — duplicating the workload daemons' storage contracts and creating a new drift source (thehive and honeycomb disagreeing on how to read the `sessions` table). The API-aggregation decision keeps thehive thin and keeps the data contracts owned by exactly one component each.

### Fork Honeycomb's dashboard code into thehive (REJECTED)

Rejected because forks diverge. Honeycomb's dashboard is a working, evolving surface; a fork would duplicate the code and force thehive to manually port every honeycomb dashboard improvement. The reuse decision (shared component layer, thehive-owned `wire`) captures the benefits of a single dashboard codebase while respecting the process boundary.

### Make thehive a child process of a workload daemon (REJECTED)

Rejected because it violates the always-on guarantee. If thehive is a child of honeycomb, the dashboard dies when honeycomb dies — which is exactly the failure mode thehive exists to survive. thehive must be a top-level supervised daemon, booted by the OS service manager, sibling to the workloads.

### Let thehive host workload logic too (REJECTED)

Rejected because it blurs the workload/portal boundary. thehive must remain a portal — it presents and aggregates, it does not do work. Putting brooding, recall, or any workload logic inside thehive would recreate the colocation problem ADR-0002 solved, just at a different layer.

## Relationship to ADR-0003 and the corpus

ADR-0003 decided *that* thehive exists and *why* it is separate from hivedoctor. This ADR decides *what* thehive is: the always-on portal that aggregates from daemon APIs (not Deep Lake), owns the dashboard (reusing honeycomb's code), and ships on its own release cadence. The two ADRs are complementary — neither supersedes the other.

Corpus references that describe the dashboard as living in the Honeycomb daemon are superseded by ADR-0003 + this ADR jointly: the dashboard lives in thehive. References that describe thehive reading Deep Lake directly (none currently exist in the corpus, but would be tempting to introduce) are pre-emptively rejected by this ADR.

## Implementation notes

- thehive's bootstrap, dashboard serving, and API-aggregation contract are specified in `library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004c-thehive-portal-daemon.md`.
- thehive's OS service unit + registration are in `prd-004d-thehive-service-unit-and-registration.md`.
- The Source Graph page (the first thehive-hosted page beyond honeycomb's existing surface) is in `library/requirements/backlog/prd-015-dashboard-source-graph-page/`.
- The dashboard code thehive reuses lives at `honeycomb/src/dashboard/web/registry.tsx` (route registry + `PageProps` + "how to add a page") and `honeycomb/src/dashboard/web/pages/*` (page components).
- thehive binds port 3853 (confirmed in PRD-001b), writes `~/.honeycomb/thehive.pid` + `.lock`, and is registered in hivedoctor's daemon registry (`~/.honeycomb/hivedoctor.daemons.json`) per PRD-004a.

## References

- `ADR-0003-three-daemon-topology-and-thehive-portal.md` — the topology decision this expands.
- `ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md` — the independence decision that started the multi-daemon topology.
- `library/requirements/MASTER-PRD-INDEX.md` — the research that grounded the topology + thehive decisions in real Honeycomb code.
- `library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/` — thehive's PRD folder (004a–d).
- `library/requirements/backlog/prd-015-dashboard-source-graph-page/` — the first thehive-hosted dashboard page.
- `honeycomb/src/dashboard/web/registry.tsx` — the dashboard route registry thehive reuses.
- `honeycomb/hivedoctor/src/supervisor.ts` + `honeycomb/hivedoctor/src/service/index.ts` — the supervision + OS-service model thehive is a sibling of.
