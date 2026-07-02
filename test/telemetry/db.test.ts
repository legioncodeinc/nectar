import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { join } from "node:path";
import {
  TELEMETRY_DB_FILE_NAME,
  TELEMETRY_DIR_NAME,
  defaultTelemetryDbPath,
  openTelemetryDb,
  telemetryDbPathForRuntimeDir,
} from "../../dist/telemetry/db.js";
import { rmDirWithRetry } from "./test-helpers.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "nectar-telemetry-db-"));
}

test("telemetryDbPathForRuntimeDir nests the db under telemetry/nectar.sqlite", () => {
  const p = telemetryDbPathForRuntimeDir("/home/op/.honeycomb");
  assert.equal(p, join("/home/op/.honeycomb", TELEMETRY_DIR_NAME, TELEMETRY_DB_FILE_NAME));
});

test("defaultTelemetryDbPath nests under <home>/.honeycomb/telemetry/nectar.sqlite", () => {
  const p = defaultTelemetryDbPath("/home/op");
  assert.equal(p, join("/home/op", ".honeycomb", "telemetry", "nectar.sqlite"));
});

test("openTelemetryDb creates the directory and the file, and is idempotent to re-open", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "nested", "nectar.sqlite");
    const db1 = openTelemetryDb(dbPath);
    assert.ok(existsSync(dbPath), "the db file was created");
    db1.close();

    // Re-opening must not throw or clobber the existing schema (CREATE TABLE IF NOT EXISTS).
    const db2 = openTelemetryDb(dbPath);
    db2.exec("INSERT INTO service_logs (ts, level, message) VALUES ('t', 'info', 'm')");
    const row = db2.prepare("SELECT COUNT(*) as c FROM service_logs").get();
    assert.equal(Number(row?.c), 1);
    db2.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("security: openTelemetryDb creates its directory owner-only (0o700), not world-readable", { skip: platform === "win32" }, () => {
  // Windows has no POSIX mode bits; this guard is meaningful on multi-user POSIX hosts,
  // the exact threat model the security-review finding (medium) targeted.
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "nested", "nectar.sqlite");
    const db = openTelemetryDb(dbPath);
    db.close();

    const mode = statSync(join(dir, "nested")).mode & 0o777;
    assert.equal(mode, 0o700, `expected the telemetry directory to be owner-only (0o700), got ${mode.toString(8)}`);
  } finally {
    rmDirWithRetry(dir);
  }
});

test("security: openTelemetryDb tightens a PRE-EXISTING telemetry directory to 0o700 too", { skip: platform === "win32" }, () => {
  // mkdirSync's mode only applies to directories it creates; a dir left behind
  // by a pre-fix install with broader bits must still be tightened on open.
  const dir = tmpDir();
  try {
    const telemetryDir = join(dir, "nested");
    mkdirSync(telemetryDir, { recursive: true });
    chmodSync(telemetryDir, 0o755); // explicit chmod: mkdirSync's mode is umask-subject, chmod is not
    assert.equal(statSync(telemetryDir).mode & 0o777, 0o755, "precondition: the dir pre-exists with broad bits");

    const db = openTelemetryDb(join(telemetryDir, "nectar.sqlite"));
    db.close();

    const mode = statSync(telemetryDir).mode & 0o777;
    assert.equal(mode, 0o700, `expected the pre-existing telemetry directory to be tightened to 0o700, got ${mode.toString(8)}`);
  } finally {
    rmDirWithRetry(dir);
  }
});

test("openTelemetryDb creates all three telemetry tables with the pinned Contract B column shape", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "nectar.sqlite");
    const db = openTelemetryDb(dbPath);
    try {
      const tableNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => String(r["name"]));
      assert.ok(tableNames.includes("service_status"));
      assert.ok(tableNames.includes("service_metrics"));
      assert.ok(tableNames.includes("service_logs"));

      // service_status: single-row (id=1) latest-wins, per the pinned schema.
      db.exec(
        "INSERT INTO service_status (id, name, binding_time, last_seen, health) VALUES (1, 'nectar', 't', 't', 'ok')",
      );
      assert.throws(() => db.exec("INSERT INTO service_status (id, name, binding_time, last_seen, health) VALUES (2, 'x', 't', 't', 'ok')"));

      // service_metrics: the 5-counter set, all default 0, NOT NULL.
      db.exec("INSERT INTO service_metrics (id, updated_at) VALUES (1, 't')");
      const metricsRow = db.prepare("SELECT * FROM service_metrics WHERE id = 1").get();
      assert.equal(Number(metricsRow?.["files_registered"]), 0);
      assert.equal(Number(metricsRow?.["nectars_minted"]), 0);
      assert.equal(Number(metricsRow?.["descriptions_generated"]), 0);
      assert.equal(Number(metricsRow?.["hive_graph_versions"]), 0);
      assert.equal(Number(metricsRow?.["embeddings_computed"]), 0);

      // service_logs: level is constrained to the four declared verbosities.
      assert.throws(() => db.exec("INSERT INTO service_logs (ts, level, message) VALUES ('t', 'trace', 'm')"));
      db.exec("INSERT INTO service_logs (ts, level, message) VALUES ('t', 'warn', 'm')");
    } finally {
      db.close();
    }
  } finally {
    rmDirWithRetry(dir);
  }
});

test("openTelemetryDb sets WAL journal mode so a concurrent read-only handle never contends with writes (AC-9)", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "nectar.sqlite");
    const writer = openTelemetryDb(dbPath);
    try {
      const mode = writer.prepare("PRAGMA journal_mode").get();
      assert.equal(String(mode?.["journal_mode"]).toLowerCase(), "wal");
    } finally {
      writer.close();
    }
  } finally {
    rmDirWithRetry(dir);
  }
});
