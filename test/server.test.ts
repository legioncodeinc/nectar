/**
 * PRD-018a NEC-021 (AC-018a.6): `close()` must force-close an active connection
 * after a grace period so shutdown is bounded, rather than blocking forever
 * behind one in-flight request. Runs against the compiled module from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHttpServer } from "../dist/server.js";
import { HealthState } from "../dist/health.js";
import { NectarRouter, HIVE_GRAPH_GROUP } from "../dist/api/router.js";

test("AC-018a.6 close() force-closes an active in-flight request after the grace and resolves within a bound", async () => {
  const health = new HealthState();
  const router = new NectarRouter();
  const group = router.group(HIVE_GRAPH_GROUP);
  assert.ok(group !== undefined, "the hive-graph group is mounted");
  // A handler that never resolves keeps its request active (never idle), so only
  // a force-close can end it.
  group!.get("/hang", () => new Promise(() => {}));

  const server = createHttpServer(health, "127.0.0.1", 0, router);
  const port = await server.listen();

  let clientEnded = false;
  const req = request({ host: "127.0.0.1", port, path: "/api/hive-graph/hang", method: "GET" }, () => {});
  req.on("error", () => {
    clientEnded = true;
  });
  req.on("close", () => {
    clientEnded = true;
  });
  req.end();

  // Let the request reach the (hanging) handler so the connection is active.
  await new Promise((r) => setTimeout(r, 50));

  const t0 = Date.now();
  await server.close(100); // 100 ms grace, then force-close remaining connections
  const elapsed = Date.now() - t0;

  assert.ok(elapsed >= 90, `close honored the grace before forcing (took ${elapsed}ms)`);
  assert.ok(elapsed < 2000, `close stayed bounded rather than blocking on the active request (took ${elapsed}ms)`);

  // The straggler connection was destroyed by the force-close.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(clientEnded, "the active request's connection was force-closed");
});

test("close() resolves promptly when there are no active connections", async () => {
  const health = new HealthState();
  const server = createHttpServer(health, "127.0.0.1", 0);
  await server.listen();
  const t0 = Date.now();
  await server.close(5_000);
  assert.ok(Date.now() - t0 < 1_000, "an idle server closes without waiting for the grace");
});
