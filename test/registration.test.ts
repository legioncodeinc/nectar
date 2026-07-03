import { test } from "node:test";
import assert from "node:assert/strict";
import type { Timer } from "../dist/poll-loop.js";
import { WatchIntake } from "../dist/registration/fs-watch.js";
import { classifyPath } from "../dist/registration/classify.js";
import { classifyNewFile } from "../dist/registration/copy-detect.js";
import {
  createInMemoryStatCache,
  reassociate,
  repairLadderState,
  type LadderDeps,
  type ObservedFile,
} from "../dist/registration/ladder.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import type { HiveGraphStore } from "../dist/hive-graph/store.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { findPruneCandidates } from "../dist/registration/prune-cli.js";

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
  // One debounce timer (reset per observation) + one max-wait cap timer (armed
  // once per burst, AC-018l.16) = two pending timers for the one active path.
  assert.equal(mt.pending(), 2, "one path holds a debounce timer plus its max-wait cap");
  mt.fireAll();
  assert.deepEqual(fired, ["src/a.ts"], "one collapsed signal");
});

test("watch intake keeps distinct paths separate and normalizes slashes", () => {
  const mt = manualTimer();
  const fired: string[] = [];
  const intake = new WatchIntake({ root: "/x", timer: mt.timer, onPathChanged: (p) => fired.push(p) });
  intake.observe("src\\a.ts");
  intake.observe("src/b.ts");
  // Two distinct paths, each holding a debounce + a max-wait cap timer.
  assert.equal(mt.pending(), 4);
  mt.fireAll();
  assert.deepEqual(fired.sort(), ["src/a.ts", "src/b.ts"]);
});

/** A virtual-clock timer: `advance(ms)` fires every job whose deadline has elapsed, in time order. */
function clockTimer() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { fn: () => void; at: number }>();
  const timer: Timer = {
    set(fn, ms) {
      const id = ++seq;
      jobs.set(id, { fn, at: now + (ms ?? 0) });
      return id;
    },
    clear(handle) {
      jobs.delete(handle as number);
    },
  };
  return {
    timer,
    advance(ms: number) {
      now += ms;
      for (;;) {
        let dueId: number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, job] of jobs) {
          if (job.at <= now && job.at < dueAt) {
            dueAt = job.at;
            dueId = id;
          }
        }
        if (dueId === undefined) break;
        const job = jobs.get(dueId);
        jobs.delete(dueId);
        job?.fn();
      }
    },
    pending: () => jobs.size,
  };
}

test("AC-018l.16 a path written faster than the debounce still settles at the max-wait cap (NEC-042 item 9)", () => {
  const ct = clockTimer();
  const fired: string[] = [];
  const intake = new WatchIntake({
    root: "/x",
    timer: ct.timer,
    debounceMs: 100,
    maxWaitMs: 1000,
    onPathChanged: (p) => fired.push(p),
  });
  // Observe every 50ms (< the 100ms debounce), so the debounce is reset before it
  // can ever elapse - the pre-fix behavior where the path NEVER settles.
  for (let t = 0; t < 1000; t += 50) {
    intake.observe("src/hot.ts");
    ct.advance(50);
  }
  // The max-wait cap (armed once at the first observation, at t=1000) forces the
  // change through despite the never-settling debounce.
  assert.deepEqual(fired, ["src/hot.ts"], "the max-wait cap fired exactly one settle");

  // No lingering timers keep re-firing after the cap settled.
  ct.advance(5000);
  assert.deepEqual(fired, ["src/hot.ts"], "the settle fired exactly once, not repeatedly");
});

test("watch intake without continuous events still settles via the normal debounce", () => {
  const ct = clockTimer();
  const fired: string[] = [];
  const intake = new WatchIntake({ root: "/x", timer: ct.timer, debounceMs: 100, maxWaitMs: 1000, onPathChanged: (p) => fired.push(p) });
  intake.observe("src/a.ts");
  ct.advance(100); // the debounce elapses well before the cap
  assert.deepEqual(fired, ["src/a.ts"], "a quiet path settles at the debounce window, not the cap");
});

// --- classify ---

test("classifyPath returns new/changed/missing and null for nothing-to-do", () => {
  const known = new Set(["src/known.ts"]);
  assert.equal(classifyPath({ relPath: "src/new.ts", existsOnDisk: true }, known)?.kind, "new-path");
  assert.equal(classifyPath({ relPath: "src/known.ts", existsOnDisk: true }, known)?.kind, "changed-path");
  assert.equal(classifyPath({ relPath: "src/known.ts", existsOnDisk: false }, known)?.kind, "missing-path");
  assert.equal(classifyPath({ relPath: "src/ghost.ts", existsOnDisk: false }, known), null);
});

