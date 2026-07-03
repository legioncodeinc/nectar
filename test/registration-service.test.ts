import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Timer } from "../dist/poll-loop.js";
import { RegistrationService, type RegistrationFs } from "../dist/registration/service.js";
import type { WatchFn } from "../dist/registration/fs-watch.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { StoreBridge } from "../dist/registration/store-bridge.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";
import { InMemoryPendingReviewStore } from "../dist/registration/review-store.js";
import { createTlshFuzzyStep } from "../dist/registration/tlsh.js";
import { reassociate, type LadderDeps, type ObservedFile } from "../dist/registration/ladder.js";

/** Wrap a sync in-memory store as the async durable seam, so the bridge can flush to it. */
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

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

function manualTimer() {
  let seq = 0;
  const jobs = new Map<number, () => void>();
  const timer: Timer = {
    set(fn) {
      const id = ++seq;
      jobs.set(id, fn);
      return id;
    },
    clear(handle) {
      jobs.delete(handle as number);
    },
  };
  return {
    timer,
    pending: () => jobs.size,
    /**
     * Fires every job that was PENDING at the moment `fireAll()` was called.
     * Deletes each snapshotted entry by id BEFORE running it, so a job that
     * schedules a NEW follow-up job while firing (PRD-018c's watcher restart
     * scheduling a resync, or a restart scheduling the next backoff attempt)
     * leaves that follow-up pending for the NEXT `fireAll()` call, instead of
     * being wiped by a trailing `jobs.clear()`.
     */
    fireAll() {
      const toRun = [...jobs.entries()];
      for (const [id] of toRun) jobs.delete(id);
      for (const [, fn] of toRun) fn();
    },
  };
}

type FileEntry = { content: string; mtime?: string };

function memFs(files: Map<string, FileEntry>, opts: { throwOn?: string } = {}): RegistrationFs {
  return {
    statPath(rel) {
      if (opts.throwOn === rel) throw new Error(`stat failed for ${rel}`);
      const f = files.get(rel);
      if (f === undefined) return null;
      return {
        sizeBytes: Buffer.byteLength(f.content, "utf8"),
        mtimeObserved: f.mtime ?? NOW,
        readContent: () => f.content,
      };
    },
    existsOnDisk: (rel) => files.has(rel),
    listPaths: () => files.keys(),
  };
}

test("service: a settled burst mints and drains via _waitForIdle (AC-4)", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([
    ["src/a.ts", { content: "aaa" }],
    ["src/b.ts", { content: "bbb" }],
  ]);
  const mt = manualTimer();
  const svc = new RegistrationService({ store, tenancy: TEN, fs: memFs(files), root: "/x", timer: mt.timer, now: () => NOW });
  svc.observe("src/a.ts");
  svc.observe("src/b.ts");
  mt.fireAll();
  await svc._waitForIdle();
  assert.equal(store.listLatestVersions(TEN).length, 2, "both files registered in one drained cycle");
});

test("service: a per-path failure is isolated and the cycle continues (AC-4)", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["good.ts", { content: "ok" }]]);
  const logs: Record<string, unknown>[] = [];
  const mt = manualTimer();
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files, { throwOn: "bad.ts" }),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  svc.observe("bad.ts");
  svc.observe("good.ts");
  mt.fireAll();
  await svc._waitForIdle(); // must not throw

  assert.equal(store.listLatestVersions(TEN).length, 1, "the good path still registered");
  assert.equal(store.latestVersionByPath(TEN, "good.ts")?.version.contentHash !== undefined, true);
  assert.ok(
    logs.some((l) => l["scope"] === "registration.cycle" && l["relPath"] === "bad.ts"),
    "the failing path was logged and skipped",
  );
});

test("service: a rename reconstructs a move end-to-end through step 3 (AC-9)", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["src/a.ts", { content: "moved-content" }]]);
  const mt = manualTimer();
  const svc = new RegistrationService({ store, tenancy: TEN, fs: memFs(files), root: "/x", timer: mt.timer, now: () => NOW });

  svc.observe("src/a.ts");
  mt.fireAll();
  await svc._waitForIdle();
  const nectar = store.latestVersionByPath(TEN, "src/a.ts")?.identity.nectar;
  assert.ok(nectar, "a.ts was registered first");

  // Rename a.ts -> b.ts: a.ts is now gone from disk, b.ts appears with the same content.
  files.delete("src/a.ts");
  files.set("src/b.ts", { content: "moved-content" });
  svc.observe("src/a.ts");
  svc.observe("src/b.ts");
  mt.fireAll();
  await svc._waitForIdle();

  assert.equal(store.latestVersionByPath(TEN, "src/b.ts")?.identity.nectar, nectar, "same nectar carried to the new path");
  assert.equal(store.latestVersionByPath(TEN, "src/a.ts"), undefined, "old path no longer a latest path");
  assert.equal(store.listLatestVersions(TEN).length, 1, "no new nectar minted for the move");
});

