import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";
import { InMemoryPendingReviewStore, type PendingReviewCandidate } from "../dist/registration/review-store.js";
import { runReviewMatches, type ReviewDecision } from "../dist/registration/review-cli.js";
import { reassociate } from "../dist/registration/ladder.js";
import { sha256Hex } from "../dist/source-graph/hash.js";

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

function seedMissingNectar(store: InMemorySourceGraphStore): string {
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
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
