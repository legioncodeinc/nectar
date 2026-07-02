/**
 * Bridge-AC tests: the sync/async brood bridge that closes the Wave D dormancy.
 *
 * Covers:
 *   - the async-native brood pipeline (`runBroodAsync`) end-to-end against a
 *     FAKED async store: rows appended, describe_status pending->described,
 *     projection regenerated, and the PRD-017 counters incremented (via the
 *     `wrapAsyncStoreWithMetrics` seam);
 *   - the live `POST /api/hive-graph/build` endpoint broods when Portkey is
 *     configured, and honestly answers 501 `build_unavailable` when it is not;
 *   - the daemon's durable auto-brood path (`asyncBroodStore`);
 *   - the durable enricher store hydrating its working set FROM the async store.
 *
 * The suite stays fully offline: the async store is an in-memory fake, the
 * describe transport is injected, and the one Deep Lake read path is driven by a
 * fake `QueryRunner` (mirroring `hive-graph-deeplake.test.ts`). Imports the
 * compiled modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { DeepLakeHiveGraphStore } from "../dist/hive-graph/deeplake-store.js";
import { EMBED_DIMS } from "../dist/hive-graph/model.js";
import { filenameOf, extOf } from "../dist/hive-graph/paths.js";
import { wrapAsyncStoreWithMetrics } from "../dist/telemetry/metrics.js";
import { runBroodAsync, planBroodAsync, BATCH_SYSTEM_PROMPT } from "../dist/brooding/index.js";
import { assembleDaemon } from "../dist/daemon.js";
import { NectarRouter } from "../dist/api/router.js";
import { mountHiveGraphApi } from "../dist/api/hive-graph-api.js";
import { buildHiveGraphApiOptions } from "../dist/api/daemon-api-wiring.js";
import { DeepLakeEnricherStore } from "../dist/enricher/store-adapter.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const TEN = { orgId: "legion", workspaceId: "engineering", projectId: "bridge" };
const NOW = "2026-07-02T12:00:00.000Z";
const FAKE_CREDS = {
  apiUrl: "https://example.invalid",
  token: "fake-token",
  orgId: TEN.orgId,
  workspaceId: TEN.workspaceId,
};

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  return {
    statPath(rel: string) {
      const c = map.get(rel);
      if (c === undefined) return null;
      const bytes = Buffer.from(c, "utf8");
      return { sizeBytes: bytes.length, mtimeObserved: NOW, readContent: () => bytes };
    },
    existsOnDisk(rel: string) {
      return map.has(rel);
    },
    listPaths() {
      return [...map.keys()];
    },
  };
}

function fakeGit(paths: string[]) {
  return () => ({ available: true as const, paths });
}

function usage() {
  return { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 };
}

/** A describe transport that answers the batch prompt with one description per file, solo otherwise. */
function makeFakeDescribe() {
  let calls = 0;
  const fn = async (req: any) => {
    calls += 1;
    const system = req.messages[0]?.content ?? "";
    const user = req.messages[1]?.content ?? "";
    if (system === BATCH_SYSTEM_PROMPT) {
      const arr = JSON.parse(user);
      const out = arr.map((f: any) => ({
        nectar: f.nectar,
        title: `T ${f.path}`.slice(0, 80),
        description: `desc for ${f.path}`,
        concepts: ["alpha", "beta"],
      }));
      return { content: JSON.stringify(out), model: req.model ?? "gemini-2.5-flash", usage: usage() };
    }
    return {
      content: JSON.stringify({ description: "a solo description", primary_symbol: "mainFn" }),
      model: req.model ?? "gemini-2.5-flash",
      usage: usage(),
    };
  };
  return { fn, calls: () => calls };
}

const embedProvider = {
  kind: "local" as const,
  embed: async (texts: string[]) => texts.map(() => new Array(EMBED_DIMS).fill(0.01)),
};

/** A recording PipelineMetricsSink so a test can assert the exact counter deltas. */
function recordingMetrics() {
  const counts = {
    filesRegistered: 0,
    nectarsMinted: 0,
    descriptionsGenerated: 0,
    hiveGraphVersions: 0,
    embeddingsComputed: 0,
  };
  return {
    counts,
    sink: {
      incrementFilesRegistered: () => (counts.filesRegistered += 1),
      incrementNectarsMinted: () => (counts.nectarsMinted += 1),
      incrementDescriptionsGenerated: () => (counts.descriptionsGenerated += 1),
      incrementHiveGraphVersions: () => (counts.hiveGraphVersions += 1),
      incrementEmbeddingsComputed: () => (counts.embeddingsComputed += 1),
    },
  };
}

