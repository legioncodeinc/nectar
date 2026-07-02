import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { createRequire } from "node:module";
import { assembleDaemon } from "../dist/index.js";
import { DaemonAlreadyRunningError } from "../dist/errors.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const req = createRequire(import.meta.url);
const { DatabaseSync } = req("node:sqlite");

const silent = () => {};

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

function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
  });
}

function tmpRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-daemon-"));
}

test("daemon binds an ephemeral port and serves GET /health with 200 + ok", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    const port = await daemon.start();
    assert.ok(port > 0, "bound to an ephemeral port");
    assert.ok(existsSync(daemon.config.lockFilePath), "lock acquired");
    assert.ok(existsSync(daemon.config.pidFilePath), "pid file written");

    const res = await getJson(port, "/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.ok("brooding" in res.body && "enricher" in res.body, "purpose-built body");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("a degraded daemon answers /health with 503", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    const port = await daemon.start();
    daemon.health.degrade();
    const res = await getJson(port, "/health");
    assert.equal(res.status, 503);
    assert.equal(res.body.status, "degraded");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("an unknown path returns 404 json", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    const port = await daemon.start();
    const res = await getJson(port, "/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "not_found");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("a second start against the same lock throws before binding", async () => {
  const runtimeDir = tmpRuntimeDir();
  const first = assembleDaemon({ port: 0, runtimeDir, log: silent });
  const second = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    await first.start();
    await assert.rejects(
      () => second.start(),
      (err: unknown) => {
        assert.ok(err instanceof DaemonAlreadyRunningError);
        return true;
      },
    );
  } finally {
    await first.shutdown();
    await second.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("shutdown removes the lock and is idempotent; a fresh start then works", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    await daemon.start();
    const lockPath = daemon.config.lockFilePath;
    await daemon.shutdown();
    assert.equal(existsSync(lockPath), false, "lock removed on shutdown");
    await daemon.shutdown(); // idempotent, no throw

    // A fresh daemon can now start against the same runtime dir.
    const again = assembleDaemon({ port: 0, runtimeDir, log: silent });
    const port = await again.start();
    assert.ok(port > 0);
    await again.shutdown();
  } finally {
    rmDirWithRetry(runtimeDir);
  }
});

test("start() opens telemetry and checks in with the same health PipelineStatus /health reports (PRD-017a)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    const port = await daemon.start();
    const telemetry = daemon.telemetry();
    assert.equal(telemetry.enabled, true, "telemetry opened successfully");

    const reader = new DatabaseSync(telemetry.dbPath, { readOnly: true });
    try {
      const status = reader.prepare("SELECT * FROM service_status WHERE id = 1").get();
      assert.equal(status?.["name"], "nectar");
      assert.equal(status?.["health"], "ok", "matches the same PipelineStatus /health reports (AC-017a.2.2)");
      assert.ok(status?.["binding_time"], "a binding_time was recorded on check-in (AC-017a.2.1)");

      const res = await getJson(port, "/health");
      assert.equal(res.body.status, status?.["health"], "the check-in health and /health agree");
    } finally {
      reader.close();
    }
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("a restart (stop then start on the same daemon) writes a NEW binding_time and resets since-restart metrics to zero (AC-017a.3.2 / AC-017b.3.1)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    await daemon.start();
    const dbPath = daemon.telemetry().dbPath;
    daemon.telemetry().metrics.incrementFilesRegistered();

    const before = new DatabaseSync(dbPath, { readOnly: true });
    const firstBinding = before.prepare("SELECT binding_time FROM service_status WHERE id = 1").get()?.["binding_time"];
    const beforeMetrics = before.prepare("SELECT files_registered FROM service_metrics WHERE id = 1").get()?.["files_registered"];
    before.close();
    assert.equal(Number(beforeMetrics), 1);

    await daemon.shutdown();
    await daemon.start();

    const after = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const secondBinding = after.prepare("SELECT binding_time FROM service_status WHERE id = 1").get()?.["binding_time"];
      assert.notEqual(secondBinding, firstBinding, "restart produced a new binding_time");
      const afterMetrics = after.prepare("SELECT files_registered FROM service_metrics WHERE id = 1").get()?.["files_registered"];
      assert.equal(Number(afterMetrics), 0, "since-restart metrics reset to zero");
    } finally {
      after.close();
    }
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("the heartbeat advances last_seen on its interval even when nothing else changed (AC-017a.3.1)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const mt = manualTimer();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent, telemetryTimer: mt.timer, telemetryHeartbeatIntervalMs: 5000 });
  try {
    await daemon.start();
    const reader = new DatabaseSync(daemon.telemetry().dbPath, { readOnly: true });
    try {
      const first = reader.prepare("SELECT last_seen FROM service_status WHERE id = 1").get()?.["last_seen"];
      await new Promise((resolve) => setTimeout(resolve, 5));
      mt.fireAll();
      const second = reader.prepare("SELECT last_seen FROM service_status WHERE id = 1").get()?.["last_seen"];
      assert.notEqual(second, first, "last_seen advanced on the heartbeat with no other daemon activity");
    } finally {
      reader.close();
    }
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("the daemon's own structured log lines (e.g. 'listening') are mirrored into the telemetry log store, unchanged in their original sink (PRD-017c)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const seen = [];
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: (line) => seen.push(line) });
  try {
    await daemon.start();
    assert.ok(seen.some((l) => l.scope === "daemon" && l.msg === "listening"), "the original sink still received the line unchanged");

    const reader = new DatabaseSync(daemon.telemetry().dbPath, { readOnly: true });
    try {
      const logs = reader.prepare("SELECT * FROM service_logs ORDER BY id ASC").all();
      assert.ok(
        logs.some((l) => String(l["message"]).includes("listening") && l["level"] === "info"),
        "the same line was mirrored into service_logs at the matching verbosity",
      );
    } finally {
      reader.close();
    }
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});
