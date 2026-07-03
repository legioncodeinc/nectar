/**
 * Standalone hive-graph search engine (PRD-012a).
 *
 * Runs guarded lexical ILIKE + optional `<#>` vector semantic search over
 * `hive_graph_versions`, filtered to the latest described version per nectar.
 * Mirrors honeycomb recall arm mechanics without importing honeycomb (decision #2).
 */
import { EMBED_DIMS, isValidEmbedding } from "./model.js";
import { HIVE_GRAPH_VERSIONS_TABLE } from "./schema.js";
import { isMissingTableError } from "./deeplake-heal.js";
import { TransportError } from "./deeplake-transport.js";
import { sLiteral, sqlFloat4Array, sqlIdent, sqlLike } from "./sql-guards.js";
import type {
  EmbedClient,
  HiveGraphHit,
  HiveGraphSearchArmName,
  HiveGraphSearchArmStatus,
  HiveGraphSearchDeps,
  HiveGraphSearchReason,
  HiveGraphSearchResult,
  QueryScope,
  StorageQuery,
  StorageRow,
} from "./search-types.js";

export type {
  EmbedClient,
  HiveGraphHit,
  HiveGraphSearchDeps,
  HiveGraphSearchResult,
  QueryScope,
  StorageQuery,
} from "./search-types.js";

/** Default result cap when the caller omits `limit` (decision #34). */
export const DEFAULT_RECALL_LIMIT = 20;
/** Hard ceiling on search hits (fat-finger guard). */
export const MAX_RECALL_LIMIT = 200;
/** RRF constant `k` (mirrors honeycomb recall). */
export const RRF_K = 60;
/**
 * Default recall RRF multiplier when `~/.honeycomb/nectar.json`'s
 * `nectar_rrf_multiplier` knob is unset (PRD-018k / NEC-041). `1` is neutral:
 * this standalone two-arm engine applies no cross-arm class weighting
 * (PRD-012a), so the multiplier is a config surface for a future cross-table
 * fusion arm, not a value that alters fusion today.
 */
export const DEFAULT_RRF_MULTIPLIER = 1;
/** Vector arm over-fetch multiplier (mirrors honeycomb `vector.ts`). */
export const DEFAULT_OVERFETCH_MULTIPLIER = 3;

const HIVE_GRAPH_VERSIONS = sqlIdent(HIVE_GRAPH_VERSIONS_TABLE.name);
const SOURCE_NECTAR = "nectar" as const;
const SEMANTIC_ARM = "semantic" as const;
const LEXICAL_ARM = "lexical" as const;

/**
 * Resolve the effective recall RRF multiplier from the search deps (PRD-018k /
 * NEC-041 AC-018k.7): the loaded `nectar_rrf_multiplier` value when it is a
 * finite positive number, else {@link DEFAULT_RRF_MULTIPLIER}. This is where the
 * config knob plugs into the recall path; fusion does not yet weight by it.
 */
export function resolveRrfMultiplier(deps: Pick<HiveGraphSearchDeps, "rrfMultiplier">): number {
  const m = deps.rrfMultiplier;
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : DEFAULT_RRF_MULTIPLIER;
}

/** Clamp a caller-supplied limit into `[1, MAX_RECALL_LIMIT]`, defaulting a missing/bad value. */
export function resolveRecallLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_RECALL_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated < 1) return DEFAULT_RECALL_LIMIT;
  return Math.min(truncated, MAX_RECALL_LIMIT);
}