/**
 * A fake {@link AsyncHiveGraphStore} that wraps an in-memory sync store so the
 * real MAX(seq) / latest-per-nectar / projection reductions back the async
 * surface, and records every appended (nectar, seq, describeStatus) so a test
 * can assert the pending->described transition.
 */
function makeAsyncStore() {
  const inner = new InMemoryHiveGraphStore();
  const appends: { nectar: string; seq: number; describeStatus: string }[] = [];
  const store = {
    insertIdentity: async (row: any) => inner.insertIdentity(row),
    getIdentity: async (nectar: string) => inner.getIdentity(nectar),
    touchIdentity: async (nectar: string, d: string) => inner.touchIdentity(nectar, d),
    appendVersion: async (row: any) => {
      appends.push({ nectar: row.nectar, seq: row.seq, describeStatus: row.describeStatus });
      inner.appendVersion(row);
    },
    nextSeq: async (nectar: string) => inner.nextSeq(nectar),
    latestVersion: async (nectar: string) => inner.latestVersion(nectar),
    listLatestVersions: async (t: any) => inner.listLatestVersions(t),
    listLatestDescribedVersions: async (t: any) => inner.listLatestDescribedVersions(t),
    latestVersionByPath: async (t: any, p: string) => inner.latestVersionByPath(t, p),
    latestVersionByHash: async (t: any, h: string) => inner.latestVersionByHash(t, h),
    deleteNectar: async (t: any, nectar: string) => inner.deleteNectar(t, nectar),
  };
  return { store, appends, inner };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "nectar-bridge-"));
}

// ── A. runBroodAsync end-to-end against a faked async store ─────────────────────

