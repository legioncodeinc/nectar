/**
 * End-to-end watch-edit-reassociate integration test (PRD-018b AC-018b.2 / AC-018b.9).
 *
 * This is the gap the change-detection review called out: no test ever exercised
 * a REAL `fs.watch` - every prior test drove `observe()` directly. This suite
 * starts a real daemon over a temp workspace, lets its NodeFS watcher run, and
 * asserts that:
 *   - the boot cold-catch-up resync registers a pre-existing file;
 *   - a live CREATE on disk flows watch -> classify -> ladder -> a durable mint;
 *   - a live EDIT on disk appends a durable version row with `describe_status`
 *     'pending' (the enricher's input), reaching Deep Lake via the bridge;
 *   - after shutdown the watcher is closed, so a further edit is NOT processed.
 *
 * The durable store is an in-memory recorder wrapped as the async seam; only the
 * WATCHER and the workspace are real. Waits are debounce-aware and generous so
 * the suite is robust on Windows (recursive `fs.watch` is supported there), and
 * every watcher/daemon is torn down so nothing leaks. Imports the compiled
 * modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleDaemon } from "../dist/index.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";
import type { Tenancy } from "../dist/hive-graph/model.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const TEN: Tenancy = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const DEBOUNCE_MS = 40;

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

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Poll `pred` until it returns a defined value or the timeout elapses (debounce + fs.watch latency). */
async function pollFor<T>(pred: () => T | undefined, timeoutMs = 8000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = pred();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("pollFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("AC-018b.2/9 a real fs.watch flows create + edit through the ladder into the durable store as pending rows", async () => {
  const runtimeDir = tmpDir("nectar-watch-rt-");
  const projectRoot = tmpDir("nectar-watch-ws-");
  const inner = new InMemoryHiveGraphStore();

  const initial = "export const a = 1;\n";
  writeFileSync(join(projectRoot, "a.ts"), initial, "utf8");

  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    tenancy: TEN,
    projectRoot,
    enricherEnabled: false,
    registrationStore: asyncWrap(inner),
    registrationDebounceMs: DEBOUNCE_MS,
  });

  try {
    await daemon.start();
    await daemon.awaitBoot();
    const bridge = daemon.registration()!.bridge;

    // Boot cold-catch-up resync registers the pre-existing a.ts durably (pending).
    const aFirst = await pollFor(() => {
      const lv = inner.latestVersionByPath(TEN, "a.ts");
      return lv !== undefined ? lv : undefined;
    });
    assert.equal(aFirst.version.describeStatus, "pending", "the resync-registered row is pending (enricher input)");
    const aNectar = aFirst.identity.nectar;

    // A live CREATE observed by the real watcher: b.ts flows to a fresh mint.
    const bContent = "export function b() { return 2; }\n";
    writeFileSync(join(projectRoot, "b.ts"), bContent, "utf8");
    const bLv = await pollFor(() => inner.latestVersionByPath(TEN, "b.ts"));
    assert.equal(bLv.version.describeStatus, "pending", "the live-created file landed pending");
    assert.equal(bLv.version.contentHash, sha256Hex(bContent), "the durable row carries the created content hash");

    // A live EDIT observed by the real watcher: a.ts appends a new version row.
    const edited = "export const a = 1;\n// an edit observed live by fs.watch\n";
    writeFileSync(join(projectRoot, "a.ts"), edited, "utf8");
    const aEdited = await pollFor(() => {
      const lv = inner.latestVersionByPath(TEN, "a.ts");
      return lv !== undefined && lv.version.contentHash === sha256Hex(edited) ? lv : undefined;
    });
    assert.equal(aEdited.identity.nectar, aNectar, "the edit stayed on the same nectar (AC-018b.9)");
    assert.ok(aEdited.version.seq >= 1, "the edit appended a new version row");
    assert.equal(aEdited.version.describeStatus, "pending", "the ladder-appended edit row is pending (AC-018b.9)");

    // Drain the bridge so the durable writes are all flushed before we assert quiet.
    await bridge.whenFlushed();
    const seqAfterEdit = inner.latestVersionByPath(TEN, "a.ts")!.version.seq;

    // AC-018b.3: after shutdown the watcher is closed; a further edit is NOT processed.
    await daemon.shutdown();
    writeFileSync(join(projectRoot, "a.ts"), `${edited}// a post-shutdown edit that must be ignored\n`, "utf8");
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 6));
    const seqAfterShutdown = inner.latestVersionByPath(TEN, "a.ts")!.version.seq;
    assert.equal(seqAfterShutdown, seqAfterEdit, "no watch event is processed after shutdown resolves (AC-018b.3)");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
    rmDirWithRetry(projectRoot);
  }
});
