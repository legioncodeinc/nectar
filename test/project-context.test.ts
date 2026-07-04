/**
 * PRD-019a: the per-project brood + watch RunningContext. Proves a context is
 * rooted at ITS OWN bound path and scoped to ITS OWN tenancy, and that start()
 * hydrates + watches while stop() drains (a-AC-3 / a-AC-7). Hermetic: a real
 * temp dir for the watch root, an injected in-memory store + registration fs +
 * ignore (no git spawn, no network). Runs against the compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectContext } from "../dist/registration/project-context.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { mintNectar } from "../dist/hive-graph/ulid.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";
import type { Tenancy } from "../dist/hive-graph/model.js";

/** Wrap a sync in-memory store as the async durable seam, counting hydrate reads. */
function asyncWrap(inner: InMemoryHiveGraphStore, onListLatest: () => void): AsyncHiveGraphStore {
  return {
    insertIdentity: async (r) => inner.insertIdentity(r),
    getIdentity: async (n) => inner.getIdentity(n),
    touchIdentity: async (n, d) => inner.touchIdentity(n, d),
    appendVersion: async (r) => inner.appendVersion(r),
    nextSeq: async (n) => inner.nextSeq(n),
    latestVersion: async (n) => inner.latestVersion(n),
    listLatestVersions: async (t) => {
      onListLatest();
      return inner.listLatestVersions(t);
    },
    listLatestDescribedVersions: async (t) => inner.listLatestDescribedVersions(t),
    latestVersionByPath: async (t, p) => inner.latestVersionByPath(t, p),
    latestVersionByHash: async (t, h) => inner.latestVersionByHash(t, h),
    deleteNectar: async (t, n) => inner.deleteNectar(t, n),
  };
}

const fakeShared = {
  isIgnored: (_p: string) => false,
  refresh: () => {},
  isGitAvailable: () => false,
  lastGitError: () => null,
};

/** A registration fs that lists no paths (keeps the resync trivial). */
const emptyFs = {
  statPath: () => null,
  existsOnDisk: () => false,
  isDirectory: () => false,
  listPaths: () => [] as string[],
};

test("a-AC-3 / a-AC-7 a project context is rooted at its own path + tenancy; start hydrates + watches, stop drains", async () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-ctx-"));
  try {
    let hydrateReads = 0;
    const store = asyncWrap(new InMemoryHiveGraphStore(), () => {
      hydrateReads += 1;
    });
    const tenancy: Tenancy = { orgId: "o", workspaceId: "w", projectId: "proj-X" };
    const ctx = createProjectContext({
      project: { projectId: "proj-X", path: root, brooding: "active" },
      tenancy,
      store,
      // no broodDeps -> watch-only (no auto-brood), which keeps this fast + LLM-free
      registrationFs: emptyFs as any,
      sharedIgnore: fakeShared as any,
    } as any);

    assert.equal(ctx.projectId, "proj-X");
    assert.equal(ctx.path, root, "the context is rooted at its OWN bound path");
    assert.equal(ctx.watcherState(), "stopped");

    await ctx.start();
    assert.equal(ctx.watcherState(), "running", "the watcher is running after start");
    assert.ok(hydrateReads >= 1, "start hydrated the mirror from the durable store (scoped to this tenancy)");

    await ctx.stop();
    assert.equal(ctx.watcherState(), "stopped", "the watcher is stopped and drained after stop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-011b.6 (per project) context start loads <root>/.honeycomb/nectars.json and inherits hash-matched files with zero LLM calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-ctx-prewarm-"));
  try {
    // A real file on disk plus a valid projection whose entry hash-matches it.
    const content = "export const x = 1;\n";
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), content, "utf8");
    const nectar = mintNectar();
    const projection = {
      version: 1,
      generated_at: "2026-07-04T00:00:00.000Z",
      generator: "honeycomb-nectar@0.0.1",
      project: { org_id: "o", workspace_id: "w", project_id: "proj-X" },
      files: {
        [nectar]: {
          content_hash: sha256Hex(content),
          path: "src/a.ts",
          title: "The X constant",
          description: "Exports x.",
          concepts: [],
          describe_model: "gemini-2.5-flash",
          described_at: "2026-07-04T00:00:00.000Z",
        },
      },
      derived: {},
    };
    mkdirSync(join(root, ".honeycomb"), { recursive: true });
    writeFileSync(join(root, ".honeycomb", "nectars.json"), `${JSON.stringify(projection)}\n`, "utf8");

    const inner = new InMemoryHiveGraphStore();
    const store = asyncWrap(inner, () => {});
    const tenancy: Tenancy = { orgId: "o", workspaceId: "w", projectId: "proj-X" };
    const ctx = createProjectContext({
      project: { projectId: "proj-X", path: root, brooding: "active" },
      tenancy,
      store,
      // No broodDeps: no describe transport exists, so the ONLY way rows can
      // appear is the projection inherit (zero LLM calls by construction).
    } as any);

    await ctx.start();
    try {
      const identity = inner.getIdentity(nectar);
      assert.ok(identity !== undefined, "the projection's nectar identity was inherited into the store");
      const latest = inner.latestVersion(nectar);
      assert.equal(latest?.path, "src/a.ts");
      assert.equal(latest?.title, "The X constant");
      assert.equal(latest?.description, "Exports x.");
      assert.equal(latest?.contentHash, sha256Hex(content), "the inherited row carries the hash-matched content");
    } finally {
      await ctx.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-011b.6 (per project) a missing or foreign-tenancy projection is skipped fail-soft; the context still starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-ctx-prewarm-skip-"));
  try {
    // A projection for a DIFFERENT project triple: validation rejects it whole.
    mkdirSync(join(root, ".honeycomb"), { recursive: true });
    writeFileSync(
      join(root, ".honeycomb", "nectars.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-07-04T00:00:00.000Z",
        generator: "g",
        project: { org_id: "OTHER", workspace_id: "w", project_id: "proj-Y" },
        files: {},
        derived: {},
      }),
      "utf8",
    );
    const inner = new InMemoryHiveGraphStore();
    const store = asyncWrap(inner, () => {});
    const tenancy: Tenancy = { orgId: "o", workspaceId: "w", projectId: "proj-X" };
    const ctx = createProjectContext({
      project: { projectId: "proj-X", path: root, brooding: "active" },
      tenancy,
      store,
      registrationFs: emptyFs as any,
      sharedIgnore: fakeShared as any,
    } as any);
    await ctx.start();
    try {
      assert.equal(inner.listLatestVersions(tenancy).length, 0, "nothing is inherited from a foreign projection");
      assert.equal(ctx.watcherState(), "running", "the context still starts (fail-soft skip)");
    } finally {
      await ctx.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
