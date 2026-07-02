import { test } from "node:test";
import assert from "node:assert/strict";

import { EMBED_DIMS } from "../dist/hive-graph/model.js";
import { TransportError } from "../dist/hive-graph/deeplake-transport.js";
import { sqlLike } from "../dist/hive-graph/sql-guards.js";
import {
  DEFAULT_RECALL_LIMIT,
  MAX_RECALL_LIMIT,
  buildHiveGraphHydrateSql,
  buildHiveGraphLexicalArmSql,
  buildHiveGraphVectorSearchSql,
  buildLatestDescribedSubquery,
  resolveRecallLimit,
  searchHiveGraph,
  type QueryScope,
  type StorageQuery,
  type StorageRow,
} from "../dist/hive-graph/search.js";

const SCOPE: QueryScope = {
  orgId: "org-test",
  workspaceId: "ws-test",
  projectId: "proj-test",
};

function makeVector(seed = 0.01): number[] {
  return Array.from({ length: EMBED_DIMS }, (_, i) => seed + i * 0.0001);
}

function hitRow(
  id: string,
  overrides: Partial<Record<string, string>> = {},
): StorageRow {
  return {
    source: "nectar",
    id,
    path: overrides.path ?? `src/${id}.ts`,
    title: overrides.title ?? `Title ${id}`,
    body: overrides.body ?? `Body ${id}`,
    concepts: overrides.concepts ?? '["auth"]',
    content_hash: overrides.content_hash ?? `hash-${id}`,
  };
}

class RecordingStorage implements StorageQuery {
  readonly queries: { sql: string; scope: QueryScope }[] = [];
  readonly responder: (sql: string) => StorageRow[] | Error;

  constructor(responder: (sql: string) => StorageRow[] | Error) {
    this.responder = responder;
  }

  async query(sql: string, scope: QueryScope): Promise<readonly StorageRow[]> {
    this.queries.push({ sql, scope });
    const result = this.responder(sql);
    if (result instanceof Error) throw result;
    return result;
  }
}

// --- resolveRecallLimit ---

test("resolveRecallLimit defaults to 20 and clamps to MAX_RECALL_LIMIT", () => {
  assert.equal(resolveRecallLimit(undefined), DEFAULT_RECALL_LIMIT);
  assert.equal(resolveRecallLimit(Number.NaN), DEFAULT_RECALL_LIMIT);
  assert.equal(resolveRecallLimit(0), DEFAULT_RECALL_LIMIT);
  assert.equal(resolveRecallLimit(50), 50);
  assert.equal(resolveRecallLimit(999), MAX_RECALL_LIMIT);
});

// --- SQL builders (AC-012a.1.x) ---

test("012a-AC-1.1 lexical arm uses guarded ILIKE over title, description, and concepts", () => {
  const sql = buildHiveGraphLexicalArmSql("login", SCOPE, 20);
  assert.match(sql, /ILIKE '%login%'/);
  assert.match(sql, /v\.title ILIKE/);
  assert.match(sql, /v\.description ILIKE/);
  assert.match(sql, /v\.concepts ILIKE/);
  assert.match(sql, /FROM "hive_graph_versions" v/);
  assert.match(sql, /LIMIT 20/);
});

test("012a-AC-1.2 lexical arm applies MAX(seq) join and describe_status = described filter", () => {
  const sql = buildHiveGraphLexicalArmSql("auth", SCOPE, 10);
  const sub = buildLatestDescribedSubquery(SCOPE);
  assert.match(sql, new RegExp(sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sql, /describe_status = 'described'/);
  assert.match(sql, /MAX\(seq\) AS max_seq/);
  assert.match(sql, /org_id = 'org-test'/);
  assert.match(sql, /workspace_id = 'ws-test'/);
  assert.match(sql, /project_id = 'proj-test'/);
});

test("012a-AC-1.3 literal LIKE metacharacters are escaped via sqlLike and never act as wildcards", () => {
  const term = "50%_off";
  const sql = buildHiveGraphLexicalArmSql(term, SCOPE, 5);
  const escaped = sqlLike(term);
  assert.equal(escaped, "50\\%\\_off");
  assert.ok(sql.includes(`ILIKE '%${escaped}%'`));
  assert.ok(!sql.includes("ILIKE '%50%_off%'"));
});

test("012a-AC-1.1 injection payload in the search term stays inside a single ILIKE literal", () => {
  const sql = buildHiveGraphLexicalArmSql("'; DROP TABLE hive_graph_versions; --", SCOPE, 5);
  assert.ok(sql.includes("DROP TABLE hive\\_graph\\_versions"));
  assert.doesNotMatch(sql, /; DROP TABLE hive_graph_versions/);
});

// --- semantic arm (AC-012a.2.x) ---

test("012a-AC-2.1 semantic arm uses vector search then hydrate as two guarded queries", async () => {
  const nectarA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const nectarB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) {
      return [
        { id: nectarA, score: 0.9 },
        { id: nectarB, score: 0.8 },
      ];
    }
    if (sql.includes(" IN (")) {
      return [hitRow(nectarA), hitRow(nectarB)];
    }
    return [];
  });

  const result = await searchHiveGraph(
    "session refresh",
    SCOPE,
    undefined,
    {
      storage,
      embed: { embed: async () => makeVector() },
    },
  );

  assert.equal(result.degraded, false);
  assert.equal(result.hits.length, 2);
  assert.deepEqual(result.sources, ["nectar"]);
  const vectorQueries = storage.queries.filter((q) => q.sql.includes("<#>"));
  const hydrateQueries = storage.queries.filter((q) => q.sql.includes(" IN ("));
  assert.equal(vectorQueries.length, 1);
  assert.equal(hydrateQueries.length, 1);
  assert.match(vectorQueries[0]?.sql ?? "", /ARRAY_LENGTH\(v\.embedding, 1\) > 0/);
  assert.match(hydrateQueries[0]?.sql ?? "", /IN \('01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW'\)/);
});

