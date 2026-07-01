import { test } from "node:test";
import assert from "node:assert/strict";
import type { Timer } from "../dist/poll-loop.js";
import { RegistrationService, type RegistrationFs } from "../dist/registration/service.js";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";
import { InMemoryPendingReviewStore } from "../dist/registration/review-store.js";
import { createTlshFuzzyStep } from "../dist/registration/tlsh.js";
import { reassociate, type LadderDeps, type ObservedFile } from "../dist/registration/ladder.js";

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
    fireAll() {
      for (const fn of [...jobs.values()]) fn();
      jobs.clear();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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

function obsFile(relPath: string, content: string, mtime = NOW): ObservedFile {
  return { relPath, sizeBytes: content.length, mtimeObserved: mtime, readContent: () => content };
}

test("step 4 reads the PERSISTED fingerprint from the version row (survives restart, no in-memory cache)", () => {
  const store = new InMemorySourceGraphStore();
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
