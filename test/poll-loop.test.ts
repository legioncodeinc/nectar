import { test } from "node:test";
import assert from "node:assert/strict";
import { PollLoop, type Timer } from "../dist/poll-loop.js";

/** A manual clock: schedule callbacks and fire them explicitly, so the loop is deterministic. */
function manualTimer() {
  let pending: { fn: () => void; ms: number } | null = null;
  const timer: Timer = {
    set(fn, ms) {
      pending = { fn, ms };
      return pending;
    },
    clear() {
      pending = null;
    },
  };
  return {
    timer,
    lastDelay: () => pending?.ms ?? null,
    hasPending: () => pending !== null,
    async fire() {
      const p = pending;
      pending = null;
      if (p) p.fn();
      // let the async pump settle
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("runOnce returns the tick result and skips while in-flight", async () => {
  let release: (() => void) | null = null;
  const loop = new PollLoop({
    floorMs: 10,
    tick: () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  });
  const first = loop.runOnce();
  // Second call while the first is still pending must skip (return false immediately).
  const second = await loop.runOnce();
  assert.equal(second, false, "overlapping runOnce skips");
  release?.();
  assert.equal(await first, true, "the in-flight tick resolves to its real value");
});

test("backoff steps toward the ceiling when idle and resets to floor on work", async () => {
  const mt = manualTimer();
  let doWork = false;
  const loop = new PollLoop({
    floorMs: 100,
    ceilingMs: 1000,
    backoffFactor: 2,
    timer: mt.timer,
    tick: () => doWork,
  });

  loop.start();
  assert.equal(mt.lastDelay(), 0, "first tick scheduled immediately");

  await mt.fire(); // idle tick -> delay steps 100
  assert.equal(mt.lastDelay(), 100);
  await mt.fire(); // idle -> 200
  assert.equal(mt.lastDelay(), 200);
  await mt.fire(); // idle -> 400
  assert.equal(mt.lastDelay(), 400);

  doWork = true;
  await mt.fire(); // work -> reset to floor 100
  assert.equal(mt.lastDelay(), 100, "backoff resets to floor when a tick does work");

  loop.stop();
  assert.equal(loop.isRunning, false);
  assert.equal(mt.hasPending(), false, "stop clears the pending timer");
});

test("start is idempotent and stop is idempotent", () => {
  const mt = manualTimer();
  const loop = new PollLoop({ floorMs: 5, timer: mt.timer, tick: () => false });
  loop.start();
  loop.start(); // no throw, still running
  assert.equal(loop.isRunning, true);
  loop.stop();
  loop.stop(); // no throw
  assert.equal(loop.isRunning, false);
});

test("a throwing tick is routed to onError and treated as idle", async () => {
  const mt = manualTimer();
  const errors: unknown[] = [];
  const loop = new PollLoop({
    floorMs: 50,
    ceilingMs: 500,
    timer: mt.timer,
    tick: () => {
      throw new Error("boom");
    },
    onError: (e) => errors.push(e),
  });
  loop.start();
  await mt.fire();
  assert.equal(errors.length, 1, "error captured");
  assert.equal(mt.lastDelay(), 50, "error tick counts as idle -> steps from floor");
  loop.stop();
});
