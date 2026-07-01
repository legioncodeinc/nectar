import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";
import { runPrune, findPruneCandidates, PRUNE_GRACE_MS } from "../dist/registration/prune-cli.js";
import { reassociate } from "../dist/registration/ladder.js";

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";
const nowMs = Date.parse(NOW);
const daysAgo = (n: number) => new Date(nowMs - n * 24 * 60 * 60 * 1000).toISOString();

function mint(store: InMemorySourceGraphStore, relPath: string, lastUpdate: string): string {
  const r = reassociate(
    { relPath, sizeBytes: 3, mtimeObserved: NOW, readContent: () => "abc" },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  store.touchIdentity(r.nectar, lastUpdate);
  return r.nectar;
}

test("prune: bare command previews and deletes nothing (AC-19)", () => {
  const store = new InMemorySourceGraphStore();
  const gone = mint(store, "old.ts", daysAgo(40));
  const out: string[] = [];
  const result = runPrune({
    store,
    tenancy: TEN,
    existsOnDisk: () => false, // old.ts is gone from disk
    now: () => NOW,
    confirm: false,
    out: (l) => out.push(l),
  });
  assert.equal(result.deleted, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(store.getIdentity(gone) !== undefined, true, "preview must NOT delete");
  assert.ok(out.some((l) => l.includes("--confirm")), "preview points at the confirm flag");
});

test("prune --confirm is the sole deletion path (AC-19)", () => {
  const store = new InMemorySourceGraphStore();
  const gone = mint(store, "old.ts", daysAgo(40));
  const out: string[] = [];
  const result = runPrune({
    store,
    tenancy: TEN,
    existsOnDisk: () => false,
    now: () => NOW,
    confirm: true,
    out: (l) => out.push(l),
  });
  assert.equal(result.deleted, 1);
  assert.equal(store.getIdentity(gone), undefined, "confirm deletes the nectar");
});

test("prune: grace-period boundary only prunes files missing longer than the grace (AC-19)", () => {
  const store = new InMemorySourceGraphStore();
  const recentMissing = mint(store, "recent.ts", daysAgo(10)); // missing but young
  const oldMissing = mint(store, "old.ts", daysAgo(40)); // missing and old
  const present = mint(store, "present.ts", daysAgo(90)); // old but still on disk

  const candidates = findPruneCandidates({
    store,
    tenancy: TEN,
    existsOnDisk: (p) => p === "present.ts",
    now: () => NOW,
    graceMs: PRUNE_GRACE_MS, // 30 days
    out: () => {},
  });

  const nectars = candidates.map((c) => c.nectar);
  assert.deepEqual(nectars, [oldMissing], "only the file missing beyond 30 days is a candidate");
  assert.ok(!nectars.includes(recentMissing));
  assert.ok(!nectars.includes(present));
});

test("prune: a present file is never a candidate even if old", () => {
  const store = new InMemorySourceGraphStore();
  mint(store, "present.ts", daysAgo(365));
  const candidates = findPruneCandidates({
    store,
    tenancy: TEN,
    existsOnDisk: () => true,
    now: () => NOW,
    out: () => {},
  });
  assert.equal(candidates.length, 0);
});
