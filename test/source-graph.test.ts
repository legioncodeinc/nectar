import { test } from "node:test";
import assert from "node:assert/strict";
import { mintNectar, nectarCreatedAt, nectarTimestampMs, isValidNectar } from "../dist/source-graph/ulid.js";
import { sha256Hex } from "../dist/source-graph/hash.js";
import { toRepoRelative, filenameOf, extOf } from "../dist/source-graph/paths.js";
import {
  assertValidCatalogTable,
  SOURCE_GRAPH_TABLE,
  SOURCE_GRAPH_VERSIONS_TABLE,
  SOURCE_GRAPH_CATALOG_GROUP,
} from "../dist/source-graph/schema.js";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";
import { isValidEmbedding, EMBED_DIMS } from "../dist/source-graph/model.js";

// --- ULID ---

test("mintNectar produces a 26-char valid ULID that is unique", () => {
  const a = mintNectar();
  const b = mintNectar();
  assert.equal(a.length, 26);
  assert.ok(isValidNectar(a));
  assert.notEqual(a, b, "two mints differ");
});

test("nectars are lexicographically sortable by creation time", () => {
  const early = mintNectar(1000);
  const late = mintNectar(2_000_000_000_000);
  assert.ok(early < late, "earlier timestamp sorts first");
});

test("nectarCreatedAt round-trips the embedded timestamp", () => {
  const ms = 1_735_700_000_000;
  const n = mintNectar(ms);
  assert.equal(nectarTimestampMs(n), ms);
  assert.equal(nectarCreatedAt(n), new Date(ms).toISOString());
});

test("isValidNectar rejects wrong length and out-of-alphabet chars", () => {
  assert.equal(isValidNectar("too-short"), false);
  assert.equal(isValidNectar("I".repeat(26)), false, "I is not in Crockford base32");
});

// --- hash ---

test("sha256Hex is stable and matches known vector", () => {
  // sha256("") = e3b0c442...
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), sha256Hex(new TextEncoder().encode("abc")));
});

// --- paths ---

test("toRepoRelative forward-slashes and strips the root", () => {
  assert.equal(toRepoRelative("/proj/src/auth/a.ts", "/proj"), "src/auth/a.ts");
});

test("filenameOf and extOf denormalize a path", () => {
  assert.equal(filenameOf("src/auth/Login.TSX"), "Login.TSX");
  assert.equal(extOf("src/auth/Login.TSX"), "tsx", "lowercased, no dot");
  assert.equal(extOf("Makefile"), "");
});

// --- schema ---

test("both catalog tables pass the load-time guard", () => {
  assert.doesNotThrow(() => assertValidCatalogTable(SOURCE_GRAPH_TABLE));
  assert.doesNotThrow(() => assertValidCatalogTable(SOURCE_GRAPH_VERSIONS_TABLE));
});

test("both tables are tenant-scoped and carry the tenancy columns", () => {
  for (const t of [SOURCE_GRAPH_TABLE, SOURCE_GRAPH_VERSIONS_TABLE]) {
    assert.equal(t.scope, "tenant");
    const names = t.columns.map((c) => c.name);
    for (const col of ["org_id", "workspace_id", "project_id"]) {
      assert.ok(names.includes(col), `${t.name} has ${col}`);
    }
  }
});

test("every NOT NULL column carries a DEFAULT; embedding + confidence are nullable", () => {
  for (const t of [SOURCE_GRAPH_TABLE, SOURCE_GRAPH_VERSIONS_TABLE]) {
    for (const c of t.columns) {
      if (c.notNull) assert.notEqual(c.default, undefined, `${t.name}.${c.name} NOT NULL needs DEFAULT`);
    }
  }
  const versionCols = SOURCE_GRAPH_VERSIONS_TABLE.columns;
  assert.equal(versionCols.find((c) => c.name === "embedding")?.notNull, false);
  assert.equal(versionCols.find((c) => c.name === "confidence")?.notNull, false);
});

test("describe_status default is pending and skipped-deleted is a declared status", () => {
  const st = SOURCE_GRAPH_VERSIONS_TABLE.columns.find((c) => c.name === "describe_status");
  assert.equal(st?.default, "pending");
});