function cell(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function tenancyPredicate(scope: QueryScope, prefix = ""): string {
  const p = prefix === "" ? "" : `${prefix}.`;
  return (
    `${p}${sqlIdent("org_id")} = ${sLiteral(scope.orgId)} AND ` +
    `${p}${sqlIdent("workspace_id")} = ${sLiteral(scope.workspaceId)} AND ` +
    `${p}${sqlIdent("project_id")} = ${sLiteral(scope.projectId)}`
  );
}

/**
 * Latest described version per nectar (`MAX(seq)`), scoped by tenancy.
 * Load-bearing shape from `recall-integration.md`.
 */
export function buildLatestDescribedSubquery(scope: QueryScope): string {
  const nectarCol = sqlIdent("nectar");
  const seqCol = sqlIdent("seq");
  const statusCol = sqlIdent("describe_status");
  return (
    `SELECT ${nectarCol}, MAX(${seqCol}) AS max_seq ` +
    `FROM "${HIVE_GRAPH_VERSIONS}" ` +
    `WHERE ${statusCol} = ${sLiteral("described")} AND ${tenancyPredicate(scope)} ` +
    `GROUP BY ${nectarCol}`
  );
}

/**
 * Guarded lexical arm over `title`, `description`, and `concepts` with the
 * latest-per-nectar join. Exported for injection-safety tests.
 */
export function buildHiveGraphLexicalArmSql(term: string, scope: QueryScope, perArmLimit: number): string {
  const pattern = `'%${sqlLike(term)}%'`;
  const latest = buildLatestDescribedSubquery(scope);
  const perArm = Math.max(1, Math.trunc(perArmLimit));
  const nectarCol = sqlIdent("nectar");
  const seqCol = sqlIdent("seq");
  const pathCol = sqlIdent("path");
  const titleCol = sqlIdent("title");
  const descCol = sqlIdent("description");
  const conceptsCol = sqlIdent("concepts");
  const hashCol = sqlIdent("content_hash");
  // NEC-042 item 5 / AC-018l.12: `sqlLike` emits backslash escapes for `%`/`_`/`\`
  // inside a plain literal, but whether `\%` is honored as a literal is
  // dialect-dependent WITHOUT an explicit ESCAPE clause. Declaring `ESCAPE '\'`
  // on every ILIKE pins the backslash as the escape char, so an escaped
  // metacharacter can never widen the match. Applied to every ILIKE (the WHERE
  // arm and the ORDER BY ranking) so match and ranking agree.
  const like = (col: string): string => `${col} ILIKE ${pattern} ESCAPE '\\'`;
  return (
    `SELECT ${sLiteral(SOURCE_NECTAR)} AS source, v.${nectarCol} AS id, v.${pathCol} AS path, ` +
    `v.${titleCol} AS title, v.${descCol} AS body, v.${conceptsCol} AS concepts, v.${hashCol} AS content_hash ` +
    `FROM "${HIVE_GRAPH_VERSIONS}" v ` +
    `INNER JOIN (${latest}) latest ON v.${nectarCol} = latest.${nectarCol} AND v.${seqCol} = latest.max_seq ` +
    `WHERE (${like(`v.${titleCol}`)} OR ${like(`v.${descCol}`)} OR ${like(`v.${conceptsCol}`)}) ` +
    `AND ${tenancyPredicate(scope, "v")} ` +
    `ORDER BY CASE ` +
    `WHEN ${like(`v.${titleCol}`)} THEN 0 ` +
    `WHEN ${like(`v.${descCol}`)} THEN 1 ` +
    `WHEN ${like(`v.${conceptsCol}`)} THEN 2 ` +
    `ELSE 3 END ASC, v.${nectarCol} ASC ` +
    `LIMIT ${perArm}`
  );
}

/** Step 1 of the semantic arm: `<#>` cosine match returning scored nectar ids only. */
export function buildHiveGraphVectorSearchSql(
  queryVector: readonly number[],
  scope: QueryScope,
  perArmLimit: number,
  overFetchMultiplier = DEFAULT_OVERFETCH_MULTIPLIER,
): string {
  assertQueryVectorDim(queryVector);
  const latest = buildLatestDescribedSubquery(scope);
  const vecLit = sqlFloat4Array(queryVector);
  const nectarCol = sqlIdent("nectar");
  const seqCol = sqlIdent("seq");
  const embCol = sqlIdent("embedding");
  const fetchLimit = Math.max(1, Math.trunc(perArmLimit)) * Math.max(1, Math.trunc(overFetchMultiplier));
  // `<#>` between a FLOAT4[] column and a FLOAT4[] literal is cosine
  // SIMILARITY on this backend, sorted DESC (official pg_deeplake SQL
  // reference, docs.deeplake.ai "The <#> operator" table), and the live probe
  // in test/hive-graph-search-live.test.ts confirms the near vector ranks
  // first under this formula. The corpus's earlier "cosine distance, ascend"
  // phrasing was wrong (NEC-005); the docs pass corrects it. Mapping
  // similarity [-1, 1] to score [0, 1] preserves DESC = most similar first.
  const scoreSql = `((1 + (v.${embCol} <#> ${vecLit})) / 2)`;
  const embedModelCol = sqlIdent("embed_model");
  return (
    `SELECT v.${nectarCol} AS id, ${scoreSql} AS score, v.${embedModelCol} AS embed_model ` +
    `FROM "${HIVE_GRAPH_VERSIONS}" v ` +
    `INNER JOIN (${latest}) latest ON v.${nectarCol} = latest.${nectarCol} AND v.${seqCol} = latest.max_seq ` +
    `WHERE ARRAY_LENGTH(v.${embCol}, 1) > 0 AND ${tenancyPredicate(scope, "v")} ` +
    `ORDER BY score DESC ` +
    `LIMIT ${fetchLimit}`
  );
}

/** Step 2 of the semantic arm: hydrate matched nectars' display columns. */
export function buildHiveGraphHydrateSql(ids: readonly string[], scope: QueryScope): string {
  if (ids.length === 0) {
    throw new Error("buildHiveGraphHydrateSql requires at least one id");
  }
  const latest = buildLatestDescribedSubquery(scope);
  const inList = ids.map((id) => sLiteral(id)).join(", ");
  const nectarCol = sqlIdent("nectar");
  const seqCol = sqlIdent("seq");
  const pathCol = sqlIdent("path");
  const titleCol = sqlIdent("title");
  const descCol = sqlIdent("description");
  const conceptsCol = sqlIdent("concepts");
  const hashCol = sqlIdent("content_hash");
  return (
    `SELECT ${sLiteral(SOURCE_NECTAR)} AS source, v.${nectarCol} AS id, v.${pathCol} AS path, ` +
    `v.${titleCol} AS title, v.${descCol} AS body, v.${conceptsCol} AS concepts, v.${hashCol} AS content_hash ` +
    `FROM "${HIVE_GRAPH_VERSIONS}" v ` +
    `INNER JOIN (${latest}) latest ON v.${nectarCol} = latest.${nectarCol} AND v.${seqCol} = latest.max_seq ` +
    `WHERE v.${nectarCol} IN (${inList}) AND ${tenancyPredicate(scope, "v")}`
  );
}

function assertQueryVectorDim(vector: readonly number[]): void {
  if (vector.length !== EMBED_DIMS) {
    throw new Error(`Query vector must be ${EMBED_DIMS}-dim; got ${vector.length}`);
  }
  for (const v of vector) {
    if (!Number.isFinite(v)) {
      throw new Error(`Query vector must be ${EMBED_DIMS}-dim; got non-finite entry`);
    }
  }
}

function rowToHit(row: StorageRow): HiveGraphHit | null {
  const id = cell(row.id);
  if (id === "") return null;
  const source = cell(row.source);
  if (source !== SOURCE_NECTAR && source !== "") return null;
  return {
    source: SOURCE_NECTAR,
    id,
    path: cell(row.path),
    title: cell(row.title),
    body: cell(row.body),
    concepts: cell(row.concepts),
    content_hash: cell(row.content_hash),
  };
}

interface RankedArmEntry {
  readonly hit: HiveGraphHit;
}

interface RankedArm {
  readonly entries: readonly RankedArmEntry[];
}

interface ArmQueryResult {
  readonly rows: readonly StorageRow[];
  readonly status: HiveGraphSearchArmStatus;
}

interface SemanticArmResult {
  readonly entries: readonly RankedArmEntry[];
  readonly status: HiveGraphSearchArmStatus;
}

function fusionKey(source: string, id: string): string {
  return `${source}\0${id}`;
}

/** RRF fusion scoped to this engine's two arms (no cross-table arm-class weighting). */
function fuseHits(arms: readonly RankedArm[], limit: number): { hits: HiveGraphHit[]; sources: ("nectar")[] } {
  const docs = new Map<string, { hit: HiveGraphHit; score: number }>();
  for (const arm of arms) {
    arm.entries.forEach((entry, index) => {
      const rank = index + 1;
      const contribution = 1 / (RRF_K + rank);
      const key = fusionKey(entry.hit.source, entry.hit.id);
      const existing = docs.get(key);
      if (existing === undefined) {
        docs.set(key, { hit: entry.hit, score: contribution });
      } else {
        existing.score += contribution;
      }
    });
  }

  const ordered = [...docs.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0;
  });

  const hits: HiveGraphHit[] = [];
  for (const doc of ordered) {
    if (hits.length >= limit) break;
    hits.push(doc.hit);
  }
  const sources: ("nectar")[] = hits.length > 0 ? [SOURCE_NECTAR] : [];
  return { hits, sources };
}

