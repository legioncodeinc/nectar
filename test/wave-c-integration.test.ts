/**
 * Wave C integration tests: the shared-file seams that wire the three freshly
 * landed modules (PRD-007 brooding, PRD-016 enricher, PRD-012a search) into the
 * CLI, the daemon boot path, and /health.
 *
 * Covers:
 *   - `nectar brood` arg-parsing + dispatch (classifyBroodInvocation),
 *   - the daemon boot starting AND stopping the enricher loop, feeding /health,
 *   - the auto-brood trigger firing on an empty store and NOT on a populated one,
 *   - /health carrying the new brooding/enricher/cost fields,
 *   - the fresh-clone projection load + inheritance on boot (PRD-011b AC-6),
 *   - the durable enricher store adapter's hydrate + write-through.
 *
 * Imports the compiled modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { assembleDaemon, runBootProjectionLoad } from "../dist/daemon.js";
import { HealthState } from "../dist/health.js";
import { classifyBroodInvocation } from "../dist/cli.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { mintNectar } from "../dist/hive-graph/ulid.js";
import { PROJECTION_SCHEMA_VERSION, DEFAULT_PROJECTION_REL_PATH } from "../dist/projection/format.js";
import { projectionFinalPath } from "../dist/projection/write.js";
import { DeepLakeEnricherStore } from "../dist/enricher/store-adapter.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const silent = () => {};
const TEN = { orgId: "legion", workspaceId: "engineering", projectId: "wave-c" };
const HASH64 = "a".repeat(64);

function tmpRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-wave-c-"));
}

function manualTimer() {
  let seq = 0;
  const jobs = new Map<number, () => void>();
  return {
    timer: {
      set(fn: () => void) {
        const id = ++seq;
        jobs.set(id, fn);
        return id;
      },
      clear(handle: unknown) {
        jobs.delete(handle as number);
      },
    },
    fireAll() {
      for (const fn of [...jobs.values()]) fn();
      jobs.clear();
    },
  };
}

/** Let the microtask/macrotask queue drain so an async poll-loop cycle settles. */
function flush(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityRow(nectar: string) {
  return {
    nectar,
    kind: "file" as const,
    createdAt: "2026-07-01T00:00:00.000Z",
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

function versionRow(nectar: string, seq: number, path: string, status: string) {
  return {
    nectar,
    contentHash: HASH64,
    seq,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    sizeBytes: 10,
    mtimeObserved: "2026-07-01T00:00:00.000Z",
    title: status === "described" ? "T" : "",
    description: status === "described" ? "D" : "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    fingerprint: null,
    describedAt: status === "described" ? "2026-07-01T00:00:00.000Z" : "",
    describeModel: status === "described" ? "m" : "",
    describeStatus: status,
    observedAt: "2026-07-01T00:00:00.000Z",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

/** A fake sync EnricherStore that reports a fixed pending depth and no runnable work. */
function fakeEnricherStore(depth: () => number) {
  return {
    listPendingWork: () => [],
    countPending: () => depth(),
    getVersion: () => undefined,
    listVersions: () => [],
    priorDescribedVersion: () => undefined,
    updateVersion: () => {},
  };
}

const fakeBroodResult = {
  source: "git" as const,
  discoveredCount: 5,
  inheritedCount: 0,
  survivorCount: 5,
  skipBinaryCount: 0,
  skipTooLargeCount: 0,
  batchFileCount: 5,
  soloFileCount: 0,
  batchCalls: 1,
  soloCalls: 0,
  estimate: {
    totalCalls: 1,
    inputTokens: 100,
    inputUsd: 0.005,
    outputUsd: 0.004,
    embeddingUsd: 0.001,
    totalUsd: 0.01,
  },
  // EX-3: the daemon records real usage, not the estimate; the fake reports
  // actuals that happen to match the estimate so the health assertions hold.
  actualUsage: { inputTokens: 100, outputTokens: 25, usd: 0.01 },
  dryRun: false,
  skippedResumeCount: 0,
  reenqueueCount: 0,
  freshCount: 5,
  describedCount: 2,
  failedCount: 0,
  projectionPath: null,
};

// ── A. `nectar brood` arg parsing + dispatch (PRD-007d) ────────────────────────

test("classifyBroodInvocation routes malformed flags, --dry-run, and a mutating run", () => {
  const bad = classifyBroodInvocation(["--limit", "abc"]);
  assert.equal(bad.kind, "errors");
  assert.ok(bad.kind === "errors" && bad.errors.length > 0);

  const unknown = classifyBroodInvocation(["--nonsense"]);
  assert.equal(unknown.kind, "errors");

  const dry = classifyBroodInvocation(["--dry-run"]);
  assert.equal(dry.kind, "dry-run");

  const run = classifyBroodInvocation(["--force", "--limit", "5", "--model", "gemini-x"]);
  assert.equal(run.kind, "run");
  assert.ok(run.kind === "run" && run.options.force === true);
  assert.ok(run.kind === "run" && run.options.limit === 5);
  assert.ok(run.kind === "run" && run.options.model === "gemini-x");
});

// ── B. Daemon boot starts AND stops the enricher loop, feeding /health ─────────

test("daemon boot starts the enricher loop (feeding /health) and shutdown stops it", async () => {
  const runtimeDir = tmpRuntimeDir();
  const mt = manualTimer();
  let depth = 3;
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    tenancy: TEN,
    enricherTimer: mt.timer,
    enricherStore: fakeEnricherStore(() => depth),
  });
  try {
    await daemon.start();
    // The loop armed a delay-0 tick on the manual timer; fire it and let the cycle settle.
    mt.fireAll();
    await flush();
    assert.equal(daemon.health.snapshot().enricher.queueDepth, 3, "a cycle ran and fed /health");
    assert.ok(daemon.health.snapshot().enricher.lastCycleAt !== null, "lastCycleAt was recorded");

    // Prove the loop STOPPED: change the depth, shut down, fire the pending tick.
    depth = 99;
    await daemon.shutdown();
    mt.fireAll();
    await flush();
    assert.equal(daemon.health.snapshot().enricher.queueDepth, 3, "no cycle runs after shutdown");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

// ── C. Auto-brood fires on an empty store, not on a populated one (PRD-007d) ────

test("auto-brood fires on an empty store and populates the brooding + cost /health fields", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  const calls: number[] = [];
  const broodRun = async () => {
    calls.push(1);
    return fakeBroodResult;
  };
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    tenancy: TEN,
    projectRoot,
    enricherEnabled: false,
    broodStore: new InMemoryHiveGraphStore(),
    broodRun,
  });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(calls.length, 1, "auto-brood fired on the empty, unprojected store");
    const body = daemon.health.snapshot();
    assert.equal(body.brooding.filesDescribed, 2);
    assert.equal(body.brooding.filesTotal, 5);
    assert.equal(body.brooding.active, false, "brooding.active flips back off when the run completes");
    assert.equal(body.cost.broodTotalTokens, 100);
    assert.equal(body.cost.broodTotalUsd, 0.01);
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

test("auto-brood does NOT fire when the store has rows and a projection exists", async () => {
  const runtimeDir = tmpRuntimeDir();
  const projectRoot = tmpRuntimeDir();
  // A populated store: one nectar with a version.
  const store = new InMemoryHiveGraphStore();
  const nectar = mintNectar();
  store.insertIdentity(identityRow(nectar));
  store.appendVersion(versionRow(nectar, 0, "src/a.ts", "described"));
  // And a projection file on disk so hasProjection is true.
  const projPath = projectionFinalPath(projectRoot, DEFAULT_PROJECTION_REL_PATH);
  mkdirSync(dirname(projPath), { recursive: true });
  writeFileSync(projPath, "{}", "utf8");

  const calls: number[] = [];
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    tenancy: TEN,
    projectRoot,
    enricherEnabled: false,
    broodStore: store,
    broodRun: async () => {
      calls.push(1);
      return fakeBroodResult;
    },
  });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(calls.length, 0, "auto-brood is skipped when rows AND a projection exist");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});

// ── C(health). The HealthState setters merge the decision-#20 slices ───────────

test("HealthState Wave C setters merge brooding/enricher/cost/projection fields", () => {
  const h = new HealthState();
  h.setBroodingState({ active: true, filesDescribed: 3, filesTotal: 10, lastEventAt: "2026-07-02T00:00:00.000Z" });
  h.setEnricherState({ queueDepth: 7, consecutiveFailures: 2, lastCycleAt: "2026-07-02T00:00:01.000Z" });
  h.addBroodCost({ tokens: 500, usd: 0.25 });
  h.addBroodCost({ tokens: 500, usd: 0.25 });
  h.setProjectionState({ lastWriteAt: "2026-07-02T00:00:02.000Z", lastContentHash: HASH64 });

  const body = h.snapshot();
  assert.equal(body.brooding.active, true);
  assert.equal(body.brooding.filesDescribed, 3);
  assert.equal(body.enricher.queueDepth, 7);
  assert.equal(body.enricher.consecutiveFailures, 2);
  assert.equal(body.cost.broodTotalTokens, 1000, "cost is additive across broods");
  assert.equal(body.cost.broodTotalUsd, 0.5);
  assert.equal(body.projection.lastContentHash, HASH64);

  // Negative / non-finite cost deltas never corrupt the running total.
  h.addBroodCost({ tokens: -5, usd: Number.NaN });
  assert.equal(h.snapshot().cost.broodTotalTokens, 1000);
});

// ── D. Fresh-clone projection load + inheritance on boot (PRD-011b AC-6) ───────

test("runBootProjectionLoad validates a projection and inherits hash-matched files", async () => {
  const nectar = mintNectar();
  const doc = {
    version: PROJECTION_SCHEMA_VERSION,
    generated_at: "2026-07-02T00:00:00.000Z",
    generator: "test",
    project: { org_id: TEN.orgId, workspace_id: TEN.workspaceId, project_id: TEN.projectId },
    files: {
      [nectar]: {
        content_hash: HASH64,
        path: "src/a.ts",
        title: "Auth middleware",
        description: "Refreshes the session.",
        concepts: ["auth"],
        describe_model: "gemini-2.5-flash",
        described_at: "2026-07-02T00:00:00.000Z",
      },
    },
    derived: {},
  };
  const written: any[] = [];
  const result = await runBootProjectionLoad({
    tenancy: TEN,
    doc,
    diskHashes: new Map([["src/a.ts", HASH64]]),
    nowIso: "2026-07-02T00:00:05.000Z",
    write: (rows) => {
      written.push(...rows);
    },
  });
  assert.equal(result.loaded, true);
  assert.equal(result.inheritSummary?.inherited, 1);
  assert.equal(written.length, 1, "the hash-matched file's row was written to the durable store");
  assert.equal(written[0].identity.nectar, nectar, "nectar inherited verbatim (zero LLM calls)");
  // PRD-018i / NEC-019 AC-018i.5: inherited rows land `pending` (selector-visible) for re-embed.
  assert.equal(written[0].version.describeStatus, "pending");
});

test("runBootProjectionLoad rejects a project-mismatched projection wholesale (never partial)", async () => {
  const nectar = mintNectar();
  const doc = {
    version: PROJECTION_SCHEMA_VERSION,
    generated_at: "2026-07-02T00:00:00.000Z",
    generator: "test",
    project: { org_id: "someone-else", workspace_id: "x", project_id: "y" },
    files: {
      [nectar]: {
        content_hash: HASH64,
        path: "src/a.ts",
        title: "t",
        description: "d",
        concepts: [],
        describe_model: "m",
        described_at: "2026-07-02T00:00:00.000Z",
      },
    },
    derived: {},
  };
  const written: any[] = [];
  const result = await runBootProjectionLoad({
    tenancy: TEN,
    doc,
    diskHashes: new Map([["src/a.ts", HASH64]]),
    write: (rows) => written.push(...rows),
  });
  assert.equal(result.loaded, false);
  assert.equal(result.reason, "project_mismatch");
  assert.equal(written.length, 0, "a rejected projection writes nothing");
});

test("the daemon runs the boot projection load in the background (awaitBoot settles it)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const nectar = mintNectar();
  const doc = {
    version: PROJECTION_SCHEMA_VERSION,
    generated_at: "2026-07-02T00:00:00.000Z",
    generator: "test",
    project: { org_id: TEN.orgId, workspace_id: TEN.workspaceId, project_id: TEN.projectId },
    files: {
      [nectar]: {
        content_hash: HASH64,
        path: "src/a.ts",
        title: "t",
        description: "d",
        concepts: [],
        describe_model: "m",
        described_at: "2026-07-02T00:00:00.000Z",
      },
    },
    derived: {},
  };
  const written: any[] = [];
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    enricherEnabled: false,
    bootProjection: {
      tenancy: TEN,
      doc,
      diskHashes: new Map([["src/a.ts", HASH64]]),
      write: (rows) => written.push(...rows),
    },
  });
  try {
    await daemon.start();
    await daemon.awaitBoot();
    assert.equal(written.length, 1, "the projection loaded and inherited on boot");
    assert.ok(daemon.health.snapshot().projection.lastWriteAt !== null, "projection health updated after inheritance");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

// ── E. The durable enricher store adapter (hydrate + write-through) ─────────────

test("DeepLakeEnricherStore hydrates from the durable seam and commits version-bump appends", async () => {
  const nectar = mintNectar();
  const seeded = [versionRow(nectar, 0, "src/a.ts", "pending")];
  const appended: string[] = [];
  const adapter = new DeepLakeEnricherStore({
    loadVersions: async () => seeded,
    // PRD-018g / NEC-017: the durable write is a collision-safe version-bump
    // append, NOT the retired in-place UPDATE.
    appendVersion: async (row) => {
      const seq = row.seq + 1;
      appended.push(`${row.nectar}@${seq}:${row.describeStatus}`);
      return seq;
    },
  });

  assert.equal(adapter.isHydrated, false);
  await adapter.hydrate(TEN);
  assert.equal(adapter.isHydrated, true);
  assert.equal(adapter.countPending(TEN), 1, "the seeded pending row is visible to the sync cycle");

  const committed = await adapter.commitVersion(versionRow(nectar, 0, "src/a.ts", "described"));
  assert.equal(committed, true, "commitVersion resolves true on a confirmed durable append");
  assert.equal(appended.length, 1, "the described row was durably appended (version-bump), not UPDATEd");
  assert.equal(adapter.countPending(TEN), 0, "the mirror's latest row is now described");
});
