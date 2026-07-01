import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckinWriter } from "../../dist/telemetry/checkin.js";
import { openTelemetryDb } from "../../dist/telemetry/db.js";
import { rmDirWithRetry } from "./test-helpers.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "hivenectar-checkin-"));
}

function statusRow(db) {
  return db.prepare("SELECT * FROM service_status WHERE id = 1").get();
}

test("checkin writes a binding_time, an equal initial last_seen, and the current health (AC-017a.2.1)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    let now = "2026-07-01T00:00:00.000Z";
    const writer = new CheckinWriter({ db, now: () => now });

    writer.checkin("ok");
    const row = statusRow(db);
    assert.equal(row?.["name"], "hivenectar");
    assert.equal(row?.["binding_time"], now);
    assert.equal(row?.["last_seen"], now);
    assert.equal(row?.["health"], "ok");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("checkin's health value matches the same PipelineStatus /health reports (AC-017a.2.2)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new CheckinWriter({ db, now: () => "t" });
    writer.checkin("degraded");
    assert.equal(statusRow(db)?.["health"], "degraded");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("heartbeat advances last_seen without changing binding_time, even with no other change (AC-017a.3.1)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    let now = "2026-07-01T00:00:00.000Z";
    const writer = new CheckinWriter({ db, now: () => now });

    writer.checkin("ok");
    const boundAt = statusRow(db)?.["binding_time"];

    now = "2026-07-01T00:00:10.000Z";
    writer.heartbeat("ok");
    const row = statusRow(db);
    assert.equal(row?.["binding_time"], boundAt, "binding_time is unchanged by a heartbeat");
    assert.equal(row?.["last_seen"], now, "last_seen advanced");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a fresh checkin (restart) writes a NEW binding_time while the row stays single (AC-017a.3.2)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    let now = "2026-07-01T00:00:00.000Z";
    const writer = new CheckinWriter({ db, now: () => now });

    writer.checkin("ok");
    const first = statusRow(db)?.["binding_time"];

    now = "2026-07-01T01:00:00.000Z"; // "restart"
    writer.checkin("ok");
    const row = statusRow(db);
    assert.notEqual(row?.["binding_time"], first, "restart produced a new binding_time");
    assert.equal(row?.["last_seen"], now);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM service_status").get()?.["c"], 1, "still a single latest-wins row");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a status write failure is fail-soft and never throws (AC-7)", () => {
  const closedDb = {
    prepare() {
      throw new Error("db is closed");
    },
  };
  const writer = new CheckinWriter({ db: closedDb, now: () => "t" });
  assert.doesNotThrow(() => writer.checkin("ok"));
  assert.doesNotThrow(() => writer.heartbeat("ok"));
});