function rowsToRankedArm(rows: readonly StorageRow[]): RankedArm {
  const entries: RankedArmEntry[] = [];
  for (const row of rows) {
    const hit = rowToHit(row);
    if (hit !== null) entries.push({ hit });
  }
  return { entries };
}

function armOk(rows: readonly StorageRow[]): HiveGraphSearchArmStatus {
  return { status: "ok", rows: rows.length };
}

function armNotRun(reason: string): HiveGraphSearchArmStatus {
  return { status: "not-run", rows: 0, reason };
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyArmFailure(err: unknown): HiveGraphSearchArmStatus {
  const reason = errorReason(err);
  if (err instanceof TransportError && isMissingTableError(err)) {
    return { status: "missing-table", rows: 0, reason };
  }
  if (err instanceof Error && /table does not exist|no such table/i.test(err.message)) {
    return { status: "missing-table", rows: 0, reason };
  }
  return { status: "error", rows: 0, reason };
}

function resultReason(
  hits: readonly HiveGraphHit[],
  semanticStatus: HiveGraphSearchArmStatus,
  lexicalStatus: HiveGraphSearchArmStatus,
): HiveGraphSearchReason {
  if (semanticStatus.status === "error" || lexicalStatus.status === "error") return "backend-error";
  if (hits.length > 0 && semanticStatus.status === "not-run") return "semantic-unavailable";
  if (hits.length > 0) return "ok";
  if (semanticStatus.status === "missing-table" || lexicalStatus.status === "missing-table") return "missing-table";
  return "no-matches";
}

function errorSources(
  semanticStatus: HiveGraphSearchArmStatus,
  lexicalStatus: HiveGraphSearchArmStatus,
): HiveGraphSearchArmName[] {
  const sources: HiveGraphSearchArmName[] = [];
  if (semanticStatus.status === "error") sources.push(SEMANTIC_ARM);
  if (lexicalStatus.status === "error") sources.push(LEXICAL_ARM);
  return sources;
}

/** Per-arm fail-soft: missing table or backend error returns a classified status. */
async function runArmFailSoft(
  storage: StorageQuery,
  sql: string,
  scope: QueryScope,
  onSuccess?: () => void,
): Promise<ArmQueryResult> {
  try {
    const rows = [...(await storage.query(sql, scope))];
    onSuccess?.();
    return { rows, status: armOk(rows) };
  } catch (err: unknown) {
    return { rows: [], status: classifyArmFailure(err) };
  }
}

async function resolveQueryVector(query: string, embed: EmbedClient | undefined): Promise<number[] | null> {
  if (embed === undefined) return null;
  try {
    const vec = await embed.embed(query);
    if (vec === null || !isValidEmbedding(vec)) return null;
    return vec;
  } catch {
    return null;
  }
}

interface ScoredId {
  readonly id: string;
  readonly score: number;
  readonly embedModel: string | null;
}

function parseScoredIds(rows: readonly StorageRow[]): ScoredId[] {
  const out: ScoredId[] = [];
  for (const row of rows) {
    const id = cell(row.id);
    if (id === "") continue;
    const rawScore = typeof row.score === "number" ? row.score : Number(row.score);
    const score = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;
    const embedModel = typeof row.embed_model === "string" && row.embed_model !== "" ? row.embed_model : null;
    out.push({ id, score, embedModel });
  }
  return out;
}

/**
 * Partition scored rows into ones that may contribute to the vector arm and ones
 * whose stored embedding model disagrees with the active provider (PRD-018i /
 * NEC-018 AC-018i.3). A null `embed_model` (pre-provenance row) is treated as
 * compatible; only a non-null model that differs is a cross-space mismatch.
 */
function partitionByEmbedModel(
  scored: readonly ScoredId[],
  activeEmbedModel: string | undefined,
): { usable: ScoredId[]; mismatched: string[] } {
  if (activeEmbedModel === undefined) return { usable: [...scored], mismatched: [] };
  const usable: ScoredId[] = [];
  const mismatched: string[] = [];
  for (const s of scored) {
    if (s.embedModel !== null && s.embedModel !== activeEmbedModel) mismatched.push(s.id);
    else usable.push(s);
  }
  return { usable, mismatched };
}

/**
 * Semantic arm: vectorSearch (scored ids) then hydrate (second guarded query),
 * preserving cosine rank order.
 */
async function runSemanticArm(
  storage: StorageQuery,
  scope: QueryScope,
  queryVector: readonly number[],
  perArmLimit: number,
  activeEmbedModel?: string,
  onReembedNeeded?: (nectars: readonly string[]) => void,
  onSuccess?: () => void,
): Promise<SemanticArmResult> {
  const scoreSql = buildHiveGraphVectorSearchSql(queryVector, scope, perArmLimit);
  const scoreResult = await runArmFailSoft(storage, scoreSql, scope, onSuccess);
  if (scoreResult.status.status !== "ok") {
    return { entries: [], status: scoreResult.status };
  }
  const allScored = parseScoredIds(scoreResult.rows);
  // AC-018i.3: exclude rows whose stored embed_model disagrees with the active
  // provider, and queue those nectars for re-embedding so the index converges.
  const { usable: scored, mismatched } = partitionByEmbedModel(allScored, activeEmbedModel);
  if (mismatched.length > 0 && onReembedNeeded !== undefined) {
    try {
      onReembedNeeded(mismatched);
    } catch {
      // fail-soft: a faulty re-embed sink never breaks the search path.
    }
  }
  if (scored.length === 0) return { entries: [], status: armOk([]) };

  const ids = scored.map((s) => s.id).filter((id) => id !== "");
  if (ids.length === 0) return { entries: [], status: armOk([]) };

  const hydrateResult = await runArmFailSoft(storage, buildHiveGraphHydrateSql(ids, scope), scope, onSuccess);
  if (hydrateResult.status.status !== "ok") {
    return { entries: [], status: hydrateResult.status };
  }

  const hitById = new Map<string, HiveGraphHit>();
  for (const row of hydrateResult.rows) {
    const hit = rowToHit(row);
    if (hit !== null) hitById.set(hit.id, hit);
  }

  const entries: RankedArmEntry[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.id)) continue;
    const hit = hitById.get(s.id);
    if (hit === undefined) continue;
    seen.add(s.id);
    entries.push({ hit });
  }
  return { entries, status: { status: "ok", rows: entries.length } };
}

