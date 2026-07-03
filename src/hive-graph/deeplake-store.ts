/**
 * The Deep Lake-backed HiveGraphStore adapter (PRD-005).
 *
 * `DeepLakeHiveGraphStore` is the durable substrate for the two hive-graph
 * tables (`hive_graph`, `hive_graph_versions`), reached over the network
 * through nectar's own transport (`deeplake-transport.ts`) per ADR-0002 -
 * never by importing the honeycomb runtime in-process. It is an ADDITIONAL
 * adapter alongside `InMemoryHiveGraphStore` (`memory-store.ts`), not a
 * replacement of it: the in-memory store keeps backing the file-registration
 * ladder's tests and local dev, unchanged.
 *
 * `DeepLakeHiveGraphStore implements AsyncHiveGraphStore`
 * (`store.ts`), not the synchronous `HiveGraphStore`. See the docblock on
 * `AsyncHiveGraphStore` for why: the ladder's synchronous contract cannot be
 * honored by a store that does real HTTP I/O, and wiring the ladder to an
 * async store is a future PRD's decision, not this adapter's.
 *
 * All reads are scoped by `org_id`/`workspace_id`/`project_id` wherever the
 * method receives a `Tenancy` (`listLatestVersions`, `latestVersionByPath`,
 * `latestVersionByHash`), per PRD-005c's soft-filter contract - the
 * `project_id` predicate is never omitted from those queries. The four
 * by-nectar-only methods (`getIdentity`, `touchIdentity`, `nextSeq`,
 * `latestVersion`) take no `Tenancy` parameter in the `HiveGraphStore` /
 * `AsyncHiveGraphStore` seam itself - `nectar` is a globally-unique 26-char
 * ULID (`ulid.ts`) and `InMemoryHiveGraphStore` looks those up by nectar
 * alone too (no tenancy filter), so this adapter matches that seam exactly
 * for drop-in-replacement parity rather than inventing extra scoping the
 * interface does not carry.
 */
import type { DescribeStatus, HiveGraphRow, HiveGraphVersionRow, Tenancy } from "./model.js";
import { DESCRIBE_STATUSES } from "./model.js";
import type { AsyncHiveGraphStore, LatestVersion } from "./store.js";
import { HIVE_GRAPH_TABLE, HIVE_GRAPH_VERSIONS_TABLE } from "./schema.js";
import type { DeepLakeCredentials } from "./deeplake-credentials.js";
import type { DeepLakeRow } from "./deeplake-transport.js";
import { HttpDeepLakeTransport, TransportError } from "./deeplake-transport.js";
import type { QueryRunner } from "./deeplake-heal.js";
import { isMissingTableError, withHeal } from "./deeplake-heal.js";
import { eLiteral, sLiteral, sqlFloat4Array, sqlIdent, sqlNum } from "./sql-guards.js";

const HIVE_GRAPH_TABLE_NAME = sqlIdent(HIVE_GRAPH_TABLE.name);
const HIVE_GRAPH_VERSIONS_TABLE_NAME = sqlIdent(HIVE_GRAPH_VERSIONS_TABLE.name);

/** Options for {@link DeepLakeHiveGraphStore}. */
export interface DeepLakeHiveGraphStoreOptions {
  /** Loaded via `deeplake-credentials.ts#loadDeepLakeCredentials`. */
  readonly credentials: DeepLakeCredentials;
  /** Per-statement timeout override in ms; see `DEFAULT_TRANSPORT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /**
   * TEST-ONLY SEAM: inject a fake `QueryRunner` instead of constructing a
   * real `HttpDeepLakeTransport` from `credentials`. When absent (the
   * production path, and the default for every existing caller), the
   * constructor builds a real `HttpDeepLakeTransport` from `credentials`
   * exactly as before this option existed. `credentials` is still required
   * even when `transport` is supplied (a test passes a trivial placeholder
   * object; nothing in the class reads `credentials` again once the
   * transport is constructed), which keeps this a strict addition rather
   * than a change to the required shape of the options object.
   */
  readonly transport?: QueryRunner;
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDescribeStatus(value: unknown): DescribeStatus {
  if (typeof value === "string" && (DESCRIBE_STATUSES as readonly string[]).includes(value)) {
    return value as DescribeStatus;
  }
  console.warn(`nectar hive-graph: invalid describe_status value from Deep Lake mapped to failed: ${JSON.stringify(value)}`);
  return "failed";
}

function toEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => toNum(v));
}

