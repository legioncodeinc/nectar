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
  // NEC-042 item 5 / AC-018l.12: every ILIKE carries an explicit ESCAPE clause.
  assert.match(sql, /ORDER BY CASE WHEN v\.title ILIKE '%login%' ESCAPE '\\' THEN 0/);
  assert.match(sql, /WHEN v\.description ILIKE '%login%' ESCAPE '\\' THEN 1/);
  assert.match(sql, /WHEN v\.concepts ILIKE '%login%' ESCAPE '\\' THEN 2/);
  assert.match(sql, /ELSE 3 END ASC, v\.nectar ASC/);
  assert.match(sql, /LIMIT 20/);
});

test("AC-018l.12 the lexical ILIKE arm carries an explicit ESCAPE clause (NEC-042 item 5)", () => {
  // A term with LIKE metacharacters: the escape char pins `\%`/`\_` as literals.
  const sql = buildHiveGraphLexicalArmSql("50%_off", SCOPE, 5);
  const escapeMatches = sql.match(/ILIKE '[^']*' ESCAPE '\\'/g) ?? [];
  // Three ILIKE expressions in WHERE + three in the ORDER BY ranking = six.
  assert.equal(escapeMatches.length, 6, "every ILIKE (WHERE + ranking) carries ESCAPE '\\'");
  assert.ok(!/ILIKE '[^']*'(?! ESCAPE)/.test(sql), "no ILIKE is left without an ESCAPE clause");
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
  assert.equal(result.reason, "ok");
  assert.equal(result.arms.semantic.status, "ok");
  assert.equal(result.arms.lexical.status, "ok");
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
  assert.equal(result.reason, "semantic-unavailable");
  assert.equal(result.arms.semantic.status, "not-run");
  assert.equal(result.arms.lexical.status, "ok");
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
  assert.equal(result.reason, "ok");
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

  assert.equal(result.degraded, true);
  assert.equal(result.reason, "semantic-unavailable");
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
  assert.equal(result.reason, "semantic-unavailable");
  assert.deepEqual(result.errorSources, []);
  assert.equal(result.arms.semantic.status, "not-run");
  assert.equal(result.arms.lexical.status, "ok");
  assert.deepEqual(result.sources, ["nectar"]);
});

// --- fail-soft (AC-012a.4.x) ---

test("012a-AC-4.1 missing hive_graph_versions table returns classified empty floor without throwing", async () => {
  const storage = new RecordingStorage(() => {
    throw new TransportError("query", 'relation "hive_graph_versions" does not exist');
  });

  const result = await searchHiveGraph("anything", SCOPE, undefined, {
    storage,
    embed: { embed: async () => makeVector(0.03) },
  });

  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.degraded, false);
  assert.equal(result.reason, "missing-table");
  assert.equal(result.arms.semantic.status, "missing-table");
  assert.equal(result.arms.lexical.status, "missing-table");
});

test("012a-AC-4.2 empty query returns empty degraded floor", async () => {
  const storage = new RecordingStorage(() => {
    throw new Error("storage should not be called for empty query");
  });

  const empty = await searchHiveGraph("", SCOPE, undefined, { storage });
  assert.deepEqual(empty.hits, []);
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.degraded, true);
  assert.equal(empty.reason, undefined);
  assert.equal(empty.arms, undefined);

  const blank = await searchHiveGraph("   ", SCOPE, undefined, { storage });
  assert.deepEqual(blank.hits, []);
  assert.deepEqual(blank.sources, []);
  assert.equal(blank.degraded, true);
  assert.equal(blank.reason, undefined);
});

test("018h-AC-3 semantic arm storage error degrades while lexical results are served", async () => {
  const lexicalId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) throw new TransportError("query", "401: unauthorized", 401);
    if (sql.includes("ILIKE")) return [hitRow(lexicalId)];
    return [];
  });

  const result = await searchHiveGraph("auth", SCOPE, 5, {
    storage,
    embed: { embed: async () => makeVector(0.04) },
  });

  assert.equal(result.degraded, true);
  assert.equal(result.reason, "backend-error");
  assert.deepEqual(result.errorSources, ["semantic"]);
  assert.equal(result.arms.semantic.status, "error");
  assert.match(result.arms.semantic.reason ?? "", /401/);
  assert.equal(result.arms.lexical.status, "ok");
  assert.deepEqual(result.hits.map((hit) => hit.id), [lexicalId]);
});

test("018h-AC-4 missing semantic table is classified without degrading lexical results", async () => {
  const lexicalId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) throw new TransportError("query", 'relation "hive_graph_versions" does not exist');
    if (sql.includes("ILIKE")) return [hitRow(lexicalId)];
    return [];
  });

  const result = await searchHiveGraph("auth", SCOPE, 5, {
    storage,
    embed: { embed: async () => makeVector(0.05) },
  });

  assert.equal(result.degraded, false);
  assert.equal(result.reason, "ok");
  assert.deepEqual(result.errorSources, []);
  assert.equal(result.arms.semantic.status, "missing-table");
  assert.equal(result.arms.lexical.status, "ok");
  assert.deepEqual(result.hits.map((hit) => hit.id), [lexicalId]);
});

