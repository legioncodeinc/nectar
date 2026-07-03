/**
 * StoreBridge tests (PRD-018b AC-018b.4): the sync/async bridge that lets the
 * synchronous re-association ladder persist to the async durable store.
 *
 * Covers:
 *   - ordered write-through: durable writes land in the exact order the ladder
 *     produced them, even interleaved across write kinds;
 *   - reads served synchronously from the mirror (identity/seq/by-path/by-hash);
 *   - hydration seeds the mirror from the durable latest-per-nectar so seq
 *     numbering continues and cold catch-up starts warm;
 *   - failure surfacing: an injected durable flush failure is surfaced
 *     (onFlushError + durableFlushFailures), never swallowed, never poisons the
 *     queue, and never throws back into the synchronous caller.
 *
 * Fully offline: the durable store is an in-memory recorder. Imports the
 * compiled modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreBridge } from "../dist/registration/store-bridge.js";
import type { AsyncHiveGraphStore, LatestVersion } from "../dist/hive-graph/store.js";
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../dist/hive-graph/model.js";

const TEN: Tenancy = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-03T00:00:00.000Z";

function identity(nectar: string): HiveGraphRow {
  return {
    nectar,
    kind: "file",
    createdAt: NOW,
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: NOW,
  };
}

function version(nectar: string, seq: number, path: string, contentHash = "h".repeat(64)): HiveGraphVersionRow {
  return {
    nectar,
    contentHash,
    seq,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    sizeBytes: 10,
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
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: NOW,
  };
}

/** An in-memory recorder AsyncHiveGraphStore: records every write op in order; can be made to fail one op. */
function recorderStore(opts: { failOn?: (op: string, arg: string) => boolean; seed?: LatestVersion[] } = {}) {
  const ops: string[] = [];
  const failOn = opts.failOn ?? (() => false);
  const seeded = opts.seed ?? [];
  const store: AsyncHiveGraphStore = {
    insertIdentity: async (row) => {
      if (failOn("insertIdentity", row.nectar)) throw new Error(`inject insertIdentity ${row.nectar}`);
      ops.push(`insertIdentity:${row.nectar}`);
    },
    getIdentity: async (nectar) => seeded.find((lv) => lv.identity.nectar === nectar)?.identity,
    touchIdentity: async (nectar, d) => {
      if (failOn("touchIdentity", nectar)) throw new Error(`inject touchIdentity ${nectar}`);
      ops.push(`touchIdentity:${nectar}:${d}`);
    },
    appendVersion: async (row) => {
      if (failOn("appendVersion", `${row.nectar}#${row.seq}`)) throw new Error(`inject appendVersion ${row.nectar}#${row.seq}`);
      ops.push(`appendVersion:${row.nectar}#${row.seq}`);
    },
    nextSeq: async () => 0,
    latestVersion: async (nectar) => seeded.find((lv) => lv.identity.nectar === nectar)?.version,
    listLatestVersions: async () => seeded.map((lv) => ({ identity: { ...lv.identity }, version: { ...lv.version } })),
    listLatestDescribedVersions: async () => [],
    latestVersionByPath: async (_t, path) => seeded.find((lv) => lv.version.path === path),
    latestVersionByHash: async (_t, hash) => seeded.find((lv) => lv.version.contentHash === hash),
    deleteNectar: async (_t, nectar) => {
      if (failOn("deleteNectar", nectar)) throw new Error(`inject deleteNectar ${nectar}`);
      ops.push(`deleteNectar:${nectar}`);
    },
  };
  return { store, ops };
}

test("store-bridge: durable writes land in the exact ladder order (ordered write-through, AC-018b.4)", async () => {
  const { store, ops } = recorderStore();
  const bridge = new StoreBridge({ durable: store });

  // A ladder-shaped sequence: mint (insert+append), edit (append+touch), delete.
  bridge.insertIdentity(identity("n1"));
  bridge.appendVersion(version("n1", 0, "src/a.ts"));
  bridge.appendVersion(version("n1", 1, "src/a.ts", "b".repeat(64)));
  bridge.touchIdentity("n1", NOW);
  bridge.insertIdentity(identity("n2"));
  bridge.appendVersion(version("n2", 0, "src/b.ts"));
  bridge.deleteNectar(TEN, "n2");

  await bridge.whenFlushed();

  assert.deepEqual(ops, [
    "insertIdentity:n1",
    "appendVersion:n1#0",
    "appendVersion:n1#1",
    `touchIdentity:n1:${NOW}`,
    "insertIdentity:n2",
    "appendVersion:n2#0",
    "deleteNectar:n2",
  ]);
  assert.equal(bridge.durableFlushFailures, 0, "no flush failures");
  assert.equal(bridge.pendingDurableWrites, 0, "queue fully drained");
});

test("store-bridge: reads are served synchronously from the mirror", async () => {
  const { store } = recorderStore();
  const bridge = new StoreBridge({ durable: store });
  bridge.insertIdentity(identity("n1"));
  bridge.appendVersion(version("n1", 0, "src/a.ts", "c".repeat(64)));

  assert.equal(bridge.getIdentity("n1")?.nectar, "n1");
  assert.equal(bridge.nextSeq("n1"), 1, "seq continues from the mirror");
  assert.equal(bridge.latestVersionByPath(TEN, "src/a.ts")?.identity.nectar, "n1");
  assert.equal(bridge.latestVersionByHash(TEN, "c".repeat(64))?.identity.nectar, "n1");
  assert.equal(bridge.listLatestVersions(TEN).length, 1);
  await bridge.whenFlushed();
});