test("service: a null-filename observation triggers a full resync settle (AC-3)", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([
    ["src/a.ts", { content: "aaa" }],
    ["src/c.ts", { content: "ccc" }],
  ]);
  const mt = manualTimer();
  const svc = new RegistrationService({ store, tenancy: TEN, fs: memFs(files), root: "/x", timer: mt.timer, now: () => NOW });

  svc.observeRaw(null); // platform emitted a directory-level event with no filename
  mt.fireAll();
  await svc._waitForIdle();

  assert.equal(store.listLatestVersions(TEN).length, 2, "the full resync scanned and registered every disk path");
});

test("service: ignored paths never trigger a cycle (AC-5)", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([
    ["node_modules/x.ts", { content: "dep" }],
    ["src/a.ts", { content: "aaa" }],
  ]);
  const mt = manualTimer();
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    isIgnored: (p) => p.startsWith("node_modules/"),
  });

  svc.observe("node_modules/x.ts");
  assert.equal(mt.pending(), 0, "an ignored observation schedules no debounce timer");
  svc.observe("src/a.ts");
  mt.fireAll();
  await svc._waitForIdle();

  assert.equal(store.listLatestVersions(TEN).length, 1, "only the non-ignored path registered");
  assert.equal(store.latestVersionByPath(TEN, "src/a.ts")?.identity.nectar !== undefined, true);
});

test("service: step 4 low-confidence match is queued for review, not auto-claimed", async () => {
  const store = new InMemoryHiveGraphStore();
  const pendingReviews = new InMemoryPendingReviewStore();
  const original = "the original body of a moderately sized source file ".repeat(4);
  const files = new Map<string, FileEntry>([["src/a.ts", { content: original }]]);
  const mt = manualTimer();
  // A wide review band and a very high carry floor so a near-duplicate lands in "review".
  const fuzzy = createTlshFuzzyStep({ highConfidence: 0.999, reviewFloor: 0.4 });
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    fuzzy,
    pendingReviews,
  });

  svc.observe("src/a.ts");
  mt.fireAll();
  await svc._waitForIdle();

  // a.ts gone; a moved+edited near-duplicate appears at b.ts (no exact hash match).
  files.delete("src/a.ts");
  files.set("src/b.ts", { content: `${original}plus a small trailing edit` });
  svc.observe("src/a.ts");
  svc.observe("src/b.ts");
  mt.fireAll();
  await svc._waitForIdle();

  const queued = pendingReviews.list();
  assert.equal(queued.length, 1, "a low-confidence candidate was surfaced for review");
  assert.equal(queued[0]!.newPath, "src/b.ts");
  assert.ok(queued[0]!.mintedNectar.length > 0, "the new path was minted fresh at review time");
});

const LATER = "2026-07-03T04:00:00.000Z";

