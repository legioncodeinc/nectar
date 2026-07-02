import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOG_MAX_AGE_MS,
  LogWriter,
  createLogTap,
  levelFromLine,
  messageFromLine,
  redactLogMessage,
} from "../../dist/telemetry/logs.js";
import { openTelemetryDb } from "../../dist/telemetry/db.js";
import { rmDirWithRetry } from "./test-helpers.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "hivenectar-logs-"));
}

function allLogs(db) {
  return db.prepare("SELECT * FROM service_logs ORDER BY id ASC").all();
}

test("write appends a row carrying a timestamp and a verbosity level (AC-017c.1.1 / AC-017c.3.1)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new LogWriter({ db, now: () => "2026-07-01T00:00:00.000Z" });
    writer.write("info", "listening on 3854");
    const rows = allLogs(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]["ts"], "2026-07-01T00:00:00.000Z");
    assert.equal(rows[0]["level"], "info");
    assert.equal(rows[0]["message"], "listening on 3854");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("rotation keeps the store within its age bound under sustained writes (AC-017c.2.1/2.2, decision #33)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    // One write per simulated second, with a 10-second retention bound: after
    // 250 writes only the rows younger than the bound survive, regardless of
    // how many lines were ever emitted.
    const base = Date.parse("2026-07-02T00:00:00.000Z");
    let tick = 0;
    const writer = new LogWriter({
      db,
      maxAgeMs: 10_000,
      now: () => new Date(base + tick * 1_000).toISOString(),
    });
    for (let i = 0; i < 250; i++) {
      tick = i;
      writer.write("debug", `line ${i}`);
    }

    const rows = allLogs(db);
    assert.equal(rows.length, 11, "bounded by the retention age, not by total lines ever emitted");
    assert.equal(rows[rows.length - 1]["message"], "line 249", "the newest rows survive rotation");
    assert.equal(rows[0]["message"], "line 239", "rows older than maxAgeMs are rotated out");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a non-parseable injected now disables rotation (fail-soft) instead of deleting everything", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new LogWriter({ db, maxAgeMs: 1, now: () => "t" });
    for (let i = 0; i < 5; i++) writer.write("debug", `line ${i}`);
    assert.equal(allLogs(db).length, 5, "no cutoff can be computed, so nothing is deleted");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("the default retention bound is the decision-#33 24h age bound", () => {
  assert.equal(DEFAULT_LOG_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test("redactLogMessage strips a bearer token and an apikey=... field, leaving the rest of the line intact", () => {
  const redacted = redactLogMessage('calling deep lake with Authorization: Bearer sk-abc123XYZ and apikey=topsecret456');
  assert.ok(!redacted.includes("sk-abc123XYZ"));
  assert.ok(!redacted.includes("topsecret456"));
  assert.ok(redacted.includes("calling deep lake with"));
});

test("redactLogMessage strips a bearer token containing +, /, and = (base64-ish opaque tokens)", () => {
  const redacted = redactLogMessage("deeplake call failed with Authorization: Bearer abc+def/ghi== retrying");
  assert.ok(!redacted.includes("abc+def/ghi=="), "the full opaque token is redacted, not just its URL-safe prefix");
  assert.ok(!redacted.includes("abc+"), "no partial token survives");
  assert.ok(redacted.includes("deeplake call failed with"));
  assert.ok(redacted.includes("retrying"), "text after the token is left intact");
});

test("redactLogMessage stops a bearer token at a JSON closing quote so surrounding structure survives", () => {
  const redacted = redactLogMessage('{"authorization":"Bearer sk+live/token=="} sent');
  assert.ok(!redacted.includes("sk+live/token=="));
  assert.ok(redacted.includes("sent"));
});

test("redactLogMessage drops (returns null for) an oversized line rather than writing it (AC-017c.3.2)", () => {
  const hugeFileBody = "x".repeat(5000);
  assert.equal(redactLogMessage(hugeFileBody), null);
});

test("write drops rather than persists an unredactable (oversized) line", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new LogWriter({ db, now: () => "t" });
    writer.write("info", "x".repeat(5000));
    assert.equal(allLogs(db).length, 0, "the oversized line was dropped, never written");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("no log row ever contains a raw authorization header, token, or credential value (AC-10 / AC-017c.3.2)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new LogWriter({ db, now: () => "t" });
    writer.write("error", 'deeplake auth failed: authorization="Bearer super-secret-token-value"');
    writer.write("error", "client_secret: hunter2hunter2hunter2");
    const rows = allLogs(db);
    for (const row of rows) {
      assert.ok(!String(row["message"]).includes("super-secret-token-value"));
      assert.ok(!String(row["message"]).includes("hunter2hunter2hunter2"));
    }
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a log write failure is fail-soft and never throws (AC-7)", () => {
  const brokenDb = {
    prepare() {
      throw new Error("db is closed");
    },
  };
  const writer = new LogWriter({ db: brokenDb, now: () => "t" });
  assert.doesNotThrow(() => writer.write("error", "boom"));
});

test("levelFromLine maps a valid level through and defaults an invalid/missing one to info", () => {
  assert.equal(levelFromLine({ level: "warn" }), "warn");
  assert.equal(levelFromLine({ level: "trace" }), "info");
  assert.equal(levelFromLine({}), "info");
});

test("messageFromLine renders the line (minus level) as a compact string", () => {
  const msg = messageFromLine({ level: "info", scope: "daemon", msg: "listening", port: 3854 });
  assert.ok(msg.includes("daemon"));
  assert.ok(msg.includes("listening"));
  assert.ok(!msg.includes('"level"'), "level is not duplicated into the message text");
});

test("createLogTap mirrors every line into the telemetry sink while preserving the original sink's behavior unchanged", () => {
  const baseLines = [];
  const baseLog = (line) => baseLines.push(line);
  const mirrored = [];
  const sink = { log: (level, message) => mirrored.push({ level, message }) };
  const tapped = createLogTap(baseLog, sink);

  tapped({ level: "warn", scope: "daemon", msg: "degraded" });

  assert.equal(baseLines.length, 1, "the original sink still received the exact line");
  assert.deepEqual(baseLines[0], { level: "warn", scope: "daemon", msg: "degraded" });
  assert.equal(mirrored.length, 1, "the telemetry sink also received a mirrored line");
  assert.equal(mirrored[0].level, "warn");
});

test("createLogTap never lets a telemetry mirror failure affect the wrapped sink", () => {
  const baseLines = [];
  const baseLog = (line) => baseLines.push(line);
  const throwingSink = {
    log() {
      throw new Error("telemetry is down");
    },
  };
  const tapped = createLogTap(baseLog, throwingSink);
  assert.doesNotThrow(() => tapped({ level: "info", msg: "hi" }));
  assert.equal(baseLines.length, 1, "the real sink still ran despite the telemetry failure");
});
