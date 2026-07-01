/**
 * Regression tests for the CodeRabbit Major (stability/data-integrity) findings
 * fixed on PR #1: blank-env normalization (config), shared in-flight start
 * (daemon), generation-guarded poll loop, and complete()-vs-fail() separation
 * (worker). The atomic-lock fix is covered by the existing stale-reclaim /
 * live-throw cases in lock.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { resolveConfig, DEFAULT_HOST, DEFAULT_PORT } from "../dist/config.js";
import { HiveantennaeWorker, type JobSource } from "../dist/worker.js";
import { PollLoop, type Timer } from "../dist/poll-loop.js";
import { assembleDaemon } from "../dist/index.js";

// --- config: blank env vars must fall back to defaults ---

test("blank/whitespace env vars fall back to defaults (not '' -> cwd/invalid bind)", () => {
  try {
    process.env.HIVENECTAR_RUNTIME_DIR = "";
    process.env.HIVENECTAR_HOST = "   ";
    process.env.HIVENECTAR_PORT = "";
    const cfg = resolveConfig();
    assert.equal(cfg.host, DEFAULT_HOST, "blank host -> default loopback");
    assert.equal(cfg.port, DEFAULT_PORT, "blank port -> default");
    assert.notEqual(cfg.runtimeDir, "", "blank runtime dir -> real home dir, not cwd-relative");
    assert.ok(cfg.lockFilePath.includes("hivenectar.lock"));
  } finally {
    delete process.env.HIVENECTAR_RUNTIME_DIR;
    delete process.env.HIVENECTAR_HOST;
    delete process.env.HIVENECTAR_PORT;
  }
});

test("non-blank env values still apply", () => {
  try {
    process.env.HIVENECTAR_HOST = "0.0.0.0";
    process.env.HIVENECTAR_PORT = "4321";
    const cfg = resolveConfig();
    assert.equal(cfg.host, "0.0.0.0");
    assert.equal(cfg.port, 4321);
  } finally {
    delete process.env.HIVENECTAR_HOST;
    delete process.env.HIVENECTAR_PORT;
  }
});

// --- worker: complete() failure is not a job failure ---

test("a source.complete() failure is NOT reclassified as a job failure", async () => {
  const failed: string[] = [];
  let leased = false;
  const source: JobSource = {
    lease: () => (leased ? null : ((leased = true), { id: "j", kind: "enrich" })),
    complete: () => {
      throw new Error("queue down");
    },
    fail: (_id, reason) => void failed.push(reason),
  };
  const worker = new HiveantennaeWorker({
    source,
    handlers: { enrich: () => {} },
    pollIntervalMs: 1000,
    onError: () => {},
  });
  await assert.rejects(() => worker.runOnce(), /queue down/);
  assert.deepEqual(failed, [], "complete() failure did not trigger source.fail()");
});

// --- poll-loop: generation guard against stop/start races ---

test("a stale in-flight tick does not schedule after stop() + start()", async () => {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const timer: Timer = {
    set(fn) {
      const id = ++nextId;
      timers.set(id, fn);
      return id;
    },
    clear(h) {
      timers.delete(h as number);
    },
  };
  let release: (() => void) | null = null;
  let ticks = 0;
  const loop = new PollLoop({
    floorMs: 10,
    timer,
    tick: () => new Promise<boolean>((res) => { ticks += 1; release = () => res(false); }),
  });

  loop.start();
  assert.equal(timers.size, 1, "one schedule after start");
  // Fire the scheduled timer -> pump(gen1) -> tick in flight (pending).
  const firstId = [...timers.keys()][0] as number;
  const fn = timers.get(firstId);
  timers.delete(firstId);
  fn?.();
  await Promise.resolve();
  assert.equal(ticks, 1, "tick started and is in flight");

  // Stop then start again while the old tick is still pending.
  loop.stop();
  loop.start();
  const schedulesAfterRestart = timers.size;

  // Resolve the stale tick; its pump must see a newer generation and not reschedule.
  release?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, schedulesAfterRestart, "stale pump added no second schedule");
  loop.stop();
});

// --- daemon: concurrent start() shares one startup ---

function getStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
}

test("concurrent start() calls share one startup and return the same bound port", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "hivenectar-fixes-"));
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: () => {} });
  try {
    const [p1, p2] = await Promise.all([daemon.start(), daemon.start()]);
    assert.equal(p1, p2, "both callers observe the same port");
    assert.ok(p1 > 0);
    assert.equal(await getStatus(p1, "/health"), 200);
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
