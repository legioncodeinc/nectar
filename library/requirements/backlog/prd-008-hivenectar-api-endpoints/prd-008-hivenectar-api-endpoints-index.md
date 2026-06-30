# PRD-008: Hivenectar Daemon API Endpoints

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None (these endpoints read/write the `source_graph` / `source_graph_versions` tables PRD-005 owns; this PRD owns only the HTTP route surface mounted on the daemon PRD-002 produces.)

---

## Overview

PRD-008 is the HTTP surface the hivenectar daemon exposes to the dashboard and the operator. It produces the `/api/source-graph/*` route group mounted on the daemon's Hono app the same way honeycomb scaffolds `ROUTE_GROUPS` — every group is mounted as a scaffolded sub-app whose permission (and, for session groups, runtime-path) middleware is already attached at bootstrap, so a later module attaches a real handler and **inherits** enforcement without re-wiring auth ([`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts) `ROUTE_GROUPS` + [`server.ts:296-316`](../../../../honeycomb/src/daemon/runtime/server.ts) the group-scaffolding loop). The handler-attachment pattern is `mountGraphApi`: a module calls `daemon.group(base)` once after `createDaemon(...)` and attaches its handlers to the returned `basePath` router, registering them at paths **relative** to the group ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)).

The endpoints cover four concerns: a **search** surface (`/api/source-graph/search` — manual semantic + lexical search over file descriptions, owned in detail by [PRD-012](../prd-012-manual-source-graph-search/prd-012-manual-source-graph-search-index.md), a **build trigger** (`/api/source-graph/build`, modeled on `/api/graph/build` at [`codebase/api.ts:318-330`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)), a **status** surface (`/api/source-graph/status` — queue depth, `describe_status` counts, cost counter), and the **projection CRUD** (read/regenerate `.honeycomb/nectars.json`). The search contract derives from [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md); the build/status/projection surfaces map the CLI commands the corpus names ([`knowledge/private/overview.md`](../../../knowledge/private/overview.md)) onto HTTP verbs. These are session-protected daemon routes: an unfilled path falls through to the root 501 scaffold ([`server.ts:288-296`](../../../../honeycomb/src/daemon/runtime/server.ts)).

This PRD owns three sub-features: the **route-group scaffolding + permission-middleware inheritance** (008a), the **search endpoint** (008b, delegating the mechanics to PRD-012), and the **build/status/projection endpoints** (008c). The search engine itself — the BM25 + vector arm over `source_graph_versions` — is PRD-012's deliverable; this PRD owns only the HTTP handler that mounts it.

---

## Goals

- Mount the `/api/source-graph` route group on the hivenectar daemon's Hono app, mirroring honeycomb's `ROUTE_GROUPS` scaffolding so handlers inherit the permission middleware (and, where the group is session-scoped, the runtime-path middleware) without re-wiring auth ([`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts) + [`server.ts:296-316`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- Specify the **handler-attachment pattern** as `mountSourceGraphApi(daemon, options)` modeled on `mountGraphApi` ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)): resolve scope per-request, attach handlers to `daemon.group("/api/source-graph")` at paths relative to the group, and surface build errors as a 500 data body — never an unhandled throw.
- Define the **search endpoint** (`/api/source-graph/search`) as a thin handler that validates the query, resolves scope, and delegates to PRD-012's search engine, returning the same shape the CLI emits.
- Define the **build/status/projection endpoints**: `/api/source-graph/build` (trigger a brood, modeled on `/api/graph/build`), `/api/source-graph/status` (queue depth + `describe_status` counts + cost counter), and the projection read/regenerate verbs.
- Confirm **permission-middleware inheritance**: the `/api/source-graph` group is `protect: true` and inherits the daemon's permission middleware, so every endpoint is session-protected (the non-protected diagnostics endpoints `/health` + `/api/status` are owned by the daemon bootstrap, not this PRD).

## Non-Goals

- The search engine (BM25 + vector over `source_graph_versions`, latest-per-nectar) — **PRD-012**. 008b owns only the HTTP handler that mounts it.
- The recall arm (fusing `source_graph_versions` into the agent-facing fused recall) — **PRD-013**. This PRD's search endpoint is a standalone search tool, distinct from the fused recall arm.
- The daemon bootstrap / composition root / socket bind / `/health` + `/api/status` diagnostics endpoints — **PRD-002** + the bootstrap the daemon owns. This PRD attaches handlers to a group PRD-002 mounts.
- The brooding pipeline mechanics — **PRD-007**. 008c owns the `build` endpoint that triggers a brood, not the pipeline.
- The projection format + atomic write + rebuild logic — **PRD-011**. 008c owns the projection read/regenerate endpoints, not the format.
- The Deep Lake table schemas — **PRD-005**. These endpoints read those tables.
- The dashboard page that calls these endpoints — **PRD-015** (hosted by thehive).

---

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [`prd-008a-route-group-scaffolding`](./prd-008a-route-group-scaffolding.md) | The `/api/source-graph` route group: `ROUTE_GROUPS` mounting + permission/runtime-path middleware inheritance + the `group()` accessor contract | Draft |
| [`prd-008b-search-endpoint`](./prd-008b-search-endpoint.md) | `/api/source-graph/search` — a thin handler that delegates to PRD-012's search engine | Draft |
| [`prd-008c-build-status-projection-endpoints`](./prd-008c-build-status-projection-endpoints.md) | `/api/source-graph/build`, `/api/source-graph/status`, and the projection read/regenerate endpoints | Draft |

---

## Acceptance Criteria

- [ ] The hivenectar daemon mounts a `/api/source-graph` route group in its `ROUTE_GROUPS`-equivalent list (`protect: true`), mirroring honeycomb's `ROUTE_GROUPS` scaffolding ([`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts)) and the group-scaffolding loop at [`server.ts:296-316`](../../../../honeycomb/src/daemon/runtime/server.ts).
- [ ] A `mountSourceGraphApi(daemon, options)` module attaches handlers to `daemon.group("/api/source-graph")` once after `createDaemon(...)`, mirroring `mountGraphApi` ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)); handlers register at paths **relative** to the group and inherit the permission middleware without re-wiring auth.
- [ ] Every `/api/source-graph/*` endpoint inherits the daemon's permission middleware (the group is `protect: true`); an unfilled path returns the root 501 scaffold, never a 404-with-no-auth (mirroring [`server.ts:288-296`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- [ ] `/api/source-graph/search` delegates to PRD-012's search engine and returns the same result shape the CLI emits; build/scoping failures are surfaced as data bodies, never unhandled throws.
- [ ] `/api/source-graph/build`, `/api/source-graph/status`, and the projection read/regenerate endpoints resolve scope per-request (mirroring [`codebase/api.ts:309-310`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts) `resolveScope`) and reach storage solely through the injected storage client (the daemon is the only DeepLake client — [`server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts)).

---

## Defaults registered in this PRD

One value is a default pending implementation confirmation, flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| Route group path | `/api/source-graph`; inherits session-protect middleware | 008a | Mirrors honeycomb's `/api/graph` group ([`server.ts:87`](../../../../honeycomb/src/daemon/runtime/server.ts)) and the daemon's session-protect posture for capture surfaces ([`server.ts:74-77`](../../../../honeycomb/src/daemon/runtime/server.ts) `/api/memories`, `/memory`, `/api/hooks` are `protect: true, session: true`). |

---

## Related

- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-008 brief (HTTP surface, route groups, endpoint list) + decision #4 (mirror-not-import across the process boundary).
- [`knowledge/private/overview.md`](../../../knowledge/private/overview.md) — the daemon API + the CLI commands these endpoints mirror onto HTTP.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the search contract the `/search` endpoint delegates to.
- [`prd-002-hivenectar-daemon`](../prd-002-hivenectar-daemon/prd-002-hivenectar-daemon-index.md) — produces the runnable daemon + mounts the `/health` route this PRD's group sits beside.
- [`prd-005-source-graph-catalog-tables`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — owns the tables these endpoints read/write.
- [`prd-007-brooding-process`](../prd-007-brooding-process/prd-007-brooding-process-index.md) — owns the brooding pipeline the `/build` endpoint triggers.
- [`prd-011-portable-projection`](../prd-011-portable-projection/prd-011-portable-projection-index.md) — owns the projection format the projection endpoints read/regenerate.
- [`prd-012-manual-source-graph-search`](../prd-012-manual-source-graph-search/prd-012-manual-source-graph-search-index.md) — owns the search engine the `/search` endpoint mounts.
- [`honeycomb/src/daemon/runtime/server.ts`](../../../../honeycomb/src/daemon/runtime/server.ts) — the `ROUTE_GROUPS` scaffolding + permission-middleware inheritance pattern to mirror (`:71-96`, `:202-316`).
- [`honeycomb/src/daemon/runtime/codebase/api.ts`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts) — `mountGraphApi` (`:304-347`), the handler-attachment pattern to mirror.
