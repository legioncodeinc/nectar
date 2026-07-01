import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqlStr, sqlLike, sqlIdent, sLiteral, eLiteral, sqlFloat4Array, sqlNum } from "../dist/source-graph/sql-guards.js";
import { buildCreateTableSql, SOURCE_GRAPH_TABLE, SOURCE_GRAPH_VERSIONS_TABLE } from "../dist/source-graph/schema.js";
import { TransportError, HttpDeepLakeTransport } from "../dist/source-graph/deeplake-transport.js";
import { isMissingTableError, withHeal } from "../dist/source-graph/deeplake-heal.js";
import {
  loadDeepLakeCredentials,
  DeepLakeCredentialsError,
  redactToken,
  DEFAULT_DEEPLAKE_API_URL,
} from "../dist/source-graph/deeplake-credentials.js";
import { DeepLakeSourceGraphStore } from "../dist/source-graph/deeplake-store.js";
import { mintNectar, nectarCreatedAt } from "../dist/source-graph/ulid.js";
import { sha256Hex } from "../dist/source-graph/hash.js";
import { filenameOf, extOf } from "../dist/source-graph/paths.js";

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- sql-guards (unit, no creds needed) ---

test("sqlStr doubles quotes/backslashes and strips control chars, preserving \\n\\t\\r", () => {
  assert.equal(sqlStr("O'Brien"), "O''Brien");
  assert.equal(sqlStr("a\\b"), "a\\\\b");
  assert.equal(sqlStr("a'; DROP TABLE x; --"), "a''; DROP TABLE x; --");
  assert.equal(sqlStr("line1\nline2\ttab\rcr"), "line1\nline2\ttab\rcr");
  assert.equal(sqlStr("bell\x07del\x7f"), "belldel");
});

test("sqlLike escapes LIKE metacharacters in addition to the sqlStr floor", () => {
  assert.equal(sqlLike("50%_off"), "50\\%\\_off");
  assert.equal(sqlLike("back\\slash"), "back\\\\slash");
});

test("sqlIdent accepts a valid identifier unchanged and rejects an unsafe one", () => {
  assert.equal(sqlIdent("source_graph"), "source_graph");
  assert.equal(sqlIdent("_col1"), "_col1");
  assert.throws(() => sqlIdent("bad; DROP TABLE x"), /Invalid SQL identifier/);
  assert.throws(() => sqlIdent("1leadingdigit"), /Invalid SQL identifier/);
});

test("sLiteral and eLiteral wrap an escaped value in the expected quote form", () => {
  assert.equal(sLiteral("a'b"), "'a''b'");
  assert.equal(eLiteral("a\\b"), "E'a\\\\b'");
});

test("sqlFloat4Array serializes a numeric vector as an ARRAY[...]::float4[] literal", () => {
  assert.equal(sqlFloat4Array([0.1, -0.2, 3]), "ARRAY[0.1,-0.2,3]::float4[]");
  assert.equal(sqlFloat4Array([]), "ARRAY[]::float4[]");
});

test("sqlFloat4Array rejects a non-finite or non-numeric entry instead of interpolating it bare", () => {
  assert.throws(() => sqlFloat4Array([1, Number.NaN, 2]), /Invalid SQL numeric value/);
  assert.throws(() => sqlFloat4Array([1, Number.POSITIVE_INFINITY]), /Invalid SQL numeric value/);
  // A value smuggled past the `number[]` type at runtime must still be rejected.
  assert.throws(
    () => sqlFloat4Array([1, "1); DROP TABLE source_graph_versions; --" as unknown as number]),
    /Invalid SQL numeric value/,
  );
});

test("sqlNum accepts finite numbers and rejects non-finite/non-numeric values", () => {
  assert.equal(sqlNum(0), "0");
  assert.equal(sqlNum(-3.5), "-3.5");
  assert.throws(() => sqlNum(Number.NaN), /Invalid SQL numeric value/);
  assert.throws(() => sqlNum(Number.POSITIVE_INFINITY), /Invalid SQL numeric value/);
  assert.throws(() => sqlNum("0; DROP TABLE x; --" as unknown as number), /Invalid SQL numeric value/);
});