test("AC-018c.8 classifyPath's optional fold makes the known-lookup case-insensitive while the returned relPath keeps the observed casing", () => {
  const known = new Set(["src/known.ts".toLowerCase()]); // the caller pre-folds knownPaths' entries
  const fold = (p: string) => p.toLowerCase();
  const result = classifyPath({ relPath: "src/Known.ts", existsOnDisk: true }, known, fold);
  assert.equal(result?.kind, "changed-path", "the fold makes this resolve as known despite the casing difference");
  assert.equal(result?.relPath, "src/Known.ts", "the returned path preserves the OBSERVED (real on-disk) casing");
  // Without a fold (the default), the same input is unknown - identity is the default.
  const noFold = classifyPath({ relPath: "src/Known.ts", existsOnDisk: true }, known);
  assert.equal(noFold?.kind, "new-path", "case-sensitive behavior is unchanged by default");
});

// --- ladder helpers ---

function obs(relPath: string, content: string, mtime = NOW): ObservedFile {
  return { relPath, sizeBytes: content.length, mtimeObserved: mtime, readContent: () => content };
}

function deps(store: InMemoryHiveGraphStore, onDisk: Set<string>, extra: Partial<LadderDeps> = {}): LadderDeps {
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
  const store = new InMemoryHiveGraphStore();
  const r = reassociate(obs("src/a.ts", "hello"), deps(store, new Set(["src/a.ts"])));
  assert.equal(r.step, 5);
  assert.equal(r.action, "mint");
  assert.equal(store.latestVersion(r.nectar)?.path, "src/a.ts");
  assert.equal(store.latestVersion(r.nectar)?.contentHash, sha256Hex("hello"));
});

test("step 1: same path + mtime + size is a no-op and never reads content", () => {
  const store = new InMemoryHiveGraphStore();
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
  const store = new InMemoryHiveGraphStore();
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
  const store = new InMemoryHiveGraphStore();
  const first = reassociate(obs("src/a.ts", "moved-content"), deps(store, new Set(["src/a.ts"])));
  // a.ts is gone; the same content appears at b.ts.
  const r = reassociate(obs("src/b.ts", "moved-content"), deps(store, new Set(["src/b.ts"])));
  assert.equal(r.step, 3);
  assert.equal(r.action, "carry-nectar");
  assert.equal(r.nectar, first.nectar, "same nectar carried to the new path");
  assert.equal(store.latestVersion(first.nectar)?.path, "src/b.ts");
});

test("step 5 copy: same content while the source still exists mints with provenance", () => {
  const store = new InMemoryHiveGraphStore();
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
  const store = new InMemoryHiveGraphStore();
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
  const store = new InMemoryHiveGraphStore();
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
  const store = new InMemoryHiveGraphStore();
  reassociate(obs("src/a.ts", "aaaa original"), deps(store, new Set(["src/a.ts"])));
  const r = reassociate(obs("src/b.ts", "aaaa original but edited"), deps(store, new Set(["src/b.ts"])));
  assert.equal(r.step, 5, "no fuzzy matcher -> no step 4 -> mint");
  assert.equal(r.action, "mint");
});

// --- PRD-018c NEC-035 / AC-018c.9: the step-2 fast-path stat cache ---

test("AC-018c.9 a step-2 identical-content touch refreshes the cached stat so the NEXT observation takes step 1 without re-hashing", () => {
  const store = new InMemoryHiveGraphStore();
  const statCache = createInMemoryStatCache();
  const first = reassociate(obs("src/a.ts", "stable content"), deps(store, new Set(["src/a.ts"]), { statCache }));
  assert.equal(first.step, 5);

  // A touch: identical content, a different mtime (e.g. a branch-switch bump).
  const TOUCHED_MTIME = "2026-07-01T02:00:00.000Z";
  const touch = reassociate(
    obs("src/a.ts", "stable content", TOUCHED_MTIME),
    deps(store, new Set(["src/a.ts"]), { statCache }),
  );
  assert.equal(touch.step, 2);
  assert.equal(touch.action, "noop");

  // The version ROW itself is never rewritten (still carries the ORIGINAL
  // mtime), so a naive step-1 comparison against it would still miss and
  // re-hash. With the cache, the next observation at the SAME touched
  // mtime/size takes the step-1 fast path and never reads content.
  const noRead: ObservedFile = {
    relPath: "src/a.ts",
    sizeBytes: "stable content".length,
    mtimeObserved: TOUCHED_MTIME,
    readContent: () => {
      throw new Error("step 1 must not read content");
    },
  };
  const second = reassociate(noRead, deps(store, new Set(["src/a.ts"]), { statCache }));
  assert.equal(second.step, 1, "the cached stat let this observation take the step-1 fast path");
  assert.equal(second.action, "noop");
  assert.equal(second.nectar, first.nectar);
});

