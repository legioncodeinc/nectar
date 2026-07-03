import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import type { HiveGraphStore } from "../dist/hive-graph/store.js";
import {
  InMemoryPendingReviewStore,
  FilePendingReviewStore,
  type PendingReviewCandidate,
} from "../dist/registration/review-store.js";
import { runReviewMatches, type ReviewDecision } from "../dist/registration/review-cli.js";
import { reassociate, repairLadderState } from "../dist/registration/ladder.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

function seedMissingNectar(store: InMemoryHiveGraphStore): string {
  const r = reassociate(
    { relPath: "src/a.ts", sizeBytes: 5, mtimeObserved: NOW, readContent: () => "alpha" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  return r.nectar;
}

function candidate(nectar: string): PendingReviewCandidate {
  return {
    id: "cand-1",
    candidateNectar: nectar,
    newPath: "src/b.ts",
    confidence: 0.62,
    distance: 120,
    contentHash: sha256Hex("alpha-edited"),
    sizeBytes: 12,
    mtimeObserved: NOW,
    mintedNectar: "MINTEDNECTARPLACEHOLDER0001",
    createdAt: NOW,
  };
}

test("review-matches: empty queue prints nothing-to-review", async () => {
  const store = new InMemoryHiveGraphStore();
  const out: string[] = [];
  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: new InMemoryPendingReviewStore(),
    now: () => NOW,
    out: (l) => out.push(l),
    decide: () => "skip" as ReviewDecision,
  });
  assert.deepEqual(result, { accepted: 0, rejected: 0, skipped: 0, staleDropped: 0 });
  assert.ok(out.some((l) => l.includes("No pending matches")));
});

test("review-matches: accept carries the candidate nectar to the new path (AC-18)", async () => {
  const store = new InMemoryHiveGraphStore();
  const nectar = seedMissingNectar(store);
  const pending = new InMemoryPendingReviewStore();
  pending.add(candidate(nectar));
  const enriched: string[] = [];
  const out: string[] = [];

  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: pending,
    now: () => NOW,
    out: (l) => out.push(l),
    decide: () => "accept",
    onEnrichQueued: (n) => enriched.push(n),
  });

  assert.equal(result.accepted, 1);
  assert.equal(pending.list().length, 0, "the resolved candidate is removed");
  assert.equal(store.latestVersionByPath(TEN, "src/b.ts")?.identity.nectar, nectar, "nectar carried to the new path");
  assert.deepEqual(enriched, [nectar], "an enrich job is queued for the carried nectar");
  assert.ok(out.some((l) => l.includes("0.620")), "the preview shows the confidence");
});

test("review-matches: reject leaves the new path minted fresh and the missing entry (AC-18)", async () => {
  const store = new InMemoryHiveGraphStore();
  const nectar = seedMissingNectar(store);
  const pending = new InMemoryPendingReviewStore();
  pending.add(candidate(nectar));
  const out: string[] = [];

  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: pending,
    now: () => NOW,
    out: (l) => out.push(l),
    decide: () => "reject",
  });

  assert.equal(result.rejected, 1);
  assert.equal(pending.list().length, 0, "the candidate is dropped from the queue");
  assert.equal(store.latestVersionByPath(TEN, "src/a.ts")?.identity.nectar, nectar, "the missing entry's nectar is untouched");
  assert.equal(store.latestVersionByPath(TEN, "src/b.ts"), undefined, "the candidate nectar was NOT carried to b.ts");
});

test("review-matches: accept of a vanished candidate nectar drops the stale review", async () => {
  const store = new InMemoryHiveGraphStore();
  const pending = new InMemoryPendingReviewStore();
  pending.add(candidate("NECTARTHATDOESNOTEXIST00001"));

  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: pending,
    now: () => NOW,
    out: () => {},
    decide: () => "accept",
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.staleDropped, 1);
  assert.equal(pending.list().length, 0);
});

// --- PRD-018d / NEC-036: crash-injected review-accept + repair sweep (AC-018d.5) ---

/** Delegates every HiveGraphStore method straight through except `deleteNectar`, which always throws. */
function crashOnDelete(store: HiveGraphStore): HiveGraphStore {
  return {
    insertIdentity: (row) => store.insertIdentity(row),
    getIdentity: (nectar) => store.getIdentity(nectar),
    touchIdentity: (nectar, lastUpdateDate) => store.touchIdentity(nectar, lastUpdateDate),
    appendVersion: (row) => store.appendVersion(row),
    nextSeq: (nectar) => store.nextSeq(nectar),
    latestVersion: (nectar) => store.latestVersion(nectar),
    listLatestVersions: (t) => store.listLatestVersions(t),
    listLatestDescribedVersions: (t) => store.listLatestDescribedVersions(t),
    latestVersionByPath: (t, p) => store.latestVersionByPath(t, p),
    latestVersionByHash: (t, h) => store.latestVersionByHash(t, h),
    deleteNectar: () => {
      throw new Error("simulated crash before the placeholder delete");
    },
    listIdentities: (t) => store.listIdentities!(t),
  };
}

