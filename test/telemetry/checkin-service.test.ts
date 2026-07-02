import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckinService, CheckinWriter } from "../../dist/telemetry/checkin.js";
import { openTelemetryDb } from "../../dist/telemetry/db.js";
import { rmDirWithRetry } from "./test-helpers.ts";

// This test covers CheckinService's OWN start()/stop() timer lifecycle (arming
// and disarming the injected heartbeat interval). The check-in/heartbeat WRITE
// behavior itself (binding_time, last_seen, health matching /health, restart
// reset) is exhaustively covered at the CheckinWriter level in `checkin.test.ts`
// and end-to-end through the real daemon in `../daemon.test.ts` ("the heartbeat
// advances last_seen on its interval...", "a restart... resets... metrics to
// zero"), so this test is deliberately narrow and avoids interleaving a SQLite
// read immediately after firing the mock timer mid-test - that specific shape
// was observed to trigger an intermittent, environment-specific (Windows +
// experimental `node:sqlite`) file-handle release delay unrelated to
// CheckinService's own correctness (the identical class, exercised the same
// way through the real daemon, passes reliably in `../daemon.test.ts`).

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "nectar-checkin-service-"));
}

function manualTimer() {
  let seq = 0;
  const jobs = new Map();
  return {
    timer: {
      set(fn) {
        const id = ++seq;
        jobs.set(id, fn);
        return id;
      },
      clear(handle) {
        jobs.delete(handle);
      },
    },
    fireAll() {
      // Delete the fired jobs FIRST, then run them, so a callback that
      // re-arms itself (the heartbeat loop) keeps its fresh job pending.
      const entries = [...jobs.entries()];
      for (const [id] of entries) jobs.delete(id);
      for (const [, fn] of entries) fn();
    },
    pending: () => jobs.size,
  };
}

test("CheckinService arms the heartbeat on start() and disarms it on stop()", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new CheckinWriter({ db, now: () => "t0" });
    const mt = manualTimer();
    const svc = new CheckinService({ writer, health: () => "ok", timer: mt.timer, intervalMs: 1000 });

    svc.start();
    assert.equal(mt.pending(), 1, "the heartbeat is armed on start");
    assert.equal(svc.isRunning, true);

    mt.fireAll(); // the heartbeat fires once, silently rearming itself.

    svc.stop();
    assert.equal(mt.pending(), 0, "stop disarms the heartbeat");
    assert.equal(svc.isRunning, false);

    // Idempotent: a second start()/stop() pair behaves the same way.
    svc.start();
    assert.equal(mt.pending(), 1, "a fresh start re-arms the heartbeat");
    svc.stop();
    assert.equal(mt.pending(), 0);

    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a throwing health sampler is fail-soft: start() does not throw and the heartbeat loop survives bad ticks", () => {
  // No SQLite here on purpose: health() throws BEFORE the writer is reached,
  // so the writer's own fail-soft upsert never engages and the guard under
  // test is CheckinService's own try/catch around the sample-then-write.
  const writer = new CheckinWriter({ db: { prepare() { throw new Error("never reached"); } }, now: () => "t0" });
  const mt = manualTimer();
  const svc = new CheckinService({
    writer,
    health: () => {
      throw new Error("health sampling failed");
    },
    timer: mt.timer,
    intervalMs: 1000,
  });

  assert.doesNotThrow(() => svc.start(), "a bad health sample must not block daemon boot");
  assert.equal(mt.pending(), 1, "the heartbeat is still armed despite the failed initial sample");

  mt.fireAll(); // a tick whose health sample throws...
  assert.equal(mt.pending(), 1, "...still rearms the next heartbeat instead of stopping permanently");

  svc.stop();
  assert.equal(mt.pending(), 0);
});

test("CheckinService.start() is idempotent: a second start() while running does not arm a duplicate heartbeat", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new CheckinWriter({ db, now: () => "t0" });
    const mt = manualTimer();
    const svc = new CheckinService({ writer, health: () => "ok", timer: mt.timer, intervalMs: 1000 });

    svc.start();
    svc.start();
    assert.equal(mt.pending(), 1, "a redundant start() does not arm a second heartbeat");

    svc.stop();
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});
