import { test } from "node:test";
import assert from "node:assert/strict";
import type { Timer } from "../dist/poll-loop.js";
import { WatchIntake } from "../dist/registration/fs-watch.js";
import { classifyPath } from "../dist/registration/classify.js";
import { classifyNewFile } from "../dist/registration/copy-detect.js";
import { reassociate, type LadderDeps, type ObservedFile } from "../dist/registration/ladder.js";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";
import { sha256Hex } from "../dist/source-graph/hash.js";

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

// --- fs-watch debounce ---

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
  return { timer, pending: () => jobs.size, fireAll() { for (const fn of [...jobs.values()]) fn(); jobs.clear(); } };
}

test("watch intake collapses a burst on one path to a single signal", () => {
  const mt = manualTimer();
  const fired: string[] = [];
  const intake = new WatchIntake({ root: "/x", timer: mt.timer, onPathChanged: (p) => fired.push(p) });
  intake.observe("src/a.ts");
  intake.observe("src/a.ts");
  intake.observe("src/a.ts");
  assert.equal(mt.pending(), 1, "three events on one path leave one pending timer");
  mt.fireAll();
  assert.deepEqual(fired, ["src/a.ts"], "one collapsed signal");
});

test("watch intake keeps distinct paths separate and normalizes slashes", () => {
  const mt = manualTimer();
  const fired: string[] = [];
  const intake = new WatchIntake({ root: "/x", timer: mt.timer, onPathChanged: (p) => fired.push(p) });
  intake.observe("src\\a.ts");
  intake.observe("src/b.ts");
  assert.equal(mt.pending(), 2);
  mt.fireAll();
  assert.deepEqual(fired.sort(), ["src/a.ts", "src/b.ts"]);
});

// --- classify ---

test("classifyPath returns new/changed/missing and null for nothing-to-do", () => {
  const known = new Set(["src/known.ts"]);
  assert.equal(classifyPath({ relPath: "src/new.ts", existsOnDisk: true }, known)?.kind, "new-path");
  assert.equal(classifyPath({ relPath: "src/known.ts", existsOnDisk: true }, known)?.kind, "changed-path");
  assert.equal(classifyPath({ relPath: "src/known.ts", existsOnDisk: false }, known)?.kind, "missing-path");
  assert.equal(classifyPath({ relPath: "src/ghost.ts", existsOnDisk: false }, known), null);
});

// --- ladder helpers ---

function obs(relPath: string, content: string, mtime = NOW): ObservedFile {
  return { relPath, sizeBytes: content.length, mtimeObserved: mtime, readContent: () => content };
}

function deps(store: InMemorySourceGraphStore, onDisk: Set<string>, extra: Partial<LadderDeps> = {}): LadderDeps {
  return {
    store,
    tenancy: TEN,
    now: () => NOW,
    existsOnDisk: (p) => onDisk.has(p),
    ...extra,
  };
}

// --- ladder: the five steps ---

test("step 5: a genuinely new file mints a fresh nectar", () => {
  const store = new InMemorySourceGraphStore();
  const r = reassociate(obs("src/a.ts", "hello"), deps(store, new Set(["src/a.ts"])));
  assert.equal(r.step, 5);
  assert.equal(r.action, "mint");
  assert.equal(store.latestVersion(r.nectar)?.path, "src/a.ts");
  assert.equal(store.latestVersion(r.nectar)?.contentHash, sha256Hex("hello"));
});

test("step 1: same path + mtime + size is a no-op and never reads content", () => {
  const store = new InMemorySourceGraphStore();
  const first = reassociate(obs("src/a.ts", "hello"), deps(store, new Set(["src/a.ts"])));
  // Re-observe with the same mtime/size; readContent must not be called.
  const file: ObservedFile = {
    relPath: "src/a.ts",
    sizeBytes: "hello".length,
    mtimeObserved: NOW,
    readContent: () => { throw new Error("step 1 must not read content"); },
  };
  const r = reassociate(file, deps(store, new Set(["src/a.ts"])));
  assert.equal(r.step, 1);
  assert.equal(r.action, "noop");
  assert.equal(r.nectar, first.nectar);
});

test("step 2: same path, changed content appends a version under the same nectar", () => {
  const store = new InMemorySourceGraphStore();
  const first = reassociate(obs("src/a.ts", "v1"), deps(store, new Set(["src/a.ts"])));
  const enriched: string[] = [];
  const r = reassociate(
    obs("src/a.ts", "v2-different", "2026-07-01T01:00:00.000Z"),
    deps(store, new Set(["src/a.ts"]), { onEnrichQueued: (n) => enriched.push(n) }),
  );
  assert.equal(r.step, 2);
  assert.equal(r.action, "append-version");
  assert.equal(r.nectar, first.nectar, "same nectar");
  assert.equal(store.latestVersion(r.nectar)?.contentHash, sha256Hex("v2-different"));
  assert.equal(store.latestVersion(r.nectar)?.seq, 1);
  assert.deepEqual(enriched, [first.nectar], "edit enqueues enrichment");
});

