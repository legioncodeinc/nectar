/**
 * Heal-on-first-write for the Deep Lake adapter (PRD-005).
 *
 * Mirrors the missing-table branch of honeycomb's `withHeal`
 * (`src/daemon/storage/heal.ts:286-313`), scoped down to what the
 * source-graph tables need: a write that fails because its table does not
 * exist yet triggers exactly ONE create-then-retry. Any other failure
 * (permission, connection, timeout, a genuine syntax error) propagates
 * unchanged and never triggers a create — the same anti-mask rule honeycomb's
 * `classifyFailure` documents: a credentials or syntax problem must never be
 * misread as a schema gap behind a confusing CREATE attempt.
 *
 * Column healing (honeycomb's `healColumns` / `ALTER TABLE ADD COLUMN`) is
 * deliberately NOT ported here: `SOURCE_GRAPH_COLUMNS` /
 * `SOURCE_GRAPH_VERSIONS_COLUMNS` are the full, fixed column set at CREATE
 * time and PRD-005 does not add columns to an already-created table out from
 * under a running adapter, so there is no missing-column case for this
 * adapter to heal. A future PRD that adds a column to the catalog would need
 * to bring the column-heal half of honeycomb's engine over too.
 */
import type { CatalogTable } from "./schema.js";
import { buildCreateTableSql } from "./schema.js";
import type { DeepLakeRow } from "./deeplake-transport.js";
import { TransportError } from "./deeplake-transport.js";

/**
 * The minimal shape `withHeal` needs from a transport: one method that runs a
 * SQL statement. `HttpDeepLakeTransport` satisfies this structurally (its
 * `query` method is public even though its connection fields are private), so
 * production callers pass it directly; a test can pass a plain fake object
 * with a `query` method instead, without needing to construct a real
 * `HttpDeepLakeTransport` or reach for a mocking library (hivenectar has
 * none, by design).
 */
export interface QueryRunner {
  query(sql: string): Promise<DeepLakeRow[]>;
}

/**
 * Classify a `query`-kind `TransportError` message as a missing-table failure
 * (mirrors honeycomb's `classifyFailure`, `src/daemon/storage/heal.ts:77-98`,
 * missing-table branch only). Auth/permission failures are excluded first so a
 * message that happens to mention a relation is never misread as a schema gap.
 */
export function isMissingTableError(err: TransportError): boolean {
  if (err.kind !== "query") return false;
  if (/permission denied|must be owner|not authorized|forbidden|unauthorized/i.test(err.message)) {
    return false;
  }
  return /table does not exist|relation ["']?[A-Za-z_][A-Za-z0-9_.]*["']? does not exist|no such table/i.test(
    err.message,
  );
}

/**
 * Run a write, and on a missing-table failure, CREATE the table and retry the
 * write EXACTLY ONCE. Any other failure (or a success) returns/throws
 * immediately and unhealed. A second failure after the heal propagates
 * without a further retry (no infinite loop).
 *
 * `runWrite` is the original statement's thunk so the retry re-issues the
 * identical write.
 */
export async function withHeal(
  transport: QueryRunner,
  table: CatalogTable,
  runWrite: () => Promise<DeepLakeRow[]>,
): Promise<DeepLakeRow[]> {
  try {
    return await runWrite();
  } catch (err: unknown) {
    if (!(err instanceof TransportError) || !isMissingTableError(err)) {
      throw err;
    }
    // Missing table: create it (IF NOT EXISTS makes concurrent heals
    // converge), then retry the original write exactly once. Any failure from
    // here on (the create itself, or the retried write) propagates unchanged.
    await transport.query(buildCreateTableSql(table));
    return runWrite();
  }
}
