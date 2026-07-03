/**
 * Pending-work SQL builder (PRD-016a). Values are sqlStr-guarded per codebase convention.
 */
import { sLiteral } from "../hive-graph/sql-guards.js";
import type { Tenancy } from "../hive-graph/model.js";

export interface PendingWorkRow {
  readonly nectar: string;
  readonly seq: number;
}

export interface PendingWorkSourceRow {
  readonly nectar: string;
  readonly seq: number;
  readonly describeStatus: string;
  readonly observedAt: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

/**
 * Build the enricher's pending-work query (PRD-018g / NEC-017): the LATEST row
 * per nectar (`MAX(seq)`), returned only when that latest row's status is
 * `pending`/`failed`.
 *
 * This "latest-is-pending" shape (rather than "MAX(seq) among pending rows") is
 * what makes the version-bump append durable write terminate: once the enricher
 * appends a `described` row at `seq+1`, that becomes the latest row for the
 * nectar and the nectar drops out of this selection, instead of looping forever
 * on the still-`pending` lower-seq row an append leaves behind. Values are
 * `sLiteral`-guarded per codebase convention.
 */
export function buildPendingWorkSql(tenancy: Tenancy, batchSize: number): string {
  const org = sLiteral(tenancy.orgId);
  const workspace = sLiteral(tenancy.workspaceId);
  const project = sLiteral(tenancy.projectId);
  const limit = Math.max(1, Math.floor(batchSize));
  const tenancySql =
    `org_id = ${org} AND workspace_id = ${workspace} AND project_id = ${project}`;
  const latest =
    `SELECT nectar, MAX(seq) AS max_seq FROM hive_graph_versions ` +
    `WHERE ${tenancySql} GROUP BY nectar`;
  return (
    `SELECT v.nectar AS nectar, v.seq AS seq ` +
    `FROM hive_graph_versions v ` +
    `INNER JOIN (${latest}) latest ON v.nectar = latest.nectar AND v.seq = latest.max_seq ` +
    `WHERE v.describe_status IN ('pending', 'failed') AND ${tenancySql} ` +
    `ORDER BY v.observed_at ` +
    `LIMIT ${limit}`
  );
}

/**
 * Pure in-memory equivalent of the pending-work query for tests and the memory
 * adapter (PRD-018g / NEC-017): the LATEST row per nectar, selected only when
 * that latest row is `pending`/`failed`. Mirrors {@link buildPendingWorkSql}'s
 * latest-is-pending shape so the version-bump append terminates.
 */
export function selectPendingWorkInMemory(
  rows: readonly PendingWorkSourceRow[],
  tenancy: Tenancy,
  batchSize: number,
): PendingWorkRow[] {
  const latestByNectar = new Map<string, PendingWorkSourceRow>();

  for (const row of rows) {
    if (row.orgId !== tenancy.orgId || row.workspaceId !== tenancy.workspaceId || row.projectId !== tenancy.projectId) {
      continue;
    }
    const existing = latestByNectar.get(row.nectar);
    if (existing === undefined || row.seq > existing.seq) latestByNectar.set(row.nectar, row);
  }

  return [...latestByNectar.values()]
    .filter((r) => r.describeStatus === "pending" || r.describeStatus === "failed")
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .slice(0, Math.max(1, batchSize))
    .map((r) => ({ nectar: r.nectar, seq: r.seq }));
}
