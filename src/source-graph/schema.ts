/**
 * Source Graph table definitions (PRD-005), transcribed from the DDL in
 * `library/knowledge/private/data/source-graph-schema.md`.
 *
 * These `ColumnDef[]` arrays are the catalog contract the future Deep Lake
 * adapter registers (mirroring honeycomb's `CatalogTable` / `ColumnDef` and its
 * load-time guard: valid identifiers, no duplicates, and every NOT NULL column
 * carries a DEFAULT, except the nullable `embedding`/`confidence`). Both tables
 * self-create on first write via `withHeal`; there is no DDL pre-step.
 */

export type SqlType = "TEXT" | "BIGINT" | "REAL" | "FLOAT4[]";

export interface ColumnDef {
  readonly name: string;
  readonly type: SqlType;
  /** NOT NULL columns must carry a `default` (the load-time guard). Nullable columns omit it. */
  readonly notNull: boolean;
  readonly default?: string | number;
}

export interface CatalogTable {
  readonly name: string;
  /** Scope is `tenant` for both tables (explicit org/workspace/project columns), mirroring `codebase`. */
  readonly scope: "tenant";
  /** How writes reconcile: identity is upserted, versions are append-only. */
  readonly writePattern: "update-or-insert" | "append-only";
  readonly columns: readonly ColumnDef[];
}

/** `source_graph` (identity + provenance). All TEXT NOT NULL with defaults; `kind` defaults to 'file'. */
export const SOURCE_GRAPH_COLUMNS: readonly ColumnDef[] = [
  { name: "nectar", type: "TEXT", notNull: true, default: "" },
  { name: "kind", type: "TEXT", notNull: true, default: "file" },
  { name: "created_at", type: "TEXT", notNull: true, default: "" },
  { name: "derived_from_nectar", type: "TEXT", notNull: true, default: "" },
  { name: "fork_content_hash", type: "TEXT", notNull: true, default: "" },
  { name: "org_id", type: "TEXT", notNull: true, default: "" },
  { name: "workspace_id", type: "TEXT", notNull: true, default: "" },
  { name: "project_id", type: "TEXT", notNull: true, default: "" },
  { name: "last_update_date", type: "TEXT", notNull: true, default: "" },
];

/** `source_graph_versions` (content + description chain). `embedding` + `confidence` are nullable. */
export const SOURCE_GRAPH_VERSIONS_COLUMNS: readonly ColumnDef[] = [
  { name: "nectar", type: "TEXT", notNull: true, default: "" },
  { name: "content_hash", type: "TEXT", notNull: true, default: "" },
  { name: "seq", type: "BIGINT", notNull: true, default: 0 },
  { name: "path", type: "TEXT", notNull: true, default: "" },
  { name: "filename", type: "TEXT", notNull: true, default: "" },
  { name: "ext", type: "TEXT", notNull: true, default: "" },
  { name: "size_bytes", type: "BIGINT", notNull: true, default: 0 },
  { name: "mtime_observed", type: "TEXT", notNull: true, default: "" },
  { name: "title", type: "TEXT", notNull: true, default: "" },
  { name: "description", type: "TEXT", notNull: true, default: "" },
  { name: "concepts", type: "TEXT", notNull: true, default: "[]" },
  { name: "embedding", type: "FLOAT4[]", notNull: false },
  { name: "confidence", type: "REAL", notNull: false },
  { name: "described_at", type: "TEXT", notNull: true, default: "" },
  { name: "describe_model", type: "TEXT", notNull: true, default: "" },
  { name: "describe_status", type: "TEXT", notNull: true, default: "pending" },
  { name: "observed_at", type: "TEXT", notNull: true, default: "" },
  { name: "org_id", type: "TEXT", notNull: true, default: "" },
  { name: "workspace_id", type: "TEXT", notNull: true, default: "" },
  { name: "project_id", type: "TEXT", notNull: true, default: "" },
  { name: "last_update_date", type: "TEXT", notNull: true, default: "" },
];

export const SOURCE_GRAPH_TABLE: CatalogTable = {
  name: "source_graph",
  scope: "tenant",
  writePattern: "update-or-insert",
  columns: SOURCE_GRAPH_COLUMNS,
};

export const SOURCE_GRAPH_VERSIONS_TABLE: CatalogTable = {
  name: "source_graph_versions",
  scope: "tenant",
  writePattern: "append-only",
  columns: SOURCE_GRAPH_VERSIONS_COLUMNS,
};

/** The `source-graph` catalog group appended to the daemon's CATALOG aggregation. */
export const SOURCE_GRAPH_CATALOG_GROUP = {
  name: "source-graph",
  tables: [SOURCE_GRAPH_TABLE, SOURCE_GRAPH_VERSIONS_TABLE],
} as const;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * The load-time guard (mirrors honeycomb `schema.ts:80-100`): valid identifiers,
 * no duplicate columns, and every NOT NULL column carries a DEFAULT. Throws on
 * violation. Returns the table unchanged so it can wrap a definition inline.
 */
export function assertValidCatalogTable(table: CatalogTable): CatalogTable {
  if (!IDENT_RE.test(table.name)) {
    throw new Error(`invalid table name: ${table.name}`);
  }
  const seen = new Set<string>();
  for (const col of table.columns) {
    if (!IDENT_RE.test(col.name)) {
      throw new Error(`invalid column identifier: ${table.name}.${col.name}`);
    }
    if (seen.has(col.name)) {
      throw new Error(`duplicate column: ${table.name}.${col.name}`);
    }
    seen.add(col.name);
    if (col.notNull && col.default === undefined) {
      throw new Error(`NOT NULL column without DEFAULT: ${table.name}.${col.name}`);
    }
  }
  return table;
}