// --- schema: buildCreateTableSql (unit, no creds needed) ---

test("buildCreateTableSql renders CREATE TABLE IF NOT EXISTS ... USING deeplake with NOT NULL DEFAULTs", () => {
  const sql = buildCreateTableSql(SOURCE_GRAPH_TABLE);
  assert.match(sql, /^CREATE TABLE IF NOT EXISTS "source_graph" \(/);
  assert.match(sql, /\) USING deeplake$/);
  assert.match(sql, /nectar TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /kind TEXT NOT NULL DEFAULT 'file'/);
});

test("buildCreateTableSql renders nullable columns (embedding/confidence) with no DEFAULT clause", () => {
  const sql = buildCreateTableSql(SOURCE_GRAPH_VERSIONS_TABLE);
  assert.match(sql, /embedding FLOAT4\[\](?! NOT NULL)(?! DEFAULT)/);
  assert.match(sql, /confidence REAL(?! NOT NULL)(?! DEFAULT)/);
  assert.match(sql, /seq BIGINT NOT NULL DEFAULT 0/);
});

// --- deeplake-heal: missing-table classification (unit, no creds needed) ---

test("isMissingTableError recognizes a missing-table query error and rejects other kinds/messages", () => {
  assert.equal(isMissingTableError(new TransportError("query", 'relation "source_graph" does not exist')), true);
  assert.equal(isMissingTableError(new TransportError("query", "no such table: source_graph")), true);
  assert.equal(isMissingTableError(new TransportError("query", "permission denied for relation source_graph")), false);
  assert.equal(isMissingTableError(new TransportError("connection", "relation does not exist")), false, "wrong kind");
  assert.equal(isMissingTableError(new TransportError("query", "syntax error near SELECT")), false);
});

test("withHeal creates the table and retries exactly once on a missing-table failure, then propagates a second failure", async () => {
  let calls = 0;
  const created: string[] = [];
  const fakeTransport = {
    async query(sql: string) {
      if (sql.startsWith("CREATE TABLE")) {
        created.push(sql);
        return [];
      }
      calls += 1;
      throw new TransportError("query", 'relation "source_graph" does not exist');
    },
  };
  await assert.rejects(
    () => withHeal(fakeTransport, SOURCE_GRAPH_TABLE, () => fakeTransport.query("SELECT 1")),
    (err: unknown) => err instanceof TransportError,
  );
  // One create attempt, and the write thunk ran twice (the original attempt + the one retry).
  assert.equal(created.length, 1, "creates the table exactly once");
  assert.equal(calls, 2, "retries the write exactly once after healing");
});

test("withHeal does not heal a non-missing-table failure", async () => {
  const fakeTransport = {
    async query() {
      throw new TransportError("query", "permission denied for relation source_graph");
    },
  };
  await assert.rejects(() => withHeal(fakeTransport, SOURCE_GRAPH_TABLE, () => fakeTransport.query()));
});

// --- deeplake-credentials (unit, uses a temp dir override — never the real ~/.deeplake) ---

test("loadDeepLakeCredentials fails closed with a clear reason when the file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "hivenectar-creds-missing-"));
  try {
    assert.throws(() => loadDeepLakeCredentials({ dir }), DeepLakeCredentialsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDeepLakeCredentials fails closed and lists exactly what's missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hivenectar-creds-partial-"));
  try {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ token: "abcd1234" }), "utf8");
    let caught: unknown;
    try {
      loadDeepLakeCredentials({ dir });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof DeepLakeCredentialsError, "throws the typed credentials error");
    assert.deepEqual((caught as InstanceType<typeof DeepLakeCredentialsError>).missing, ["orgId", "workspaceId"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDeepLakeCredentials loads a well-formed file and defaults apiUrl when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "hivenectar-creds-ok-"));
  try {
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({ token: "secret-token-xyz", orgId: "org1", workspaceId: "ws1" }),
      "utf8",
    );
    const creds = loadDeepLakeCredentials({ dir });
    assert.equal(creds.token, "secret-token-xyz");
    assert.equal(creds.orgId, "org1");
    assert.equal(creds.workspaceId, "ws1");
    assert.equal(creds.apiUrl, DEFAULT_DEEPLAKE_API_URL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactToken never echoes the token in full", () => {
  assert.equal(redactToken("abcdefgh1234"), "****1234");
  assert.equal(redactToken("ab"), "****");
});