test("012a-AC-2.2 non-768 embed vector skips semantic arm and returns degraded true", async () => {
  const nectar = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("ILIKE")) return [hitRow(nectar)];
    return [];
  });

  const wrongDim = Array.from({ length: 1024 }, () => 0.1);
  const result = await searchHiveGraph("login", SCOPE, undefined, {
    storage,
    embed: { embed: async () => wrongDim },
  });

  assert.equal(result.degraded, true);
  assert.equal(result.hits.length, 1);
  assert.equal(storage.queries.some((q) => q.sql.includes("<#>")), false);
});

test("012a-AC-2.3 both arms fuse by reciprocal rank and dedupe source+id", async () => {
  const sharedId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
  const lexicalOnly = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) return [{ id: sharedId, score: 0.95 }];
    if (sql.includes(" IN (")) return [hitRow(sharedId, { title: "Semantic title" })];
    if (sql.includes("ILIKE")) {
      return [hitRow(sharedId, { title: "Lexical title" }), hitRow(lexicalOnly)];
    }
    return [];
  });

  const result = await searchHiveGraph("jwt", SCOPE, 10, {
    storage,
    embed: { embed: async () => makeVector(0.02) },
  });

  assert.equal(result.degraded, false);
  assert.equal(result.hits.length, 2);
  const ids = result.hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(sharedId));
  assert.ok(ids.includes(lexicalOnly));
  assert.equal(result.hits[0]?.id, sharedId, "corroborated hit outranks lexical-only");
});

// --- embeddings off (AC-012a.3.x) ---

test("012a-AC-3.1 absent embed client runs lexical arm only", async () => {
  const nectar = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("ILIKE")) return [hitRow(nectar)];
    return [];
  });

  const result = await searchHiveGraph("logout", SCOPE, undefined, { storage });

  assert.equal(result.hits.length, 1);
  assert.equal(storage.queries.some((q) => q.sql.includes("<#>")), false);
});

test("012a-AC-3.2 lexical-only run returns degraded true", async () => {
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("ILIKE")) return [hitRow("01ARZ3NDEKTSV4RRFFQ69G5FB1")];
    return [];
  });

  const result = await searchHiveGraph("token", SCOPE, undefined, {
    storage,
    embed: { embed: async () => null },
  });

  assert.equal(result.degraded, true);
  assert.deepEqual(result.sources, ["nectar"]);
});

// --- fail-soft (AC-012a.4.x) ---

test("012a-AC-4.1 missing hive_graph_versions table returns empty degraded floor without throwing", async () => {
  const storage = new RecordingStorage(() => {
    throw new TransportError("query", 'relation "hive_graph_versions" does not exist');
  });

  const result = await searchHiveGraph("anything", SCOPE, undefined, {
    storage,
    embed: { embed: async () => makeVector(0.03) },
  });

  assert.deepEqual(result, { hits: [], sources: [], degraded: true });
});

test("012a-AC-4.2 empty query returns empty degraded floor", async () => {
  const storage = new RecordingStorage(() => {
    throw new Error("storage should not be called for empty query");
  });

  assert.deepEqual(await searchHiveGraph("", SCOPE, undefined, { storage }), {
    hits: [],
    sources: [],
    degraded: true,
  });
  assert.deepEqual(await searchHiveGraph("   ", SCOPE, undefined, { storage }), {
    hits: [],
    sources: [],
    degraded: true,
  });
});

// --- builder sanity ---

test("buildHiveGraphVectorSearchSql rejects wrong-dim vectors before SQL is built", () => {
  assert.throws(
    () => buildHiveGraphVectorSearchSql(Array.from({ length: 4 }, () => 1), SCOPE, 5),
    /768-dim/,
  );
});

test("buildHiveGraphHydrateSql requires at least one id", () => {
  assert.throws(() => buildHiveGraphHydrateSql([], SCOPE), /at least one id/);
});

test("searchHiveGraph default limit is 20 when omitted", async () => {
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("ILIKE")) {
      assert.match(sql, /LIMIT 20/);
      return [];
    }
    return [];
  });

  await searchHiveGraph("probe", SCOPE, undefined, {
    storage,
    embed: { embed: async () => null },
  });
});