test("AC-018c.9 without an injected statCache, behavior is unchanged from pre-018c: a touch keeps re-hashing", () => {
  const store = new InMemoryHiveGraphStore();
  const first = reassociate(obs("src/a.ts", "stable content"), deps(store, new Set(["src/a.ts"])));
  const TOUCHED_MTIME = "2026-07-01T02:00:00.000Z";
  reassociate(obs("src/a.ts", "stable content", TOUCHED_MTIME), deps(store, new Set(["src/a.ts"])));
  const again = reassociate(obs("src/a.ts", "stable content", TOUCHED_MTIME), deps(store, new Set(["src/a.ts"])));
  assert.equal(again.step, 2, "no cache injected -> step 1 still misses on the untouched version row's stale mtime");
  assert.equal(again.nectar, first.nectar);
});

test("AC-018c.9 a real content edit clears any stale cached stat so the fresh version row's own stat stays authoritative", () => {
  const store = new InMemoryHiveGraphStore();
  const statCache = createInMemoryStatCache();
  const first = reassociate(obs("src/a.ts", "v1"), deps(store, new Set(["src/a.ts"]), { statCache }));
  const TOUCHED_MTIME = "2026-07-01T02:00:00.000Z";
  reassociate(obs("src/a.ts", "v1", TOUCHED_MTIME), deps(store, new Set(["src/a.ts"]), { statCache })); // caches TOUCHED_MTIME

  const EDIT_MTIME = "2026-07-01T03:00:00.000Z";
  const edited = reassociate(
    obs("src/a.ts", "v2-different-content", EDIT_MTIME),
    deps(store, new Set(["src/a.ts"]), { statCache }),
  );
  assert.equal(edited.step, 2);
  assert.equal(edited.action, "append-version");
  assert.equal(edited.nectar, first.nectar);

  // Re-observing at the STALE pre-edit touched mtime (impossible on a real
  // disk post-edit, but it proves the stale cache entry was cleared rather
  // than shadowing the fresh version row's own, now-correct, mtime).
  const staleCheck = reassociate(
    obs("src/a.ts", "v2-different-content", TOUCHED_MTIME),
    deps(store, new Set(["src/a.ts"]), { statCache }),
  );
  assert.notEqual(staleCheck.step, 1, "the stale pre-edit cache entry no longer shadows the fresh version row");
});

// --- PRD-018c NEC-034 / AC-018c.8: case-insensitive-filesystem rename detection ---

test("AC-018c.8 on a case-insensitive workspace, a case-only rename carries the nectar instead of minting a copy", () => {
  const store = new InMemoryHiveGraphStore();
  const original = reassociate(obs("Foo.ts", "shared boiler content"), deps(store, new Set(["Foo.ts"])));

  // The OS resolves "Foo.ts" to the file that is now actually named "foo.ts" -
  // existsOnDisk("Foo.ts") naively returns true (the exact NEC-034 bug), but
  // the case-only-rename guard fires regardless of that.
  const renamed = reassociate(
    obs("foo.ts", "shared boiler content"),
    deps(store, new Set(["foo.ts"]), { existsOnDisk: (p) => p === "Foo.ts", caseInsensitive: true }),
  );
  assert.equal(renamed.step, 3);
  assert.equal(renamed.action, "carry-nectar");
  assert.equal(renamed.nectar, original.nectar, "the SAME nectar is carried, not a fresh mint");
  assert.equal(store.latestVersion(original.nectar)?.path, "foo.ts", "the stored row preserves the fresh on-disk casing");
  assert.equal(store.listLatestVersions(TEN).length, 1, "no duplicate nectar was minted");
});