// --- DeepLakeSourceGraphStore against a FAKE in-memory transport (unit, no creds/network needed) ---
//
// These tests inject a fake `QueryRunner` via `DeepLakeSourceGraphStoreOptions.transport`
// (the seam added for exactly this purpose) instead of hitting the network, so the
// store's OWN query-building and row-mapping logic runs and is asserted on directly -
// this is the coverage gap the quality pass flagged: before this seam existed, only
// `withHeal` against a bare fake table was exercised without real credentials, and
// `insertIdentity`'s duplicate-throw/race-detection, `nextSeq`'s MAX+1 math,
// `latestVersion`'s MAX(seq) selection, and `toIdentityRow`/`toVersionRow` never ran in
// any passing test. `FAKE_CREDENTIALS` is a placeholder object that is never read once
// a `transport` override is supplied (see the constructor).

const FAKE_CREDENTIALS = { apiUrl: "https://unused.invalid", token: "unused", orgId: "unused", workspaceId: "unused" };
const TEN = { orgId: "org-x", workspaceId: "ws-y", projectId: "proj-z" };

/** A fake `QueryRunner` that records every SQL string it receives and answers via `responder`. */
function fakeTransport(responder: (sql: string, callIndex: number) => object[]) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string): Promise<object[]> {
      const callIndex = calls.length;
      calls.push(sql);
      return responder(sql, callIndex);
    },
  };
}

/** A domain-shaped `SourceGraphRow` for calls INTO the store (e.g. `insertIdentity`). */
function identityRow(nectar: string, createdAt = "2026-07-01T00:00:00.000Z") {
  return {
    nectar,
    kind: "file" as const,
    createdAt,
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "2026-07-01T00:00:00.000Z",
  };
}