test("store-bridge: hydrate seeds the mirror so seq continues from the persisted state", async () => {
  const seed: LatestVersion[] = [{ identity: identity("n7"), version: version("n7", 4, "src/x.ts") }];
  const { store } = recorderStore({ seed });
  const bridge = new StoreBridge({ durable: store });

  await bridge.hydrate(TEN);
  assert.equal(bridge.getIdentity("n7")?.nectar, "n7", "the identity was hydrated into the mirror");
  assert.equal(bridge.nextSeq("n7"), 5, "nextSeq continues from the hydrated MAX(seq)=4");
  assert.equal(bridge.listLatestVersions(TEN).length, 1);
});

test("store-bridge: a failed durable flush is surfaced, not swallowed, and does not poison later writes (AC-018b.4)", async () => {
  const surfaced: Array<{ op: string; msg: string }> = [];
  // Fail exactly the seq-0 append for n1; every other write must still land.
  const { store, ops } = recorderStore({ failOn: (op, arg) => op === "appendVersion" && arg === "n1#0" });
  const bridge = new StoreBridge({
    durable: store,
    onFlushError: (err, op) => surfaced.push({ op, msg: err instanceof Error ? err.message : String(err) }),
  });

  // The synchronous writes must never throw even though a durable flush will fail.
  bridge.insertIdentity(identity("n1"));
  bridge.appendVersion(version("n1", 0, "src/a.ts")); // durable flush rejects
  bridge.appendVersion(version("n1", 1, "src/a.ts", "z".repeat(64))); // still flushes

  await bridge.whenFlushed(); // resolves (does not hang or throw) despite the failure

  assert.equal(bridge.durableFlushFailures, 1, "the failure was counted");
  assert.equal(surfaced.length, 1, "onFlushError was called exactly once");
  assert.equal(surfaced[0]!.op, "appendVersion", "the failing write kind was surfaced");
  assert.ok(bridge.lastFlushError instanceof Error, "the error object is retained");
  // The mirror (source of truth) still has the row; later durable writes landed.
  assert.equal(bridge.latestVersion("n1")?.seq, 1, "the mirror kept the write despite the durable failure");
  assert.deepEqual(ops, ["insertIdentity:n1", "appendVersion:n1#1"], "the good writes flushed; only the injected one failed");
  assert.equal(bridge.pendingDurableWrites, 0);
});

// ── CodeRabbit PR-18 finding #8 (layer a): park later writes for a nectar whose identity insert failed durably ──

test("store-bridge: a later appendVersion for a nectar whose durable insertIdentity failed is parked, never producing a durable orphan version", async () => {
  const surfaced: string[] = [];
  const { store, ops } = recorderStore({ failOn: (op) => op === "insertIdentity" });
  const bridge = new StoreBridge({
    durable: store,
    onFlushError: (err, op) => surfaced.push(op),
  });

  // The ladder-shaped mint sequence: insertIdentity (fails durably), then
  // appendVersion for the SAME nectar (must never reach the durable store -
  // that would orphan hive_graph_versions with no matching hive_graph row).
  bridge.insertIdentity(identity("orphan-1"));
  bridge.appendVersion(version("orphan-1", 0, "src/a.ts"));
  bridge.touchIdentity("orphan-1", NOW);

  await bridge.whenFlushed();

  assert.deepEqual(ops, [], "the durable store never received ANY write for the failed-identity nectar");
  assert.deepEqual(surfaced, ["insertIdentity", "appendVersion", "touchIdentity"], "every write for the nectar surfaced a failure, in order");
  assert.equal(bridge.durableFlushFailures, 3, "the original failure plus the two parked writes all count");
  // The mirror (source of truth for the sync ladder) is unaffected - the
  // synchronous side of the bridge never observes the durable-layer problem.
  assert.equal(bridge.latestVersion("orphan-1")?.seq, 0, "the mirror still has the row (the ladder never blocks on this)");
});

test("store-bridge: an UNRELATED nectar's writes are unaffected by another nectar's failed identity insert", async () => {
  const { store, ops } = recorderStore({ failOn: (op, arg) => op === "insertIdentity" && arg === "n1" });
  const bridge = new StoreBridge({ durable: store });

  bridge.insertIdentity(identity("n1")); // fails durably
  bridge.appendVersion(version("n1", 0, "src/a.ts")); // parked
  bridge.insertIdentity(identity("n2")); // unrelated, must flush normally
  bridge.appendVersion(version("n2", 0, "src/b.ts"));

  await bridge.whenFlushed();

  assert.deepEqual(ops, ["insertIdentity:n2", "appendVersion:n2#0"], "n2's writes flushed normally; n1's were parked");
});

test("store-bridge: deleteNectar clears the failed-identity tracking so the nectar id is not marked forever", async () => {
  const { store, ops } = recorderStore({ failOn: (op) => op === "insertIdentity" });
  const bridge = new StoreBridge({ durable: store });

  bridge.insertIdentity(identity("n1")); // fails durably
  bridge.deleteNectar(TEN, "n1"); // the nectar is gone; nothing left to orphan

  await bridge.whenFlushed();

  assert.deepEqual(ops, ["deleteNectar:n1"], "the delete itself flushed (it is not parked)");
});