test("service: cold catch-up on boot reconciles offline edit/move/delete through the resync bridge (AC-018b.5)", async () => {
  const inner = new InMemoryHiveGraphStore();
  const durable = asyncWrap(inner);

  // Phase 1: a prior daemon registered four files; seed the DURABLE store through the bridge.
  const files = new Map<string, FileEntry>([
    ["src/keep.ts", { content: "keep me unchanged forever" }],
    ["src/edit.ts", { content: "the original body of the edited file" }],
    ["src/movesrc.ts", { content: "content that will move to a new path" }],
    ["src/del.ts", { content: "a file that will be deleted offline" }],
  ]);
  const bridge1 = new StoreBridge({ durable });
  await bridge1.hydrate(TEN);
  const mt1 = manualTimer();
  const svc1 = new RegistrationService({ store: bridge1, tenancy: TEN, fs: memFs(files), root: "/x", timer: mt1.timer, now: () => NOW });
  svc1.requestResync();
  mt1.fireAll();
  await svc1._waitForIdle();
  await bridge1.whenFlushed();
  assert.equal(inner.listLatestVersions(TEN).length, 4, "four nectars seeded durably");
  const editNectar = inner.latestVersionByPath(TEN, "src/edit.ts")!.identity.nectar;
  const moveNectar = inner.latestVersionByPath(TEN, "src/movesrc.ts")!.identity.nectar;

  // Phase 2: the daemon is DOWN. Offline mutations happen on disk (edit, move, delete).
  files.set("src/edit.ts", { content: "the original body of the edited file, plus an offline edit", mtime: LATER });
  files.delete("src/movesrc.ts");
  files.set("src/movedst.ts", { content: "content that will move to a new path" });
  files.delete("src/del.ts");

  // Phase 3: BOOT. A fresh bridge over the SAME durable store; hydrate + one resync.
  const bridge2 = new StoreBridge({ durable });
  await bridge2.hydrate(TEN);
  let resyncs = 0;
  const mt2 = manualTimer();
  const svc2 = new RegistrationService({
    store: bridge2,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt2.timer,
    now: () => LATER,
    onResyncRequested: () => {
      resyncs += 1;
    },
  });
  svc2.requestResync();
  assert.equal(resyncs, 1, "the cold-catch-up resync was requested exactly once on boot");
  mt2.fireAll();
  await svc2._waitForIdle();
  await bridge2.whenFlushed();

  // edit: a new version row appended to the SAME nectar (edit reconciled).
  const editLatest = inner.latestVersionByPath(TEN, "src/edit.ts")!;
  assert.equal(editLatest.identity.nectar, editNectar, "edit stayed on the same nectar");
  assert.ok(editLatest.version.seq >= 1, "edit appended a new version row");
  // move: the nectar was carried to the new path; the old path is no longer latest.
  assert.equal(inner.latestVersionByPath(TEN, "src/movedst.ts")!.identity.nectar, moveNectar, "move carried the nectar");
  assert.equal(inner.latestVersionByPath(TEN, "src/movesrc.ts"), undefined, "the old move path is no longer a latest path");
  // delete: the nectar is NOT removed (only prune --confirm deletes) but its path is now missing on disk.
  assert.equal(inner.listLatestVersions(TEN).length, 4, "still four nectars (move reused a nectar; delete removed none)");
  const delLv = inner.listLatestVersions(TEN).find((lv) => lv.version.path === "src/del.ts");
  assert.ok(delLv !== undefined, "the deleted file's nectar remains (now a prune candidate, path missing on disk)");
});

function obsFile(relPath: string, content: string, mtime = NOW): ObservedFile {
  return { relPath, sizeBytes: content.length, mtimeObserved: mtime, readContent: () => content };
}

test("step 4 reads the PERSISTED fingerprint from the version row (survives restart, no in-memory cache)", () => {
  const store = new InMemoryHiveGraphStore();
  const original = "the original body of a source file that will move and be edited later on";

  // Register src/a.ts: the mint persists the content fingerprint on the version row.
  const first = reassociate(obsFile("src/a.ts", original), {
    store,
    tenancy: TEN,
    now: () => NOW,
    existsOnDisk: (p) => p === "src/a.ts",
  });
  const persisted = store.latestVersion(first.nectar)?.fingerprint ?? null;
  assert.ok(persisted !== null && persisted.startsWith("H1"), "the mint persisted a fingerprint on the version row");

  // "Restart": there is no in-memory fingerprint state anymore. a.ts is now gone;
  // a moved+edited file appears at src/b.ts. The injected fuzzy step must receive
  // the missing candidate's PERSISTED fingerprint (read from version.fingerprint).
  let sawFingerprint: string | null | undefined = undefined;
  const deps: LadderDeps = {
    store,
    tenancy: TEN,
    now: () => NOW,
    existsOnDisk: (p) => p === "src/b.ts", // a.ts is gone
    fuzzy: {
      match: (_content, candidates) => {
        const cand = candidates.find((c) => c.identity.nectar === first.nectar);
        sawFingerprint = cand?.fingerprint ?? null;
        return { kind: "match", nectar: first.nectar, confidence: 0.9 };
      },
    },
  };
  const r = reassociate(obsFile("src/b.ts", `${original} with a small edit`), deps);

  assert.equal(sawFingerprint, persisted, "step 4 received the persisted fingerprint from version.fingerprint");
  assert.equal(r.step, 4);
  assert.equal(r.action, "carry-nectar");
  assert.equal(r.nectar, first.nectar, "the nectar was carried via the persisted-fingerprint match, no cache involved");
});

