/**
 * SQL-safety escaping helpers for the Deep Lake adapter (PRD-005).
 *
 * Ported (not imported) from honeycomb's `src/daemon/storage/sql.ts`, per
 * ADR-0002: hivenectar reaches Deep Lake over the network through its own
 * client and never imports the honeycomb runtime in-process, so the escaping
 * floor is mirrored here rather than shared across the process boundary.
 *
 * The Deep Lake HTTP query endpoint binds no parameters: every value is
 * escaped and interpolated into the statement by hand before it is sent.
 * There is no parameterized fallback to forget to use, so these helpers ARE
 * the parameter binding. Every dynamic value the Deep Lake adapter builds
 * (`schema.ts`'s `buildCreateTableSql`, `deeplake-store.ts`'s query builders)
 * routes through `sqlStr` / `sqlLike` / `sqlIdent` / `sLiteral` / `eLiteral`.
 *
 * These functions are pure, synchronous, side-effect-free, and dependency-free
 * beyond the language runtime (hivenectar's zero-runtime-dependency rule).
 */

/**
 * Escape a string for use inside a single-quoted SQL literal.
 *
 * Order matters: backslashes are doubled FIRST (so the backslash added for a
 * doubled quote is not itself re-escaped), then single quotes are doubled,
 * then NUL and the C0/C1 control characters are dropped. The result is the
 * inner body of the literal; the caller wraps it in quotes (`'${sqlStr(v)}'`,
 * or via {@link sLiteral}) or uses the `E'...'` form via {@link eLiteral} when
 * the body carries escape sequences.
 *
 * Because every quote is doubled and every backslash is doubled, an injection
 * payload like `'; DROP TABLE x; --` collapses to one inert literal: the
 * embedded quote can never close the string early, so no second statement is
 * ever produced.
 */
export function sqlStr(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\0/g, "")
    // Drop C0 controls except \t (0x09) \n (0x0A) \r (0x0D), plus DEL (0x7f).
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Escape a string for use inside a `LIKE` / `ILIKE` pattern.
 *
 * Escapes the `LIKE` metacharacters (`%` and `_`) so a literal substring
 * search is never reinterpreted as a wildcard match, alongside the same
 * quote-doubling and control stripping {@link sqlStr} performs. Not currently
 * exercised by the source-graph store's equality-only reads, but ported
 * alongside `sqlStr`/`sqlIdent` so a future prefix/substring query never has
 * to reach for a hand-rolled escape.
 */
export function sqlLike(value: string): string {
  return value
    .replace(/[\\%_]/g, "\\$&")
    .replace(/'/g, "''")
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Validate a table/column identifier against `^[a-zA-Z_][a-zA-Z0-9_]*$`.
 * Returns the name UNCHANGED on success; throws on anything else.
 *
 * Strict by design: it THROWS rather than sanitizing, because a silently
 * rewritten identifier would be a worse, harder-to-debug failure than a
 * rejected one. Callers pass only known schema names (table and column
 * identifiers from `SOURCE_GRAPH_COLUMNS` / `SOURCE_GRAPH_VERSIONS_COLUMNS`),
 * so a rejection is always a programmer error worth surfacing.
 */
export function sqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Build an ordinary single-quoted literal from a value. Thin convenience
 * around `'${sqlStr(v)}'` so call sites read as a builder call rather than raw
 * quote assembly. Use for ids, paths, hashes, enum-like values, and dates.
 * Use {@link eLiteral} instead when the body may carry escape sequences
 * (free-text title/description/concepts).
 */
export function sLiteral(value: string): string {
  return `'${sqlStr(value)}'`;
}

/**
 * Build an `E'...'` escape-string literal from a raw text body.
 *
 * Free-text bodies that may contain escape sequences (a description or title
 * with a literal backslash) must use the `E'...'` form so the
 * doubled-backslash escaping from {@link sqlStr} round-trips to the intended
 * bytes; a plain `'...'` literal for a body with backslashes would corrupt it.
 */
export function eLiteral(body: string): string {
  return `E'${sqlStr(body)}'`;
}

/**
 * Validate and render a numeric value for bare (unquoted) SQL interpolation.
 * Throws unless `value` is, at runtime, a finite JavaScript `number` -
 * TypeScript's `number` type is erased at runtime, so a value that merely
 * carries the `number` type at compile time (e.g. `row.seq`, `row.sizeBytes`,
 * `row.confidence`, or one entry of an embedding vector) is not actually
 * guaranteed to be a safe, quote-free numeric literal unless this is checked
 * here. Without this guard, a non-numeric value smuggled past the type
 * system (a string, `NaN`, `Infinity`, or an object) would be interpolated
 * bare via `String(value)` with no escaping at all - the same injection
 * shape `sqlStr`/`sqlIdent` close for text and identifiers, just for the
 * numeric case. Rejects `NaN`/`Infinity`/`-Infinity` too, since those are not
 * valid bare-numeric SQL tokens.
 */
export function sqlNum(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid SQL numeric value: ${JSON.stringify(value)}`);
  }
  return String(value);
}

/**
 * Serialize a `number[]` to a `FLOAT4[]` SQL literal (`ARRAY[...]::float4[]`),
 * mirroring honeycomb's `serializeFloat4Array` (`src/daemon/storage/vector.ts`).
 * Every entry is validated via {@link sqlNum} before interpolation - the
 * dimension contract (`isValidEmbedding`, 768) is a separate application-level
 * check the caller is still responsible for, but this function does not rely
 * on the caller to have validated *finiteness*: a non-numeric or non-finite
 * entry throws here rather than being interpolated bare into the statement.
 */
export function sqlFloat4Array(vector: readonly number[]): string {
  const numbersLit = vector.map((v) => sqlNum(v)).join(",");
  return `ARRAY[${numbersLit}]::float4[]`;
}
