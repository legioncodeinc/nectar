/**
 * HttpDeepLakeTransport transient-retry contract (production hardening from
 * the 2026-07-03 supervised brood: the live backend intermittently returns
 * '500: failed to get database connection', which must not abort a brood).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HttpDeepLakeTransport,
  TransportError,
  QUERY_TRANSIENT_MAX_ATTEMPTS,
} from "../dist/hive-graph/deeplake-transport.js";

function makeTransport(): HttpDeepLakeTransport {
  return new HttpDeepLakeTransport({
    endpoint: "http://127.0.0.1:1",
    token: "t",
    orgId: "o",
    workspaceId: "w",
    timeoutMs: 1000,
  });
}

function fakeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("a transient 500 is retried and the query succeeds on a later attempt", async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return fakeResponse(500, { error: "failed to get database connection" });
    return fakeResponse(200, { columns: ["x"], rows: [[1]] });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const rows = await makeTransport().query("SELECT 1");
  assert.equal(calls, 3, "two transient failures then success");
  assert.deepEqual(rows, [{ x: 1 }]);
});

test("a persistent 500 exhausts the bounded attempts then propagates", async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return fakeResponse(500, { error: "failed to get database connection" });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  await assert.rejects(
    () => makeTransport().query("SELECT 1"),
    (err: unknown) => err instanceof TransportError && err.status === 500,
  );
  assert.equal(calls, QUERY_TRANSIENT_MAX_ATTEMPTS, "bounded attempts, no infinite loop");
});

test("a non-transient 400 fails fast on the first attempt (heal classification unchanged)", async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return fakeResponse(400, { error: 'Column does not exist: column "embed_model" does not exist' });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  await assert.rejects(
    () => makeTransport().query("SELECT 1"),
    (err: unknown) => err instanceof TransportError && err.status === 400,
  );
  assert.equal(calls, 1, "4xx does not retry");
});

test("a 429 is treated as transient", async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return fakeResponse(429, { error: "rate limited" });
    return fakeResponse(200, { columns: ["x"], rows: [[1]] });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const rows = await makeTransport().query("SELECT 1");
  assert.equal(calls, 2);
  assert.deepEqual(rows, [{ x: 1 }]);
});