// --- PRD-018c NEC-008 / AC-018c.5: directory-level events trigger a resync ---

test("AC-018c.5(a) a settled path that currently IS a directory triggers a resync instead of being silently dropped", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["src/a.ts", { content: "aaa" }]]);
  const mt = manualTimer();
  const fsFake: RegistrationFs = { ...memFs(files), isDirectory: (rel) => rel === "src" };
  let resyncs = 0;
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: fsFake,
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    onResyncRequested: () => {
      resyncs += 1;
    },
  });

  svc.observe("src"); // a directory-level watch event reporting the still-existing "src" dir
  mt.fireAll();
  await svc._waitForIdle();

  assert.ok(resyncs >= 1, "the directory event requested a resync instead of being dropped");
  assert.ok(
    store.latestVersionByPath(TEN, "src/a.ts")?.identity.nectar !== undefined,
    "the triggered resync registered the pre-existing file",
  );
});

test("AC-018c.5(b) a directory rename (old name missing, but a PREFIX of known paths) triggers a resync that carries every child to its new path", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["src/identity/login.ts", { content: "login logic" }]]);
  const mt = manualTimer();
  const svc = new RegistrationService({ store, tenancy: TEN, fs: memFs(files), root: "/x", timer: mt.timer, now: () => NOW });

  svc.observe("src/identity/login.ts");
  mt.fireAll();
  await svc._waitForIdle();
  const nectar = store.latestVersionByPath(TEN, "src/identity/login.ts")?.identity.nectar;
  assert.ok(nectar, "the file registered before the rename");

  // `mv src/identity src/auth`: per NEC-008's evidence, only a directory-level
  // event for the OLD name arrives on Linux inotify/macOS FSEvents - no
  // per-child event. `stat("src/identity")` fails (it's gone); it is not
  // itself a known FILE path, but IS a prefix of one.
  files.delete("src/identity/login.ts");
  files.set("src/auth/login.ts", { content: "login logic" });
  svc.observe("src/identity");
  mt.fireAll();
  await svc._waitForIdle();

  assert.equal(
    store.latestVersionByPath(TEN, "src/auth/login.ts")?.identity.nectar,
    nectar,
    "the child was carried to its new path via the triggered resync",
  );
  assert.equal(store.latestVersionByPath(TEN, "src/identity/login.ts"), undefined, "the old path is no longer latest");
  assert.equal(store.listLatestVersions(TEN).length, 1, "no duplicate nectar was minted for the directory rename");
});

// --- PRD-018c NEC-009 / AC-018c.6, AC-018c.7: watcher error, restart-with-backoff, /health state ---

/** A fake raw `fs.watch` constructor: each call either throws (simulating an attach failure) or returns a controllable fake handle. */
function fakeWatchFn() {
  let attachCount = 0;
  let failing = false;
  const instances: (EventEmitter & { close(): void; closed: boolean })[] = [];
  const watchFn: WatchFn = () => {
    attachCount += 1;
    if (failing) throw new Error(`simulated attach failure #${attachCount}`);
    const handle = new EventEmitter() as EventEmitter & { close(): void; closed: boolean };
    handle.closed = false;
    handle.close = () => {
      handle.closed = true;
    };
    instances.push(handle);
    return handle;
  };
  return {
    watchFn,
    instances,
    attachCount: () => attachCount,
    setFailing(v: boolean) {
      failing = v;
    },
  };
}

test("AC-018c.6 a watcher error closes and restarts the watcher with backoff, then requests a resync on successful re-attach", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["src/a.ts", { content: "aaa" }]]);
  const mt = manualTimer();
  const fake = fakeWatchFn();
  const states: string[] = [];
  let resyncs = 0;
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    watchFn: fake.watchFn,
    watcherRestartBackoffFloorMs: 5,
    watcherRestartBackoffCeilingMs: 20,
    maxWatcherRestartAttempts: 3,
    periodicResyncMs: 0,
    onWatcherStateChange: (s) => states.push(s),
    onResyncRequested: () => {
      resyncs += 1;
    },
  });

  svc.start();
  assert.equal(fake.attachCount(), 1);
  assert.deepEqual(states, ["running"]);

  // Simulate a raw fs.watch error (e.g. Linux ENOSPC / a renamed workspace root).
  fake.instances[0]!.emit("error", new Error("ENOSPC"));
  assert.deepEqual(states, ["running", "restarting"], "the watcher backs off instead of dying silently");
  assert.equal(fake.instances[0]!.closed, true, "the dead watcher is closed");

  mt.fireAll(); // fires the backoff-scheduled restart
  assert.equal(fake.attachCount(), 2, "the watcher re-attached");
  assert.deepEqual(states, ["running", "restarting", "running"]);

  mt.fireAll(); // fires the debounced resync the successful re-attach requested (AC-3's mechanism, reused)
  await svc._waitForIdle();
  assert.ok(resyncs >= 1, "a resync was requested on successful re-attach, reconciling the outage window (AC-018c.6)");

  svc.stop();
});