/** A domain-shaped `SourceGraphVersionRow` for calls INTO the store (e.g. `appendVersion`). */
function versionRow(nectar: string, seq: number, path: string, contentHash: string) {
  return {
    nectar,
    contentHash,
    seq,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    sizeBytes: 10,
    mtimeObserved: "2026-07-01T00:00:00.000Z",
    title: "",
    description: "",
    concepts: "[]",
    embedding: null as number[] | null,
    confidence: null as number | null,
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

/** A RAW `source_graph` row shaped as Deep Lake would return it (snake_case), for canned responses OUT of the fake. */
function rawIdentityRow(nectar: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

/** A RAW `source_graph_versions` row shaped as Deep Lake would return it (snake_case), for canned responses OUT of the fake. */
function rawVersionRow(nectar: string, seq: number, path: string, contentHash: string, overrides: Record<string, unknown> = {}) {
  return {
    nectar,
    content_hash: contentHash,
    seq,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    size_bytes: 10,
    mtime_observed: "2026-07-01T00:00:00.000Z",
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    described_at: "",
    describe_model: "",
    describe_status: "pending",
    observed_at: "2026-07-01T00:00:00.000Z",
    org_id: TEN.orgId,
    workspace_id: TEN.workspaceId,
    project_id: TEN.projectId,
    last_update_date: "",
    ...overrides,
  };
}

test("insertIdentity throws when the probe finds an existing nectar, and never issues an INSERT", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => [{ nectar }]); // every query "finds" the row
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  await assert.rejects(() => store.insertIdentity(identityRow(nectar)), /already exists/);
  assert.equal(transport.calls.length, 1, "only the probe SELECT ran; the INSERT never fired");
  assert.match(transport.calls[0] as string, /^SELECT nectar FROM "source_graph" WHERE nectar = '/);
  assert.ok((transport.calls[0] as string).includes(nectar), "the probe filters by the requested nectar");
});

test("insertIdentity runs probe -> insert -> re-verify for a fresh nectar and escapes a single quote in the value", async () => {
  // A real nectar (ulid.ts) never contains a quote, but the escaping floor must
  // hold regardless - this proves it defensively with a value crafted to break
  // out of the string literal if the escaping were ever skipped or reverted.
  const trickyNectar = "abc'; DROP TABLE source_graph; --";
  const transport = fakeTransport(() => []); // never "finds" anything -> proceeds to insert; verify then sees 0 rows
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  await store.insertIdentity(identityRow(trickyNectar));

  assert.equal(transport.calls.length, 3, "probe, insert, and re-verify each ran exactly once");
  const [probeSql, insertSql, verifySql] = transport.calls as string[];
  assert.match(probeSql as string, /^SELECT nectar FROM "source_graph" WHERE nectar = '/);
  assert.match(insertSql as string, /^INSERT INTO "source_graph" \(/);
  assert.match(verifySql as string, /^SELECT nectar FROM "source_graph" WHERE nectar = '/);
  for (const sql of transport.calls as string[]) {
    // The raw payload's quote must never survive unescaped - an unescaped quote
    // right there would close the literal early and let the trailing SQL run as
    // a second statement.
    assert.ok(!sql.includes("abc'; DROP TABLE"), "the raw unescaped payload must not appear");
    assert.ok(sql.includes("abc''; DROP TABLE source_graph; --"), "the doubled-quote-escaped literal is present instead");
  }
});

test("nextSeq returns 0 for a nectar with no version rows", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => []);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  assert.equal(await store.nextSeq(nectar), 0);
  assert.match(transport.calls[0] as string, /^SELECT seq FROM "source_graph_versions" WHERE nectar = '/);
});

test("nextSeq computes MAX(seq)+1 over out-of-order canned version rows", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => [{ seq: 1 }, { seq: 4 }, { seq: 0 }, { seq: 3 }]);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const seq = await store.nextSeq(nectar);
  assert.equal(seq, 5, "MAX(seq) across the canned rows is 4, so nextSeq is 5, not just rows[0]+1");
  assert.ok((transport.calls[0] as string).includes(nectar), "the query filters by the requested nectar");
});

test("latestVersion returns the row with the highest seq from out-of-order canned rows, correctly mapped", async () => {
  const nectar = mintNectar();
  const rows = [
    rawVersionRow(nectar, 1, "src/a.ts", "hash1"),
    rawVersionRow(nectar, 5, "src/a.ts", "hash5", { embedding: [0.1, 0.2, 0.3], confidence: 0.87 }),
    rawVersionRow(nectar, 3, "src/a.ts", "hash3"),
  ];
  const transport = fakeTransport(() => rows);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const latest = await store.latestVersion(nectar);
  assert.ok(latest, "a version is returned");
  assert.equal(latest?.seq, 5, "picks the highest seq, not the first row the fake happened to return");
  assert.equal(latest?.contentHash, "hash5");
  assert.deepEqual(latest?.embedding, [0.1, 0.2, 0.3], "a non-null embedding array round-trips through toVersionRow");
  assert.equal(latest?.confidence, 0.87, "a non-null confidence number round-trips through toVersionRow");
});

test("latestVersion maps a null embedding/confidence back to null (not 0 or NaN)", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => [rawVersionRow(nectar, 0, "src/a.ts", "h0")]);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const latest = await store.latestVersion(nectar);
  assert.equal(latest?.embedding, null);
  assert.equal(latest?.confidence, null);
});

test("latestVersion returns undefined when there are no version rows", async () => {
  const transport = fakeTransport(() => []);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });
  assert.equal(await store.latestVersion(mintNectar()), undefined);
});

test("getIdentity builds a SELECT against source_graph filtered by nectar, and maps the raw row (kind round-trips)", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => [rawIdentityRow(nectar, { kind: "directory" })]);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const identity = await store.getIdentity(nectar);
  assert.ok(identity);
  assert.equal(identity?.nectar, nectar);
  assert.equal(identity?.kind, "directory", "kind round-trips through toIdentityRow, not silently coerced to 'file'");
  assert.match(transport.calls[0] as string, /^SELECT \* FROM "source_graph" WHERE nectar = '.*' LIMIT 1$/);
});

test("getIdentity returns undefined when no row is found", async () => {
  const transport = fakeTransport(() => []);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });
  assert.equal(await store.getIdentity(mintNectar()), undefined);
});

