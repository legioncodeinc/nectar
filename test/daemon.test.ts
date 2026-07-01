import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { assembleDaemon } from "../dist/index.js";
import { DaemonAlreadyRunningError } from "../dist/errors.js";

const silent = () => {};

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
  return mkdtempSync(join(tmpdir(), "hivenectar-daemon-"));
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
    rmSync(runtimeDir, { recursive: true, force: true });
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
    rmSync(runtimeDir, { recursive: true, force: true });
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
    rmSync(runtimeDir, { recursive: true, force: true });
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
    rmSync(runtimeDir, { recursive: true, force: true });
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
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
