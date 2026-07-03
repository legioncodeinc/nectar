import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timer } from "../dist/poll-loop.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { reassociate, carryNectar, type LadderDeps, type ObservedFile } from "../dist/registration/ladder.js";
import { runReviewMatches } from "../dist/registration/review-cli.js";
import { InMemoryPendingReviewStore, type PendingReviewCandidate } from "../dist/registration/review-store.js";
import { runPrune, findPruneCandidates } from "../dist/registration/prune-cli.js";
import { WatchIntake } from "../dist/registration/fs-watch.js";
import { RegistrationService, type RegistrationFs } from "../dist/registration/service.js";
import { isSafeRelPath, containedPath, realpathContained } from "../dist/registration/paths-safe.js";
import { createDiskRegistrationFs } from "../dist/registration/disk-fs.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";

const TEN_A = { orgId: "o1", workspaceId: "w1", projectId: "pA" };
const TEN_B = { orgId: "o1", workspaceId: "w1", projectId: "pB" };
const NOW = "2026-07-01T00:00:00.000Z";

function obs(relPath: string, content: string, mtime = NOW): ObservedFile {
  return { relPath, sizeBytes: content.length, mtimeObserved: mtime, readContent: () => content };
}
function deps(store: InMemoryHiveGraphStore, tenancy: typeof TEN_A, onDisk: Set<string>): LadderDeps {
  return { store, tenancy, now: () => NOW, existsOnDisk: (p) => onDisk.has(p) };
}

// ---------------------------------------------------------------------------
// Medium 1: tenancy enforcement on delete / carry / accept / prune (AC-20)
// ---------------------------------------------------------------------------

test("deleteNectar refuses a cross-tenancy delete and applies an in-tenancy one", () => {
  const store = new InMemoryHiveGraphStore();
  const r = reassociate(obs("src/a.ts", "x"), deps(store, TEN_A, new Set(["src/a.ts"])));

  store.deleteNectar(TEN_B, r.nectar); // wrong project
  assert.ok(store.getIdentity(r.nectar), "a cross-tenancy delete is a no-op");

  store.deleteNectar(TEN_A, r.nectar); // correct project
  assert.equal(store.getIdentity(r.nectar), undefined, "the in-tenancy delete applies");
});

test("carryNectar refuses a cross-tenancy source (no version appended)", () => {
  const store = new InMemoryHiveGraphStore();
  const src = reassociate(obs("src/a.ts", "moved"), deps(store, TEN_A, new Set(["src/a.ts"])));

  const carried = carryNectar(
    store,
    TEN_B, // asking as a different project
    NOW,
    src.nectar,
    { relPath: "src/b.ts", contentHash: sha256Hex("moved"), sizeBytes: 5, mtimeObserved: NOW },
    null,
  );
  assert.equal(carried, false, "carry across a project boundary is refused");
  assert.equal(store.latestVersion(src.nectar)?.path, "src/a.ts", "the source nectar was not moved");
});

test("review accept refuses a candidate outside the deps tenancy (AC-20)", async () => {
  const store = new InMemoryHiveGraphStore();
  const src = reassociate(obs("src/a.ts", "alpha"), deps(store, TEN_A, new Set(["src/a.ts"])));
  const pending = new InMemoryPendingReviewStore();
  const candidate: PendingReviewCandidate = {
    id: "c1",
    candidateNectar: src.nectar,
    newPath: "src/b.ts",
    confidence: 0.6,
    distance: 100,
    contentHash: sha256Hex("alpha-edited"),
    sizeBytes: 12,
    mtimeObserved: NOW,
    mintedNectar: "MINTEDNECTAR0000000000000A",
    createdAt: NOW,
  };
  pending.add(candidate);

  const result = await runReviewMatches({
    store,
    tenancy: TEN_B, // reviewing under the wrong project
    pendingReviews: pending,
    now: () => NOW,
    out: () => {},
    decide: () => "accept",
  });

  assert.equal(result.accepted, 0, "an out-of-scope accept is refused");
  assert.equal(result.staleDropped, 1);
  assert.equal(store.latestVersion(src.nectar)?.path, "src/a.ts", "the nectar was not carried across the boundary");
});

