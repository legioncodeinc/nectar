import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { assembleDaemon } from "../dist/index.js";
import { evaluateBroodPrereqs } from "../dist/brood-prereqs.js";
import { DaemonAlreadyRunningError, NonLoopbackOpenApiError } from "../dist/errors.js";
import { readLockIdentity } from "../dist/lock.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { RegistrationService } from "../dist/registration/service.js";
import { StoreBridge } from "../dist/registration/store-bridge.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../dist/hive-graph/model.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const REG_TEN: Tenancy = { orgId: "o1", workspaceId: "w1", projectId: "p1" };

/** Wrap a sync in-memory store as the async durable seam the registration pipeline persists to. */
function asyncWrap(inner: InMemoryHiveGraphStore): AsyncHiveGraphStore {
  return {
    insertIdentity: async (r) => inner.insertIdentity(r),
    getIdentity: async (n) => inner.getIdentity(n),
    touchIdentity: async (n, d) => inner.touchIdentity(n, d),
    appendVersion: async (r) => inner.appendVersion(r),
    nextSeq: async (n) => inner.nextSeq(n),
    latestVersion: async (n) => inner.latestVersion(n),
    listLatestVersions: async (t) => inner.listLatestVersions(t),
    listLatestDescribedVersions: async (t) => inner.listLatestDescribedVersions(t),
    latestVersionByPath: async (t, p) => inner.latestVersionByPath(t, p),
    latestVersionByHash: async (t, h) => inner.latestVersionByHash(t, h),
    deleteNectar: async (t, n) => inner.deleteNectar(t, n),
  };
}

function regIdentity(nectar: string): HiveGraphRow {
  return {
    nectar,
    kind: "file",
    createdAt: "2026-07-03T00:00:00.000Z",
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: REG_TEN.orgId,
    workspaceId: REG_TEN.workspaceId,
    projectId: REG_TEN.projectId,
    lastUpdateDate: "2026-07-03T00:00:00.000Z",
  };
}

function regVersion(nectar: string, path: string, content: string): HiveGraphVersionRow {
  return {
    nectar,
    contentHash: sha256Hex(content),
    seq: 0,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    mtimeObserved: "2026-07-03T00:00:00.000Z",
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    fingerprint: null,
    describedAt: "",
    describeModel: "",
    describeStatus: "pending",
    observedAt: "2026-07-03T00:00:00.000Z",
    orgId: REG_TEN.orgId,
    workspaceId: REG_TEN.workspaceId,
    projectId: REG_TEN.projectId,
    lastUpdateDate: "2026-07-03T00:00:00.000Z",
  };
}

const fakeBroodResult = {
  source: "git" as const,
  discoveredCount: 1,
  inheritedCount: 0,
  survivorCount: 1,
  skipBinaryCount: 0,
  skipTooLargeCount: 0,
  batchFileCount: 1,
  soloFileCount: 0,
  batchCalls: 1,
  soloCalls: 0,
  estimate: { totalCalls: 1, inputTokens: 10, inputUsd: 0.001, outputUsd: 0.001, embeddingUsd: 0, totalUsd: 0.002 },
  actualUsage: { inputTokens: 10, outputTokens: 5, usd: 0.002 },
  dryRun: false,
  skippedResumeCount: 0,
  reenqueueCount: 0,
  freshCount: 1,
  describedCount: 1,
  failedCount: 0,
  projectionPath: null,
};

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

