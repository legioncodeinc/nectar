/**
 * Wave-2 integration tests: the shared surfaces the three freshly-implemented
 * modules (PRD-010 portkey, PRD-011 projection, PRD-014 embeddings) plug into.
 *
 * Covers:
 *   - the durable projection scan (`listLatestDescribedVersions`) on both the
 *     in-memory and Deep Lake stores (latest DESCRIBED version per nectar),
 *   - the async projection rebuild the `rebuild-projection` CLI verb runs REAL
 *     against Deep Lake, including 011c-AC-3 byte-identical regeneration,
 *   - the `/health` provider state (PRD-010 `portkey.enabled` + PRD-014
 *     `embeddings.provider`) resolved once at assemble time,
 *   - the collapsed Portkey header module (one `buildPortkeyHeaders`, shared URL).
 *
 * Imports the compiled modules from `dist/` (the suite builds first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintNectar } from "../dist/hive-graph/ulid.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { DeepLakeHiveGraphStore } from "../dist/hive-graph/deeplake-store.js";
import { rebuildProjectionAsync } from "../dist/projection/write.js";
import { buildProjectionFromAsyncStore } from "../dist/projection/generate.js";
import { canonicalSerializeExceptGeneratedAt } from "../dist/projection/format.js";
import { assembleDaemon } from "../dist/index.js";
import { HealthState } from "../dist/health.js";
import { buildPortkeyHeaders as buildFromPortkey, PORTKEY_EMBEDDINGS_URL as URL_FROM_PORTKEY } from "../dist/portkey/headers.js";
import { buildPortkeyHeaders as buildFromEmbeddings, PORTKEY_EMBEDDINGS_URL as URL_FROM_EMBEDDINGS } from "../dist/embeddings/index.js";

const TEN = { orgId: "legion", workspaceId: "engineering", projectId: "honeycomb" };
const FAKE_CREDENTIALS = { apiUrl: "https://unused.invalid", token: "unused", orgId: "unused", workspaceId: "unused" };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "nectar-wave2-"));
}

/** A domain-shaped identity row for the in-memory store. */
function identityRow(nectar: string) {
  return {
    nectar,
    kind: "file" as const,
    createdAt: "2026-07-01T00:00:00.000Z",
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

/** A domain-shaped version row for the in-memory store. */
function versionRow(nectar: string, seq: number, path: string, hash: string, described: boolean) {
  return {
    nectar,
    contentHash: hash,
    seq,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    sizeBytes: 10,
    mtimeObserved: "2026-07-01T00:00:00.000Z",
    title: described ? "Title" : "",
    description: described ? "Description." : "",
    concepts: described ? '["auth"]' : "[]",
    embedding: null as number[] | null,
    confidence: null as number | null,
    fingerprint: null as string | null,
    describedAt: described ? "2026-07-01T00:00:00.000Z" : "",
    describeModel: described ? "gemini-2.5-flash" : "",
    describeStatus: described ? ("described" as const) : ("pending" as const),
    observedAt: "2026-07-01T00:00:00.000Z",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

/** A RAW snake_case hive_graph row (what Deep Lake returns). */
function rawIdentity(nectar: string) {
  return {
    nectar,
    kind: "file",
    created_at: "2026-07-01T00:00:00.000Z",
    derived_from_nectar: "",
    fork_content_hash: "",
    org_id: TEN.orgId,
    workspace_id: TEN.workspaceId,
    project_id: TEN.projectId,
    last_update_date: "",
  };
}

/** A RAW snake_case hive_graph_versions row (what Deep Lake returns). */
function rawVersion(nectar: string, seq: number, path: string, hash: string, described: boolean) {
  return {
    nectar,
    content_hash: hash,
    seq,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    size_bytes: 10,
    mtime_observed: "2026-07-01T00:00:00.000Z",
    title: described ? "Title" : "",
    description: described ? "Description." : "",
    concepts: described ? '["auth"]' : "[]",
    embedding: null,
    confidence: null,
    fingerprint: null,
    described_at: described ? "2026-07-01T00:00:00.000Z" : "",
    describe_model: described ? "gemini-2.5-flash" : "",
    describe_status: described ? "described" : "pending",
    observed_at: "2026-07-01T00:00:00.000Z",
    org_id: TEN.orgId,
    workspace_id: TEN.workspaceId,
    project_id: TEN.projectId,
    last_update_date: "",
  };
}

function fakeTransport(responder: (sql: string) => object[]) {
  return {
    async query(sql: string): Promise<object[]> {
      return responder(sql);
    },
  };
}

// ── the collapsed Portkey header module (Wave-2 item 1) ────────────────────────

test("wave2 Portkey headers are a single shared module: embeddings re-export IS the portkey one", () => {
  // Both import paths resolve to the same definition after the duplicate file was deleted.
  assert.equal(URL_FROM_PORTKEY, URL_FROM_EMBEDDINGS);
  assert.equal(URL_FROM_PORTKEY, "https://api.portkey.ai/v1/embeddings");
  assert.deepEqual(buildFromPortkey("k", "c"), buildFromEmbeddings("k", "c"));
});

// ── listLatestDescribedVersions: the projection scan (Wave-2 item 4) ───────────

test("InMemoryHiveGraphStore.listLatestDescribedVersions returns the highest-seq described row and omits undescribed nectars", () => {
  const store = new InMemoryHiveGraphStore();
  const a = mintNectar(1000);
  const b = mintNectar(2000);
  store.insertIdentity(identityRow(a));
  store.insertIdentity(identityRow(b));
  // nectar A: pending seq 0 then described seq 1.
  store.appendVersion(versionRow(a, 0, "src/a.ts", "ha0", false));
  store.appendVersion(versionRow(a, 1, "src/a.ts", "ha1", true));
  // nectar B: only pending (never described).
  store.appendVersion(versionRow(b, 0, "src/b.ts", "hb0", false));

  const described = store.listLatestDescribedVersions(TEN);
  assert.equal(described.length, 1, "only the nectar with a described version appears");
  assert.equal(described[0]?.identity.nectar, a);
  assert.equal(described[0]?.version.seq, 1, "the highest-seq described row, not the pending latest");
  assert.equal(described[0]?.version.describeStatus, "described");
});

test("DeepLakeHiveGraphStore.listLatestDescribedVersions reduces client-side to latest described per nectar, scoped", async () => {
  const a = mintNectar(1000);
  const b = mintNectar(2000);
  const c = mintNectar(3000);
  const transport = fakeTransport((sql) => {
    if (sql.startsWith('SELECT * FROM "hive_graph"') && !sql.includes("hive_graph_versions")) {
      return [rawIdentity(a), rawIdentity(b), rawIdentity(c)];
    }
    if (sql.startsWith('SELECT * FROM "hive_graph_versions"')) {
      return [
        rawVersion(a, 0, "src/a.ts", "ha0", false),
        rawVersion(a, 1, "src/a.ts", "ha1", true),
        rawVersion(b, 0, "src/b.ts", "hb0", false),
        // nectar C: described seq 2 then a NEWER pending seq 3 -> described must win.
        rawVersion(c, 2, "src/c.ts", "hc2", true),
        rawVersion(c, 3, "src/c.ts", "hc3", false),
      ];
    }
    return [];
  });
  const store = new DeepLakeHiveGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const described = await store.listLatestDescribedVersions(TEN);
  const byNectar = new Map(described.map((lv) => [lv.identity.nectar, lv.version]));
  assert.equal(described.length, 2, "A and C have a described version; B does not");
  assert.equal(byNectar.get(a)?.seq, 1);
  assert.equal(byNectar.get(c)?.seq, 2, "the described seq 2 wins over the newer pending seq 3");
  assert.equal(byNectar.has(b), false, "an undescribed nectar is omitted from the described scan");
});

// ── async projection rebuild: the REAL wiring the CLI runs (Wave-2 item 4) ─────

test("011c-AC-3 rebuildProjectionAsync scans Deep Lake for latest described per nectar and keeps undescribed nectars as minimal entries", async () => {
  const root = tempRoot();
  try {
    const a = mintNectar(1000);
    const b = mintNectar(2000);
    const c = mintNectar(3000);
    const transport = fakeTransport((sql) => {
      if (sql.startsWith('SELECT * FROM "hive_graph"') && !sql.includes("hive_graph_versions")) {
        return [rawIdentity(a), rawIdentity(b), rawIdentity(c)];
      }
      if (sql.startsWith('SELECT * FROM "hive_graph_versions"')) {
        return [
          rawVersion(a, 0, "src/a.ts", "ha0", false),
          rawVersion(a, 1, "src/a.ts", "ha1", true),
          rawVersion(b, 0, "src/b.ts", "hb0", false),
          rawVersion(c, 2, "src/c.ts", "hc2", true),
          rawVersion(c, 3, "src/c.ts", "hc3", false),
        ];
      }
      return [];
    });
    const store = new DeepLakeHiveGraphStore({ credentials: FAKE_CREDENTIALS, transport });

    const { doc, path } = await rebuildProjectionAsync(store, TEN, {
      projectRoot: root,
      generatedAt: "2026-07-02T12:00:00.000Z",
    });

    assert.equal(Object.keys(doc.files).length, 3, "all three nectars are present");
    // A + C carry the latest described version verbatim.
    assert.equal(doc.files[a]?.title, "Title");
    assert.equal(doc.files[a]?.content_hash, "ha1");
    assert.equal(doc.files[c]?.content_hash, "hc2", "C carries the described seq 2, not the pending seq 3");
    assert.equal(doc.files[c]?.describe_model, "gemini-2.5-flash");
    // B is undescribed -> minimal entry (identity + path/content_hash, empty description).
    assert.equal(doc.files[b]?.title, "");
    assert.equal(doc.files[b]?.description, "");
    assert.equal(doc.files[b]?.content_hash, "hb0", "the undescribed nectar keeps a minimal entry, not dropped");

    const onDisk = readFileSync(path, "utf8");
    assert.ok(onDisk.includes('"title":"Title"'), "the file was written atomically with the described content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("011c-AC-3 two async regenerations of the same Deep Lake state are byte-identical modulo generated_at", async () => {
  const a = mintNectar(1000);
  const responder = (sql: string): object[] => {
    if (sql.startsWith('SELECT * FROM "hive_graph"') && !sql.includes("hive_graph_versions")) {
      return [rawIdentity(a)];
    }
    if (sql.startsWith('SELECT * FROM "hive_graph_versions"')) {
      return [rawVersion(a, 0, "src/a.ts", "ha0", true)];
    }
    return [];
  };
  const store = new DeepLakeHiveGraphStore({ credentials: FAKE_CREDENTIALS, transport: fakeTransport(responder) });

  const first = await buildProjectionFromAsyncStore(store, TEN, { generatedAt: "2026-07-02T12:00:00.000Z" });
  const second = await buildProjectionFromAsyncStore(store, TEN, { generatedAt: "2026-07-03T00:00:00.000Z" });

  assert.equal(canonicalSerializeExceptGeneratedAt(first), canonicalSerializeExceptGeneratedAt(second));
  assert.notEqual(first.generated_at, second.generated_at);
});

// ── /health provider state resolved once at assemble (Wave-2 item 3) ───────────

test("HealthState.setProviderState populates portkey.enabled + embeddings.provider; defaults stay honest", () => {
  const fresh = new HealthState();
  assert.equal(fresh.snapshot().portkey.enabled, false);
  assert.equal(fresh.snapshot().embeddings.provider, "off");

  const h = new HealthState();
  h.setProviderState({ portkeyEnabled: true, embeddingsProvider: "hosted" });
  const body = h.snapshot();
  assert.equal(body.portkey.enabled, true);
  assert.equal(body.embeddings.provider, "hosted");
});

test("assembleDaemon resolves provider state once and surfaces it in /health (no start, no sockets)", () => {
  const root = tempRoot();
  try {
    // Enabled Portkey + hosted embeddings via injected overrides (no env, no disk).
    const enabled = assembleDaemon({
      runtimeDir: root,
      log: () => {},
      portkey: { enabled: true, apiKey: "k", configId: "c", env: {} },
      embeddings: { selector: "hosted", env: {} },
    });
    const body = enabled.health.snapshot();
    assert.equal(body.portkey.enabled, true);
    assert.equal(body.embeddings.provider, "hosted");

    // Defaults: Portkey disabled, embeddings default selector (local) -> local-nomic label.
    const defaults = assembleDaemon({
      runtimeDir: root,
      log: () => {},
      portkey: { env: {} },
      embeddings: { env: {} },
    });
    const defaultBody = defaults.health.snapshot();
    assert.equal(defaultBody.portkey.enabled, false);
    assert.equal(defaultBody.embeddings.provider, "local-nomic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