test("AC-018c.8 regression: on a case-SENSITIVE workspace, the identical scenario still mints a copy (pre-018c behavior unchanged)", () => {
  const store = new InMemoryHiveGraphStore();
  const original = reassociate(obs("Foo.ts", "shared boiler content"), deps(store, new Set(["Foo.ts"])));
  const copied = reassociate(
    obs("foo.ts", "shared boiler content"),
    deps(store, new Set(["Foo.ts", "foo.ts"]), { existsOnDisk: (p) => p === "Foo.ts" }), // caseInsensitive omitted -> false
  );
  assert.equal(copied.step, 5);
  assert.equal(copied.action, "copy");
  assert.notEqual(copied.nectar, original.nectar);
});

// --- PRD-018c EX-4 (change-detection review M7): the injected missing-paths set ---

test("EX-4 step 4's candidate scan uses the injected missingPaths set instead of an existsOnDisk stat per candidate", () => {
  const store = new InMemoryHiveGraphStore();
  reassociate(obs("src/a.ts", "content A"), deps(store, new Set(["src/a.ts"])));
  reassociate(obs("src/b.ts", "content B"), deps(store, new Set(["src/b.ts"])));
  reassociate(obs("src/c.ts", "content C"), deps(store, new Set(["src/c.ts"])));

  let existsOnDiskCalls = 0;
  const missingPaths = new Set(["src/a.ts", "src/b.ts"]); // c.ts stays "on disk"
  const r = reassociate(obs("src/new.ts", "unrelated new content"), {
    store,
    tenancy: TEN,
    now: () => NOW,
    existsOnDisk: (p) => {
      existsOnDiskCalls += 1;
      return p === "src/c.ts";
    },
    fuzzy: {
      match: (_content, candidates) => {
        assert.deepEqual(
          candidates.map((c) => c.version.path).sort(),
          ["src/a.ts", "src/b.ts"],
          "only the injected missingPaths entries are offered as fuzzy candidates",
        );
        return { kind: "none" };
      },
    },
    missingPaths,
  });
  assert.equal(r.step, 5, "no fuzzy match -> mint");
  assert.equal(existsOnDiskCalls, 0, "missingPaths eliminates the per-candidate existsOnDisk stat entirely");
});

test("EX-4 without an injected missingPaths set, behavior is unchanged: step 4 falls back to a per-candidate existsOnDisk stat", () => {
  const store = new InMemoryHiveGraphStore();
  reassociate(obs("src/a.ts", "content A"), deps(store, new Set(["src/a.ts"])));
  let existsOnDiskCalls = 0;
  reassociate(obs("src/new.ts", "unrelated new content"), {
    store,
    tenancy: TEN,
    now: () => NOW,
    existsOnDisk: (p) => {
      existsOnDiskCalls += 1;
      return p !== "src/a.ts";
    },
    fuzzy: { match: () => ({ kind: "none" }) },
  });
  assert.ok(existsOnDiskCalls > 0, "the pre-018c per-candidate existsOnDisk path still runs when missingPaths is omitted");
});

// --- copy-detect (unit) ---

test("classifyNewFile returns mint when no hash matches, copy when a latest hash matches", () => {
  const store = new InMemoryHiveGraphStore();
  assert.equal(classifyNewFile(store, TEN, sha256Hex("x")).action, "mint");
  reassociate(obs("src/a.ts", "shared"), deps(store, new Set(["src/a.ts"])));
  const d = classifyNewFile(store, TEN, sha256Hex("shared"));
  assert.equal(d.action, "copy");
});

// --- PRD-018d / NEC-036: crash-injected multi-write ladder actions + repair sweep (AC-018d.4) ---

/**
 * Wraps a real store and throws right after the delegated call named
 * `crashAfterCall` completes - simulating "this write landed on disk, then the
 * process died before the next one." Every other method delegates straight
 * through, so the underlying store's real state is what a genuine crash would
 * leave behind.
 */
function crashAfter(store: HiveGraphStore, crashAfterCall: "insertIdentity" | "appendVersion"): HiveGraphStore {
  return {
    insertIdentity(row) {
      store.insertIdentity(row);
      if (crashAfterCall === "insertIdentity") throw new Error("simulated crash after insertIdentity");
    },
    getIdentity: (nectar) => store.getIdentity(nectar),
    touchIdentity: (nectar, lastUpdateDate) => store.touchIdentity(nectar, lastUpdateDate),
    appendVersion(row) {
      store.appendVersion(row);
      if (crashAfterCall === "appendVersion") throw new Error("simulated crash after appendVersion");
    },
    nextSeq: (nectar) => store.nextSeq(nectar),
    latestVersion: (nectar) => store.latestVersion(nectar),
    listLatestVersions: (t) => store.listLatestVersions(t),
    listLatestDescribedVersions: (t) => store.listLatestDescribedVersions(t),
    latestVersionByPath: (t, p) => store.latestVersionByPath(t, p),
    latestVersionByHash: (t, h) => store.latestVersionByHash(t, h),
    deleteNectar: (t, nectar) => store.deleteNectar(t, nectar),
    listIdentities: (t) => store.listIdentities!(t),
  };
}

