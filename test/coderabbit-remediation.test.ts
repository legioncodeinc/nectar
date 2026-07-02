import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { reassociate, type LadderDeps, type ObservedFile } from "../dist/registration/ladder.js";
import { runReviewMatches } from "../dist/registration/review-cli.js";
import {
  InMemoryPendingReviewStore,
  FilePendingReviewStore,
  type PendingReviewCandidate,
} from "../dist/registration/review-store.js";
import { runPrune } from "../dist/registration/prune-cli.js";
import { createDefaultIgnore } from "../dist/registration/ignore.js";
import { createTlshFuzzyStep, computeFingerprint, type FuzzyCandidate } from "../dist/registration/tlsh.js";
import { createDiskRegistrationFs } from "../dist/registration/disk-fs.js";
import { DeepLakeHiveGraphStore } from "../dist/hive-graph/deeplake-store.js";
import { TransportError } from "../dist/hive-graph/deeplake-transport.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

function obs(relPath: string, content: string, mtime = NOW): ObservedFile {
  return { relPath, sizeBytes: content.length, mtimeObserved: mtime, readContent: () => content };
}
function deps(store: InMemoryHiveGraphStore, onDisk: Set<string>): LadderDeps {
  return { store, tenancy: TEN, now: () => NOW, existsOnDisk: (p) => onDisk.has(p) };
}
function candidateFrom(store: InMemoryHiveGraphStore, relPath: string, content: string): FuzzyCandidate {
  reassociate(obs(relPath, content), deps(store, new Set([relPath])));
  const lv = store.listLatestVersions(TEN).find((v) => v.version.path === relPath)!;
  return { identity: lv.identity, version: lv.version, fingerprint: computeFingerprint(content) };
}

