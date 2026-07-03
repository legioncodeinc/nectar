/**
 * Heal-on-first-write for the Deep Lake adapter (PRD-005).
 *
 * Mirrors the missing-table branch of honeycomb's `withHeal`
 * (`src/daemon/storage/heal.ts:286-313`), scoped down to what the
 * hive-graph tables need: a write that fails because its table does not
 * exist yet triggers exactly ONE create-then-retry. Any other failure
 * (permission, connection, timeout, a genuine syntax error) propagates
 * unchanged and never triggers a create — the same anti-mask rule honeycomb's
 * `classifyFailure` documents: a credentials or syntax problem must never be
 * misread as a schema gap behind a confusing CREATE attempt.
 *
 * Column healing (honeycomb's `healColumns` / `ALTER TABLE ADD COLUMN`) is now
 * ported for the additive case (PRD-018i / NEC-018): a write whose statement
 * references a column the live table does not carry yet (an additive nullable
 * column added to the catalog after CREATE, e.g. `embed_model`) triggers exactly
 * ONE `ALTER TABLE ADD COLUMN`-then-retry, mirroring the missing-table branch.
 * Any other failure still propagates unhealed.
 */
import type { CatalogTable, ColumnDef } from "./schema.js";
import { buildAddColumnSql, buildCreateTableSql } from "./schema.js";
import type { DeepLakeRow } from "./deeplake-transport.js";
import { TransportError } from "./deeplake-transport.js";

/**
 * The minimal shape `withHeal` needs from a transport: one method that runs a
 * SQL statement. `HttpDeepLakeTransport` satisfies this structurally (its
 * `query` method is public even though its connection fields are private), so
 * production callers pass it directly; a test can pass a plain fake object
 * with a `query` method instead, without needing to construct a real
 * `HttpDeepLakeTransport` or reach for a mocking library (nectar has
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
  // A missing-COLUMN failure on the live backend also mentions the relation
  // ('Column does not exist: column "x" of relation "t" does not exist'), so
  // exclude the column form first or the wrong heal branch (CREATE TABLE)
  // fires and the ALTER never happens (found by the PRD-018 close-out QA).
  if (missingColumnName(err) !== null) return false;
  return /table does not exist|relation ["']?[A-Za-z_][A-Za-z0-9_.]*["']? does not exist|no such table/i.test(
    err.message,
  );
}

/**
 * Extract the missing-column name from a `query`-kind `TransportError`, or null
 * when the message is not a missing-column failure. Auth/permission failures are
 * excluded first (same anti-mask rule as {@link isMissingTableError}) so a
 * message that happens to mention a column is never misread as a schema gap.
 * Recognizes the common phrasings across SQL backends (`column "x" does not
 * exist`, `no such column: x`, `unknown column 'x'`, `undefined column: x`).
 */
export function missingColumnName(err: TransportError): string | null {
  if (err.kind !== "query") return null;
  if (/permission denied|must be owner|not authorized|forbidden|unauthorized/i.test(err.message)) {
    return null;
  }
  // Quote matcher: the transport surfaces the backend's raw JSON error body,
  // so quotes around identifiers arrive JSON-escaped (`\"embed_model\"`).
  // `Q` tolerates optional backslashes before an optional quote character.
  const q = String.raw`\\*["'\u0060]?`;
  const name = "([A-Za-z_][A-Za-z0-9_]*)";
  const relation = String.raw`[A-Za-z_][A-Za-z0-9_.]*`;
  const patterns = [
    // The live Deep Lake backend's INSERT-path form (measured 2026-07-03):
    // '400: {"error":"Column does not exist: column \"embed_model\" of
    // relation \"hive_graph_versions\" does not exist", ...}'. Must come
    // before the plain form and be recognized at all: without it the trailing
    // 'relation ... does not exist' text matches the missing-TABLE classifier
    // instead and the heal issues a useless CREATE rather than the ALTER.
    new RegExp(`column ${q}${name}${q} of relation ${q}${relation}${q} does not exist`, "i"),
    new RegExp(`column ${q}${name}${q} does not exist`, "i"),
    new RegExp(`no such column:?\\s*${q}${name}${q}`, "i"),
    new RegExp(`unknown column ${q}${name}${q}`, "i"),
    new RegExp(`undefined column:?\\s*${q}${name}${q}`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(err.message);
    if (m !== null && m[1] !== undefined) return m[1];
  }
  return null;
}

/**
 * Run a write, healing the two additive schema gaps EXACTLY ONCE each:
 *   - a missing-table failure -> CREATE the table (IF NOT EXISTS) and retry;
 *   - a missing-column failure whose column is a nullable additive column in
 *     `table` -> `ALTER TABLE ADD COLUMN` and retry (PRD-018i / NEC-018).
 * Any other failure (or a success) returns/throws immediately and unhealed. A
 * second failure after a heal propagates without a further retry (no loop).
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
    if (!(err instanceof TransportError)) throw err;
    if (isMissingTableError(err)) {
      // Missing table: create it (IF NOT EXISTS makes concurrent heals
      // converge), then retry the original write exactly once. Any failure from
      // here on (the create itself, or the retried write) propagates unchanged.
      await transport.query(buildCreateTableSql(table));
      return runWrite();
    }
    const column = missingColumnName(err);
    if (column !== null) {
      const def: ColumnDef | undefined = table.columns.find((c) => c.name === column);
      // Only heal a column the current catalog actually defines AND that is a
      // nullable additive column (NOT NULL columns are part of the CREATE set and
      // never arrive via ALTER; refusing them keeps a stray message from ALTERing
      // a bogus column). A future non-additive add must extend this rule.
      if (def !== undefined && !def.notNull) {
        await transport.query(buildAddColumnSql(table, def));
        return runWrite();
      }
    }
    throw err;
  }
}
