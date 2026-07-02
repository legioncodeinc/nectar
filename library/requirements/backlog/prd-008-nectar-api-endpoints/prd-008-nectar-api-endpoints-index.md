# PRD-008: Nectar Daemon API Endpoints

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None (these endpoints read/write the `hive_graph` / `hive_graph_versions` tables PRD-005 owns; this PRD owns only the HTTP route surface mounted on the daemon PRD-002 produces.)

---

## Overview

PRD-008 is the HTTP surface the nectar daemon exposes to the dashboard and the operator. It produces the `/api/hive-graph/*` route group, mounted through nectar's own in-repo router seam layered over the existing `node:http` request handler (`src/server.ts`) the same way honeycomb scaffolds `ROUTE_GROUPS` on its Hono app. PRD-008a defines a minimal `RouteGroup` abstraction and a `mountHiveGraphApi(daemon, options)` attach point that mirror honeycomb's pattern across the process boundary (`ADR-0002`) instead of importing its Hono runtime, so nectar's zero-runtime-dependency invariant holds (`AGENTS.md`). Every group is scaffolded at bootstrap with its permission (and, for session groups, runtime-path) middleware already attached, so a later module attaches a real handler and **inherits** enforcement without re-wiring auth (mirroring `honeycomb/src/daemon/runtime/server.ts:68-106` `ROUTE_GROUPS` + `honeycomb/src/daemon/runtime/server.ts:306-328` the group-scaffolding loop). The handler-attachment pattern mirrors `mountGraphApi`: a module calls `daemon.group(base)` once after `createDaemon(...)` and attaches its handlers to the returned route-group handle, registering them at paths **relative** to the group (`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`).

The endpoints cover four concerns: a **search** surface (`/api/hive-graph/search` — manual semantic + lexical search over file descriptions, owned in detail by [PRD-012](../prd-012-manual-hive-graph-search/prd-012-manual-hive-graph-search-index.md), a **build trigger** (`/api/hive-graph/build`, modeled on `/api/graph/build` at `honeycomb/src/daemon/runtime/codebase/api.ts:318-330`), a **status** surface (`/api/hive-graph/status` — queue depth, `describe_status` counts, cost counter), and the **projection CRUD** (read/regenerate `.honeycomb/nectars.json`). The search contract derives from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md); the build/status/projection surfaces map the CLI commands the corpus names ([`knowledge/private/overview.md`](../../../knowledge/private/overview.md)) onto HTTP verbs. These are session-protected daemon routes: an unfilled path falls through to the root 501 scaffold (`honeycomb/src/daemon/runtime/server.ts:385-400`).

This PRD owns three sub-features: the **route-group scaffolding + permission-middleware inheritance** (008a), the **search endpoint** (008b, delegating the mechanics to PRD-012), and the **build/status/projection endpoints** (008c). The search engine itself — the BM25 + vector arm over `hive_graph_versions` — is PRD-012's deliverable; this PRD owns only the HTTP handler that mounts it.

---

## Goals

- Mount the `/api/hive-graph` route group through nectar's own in-repo router seam over `node:http` (`src/server.ts`), mirroring honeycomb's `ROUTE_GROUPS` scaffolding so handlers inherit the permission middleware (and, where the group is session-scoped, the runtime-path middleware) without re-wiring auth (mirroring `honeycomb/src/daemon/runtime/server.ts:68-106` + `honeycomb/src/daemon/runtime/server.ts:306-328`).
- Specify the **handler-attachment pattern** as `mountHiveGraphApi(daemon, options)` modeled on `mountGraphApi` (`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`): resolve scope per-request, attach handlers to `daemon.group("/api/hive-graph")` at paths relative to the group, and surface build errors as a 500 data body — never an unhandled throw.
- Define the **search endpoint** (`/api/hive-graph/search`) as a thin handler that validates the query, resolves scope, and delegates to PRD-012's search engine, returning the same shape the CLI emits.
- Define the **build/status/projection endpoints**: `/api/hive-graph/build` (trigger a brood, modeled on `/api/graph/build`), `/api/hive-graph/status` (queue depth + `describe_status` counts + cost counter), and the projection read/regenerate verbs.
- Confirm **permission-middleware inheritance**: the `/api/hive-graph` group is `protect: true` and inherits the daemon's permission middleware, so every endpoint is session-protected (the non-protected diagnostics endpoints `/health` + `/api/status` are owned by the daemon bootstrap, not this PRD).

## Non-Goals

- The search engine (BM25 + vector over `hive_graph_versions`, latest-per-nectar) — **PRD-012**. 008b owns only the HTTP handler that mounts it.
- The recall arm (fusing `hive_graph_versions` into the agent-facing fused recall) — **PRD-013**. This PRD's search endpoint is a standalone search tool, distinct from the fused recall arm.
- The daemon bootstrap / composition root / socket bind / `/health` + `/api/status` diagnostics endpoints — **PRD-002** + the bootstrap the daemon owns. This PRD attaches handlers to a group PRD-002 mounts.
- The brooding pipeline mechanics — **PRD-007**. 008c owns the `build` endpoint that triggers a brood, not the pipeline.
- The projection format + atomic write + rebuild logic — **PRD-011**. 008c owns the projection read/regenerate endpoints, not the format.
- The Deep Lake table schemas — **PRD-005**. These endpoints read those tables.
- The dashboard page that calls these endpoints — **PRD-015** (hosted by hive).

