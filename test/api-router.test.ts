/**
 * PRD-008a: route-group scaffolding + permission-middleware inheritance over
 * nectar's own in-repo router seam (node:http; NOT Hono). Covers the mount, the
 * `group()` accessor contract, the 501 scaffold for unfilled paths, permission
 * inheritance, and `mountHiveGraphApi`'s no-op-on-unknown-group guard.
 *
 * Imports the compiled modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { get, request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NectarRouter,
  ROUTE_GROUPS,
  HIVE_GRAPH_GROUP,
  allowAllPermission,
  type RouteContext,
  type RouteResponse,
} from "../dist/api/router.js";
import { mountHiveGraphApi } from "../dist/api/hive-graph-api.js";
import { assembleDaemon } from "../dist/index.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const SCOPE = { orgId: "org", workspaceId: "ws", projectId: "proj" };

function makeCtx(
  method: string,
  path: string,
  opts: { body?: unknown; query?: string; headers?: Record<string, string> } = {},
): RouteContext {
  const rawUrl = opts.query !== undefined && opts.query !== "" ? `${path}?${opts.query}` : path;
  return {
    method,
    path,
    rawUrl,
    query: new URLSearchParams(opts.query ?? ""),
    headers: opts.headers ?? {},
    body: () => opts.body,
    json: (body: unknown, status = 200): RouteResponse => ({
      status,
      body: JSON.stringify(body ?? null),
      contentType: "application/json; charset=utf-8",
    }),
  };
}

function tmpRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-api-router-"));
}

function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
  });
}

function postJson(port: number, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload ?? {});
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// ── AC-008a.1.1: the group is in the frozen ROUTE_GROUPS list, protect:true ────

test("008a-AC-1.1 ROUTE_GROUPS contains { path: /api/hive-graph, protect: true }", () => {
  const spec = ROUTE_GROUPS.find((s) => s.path === HIVE_GRAPH_GROUP);
  assert.ok(spec !== undefined, "the group is in the frozen list");
  assert.equal(spec?.protect, true, "the group is protect: true");
  assert.equal(HIVE_GRAPH_GROUP, "/api/hive-graph");
});

// ── AC-008a.2.1 / 2.2: the group() accessor returns a RouteGroup / undefined ───

test("008a-AC-2.1 group() returns a RouteGroup handle for the mounted group", () => {
  const router = new NectarRouter();
  const group = router.group(HIVE_GRAPH_GROUP);
  assert.ok(group !== undefined, "the mounted group resolves to a RouteGroup");
  assert.equal(group?.base, HIVE_GRAPH_GROUP);
});

test("008a-AC-2.2 group() returns undefined for an unknown group path", () => {
  const router = new NectarRouter();
  assert.equal(router.group("/api/does-not-exist"), undefined);
});

// ── AC-008a.2.3 + AC-008a.1.2: handler registers at the full path and inherits ─
//    the already-mounted permission middleware.

test("008a-AC-2.3 a handler registered via group.post('/search') runs at the full /api/hive-graph/search path", async () => {
  const router = new NectarRouter();
  const group = router.group(HIVE_GRAPH_GROUP);
  assert.ok(group !== undefined);
  let ran = false;
  group!.post("/search", (ctx) => {
    ran = true;
    return ctx.json({ ok: true });
  });
  const res = await router.dispatch(makeCtx("POST", "/api/hive-graph/search"));
  assert.ok(res !== undefined);
  assert.equal(res?.status, 200);
  assert.equal(ran, true, "the handler ran at the group-relative path mapped to the full path");
});

test("008a-AC-1.2 a protect:true group inherits the permission gate: a deny gate blocks the handler before it runs", async () => {
  const deny = () => ({ status: 403 as const, body: { error: "forbidden" } });
  const router = new NectarRouter(ROUTE_GROUPS, deny);
  const group = router.group(HIVE_GRAPH_GROUP);
  let ran = false;
  group!.post("/search", (ctx) => {
    ran = true;
    return ctx.json({ ok: true });
  });
  const res = await router.dispatch(makeCtx("POST", "/api/hive-graph/search"));
  assert.equal(res?.status, 403, "the inherited permission gate rejected the request");
  assert.equal(ran, false, "the handler never ran behind the gate");
  const body = JSON.parse(res!.body);
  assert.equal(body.error, "forbidden");
});

// ── AC-008a.1.3: an unfilled path under the group falls to the 501 scaffold ─────

test("008a-AC-1.3 an unfilled path under /api/hive-graph returns the root 501 scaffold, not a 404", async () => {
  const router = new NectarRouter(); // allow gate, no handlers attached
  const res = await router.dispatch(makeCtx("GET", "/api/hive-graph/not-attached"));
  assert.ok(res !== undefined, "the path is under a mounted group, so it is handled here");
  assert.equal(res?.status, 501);
  const body = JSON.parse(res!.body);
  assert.equal(body.error, "not_implemented");
  assert.equal(body.path, "/api/hive-graph/not-attached");
});

test("008a-AC-1.3 an unfilled protected path still runs the deny gate first (never answers with no protection)", async () => {
  const deny = () => ({ status: 401 as const, body: { error: "unauthenticated" } });
  const router = new NectarRouter(ROUTE_GROUPS, deny);
  const res = await router.dispatch(makeCtx("GET", "/api/hive-graph/not-attached"));
  assert.equal(res?.status, 401, "the unfilled path is gated, not answered unprotected");
});

test("dispatch returns undefined for a path under no mounted group (server serves its own 404)", async () => {
  const router = new NectarRouter();
  assert.equal(await router.dispatch(makeCtx("GET", "/nope")), undefined);
});

// ── AC-008a.3.1: mountHiveGraphApi no-ops on a daemon whose group() is unknown ──

test("008a-AC-3.1 mountHiveGraphApi is a safe no-op when group() returns undefined", () => {
  const fakeDaemon = { group: () => undefined };
  assert.doesNotThrow(() => mountHiveGraphApi(fakeDaemon, { defaultScope: SCOPE }));
});

test("008a-AC-2.x mountHiveGraphApi attaches handlers to the real router's group", async () => {
  const router = new NectarRouter();
  mountHiveGraphApi(
    { group: (p) => router.group(p) },
    { defaultScope: SCOPE, searchHiveGraph: async () => ({ hits: [], sources: [], degraded: true }) },
  );
  const res = await router.dispatch(makeCtx("POST", "/api/hive-graph/search", { body: { query: "x" } }));
  assert.equal(res?.status, 200);
  assert.deepEqual(JSON.parse(res!.body), { hits: [], sources: [], degraded: true });
});

// ── Real-socket integration: mount from boot, /health stays unprotected, 404 ───

test("008a-AC-1.1/1.2 the daemon mounts /api/hive-graph from boot; a deny gate protects it while /health stays open", async () => {
  const runtimeDir = tmpRuntimeDir();
  const deny = () => ({ status: 401 as const, body: { error: "unauthenticated" } });
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    apiPermission: deny,
    hiveGraphApi: { defaultScope: SCOPE, searchHiveGraph: async () => ({ hits: [], sources: [], degraded: false }) },
  });
  try {
    const port = await daemon.start();

    // /health is unprotected exactly as shipped, even under a deny gate.
    const health = await getJson(port, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");

    // Every /api/hive-graph/* path inherits the deny gate.
    const search = await postJson(port, "/api/hive-graph/search", { query: "x" });
    assert.equal(search.status, 401, "the protected group rejected the request");
    const unfilled = await getJson(port, "/api/hive-graph/not-attached");
    assert.equal(unfilled.status, 401, "even an unfilled protected path is gated, never unprotected");

    // A non-group path preserves the shipped 404 not_found behavior.
    const nope = await getJson(port, "/nope");
    assert.equal(nope.status, 404);
    assert.equal(nope.body.error, "not_found");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("008a a mounted, allowed /api/hive-graph/* unfilled path returns the 501 scaffold over the socket", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    hiveGraphApi: { defaultScope: SCOPE },
  });
  try {
    const port = await daemon.start();
    const res = await getJson(port, "/api/hive-graph/not-attached");
    assert.equal(res.status, 501);
    assert.equal(res.body.error, "not_implemented");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("008a a POST body over the 1 MiB cap is rejected 413 before any handler runs", async () => {
  const runtimeDir = tmpRuntimeDir();
  let handlerCalls = 0;
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    hiveGraphApi: {
      defaultScope: SCOPE,
      searchHiveGraph: async () => {
        handlerCalls++;
        return { hits: [], sources: [], degraded: false };
      },
    },
  });
  try {
    const port = await daemon.start();
    const huge = { query: "a".repeat(1_100_000) };
    const res = await postJson(port, "/api/hive-graph/search", huge);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "payload_too_large");
    assert.equal(handlerCalls, 0, "the oversize body was rejected before the handler ran");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});