test("018j-AC-018j.4 loopback default with allowAllPermission starts exactly as before", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    assert.equal(daemon.config.host, "127.0.0.1");
    const port = await daemon.start();
    assert.ok(port > 0);
    assert.ok(existsSync(daemon.config.lockFilePath));
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("018j-AC-018j.3 non-loopback NECTAR_HOST with allowAllPermission refuses startup before binding", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ host: "0.0.0.0", port: 0, runtimeDir, log: silent });
  try {
    await assert.rejects(() => daemon.start(), NonLoopbackOpenApiError);
    assert.ok(!existsSync(daemon.config.lockFilePath), "must not acquire the lock off loopback");
    assert.ok(!existsSync(daemon.config.pidFilePath), "must not write pid off loopback");
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

test("AC-018a.1 after a failed second start the survivor's lock/pid survive and a third start still throws (NEC-002 regression)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const first = assembleDaemon({ port: 0, runtimeDir, log: silent });
  const second = assembleDaemon({ port: 0, runtimeDir, log: silent });
  const third = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    await first.start();
    const lockPath = first.config.lockFilePath;
    const pidPath = first.config.pidFilePath;
    assert.ok(existsSync(lockPath) && existsSync(pidPath), "first daemon holds the lock");
    const firstToken = readLockIdentity(lockPath)?.token;

    await assert.rejects(() => second.start(), DaemonAlreadyRunningError);
    // The critical regression (NEC-002 C1): the failed second start's rollback
    // must NOT have deleted the running first daemon's lock and pid files.
    assert.ok(existsSync(lockPath), "the survivor's lock still exists after the failed second start");
    assert.ok(existsSync(pidPath), "the survivor's pid file still exists after the failed second start");
    assert.equal(readLockIdentity(lockPath)?.token, firstToken, "the lock is still the first daemon's");

    // And a third start still throws (no double daemon).
    await assert.rejects(() => third.start(), DaemonAlreadyRunningError);
    assert.equal(readLockIdentity(lockPath)?.token, firstToken, "still the first daemon's lock after the third attempt");
  } finally {
    await first.shutdown();
    await second.shutdown();
    await third.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("AC-018a.2 a start that fails after acquiring the lock (bind error) releases its own lock; the next start succeeds", async () => {
  const runtimeDir = tmpRuntimeDir();
  // Occupy a port so the daemon's bind fails AFTER it has acquired the lock.
  const blocker = createNetServer();
  const occupiedPort: number = await new Promise((resolve) => {
    blocker.listen(0, "127.0.0.1", () => {
      const addr = blocker.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  const daemon = assembleDaemon({ port: occupiedPort, host: "127.0.0.1", runtimeDir, log: silent });
  try {
    await assert.rejects(() => daemon.start(), /EADDRINUSE|listen/i);
    assert.equal(existsSync(daemon.config.lockFilePath), false, "the failed start released its own lock");

    // A fresh start against the same runtime dir now succeeds (no leaked lock).
    const again = assembleDaemon({ port: 0, runtimeDir, log: silent });
    const port = await again.start();
    assert.ok(port > 0);
    await again.shutdown();
  } finally {
    await daemon.shutdown();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmDirWithRetry(runtimeDir);
  }
});

test("AC-018a.10 shutdown drains bootSettled before releasing the lock", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir(); // no projection here -> auto-brood triggers
  let release!: (r: unknown) => void;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    projectRoot,
    log: silent,
    broodStore: new InMemoryHiveGraphStore(),
    broodRun: () => gate as Promise<any>,
  });
  try {
    await daemon.start();
    await new Promise((r) => setTimeout(r, 15)); // let the background boot task enter the blocked brood
    const lockPath = daemon.config.lockFilePath;
    assert.ok(existsSync(lockPath), "lock held while the brood runs");

    const shutdownDone = daemon.shutdown();
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(existsSync(lockPath), "lock is still held while shutdown drains the in-flight brood");

    release({ describedCount: 0, discoveredCount: 0, estimate: { inputTokens: 0, totalUsd: 0 } });
    await shutdownDone;
    assert.equal(existsSync(lockPath), false, "lock released only after the drain completed");
  } finally {
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("AC-018a.11 a hung drain hits the bounded timeout and shutdown still resolves and releases the lock", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  const logs: Array<Record<string, any>> = [];
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    projectRoot,
    log: (line) => logs.push(line),
    shutdownDrainMs: 50, // short, bounded drain
    broodStore: new InMemoryHiveGraphStore(),
    broodRun: () => new Promise(() => {}) as Promise<any>, // never resolves -> drain must time out
  });
  try {
    await daemon.start();
    await new Promise((r) => setTimeout(r, 15));
    const lockPath = daemon.config.lockFilePath;
    const t0 = Date.now();
    await daemon.shutdown();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `shutdown stayed bounded despite the hung drain (took ${elapsed}ms)`);
    assert.equal(existsSync(lockPath), false, "lock released after the bounded drain");
    assert.ok(
      logs.some((l) => l["msg"] === "drain timed out; proceeding with shutdown"),
      "the timed-out drain was logged",
    );
  } finally {
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("EX-1 a shutdown racing an in-flight start unwinds cleanly: start rejects, no lock is leaked, a fresh start works", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    const startP = daemon.start(); // runs synchronously up to `await server.listen()`
    startP.catch(() => {}); // avoid an unhandled-rejection window before we assert
    const lockPath = daemon.config.lockFilePath;
    await daemon.shutdown(); // races the in-flight start between lock acquisition and bind
    await assert.rejects(() => startP); // the start bails out and unwinds
    assert.equal(existsSync(lockPath), false, "no lock was leaked by the aborted start (M6)");

    // A fresh daemon can start against the same runtime dir (nothing leaked).
    const again = assembleDaemon({ port: 0, runtimeDir, log: silent });
    const port = await again.start();
    assert.ok(port > 0);
    await again.shutdown();
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

test("AC-018b.1 start() constructs the registration pipeline and the watcher runs after boot settles", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  const inner = new InMemoryHiveGraphStore();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    tenancy: REG_TEN,
    projectRoot,
    enricherEnabled: false,
    registrationStore: asyncWrap(inner),
  });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    const pipeline = daemon.registration();
    assert.ok(pipeline !== null, "the registration pipeline was constructed");
    assert.ok(pipeline!.service instanceof RegistrationService, "wired a RegistrationService");
    assert.ok(pipeline!.bridge instanceof StoreBridge, "wired the sync/async StoreBridge");
    assert.equal(daemon.health.snapshot().watch.running, true, "the NodeFS watcher is running (AC-018b.1)");
    assert.equal(daemon.registrationBootResyncCount(), 1, "the cold-catch-up resync ran exactly once (AC-018b.5)");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("AC-018b.7 without a durable store the pipeline is not started and /health reports the watch leg dormant", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent, projectRoot, enricherEnabled: false });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(daemon.registration(), null, "no pipeline constructed without a durable store");
    const watch = daemon.health.snapshot().watch;
    assert.equal(watch.running, false, "the watch leg is not running");
    assert.equal(watch.reason, "no-credentials", "the dormant watch leg is observable on /health (AC-018b.7)");
    assert.equal(daemon.registrationBootResyncCount(), 0, "no resync when dormant");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("AC-018b.3 shutdown stops the watcher before releasing the lock and drains the durable bridge", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  const inner = new InMemoryHiveGraphStore();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    tenancy: REG_TEN,
    projectRoot,
    enricherEnabled: false,
    registrationStore: asyncWrap(inner),
  });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    const lockPath = daemon.config.lockFilePath;
    assert.equal(daemon.health.snapshot().watch.running, true, "watcher running before shutdown");
    assert.ok(existsSync(lockPath), "lock held while the watcher runs");

    await daemon.shutdown();

    assert.equal(existsSync(lockPath), false, "the lock was released on shutdown");
    assert.equal(daemon.health.snapshot().watch.running, false, "the watcher was stopped (AC-018b.3)");
    assert.equal(daemon.registration()!.bridge.pendingDurableWrites, 0, "the durable bridge was drained before release");
  } finally {
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("AC-018b.6 auto-brood is sequenced before the watch resync, so a brooded path is not double-minted", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  const content = "export const a = 1;\n";
  writeFileSync(join(projectRoot, "a.ts"), content, "utf8");
  const inner = new InMemoryHiveGraphStore();
  const store = asyncWrap(inner);
  let broodCalls = 0;
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    tenancy: REG_TEN,
    projectRoot,
    enricherEnabled: false,
    // Empty async store -> auto-brood fires; the spy "broods" by minting a.ts durably.
    asyncBroodStore: store,
    registrationStore: store,
    broodRunAsync: async () => {
      broodCalls += 1;
      await store.insertIdentity(regIdentity("brood-nectar-000000000000"));
      await store.appendVersion(regVersion("brood-nectar-000000000000", "a.ts", content));
      return fakeBroodResult;
    },
  });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(broodCalls, 1, "auto-brood fired on the empty store");
    assert.equal(daemon.registrationBootResyncCount(), 1, "the resync ran once, after the brood");
    // If the watcher/resync had run BEFORE the brood (or raced it), a.ts would be
    // minted a second time. The resync hydrated the brood's row first, so a.ts is
    // a step-1/2 no-op and stays a single nectar. This proves the sequencing.
    assert.equal(inner.listLatestVersions(REG_TEN).length, 1, "a.ts is a single nectar; no double mint (AC-018b.6)");
    assert.equal(inner.latestVersionByPath(REG_TEN, "a.ts")!.identity.nectar, "brood-nectar-000000000000");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
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

// ── PRD-018k / NEC-023: loud brooding-dormancy signalling at startup ───────────

test("AC-018k.1 boot without credentials logs a dormancy line naming the missing credentials file", async () => {
  const runtimeDir = tmpRuntimeDir();
  const logs: Record<string, unknown>[] = [];
  const credPath = "/home/dev/.deeplake/credentials.json";
  const prereqs = evaluateBroodPrereqs({
    credentialsPresent: false,
    credentialsPath: credPath,
    portkeyEnabled: false,
    portkeyApiKeySet: false,
    portkeyConfigSet: false,
  });
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: (line) => logs.push(line), broodPrereqs: prereqs });
  try {
    await daemon.start();
    const dormancy = logs.find((l) => l.scope === "brood" && String(l.msg).includes("dormant"));
    assert.ok(dormancy, "a startup dormancy log line was emitted");
    assert.equal(dormancy?.reason, "credentials_missing");
    const missing = dormancy?.missing as string[];
    assert.ok(missing.some((m) => m.includes(".deeplake/credentials.json")), "the line names the missing credentials file");
    // /health carries the same machine-readable reason (AC-018k.3).
    assert.equal(daemon.health.snapshot().brooding.reason, "credentials_missing");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("AC-018k.2 boot with credentials but an unset NECTAR_PORTKEY_API_KEY names that variable", async () => {
  const runtimeDir = tmpRuntimeDir();
  const logs: Record<string, unknown>[] = [];
  const prereqs = evaluateBroodPrereqs({
    credentialsPresent: true,
    credentialsPath: "/home/dev/.deeplake/credentials.json",
    portkeyEnabled: true,
    portkeyApiKeySet: false, // the one unset variable
    portkeyConfigSet: true,
  });
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: (line) => logs.push(line), broodPrereqs: prereqs });
  try {
    await daemon.start();
    const dormancy = logs.find((l) => l.scope === "brood" && String(l.msg).includes("dormant"));
    assert.ok(dormancy, "a startup dormancy log line was emitted");
    assert.equal(dormancy?.reason, "portkey_disabled");
    const missing = dormancy?.missing as string[];
    assert.deepEqual(missing, ["NECTAR_PORTKEY_API_KEY"], "only the unset variable is named");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("AC-018k.1/.2 a fully-configured daemon logs no dormancy line and reports brooding reason null", async () => {
  const runtimeDir = tmpRuntimeDir();
  const logs: Record<string, unknown>[] = [];
  const prereqs = evaluateBroodPrereqs({
    credentialsPresent: true,
    credentialsPath: "/home/dev/.deeplake/credentials.json",
    portkeyEnabled: true,
    portkeyApiKeySet: true,
    portkeyConfigSet: true,
  });
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: (line) => logs.push(line), broodPrereqs: prereqs });
  try {
    await daemon.start();
    assert.ok(!logs.some((l) => l.scope === "brood" && String(l.msg).includes("dormant")), "no dormancy line when ready");
    assert.equal(daemon.health.snapshot().brooding.reason, null);
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});