---

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [`prd-008a-route-group-scaffolding`](./prd-008a-route-group-scaffolding.md) | The `/api/hive-graph` route group: `ROUTE_GROUPS` mounting + permission/runtime-path middleware inheritance + the `group()` accessor contract | Draft |
| [`prd-008b-search-endpoint`](./prd-008b-search-endpoint.md) | `/api/hive-graph/search` — a thin handler that delegates to PRD-012's search engine | Draft |
| [`prd-008c-build-status-projection-endpoints`](./prd-008c-build-status-projection-endpoints.md) | `/api/hive-graph/build`, `/api/hive-graph/status`, and the projection read/regenerate endpoints | Draft |

---

## Acceptance Criteria

- [ ] The nectar daemon mounts a `/api/hive-graph` route group in its own `ROUTE_GROUPS`-equivalent list (`protect: true`) through the in-repo router seam over `node:http` (`src/server.ts`), mirroring honeycomb's `ROUTE_GROUPS` scaffolding (`honeycomb/src/daemon/runtime/server.ts:68-106`) and the group-scaffolding loop at `honeycomb/src/daemon/runtime/server.ts:306-328`.
- [ ] A `mountHiveGraphApi(daemon, options)` module attaches handlers to `daemon.group("/api/hive-graph")` once after `createDaemon(...)`, mirroring `mountGraphApi` (`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`); handlers register at paths **relative** to the group and inherit the permission middleware without re-wiring auth.
- [ ] Every `/api/hive-graph/*` endpoint inherits the daemon's protection middleware (the group is `protect: true`; 008a scaffolds that protection middleware on the in-repo seam, since the shipped daemon has none today beyond the unprotected `/health`); an unfilled path returns the root 501 scaffold, never a 404-with-no-auth (mirroring `honeycomb/src/daemon/runtime/server.ts:385-400`), and `/health` stays unprotected exactly as shipped (`src/server.ts`).
- [ ] `/api/hive-graph/search` delegates to PRD-012's search engine and returns the same result shape the CLI emits; build/scoping failures are surfaced as data bodies, never unhandled throws.
- [ ] `/api/hive-graph/build`, `/api/hive-graph/status`, and the projection read/regenerate endpoints resolve scope per-request (mirroring `honeycomb/src/daemon/runtime/codebase/api.ts:309-310` `resolveScope`) and reach storage solely through the injected storage client (the daemon is the only DeepLake client — `honeycomb/src/daemon/runtime/server.ts:13-16`).

---

## Defaults registered in this PRD

One value is a default pending implementation confirmation, flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| Route group path | `/api/hive-graph`; inherits session-protect middleware | 008a | Mirrors honeycomb's `/api/graph` group (`honeycomb/src/daemon/runtime/server.ts:84`) and the daemon's session-protect posture for capture surfaces (`honeycomb/src/daemon/runtime/server.ts:72-74` `/api/memories`, `/memory`, `/api/hooks` are `protect: true, session: true`). |

---

## Related

- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-008 brief (HTTP surface, route groups, endpoint list).
- `ADR-0002` — the mirror-not-import-across-the-process-boundary decision.
- [`knowledge/private/overview.md`](../../../knowledge/private/overview.md) — the daemon API + the CLI commands these endpoints mirror onto HTTP.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the search contract the `/search` endpoint delegates to.
- [`prd-002-nectar-daemon`](../../completed/prd-002-nectar-daemon/prd-002-nectar-daemon-index.md) — produces the runnable daemon + mounts the `/health` route this PRD's group sits beside.
- [`prd-005-hive-graph-catalog-tables`](../../completed/prd-005-hive-graph-catalog-tables/prd-005-hive-graph-catalog-tables-index.md) — owns the tables these endpoints read/write.
- [`prd-007-brooding-process`](../prd-007-brooding-process/prd-007-brooding-process-index.md) — owns the brooding pipeline the `/build` endpoint triggers.
- [`prd-011-portable-projection`](../../in-work/prd-011-portable-projection/prd-011-portable-projection-index.md) — owns the projection format the projection endpoints read/regenerate.
- [`prd-012-manual-hive-graph-search`](../prd-012-manual-hive-graph-search/prd-012-manual-hive-graph-search-index.md) — owns the search engine the `/search` endpoint mounts.
- `honeycomb/src/daemon/runtime/server.ts` — the `ROUTE_GROUPS` scaffolding + permission-middleware inheritance pattern to mirror (`:68-106`, `:205-328`).
- `honeycomb/src/daemon/runtime/codebase/api.ts` — `mountGraphApi` (`:304-347`), the handler-attachment pattern to mirror.