/**
 * Search the hive graph: guarded lexical + optional semantic arms fused by RRF.
 *
 * @param query - Search term (trimmed; empty returns the empty/degraded floor).
 * @param scope - Tenancy + soft project filter applied in SQL.
 * @param limit - Result cap; defaults to {@link DEFAULT_RECALL_LIMIT}.
 * @param deps - Storage query seam + optional embed client.
 */
export async function searchHiveGraph(
  query: string,
  scope: QueryScope,
  limit: number | undefined,
  deps: HiveGraphSearchDeps,
): Promise<HiveGraphSearchResult> {
  const term = query.trim();
  const resolvedLimit = resolveRecallLimit(limit);
  if (term === "") {
    return { hits: [], sources: [], degraded: true };
  }

  const queryVector = await resolveQueryVector(term, deps.embed);
  const semanticRan = queryVector !== null;

  const queryArm = async (sql: string): Promise<ArmQueryResult> => {
    const result = await runArmFailSoft(deps.storage, sql, scope);
    return result;
  };

  const [semanticResult, lexicalResult] = await Promise.all([
    semanticRan && queryVector !== null
      ? runSemanticArm(deps.storage, scope, queryVector, resolvedLimit, deps.activeEmbedModel, deps.onReembedNeeded)
      : Promise.resolve({ entries: [], status: armNotRun("query embedding unavailable") } as SemanticArmResult),
    queryArm(buildHiveGraphLexicalArmSql(term, scope, resolvedLimit)),
  ]);

  const arms: RankedArm[] = [];
  if (semanticResult.entries.length > 0) {
    arms.push({ entries: semanticResult.entries });
  } else if (semanticRan) {
    arms.push({ entries: [] });
  }
  arms.push(rowsToRankedArm(lexicalResult.rows));

  const { hits, sources } = fuseHits(arms, resolvedLimit);
  const errors = errorSources(semanticResult.status, lexicalResult.status);
  const degraded = !semanticRan || errors.length > 0;
  return {
    hits,
    sources,
    degraded,
    reason: resultReason(hits, semanticResult.status, lexicalResult.status),
    errorSources: errors,
    arms: {
      semantic: semanticResult.status,
      lexical: lexicalResult.status,
    },
  };
}