function toConfidence(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Map a raw `hive_graph` row into the domain `HiveGraphRow`. */
function toIdentityRow(row: DeepLakeRow): HiveGraphRow {
  return {
    nectar: toStr(row.nectar),
    kind: row.kind === "directory" ? "directory" : "file",
    createdAt: toStr(row.created_at),
    derivedFromNectar: toStr(row.derived_from_nectar),
    forkContentHash: toStr(row.fork_content_hash),
    orgId: toStr(row.org_id),
    workspaceId: toStr(row.workspace_id),
    projectId: toStr(row.project_id),
    lastUpdateDate: toStr(row.last_update_date),
  };
}

/** Map a raw `hive_graph_versions` row into the domain `HiveGraphVersionRow`. */
function toVersionRow(row: DeepLakeRow): HiveGraphVersionRow {
  return {
    nectar: toStr(row.nectar),
    contentHash: toStr(row.content_hash),
    seq: toNum(row.seq),
    path: toStr(row.path),
    filename: toStr(row.filename),
    ext: toStr(row.ext),
    sizeBytes: toNum(row.size_bytes),
    mtimeObserved: toStr(row.mtime_observed),
    title: toStr(row.title),
    description: toStr(row.description),
    concepts: toStr(row.concepts),
    embedding: toEmbedding(row.embedding),
    confidence: toConfidence(row.confidence),
    fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : null,
    describedAt: toStr(row.described_at),
    describeModel: toStr(row.describe_model),
    embedModel: typeof row.embed_model === "string" ? row.embed_model : null,
    describeStatus: toDescribeStatus(row.describe_status),
    observedAt: toStr(row.observed_at),
    orgId: toStr(row.org_id),
    workspaceId: toStr(row.workspace_id),
    projectId: toStr(row.project_id),
    lastUpdateDate: toStr(row.last_update_date),
  };
}

/**
 * Reduce a set of raw `hive_graph_versions` rows for ONE nectar to the one
 * with the highest `seq` (client-side MAX(seq)), returning `undefined` for an
 * empty set. This is the real "MAX(seq) selection" logic `nextSeq`,
 * `latestVersion`, and `listLatestVersions` all share - it does not trust the
 * Deep Lake backend to have already applied an `ORDER BY seq DESC LIMIT 1`
 * correctly, since this same file documents (`touchIdentity`'s docblock,
 * citing honeycomb `src/daemon/storage/catalog/tenancy.ts:475-489`) that this
 * backend has known point-read/ordering quirks under load. Fetching every
 * version row for a nectar and reducing here is a small, testable function
 * instead of an opaque SQL clause, and a nectar's version history (one row
 * per observed edit of a single file) is not expected to be large enough for
 * the extra rows to matter.
 */
function reduceLatestVersion(rows: readonly DeepLakeRow[]): HiveGraphVersionRow | undefined {
  let latest: HiveGraphVersionRow | undefined;
  for (const raw of rows) {
    const version = toVersionRow(raw);
    if (latest === undefined || version.seq > latest.seq) latest = version;
  }
  return latest;
}

/**
 * Reduce a set of raw `hive_graph_versions` rows for ONE nectar to the
 * highest-seq row whose `describe_status` is `described`, returning `undefined`
 * when the nectar has no described version. Shares the client-side MAX(seq)
 * discipline of {@link reduceLatestVersion} (it does not trust an SQL
 * `ORDER BY seq DESC LIMIT 1`, for the point-read/ordering-quirk reason that
 * function documents); the `describe_status` filter is applied client-side too,
 * so the same fetched row set feeds both reductions with no extra query.
 */
function reduceLatestDescribedVersion(rows: readonly DeepLakeRow[]): HiveGraphVersionRow | undefined {
  let latest: HiveGraphVersionRow | undefined;
  for (const raw of rows) {
    const version = toVersionRow(raw);
    if (version.describeStatus !== "described") continue;
    if (latest === undefined || version.seq > latest.seq) latest = version;
  }
  return latest;
}

/** Build the `INSERT INTO "hive_graph" (...) VALUES (...)` statement for one identity row. */
function buildInsertIdentitySql(row: HiveGraphRow): string {
  const cols = [
    "nectar",
    "kind",
    "created_at",
    "derived_from_nectar",
    "fork_content_hash",
    "org_id",
    "workspace_id",
    "project_id",
    "last_update_date",
  ];
  const vals = [
    sLiteral(row.nectar),
    sLiteral(row.kind),
    sLiteral(row.createdAt),
    sLiteral(row.derivedFromNectar),
    sLiteral(row.forkContentHash),
    sLiteral(row.orgId),
    sLiteral(row.workspaceId),
    sLiteral(row.projectId),
    sLiteral(row.lastUpdateDate),
  ];
  return `INSERT INTO "${HIVE_GRAPH_TABLE_NAME}" (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
}

/** Build the `INSERT INTO "hive_graph_versions" (...) VALUES (...)` statement for one version row. */
function buildInsertVersionSql(row: HiveGraphVersionRow): string {
  const cols = [
    "nectar",
    "content_hash",
    "seq",
    "path",
    "filename",
    "ext",
    "size_bytes",
    "mtime_observed",
    "title",
    "description",
    "concepts",
    "embedding",
    "confidence",
    "fingerprint",
    "described_at",
    "describe_model",
    "embed_model",
    "describe_status",
    "observed_at",
    "org_id",
    "workspace_id",
    "project_id",
    "last_update_date",
  ];
  const vals = [
    sLiteral(row.nectar),
    sLiteral(row.contentHash),
    sqlNum(row.seq),
    sLiteral(row.path),
    sLiteral(row.filename),
    sLiteral(row.ext),
    sqlNum(row.sizeBytes),
    sLiteral(row.mtimeObserved),
    // Free-text fields may carry backslashes/newlines; use the E'...' form.
    eLiteral(row.title),
    eLiteral(row.description),
    eLiteral(row.concepts),
    row.embedding !== null ? sqlFloat4Array(row.embedding) : "NULL",
    row.confidence !== null ? sqlNum(row.confidence) : "NULL",
    row.fingerprint !== null ? sLiteral(row.fingerprint) : "NULL",
    sLiteral(row.describedAt),
    sLiteral(row.describeModel),
    row.embedModel !== null && row.embedModel !== undefined ? sLiteral(row.embedModel) : "NULL",
    sLiteral(row.describeStatus),
    sLiteral(row.observedAt),
    sLiteral(row.orgId),
    sLiteral(row.workspaceId),
    sLiteral(row.projectId),
    sLiteral(row.lastUpdateDate),
  ];
  return `INSERT INTO "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
}

/** The `AND`-joined tenancy predicate (`org_id`/`workspace_id`/`project_id`), never omitting `project_id`. */
function tenancyPredicate(tenancy: Tenancy): string {
  return (
    `org_id = ${sLiteral(tenancy.orgId)} AND ` +
    `workspace_id = ${sLiteral(tenancy.workspaceId)} AND ` +
    `project_id = ${sLiteral(tenancy.projectId)}`
  );
}

export class DeepLakeHiveGraphStore implements AsyncHiveGraphStore {
  private readonly transport: QueryRunner;
  /**
   * Per-nectar append serialization (PRD-018g / NEC-011 AC-018g.3). Deep Lake has
   * no transaction or unique constraint, so `nextSeq` + `appendVersion` as two
   * statements is a read-then-write race: two concurrent writers can read the
   * same MAX(seq) and both append `seq+1`. Chaining every seq-allocating append
   * for a nectar through one promise makes the allocate-and-append pair atomic
   * within THIS store instance, so no duplicate `(nectar, seq)` is produced by
   * writers sharing the store.
   */
  private readonly seqChains = new Map<string, Promise<unknown>>();
  /**
   * Per-nectar IN-PROCESS high-water mark for seq (issue NEC: the rename-during-
   * describe duplicate-seq race). Deep Lake has documented read-after-write lag
   * (`touchIdentity`'s docblock, citing honeycomb
   * `src/daemon/storage/catalog/tenancy.ts:475-489`), so a just-appended row can
   * be invisible to the very next `SELECT seq` for a short window. Two components
   * with independent store views (the enricher's `appendVersionAtNextSeq` and the
   * registration bridge's flushed `appendVersion`) both allocate against this ONE
   * store instance in the live daemon (`cli.ts` wires `ctx.store` into both), so
   * recording the highest seq THIS process has written and taking
   * `max(inProcessHighWater, backendMax) + 1` at allocation makes allocation
   * monotonic within the daemon regardless of backend lag - the read is no longer
   * trusted to reflect an append that already happened here. This is the process-
   * local complement to the per-nectar serialization above (`seqChains`): the
   * chain removes intra-store races, the high-water removes lag-induced ones.
   */
  private readonly seqHighWater = new Map<string, number>();

  constructor(options: DeepLakeHiveGraphStoreOptions) {
    this.transport =
      options.transport ??
      new HttpDeepLakeTransport({
        endpoint: options.credentials.apiUrl,
        token: options.credentials.token,
        orgId: options.credentials.orgId,
        workspaceId: options.credentials.workspaceId,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
  }

  /**
   * Run a READ statement, tolerating a missing-table failure as "no data yet"
   * (an empty result), exactly like honeycomb's read-path guard
   * (`tableExists`, `src/daemon/storage/heal.ts:171-175`) fails OPEN rather
   * than provoking a CREATE. Only the missing-table shape is tolerated; a
   * genuine connection/timeout/permission/syntax failure still propagates.
   * Reads never create a table - only a write does, via `withHeal`.
   */
  private async readTolerant(sql: string): Promise<DeepLakeRow[]> {
    try {
      return await this.transport.query(sql);
    } catch (err: unknown) {
      if (err instanceof TransportError && isMissingTableError(err)) return [];
      throw err;
    }
  }

  /**
   * Insert-only mint, mirroring honeycomb's SELECT-before-INSERT write
   * pattern (`selectBeforeInsert`, `src/daemon/storage/writes.ts:325-360`)
   * rather than relying on a Deep Lake UNIQUE constraint: the Deep Lake SQL
   * surface this adapter targets has no reliably-enforced uniqueness
   * constraint to lean on, so "does the nectar already exist" is answered by
   * probing first. Both the probe and the insert are heal-aware (a fresh
   * tenancy's tables may not exist yet).
   *
   * After the insert, a best-effort re-verify SELECT counts the rows for the
   * nectar; more than one means a race doubled it. Deep Lake offers no
   * transactions, so this cannot PREVENT a race, only make it observable
   * (the same limitation honeycomb documents). In practice a real race here
   * is a near-zero-probability event - a nectar is a 26-char ULID with 80
   * bits of randomness (`ulid.ts`), not a narrow key space two writers could
   * plausibly collide on - so a failure of the re-verify SELECT itself
   * (e.g. a transient network hiccup immediately after a successful insert)
   * does not fail the whole call; the insert already succeeded and the
   * re-verify is an observability nicety, not the source of truth.
   */
  async insertIdentity(row: HiveGraphRow): Promise<void> {
    const probeSql = `SELECT nectar FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE nectar = ${sLiteral(row.nectar)} LIMIT 1`;
    const probeRows = await withHeal(this.transport, HIVE_GRAPH_TABLE, () => this.transport.query(probeSql));
    if (probeRows.length > 0) {
      throw new Error(`identity already exists for nectar ${row.nectar}`);
    }

    const insertSql = buildInsertIdentitySql(row);
    await withHeal(this.transport, HIVE_GRAPH_TABLE, () => this.transport.query(insertSql));

    const verifySql = `SELECT nectar FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE nectar = ${sLiteral(row.nectar)}`;
    const verifyRows = await this.transport.query(verifySql).catch((): DeepLakeRow[] => []);
    if (verifyRows.length > 1) {
      throw new Error(
        `race detected inserting identity for nectar ${row.nectar}: ${verifyRows.length} rows present after insert`,
      );
    }
  }

  async getIdentity(nectar: string): Promise<HiveGraphRow | undefined> {
    const sql = `SELECT * FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE nectar = ${sLiteral(nectar)} LIMIT 1`;
    const rows = await this.readTolerant(sql);
    return rows.length > 0 ? toIdentityRow(rows[0] as DeepLakeRow) : undefined;
  }

  /**
   * Bump `last_update_date` via an in-place `UPDATE`.
   *
   * KNOWN CAVEAT: honeycomb's own operational history found that an in-place
   * `UPDATE ... WHERE id = ...` does not reliably land on this backend under
   * load - a by-id point read can still return a pre-update snapshot from a
   * stale segment (see honeycomb `src/daemon/storage/catalog/tenancy.ts:475-489`,
   * where the equivalent revoke-by-UPDATE was RETIRED in favor of an
   * append-only version-bump for that reason). `hive_graph`'s catalog entry
   * (`schema.ts`) nonetheless declares `writePattern: "update-or-insert"` for
   * this exact field, and `last_update_date` is a low-stakes denormalized
   * "last observed change" timestamp (not an authorization-bearing flag like
   * the retired revoke), so this adapter uses `UPDATE` as declared rather than
   * inventing an append-based scheme the schema does not define. If
   * `last_update_date` staleness proves to be a real problem in practice, a
   * future PRD should revisit this the same way honeycomb did - not this
   * adapter, which mirrors the declared write pattern faithfully.
   */
  async touchIdentity(nectar: string, lastUpdateDate: string): Promise<void> {
    const sql =
      `UPDATE "${HIVE_GRAPH_TABLE_NAME}" SET last_update_date = ${sLiteral(lastUpdateDate)} ` +
      `WHERE nectar = ${sLiteral(nectar)}`;
    await withHeal(this.transport, HIVE_GRAPH_TABLE, () => this.transport.query(sql));
  }

  async appendVersion(row: HiveGraphVersionRow): Promise<void> {
    const insertSql = buildInsertVersionSql(row);
    await withHeal(this.transport, HIVE_GRAPH_VERSIONS_TABLE, () => this.transport.query(insertSql));
    // Record the seq we just wrote so a subsequent allocation (from this OR any
    // other in-process caller sharing this store) cannot re-allocate it before
    // Deep Lake's read lag catches up. Every durable append - the direct
    // `appendVersion` path and the allocator's `allocateAndAppend` below - funnels
    // through here, so the high-water reflects them all.
    this.recordSeqHighWater(row.nectar, row.seq);
  }

  /** Advance the per-nectar in-process seq high-water to `seq` when it exceeds the current mark. */
  private recordSeqHighWater(nectar: string, seq: number): void {
    const current = this.seqHighWater.get(nectar);
    if (current === undefined || seq > current) this.seqHighWater.set(nectar, seq);
  }

  /**
   * Allocate the next monotonic seq for `row.nectar` and append `row` at it,
   * atomically with respect to other seq-allocating appends for the SAME nectar
   * through this store (PRD-018g AC-018g.3). Returns the seq actually written.
   * `row.seq` is ignored; the store owns seq allocation here so the caller never
   * hand-computes a colliding value. Non-seq appends (`appendVersion`) that a
   * caller has already sequenced are unaffected.
   */
  async appendVersionAtNextSeq(row: HiveGraphVersionRow): Promise<number> {
    const nectar = row.nectar;
    const prior = this.seqChains.get(nectar) ?? Promise.resolve();
    const next = prior.then(
      () => this.allocateAndAppend(row),
      () => this.allocateAndAppend(row),
    );
    // Keep the chain alive but do not let a rejection poison the next link; the
    // `.then(_, _)` above already recovers, and we clear the slot once settled.
    this.seqChains.set(
      nectar,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await next;
    } finally {
      // Best-effort GC: drop the chain slot when this was the last queued append.
      const current = this.seqChains.get(nectar);
      if (current !== undefined) {
        void current.then(() => {
          if (this.seqChains.get(nectar) === current) this.seqChains.delete(nectar);
        });
      }
    }
  }

  private async allocateAndAppend(row: HiveGraphVersionRow): Promise<number> {
    const seq = await this.nextSeq(row.nectar);
    await this.appendVersion({ ...row, seq });
    return seq;
  }

  /**
   * The next monotonic seq for a nectar: `max(inProcessHighWater, backendMax) + 1`,
   * with `backendMax` computed client-side (MAX over every version row) rather
   * than trusted to an SQL `ORDER BY`/`LIMIT`/`MAX()` clause (see
   * {@link reduceLatestVersion}'s docblock for why). Seeding the running maximum
   * from {@link seqHighWater} is the lag fix (issue NEC): if this process already
   * wrote a higher seq that Deep Lake's read has not surfaced yet, the returned
   * seq still clears it, so no allocation collides with a just-written row. With
   * no high-water and no rows the result is 0 (an unchanged fresh-nectar mint).
   */
  async nextSeq(nectar: string): Promise<number> {
    const sql = `SELECT seq FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" WHERE nectar = ${sLiteral(nectar)}`;
    const rows = await this.readTolerant(sql);
    let maxSeq = this.seqHighWater.get(nectar) ?? -1;
    for (const row of rows) {
      const seq = toNum(row.seq);
      if (seq > maxSeq) maxSeq = seq;
    }
    return maxSeq + 1;
  }

  /** The latest (MAX seq) version row for a nectar; see {@link reduceLatestVersion}. */
  async latestVersion(nectar: string): Promise<HiveGraphVersionRow | undefined> {
    const sql = `SELECT * FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" WHERE nectar = ${sLiteral(nectar)}`;
    const rows = await this.readTolerant(sql);
    return reduceLatestVersion(rows);
  }

  /**
   * Every nectar's latest version, scoped by the full tenancy predicate
   * (`org_id`/`workspace_id`/`project_id`, PRD-005c). Fetches every identity
   * and every version row for the tenancy and reduces to "latest per nectar"
   * in application code, mirroring `InMemoryHiveGraphStore.listLatestVersions`'s
   * iterate-and-reduce shape rather than pushing a `GROUP BY`/window-function
   * reduction into SQL. This is not optimized for a very large per-tenant
   * row count; a future PRD could push the "latest per nectar" reduction into
   * SQL if that becomes the bottleneck. It is not this adapter's job to
   * diverge from the reference in-memory implementation's behavior to chase
   * that optimization prematurely.
   */
  async listLatestVersions(tenancy: Tenancy): Promise<LatestVersion[]> {
    const predicate = tenancyPredicate(tenancy);
    const identitiesSql = `SELECT * FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE ${predicate}`;
    const versionsSql = `SELECT * FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" WHERE ${predicate}`;
    const [identityRows, versionRows] = await Promise.all([
      this.readTolerant(identitiesSql),
      this.readTolerant(versionsSql),
    ]);

    // Group raw version rows by nectar first, then reduce each group with the
    // SAME `reduceLatestVersion` helper `nextSeq`/`latestVersion` use, so
    // there is exactly one "pick the highest seq" implementation in this file.
    const rowsByNectar = new Map<string, DeepLakeRow[]>();
    for (const raw of versionRows) {
      const nectar = toStr(raw.nectar);
      const group = rowsByNectar.get(nectar);
      if (group === undefined) rowsByNectar.set(nectar, [raw]);
      else group.push(raw);
    }

    const out: LatestVersion[] = [];
    for (const raw of identityRows) {
      const identity = toIdentityRow(raw);
      const group = rowsByNectar.get(identity.nectar);
      const version = group !== undefined ? reduceLatestVersion(group) : undefined;
      if (version !== undefined) out.push({ identity, version });
    }
    return out;
  }

  /**
   * Every nectar's latest DESCRIBED version, scoped by the full tenancy
   * predicate (PRD-011c's projection scan). Mirrors {@link listLatestVersions}'s
   * two-SELECT-then-reduce-in-application-code shape, but reduces each nectar's
   * version group with {@link reduceLatestDescribedVersion} and omits nectars
   * that have no described version. The projection builder overlays this onto
   * {@link listLatestVersions} so a minted-but-undescribed nectar still keeps a
   * minimal entry.
   */
  async listLatestDescribedVersions(tenancy: Tenancy): Promise<LatestVersion[]> {
    const predicate = tenancyPredicate(tenancy);
    const identitiesSql = `SELECT * FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE ${predicate}`;
    const versionsSql = `SELECT * FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" WHERE ${predicate}`;
    const [identityRows, versionRows] = await Promise.all([
      this.readTolerant(identitiesSql),
      this.readTolerant(versionsSql),
    ]);

    const rowsByNectar = new Map<string, DeepLakeRow[]>();
    for (const raw of versionRows) {
      const nectar = toStr(raw.nectar);
      const group = rowsByNectar.get(nectar);
      if (group === undefined) rowsByNectar.set(nectar, [raw]);
      else group.push(raw);
    }

    const out: LatestVersion[] = [];
    for (const raw of identityRows) {
      const identity = toIdentityRow(raw);
      const group = rowsByNectar.get(identity.nectar);
      const version = group !== undefined ? reduceLatestDescribedVersion(group) : undefined;
      if (version !== undefined) out.push({ identity, version });
    }
    return out;
  }

  async latestVersionByPath(tenancy: Tenancy, path: string): Promise<LatestVersion | undefined> {
    return this.latestVersionByColumn(tenancy, "path", path, (v) => v.path === path);
  }

  async latestVersionByHash(tenancy: Tenancy, contentHash: string): Promise<LatestVersion | undefined> {
    return this.latestVersionByColumn(tenancy, "content_hash", contentHash, (v) => v.contentHash === contentHash);
  }

  /**
   * By-path / by-hash lookup with predicate pushdown (NEC-042 item 8 /
   * AC-018l.15). The pre-fix path called {@link listLatestVersions}, which
   * scans the ENTIRE tenancy (all identities + all version rows) per probe -
   * O(all rows) on what becomes a per-file-event hot path. Instead:
   *
   *   1. push the column predicate down (`WHERE path = ...` / `WHERE
   *      content_hash = ...`) to find only the candidate nectars that ever
   *      carried the value;
   *   2. fetch the full history for JUST those candidates and reduce
   *      latest-per-nectar client-side with the shared {@link reduceLatestVersion}
   *      MAX(seq) helper (the client-side reduction is kept, not trusted to an
   *      SQL ORDER BY, matching the rest of this adapter);
   *   3. return the nectar whose LATEST version satisfies the predicate, which
   *      preserves the reference `listLatestVersions().find` semantics (a nectar
   *      renamed AWAY from the path is not a false positive).
   */
  private async latestVersionByColumn(
    tenancy: Tenancy,
    column: "path" | "content_hash",
    value: string,
    matches: (v: HiveGraphVersionRow) => boolean,
  ): Promise<LatestVersion | undefined> {
    const predicate = tenancyPredicate(tenancy);
    const candidateSql =
      `SELECT nectar FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" ` +
      `WHERE ${sqlIdent(column)} = ${sLiteral(value)} AND ${predicate}`;
    const candidateRows = await this.readTolerant(candidateSql);
    const nectars = [...new Set(candidateRows.map((r) => toStr(r.nectar)).filter((n) => n !== ""))];
    if (nectars.length === 0) return undefined;

    const inList = nectars.map((n) => sLiteral(n)).join(", ");
    const versionsSql = `SELECT * FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" WHERE nectar IN (${inList}) AND ${predicate}`;
    const versionRows = await this.readTolerant(versionsSql);
    const rowsByNectar = new Map<string, DeepLakeRow[]>();
    for (const raw of versionRows) {
      const nectar = toStr(raw.nectar);
      const group = rowsByNectar.get(nectar);
      if (group === undefined) rowsByNectar.set(nectar, [raw]);
      else group.push(raw);
    }

    for (const nectar of nectars) {
      const latest = reduceLatestVersion(rowsByNectar.get(nectar) ?? []);
      if (latest === undefined || !matches(latest)) continue;
      const identitySql = `SELECT * FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE nectar = ${sLiteral(nectar)} AND ${predicate}`;
      const identityRows = await this.readTolerant(identitySql);
      const identityRaw = identityRows[0];
      if (identityRaw === undefined) continue;
      return { identity: toIdentityRow(identityRaw), version: latest };
    }
    return undefined;
  }

  /**
   * Delete a nectar (identity + versions) scoped to `tenancy`, the SOLE deletion
   * path (`prune --confirm`, PRD-006d). Both DELETE statements carry the full
   * tenancy predicate (`org_id`/`workspace_id`/`project_id`, never omitting
   * `project_id`) alongside the nectar key, so a nectar minted under another
   * project is never removed by a delete issued in this tenancy (AC-20).
   *
   * The delete path deliberately does NOT go through `withHeal`: a missing table
   * means there is nothing to delete, so it is a harmless no-op, NOT a reason to
   * CREATE a fresh (empty) table. `deleteTolerant` therefore swallows only the
   * missing-table transport error (via `isMissingTableError`, the same
   * classification the read path uses) and lets every other failure propagate.
   */
  async deleteNectar(tenancy: Tenancy, nectar: string): Promise<void> {
    const predicate = tenancyPredicate(tenancy);
    const nectarKey = sLiteral(nectar);
    const deleteVersionsSql =
      `DELETE FROM "${HIVE_GRAPH_VERSIONS_TABLE_NAME}" WHERE nectar = ${nectarKey} AND ${predicate}`;
    const deleteIdentitySql =
      `DELETE FROM "${HIVE_GRAPH_TABLE_NAME}" WHERE nectar = ${nectarKey} AND ${predicate}`;
    await this.deleteTolerant(deleteVersionsSql);
    await this.deleteTolerant(deleteIdentitySql);
  }

  /**
   * Run a DELETE, tolerating a missing-table failure as "nothing to delete" (a
   * no-op). Never creates a table. Any other transport failure propagates.
   */
  private async deleteTolerant(sql: string): Promise<void> {
    try {
      await this.transport.query(sql);
    } catch (err: unknown) {
      if (err instanceof TransportError && isMissingTableError(err)) return;
      throw err;
    }
  }
}