test("018h-AC-5 both arms failing reports backend-error instead of no matches", async () => {
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) throw new TransportError("query", "500: vector backend failed", 500);
    if (sql.includes("ILIKE")) throw new TransportError("query", "500: lexical backend failed", 500);
    return [];
  });

  const result = await searchHiveGraph("auth", SCOPE, 5, {
    storage,
    embed: { embed: async () => makeVector(0.06) },
  });

  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.degraded, true);
  assert.equal(result.reason, "backend-error");
  assert.deepEqual(result.errorSources, ["semantic", "lexical"]);
  assert.equal(result.arms.semantic.status, "error");
  assert.equal(result.arms.lexical.status, "error");
});

test("018h-AC-6/7 lexical arm orders by match field priority and nectar tiebreaker", async () => {
  const sql = buildHiveGraphLexicalArmSql("auth", SCOPE, 2);
  assert.match(sql, /ORDER BY CASE/);
  assert.match(sql, /WHEN v\.title ILIKE '%auth%' ESCAPE '\\' THEN 0/);
  assert.match(sql, /WHEN v\.description ILIKE '%auth%' ESCAPE '\\' THEN 1/);
  assert.match(sql, /WHEN v\.concepts ILIKE '%auth%' ESCAPE '\\' THEN 2/);
  assert.match(sql, /ELSE 3 END ASC, v\.nectar ASC LIMIT 2/);

  const lexicalRows = [
    hitRow("01ARZ3NDEKTSV4RRFFQ69G5FB4", { title: "auth title" }),
    hitRow("01ARZ3NDEKTSV4RRFFQ69G5FB5", { body: "auth description" }),
  ];
  const storage = new RecordingStorage((querySql) => {
    if (querySql.includes("ILIKE")) return lexicalRows;
    return [];
  });

  const first = await searchHiveGraph("auth", SCOPE, 2, { storage });
  const second = await searchHiveGraph("auth", SCOPE, 2, { storage });

  assert.deepEqual(first.hits.map((hit) => hit.id), second.hits.map((hit) => hit.id));
  assert.deepEqual(first.hits.map((hit) => hit.id), lexicalRows.map((row) => String(row.id)));
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

// --- PRD-018i: embed_model mismatch filtering (NEC-018 AC-018i.3) ---

test("018i.3 vector arm SQL selects embed_model for provenance filtering", () => {
  const sql = buildHiveGraphVectorSearchSql(makeVector(), SCOPE, 10);
  assert.match(sql, /v\.embed_model AS embed_model/);
});

test("018i.3 rows whose embed_model disagrees are excluded and queued for re-embed", async () => {
  const nectarA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const nectarB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const reembed: string[] = [];
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) {
      return [
        { id: nectarA, score: 0.9, embed_model: "model-A" },
        { id: nectarB, score: 0.8, embed_model: "model-A" },
      ];
    }
    return []; // lexical + hydrate empty
  });
  const result = await searchHiveGraph("q", SCOPE, undefined, {
    storage,
    embed: { embed: async () => makeVector() },
    activeEmbedModel: "model-B",
    onReembedNeeded: (ids) => reembed.push(...ids),
  });
  assert.equal(result.hits.length, 0, "cross-space (model-A) rows do not contribute under active model-B");
  assert.deepEqual(reembed.slice().sort(), [nectarA, nectarB].slice().sort(), "mismatched nectars were queued for re-embed");
});

test("018i.3 matching embed_model rows still contribute and are not re-embed-queued", async () => {
  const nectarA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const reembed: string[] = [];
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) return [{ id: nectarA, score: 0.9, embed_model: "model-B" }];
    if (sql.includes(" IN (")) return [hitRow(nectarA)];
    return [];
  });
  const result = await searchHiveGraph("q", SCOPE, undefined, {
    storage,
    embed: { embed: async () => makeVector() },
    activeEmbedModel: "model-B",
    onReembedNeeded: (ids) => reembed.push(...ids),
  });
  assert.ok(result.hits.some((h) => h.id === nectarA), "a row matching the active model contributes");
  assert.equal(reembed.length, 0);
});

test("018i.3 a null embed_model (pre-provenance row) is treated as compatible", async () => {
  const nectarA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const reembed: string[] = [];
  const storage = new RecordingStorage((sql) => {
    if (sql.includes("<#>")) return [{ id: nectarA, score: 0.9 }]; // no embed_model
    if (sql.includes(" IN (")) return [hitRow(nectarA)];
    return [];
  });
  const result = await searchHiveGraph("q", SCOPE, undefined, {
    storage,
    embed: { embed: async () => makeVector() },
    activeEmbedModel: "model-B",
    onReembedNeeded: (ids) => reembed.push(...ids),
  });
  assert.ok(result.hits.some((h) => h.id === nectarA), "an unstamped row is not excluded");
  assert.equal(reembed.length, 0);
});
