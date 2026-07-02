/**
 * SQL UPDATE builder for enricher row patches (PRD-016).
 */
import type { HiveGraphVersionRow } from "../hive-graph/model.js";
import { eLiteral, sLiteral, sqlFloat4Array, sqlIdent, sqlNum } from "../hive-graph/sql-guards.js";
import { HIVE_GRAPH_VERSIONS_TABLE } from "../hive-graph/schema.js";

const TABLE = sqlIdent(HIVE_GRAPH_VERSIONS_TABLE.name);

/** Build an in-place UPDATE for one version row keyed by nectar + seq. */
export function buildUpdateVersionSql(row: HiveGraphVersionRow): string {
  const embedding =
    row.embedding !== null ? sqlFloat4Array(row.embedding) : "NULL";
  const confidence = row.confidence !== null ? sqlNum(row.confidence) : "NULL";
  const fingerprint = row.fingerprint !== null ? sLiteral(row.fingerprint) : "NULL";
  return (
    `UPDATE "${TABLE}" SET ` +
    `title = ${eLiteral(row.title)}, ` +
    `description = ${eLiteral(row.description)}, ` +
    `concepts = ${eLiteral(row.concepts)}, ` +
    `embedding = ${embedding}, ` +
    `confidence = ${confidence}, ` +
    `fingerprint = ${fingerprint}, ` +
    `described_at = ${sLiteral(row.describedAt)}, ` +
    `describe_model = ${sLiteral(row.describeModel)}, ` +
    `describe_status = ${sLiteral(row.describeStatus)}, ` +
    `last_update_date = ${sLiteral(row.lastUpdateDate)} ` +
    `WHERE nectar = ${sLiteral(row.nectar)} AND seq = ${sqlNum(row.seq)}`
  );
}