// Item 1 -----------------------------------------------------------------
test("disk-fs existsOnDisk is true only for files, not directories", () => {
  const ws = mkdtempSync(join(tmpdir(), "hn-cr1-"));
  try {
    mkdirSync(join(ws, "adir"));
    writeFileSync(join(ws, "afile.txt"), "hi");
    const fs = createDiskRegistrationFs(ws);
    assert.equal(fs.existsOnDisk("afile.txt"), true, "a real file exists");
    assert.equal(fs.existsOnDisk("adir"), false, "a directory is not a tracked path");
    assert.equal(fs.statPath("adir"), null, "statPath refuses a directory too");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Item 2 -----------------------------------------------------------------
test("ignore honors a graph-ignore prefix that carries a trailing slash", () => {
  const isIgnored = createDefaultIgnore("/repo", () => JSON.stringify(["dist/", "coverage"]));
  assert.equal(isIgnored("dist/bundle.js"), true, "trailing-slash prefix matches a child");
  assert.equal(isIgnored("dist"), true, "trailing-slash prefix matches the dir itself");
  assert.equal(isIgnored("coverage/lcov.info"), true);
  assert.equal(isIgnored("distinct/keep.ts"), false, "still segment-aware, not substring");
});

// Item 3 -----------------------------------------------------------------
test("prune --confirm skips a candidate whose file reappeared before the delete", () => {
  const store = new InMemoryHiveGraphStore();
  const r = reassociate(obs("gone.ts", "abc"), deps(store, new Set(["gone.ts"])));
  store.touchIdentity(r.nectar, new Date(Date.parse(NOW) - 40 * 24 * 60 * 60 * 1000).toISOString());

  // existsOnDisk reports absent during candidate computation, then present (the
  // file returned) by the time the delete loop re-checks it.
  let calls = 0;
  const out: string[] = [];
  const result = runPrune({
    store,
    tenancy: TEN,
    existsOnDisk: () => {
      calls += 1;
      return calls > 1; // first call (candidate scan) = absent; later (delete loop) = present
    },
    now: () => NOW,
    confirm: true,
    out: (l) => out.push(l),
  });

  assert.equal(result.candidates.length, 1, "it was a candidate at scan time");
  assert.equal(result.deleted, 0, "but it is not deleted because it reappeared");
  assert.ok(store.getIdentity(r.nectar), "the nectar survives");
});

// Item 4 -----------------------------------------------------------------
test("review accept carries the nectar AND retires the placeholder mint", async () => {
  const store = new InMemoryHiveGraphStore();
  const src = reassociate(obs("src/a.ts", "alpha"), deps(store, new Set(["src/a.ts"]))); // candidate (missing) nectar
  const placeholder = reassociate(obs("src/b.ts", "beta"), deps(store, new Set(["src/b.ts"]))); // fresh mint at newPath
  const pending = new InMemoryPendingReviewStore();
  const candidate: PendingReviewCandidate = {
    id: "c1",
    candidateNectar: src.nectar,
    newPath: "src/b.ts",
    confidence: 0.6,
    distance: 100,
    contentHash: sha256Hex("beta"),
    sizeBytes: 4,
    mtimeObserved: NOW,
    mintedNectar: placeholder.nectar,
    createdAt: NOW,
  };
  pending.add(candidate);
  const out: string[] = [];

  const result = await runReviewMatches({
    store,
    tenancy: TEN,
    pendingReviews: pending,
    now: () => NOW,
    out: (l) => out.push(l),
    decide: () => "accept",
  });

  assert.equal(result.accepted, 1);
  assert.equal(store.getIdentity(placeholder.nectar), undefined, "the placeholder mint is retired");
  assert.equal(store.latestVersionByPath(TEN, "src/b.ts")?.identity.nectar, src.nectar, "the carried nectar owns newPath");
  const atNewPath = store.listLatestVersions(TEN).filter((lv) => lv.version.path === "src/b.ts");
  assert.equal(atNewPath.length, 1, "exactly one identity points at newPath");
  assert.ok(out.some((l) => l.includes("retired placeholder mint")), "the output notes the retired placeholder");
});

test("review accept does NOT retire the placeholder when the carry fails (source gone)", async () => {
  const store = new InMemoryHiveGraphStore();
  const placeholder = reassociate(obs("src/b.ts", "beta"), deps(store, new Set(["src/b.ts"])));
  const pending = new InMemoryPendingReviewStore();
  pending.add({
    id: "c2",
    candidateNectar: "NECTARDOESNOTEXIST00000001",
    newPath: "src/b.ts",
    confidence: 0.6,
    distance: 100,
    contentHash: sha256Hex("beta"),
    sizeBytes: 4,
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

  assert.equal(result.accepted, 0);
  assert.ok(store.getIdentity(placeholder.nectar), "the placeholder mint is NOT retired when nothing was carried");
});

// Item 5 -----------------------------------------------------------------
test("FilePendingReviewStore writes a complete parseable file and ignores leftover temp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hn-cr5-"));
  const filePath = join(dir, "pending-reviews.json");
  try {
    const store = new FilePendingReviewStore(filePath);
    const candidate: PendingReviewCandidate = {
      id: "id-1",
      candidateNectar: "N1",
      newPath: "src/b.ts",
      confidence: 0.5,
      distance: null,
      contentHash: "h",
      sizeBytes: 3,
      mtimeObserved: NOW,
      mintedNectar: "M1",
      createdAt: NOW,
    };
    store.add(candidate);

    const raw = readFileSync(filePath, "utf8");
    assert.ok(raw.endsWith("\n"), "the file ends with a newline");
    const parsed = JSON.parse(raw); // must be complete + parseable (no torn write)
    assert.equal(Array.isArray(parsed) && parsed.length, 1);

    // A leftover temp file in the same dir must NOT be treated as the queue.
    writeFileSync(`${filePath}.99999.deadbeef.tmp`, "garbage not json", "utf8");
    assert.equal(store.list().length, 1, "list reads only the target file, not stray .tmp files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Item 7 -----------------------------------------------------------------
test("fuzzy step abstains for content shorter than one trigram (no false tiny-file carry)", () => {
  const store = new InMemoryHiveGraphStore();
  const candidate = candidateFrom(store, "ab.ts", "ab"); // 2 bytes
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  assert.equal(step.match("ba", [candidate]).kind, "none", "distinct 2-byte contents never match");
  assert.equal(step.match("hello world content here", [candidate]).kind, "none", "a 2-byte candidate is skipped");
});

// Item 8 -----------------------------------------------------------------
test("fuzzy step never auto-carries when the top confidence is tied", () => {
  const store = new InMemoryHiveGraphStore();
  const content = "the shared body of two identical candidate files here";
  const c1 = candidateFrom(store, "one.ts", content);
  // A second candidate with the SAME fingerprint + size (a tie at the top score).
  const c2: FuzzyCandidate = { ...c1, identity: { ...c1.identity, nectar: "SECONDNECTAR0000000000001A" } };
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });

  const tied = step.match(content, [c1, c2]);
  assert.notEqual(tied.kind, "match", "a shared top score is never auto-carried");
  assert.equal(tied.kind, "review", "it downgrades to review (>= reviewFloor)");

  const unique = step.match(content, [c1]);
  assert.equal(unique.kind, "match", "a uniquely-best candidate still carries");
});

// Item 9 -----------------------------------------------------------------
const FAKE_CREDENTIALS = { apiUrl: "https://unused.invalid", token: "unused", orgId: "unused", workspaceId: "unused" };

test("deeplake deleteNectar treats a missing table as a no-op and never CREATEs", async () => {
  const calls: string[] = [];
  const transport = {
    async query(sql: string): Promise<object[]> {
      calls.push(sql);
      throw new TransportError("query", 'relation "hive_graph_versions" does not exist');
    },
  };
  const store = new DeepLakeHiveGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  await store.deleteNectar(TEN, "SOMENECTAR0000000000000001");

  assert.equal(calls.length, 2, "one DELETE per table, nothing more");
  assert.ok(calls.every((sql) => /^DELETE FROM/.test(sql)), "both statements are DELETEs");
  assert.ok(calls.every((sql) => /project_id = /.test(sql)), "both carry the full tenancy predicate (AC-20)");
  assert.ok(!calls.some((sql) => /CREATE TABLE/i.test(sql)), "the delete path never heals/creates a table");
});

test("deeplake deleteNectar propagates a non-missing-table error", async () => {
  const transport = {
    async query(): Promise<object[]> {
      throw new TransportError("query", "permission denied for relation hive_graph");
    },
  };
  const store = new DeepLakeHiveGraphStore({ credentials: FAKE_CREDENTIALS, transport });
  await assert.rejects(() => store.deleteNectar(TEN, "SOMENECTAR0000000000000001"), /permission denied/);
});