test("appendVersion issues an INSERT against source_graph_versions carrying the row's values", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => []);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  await store.appendVersion(versionRow(nectar, 2, "src/auth/login.ts", "hash-abc"));

  assert.equal(transport.calls.length, 1);
  const sql = transport.calls[0] as string;
  assert.match(sql, /^INSERT INTO "source_graph_versions" \(/);
  assert.ok(sql.includes("'src/auth/login.ts'"), "the path value is present, quoted");
  assert.ok(sql.includes(nectar), "the nectar value is present");
});

test("touchIdentity issues an UPDATE against source_graph with the new timestamp", async () => {
  const nectar = mintNectar();
  const transport = fakeTransport(() => []);
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  await store.touchIdentity(nectar, "2026-07-02T00:00:00.000Z");

  assert.equal(transport.calls.length, 1);
  const sql = transport.calls[0] as string;
  assert.match(sql, /^UPDATE "source_graph" SET last_update_date = '2026-07-02T00:00:00\.000Z' WHERE nectar = '/);
  assert.ok(sql.includes(nectar));
});

test("listLatestVersions scopes both SELECTs by org_id/workspace_id/project_id and reduces to the latest per nectar", async () => {
  const nectarA = mintNectar();
  const nectarB = mintNectar();

  const transport = fakeTransport((sql) => {
    if (sql.startsWith('SELECT * FROM "source_graph"') && !sql.includes("source_graph_versions")) {
      return [rawIdentityRow(nectarA), rawIdentityRow(nectarB)];
    }
    if (sql.startsWith('SELECT * FROM "source_graph_versions"')) {
      return [
        rawVersionRow(nectarA, 0, "src/a.ts", "h0"),
        rawVersionRow(nectarA, 2, "src/a.ts", "h2"),
        rawVersionRow(nectarB, 1, "src/b.ts", "hb1"),
      ];
    }
    return [];
  });
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const list = await store.listLatestVersions(TEN);

  assert.equal(transport.calls.length, 2, "one SELECT against each table");
  for (const sql of transport.calls as string[]) {
    assert.ok(sql.includes(`org_id = '${TEN.orgId}'`), "org_id predicate present");
    assert.ok(sql.includes(`workspace_id = '${TEN.workspaceId}'`), "workspace_id predicate present");
    assert.ok(sql.includes(`project_id = '${TEN.projectId}'`), "project_id predicate is never omitted");
  }

  assert.equal(list.length, 2);
  const forA = list.find((lv) => lv.identity.nectar === nectarA);
  assert.equal(forA?.version.seq, 2, "nectarA's latest is seq 2, not the first row the fake returned for it");
  const forB = list.find((lv) => lv.identity.nectar === nectarB);
  assert.equal(forB?.version.seq, 1);
});

test("latestVersionByPath and latestVersionByHash filter listLatestVersions' reduced result", async () => {
  const nectarA = mintNectar();
  const nectarB = mintNectar();

  const transport = fakeTransport((sql) => {
    if (sql.startsWith('SELECT * FROM "source_graph"') && !sql.includes("source_graph_versions")) {
      return [rawIdentityRow(nectarA), rawIdentityRow(nectarB)];
    }
    if (sql.startsWith('SELECT * FROM "source_graph_versions"')) {
      return [rawVersionRow(nectarA, 0, "src/a.ts", "hA"), rawVersionRow(nectarB, 0, "src/b.ts", "hB")];
    }
    return [];
  });
  const store = new DeepLakeSourceGraphStore({ credentials: FAKE_CREDENTIALS, transport });

  const byPath = await store.latestVersionByPath(TEN, "src/b.ts");
  assert.equal(byPath?.identity.nectar, nectarB);

  const byHash = await store.latestVersionByHash(TEN, "hA");
  assert.equal(byHash?.identity.nectar, nectarA);

  const miss = await store.latestVersionByPath(TEN, "src/does-not-exist.ts");
  assert.equal(miss, undefined);
});

// --- live round-trip against the real ~/.deeplake credentials (skips gracefully if unavailable) ---

test("DeepLakeSourceGraphStore live round-trip: insert identity + append version + read back", async (t) => {
  let credentials: ReturnType<typeof loadDeepLakeCredentials>;
  try {
    credentials = loadDeepLakeCredentials();
  } catch (err) {
    t.skip(`Deep Lake credentials unavailable at ~/.deeplake/credentials.json, skipping live round-trip: ${describeErr(err)}`);
    return;
  }

  const tenancy = {
    orgId: credentials.orgId,
    workspaceId: credentials.workspaceId,
    projectId: `hivenectar-prd005-adapter-selftest-${Date.now()}`,
  };
  const nectar = mintNectar();
  const now = new Date().toISOString();
  const content = `hivenectar prd-005 adapter self-test @ ${now}`;
  const contentHash = sha256Hex(content);
  const path = "src/selftest/adapter-roundtrip.ts";

  const identity = {
    nectar,
    kind: "file" as const,
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };
  const version = {
    nectar,
    contentHash,
    seq: 0,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    sizeBytes: content.length,
    mtimeObserved: now,
    title: "PRD-005 adapter self-test",
    description: "A throwaway row written by the live round-trip test; safe to delete.",
    concepts: "[]",
    embedding: null,
    confidence: null,
    describedAt: "",
    describeModel: "",
    describeStatus: "pending" as const,
    observedAt: now,
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };

  const store = new DeepLakeSourceGraphStore({ credentials });

  try {
    await store.insertIdentity(identity);
    await store.appendVersion(version);

    const seq = await store.nextSeq(nectar);
    assert.equal(seq, 1, "nextSeq is 1 after one appended version");

    const readIdentity = await store.getIdentity(nectar);
    assert.ok(readIdentity, "identity round-trips");
    assert.equal(readIdentity?.nectar, nectar);
    assert.equal(readIdentity?.projectId, tenancy.projectId);

    const readVersion = await store.latestVersion(nectar);
    assert.ok(readVersion, "version round-trips");
    assert.equal(readVersion?.contentHash, contentHash);
    assert.equal(readVersion?.path, path);
    assert.equal(readVersion?.seq, 0);

    const byPath = await store.latestVersionByPath(tenancy, path);
    assert.equal(byPath?.identity.nectar, nectar, "latestVersionByPath finds the row");

    const byHash = await store.latestVersionByHash(tenancy, contentHash);
    assert.equal(byHash?.identity.nectar, nectar, "latestVersionByHash finds the row");

    const list = await store.listLatestVersions(tenancy);
    assert.ok(
      list.some((lv) => lv.identity.nectar === nectar),
      "listLatestVersions includes the freshly-written row",
    );

    await assert.rejects(() => store.insertIdentity(identity), /already exists/, "duplicate insertIdentity throws");
  } catch (err) {
    if (err instanceof TransportError) {
      t.skip(`Deep Lake unreachable, skipping live round-trip: ${err.message}`);
      return;
    }
    throw err;
  } finally {
    // Best-effort cleanup; a cleanup failure must never fail this test — the
    // assertions above already ran and are the source of truth. Each DELETE
    // is attempted independently (its own try/catch) so a missing
    // `source_graph_versions` table (e.g. appendVersion never got far enough
    // to create it) does not short-circuit the `source_graph` cleanup too.
    const transport = new HttpDeepLakeTransport({
      endpoint: credentials.apiUrl,
      token: credentials.token,
      orgId: credentials.orgId,
      workspaceId: credentials.workspaceId,
    });
    try {
      await transport.query(
        `DELETE FROM "${sqlIdent(SOURCE_GRAPH_VERSIONS_TABLE.name)}" WHERE nectar = ${sLiteral(nectar)}`,
      );
    } catch (cleanupErr) {
      console.log(
        `[source-graph-deeplake.test] best-effort cleanup of source_graph_versions failed for nectar ${nectar} (ignored): ${describeErr(cleanupErr)}`,
      );
    }
    try {
      await transport.query(`DELETE FROM "${sqlIdent(SOURCE_GRAPH_TABLE.name)}" WHERE nectar = ${sLiteral(nectar)}`);
    } catch (cleanupErr) {
      console.log(
        `[source-graph-deeplake.test] best-effort cleanup of source_graph failed for nectar ${nectar} (ignored): ${describeErr(cleanupErr)}`,
      );
    }
  }
});