test("AC-018d.5: a crash between the carry and the placeholder delete leaves two identities on one path; the sweep converges to one", async () => {
  const store = new InMemoryHiveGraphStore();
  // The missing nectar being re-associated (M), and the placeholder fresh mint
  // that was minted for newPath when the review was originally raised (P).
  const missing = reassociate(
    { relPath: "src/a.ts", sizeBytes: 5, mtimeObserved: NOW, readContent: () => "alpha" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  const placeholder = reassociate(
    { relPath: "src/b.ts", sizeBytes: 12, mtimeObserved: NOW, readContent: () => "alpha-edited" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  assert.notEqual(missing.nectar, placeholder.nectar);

  const pending = new InMemoryPendingReviewStore();
  pending.add({
    id: "cand-crash-1",
    candidateNectar: missing.nectar,
    newPath: "src/b.ts",
    confidence: 0.62,
    distance: 120,
    contentHash: sha256Hex("alpha-edited"),
    sizeBytes: 12,
    mtimeObserved: NOW,
    mintedNectar: placeholder.nectar,
    createdAt: NOW,
  });

  const crashing = crashOnDelete(store);
  await assert.rejects(
    runReviewMatches({
      store: crashing,
      tenancy: TEN,
      pendingReviews: pending,
      now: () => NOW,
      out: () => {},
      decide: () => "accept",
    }),
  );

  // The crash's residue: the carry landed (M's latest version is now at
  // src/b.ts too), but the placeholder delete never ran - two identities both
  // claim src/b.ts as their latest version's path.
  const claimants = store.listLatestVersions(TEN).filter((lv) => lv.version.path === "src/b.ts");
  assert.equal(claimants.length, 2, "both the carried nectar and the undeleted placeholder claim src/b.ts");

  const report = repairLadderState(store, TEN);
  assert.equal(report.healedDuplicatePaths, 1);
  assert.equal(store.getIdentity(placeholder.nectar), undefined, "the review-minted placeholder is gone");
  assert.equal(
    store.latestVersionByPath(TEN, "src/b.ts")?.identity.nectar,
    missing.nectar,
    "exactly one identity (the carried one) points at the accepted path",
  );
  assert.equal(store.listLatestVersions(TEN).filter((lv) => lv.version.path === "src/b.ts").length, 1);
});

// --- PRD-018d / NEC-036: FilePendingReviewStore concurrency + dedupe (AC-018d.6/.7) ---

const REVIEW_STORE_MODULE_URL = new URL("../dist/registration/review-store.js", import.meta.url).href;

function fixtureCandidate(id: string): PendingReviewCandidate {
  return {
    id,
    candidateNectar: `NECTAR-${id}`,
    newPath: `src/${id}.ts`,
    confidence: 0.5,
    distance: 10,
    contentHash: `hash-${id}`,
    sizeBytes: 10,
    mtimeObserved: NOW,
    mintedNectar: "MINTEDNECTARPLACEHOLDER0001",
    createdAt: NOW,
  };
}

function concurrencyWorkerScript(mode: "add" | "remove", filePath: string, ids: readonly string[]): string {
  const candidates = ids.map((id) => fixtureCandidate(id));
  return `
import { FilePendingReviewStore } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};
const store = new FilePendingReviewStore(${JSON.stringify(filePath)});
const mode = ${JSON.stringify(mode)};
const candidates = ${JSON.stringify(candidates)};
if (mode === "add") {
  for (const c of candidates) store.add(c);
} else {
  for (const c of candidates) store.remove(c.id);
}
`;
}

function runNodeScript(script: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker script exited ${code}: ${stderr}`));
      else resolvePromise();
    });
  });
}

test("AC-018d.6: a concurrent daemon add() and CLI remove() against the same file both land, with no lost update in either direction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-review-store-"));
  const filePath = join(dir, "pending-reviews.json");
  try {
    const seedStore = new FilePendingReviewStore(filePath);
    const toRemove = Array.from({ length: 10 }, (_, i) => `preexisting-${i}`);
    for (const id of toRemove) seedStore.add(fixtureCandidate(id));

    const toAdd = Array.from({ length: 10 }, (_, i) => `fresh-${i}`);

    // Two REAL, concurrently-running OS processes hammering the same file:
    // exactly the daemon-add()-races-CLI-remove() scenario the store's own
    // docstring names as its intended two-writer use case.
    await Promise.all([
      runNodeScript(concurrencyWorkerScript("remove", filePath, toRemove)),
      runNodeScript(concurrencyWorkerScript("add", filePath, toAdd)),
    ]);

    const finalIds = new FilePendingReviewStore(filePath)
      .list()
      .map((c) => c.id)
      .sort();
    assert.deepEqual(
      finalIds,
      [...toAdd].sort(),
      "every fresh candidate landed and every pre-existing one was removed - no lost update either way",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-018d.7: re-observing the same (candidateNectar, newPath) refreshes the pending entry in place instead of growing the queue", () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-review-store-"));
  const filePath = join(dir, "pending-reviews.json");
  try {
    const store = new FilePendingReviewStore(filePath);
    const first = candidate("NECTAR-DUP");
    store.add({ ...first, id: "review-1", confidence: 0.6 });
    store.add({ ...first, id: "review-2", confidence: 0.75 }); // re-observed with a fresher confidence

    const items = store.list();
    assert.equal(items.length, 1, "the queue does not grow per re-observation of one path");
    assert.equal(items[0]!.confidence, 0.75, "the metadata was refreshed in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-018d.7 (in-memory store): the same dedupe/replace-by-tuple behavior", () => {
  const store = new InMemoryPendingReviewStore();
  const first = candidate("NECTAR-DUP");
  store.add({ ...first, id: "review-1", confidence: 0.6 });
  store.add({ ...first, id: "review-2", confidence: 0.75 });

  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "review-2");
  assert.equal(items[0]!.confidence, 0.75);
});

// --- PRD-018d / NEC-036: stale accept resolves as stale, no outdated metadata carried (AC-018d.8) ---

test("AC-018d.8: accepting a candidate whose target content changed since it was queued resolves as stale", async () => {
  const store = new InMemoryHiveGraphStore();
  const missing = reassociate(
    { relPath: "src/a.ts", sizeBytes: 5, mtimeObserved: NOW, readContent: () => "alpha" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  // The fresh mint at review-raise time, at the ORIGINAL queued content.
  const placeholder = reassociate(
    { relPath: "src/b.ts", sizeBytes: 12, mtimeObserved: NOW, readContent: () => "alpha-edited" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  const queuedHash = sha256Hex("alpha-edited");

  // The file at src/b.ts changed AGAIN before the operator got to the review
  // (a step-2 edit onto the SAME placeholder identity, keyed by path).
  const LATER = "2026-07-01T01:00:00.000Z";
  reassociate(
    { relPath: "src/b.ts", sizeBytes: 20, mtimeObserved: LATER, readContent: () => "alpha-edited-again" },
    { store, tenancy: TEN, now: () => LATER, existsOnDisk: () => true },
  );

  const pending = new InMemoryPendingReviewStore();
  pending.add({
    id: "cand-stale-1",
    candidateNectar: missing.nectar,
    newPath: "src/b.ts",
    confidence: 0.62,
    distance: 120,
    contentHash: queuedHash, // the OLD hash recorded when the review was queued
    sizeBytes: 12,
    mtimeObserved: NOW,
    mintedNectar: placeholder.nectar,
    createdAt: NOW,
  });

  const out: string[] = [];
  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: pending,
    now: () => LATER,
    out: (l) => out.push(l),
    decide: () => "accept",
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.staleDropped, 1, "the accept resolved as stale, not a carry");
  assert.ok(out.some((l) => l.includes("stale")));
  assert.equal(pending.list().length, 0, "the stale entry was dropped, not left pending");
  // No carry happened: src/b.ts is still owned by the placeholder identity,
  // now on its own latest (re-edited) content - never overwritten with the
  // queued (now outdated) hash/mtime metadata.
  assert.equal(store.latestVersionByPath(TEN, "src/b.ts")?.identity.nectar, placeholder.nectar);
  assert.equal(store.latestVersionByPath(TEN, "src/b.ts")?.version.contentHash, sha256Hex("alpha-edited-again"));
});

test("AC-018d.8: a still-fresh candidate (unchanged since queued) still accepts normally", async () => {
  const store = new InMemoryHiveGraphStore();
  const missing = reassociate(
    { relPath: "src/a.ts", sizeBytes: 5, mtimeObserved: NOW, readContent: () => "alpha" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  const placeholder = reassociate(
    { relPath: "src/b.ts", sizeBytes: 12, mtimeObserved: NOW, readContent: () => "alpha-edited" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  const pending = new InMemoryPendingReviewStore();
  pending.add({
    id: "cand-fresh-1",
    candidateNectar: missing.nectar,
    newPath: "src/b.ts",
    confidence: 0.62,
    distance: 120,
    contentHash: sha256Hex("alpha-edited"), // matches the placeholder's CURRENT latest content
    sizeBytes: 12,
    mtimeObserved: NOW,
    mintedNectar: placeholder.nectar,
    createdAt: NOW,
  });

  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: pending,
    now: () => NOW,
    out: () => {},
    decide: () => "accept",
  });

  assert.equal(result.accepted, 1);
  assert.equal(result.staleDropped, 0);
  assert.equal(store.latestVersionByPath(TEN, "src/b.ts")?.identity.nectar, missing.nectar, "the carry succeeded");
});