test("AC-018d.4: a crash between mint's insertIdentity and appendVersion leaves an orphan identity that the sweep heals", () => {
  const store = new InMemoryHiveGraphStore();
  const crashing = crashAfter(store, "insertIdentity");
  const mintDeps: LadderDeps = { store: crashing, tenancy: TEN, now: () => NOW, existsOnDisk: () => true };
  assert.throws(() => reassociate(obs("src/a.ts", "hello"), mintDeps));

  // The crash's residue: an identity row with zero version rows.
  const orphans = store.listIdentities(TEN);
  assert.equal(orphans.length, 1, "insertIdentity landed before the crash");
  assert.equal(store.latestVersion(orphans[0]!.nectar), undefined, "appendVersion never ran");

  const report = repairLadderState(store, TEN);
  assert.equal(report.healedOrphanIdentities, 1);
  assert.equal(store.listIdentities(TEN).length, 0, "the orphan is gone");
  assert.equal(store.listLatestVersions(TEN).length, 0, "nothing spurious was left registered");

  // Idempotent: running the sweep again on the healed store finds nothing to do.
  const second = repairLadderState(store, TEN);
  assert.deepEqual(second, { healedOrphanIdentities: 0, healedStaleLastUpdate: 0, healedDuplicatePaths: 0 });
});

test("AC-018d.4: a crash between an edit's appendVersion and touchIdentity leaves a stale identity.lastUpdateDate that the sweep heals", () => {
  const store = new InMemoryHiveGraphStore();
  const MINT_TIME = "2025-01-01T00:00:00.000Z";
  const EDIT_TIME = "2026-06-16T00:00:00.000Z";
  const NOW_CHECK = "2026-07-01T00:00:00.000Z"; // ~15 days after EDIT_TIME, ~181 days after MINT_TIME

  const mintDeps: LadderDeps = { store, tenancy: TEN, now: () => MINT_TIME, existsOnDisk: () => true };
  const first = reassociate(obs("src/a.ts", "v1", MINT_TIME), mintDeps);

  const crashing = crashAfter(store, "appendVersion");
  const editDeps: LadderDeps = { store: crashing, tenancy: TEN, now: () => EDIT_TIME, existsOnDisk: () => true };
  assert.throws(() => reassociate(obs("src/a.ts", "v2-different", EDIT_TIME), editDeps));

  // The crash's residue: the new version row landed, but touchIdentity never ran.
  const staleVersion = store.latestVersion(first.nectar);
  assert.equal(staleVersion?.contentHash, sha256Hex("v2-different"), "appendVersion landed");
  assert.equal(store.getIdentity(first.nectar)?.lastUpdateDate, MINT_TIME, "touchIdentity did not run: identity predates its own latest version");

  // Using the UNHEALED (stale) identity.lastUpdateDate, prune (with the file
  // now missing) would wrongly treat this as missing for ~181 days -> eligible.
  const staleCandidates = findPruneCandidates({
    store,
    tenancy: TEN,
    existsOnDisk: () => false,
    now: () => NOW_CHECK,
    out: () => {},
  });
  assert.ok(staleCandidates.some((c) => c.nectar === first.nectar), "unhealed state wrongly makes this prune-eligible");

  const report = repairLadderState(store, TEN);
  assert.equal(report.healedStaleLastUpdate, 1);
  assert.equal(store.getIdentity(first.nectar)?.lastUpdateDate, EDIT_TIME, "identity caught up to its latest version");

  // AC-018d.4: prune eligibility is computed only from the healed state - the
  // real edit was only ~15 days ago, well inside the grace period.
  const healedCandidates = findPruneCandidates({
    store,
    tenancy: TEN,
    existsOnDisk: () => false,
    now: () => NOW_CHECK,
    out: () => {},
  });
  assert.ok(!healedCandidates.some((c) => c.nectar === first.nectar), "healed state correctly is NOT prune-eligible");

  const second = repairLadderState(store, TEN);
  assert.deepEqual(second, { healedOrphanIdentities: 0, healedStaleLastUpdate: 0, healedDuplicatePaths: 0 }, "idempotent");
});