test("bridge-AC async brood appends rows, transitions pending->described, regenerates the projection, and counts", async () => {
  const root = tmpRoot();
  const { store, appends, inner } = makeAsyncStore();
  const metrics = recordingMetrics();
  const wrapped = wrapAsyncStoreWithMetrics(store, metrics.sink);
  const describe = makeFakeDescribe();
  try {
    const result = await runBroodAsync(
      {
        store: wrapped,
        tenancy: TEN,
        root,
        fs: makeFs({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" }),
        gitLsFiles: fakeGit(["src/a.ts", "src/b.ts"]),
        projection: null,
        now: () => NOW,
      } as any,
      { describe: describe.fn, embedProvider } as any,
      {},
    );

    assert.equal(result.dryRun, false);
    assert.equal(result.freshCount, 2, "both files were minted fresh");
    assert.equal(result.describedCount, 2, "both files reached described");
    assert.equal(result.failedCount, 0);

    // Rows appended: a pending seq-0 THEN a described seq-1 per nectar (the transition).
    const byNectar = new Map<string, string[]>();
    for (const a of appends) {
      const list = byNectar.get(a.nectar) ?? [];
      list[a.seq] = a.describeStatus;
      byNectar.set(a.nectar, list);
    }
    assert.equal(byNectar.size, 2, "two nectars written");
    for (const statuses of byNectar.values()) {
      assert.equal(statuses[0], "pending", "seq 0 was written pending");
      assert.equal(statuses[1], "described", "seq 1 transitioned to described");
    }

    // Final latest-per-nectar are described (what recall/projection reads).
    const latest = inner.listLatestVersions(TEN);
    assert.equal(latest.length, 2);
    for (const lv of latest) assert.equal(lv.version.describeStatus, "described");

    // Projection regenerated atomically at the durable-store scan.
    assert.ok(result.projectionPath !== null, "a projection path was returned");
    assert.ok(existsSync(result.projectionPath as string), "the projection file exists on disk");

    // Counters moved on the async write path (previously stuck at 0 in prod).
    assert.equal(metrics.counts.nectarsMinted, 2, "one mint per fresh nectar");
    assert.equal(metrics.counts.hiveGraphVersions, 4, "2 pending + 2 described appends");
    assert.equal(metrics.counts.descriptionsGenerated, 2, "one per described row");
    assert.equal(metrics.counts.embeddingsComputed, 2, "one per valid 768-dim embedding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge-AC planBroodAsync previews cost against the async store with zero writes", async () => {
  const { store, appends } = makeAsyncStore();
  const plan = await planBroodAsync({
    store,
    tenancy: TEN,
    root: "/repo",
    fs: makeFs({ "src/a.ts": "export const a = 1;\n" }),
    gitLsFiles: fakeGit(["src/a.ts"]),
    projection: null,
    now: () => NOW,
  } as any);
  assert.equal(plan.discoveredCount, 1);
  assert.equal(appends.length, 0, "a dry preview writes nothing to the store");
});

// ── B. the live build endpoint: broods when configured, 501 when not ────────────

function mount(options: any): NectarRouter {
  const router = new NectarRouter();
  mountHiveGraphApi({ group: (p: string) => router.group(p) }, options);
  return router;
}

function makeCtx(method: string, path: string, opts: { body?: unknown } = {}) {
  return {
    method,
    path,
    rawUrl: path,
    query: new URLSearchParams(""),
    headers: {},
    body: () => opts.body,
    json: (body: unknown, status = 200) => ({
      status,
      body: JSON.stringify(body ?? null),
      contentType: "application/json; charset=utf-8",
    }),
  };
}

async function call(router: NectarRouter, method: string, path: string, opts: { body?: unknown } = {}) {
  const res = await router.dispatch(makeCtx(method, path, opts) as any);
  assert.ok(res !== undefined, `${method} ${path} should be handled`);
  return { status: res!.status, body: JSON.parse(res!.body) };
}

test("bridge-AC live build endpoint broods against the durable store when Portkey is configured", async () => {
  const root = tmpRoot();
  const { store, inner } = makeAsyncStore();
  const metrics = recordingMetrics();
  const describe = makeFakeDescribe();
  try {
    const options = buildHiveGraphApiOptions({
      credentials: FAKE_CREDS as any,
      tenancy: TEN,
      projectRoot: root,
      store: store as any,
      costSpentUsd: () => 0,
      brood: {
        portkey: { enabled: true, apiKey: "k", configId: "c", activeModel: "gemini-2.5-flash" },
        metrics: metrics.sink,
        fs: makeFs({ "src/a.ts": "export const a = 1;\n" }),
        gitLsFiles: fakeGit(["src/a.ts"]),
        describe: describe.fn,
        embedProvider,
      },
    } as any);

    assert.ok(options.runBrood !== undefined, "the build mechanic is wired when Portkey is configured");

    const router = mount(options);
    const res = await call(router, "POST", "/api/hive-graph/build", { body: {} });
    assert.equal(res.status, 200, "the live build path returns a 200 result, not 501");
    assert.equal(res.body.describedCount, 1, "the file was described end-to-end");
    assert.equal(inner.listLatestVersions(TEN).length, 1, "a row landed in the durable store");
    assert.equal(metrics.counts.descriptionsGenerated, 1, "the live build path moved the counters");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge-AC build endpoint stays 501 build_unavailable when Portkey is not configured (honest creds gate)", async () => {
  const root = tmpRoot();
  const { store } = makeAsyncStore();
  try {
    const options = buildHiveGraphApiOptions({
      credentials: FAKE_CREDS as any,
      tenancy: TEN,
      projectRoot: root,
      store: store as any,
      costSpentUsd: () => 0,
      brood: {
        portkey: { enabled: false, reason: "disabled" },
        embedProvider,
      },
    } as any);

    assert.equal(options.runBrood, undefined, "no build mechanic is wired without a describe transport");

    const router = mount(options);
    const res = await call(router, "POST", "/api/hive-graph/build", { body: {} });
    assert.equal(res.status, 501);
    assert.equal(res.body.error, "build_unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C. the daemon's durable auto-brood path (asyncBroodStore) ───────────────────

const fakeBroodResult = {
  source: "git" as const,
  discoveredCount: 4,
  inheritedCount: 0,
  survivorCount: 4,
  skipBinaryCount: 0,
  skipTooLargeCount: 0,
  batchFileCount: 4,
  soloFileCount: 0,
  batchCalls: 1,
  soloCalls: 0,
  estimate: { totalCalls: 1, inputTokens: 80, inputUsd: 0.004, outputUsd: 0.003, embeddingUsd: 0.001, totalUsd: 0.008 },
  dryRun: false,
  skippedResumeCount: 0,
  reenqueueCount: 0,
  freshCount: 4,
  describedCount: 3,
  failedCount: 0,
  projectionPath: null,
};

test("bridge-AC daemon durable auto-brood fires runBroodAsync against an empty async store", async () => {
  const runtimeDir = tmpRoot();
  const projectRoot = tmpRoot();
  const { store } = makeAsyncStore();
  const calls: number[] = [];
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    tenancy: TEN,
    projectRoot,
    enricherEnabled: false,
    asyncBroodStore: store as any,
    broodRunAsync: async () => {
      calls.push(1);
      return fakeBroodResult;
    },
  } as any);
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(calls.length, 1, "durable auto-brood fired on the empty async store");
    const body = daemon.health.snapshot();
    assert.equal(body.brooding.filesDescribed, 3);
    assert.equal(body.brooding.active, false);
    assert.equal(body.cost.broodTotalUsd, 0.008);
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("bridge-AC daemon durable auto-brood runs the real pipeline and moves the telemetry counters", async () => {
  const runtimeDir = tmpRoot();
  const projectRoot = tmpRoot();
  const { store, inner } = makeAsyncStore();
  const describe = makeFakeDescribe();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    tenancy: TEN,
    projectRoot,
    enricherEnabled: false,
    asyncBroodStore: store as any,
    broodConfigAsync: { fs: makeFs({ "src/a.ts": "export const a = 1;\n" }), gitLsFiles: fakeGit(["src/a.ts"]) },
    broodDepsAsync: { describe: describe.fn, embedProvider },
  } as any);
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(inner.listLatestVersions(TEN).length, 1, "the durable auto-brood wrote a row");
    assert.equal(inner.listLatestVersions(TEN)[0].version.describeStatus, "described");
    const snap = daemon.telemetry().metricsSnapshot();
    assert.ok(snap.hiveGraphVersions >= 2, "pending + described appends counted via the daemon telemetry");
    assert.equal(snap.descriptionsGenerated, 1, "the described row moved descriptionsGenerated");
    assert.equal(snap.nectarsMinted, 1);
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

// ── D. the durable enricher hydrating its working set FROM the async store ───────

/** A fake QueryRunner answering the two SELECTs `listLatestVersions` issues. */
function fakeTransport(identityRows: object[], versionRows: object[]) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string): Promise<object[]> {
      calls.push(sql);
      if (sql.includes('"hive_graph_versions"')) return versionRows;
      if (sql.includes('"hive_graph"')) return identityRows;
      return [];
    },
  };
}

function rawIdentity(nectar: string) {
  return {
    nectar,
    kind: "file",
    created_at: NOW,
    derived_from_nectar: "",
    fork_content_hash: "",
    org_id: TEN.orgId,
    workspace_id: TEN.workspaceId,
    project_id: TEN.projectId,
    last_update_date: "",
  };
}

function rawVersion(nectar: string, seq: number, path: string, status: string) {
  return {
    nectar,
    content_hash: "h".repeat(64),
    seq,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    size_bytes: 10,
    mtime_observed: NOW,
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    fingerprint: null,
    described_at: "",
    describe_model: "",
    describe_status: status,
    observed_at: NOW,
    org_id: TEN.orgId,
    workspace_id: TEN.workspaceId,
    project_id: TEN.projectId,
    last_update_date: "",
  };
}

test("bridge-AC durable enricher hydrates its pending working set FROM the async store's latest-per-nectar", async () => {
  const nectar = "n".repeat(26);
  const transport = fakeTransport([rawIdentity(nectar)], [rawVersion(nectar, 0, "src/a.ts", "pending")]);
  const asyncStore = new DeepLakeHiveGraphStore({ credentials: FAKE_CREDS as any, transport });

  const writtenSql: string[] = [];
  const enricher = new DeepLakeEnricherStore({
    loadVersions: async (tenancy: any) => (await asyncStore.listLatestVersions(tenancy)).map((lv: any) => lv.version),
    writeBack: async (sql: string) => {
      writtenSql.push(sql);
    },
  });

  assert.equal(enricher.isHydrated, false);
  await enricher.hydrate(TEN);
  assert.equal(enricher.isHydrated, true);
  assert.equal(enricher.countPending(TEN), 1, "the async store's pending row seeded the enricher working set");

  const work = enricher.listPendingWork(TEN, 10);
  assert.equal(work.length, 1, "the pending row is selectable work");
  assert.equal(work[0].row.path, "src/a.ts");
});