test("AC-018c.7 repeated restart failures park the watcher degraded, and the periodic resync backstop keeps reconciling", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["src/a.ts", { content: "aaa" }]]);
  const mt = manualTimer();
  const fake = fakeWatchFn();
  const states: string[] = [];
  let resyncs = 0;
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    watchFn: fake.watchFn,
    watcherRestartBackoffFloorMs: 5,
    watcherRestartBackoffCeilingMs: 20,
    maxWatcherRestartAttempts: 2,
    periodicResyncMs: 30,
    onWatcherStateChange: (s) => states.push(s),
    onResyncRequested: () => {
      resyncs += 1;
    },
  });

  svc.start();
  assert.equal(fake.attachCount(), 1);

  // The underlying condition never clears: every restart attempt fails outright.
  fake.setFailing(true);
  fake.instances[0]!.emit("error", new Error("ENOSPC")); // attempt 1 -> restarting
  mt.fireAll(); // the restart timer fires; attach() throws -> attempt 2 -> still restarting
  mt.fireAll(); // the next restart timer fires; attach() throws again -> attempt 3 > max(2) -> degraded

  assert.ok(states.includes("degraded"), "repeated restart failures park the watcher degraded, not looping hot");
  assert.equal(states[states.length - 1], "degraded");
  const attachCountAtDegraded = fake.attachCount();

  // AC-018c.7: the periodic resync backstop still runs while degraded.
  const resyncsBeforeBackstop = resyncs;
  mt.fireAll();
  await svc._waitForIdle();
  assert.ok(resyncs > resyncsBeforeBackstop, "the periodic backstop keeps requesting resyncs while the watcher is degraded");
  assert.equal(fake.attachCount(), attachCountAtDegraded, "degraded means no further restart attempt is scheduled");

  svc.stop();
});

// --- PRD-018c NEC-034 / AC-018c.8: case-only rename end to end through the service ---

test("AC-018c.8 service: a case-only rename on a simulated case-insensitive workspace carries the nectar instead of minting a copy", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["Foo.ts", { content: "shared boiler content" }]]);
  const mt = manualTimer();
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    caseInsensitive: true, // override the real probe for a deterministic test
  });

  svc.observe("Foo.ts");
  mt.fireAll();
  await svc._waitForIdle();
  const nectar = store.latestVersionByPath(TEN, "Foo.ts")?.identity.nectar;
  assert.ok(nectar, "the file registered under its original casing");

  // Case-only rename: `mv Foo.ts foo.ts`. The new casing is observed with identical content.
  files.delete("Foo.ts");
  files.set("foo.ts", { content: "shared boiler content" });
  svc.observe("foo.ts");
  mt.fireAll();
  await svc._waitForIdle();

  assert.equal(
    store.latestVersionByPath(TEN, "foo.ts")?.identity.nectar,
    nectar,
    "the SAME nectar was carried to the new casing, not a fresh mint",
  );
  assert.equal(store.listLatestVersions(TEN).length, 1, "no duplicate nectar was minted for the case-only rename");
});

test("AC-018c.8 service regression: on a case-SENSITIVE workspace (the default), the identical rename mints a copy unchanged from pre-018c", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, FileEntry>([["Foo.ts", { content: "shared boiler content" }]]);
  const mt = manualTimer();
  const svc = new RegistrationService({
    store,
    tenancy: TEN,
    fs: memFs(files),
    root: "/x",
    timer: mt.timer,
    now: () => NOW,
    caseInsensitive: false,
  });

  svc.observe("Foo.ts");
  mt.fireAll();
  await svc._waitForIdle();

  // Both casings present simultaneously (legitimate on a case-sensitive fs).
  files.set("foo.ts", { content: "shared boiler content" });
  svc.observe("foo.ts");
  mt.fireAll();
  await svc._waitForIdle();

  assert.equal(store.listLatestVersions(TEN).length, 2, "a distinct nectar was minted (a copy), matching pre-018c behavior");
});