test("prune scopes its candidates and deletes to a single tenancy", () => {
  const store = new InMemoryHiveGraphStore();
  const a = reassociate(obs("a.ts", "aa"), deps(store, TEN_A, new Set(["a.ts"])));
  const b = reassociate(obs("b.ts", "bb"), deps(store, TEN_B, new Set(["b.ts"])));
  const old = new Date(Date.parse(NOW) - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.touchIdentity(a.nectar, old);
  store.touchIdentity(b.nectar, old);

  const candidatesA = findPruneCandidates({ store, tenancy: TEN_A, existsOnDisk: () => false, now: () => NOW, out: () => {} });
  assert.deepEqual(candidatesA.map((c) => c.nectar), [a.nectar], "only project A's nectar is a candidate for A");

  runPrune({ store, tenancy: TEN_A, existsOnDisk: () => false, now: () => NOW, confirm: true, out: () => {} });
  assert.equal(store.getIdentity(a.nectar), undefined, "A's nectar is pruned");
  assert.ok(store.getIdentity(b.nectar), "B's nectar is untouched by A's prune");
});

// ---------------------------------------------------------------------------
// Medium 2: workspace path containment (CWE-22)
// ---------------------------------------------------------------------------

test("isSafeRelPath rejects traversal, absolute, and drive paths", () => {
  assert.equal(isSafeRelPath("src/a.ts"), true);
  assert.equal(isSafeRelPath("../a.ts"), false);
  assert.equal(isSafeRelPath("src/../../a.ts"), false);
  assert.equal(isSafeRelPath("/etc/passwd"), false);
  assert.equal(isSafeRelPath("C:/Windows/system32"), false);
  assert.equal(isSafeRelPath("C:\\Windows"), false);
  assert.equal(isSafeRelPath(""), false);
});

test("containedPath rejects escapes and resolves safe paths under the root", () => {
  const root = process.cwd();
  assert.equal(containedPath(root, "../outside.ts"), null);
  assert.equal(containedPath(root, "/abs/path.ts"), null);
  const inside = containedPath(root, "src/a.ts");
  assert.ok(inside !== null && inside.startsWith(root));
});

test("realpathContained resolves an inside file and rejects a symlink escape", () => {
  const workspace = mkdtempSync(join(tmpdir(), "hn-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "hn-out-"));
  try {
    writeFileSync(join(workspace, "inside.txt"), "safe");
    writeFileSync(join(outside, "secret.txt"), "secret");

    assert.ok(realpathContained(workspace, "inside.txt"), "an inside file resolves");
    assert.equal(realpathContained(workspace, "../escape.txt"), null, "a traversal is rejected");
    assert.equal(realpathContained(workspace, "missing.txt"), null, "a nonexistent path is rejected");

    let symlinked = true;
    try {
      symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
    } catch {
      symlinked = false; // some platforms (Windows without privilege) cannot create symlinks
    }
    if (symlinked) {
      assert.equal(realpathContained(workspace, "link.txt"), null, "a symlink escaping the root is rejected");
      const fs = createDiskRegistrationFs(workspace);
      assert.equal(fs.statPath("link.txt"), null, "the disk FS refuses to stat an escaping symlink");
      assert.equal(fs.existsOnDisk("link.txt"), false);
      assert.ok(fs.statPath("inside.txt"), "the disk FS stats an inside file");
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("createDiskRegistrationFs refuses traversal and absolute paths without reading disk", () => {
  const workspace = mkdtempSync(join(tmpdir(), "hn-ws2-"));
  try {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.ts"), "hello");
    const fs = createDiskRegistrationFs(workspace);
    assert.ok(fs.statPath("src/a.ts"), "an inside file is stat-able");
    assert.equal(fs.statPath("../../etc/passwd"), null, "traversal is refused");
    assert.equal(fs.statPath("/etc/passwd"), null, "an absolute path is refused");
    const listed = [...fs.listPaths()];
    assert.deepEqual(listed, ["src/a.ts"], "listPaths yields only safe repo-relative paths");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("intake drops traversal/absolute observations before scheduling (CWE-22)", () => {
  let seq = 0;
  const jobs = new Map<number, () => void>();
  const timer: Timer = {
    set(fn) { const id = ++seq; jobs.set(id, fn); return id; },
    clear(handle) { jobs.delete(handle as number); },
  };
  const fired: string[] = [];
  const intake = new WatchIntake({ root: "/x", timer, onPathChanged: (p) => fired.push(p) });
  intake.observe("../escape.ts");
  intake.observe("/etc/passwd");
  assert.equal(jobs.size, 0, "unsafe observations schedule no debounce timer");
  intake.observe("src/ok.ts");
  // A safe observation schedules its debounce timer plus its max-wait cap
  // (AC-018l.16); the unsafe ones above still scheduled nothing.
  assert.equal(jobs.size, 2, "a safe observation schedules a debounce timer and a max-wait cap");
});

test("service drops an unsafe resync path before any persist (CWE-22)", async () => {
  const store = new InMemoryHiveGraphStore();
  const files = new Map<string, string>([
    ["../evil.ts", "payload"],
    ["src/ok.ts", "fine"],
  ]);
  const fs: RegistrationFs = {
    statPath: (rel) => {
      const c = files.get(rel);
      return c === undefined ? null : { sizeBytes: c.length, mtimeObserved: NOW, readContent: () => c };
    },
    existsOnDisk: (rel) => files.has(rel),
    listPaths: () => files.keys(),
  };
  const logs: Record<string, unknown>[] = [];
  let seq = 0;
  const jobs = new Map<number, () => void>();
  const timer: Timer = {
    set(fn) { const id = ++seq; jobs.set(id, fn); return id; },
    clear(handle) { jobs.delete(handle as number); },
  };
  const svc = new RegistrationService({
    store, tenancy: TEN_A, fs, root: "/x", timer, now: () => NOW, log: (l) => logs.push(l),
  });

  svc.requestResync();
  for (const fn of [...jobs.values()]) fn();
  jobs.clear();
  await svc._waitForIdle();

  assert.equal(store.listLatestVersions(TEN_A).length, 1, "only the safe path is registered");
  assert.equal(store.latestVersionByPath(TEN_A, "src/ok.ts")?.identity.nectar !== undefined, true);
  assert.ok(logs.some((l) => l["msg"] === "dropped unsafe path" && l["relPath"] === "../evil.ts"));
});
