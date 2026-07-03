/**
 * CLI verb tests (PRD-018b AC-018b.8): `brood` (mutating), `prune`, and
 * `review-matches` now run their real mechanics against the durable store
 * instead of exiting 2 as wiring stubs.
 *
 * These exercise the exported, testable verb runners against an injected store
 * (the process wrappers resolve the real Deep Lake context and bridge the
 * sync/async gap; that plumbing is covered by store-bridge.test.ts and the watch
 * integration test). Each verb returns 0 on success, never the old exit-2 stub.
 *
 * Fully offline: the async store is an in-memory recorder, the describe transport
 * is a fake. Imports the compiled modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBroodMutatingVerb,
  runPruneVerb,
  runReviewMatchesVerb,
  resolveCliBroodEmbedDeps,
  interactiveReviewDecider,
  type InteractiveReviewIo,
} from "../dist/cli.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { InMemoryPendingReviewStore } from "../dist/registration/review-store.js";
import { EMBED_DIMS } from "../dist/hive-graph/model.js";
import { activeEmbedModelId, resolveEmbeddingsConfig } from "../dist/embeddings/config.js";
import { filenameOf, extOf } from "../dist/hive-graph/paths.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { BATCH_SYSTEM_PROMPT } from "../dist/brooding/index.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../dist/hive-graph/model.js";

const TEN: Tenancy = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-03T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function identity(nectar: string, lastUpdateDate = NOW): HiveGraphRow {
  return {
    nectar,
    kind: "file",
    createdAt: OLD,
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate,
  };
}

function version(nectar: string, path: string, content: string, lastUpdateDate = NOW): HiveGraphVersionRow {
  return {
    nectar,
    contentHash: sha256Hex(content),
    seq: 0,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    sizeBytes: Buffer.byteLength(content, "utf8"),
    mtimeObserved: NOW,
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    fingerprint: null,
    describedAt: "",
    describeModel: "",
    describeStatus: "pending",
    observedAt: NOW,
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate,
  };
}

test("cli prune: preview (no --confirm) runs the real mechanic and exits 0 without deleting", () => {
  const store = new InMemoryHiveGraphStore();
  store.insertIdentity(identity("n-missing", OLD));
  store.appendVersion(version("n-missing", "gone.ts", "long gone", OLD));
  const out: string[] = [];
  const code = runPruneVerb({
    store,
    tenancy: TEN,
    existsOnDisk: () => false,
    confirm: false,
    out: (l) => out.push(l),
    now: () => NOW,
  });
  assert.equal(code, 0, "prune preview exits 0 (not the old exit-2 stub)");
  assert.equal(store.listLatestVersions(TEN).length, 1, "preview deletes nothing");
  assert.ok(out.some((l) => l.includes("preview only")), "the real preview ran");
});

test("cli prune --confirm: runs the real mechanic against the store and deletes the missing nectar", () => {
  const store = new InMemoryHiveGraphStore();
  store.insertIdentity(identity("n-missing", OLD));
  store.appendVersion(version("n-missing", "gone.ts", "long gone", OLD));
  const out: string[] = [];
  const code = runPruneVerb({
    store,
    tenancy: TEN,
    existsOnDisk: () => false,
    confirm: true,
    out: (l) => out.push(l),
    now: () => NOW,
  });
  assert.equal(code, 0, "prune --confirm exits 0");
  assert.equal(store.listLatestVersions(TEN).length, 0, "the missing, past-grace nectar was pruned");
});

test("cli review-matches: no pending candidates runs the real mechanic and exits 0", async () => {
  const store = new InMemoryHiveGraphStore();
  const pendingReviews = new InMemoryPendingReviewStore();
  const out: string[] = [];
  const code = await runReviewMatchesVerb({
    store,
    tenancy: TEN,
    pendingReviews,
    decide: () => "skip",
    out: (l) => out.push(l),
    now: () => NOW,
  });
  assert.equal(code, 0, "review-matches exits 0 with nothing to review (not the old exit-2 stub)");
  assert.ok(out.some((l) => l.includes("No pending matches")), "the real mechanic ran");
});

test("cli review-matches: an accepted candidate carries the nectar onto the new path and exits 0", async () => {
  const store = new InMemoryHiveGraphStore();
  store.insertIdentity(identity("n-missing", OLD));
  store.appendVersion(version("n-missing", "old.ts", "shared body of the file"));
  const pendingReviews = new InMemoryPendingReviewStore();
  pendingReviews.add({
    id: "cand-1",
    candidateNectar: "n-missing",
    newPath: "new.ts",
    confidence: 0.7,
    distance: 42,
    contentHash: sha256Hex("shared body of the file"),
    sizeBytes: 22,
    mtimeObserved: NOW,
    mintedNectar: "",
    createdAt: NOW,
  });
  const out: string[] = [];
  const code = await runReviewMatchesVerb({
    store,
    tenancy: TEN,
    pendingReviews,
    decide: () => "accept",
    out: (l) => out.push(l),
    now: () => NOW,
  });
  assert.equal(code, 0, "review-matches accept exits 0");
  assert.equal(store.latestVersionByPath(TEN, "new.ts")?.identity.nectar, "n-missing", "the nectar was carried to the new path");
  assert.equal(pendingReviews.list().length, 0, "the resolved candidate was removed");
});

// ── CodeRabbit PR-18 finding #6: the interactive decider prints its own context ──

function fakeInteractiveIo(answers: readonly string[]): { io: InteractiveReviewIo; written: string[]; prompts: string[] } {
  const written: string[] = [];
  const prompts: string[] = [];
  let call = 0;
  return {
    written,
    prompts,
    io: {
      isTTY: true,
      write: (line) => written.push(line),
      question: async (prompt) => {
        prompts.push(prompt);
        const answer = answers[call] ?? "s";
        call += 1;
        return answer;
      },
      close: () => {},
    },
  };
}

test("interactiveReviewDecider writes the preview via its own IO before asking (CodeRabbit PR-18 finding #6)", async () => {
  const { io, written, prompts } = fakeInteractiveIo(["a"]);
  const decider = interactiveReviewDecider(io);
  const candidate = {
    id: "c1",
    candidateNectar: "N1",
    newPath: "src/b.ts",
    confidence: 0.6,
    distance: 10,
    contentHash: "h",
    sizeBytes: 3,
    mtimeObserved: "2026-07-03T00:00:00.000Z",
    mintedNectar: "M1",
    createdAt: "2026-07-03T00:00:00.000Z",
  };
  const preview = `candidate ${candidate.id}\n  new path: ${candidate.newPath}`;

  const decision = await decider.decide(candidate, preview);

  assert.equal(decision, "accept");
  assert.ok(written.length > 0, "the decider wrote at least one line via its own IO");
  assert.equal(written[0], preview, "the preview text was written before the question");
  assert.equal(prompts.length, 1, "the question was asked exactly once, after the preview was written");
});

test("interactiveReviewDecider defaults to skip on a non-TTY IO without asking or writing", async () => {
  const decider = interactiveReviewDecider({
    isTTY: false,
    write: () => {
      throw new Error("must never write on a non-TTY input");
    },
    question: async () => {
      throw new Error("must never ask on a non-TTY input");
    },
    close: () => {},
  });
  const decision = await decider.decide({} as never, "unused preview");
  assert.equal(decision, "skip");
});

// ── CodeRabbit PR-18 finding #7: the CLI brood path resolves a non-null embedModelId ──

test("resolveCliBroodEmbedDeps resolves an embedModelId matching the currently-configured embed provider", () => {
  const config = resolveEmbeddingsConfig({});
  const expected = activeEmbedModelId(config);
  const { embedProvider, embedModelId } = resolveCliBroodEmbedDeps();
  assert.equal(embedModelId, expected, "matches whatever the process's own embeddings config currently resolves to");
  assert.equal(typeof embedProvider.embed, "function", "an embed provider was resolved alongside the model id");
  if (config.selector !== "off") {
    assert.notEqual(embedModelId, null, "a configured (non-off) provider must yield a non-null embedModelId (AC-018i.3)");
  }
});

// ── mutating brood against a fake async store ────────────────────────────────

function makeAsyncStore() {
  const inner = new InMemoryHiveGraphStore();
  const store: AsyncHiveGraphStore = {
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
  return { store, inner };
}

function makeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  return {
    statPath(rel: string) {
      const c = map.get(rel);
      if (c === undefined) return null;
      const bytes = Buffer.from(c, "utf8");
      return { sizeBytes: bytes.length, mtimeObserved: NOW, readContent: () => bytes };
    },
    existsOnDisk: (rel: string) => map.has(rel),
    listPaths: () => [...map.keys()],
  };
}

const embedProvider = {
  kind: "local" as const,
  embed: async (texts: string[]) => texts.map(() => new Array(EMBED_DIMS).fill(0.01)),
};

function makeFakeDescribe() {
  return async (req: { model?: string; messages: Array<{ content?: string }> }) => {
    const system = req.messages[0]?.content ?? "";
    const user = req.messages[1]?.content ?? "";
    if (system === BATCH_SYSTEM_PROMPT) {
      const arr = JSON.parse(user) as Array<{ nectar: string; path: string }>;
      const out = arr.map((f) => ({ nectar: f.nectar, title: `T ${f.path}`.slice(0, 80), description: `desc ${f.path}`, concepts: ["a"] }));
      return { content: JSON.stringify(out), model: req.model ?? "gemini-2.5-flash", usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 } };
    }
    return {
      content: JSON.stringify({ description: "solo", primary_symbol: "main" }),
      model: req.model ?? "gemini-2.5-flash",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
    };
  };
}

test("cli brood (mutating): runs runBroodAsync against the durable store and exits 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-cli-brood-"));
  const { store, inner } = makeAsyncStore();
  const out: string[] = [];
  try {
    const code = await runBroodMutatingVerb({
      config: {
        store,
        tenancy: TEN,
        root,
        fs: makeFs({ "src/a.ts": "export const a = 1;\n" }) as never,
        gitLsFiles: () => ({ available: true as const, paths: ["src/a.ts"] }),
        projection: null,
        now: () => NOW,
      },
      deps: { describe: makeFakeDescribe() as never, embedProvider },
      out: (l) => out.push(l),
    });
    assert.equal(code, 0, "mutating brood exits 0 (not the old exit-2 stub)");
    assert.equal(inner.listLatestVersions(TEN).length, 1, "a durable row landed from the real brood mechanic");
    assert.equal(inner.listLatestVersions(TEN)[0]!.version.describeStatus, "described", "the brood described the file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