test("step 3: exact-hash match to a missing file carries the nectar (move)", () => {
  const store = new InMemorySourceGraphStore();
  const first = reassociate(obs("src/a.ts", "moved-content"), deps(store, new Set(["src/a.ts"])));
  // a.ts is gone; the same content appears at b.ts.
  const r = reassociate(obs("src/b.ts", "moved-content"), deps(store, new Set(["src/b.ts"])));
  assert.equal(r.step, 3);
  assert.equal(r.action, "carry-nectar");
  assert.equal(r.nectar, first.nectar, "same nectar carried to the new path");
  assert.equal(store.latestVersion(first.nectar)?.path, "src/b.ts");
});

test("step 5 copy: same content while the source still exists mints with provenance", () => {
  const store = new InMemorySourceGraphStore();
  const src = reassociate(obs("src/a.ts", "boiler"), deps(store, new Set(["src/a.ts"])));
  // a.ts still on disk; b.ts is a copy of it.
  const r = reassociate(obs("src/b.ts", "boiler"), deps(store, new Set(["src/a.ts", "src/b.ts"])));
  assert.equal(r.step, 5);
  assert.equal(r.action, "copy");
  assert.notEqual(r.nectar, src.nectar, "copy gets its own nectar");
  const id = store.getIdentity(r.nectar);
  assert.equal(id?.derivedFromNectar, src.nectar, "provenance back to the source");
  assert.equal(id?.forkContentHash, sha256Hex("boiler"));
});

test("step 4: a low-confidence fuzzy candidate is surfaced for review, then mints", () => {
  const store = new InMemorySourceGraphStore();
  const orig = reassociate(obs("src/a.ts", "the original content here"), deps(store, new Set(["src/a.ts"])));
  const reviews: Array<{ nectar: string; confidence: number }> = [];
  // a.ts is gone; a moved+edited file appears (no exact hash match). Fuzzy says "review".
  const r = reassociate(
    obs("src/b.ts", "the original content here, edited"),
    deps(store, new Set(["src/b.ts"]), {
      fuzzy: { match: () => ({ kind: "review", nectar: orig.nectar, confidence: 0.4 }) },
      onReviewNeeded: (c) => reviews.push({ nectar: c.nectar, confidence: c.confidence }),
    }),
  );
  assert.equal(reviews.length, 1, "surfaced for review, not auto-claimed");
  assert.equal(r.step, 5, "falls through to mint");
  assert.equal(r.action, "mint");
  assert.notEqual(r.nectar, orig.nectar);
});

test("step 4: a high-confidence fuzzy match carries the nectar and stamps confidence", () => {
  const store = new InMemorySourceGraphStore();
  const orig = reassociate(obs("src/a.ts", "content alpha beta"), deps(store, new Set(["src/a.ts"])));
  const r = reassociate(
    obs("src/b.ts", "content alpha beta gamma"),
    deps(store, new Set(["src/b.ts"]), {
      fuzzy: { match: (_c, cands) => ({ kind: "match", nectar: cands[0]!.identity.nectar, confidence: 0.92 }) },
    }),
  );
  assert.equal(r.step, 4);
  assert.equal(r.action, "carry-nectar");
  assert.equal(r.nectar, orig.nectar);
  assert.equal(store.latestVersion(orig.nectar)?.confidence, 0.92, "confidence stamped on the carried row");
});

test("deliberate gap: with NO fuzzy step injected, an edited+moved file mints (step 4 skipped)", () => {
  const store = new InMemorySourceGraphStore();
  reassociate(obs("src/a.ts", "aaaa original"), deps(store, new Set(["src/a.ts"])));
  const r = reassociate(obs("src/b.ts", "aaaa original but edited"), deps(store, new Set(["src/b.ts"])));
  assert.equal(r.step, 5, "no fuzzy matcher -> no step 4 -> mint");
  assert.equal(r.action, "mint");
});

// --- copy-detect (unit) ---

test("classifyNewFile returns mint when no hash matches, copy when a latest hash matches", () => {
  const store = new InMemorySourceGraphStore();
  assert.equal(classifyNewFile(store, TEN, sha256Hex("x")).action, "mint");
  reassociate(obs("src/a.ts", "shared"), deps(store, new Set(["src/a.ts"])));
  const d = classifyNewFile(store, TEN, sha256Hex("shared"));
  assert.equal(d.action, "copy");
});
