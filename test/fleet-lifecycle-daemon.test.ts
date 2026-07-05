/**
 * PRD-003a a-AC-1 / a-AC-2 (daemon integration): a daemon that boots without
 * credentials serves 503 degraded on /health, and the credentials watch flips it
 * to 200 healthy on the SAME running daemon (no restart) the moment the probe
 * reports credentials present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpGet } from "node:http";
import { assembleDaemon } from "../dist/index.js";
import { healthHttpStatus } from "../dist/health.js";
import type { Timer } from "../dist/poll-loop.js";

const silent = (): void => {};

function tmpRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-fleet-daemon-"));
}

/** A manual timer: tasks are queued, not run, until `flush()` fires the queued ones. */
function manualTimer(): { timer: Timer; flush: () => void; pending: () => number } {
  let nextHandle = 1;
  let tasks: Array<{ handle: number; fn: () => void }> = [];
  return {
    timer: {
      set(fn: () => void, _ms: number): unknown {
        const handle = nextHandle++;
        tasks.push({ handle, fn });
        return handle;
      },
      clear(handle: unknown): void {
        tasks = tasks.filter((t) => t.handle !== handle);
      },
    },
    flush(): void {
      const pending = tasks;
      tasks = [];
      for (const t of pending) t.fn();
    },
    pending: () => tasks.length,
  };
}

/** A minimal socket-level GET, over real HTTP (node:http), never `fetch`-ing through an in-process shortcut. */
function fetchHealthOverSocket(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on("error", reject);
  });
}

test("a-AC-1 a real socket GET /health on a credentials-missing daemon returns 503 with the machine-readable reason", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    storageCredentialsPresent: false,
  });
  try {
    const port = await daemon.start();
    const { status, body } = await fetchHealthOverSocket(port);
    assert.equal(status, 503, "the real HTTP response code (not just the in-process snapshot) is 503");
    const parsed = body as { status: string; storage: { reachable: boolean; reason: string | null } };
    assert.equal(parsed.status, "degraded");
    assert.equal(parsed.storage.reachable, false);
    assert.equal(
      parsed.storage.reason,
      "credentials-missing",
      "the machine-readable reason rides in the real HTTP response body",
    );
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a-AC-1 a daemon that boots without credentials serves 503 degraded with reason credentials-missing", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    storageCredentialsPresent: false,
  });
  try {
    await daemon.start();
    const body = daemon.health.snapshot();
    assert.equal(body.status, "degraded");
    assert.equal(healthHttpStatus(body.status), 503);
    assert.equal(body.storage.reachable, false);
    assert.equal(body.storage.reason, "credentials-missing");
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a-AC-1 a daemon that boots WITH credentials serves 200 ok", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    storageCredentialsPresent: true,
  });
  try {
    await daemon.start();
    const body = daemon.health.snapshot();
    assert.equal(body.status, "ok");
    assert.equal(healthHttpStatus(body.status), 200);
    assert.equal(body.storage.reachable, true);
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a-AC-2 the credentials watch flips /health from 503 to 200 without a restart", async () => {
  const runtimeDir = tmpRuntimeDir();
  const clock = manualTimer();
  let credentialsPresent = false;
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    storageCredentialsPresent: false,
    credentialsWatch: {
      probe: () => credentialsPresent,
      intervalMs: 1000,
      timer: clock.timer,
    },
  });
  try {
    await daemon.start();
    // Boot posture: degraded (503).
    assert.equal(daemon.health.snapshot().status, "degraded");
    assert.equal(healthHttpStatus(daemon.health.snapshot().status), 503);

    // Credentials appear; drive one watch tick on the SAME running daemon.
    credentialsPresent = true;
    clock.flush();
    // Allow any microtasks from the poll tick to settle.
    await new Promise((r) => setImmediate(r));

    const body = daemon.health.snapshot();
    assert.equal(body.status, "ok", "the daemon transitioned to healthy WITHOUT a restart");
    assert.equal(healthHttpStatus(body.status), 200);
    assert.equal(body.storage.reachable, true);
    assert.equal(body.storage.reason, null);
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
