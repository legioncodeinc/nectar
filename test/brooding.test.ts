/**
 * Brooding pipeline tests (PRD-007). Test names are prefixed with the acceptance
 * criterion id (e.g. "007-AC-1 ...") they exercise.
 *
 * Run against the compiled `dist/` output (the repo's `node --test` harness),
 * matching every existing test in this suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { mintNectar } from "../dist/hive-graph/ulid.js";
import { EMBED_DIMS } from "../dist/hive-graph/model.js";
import {
  discoverFiles,
  GIT_LS_FILES_ARGS,
  contentHashPrecheck,
  prepareFiles,
  classifyBucket,
  packBatches,
  estimateTokens,
  bucketFiles,
  BATCH_FILE_SIZE,
  BATCH_TOTAL_SIZE,
  MAX_DESCRIBE_SIZE,
  BINARY_SNIFF_BYTES,
  MAX_BATCH_FILES,
  BATCH_INPUT_TOKEN_BUDGET,
  BROODING_COST_REFERENCE,
  GEMINI_INPUT_PRICE_PER_M_LE_200K,
  GEMINI_OUTPUT_PRICE_PER_M_LE_200K,
  BATCH_SYSTEM_PROMPT,
  SOLO_SYSTEM_PROMPT,
  describeBatchGroup,
  describeSoloFile,
  classifyResume,
  planBrood,
  runBrood,
  parseBroodArgs,
  shouldAutoBrood,
  formatDryRunReport,
} from "../dist/brooding/index.js";

const TENANCY = { orgId: "legion", workspaceId: "engineering", projectId: "nectar" };
const NOW = "2026-07-02T12:00:00.000Z";

// ── fakes ────────────────────────────────────────────────────────────────────

function makeFs(files) {
  const map = new Map(Object.entries(files));
  return {
    statPath(rel) {
      const c = map.get(rel);
      if (c === undefined) return null;
      const bytes = typeof c === "string" ? Buffer.from(c, "utf8") : c;
      return { sizeBytes: bytes.length, mtimeObserved: NOW, readContent: () => bytes };
    },
    existsOnDisk(rel) {
      return map.has(rel);
    },
    listPaths() {
      return [...map.keys()];
    },
  };
}

function fakeGit(paths) {
  return () => ({ available: true, paths });
}

function unavailableGit() {
  return () => ({ available: false });
}

function makeFakeDescribe() {
  let calls = 0;
  const fn = async (req) => {
    calls += 1;
    const system = req.messages[0]?.content ?? "";
    const user = req.messages[1]?.content ?? "";
    if (system === BATCH_SYSTEM_PROMPT) {
      const arr = JSON.parse(user);
      const out = arr.map((f) => ({
        nectar: f.nectar,
        title: `T ${f.path}`.slice(0, 80),
        description: `desc for ${f.path}`,
        concepts: ["alpha", "beta"],
      }));
      return { content: JSON.stringify(out), model: req.model ?? "gemini-2.5-flash", usage: usage() };
    }
    // solo
    return {
      content: JSON.stringify({ description: "a solo description", primary_symbol: "mainFn" }),
      model: req.model ?? "gemini-2.5-flash",
      usage: usage(),
    };
  };
  return { fn, calls: () => calls };
}

function usage() {
  return { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 };
}

const embedProvider = {
  kind: "local",
  embed: async (texts) => texts.map(() => new Array(EMBED_DIMS).fill(0)),
};

function baseConfig(files, over = {}) {
  const store = over.store ?? new InMemoryHiveGraphStore();
  return {
    config: {
      store,
      tenancy: TENANCY,
      root: over.root ?? "/repo",
      fs: makeFs(files),
      gitLsFiles: over.gitLsFiles ?? fakeGit(Object.keys(files)),
      projection: over.projection ?? null,
      now: () => NOW,
      ...(over.packOptions ? { packOptions: over.packOptions } : {}),
    },
    store,
  };
}

// ── 007-AC-2: discovery ────────────────────────────────────────────────────────

test("007-AC-2 discovery command is git ls-files --cached --others --exclude-standard -z (verbatim)", () => {
  assert.deepEqual([...GIT_LS_FILES_ARGS], ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
});

test("007-AC-2 discovery uses git when available and returns the candidate set", () => {
  const fs = makeFs({ "a.ts": "x", "b.md": "y" });
  const res = discoverFiles({ root: "/repo", fs, gitLsFiles: fakeGit(["a.ts", "b.md"]) });
  assert.equal(res.source, "git");
  assert.deepEqual(res.files.map((f) => f.relPath).sort(), ["a.ts", "b.md"]);
});

test("007-AC-2 discovery falls back to a manual recursive walk when git is unavailable", () => {
  const fs = makeFs({ "src/a.ts": "x", "node_modules/dep/i.js": "z" });
  const res = discoverFiles({ root: "/repo", fs, gitLsFiles: unavailableGit() });
  assert.equal(res.source, "walk");
  // The walk honors the shared ignore contract (node_modules dropped).
  assert.deepEqual(res.files.map((f) => f.relPath), ["src/a.ts"]);
});

// ── 007-AC-3: content-hash pre-check (fresh-clone $0) ──────────────────────────

test("007-AC-3 a content_hash match inherits the nectar+description and makes no LLM call", () => {
  const content = "export const a = 1;\n";
  const hash = sha256Hex(Buffer.from(content, "utf8"));
  const nectar = mintNectar();
  const projection = {
    version: 1,
    generated_at: NOW,
    generator: "test",
    project: { org_id: TENANCY.orgId, workspace_id: TENANCY.workspaceId, project_id: TENANCY.projectId },
    files: {
      [nectar]: {
        content_hash: hash,
        path: "a.ts",
        title: "A module",
        description: "inherited",
        concepts: ["x"],
        describe_model: "gemini-2.5-flash",
        described_at: NOW,
      },
    },
    derived: {},
  };
  const fs = makeFs({ "a.ts": content, "b.ts": "new file body" });
  const prepared = prepareFiles(fs, [
    { relPath: "a.ts", sizeBytes: content.length, mtimeObserved: NOW, ext: "ts" },
    { relPath: "b.ts", sizeBytes: 13, mtimeObserved: NOW, ext: "ts" },
  ]);
  const result = contentHashPrecheck(prepared, { tenancy: TENANCY, projection });
  assert.equal(result.inheritedCount, 1);
  assert.equal(result.inheritedRows[0].identity.nectar, nectar);
  assert.equal(result.survivorCount, 1);
  assert.equal(result.survivors[0].file.relPath, "b.ts");
});

test("007-AC-3 with no projection every candidate survives (no inheritance)", () => {
  const fs = makeFs({ "a.ts": "x", "b.ts": "y" });
  const prepared = prepareFiles(fs, [
    { relPath: "a.ts", sizeBytes: 1, mtimeObserved: NOW, ext: "ts" },
    { relPath: "b.ts", sizeBytes: 1, mtimeObserved: NOW, ext: "ts" },
  ]);
  const result = contentHashPrecheck(prepared, { tenancy: TENANCY, projection: null });
  assert.equal(result.inheritedCount, 0);
  assert.equal(result.survivorCount, 2);
});

// ── 007-AC-4: the four buckets + thresholds ────────────────────────────────────

test("007-AC-4 thresholds are 4 KB / 100 KB / 256 KB / 8 KB (verbatim)", () => {
  assert.equal(BATCH_FILE_SIZE, 4 * 1024);
  assert.equal(BATCH_TOTAL_SIZE, 100 * 1024);
  assert.equal(MAX_DESCRIBE_SIZE, 256 * 1024);
  assert.equal(BINARY_SNIFF_BYTES, 8 * 1024);
});

test("007-AC-4 files bucket into exactly one of skip-binary / skip-too-large / batch / solo", () => {
  const mk = (relPath, ext, sizeBytes, hasNul) => ({
    file: { relPath, sizeBytes, mtimeObserved: NOW, ext },
    bytes: new Uint8Array(hasNul ? [0, 1, 2] : [1, 2, 3]),
    contentHash: "h",
    hasNulInSniff: hasNul === true,
  });
  assert.equal(classifyBucket(mk("logo.png", "png", 10, false)), "skip-binary");
  assert.equal(classifyBucket(mk("big.txt", "txt", MAX_DESCRIBE_SIZE + 1, false)), "skip-too-large");
  assert.equal(classifyBucket(mk("blob.dat", "dat", 100, true)), "skip-binary");
  assert.equal(classifyBucket(mk("small.ts", "ts", BATCH_FILE_SIZE, false)), "batch");
  assert.equal(classifyBucket(mk("mid.ts", "ts", BATCH_FILE_SIZE + 1, false)), "solo");
});

// ── 007-AC-4 / US-007b.1: dynamic batch packing (decision #22, not fixed-40) ────

function preparedOfSize(n, sizeBytes) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      file: { relPath: `f${i}.ts`, sizeBytes, mtimeObserved: NOW, ext: "ts" },
      bytes: new Uint8Array(1),
      contentHash: `h${i}`,
      hasNulInSniff: false,
    });
  }
  return out;
}

test("007-AC-4 batch packing is DYNAMIC: groups respect the 100 KB cap and the 30-50 files ceiling", () => {
  const groups = packBatches(preparedOfSize(200, 2 * 1024));
  assert.ok(groups.length > 1);
  for (const g of groups) {
    assert.ok(g.files.length <= MAX_BATCH_FILES);
    assert.ok(g.totalBytes <= BATCH_TOTAL_SIZE);
    assert.ok(g.estimatedTokens <= BATCH_INPUT_TOKEN_BUDGET);
  }
});

test("007-AC-4 dynamic packing adapts to file size (larger files => fewer per call, not fixed-40)", () => {
  const small = packBatches(preparedOfSize(120, 2 * 1024))[0].files.length;
  const large = packBatches(preparedOfSize(120, 4 * 1024))[0].files.length;
  assert.notEqual(small, large); // it adapts to actual sizes rather than counting a fixed number
  assert.ok(large < small);
});

test("007-AC-4 estimateTokens follows 4 KB of source ~= 1K tokens", () => {
  assert.equal(estimateTokens(4096), 1024);
  assert.equal(estimateTokens(2048), 512);
});

// ── 007-AC-5: cost math (verbatim) ─────────────────────────────────────────────

test("007-AC-5 cost math is carried verbatim (~$3.05 = $0.65 input + $2.40 output, ~2.15M tokens, ~318 calls)", () => {
  const r = BROODING_COST_REFERENCE;
  assert.equal(r.totalUsd, 3.05);
  assert.equal(r.inputUsd, 0.65);
  assert.equal(r.outputUsd, 2.4);
  assert.equal(r.embeddingUsd, 0);
  assert.equal(r.totalInputTokens, 2_150_000);
  assert.equal(r.totalCalls, 318);
  assert.equal(r.buckets.batch.calls, 38);
  assert.equal(r.buckets.solo.calls, 280);
  assert.equal(r.buckets.batch.files, 1500);
  assert.equal(r.buckets.solo.files, 280);
  assert.equal(r.buckets.skipBinary.files, 200);
  assert.equal(r.buckets.skipTooLarge.files, 20);
  assert.equal(r.monorepo10kUsd, 15);
  assert.equal(r.microservice200Usd, 0.3);
  assert.equal(GEMINI_INPUT_PRICE_PER_M_LE_200K, 0.3);
  assert.equal(GEMINI_OUTPUT_PRICE_PER_M_LE_200K, 2.5);
});

// ── 007-AC-6: batch/solo call shapes ───────────────────────────────────────────

test("007-AC-6 the batch system prompt is reproduced verbatim from the corpus", () => {
  assert.equal(
    BATCH_SYSTEM_PROMPT,
    [
      "You are describing source files in a codebase for a semantic search index.",
      "For each file, return:",
      "- title: <=80 chars, a human-readable name for what this file IS (not its path).",
      "- description: 1-3 sentences, what this file does and what it is for.",
      '- concepts: 1-5 lowercase tags for cross-file linking (e.g. "auth", "session", "jwt").',
      "Respond as a JSON array, one object per input file, in input order.",
    ].join("\n"),
  );
});

test("007-AC-6 batch call returns title (<=80) + description + 1-5 concepts per file, in input order", async () => {
  const targets = [
    { nectar: "N1", prepared: { file: { relPath: "a.ts", ext: "ts", sizeBytes: 3, mtimeObserved: NOW }, bytes: Buffer.from("aaa"), contentHash: "h1", hasNulInSniff: false } },
    { nectar: "N2", prepared: { file: { relPath: "b.ts", ext: "ts", sizeBytes: 3, mtimeObserved: NOW }, bytes: Buffer.from("bbb"), contentHash: "h2", hasNulInSniff: false } },
  ];
  const { fn } = makeFakeDescribe();
  const res = await describeBatchGroup(targets, fn);
  assert.equal(res.described.length, 2);
  assert.equal(res.failed.length, 0);
  for (const d of res.described) {
    assert.ok(d.payload.title.length <= 80);
    assert.ok(d.payload.description.length > 0);
    const concepts = JSON.parse(d.payload.concepts);
    assert.ok(concepts.length >= 1 && concepts.length <= 5);
  }
});

test("007-AC-6 solo call returns a description + primary symbol (title from the primary symbol)", async () => {
  const target = { nectar: "N1", prepared: { file: { relPath: "big.ts", ext: "ts", sizeBytes: 9, mtimeObserved: NOW }, bytes: Buffer.from("big source"), contentHash: "h", hasNulInSniff: false } };
  const { fn } = makeFakeDescribe();
  const res = await describeSoloFile(target, fn);
  assert.ok(res.payload !== null);
  assert.equal(res.payload.title, "mainFn");
  assert.ok(res.payload.description.length > 0);
});

test("007-AC-6 a malformed batch entry is reported as failed (re-tried solo or marked failed by the pipeline)", async () => {
  const targets = [
    { nectar: "N1", prepared: { file: { relPath: "a.ts", ext: "ts", sizeBytes: 1, mtimeObserved: NOW }, bytes: Buffer.from("a"), contentHash: "h1", hasNulInSniff: false } },
    { nectar: "N2", prepared: { file: { relPath: "b.ts", ext: "ts", sizeBytes: 1, mtimeObserved: NOW }, bytes: Buffer.from("b"), contentHash: "h2", hasNulInSniff: false } },
  ];
  // Only N1 comes back well-formed.
  const fn = async () => ({ content: JSON.stringify([{ nectar: "N1", title: "T", description: "d", concepts: ["x"] }]), model: "m", usage: usage() });
  const res = await describeBatchGroup(targets, fn);
  assert.deepEqual(res.described.map((d) => d.nectar), ["N1"]);
  assert.deepEqual(res.failed, ["N2"]);
});

// ── 007-AC-7: resumability state machine ───────────────────────────────────────

test("007-AC-7 the three rules: skip (terminal) / re-enqueue (pending) / discover-fresh (no nectar)", () => {
  assert.equal(classifyResume(undefined), "discover-fresh");
  assert.equal(classifyResume({ describeStatus: "pending" }), "re-enqueue");
  assert.equal(classifyResume({ describeStatus: "described" }), "skip");
  assert.equal(classifyResume({ describeStatus: "skipped-binary" }), "skip");
  assert.equal(classifyResume({ describeStatus: "skipped-too-large" }), "skip");
});

test("007-AC-7 a failed row is re-enqueueable (not a permanent terminal state)", () => {
  assert.equal(classifyResume({ describeStatus: "failed" }), "re-enqueue");
});

test("007-AC-7 --force re-enqueues described/failed but keeps the two skip statuses skipped", () => {
  assert.equal(classifyResume({ describeStatus: "described" }, { force: true }), "re-enqueue");
  assert.equal(classifyResume({ describeStatus: "failed" }, { force: true }), "re-enqueue");
  assert.equal(classifyResume({ describeStatus: "skipped-binary" }, { force: true }), "skip");
  assert.equal(classifyResume({ describeStatus: "skipped-too-large" }, { force: true }), "skip");
});

test("007-AC-7 a killed brood resumes: described files are skipped, new files discovered fresh", async () => {
  const { config, store } = baseConfig({ "a.ts": "aaa", "b.ts": "bbb" });
  const d1 = makeFakeDescribe();
  const r1 = await runBrood(config, { describe: d1.fn, embedProvider, regenerateProjection: () => "/x" });
  assert.equal(r1.describedCount, 2);
  const callsAfterFirst = d1.calls();

  // Second run: add c.ts. a/b are described (skip), c is fresh.
  const fs2 = makeFs({ "a.ts": "aaa", "b.ts": "bbb", "c.ts": "ccc" });
  const d2 = makeFakeDescribe();
  const r2 = await runBrood(
    { ...config, fs: fs2, gitLsFiles: fakeGit(["a.ts", "b.ts", "c.ts"]) },
    { describe: d2.fn, embedProvider, regenerateProjection: () => "/x" },
  );
  assert.equal(r2.skippedResumeCount, 2);
  assert.equal(r2.freshCount, 1);
  assert.equal(r2.describedCount, 1);
  assert.ok(d2.calls() >= 1 && d2.calls() < callsAfterFirst + 2);
});

test("007-AC-7 no lockfile or partial-state marker is created (state derives from the table)", async () => {
  const root = mkdtempSync(join(tmpdir(), "brood-lock-"));
  try {
    const { config } = baseConfig({ "a.ts": "aaa" }, { root });
    const d = makeFakeDescribe();
    await runBrood(config, { describe: d.fn, embedProvider });
    const entries = readdirSync(join(root, ".honeycomb"));
    assert.deepEqual(entries, ["nectars.json"]); // only the projection, no lock/marker
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 007-AC-8: --dry-run ────────────────────────────────────────────────────────

test("007-AC-8 --dry-run runs discovery + bucketing + estimate with NO LLM call and NO writes", async () => {
  const { config, store } = baseConfig({ "a.ts": "aaa", "b.ts": "bbb" });
  const d = makeFakeDescribe();
  const res = await runBrood(config, { describe: d.fn, embedProvider }, { dryRun: true });
  assert.equal(d.calls(), 0);
  assert.equal(res.dryRun, true);
  assert.equal(res.projectionPath, null);
  assert.equal(store.listLatestVersions(TENANCY).length, 0);
  assert.ok(res.estimate.totalCalls >= 0);
});

test("007-AC-8 planBrood buckets and estimates cost without touching the store", () => {
  const { config, store } = baseConfig({ "a.ts": "aaa", "logo.png": Buffer.from([0, 1, 2]) });
  const plan = planBrood(config);
  assert.equal(plan.skipBinaryCount, 1);
  assert.equal(plan.batchFileCount, 1);
  assert.equal(store.listLatestVersions(TENANCY).length, 0);
  const report = formatDryRunReport(plan);
  assert.ok(report.includes("$"));
  assert.ok(report.includes("no LLM calls"));
});

// ── 007-AC-9: --force and --limit ──────────────────────────────────────────────

test("007-AC-9 --limit N caps the number of pending files described; the rest resume later", async () => {
  const files = { "a.ts": "a", "b.ts": "b", "c.ts": "c", "d.ts": "d" };
  const { config, store } = baseConfig(files);
  const d1 = makeFakeDescribe();
  const r1 = await runBrood(config, { describe: d1.fn, embedProvider, regenerateProjection: () => "/x" }, { limit: 2 });
  assert.equal(r1.describedCount, 2);

  const d2 = makeFakeDescribe();
  const r2 = await runBrood(
    { ...config, fs: makeFs(files), gitLsFiles: fakeGit(Object.keys(files)) },
    { describe: d2.fn, embedProvider, regenerateProjection: () => "/x" },
  );
  assert.equal(r2.describedCount, 2); // the remaining two brood on the next run
});

test("007-AC-9 --force re-describes an already-described file; without force it is skipped", async () => {
  const files = { "a.ts": "aaa" };
  const { config, store } = baseConfig(files);
  const d1 = makeFakeDescribe();
  await runBrood(config, { describe: d1.fn, embedProvider, regenerateProjection: () => "/x" });

  // No-force second run: skipped.
  const d2 = makeFakeDescribe();
  const r2 = await runBrood(
    { ...config, fs: makeFs(files), gitLsFiles: fakeGit(["a.ts"]) },
    { describe: d2.fn, embedProvider, regenerateProjection: () => "/x" },
  );
  assert.equal(r2.skippedResumeCount, 1);
  assert.equal(d2.calls(), 0);

  // Force run: re-described.
  const d3 = makeFakeDescribe();
  const r3 = await runBrood(
    { ...config, fs: makeFs(files), gitLsFiles: fakeGit(["a.ts"]) },
    { describe: d3.fn, embedProvider, regenerateProjection: () => "/x" },
    { force: true },
  );
  assert.equal(r3.reenqueueCount, 1);
  assert.equal(r3.describedCount, 1);
  assert.ok(d3.calls() >= 1);
});

// ── 007-AC-10: automatic triggering ────────────────────────────────────────────

test("007-AC-10 the automatic trigger fires when there are no hive_graph rows OR no projection", () => {
  assert.equal(shouldAutoBrood({ hasHiveGraphRows: false, hasProjection: false }), true);
  assert.equal(shouldAutoBrood({ hasHiveGraphRows: true, hasProjection: false }), true);
  assert.equal(shouldAutoBrood({ hasHiveGraphRows: false, hasProjection: true }), true);
  assert.equal(shouldAutoBrood({ hasHiveGraphRows: true, hasProjection: true }), false);
});

// ── 007-AC-1: the fixed pipeline order ─────────────────────────────────────────

test("007-AC-1 the pipeline runs in the fixed order discover -> ... -> describe -> embed -> persist -> regenerate-projection", async () => {
  const order = [];
  const files = { "a.ts": "aaa", "b.ts": "bbb" };
  const store = new InMemoryHiveGraphStore();
  const gitLsFiles = () => {
    order.push("discover");
    return { available: true, paths: Object.keys(files) };
  };
  const describe = async (req) => {
    order.push("describe");
    const arr = JSON.parse(req.messages[1].content);
    return {
      content: JSON.stringify(arr.map((f) => ({ nectar: f.nectar, title: "T", description: "d", concepts: ["x"] }))),
      model: "gemini-2.5-flash",
      usage: usage(),
    };
  };
  const provider = {
    kind: "local",
    embed: async (texts) => {
      order.push("embed");
      return texts.map(() => new Array(EMBED_DIMS).fill(0));
    },
  };
  const regenerateProjection = (s) => {
    order.push("regenerate");
    // Persist must already be complete before regeneration reads the store.
    assert.ok(s.listLatestVersions(TENANCY).length > 0);
    return "/x";
  };
  const config = { store, tenancy: TENANCY, root: "/repo", fs: makeFs(files), gitLsFiles, projection: null, now: () => NOW };
  await runBrood(config, { describe, embedProvider: provider, regenerateProjection });

  assert.equal(order[0], "discover");
  assert.equal(order[order.length - 1], "regenerate");
  const describeIdx = order.indexOf("describe");
  const embedIdx = order.indexOf("embed");
  assert.ok(describeIdx > 0 && embedIdx > describeIdx);
  assert.ok(order.indexOf("regenerate") > embedIdx);
});

// ── 007-AC-2 / US-007b.2: skip buckets are minted but not described ─────────────

test("007-AC-4 binary and oversized files mint a nectar but make no LLM call", async () => {
  const big = "x".repeat(MAX_DESCRIBE_SIZE + 10);
  const files = { "logo.png": Buffer.from([0, 1, 2, 3]), "huge.txt": big, "ok.ts": "small" };
  const { config, store } = baseConfig(files);
  const d = makeFakeDescribe();
  const res = await runBrood(config, { describe: d.fn, embedProvider, regenerateProjection: () => "/x" });
  assert.equal(res.skipBinaryCount, 1);
  assert.equal(res.skipTooLargeCount, 1);
  assert.equal(res.describedCount, 1); // only ok.ts described

  const statuses = store.listLatestVersions(TENANCY).map((lv) => lv.version.describeStatus).sort();
  assert.deepEqual(statuses, ["described", "skipped-binary", "skipped-too-large"]);
});

// ── 007d: flag parsing ─────────────────────────────────────────────────────────

test("007-AC-9 parseBroodArgs parses --force, --limit N, --dry-run, --model <new>", () => {
  const parsed = parseBroodArgs(["--force", "--limit", "100", "--dry-run", "--model", "gemini-2.0"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.force, true);
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.limit, 100);
  assert.equal(parsed.options.model, "gemini-2.0");
});

test("007-AC-9 parseBroodArgs accepts --limit=N and rejects a non-integer limit", () => {
  assert.equal(parseBroodArgs(["--limit=5"]).options.limit, 5);
  assert.ok(parseBroodArgs(["--limit", "abc"]).errors.length > 0);
  assert.ok(parseBroodArgs(["--bogus"]).errors.length > 0);
});
