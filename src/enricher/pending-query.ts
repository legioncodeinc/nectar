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
 * Build the enricher's pending-work query (corpus verbatim + failed rows for solo retry).
 */
export function buildPendingWorkSql(tenancy: Tenancy, batchSize: number): string {
  const org = sLiteral(tenancy.orgId);
  const workspace = sLiteral(tenancy.workspaceId);
  const project = sLiteral(tenancy.projectId);
  const limit = Math.max(1, Math.floor(batchSize));
  return (
    `SELECT nectar, MAX(seq) AS seq ` +
    `FROM hive_graph_versions ` +
    `WHERE describe_status IN ('pending', 'failed') ` +
    `AND org_id = ${org} ` +
    `AND workspace_id = ${workspace} ` +
    `AND project_id = ${project} ` +
    `GROUP BY nectar ` +
    `ORDER BY MIN(observed_at) ` +
    `LIMIT ${limit}`
  );
}

/** Pure in-memory equivalent of the pending-work query for tests and the memory adapter. */
export function selectPendingWorkInMemory(
  rows: readonly PendingWorkSourceRow[],
  tenancy: Tenancy,
  batchSize: number,
): PendingWorkRow[] {
  const byNectar = new Map<string, { maxSeq: number; minObserved: string }>();

  for (const row of rows) {
    if (row.orgId !== tenancy.orgId || row.workspaceId !== tenancy.workspaceId || row.projectId !== tenancy.projectId) {
      continue;
    }
    if (row.describeStatus !== "pending" && row.describeStatus !== "failed") continue;

    const existing = byNectar.get(row.nectar);
    if (existing === undefined) {
      byNectar.set(row.nectar, { maxSeq: row.seq, minObserved: row.observedAt });
      continue;
    }
    const maxSeq = Math.max(existing.maxSeq, row.seq);
    const minObserved = row.observedAt < existing.minObserved ? row.observedAt : existing.minObserved;
    byNectar.set(row.nectar, { maxSeq, minObserved });
  }

  return [...byNectar.entries()]
    .map(([nectar, v]) => ({ nectar, seq: v.maxSeq, minObserved: v.minObserved }))
    .sort((a, b) => a.minObserved.localeCompare(b.minObserved))
    .slice(0, Math.max(1, batchSize))
    .map(({ nectar, seq }) => ({ nectar, seq }));
}
