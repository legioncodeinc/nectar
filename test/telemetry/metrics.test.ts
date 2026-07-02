import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsWriter, wrapStoreWithMetrics } from "../../dist/telemetry/metrics.js";
import { openTelemetryDb } from "../../dist/telemetry/db.js";
import { InMemorySourceGraphStore } from "../../dist/source-graph/memory-store.js";
import { RegistrationService } from "../../dist/registration/service.js";
import { rmDirWithRetry } from "./test-helpers.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "hivenectar-metrics-"));
}

function metricsRow(db) {
  return db.prepare("SELECT * FROM service_metrics WHERE id = 1").get();
}

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

test("a fresh MetricsWriter establishes an all-zero baseline row immediately (AC-017b.1.2)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    new MetricsWriter({ db, now: () => NOW });
    const row = metricsRow(db);
    assert.equal(Number(row?.["files_registered"]), 0);
    assert.equal(Number(row?.["nectars_minted"]), 0);
    assert.equal(Number(row?.["descriptions_generated"]), 0);
    assert.equal(Number(row?.["source_graph_versions"]), 0);
    assert.equal(Number(row?.["embeddings_computed"]), 0);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM service_metrics").get()?.["c"], 1, "latest-wins single row, not an append log");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("each counter increments independently and the row stays latest-wins (AC-017b.1.1/1.2)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new MetricsWriter({ db, now: () => NOW });

    writer.incrementFilesRegistered();
    writer.incrementFilesRegistered();
    writer.incrementNectarsMinted();
    writer.incrementDescriptionsGenerated();
    writer.incrementSourceGraphVersions();
    writer.incrementSourceGraphVersions();
    writer.incrementSourceGraphVersions();
    writer.incrementEmbeddingsComputed();

    const snap = writer.snapshot();
    assert.equal(snap.filesRegistered, 2);
    assert.equal(snap.nectarsMinted, 1);
    assert.equal(snap.descriptionsGenerated, 1);
    assert.equal(snap.sourceGraphVersions, 3);
    assert.equal(snap.embeddingsComputed, 1);

    const row = metricsRow(db);
    assert.equal(Number(row?.["files_registered"]), 2);
    assert.equal(Number(row?.["source_graph_versions"]), 3);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM service_metrics").get()?.["c"], 1, "still one row after many increments");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a restart (a fresh MetricsWriter) resets the since-restart counters to zero (AC-6 / AC-017b.3.1)", () => {
  const dir = tmpDir();
  try {
    const dbPath = join(dir, "t.sqlite");
    const db1 = openTelemetryDb(dbPath);
    const writer1 = new MetricsWriter({ db: db1, now: () => NOW });
    writer1.incrementFilesRegistered();
    writer1.incrementNectarsMinted();
    assert.equal(metricsRow(db1)?.["files_registered"], 1);
    db1.close();

    // "Restart": a brand new MetricsWriter against the SAME on-disk file.
    const db2 = openTelemetryDb(dbPath);
    new MetricsWriter({ db: db2, now: () => NOW });
    const row = metricsRow(db2);
    assert.equal(Number(row?.["files_registered"]), 0, "reset to zero on restart");
    assert.equal(Number(row?.["nectars_minted"]), 0);
    db2.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("a metrics write failure is fail-soft and never throws (AC-7)", () => {
  const brokenDb = {
    prepare() {
      throw new Error("disk full");
    },
  };
  const writer = new MetricsWriter({ db: brokenDb, now: () => NOW });
  assert.doesNotThrow(() => writer.incrementFilesRegistered());
  assert.equal(writer.snapshot().filesRegistered, 1, "the in-memory count still advances even though the write failed");
});

test("wrapStoreWithMetrics increments nectarsMinted once per successful insertIdentity, never on a rejected duplicate mint", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new MetricsWriter({ db, now: () => NOW });
    const store = wrapStoreWithMetrics(new InMemorySourceGraphStore(), writer);

    const row = {
      nectar: "N1",
      kind: "file",
      createdAt: NOW,
      derivedFromNectar: "",
      forkContentHash: "",
      orgId: "o1",
      workspaceId: "w1",
      projectId: "p1",
      lastUpdateDate: NOW,
    };
    store.insertIdentity(row);
    assert.equal(writer.snapshot().nectarsMinted, 1);

    assert.throws(() => store.insertIdentity(row));
    assert.equal(writer.snapshot().nectarsMinted, 1, "the rejected duplicate did not double-count");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("wrapStoreWithMetrics increments sourceGraphVersions once per appendVersion call, without double counting", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new MetricsWriter({ db, now: () => NOW });
    const store = wrapStoreWithMetrics(new InMemorySourceGraphStore(), writer);

    const version = (nectar, seq) => ({
      nectar,
      contentHash: `hash-${seq}`,
      seq,
      path: "src/a.ts",
      filename: "a.ts",
      ext: "ts",
      sizeBytes: 3,
      mtimeObserved: NOW,
      title: "",
      description: "",
      concepts: "[]",
      embedding: null,
      confidence: null,
      fingerprint: null,
      describedAt: "",
      describeModel: "",
      describeStatus: "pending",
      observedAt: NOW,
      orgId: "o1",
      workspaceId: "w1",
      projectId: "p1",
      lastUpdateDate: NOW,
    });

    store.appendVersion(version("N1", 0));
    store.appendVersion(version("N1", 1));
    store.appendVersion(version("N2", 0));

    const snap = writer.snapshot();
    assert.equal(snap.sourceGraphVersions, 3, "one increment per appendVersion call");
    assert.equal(snap.descriptionsGenerated, 0, "no version row was described, so no false increment");
    assert.equal(snap.embeddingsComputed, 0, "no version row carried an embedding, so no false increment");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test(
  "wrapStoreWithMetrics's descriptionsGenerated/embeddingsComputed wire to the real (currently dormant) row signal, " +
    "not a fabricated hook: they fire the moment a row actually carries a description/embedding",
  () => {
    const dir = tmpDir();
    try {
      const db = openTelemetryDb(join(dir, "t.sqlite"));
      const writer = new MetricsWriter({ db, now: () => NOW });
      const store = wrapStoreWithMetrics(new InMemorySourceGraphStore(), writer);

      const pendingRow = {
        nectar: "N1",
        contentHash: "h1",
        seq: 0,
        path: "src/a.ts",
        filename: "a.ts",
        ext: "ts",
        sizeBytes: 3,
        mtimeObserved: NOW,
        title: "",
        description: "",
        concepts: "[]",
        embedding: null,
        confidence: null,
        fingerprint: null,
        describedAt: "",
        describeModel: "",
        describeStatus: "pending",
        observedAt: NOW,
        orgId: "o1",
        workspaceId: "w1",
        projectId: "p1",
        lastUpdateDate: NOW,
      };
      store.appendVersion(pendingRow);
      assert.equal(writer.snapshot().descriptionsGenerated, 0);
      assert.equal(writer.snapshot().embeddingsComputed, 0);

      const describedRow = {
        ...pendingRow,
        nectar: "N2",
        describeStatus: "described",
        title: "A title",
        description: "A description",
        embedding: new Array(768).fill(0),
      };
      store.appendVersion(describedRow);
      assert.equal(writer.snapshot().descriptionsGenerated, 1, "a described row increments descriptionsGenerated");
      assert.equal(writer.snapshot().embeddingsComputed, 1, "a row with a non-null embedding increments embeddingsComputed");
      db.close();
    } finally {
      rmDirWithRetry(dir);
    }
  },
);

test("no metrics column ever holds nectar content, a description body, or an embedding vector (AC-10 / AC-017b.4.1)", () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new MetricsWriter({ db, now: () => NOW });
    const store = wrapStoreWithMetrics(new InMemorySourceGraphStore(), writer);

    store.insertIdentity({
      nectar: "N1",
      kind: "file",
      createdAt: NOW,
      derivedFromNectar: "",
      forkContentHash: "",
      orgId: "o1",
      workspaceId: "w1",
      projectId: "p1",
      lastUpdateDate: NOW,
    });
    store.appendVersion({
      nectar: "N1",
      contentHash: "h1",
      seq: 0,
      path: "src/secret.ts",
      filename: "secret.ts",
      ext: "ts",
      sizeBytes: 3,
      mtimeObserved: NOW,
      title: "leaked title",
      description: "a very sensitive LLM-minted description of the file body",
      concepts: "[]",
      embedding: new Array(768).fill(0.5),
      confidence: null,
      fingerprint: null,
      describedAt: NOW,
      describeModel: "gemini",
      describeStatus: "described",
      observedAt: NOW,
      orgId: "o1",
      workspaceId: "w1",
      projectId: "p1",
      lastUpdateDate: NOW,
    });

    const row = metricsRow(db);
    const values = Object.values(row ?? {}).map((v) => String(v));
    assert.ok(!values.some((v) => v.includes("leaked title")), "no title leaked into a metrics column");
    assert.ok(!values.some((v) => v.includes("sensitive LLM-minted description")), "no description body leaked into a metrics column");
    assert.ok(!values.some((v) => v.includes("0.5")), "no embedding vector content leaked into a metrics column");
    // Every column value is either a small integer count or the updated_at timestamp.
    for (const [key, value] of Object.entries(row ?? {})) {
      if (key === "id" || key === "updated_at") continue;
      assert.ok(Number.isInteger(Number(value)), `${key} is a pure count`);
    }
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});

test("integration: RegistrationService's metrics + a wrapped store increment files/nectars/versions once per real unit of work", async () => {
  const dir = tmpDir();
  try {
    const db = openTelemetryDb(join(dir, "t.sqlite"));
    const writer = new MetricsWriter({ db, now: () => NOW });
    const rawStore = new InMemorySourceGraphStore();
    const store = wrapStoreWithMetrics(rawStore, writer);

    const files = new Map([
      ["src/a.ts", { content: "aaa" }],
      ["src/b.ts", { content: "bbb" }],
    ]);
    const fs = {
      statPath(rel) {
        const f = files.get(rel);
        if (f === undefined) return null;
        return { sizeBytes: Buffer.byteLength(f.content, "utf8"), mtimeObserved: NOW, readContent: () => f.content };
      },
      existsOnDisk: (rel) => files.has(rel),
      listPaths: () => files.keys(),
    };

    let seq = 0;
    const jobs = new Map();
    const timer = {
      set(fn) {
        const id = ++seq;
        jobs.set(id, fn);
        return id;
      },
      clear(handle) {
        jobs.delete(handle);
      },
    };

    const svc = new RegistrationService({ store, tenancy: TEN, fs, root: "/x", timer, now: () => NOW, metrics: writer });
    svc.observe("src/a.ts");
    svc.observe("src/b.ts");
    for (const fn of [...jobs.values()]) fn();
    jobs.clear();
    await svc._waitForIdle();

    const snap = writer.snapshot();
    assert.equal(snap.filesRegistered, 2, "one increment per settled path resolved through the ladder");
    assert.equal(snap.nectarsMinted, 2, "two fresh mints, no double counting");
    assert.equal(snap.sourceGraphVersions, 2, "two version rows written");
    db.close();
  } finally {
    rmDirWithRetry(dir);
  }
});
