/**
 * The `/api/hive-graph/status` read model (PRD-008c).
 *
 * Produces the coarse, cheap pipeline status an operator and the dashboard
 * read: queue depth (latest-pending-per-nectar count), the `describe_status`
 * breakdown (one counter per REAL enum value, W-1 closed — all six values kept
 * distinct, never collapsed into a single `skipped` bucket), and the cumulative
 * cost counter. Aggregate counts only, no full scan (mirrors honeycomb's coarse
 * `/health` posture). Fail-soft: a missing table on a fresh workspace degrades
 * to empty counts + `degraded: true`, never a 500 (mirrors the per-arm
 * fail-soft at `honeycomb/src/daemon/runtime/memories/recall.ts:24-35`).
 */
import { DESCRIBE_STATUSES, type DescribeStatus } from "../hive-graph/model.js";
import { HIVE_GRAPH_VERSIONS_TABLE } from "../hive-graph/schema.js";
import { isMissingTableError } from "../hive-graph/deeplake-heal.js";
import { TransportError } from "../hive-graph/deeplake-transport.js";
import { sLiteral, sqlIdent } from "../hive-graph/sql-guards.js";
import type { QueryScope, StorageQuery, StorageRow } from "../hive-graph/search-types.js";

const HIVE_GRAPH_VERSIONS = sqlIdent(HIVE_GRAPH_VERSIONS_TABLE.name);

/** The `describe_status` breakdown: one counter per real enum value (all six kept distinct). */
export type DescribeStatusCounts = Record<DescribeStatus, number>;

/** The `/api/hive-graph/status` response shape (PRD-008c). */
export interface HiveGraphStatus {
  readonly queueDepth: number;
  readonly describeStatus: DescribeStatusCounts;
  readonly costSpentUsd: number;
  readonly degraded: boolean;
}

/** A zeroed counter for every real `describe_status` value (the honest empty breakdown). */
export function emptyDescribeStatusCounts(): DescribeStatusCounts {
  const counts = {} as Record<DescribeStatus, number>;
  for (const status of DESCRIBE_STATUSES) counts[status] = 0;
  return counts;
}

function tenancyPredicate(scope: QueryScope): string {
  return (
    `${sqlIdent("org_id")} = ${sLiteral(scope.orgId)} AND ` +
    `${sqlIdent("workspace_id")} = ${sLiteral(scope.workspaceId)} AND ` +
    `${sqlIdent("project_id")} = ${sLiteral(scope.projectId)}`
  );
}

/** Aggregate count of version rows grouped by `describe_status`, scoped by tenancy. */
export function buildDescribeStatusCountSql(scope: QueryScope): string {
  const statusCol = sqlIdent("describe_status");
  return (
    `SELECT ${statusCol}, COUNT(*) AS n ` +
    `FROM "${HIVE_GRAPH_VERSIONS}" ` +
    `WHERE ${tenancyPredicate(scope)} ` +
    `GROUP BY ${statusCol}`
  );
}

/**
 * Latest-pending-per-nectar rows, scoped by tenancy. The queue depth is the row
 * count of this result (one row per nectar whose latest version is pending),
 * mirroring the enricher's pending-work query shape
 * (`src/enricher/pending-query.ts` `buildPendingWorkSql`).
 */
export function buildQueueDepthSql(scope: QueryScope): string {
  const nectarCol = sqlIdent("nectar");
  const seqCol = sqlIdent("seq");
  const statusCol = sqlIdent("describe_status");
  return (
    `SELECT ${nectarCol}, MAX(${seqCol}) AS seq ` +
    `FROM "${HIVE_GRAPH_VERSIONS}" ` +
    `WHERE ${statusCol} = ${sLiteral("pending")} AND ${tenancyPredicate(scope)} ` +
    `GROUP BY ${nectarCol}`
  );
}

/** Fold GROUP BY rows into the six-value breakdown; unknown values are ignored (schema is the source of truth). */
export function parseDescribeStatusCounts(rows: readonly StorageRow[]): DescribeStatusCounts {
  const counts = emptyDescribeStatusCounts();
  const known = new Set<string>(DESCRIBE_STATUSES);
  for (const row of rows) {
    const status = typeof row["describe_status"] === "string" ? (row["describe_status"] as string) : "";
    if (!known.has(status)) continue;
    const raw = row["n"];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) counts[status as DescribeStatus] = n;
  }
  return counts;
}

function isMissingTable(err: unknown): boolean {
  if (err instanceof TransportError && isMissingTableError(err)) return true;
  return err instanceof Error && /table does not exist|no such table|relation .* does not exist/i.test(err.message);
}

export interface ReadHiveGraphStatusOptions {
  /** The cumulative brooding/enricher cost counter (from the daemon's health cost slice). */
  readonly costSpentUsd?: number;
}

/**
 * Read the pipeline status over the injected {@link StorageQuery}. Fail-soft:
 * a missing table (fresh workspace) returns the degraded empty status, never
 * throwing (AC-008c.2.2). A non-missing-table storage failure also degrades
 * rather than crashing the status read. `costSpentUsd` is supplied by the
 * daemon's in-memory cost counter (there is no durable cost table to query).
 */
export async function readHiveGraphStatusOverStorage(
  storage: StorageQuery,
  scope: QueryScope,
  options: ReadHiveGraphStatusOptions = {},
): Promise<HiveGraphStatus> {
  const costSpentUsd = options.costSpentUsd ?? 0;
  try {
    const [statusRows, queueRows] = await Promise.all([
      storage.query(buildDescribeStatusCountSql(scope), scope),
      storage.query(buildQueueDepthSql(scope), scope),
    ]);
    return {
      queueDepth: queueRows.length,
      describeStatus: parseDescribeStatusCounts(statusRows),
      costSpentUsd,
      degraded: false,
    };
  } catch (err: unknown) {
    if (isMissingTable(err)) {
      return { queueDepth: 0, describeStatus: emptyDescribeStatusCounts(), costSpentUsd, degraded: true };
    }
    // Any other storage failure also degrades (coarse status never 500s the daemon).
    return { queueDepth: 0, describeStatus: emptyDescribeStatusCounts(), costSpentUsd, degraded: true };
  }
}
