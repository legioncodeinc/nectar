import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HiveantennaeWorker,
  emptyJobSource,
  type Job,
  type JobKind,
  type JobSource,
} from "../dist/worker.js";

/** An in-memory job source for testing the harness without Deep Lake. */
function arraySource(jobs: Job[]) {
  const completed: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  const source: JobSource = {
    lease(kinds: readonly JobKind[]) {
      const idx = jobs.findIndex((j) => kinds.includes(j.kind));
      if (idx === -1) return null;
      return jobs.splice(idx, 1)[0] ?? null;
    },
    complete(id) {
      completed.push(id);
    },
    fail(id, reason) {
      failed.push({ id, reason });
    },
  };
  return { source, completed, failed };
}

test("runOnce returns false on an empty source", async () => {
  const worker = new HiveantennaeWorker({
    source: emptyJobSource,
    handlers: { brood: () => {} },
    pollIntervalMs: 1000,
  });
  assert.equal(await worker.runOnce(), false);
});

test("runOnce leases, runs the handler, and completes", async () => {
  const { source, completed } = arraySource([{ id: "j1", kind: "enrich" }]);
  const seen: string[] = [];
  const worker = new HiveantennaeWorker({
    source,
    handlers: { enrich: (job) => void seen.push(job.id) },
    pollIntervalMs: 1000,
  });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(seen, ["j1"]);
  assert.deepEqual(completed, ["j1"]);
});

test("a throwing handler routes to source.fail, never a silent complete", async () => {
  const { source, completed, failed } = arraySource([{ id: "j2", kind: "brood" }]);
  const worker = new HiveantennaeWorker({
    source,
    handlers: {
      brood: () => {
        throw new Error("describe failed");
      },
    },
    pollIntervalMs: 1000,
    onError: () => {},
  });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(completed, []);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.reason, "describe failed");
});

test("a job whose kind has no handler is failed loudly, not completed", async () => {
  // Lease only 'enrich' kinds but the source hands back one; register no handler for it.
  const { source, completed, failed } = arraySource([{ id: "j3", kind: "enrich" }]);
  const worker = new HiveantennaeWorker({
    source,
    // Register a different kind so 'enrich' is leasable via a mismatched map? Instead
    // register enrich with undefined by casting: simulate a missing handler.
    handlers: { enrich: undefined },
    pollIntervalMs: 1000,
  });
  // With enrich mapped to undefined, kinds includes 'enrich' so it leases, then no handler.
  const ran = await worker.runOnce();
  assert.equal(ran, true);
  assert.deepEqual(completed, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.reason ?? "", /no handler/);
});

test("start and stop are idempotent", () => {
  const worker = new HiveantennaeWorker({
    source: emptyJobSource,
    handlers: { brood: () => {} },
    pollIntervalMs: 1000,
  });
  worker.start();
  worker.start();
  assert.equal(worker.isRunning, true);
  worker.stop();
  worker.stop();
  assert.equal(worker.isRunning, false);
});