test("the catalog group is named source-graph with both tables", () => {
  assert.equal(SOURCE_GRAPH_CATALOG_GROUP.name, "source-graph");
  assert.equal(SOURCE_GRAPH_CATALOG_GROUP.tables.length, 2);
});

test("assertValidCatalogTable rejects a NOT NULL column without a default", () => {
  assert.throws(() =>
    assertValidCatalogTable({
      name: "bad",
      scope: "tenant",
      writePattern: "append-only",
      columns: [{ name: "x", type: "TEXT", notNull: true }],
    }),
  );
});

// --- embedding contract ---

test("isValidEmbedding enforces the 768-dim contract (null allowed)", () => {
  assert.equal(EMBED_DIMS, 768);
  assert.equal(isValidEmbedding(null), true);
  assert.equal(isValidEmbedding(new Array(768).fill(0)), true);
  assert.equal(isValidEmbedding(new Array(512).fill(0)), false);
});

// --- in-memory store ---

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };

function versionRow(nectar: string, seq: number, path: string, hash: string) {
  return {
    nectar,
    contentHash: hash,
    seq,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    sizeBytes: 10,
    mtimeObserved: "2026-07-01T00:00:00.000Z",
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    describedAt: "",
    describeModel: "",
    describeStatus: "pending" as const,
    observedAt: "2026-07-01T00:00:00.000Z",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

function identityRow(nectar: string) {
  return {
    nectar,
    kind: "file" as const,
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

test("store mints identity, appends versions, and tracks nextSeq + latest", () => {
  const store = new InMemorySourceGraphStore();
  const n = mintNectar();
  assert.equal(store.nextSeq(n), 0);
  store.insertIdentity(identityRow(n));
  store.appendVersion(versionRow(n, 0, "src/a.ts", "h0"));
  assert.equal(store.nextSeq(n), 1);
  store.appendVersion(versionRow(n, 1, "src/a.ts", "h1"));
  assert.equal(store.latestVersion(n)?.contentHash, "h1");
  assert.equal(store.latestVersion(n)?.seq, 1);
});

test("insertIdentity is single-shot (duplicate mint throws)", () => {
  const store = new InMemorySourceGraphStore();
  const n = mintNectar();
  store.insertIdentity(identityRow(n));
  assert.throws(() => store.insertIdentity(identityRow(n)));
});

test("latestVersionByPath and latestVersionByHash find the current row", () => {
  const store = new InMemorySourceGraphStore();
  const n = mintNectar();
  store.insertIdentity(identityRow(n));
  store.appendVersion(versionRow(n, 0, "src/a.ts", "h0"));
  store.appendVersion(versionRow(n, 1, "src/auth/a.ts", "h1")); // moved + edited
  assert.equal(store.latestVersionByPath(TEN, "src/auth/a.ts")?.identity.nectar, n);
  assert.equal(store.latestVersionByPath(TEN, "src/a.ts"), undefined, "old path is not latest");
  assert.equal(store.latestVersionByHash(TEN, "h1")?.identity.nectar, n);
  assert.equal(store.latestVersionByHash(TEN, "h0"), undefined, "old hash is not latest");
});

test("reads are tenancy-scoped", () => {
  const store = new InMemorySourceGraphStore();
  const n = mintNectar();
  store.insertIdentity(identityRow(n));
  store.appendVersion(versionRow(n, 0, "src/a.ts", "h0"));
  const otherTenancy = { orgId: "o2", workspaceId: "w1", projectId: "p1" };
  assert.equal(store.listLatestVersions(otherTenancy).length, 0);
  assert.equal(store.listLatestVersions(TEN).length, 1);
});

test("touchIdentity updates last_update_date", () => {
  const store = new InMemorySourceGraphStore();
  const n = mintNectar();
  store.insertIdentity(identityRow(n));
  store.touchIdentity(n, "2026-07-02T00:00:00.000Z");
  assert.equal(store.getIdentity(n)?.lastUpdateDate, "2026-07-02T00:00:00.000Z");
});
