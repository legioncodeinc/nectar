/**
 * PRD-008b (search endpoint), PRD-008c (build/status/projection endpoints), and
 * the PRD-012b endpoint contract. The handlers are exercised through the router
 * seam with injected mechanics (the daemon is the only storage client; the
 * handlers never open storage). The status read model is tested against a fake
 * StorageQuery. Imports the compiled modules from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NectarRouter, type RouteContext, type RouteResponse } from "../dist/api/router.js";
import { mountHiveGraphApi, NO_ORG_BODY, type MountHiveGraphOptions } from "../dist/api/hive-graph-api.js";
import {
  readHiveGraphStatusOverStorage,
  buildDescribeStatusCountSql,
  buildQueueDepthSql,
  emptyDescribeStatusCounts,
  parseDescribeStatusCounts,
} from "../dist/api/status-query.js";
import { searchHiveGraph, type QueryScope, type StorageQuery, type StorageRow } from "../dist/hive-graph/search.js";
import { TransportError } from "../dist/hive-graph/deeplake-transport.js";

const SCOPE: QueryScope = { orgId: "org", workspaceId: "ws", projectId: "proj" };

function makeCtx(
  method: string,
  path: string,
  opts: { body?: unknown; query?: string } = {},
): RouteContext {
  const rawUrl = opts.query !== undefined && opts.query !== "" ? `${path}?${opts.query}` : path;
  return {
    method,
    path,
    rawUrl,
    query: new URLSearchParams(opts.query ?? ""),
    headers: {},
    body: () => opts.body,
    json: (body: unknown, status = 200): RouteResponse => ({
      status,
      body: JSON.stringify(body ?? null),
      contentType: "application/json; charset=utf-8",
    }),
  };
}

function mount(options: MountHiveGraphOptions): NectarRouter {
  const router = new NectarRouter();
  mountHiveGraphApi({ group: (p) => router.group(p) }, options);
  return router;
}

async function call(router: NectarRouter, method: string, path: string, opts: { body?: unknown; query?: string } = {}) {
  const res = await router.dispatch(makeCtx(method, path, opts));
  assert.ok(res !== undefined, `${method} ${path} should be handled by the router`);
  return { status: res!.status, body: JSON.parse(res!.body) };
}

// ── PRD-008b + PRD-012b endpoint contract: /api/hive-graph/search ──────────────

test("008b-AC-1.1 search delegates to searchHiveGraph and returns its result shape unchanged", async () => {
  const engineResult = {
    hits: [
      { source: "nectar", id: "n1", path: "src/a.ts", title: "T", body: "B", concepts: "[]", content_hash: "h" },
    ],
    sources: ["nectar"],
    degraded: false,
  };
  const router = mount({ defaultScope: SCOPE, searchHiveGraph: async () => engineResult });
  const res = await call(router, "POST", "/api/hive-graph/search", { body: { query: "logins" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, engineResult, "endpoint returns the engine result verbatim (CLI-identical shape)");
});

test("008b-AC-1.3 the limit is passed through to the engine", async () => {
  let seenLimit: number | undefined = -1;
  const router = mount({
    defaultScope: SCOPE,
    searchHiveGraph: async (_q, _s, limit) => {
      seenLimit = limit;
      return { hits: [], sources: [], degraded: false };
    },
  });
  await call(router, "POST", "/api/hive-graph/search", { body: { query: "x", limit: 7 } });
  assert.equal(seenLimit, 7);

  await call(router, "POST", "/api/hive-graph/search", { body: { query: "x" } });
  assert.equal(seenLimit, undefined, "an absent limit passes through as undefined (engine applies its default 20)");
});

test("008b-AC-1.1 GET /search reads ?q= and ?limit= and delegates identically", async () => {
  let seen = { q: "", limit: undefined as number | undefined };
  const router = mount({
    defaultScope: SCOPE,
    searchHiveGraph: async (q, _s, limit) => {
      seen = { q, limit };
      return { hits: [], sources: [], degraded: false };
    },
  });
  await call(router, "GET", "/api/hive-graph/search", { query: "q=jwt&limit=5" });
  assert.deepEqual(seen, { q: "jwt", limit: 5 });
});

test("008b-AC-1.2 an empty query returns the engine's empty/degraded floor (shape identity via the real engine)", async () => {
  // Wire the REAL 012a engine with a storage that must never be called for an
  // empty query; the endpoint + engine together return the floor.
  const storage: StorageQuery = { query: async () => { throw new Error("storage must not be called for an empty query"); } };
  const router = mount({
    defaultScope: SCOPE,
    searchHiveGraph: (query, scope, limit) => searchHiveGraph(query, scope, limit, { storage }),
  });
  const res = await call(router, "POST", "/api/hive-graph/search", { body: { query: "" } });
  assert.deepEqual(res.body, { hits: [], sources: [], degraded: true });
});

test("008b-AC-2.1 a request with no resolvable scope returns NO_ORG_BODY 400 before the engine", async () => {
  let engineCalls = 0;
  const router = mount({
    defaultScope: null,
    searchHiveGraph: async () => {
      engineCalls++;
      return { hits: [], sources: [], degraded: false };
    },
  });
  const res = await call(router, "POST", "/api/hive-graph/search", { body: { query: "x" } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, NO_ORG_BODY);
  assert.equal(engineCalls, 0, "the engine was never reached without a scope");
});

test("008b-AC-3.1 an engine failure is surfaced as { error: search_failed } 500, never an unhandled throw", async () => {
  const router = mount({
    defaultScope: SCOPE,
    searchHiveGraph: async () => {
      throw new Error("boom");
    },
  });
  const res = await call(router, "POST", "/api/hive-graph/search", { body: { query: "x" } });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "search_failed");
  assert.equal(res.body.reason, "boom");
});

test("008b search is a degraded-passthrough: a degraded engine result flows through unchanged", async () => {
  const router = mount({
    defaultScope: SCOPE,
    searchHiveGraph: async () => ({ hits: [], sources: ["nectar"], degraded: true }),
  });
  const res = await call(router, "POST", "/api/hive-graph/search", { body: { query: "x" } });
  assert.equal(res.body.degraded, true);
});

// ── PRD-008c: /api/hive-graph/build ────────────────────────────────────────────

test("008c-AC-1.1/1.3 build invokes runBrood with the resolved scope + flags and returns its result", async () => {
  let seen: any = null;
  const broodResult = { describedCount: 3, projectionPath: null };
  const router = mount({
    defaultScope: SCOPE,
    runBrood: async (args) => {
      seen = args;
      return broodResult;
    },
  });
  const res = await call(router, "POST", "/api/hive-graph/build", { body: { force: true, limit: 5, model: "gemini-x" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, broodResult);
  assert.deepEqual(seen.scope, SCOPE);
  assert.equal(seen.force, true, "AC-1.3 force flows through");
  assert.equal(seen.limit, 5);
  assert.equal(seen.model, "gemini-x");
});

test("008c-AC-1.2 a pipeline failure returns { error: build_failed } 500", async () => {
  const router = mount({
    defaultScope: SCOPE,
    runBrood: async () => {
      throw new Error("pipeline exploded");
    },
  });
  const res = await call(router, "POST", "/api/hive-graph/build", { body: {} });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "build_failed");
  assert.equal(res.body.reason, "pipeline exploded");
});

test("008c build reports already-running (409) when a brood is in flight, without launching a second", async () => {
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = mount({
    defaultScope: SCOPE,
    runBrood: async () => {
      starts++;
      await gate;
      return { describedCount: 0 };
    },
  });
  const first = router.dispatch(makeCtx("POST", "/api/hive-graph/build", { body: {} }));
  // Let the first handler enter runBrood before the second arrives.
  await new Promise((r) => setTimeout(r, 5));
  const second = await call(router, "POST", "/api/hive-graph/build", { body: {} });
  assert.equal(second.status, 409, "the second build reports already-running");
  assert.equal(second.body.status, "already_running");
  release();
  const firstRes = await first;
  assert.equal(firstRes?.status, 200);
  assert.equal(starts, 1, "only one brood ever started");
});

test("008c build with no runBrood wired returns a structured 501 build_unavailable", async () => {
  const router = mount({ defaultScope: SCOPE });
  const res = await call(router, "POST", "/api/hive-graph/build", { body: {} });
  assert.equal(res.status, 501);
  assert.equal(res.body.error, "build_unavailable");
});

// ── PRD-008c: /api/hive-graph/status ───────────────────────────────────────────

test("008c-AC-2.1 status returns queueDepth, the six-value describeStatus breakdown, and costSpentUsd", async () => {
  const status = {
    queueDepth: 12,
    describeStatus: {
      pending: 12,
      described: 1842,
      failed: 3,
      "skipped-too-large": 40,
      "skipped-binary": 61,
      "skipped-deleted": 42,
    },
    costSpentUsd: 2.71,
    degraded: false,
  };
  const router = mount({ defaultScope: SCOPE, readStatus: async () => status });
  const res = await call(router, "GET", "/api/hive-graph/status");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, status);
  // W-1 closed: all three skipped-* reasons stay distinct, never collapsed.
  assert.equal(Object.keys(res.body.describeStatus).length, 6);
});

test("008c-AC-2.2 a missing table degrades the status read to empty counts, never a 500 (fail-soft engine)", async () => {
  const storage: StorageQuery = {
    query: async () => {
      throw new TransportError("query", 'relation "hive_graph_versions" does not exist');
    },
  };
  const status = await readHiveGraphStatusOverStorage(storage, SCOPE, { costSpentUsd: 1.5 });
  assert.equal(status.degraded, true);
  assert.equal(status.queueDepth, 0);
  assert.deepEqual(status.describeStatus, emptyDescribeStatusCounts());
  assert.equal(status.costSpentUsd, 1.5, "the cost counter is still reported when the table is missing");
});

test("008c-AC-2.1 the status read model computes queueDepth + counts over the injected storage", async () => {
  const statusRows: StorageRow[] = [
    { describe_status: "described", n: 5 },
    { describe_status: "pending", n: 2 },
    { describe_status: "failed", n: 1 },
    { describe_status: "not-a-real-status", n: 99 },
  ];
  const queueRows: StorageRow[] = [{ nectar: "n1", seq: 3 }, { nectar: "n2", seq: 1 }];
  const storage: StorageQuery = {
    query: async (sql: string) => (sql.includes("GROUP BY describe_status") ? statusRows : queueRows),
  };
  const status = await readHiveGraphStatusOverStorage(storage, SCOPE, { costSpentUsd: 0.25 });
  assert.equal(status.degraded, false);
  assert.equal(status.queueDepth, 2, "one row per latest-pending nectar");
  assert.equal(status.describeStatus.described, 5);
  assert.equal(status.describeStatus.pending, 2);
  assert.equal(status.describeStatus["skipped-deleted"], 0, "unmentioned real values default to 0");
  assert.equal(status.costSpentUsd, 0.25);
});

test("008c-AC-2.3 the status SQL issues aggregate counts (GROUP BY / MAX), not a full scan", () => {
  const countSql = buildDescribeStatusCountSql(SCOPE);
  assert.match(countSql, /COUNT\(\*\)/);
  assert.match(countSql, /GROUP BY describe_status/);
  assert.match(countSql, /org_id = 'org'/);
  const queueSql = buildQueueDepthSql(SCOPE);
  assert.match(queueSql, /MAX\(seq\)/);
  assert.match(queueSql, /describe_status = 'pending'/);
  assert.match(queueSql, /GROUP BY nectar/);
});

test("008c status describeStatus enum stays the real six values, skipped-* never collapsed (W-1 closed)", () => {
  const empty = emptyDescribeStatusCounts();
  assert.deepEqual(Object.keys(empty).sort(), [
    "described",
    "failed",
    "pending",
    "skipped-binary",
    "skipped-deleted",
    "skipped-too-large",
  ]);
  const parsed = parseDescribeStatusCounts([
    { describe_status: "skipped-binary", n: 3 },
    { describe_status: "skipped-deleted", n: 4 },
    { describe_status: "skipped-too-large", n: 5 },
  ]);
  assert.equal(parsed["skipped-binary"], 3);
  assert.equal(parsed["skipped-deleted"], 4);
  assert.equal(parsed["skipped-too-large"], 5);
});

test("008c status with no readStatus wired reports a degraded empty status (never a 500)", async () => {
  const router = mount({ defaultScope: SCOPE });
  const res = await call(router, "GET", "/api/hive-graph/status");
  assert.equal(res.status, 200);
  assert.equal(res.body.degraded, true);
  assert.equal(res.body.queueDepth, 0);
});

test("008c status with no resolvable scope returns NO_ORG_BODY 400", async () => {
  const router = mount({ defaultScope: null, readStatus: async () => ({ queueDepth: 0, describeStatus: emptyDescribeStatusCounts(), costSpentUsd: 0, degraded: false }) });
  const res = await call(router, "GET", "/api/hive-graph/status");
  assert.equal(res.status, 400);
});

// ── PRD-008c: projection read + regenerate ─────────────────────────────────────

test("008c-AC-3.1 GET /projection returns the current projection via the injected read", async () => {
  const projection = { version: 1, files: { n1: { path: "src/a.ts" } } };
  const router = mount({ defaultScope: SCOPE, readProjection: async () => projection });
  const res = await call(router, "GET", "/api/hive-graph/projection");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, projection);
});

test("008c-AC-3.2 POST /projection/rebuild returns { regenerated, nectarsCount, generatedAt }", async () => {
  const result = { regenerated: true, nectarsCount: 42, generatedAt: "2026-07-02T00:00:00.000Z" };
  let scopeSeen: QueryScope | null = null;
  const router = mount({
    defaultScope: SCOPE,
    rebuildProjection: async (scope) => {
      scopeSeen = scope;
      return result;
    },
  });
  const res = await call(router, "POST", "/api/hive-graph/projection/rebuild", { body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, result);
  assert.deepEqual(scopeSeen, SCOPE, "the rebuild resolved scope per-request");
});

test("008c a projection rebuild failure returns { error: regenerate_failed } 500", async () => {
  const router = mount({
    defaultScope: SCOPE,
    rebuildProjection: async () => {
      throw new Error("disk full");
    },
  });
  const res = await call(router, "POST", "/api/hive-graph/projection/rebuild", { body: {} });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "regenerate_failed");
});

test("008c a ?project= override resolves a per-request scope on top of the default", async () => {
  let scopeSeen: QueryScope | null = null;
  const router = mount({
    defaultScope: SCOPE,
    readStatus: async (scope) => {
      scopeSeen = scope;
      return { queueDepth: 0, describeStatus: emptyDescribeStatusCounts(), costSpentUsd: 0, degraded: false };
    },
  });
  await call(router, "GET", "/api/hive-graph/status", { query: "project=other-proj" });
  assert.deepEqual(scopeSeen, { orgId: "org", workspaceId: "ws", projectId: "other-proj" });
});
