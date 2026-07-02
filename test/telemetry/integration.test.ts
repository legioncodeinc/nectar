import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createNullTelemetry, createTelemetry } from "../../dist/telemetry/index.js";
import { rmDirWithRetry } from "./test-helpers.ts";

const req = createRequire(import.meta.url);
const { DatabaseSync } = req("node:sqlite");

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "hivenectar-telemetry-integration-"));
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
      for (const fn of [...jobs.values()]) fn();
      jobs.clear();
    },
  };
}

test("createTelemetry opens a real store; enabled is true and dbPath matches the request", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "hivenectar.sqlite");
    const telemetry = createTelemetry({ dbPath, now: () => "t" });
    assert.equal(telemetry.enabled, true);
    assert.equal(telemetry.dbPath, dbPath);
    telemetry.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("createNullTelemetry never touches disk and every method is a safe no-op (AC-7)", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "never-created.sqlite");
    const telemetry = createNullTelemetry(dbPath);
    assert.equal(telemetry.enabled, false);
    const stop = telemetry.startCheckin(() => "ok");
    assert.doesNotThrow(() => stop());
    assert.doesNotThrow(() => telemetry.log("info", "hi"));
    assert.doesNotThrow(() => telemetry.metrics.incrementFilesRegistered());
    assert.doesNotThrow(() => telemetry.close());
    const store = { insertIdentity() {}, appendVersion() {} };
    assert.equal(telemetry.wrapStore(store), store, "wrapStore is a passthrough when disabled");
  } finally {
    rmDirWithRetry(dir);
  }
});

test("integration: a hivedoctor-style read-only reader opens the SQLite in WAL mode and observes live check-in + metrics while hivenectar keeps writing (AC-9)", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "hivenectar.sqlite");
    let now = "2026-07-01T00:00:00.000Z";
    const telemetry = createTelemetry({ dbPath, now: () => now });

    let health = "ok";
    const mt = manualTimer();
    const stopHeartbeat = telemetry.startCheckin(() => health, { timer: mt.timer, intervalMs: 1000 });

    telemetry.metrics.incrementFilesRegistered();
    telemetry.metrics.incrementNectarsMinted();
    telemetry.log("info", "daemon boot complete");

    // hivedoctor opens the SAME file read-only while hivenectar continues writing.
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const status = reader.prepare("SELECT * FROM service_status WHERE id = 1").get();
      assert.equal(status?.["health"], "ok");
      const firstLastSeen = status?.["last_seen"];

      const metricsRow = reader.prepare("SELECT * FROM service_metrics WHERE id = 1").get();
      assert.equal(Number(metricsRow?.["files_registered"]), 1);
      assert.equal(Number(metricsRow?.["nectars_minted"]), 1);

      // hivenectar keeps writing after the reader has already opened its handle.
      now = "2026-07-01T00:00:10.000Z";
      health = "degraded";
      mt.fireAll(); // heartbeat
      telemetry.metrics.incrementFilesRegistered();

      const status2 = reader.prepare("SELECT * FROM service_status WHERE id = 1").get();
      assert.equal(status2?.["health"], "degraded", "the reader observes the live health update");
      assert.notEqual(status2?.["last_seen"], firstLastSeen, "the reader observes last_seen advancing");

      const metricsRow2 = reader.prepare("SELECT * FROM service_metrics WHERE id = 1").get();
      assert.equal(Number(metricsRow2?.["files_registered"]), 2, "the reader observes the live metric update");

      const logs = reader.prepare("SELECT * FROM service_logs ORDER BY id ASC").all();
      assert.ok(logs.some((l) => String(l["message"]).includes("daemon boot complete")));

      // The read-only reader must never be able to write (AC-9's "no lock contention" also implies no accidental mutation).
      assert.throws(() => reader.exec("INSERT INTO service_logs (ts, level, message) VALUES ('t', 'info', 'x')"));
    } finally {
      reader.close();
    }

    stopHeartbeat();
    telemetry.close();
  } finally {
    rmDirWithRetry(dir);
  }
});
