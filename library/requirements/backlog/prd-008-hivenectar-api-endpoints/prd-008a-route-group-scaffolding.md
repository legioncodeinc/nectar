# PRD-008a: Route Group Scaffolding

> Parent: [`prd-008-hivenectar-api-endpoints-index.md`](./prd-008-hivenectar-api-endpoints-index.md)

## Overview

This sub-PRD owns the **mounting of the `/api/source-graph` route group** on the hivenectar daemon's Hono app and the **handler-attachment contract** every 008b/008c endpoint conforms to. It does not own any endpoint's behavior — it owns the *shape* the endpoints are attached into, so 008b/008c and every later handler fill a group that is already protected, already mounted at the right base path, and already exposes the `group()` accessor.

The pattern is the one honeycomb's daemon bootstrap establishes and documents as its central seam. The bootstrap declares a frozen `ROUTE_GROUPS` list of `{ path, protect, session }` specs and mounts each group's middleware on the root app at `${path}/*` **before** any handler exists, then exposes a `group(path)` accessor returning a `basePath` router bound to the root so a later module attaches handlers and they **inherit** the already-mounted middleware ([`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts) the `ROUTE_GROUPS` list; [`server.ts:296-316`](../../../../honeycomb/src/daemon/runtime/server.ts) the scaffolding loop; [`server.ts:202-210`](../../../../honeycomb/src/daemon/runtime/server.ts) the `group()` accessor contract). The defining property — why this shape and not `app.route(base, subApp)` — is that `app.route` **copies** a sub-app's routes at call time, so a handler a later module adds to the sub-app *after* bootstrap is never picked up; mounting middleware on the root at `${base}/*` and returning `app.basePath(base)` keeps the binding live, so a handler attached later runs the already-mounted middleware without re-wiring auth (the a-AC-6 property, [`server.ts:284-296`](../../../../honeycomb/src/daemon/runtime/server.ts)). Hivenectar mirrors this pattern verbatim: the group is mounted in the hivenectar daemon's `ROUTE_GROUPS`-equivalent list and exposed via its own `group()` accessor.

The handler-attachment pattern is `mountGraphApi`: a module takes the constructed daemon + options, resolves the group once (`daemon.group(GRAPH_GROUP)`), and attaches handlers at paths **relative** to the group (`/build`, `/`, `/:id`) — the group base is stripped ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)). Hivenectar ships `mountSourceGraphApi(daemon, options)` with the identical shape, scoped to `/api/source-graph`.

## Goals

- Mount the `/api/source-graph` group in the hivenectar daemon's `ROUTE_GROUPS`-equivalent list as `{ path: "/api/source-graph", protect: true, session: <per default> }`, mirroring honeycomb's frozen `ROUTE_GROUPS` ([`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- Inherit the daemon's **permission middleware** on the group (the group is `protect: true`), so every 008b/008c endpoint is session-protected without each handler re-wiring auth (the a-AC-6 property, [`server.ts:284-296`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- Specify the **`group()` accessor contract** for the hivenectar daemon: `daemon.group("/api/source-graph")` returns the `basePath` router (or `undefined` for an unknown group), and handlers register at paths relative to the group, mirroring [`server.ts:202-210`](../../../../honeycomb/src/daemon/runtime/server.ts).
- Specify `mountSourceGraphApi(daemon, options)` as the single attach module modeled on `mountGraphApi` ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)), with scope resolution per-request and build-failure-as-data-body error handling.
- Confirm the group sits **beside** the daemon's non-protected diagnostics endpoints (`/health`, `/api/status`, which get no permission middleware — [`server.ts:72-73, 297`](../../../../honeycomb/src/daemon/runtime/server.ts)) and never shadows them.

## Non-Goals

- The behavior of any individual endpoint — **008b** (search), **008c** (build/status/projection). This sub-PRD owns the mounting shape only.
- The daemon bootstrap / `createDaemon` / socket bind — **PRD-002** + the bootstrap the daemon owns. This sub-PRD assumes the constructed daemon exposes a `group()` accessor.
- The permission-middleware implementation itself (the auth/RBAC gate) — owned by the daemon's `permissionMiddleware` ([`honeycomb/src/daemon/runtime/middleware/permission.ts`](../../../../honeycomb/src/daemon/runtime/middleware/permission.ts)); this sub-PRD only inherits it.
- The `runtime-path` middleware for session capture — owned by the daemon ([`honeycomb/src/daemon/runtime/middleware/runtime-path.ts`](../../../../honeycomb/src/daemon/runtime/middleware/runtime-path.ts)); this sub-PRD only inherits it where the group is `session: true`.

---

## The `ROUTE_GROUPS` pattern hivenectar mirrors

Honeycomb's daemon declares its route-group surface as a frozen array of specs and mounts every group at bootstrap, even those with no handler yet. The hivenectar daemon mirrors this: its own `ROUTE_GROUPS`-equivalent list includes the `/api/source-graph` entry, so the group exists and is protected from the first boot, before `mountSourceGraphApi` attaches any handler.

```mermaid
flowchart TD
    rg["ROUTE_GROUPS list (frozen)"] --> spec["/api/source-graph: protect=true"]
    spec --> mount["bootstrap mounts middleware on root at /api/source-graph/*"]
    mount --> accessor["exposes daemon.group('/api/source-graph') → basePath router"]
    accessor -->|"later, once"| attach["mountSourceGraphApi(daemon, options)"]
    attach --> h1["POST /search"]
    attach --> h2["POST /build"]
    attach --> h3["GET /status"]
    attach --> h4["projection CRUD"]
    attach -.->|"inherits"| inherit["permission (+ runtime-path) middleware already mounted"]
```

The `RouteGroupSpec` shape hivenectar mirrors ([`honeycomb/src/daemon/runtime/server.ts:60-64`](../../../../honeycomb/src/daemon/runtime/server.ts)):

```ts
interface RouteGroupSpec {
  readonly path: string;
  readonly protect: boolean;
  readonly session: boolean;
}
```

A group enters the frozen list once; the `protect` bit mounts the permission middleware at `${path}/*` on the root, and the `session` bit additionally mounts the runtime-path middleware **ahead** of permission (so a path-reject fails closed before any session handler) ([`server.ts:303-311`](../../../../honeycomb/src/daemon/runtime/server.ts)). The two diagnostics endpoints (`/health`, `/api/status`) are the only `protect: false` entries and are skipped by the middleware loop ([`server.ts:72-73, 297`](../../../../honeycomb/src/daemon/runtime/server.ts)).

---

## Permission-middleware inheritance (the load-bearing property)

Every handler attached to `/api/source-graph` inherits the permission middleware the bootstrap mounted at `/api/source-graph/*`. This is the a-AC-6 seam honeycomb documents and relies on: a later module calls `daemon.group("/api/source-graph").post("/search", h)` and the handler `h` runs behind the already-mounted gate, with no auth wiring in the handler itself ([`honeycomb/src/daemon/runtime/server.ts:284-296`](../../../../honeycomb/src/daemon/runtime/server.ts)).

This is why the shape is `app.basePath(base)` and not `app.route(base, subApp)`: `app.route` copies the sub-app's routes at call time, so a handler added to the sub-app *after* the bootstrap loop is never reflected. Mounting middleware on the root at `${base}/*` and returning a `basePath` router bound to the root keeps the binding live — a handler attached later is picked up, runs the mounted middleware, and an unfilled path falls through to the root 501 scaffold (registered as `notFound`) rather than reaching a handler with no protection ([`server.ts:288-296, 312-316`](../../../../honeycomb/src/daemon/runtime/server.ts)).

The permission gate is mode-aware: honeycomb resolves it through a `mountPermission(groupPath)` thunk that reflects the daemon's mode (`local` / `team` / `hybrid`), selecting either the legacy header-resolved adapter or the injected `authenticator` + `policy` pair, both defaulting fail-closed (always-unauthenticated → 401, default-deny → 403) ([`server.ts:255-258`](../../../../honeycomb/src/daemon/runtime/server.ts)). The hivenectar daemon inherits the same mode-aware resolution; this sub-PRD does not re-design the gate, only confirms the group sits behind it.

---

## The `group()` accessor contract

The constructed daemon exposes a `group(path)` accessor returning the scaffolded sub-app for a route group, or `undefined` for an unknown group path ([`honeycomb/src/daemon/runtime/server.ts:202-210`](../../../../honeycomb/src/daemon/runtime/server.ts)). The group base is **stripped**: a handler registers at the path **relative** to the group (`/search`, not the full `/api/source-graph/search`).

```ts
group(path: string): Hono | undefined;
```

`mountSourceGraphApi` mirrors `mountGraphApi`'s one-line group resolution + no-op-on-unknown-group guard ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-306`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)):

```ts
export function mountSourceGraphApi(daemon: Daemon, options: MountSourceGraphOptions): void {
  const group = daemon.group("/api/source-graph");
  if (group === undefined) return; // unknown daemon shape → no-op attach
  // ... 008b/008c handlers attach to `group` at paths relative to /api/source-graph
}
```

The no-op-on-unknown-group guard means the attach module is safe to call against a daemon whose `ROUTE_GROUPS` list does not yet include the group (a daemon built before this PRD lands) — it attaches nothing rather than throwing.

---

## Per-request scope resolution

Each handler resolves the tenant scope per-request, mirroring `mountGraphApi`'s `resolveScope` ([`honeycomb/src/daemon/runtime/codebase/api.ts:309-310`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)):

```ts
const resolveScope = (c: Context): QueryScope | null =>
  resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);
```

A request with no resolvable scope returns the `NO_ORG_BODY` 400 (mirroring [`codebase/api.ts:319-320`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)) before the handler reaches storage. Every handler reaches storage **solely** through the injected storage client — the daemon is the only DeepLake client, and no handler opens DeepLake ([`honeycomb/src/daemon/runtime/server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts) FR-6).

---

## User stories

### US-008a.1 — The group exists and is protected from first boot

**As a** operator, **I want to** the `/api/source-graph` group mounted and protected the moment the daemon boots, **so that** even an endpoint whose handler is not yet attached inherits the permission gate rather than answering unprotected.

**Acceptance criteria:**
- AC-008a.1.1 Given the daemon has booted, then the hivenectar daemon's `ROUTE_GROUPS`-equivalent list contains `{ path: "/api/source-graph", protect: true }`, mirroring [`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts).
- AC-008a.1.2 Given the group is mounted, then the permission middleware is mounted on the root at `/api/source-graph/*`, mirroring [`server.ts:303-311`](../../../../honeycomb/src/daemon/runtime/server.ts).
- AC-008a.1.3 Given a path under `/api/source-graph/*` with no handler attached, then it falls through to the root 501 scaffold, mirroring [`server.ts:288-296`](../../../../honeycomb/src/daemon/runtime/server.ts) — it never answers with no protection.

### US-008a.2 — `group()` returns the basePath router for handler attachment

**As a** the implementer of `mountSourceGraphApi`, **I want to** `daemon.group("/api/source-graph")` to return a `basePath` router, **so that** I attach handlers at paths relative to the group and they inherit the middleware.

**Acceptance criteria:**
- AC-008a.2.1 Given the group is mounted, then `daemon.group("/api/source-graph")` returns a `Hono` router (not `undefined`), mirroring [`server.ts:202-210`](../../../../honeycomb/src/daemon/runtime/server.ts).
- AC-008a.2.2 Given an unknown group path, then `daemon.group(path)` returns `undefined`, mirroring [`server.ts:206-210`](../../../../honeycomb/src/daemon/runtime/server.ts).
- AC-008a.2.3 Given a handler attached via `group.post("/search", h)`, then it registers on the root at the full `/api/source-graph/search` path and runs the already-mounted permission middleware, mirroring [`server.ts:312-316`](../../../../honeycomb/src/daemon/runtime/server.ts).

### US-008a.3 — `mountSourceGraphApi` is a safe no-op on an unknown group

**As a** operator booting a daemon built before this PRD, **I want to** `mountSourceGraphApi` to attach nothing rather than crash, **so that** the daemon boots cleanly.

**Acceptance criteria:**
- AC-008a.3.1 Given `daemon.group("/api/source-graph")` returns `undefined`, then `mountSourceGraphApi` returns without attaching (no throw), mirroring [`honeycomb/src/daemon/runtime/codebase/api.ts:305-306`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).

---

## Implementation notes

- **Mirror, not import.** Per decision #4 ([`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)), the hivenectar daemon mirrors honeycomb's `ROUTE_GROUPS` pattern in its own composition root; it does not import honeycomb's `server.ts`. The `ROUTE_GROUPS`-equivalent list is hivenectar's own frozen array in its own bootstrap ([`prd-002a`](../prd-002-hivenectar-daemon/prd-002a-hivenectar-bootstrap-and-composition-root.md)).
- **Mount once, attach once.** The group is mounted in the bootstrap (the `ROUTE_GROUPS` loop); handlers are attached once after `createDaemon(...)` by `mountSourceGraphApi`. The two phases never contend on a shared file (the seam's whole point — [`server.ts:9-12`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- **Diagnostics endpoints stay unprotected.** `/health` and `/api/status` are the daemon's own `protect: false` entries ([`server.ts:72-73`](../../../../honeycomb/src/daemon/runtime/server.ts)) owned by the bootstrap/PRD-002; this sub-PRD does not add them and does not shadow them (exact `/api/status` registers before the `/api/*` groups).
- **Storage reached through the client only.** Scope-resolved storage access mirrors `mountGraphApi`'s `resolveScope` + injected `storage` ([`codebase/api.ts:309-310`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)); no handler opens DeepLake directly ([`server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts) FR-6).
- **Session bit.** Whether the group is `session: true` (inheriting the runtime-path middleware ahead of permission) follows the default flagged below; the `protect` bit is `true` regardless.

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Route group path `/api/source-graph` with inherited session-protect middleware. The path mirrors honeycomb's `/api/graph` group ([`honeycomb/src/daemon/runtime/server.ts:87`](../../../../honeycomb/src/daemon/runtime/server.ts)); the session-protect posture mirrors honeycomb's capture surfaces (`/api/memories`, `/memory`, `/api/hooks` are `protect: true, session: true` at [`server.ts:74-77`](../../../../honeycomb/src/daemon/runtime/server.ts)). Whether `/api/source-graph` is `session: true` (runtime-path ahead of permission) or `session: false` (permission only, like `/api/graph` at [`server.ts:87`](../../../../honeycomb/src/daemon/runtime/server.ts)) is the one bit to confirm. From the daemon's session-protect convention, confirm.

---

## Related

- [`./prd-008-hivenectar-api-endpoints-index.md`](./prd-008-hivenectar-api-endpoints-index.md)
- [`./prd-008b-search-endpoint.md`](./prd-008b-search-endpoint.md) — the search handler this scaffolding receives.
- [`./prd-008c-build-status-projection-endpoints.md`](./prd-008c-build-status-projection-endpoints.md) — the build/status/projection handlers this scaffolding receives.
- [`../prd-002-hivenectar-daemon/prd-002a-hivenectar-bootstrap-and-composition-root.md`](../prd-002-hivenectar-daemon/prd-002a-hivenectar-bootstrap-and-composition-root.md) — the daemon composition root that exposes `group()`.
- [`../../MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — PRD-008 brief + decision #4 (mirror-not-import).
- `honeycomb/src/daemon/runtime/server.ts:71-96` — `ROUTE_GROUPS`.
- `honeycomb/src/daemon/runtime/server.ts:202-316` — `group()` accessor + scaffolding loop + permission inheritance.
- `honeycomb/src/daemon/runtime/codebase/api.ts:304-347` — `mountGraphApi` (the handler-attachment pattern to mirror).
