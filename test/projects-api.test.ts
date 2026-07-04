/**
 * PRD-019b: the projects + brooding-control endpoints, exercised through the
 * router seam with injected mechanics (the daemon side the hive dashboard calls
 * is real). Also covers the hand-validated toggle body and the persist/reconcile
 * ordering (b-AC-3/4/5/6). Imports the compiled modules from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NectarRouter, type RouteContext, type RouteResponse } from "../dist/api/router.js";
import { mountProjectsApi, parseBroodingToggle, type MountProjectsOptions } from "../dist/api/projects-api.js";
import type { ProjectsView } from "../dist/projects-control.js";

function makeCtx(method: string, path: string, opts: { body?: unknown } = {}): RouteContext {
  return {
    method,
    path,
    rawUrl: path,
    query: new URLSearchParams(""),
    headers: {},
    body: () => opts.body,
    json: (body: unknown, status = 200): RouteResponse => ({
      status,
      body: JSON.stringify(body ?? null),
      contentType: "application/json; charset=utf-8",
    }),
  };
}

function mount(options: MountProjectsOptions): NectarRouter {
  const router = new NectarRouter();
  mountProjectsApi({ group: (p) => router.group(p) }, options);
  return router;
}

async function call(router: NectarRouter, method: string, path: string, opts: { body?: unknown } = {}) {
  const res = await router.dispatch(makeCtx(method, path, opts));
  assert.ok(res !== undefined, `${method} ${path} should be handled`);
  return { status: res!.status, body: JSON.parse(res!.body) };
}

const VIEW: ProjectsView = {
  globalBrooding: "on",
  projects: [
    { projectId: "p1", name: "Repo One", path: "/work/one", brooding: "active", watcher: "running", counts: null },
  ],
};

test("GET /api/hive-graph/projects returns the view shape the dashboard consumes", async () => {
  const router = mount({
    view: () => VIEW,
    setProject: () => {},
    setGlobal: () => {},
    reconcile: async () => {},
  });
  const res = await call(router, "GET", "/api/hive-graph/projects");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, VIEW, "GET returns { globalBrooding, projects: [{ projectId, name, path, brooding, watcher, counts }] }");
});

test("b-AC-3 POST { projectId, brooding: off } persists then reconciles, returning the new view", async () => {
  const calls: string[] = [];
  const router = mount({
    view: () => VIEW,
    setProject: (id, b) => calls.push(`set:${id}:${b}`),
    setGlobal: () => calls.push("global"),
    reconcile: async () => calls.push("reconcile"),
  });
  const res = await call(router, "POST", "/api/hive-graph/projects/brooding", { body: { projectId: "p1", brooding: "off" } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["set:p1:off", "reconcile"], "persist happens BEFORE reconcile");
  assert.deepEqual(res.body, VIEW);
});

test("b-AC-5 POST { global: paused } sets the global switch then reconciles", async () => {
  const calls: string[] = [];
  const router = mount({
    view: () => VIEW,
    setProject: () => calls.push("project"),
    setGlobal: (g) => calls.push(`global:${g}`),
    reconcile: async () => calls.push("reconcile"),
  });
  const res = await call(router, "POST", "/api/hive-graph/projects/brooding", { body: { global: "paused" } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["global:paused", "reconcile"]);
});

test("b-AC-6 a persist (disk) failure returns 500 with a REDACTED reason and does NOT reconcile (prior state intact)", async () => {
  const calls: string[] = [];
  const observed: unknown[] = [];
  const rawError = new Error("EACCES: permission denied, open 'C:\\Users\\op\\.apiary\\nectar\\.projects.json.123.456.tmp'");
  const router = mount({
    view: () => VIEW,
    setProject: () => {
      throw rawError;
    },
    setGlobal: () => {},
    reconcile: async () => calls.push("reconcile"),
    stateFilePath: "/state/projects.json",
    onPersistError: (err) => observed.push(err),
  });
  const res = await call(router, "POST", "/api/hive-graph/projects/brooding", { body: { projectId: "p1", brooding: "off" } });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "persist_failed");
  // Redaction: the stable reason names only the state file, never the raw OS error.
  assert.equal(res.body.reason, "could not persist the brooding state (/state/projects.json)");
  assert.ok(!/EACCES|errno|permission denied|\.tmp/.test(JSON.stringify(res.body)), "no raw errno text leaks into the body");
  // The raw failure still reaches the server-side observer (daemon log), so diagnostics are not lost.
  assert.deepEqual(observed, [rawError]);
  assert.deepEqual(calls, [], "the reconcile is NOT run against a half-written file");
});

test("b-AC-6 a persist failure with no stateFilePath configured still redacts to the stable reason only", async () => {
  const router = mount({
    view: () => VIEW,
    setProject: () => {
      throw new Error("ENOSPC: no space left on device, write");
    },
    setGlobal: () => {},
    reconcile: async () => {},
  });
  const res = await call(router, "POST", "/api/hive-graph/projects/brooding", { body: { projectId: "p1", brooding: "off" } });
  assert.equal(res.status, 500);
  assert.equal(res.body.reason, "could not persist the brooding state");
  assert.ok(!/ENOSPC/.test(JSON.stringify(res.body)));
});

test("an invalid toggle body is a 400 (never a 500) and never persists", async () => {
  const calls: string[] = [];
  const router = mount({
    view: () => VIEW,
    setProject: () => calls.push("set"),
    setGlobal: () => calls.push("set"),
    reconcile: async () => calls.push("reconcile"),
  });
  const bad = await call(router, "POST", "/api/hive-graph/projects/brooding", { body: { projectId: "p1", brooding: "maybe" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_request");
  assert.deepEqual(calls, [], "nothing is persisted for an invalid body");
});

test("parseBroodingToggle accepts exactly one of { projectId, brooding } or { global } and rejects the rest", () => {
  assert.deepEqual(parseBroodingToggle({ projectId: "p", brooding: "on" }), { kind: "project", projectId: "p", brooding: "on" });
  assert.deepEqual(parseBroodingToggle({ global: "paused" }), { kind: "global", global: "paused" });
  assert.throws(() => parseBroodingToggle({ projectId: "p", brooding: "on", global: "on" }), /not both/);
  assert.throws(() => parseBroodingToggle({ brooding: "on" }), /projectId/);
  assert.throws(() => parseBroodingToggle({ global: "nope" }), /"on" or "paused"/);
  assert.throws(() => parseBroodingToggle(42), /object/);
});
