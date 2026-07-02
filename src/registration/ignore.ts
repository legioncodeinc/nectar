/**
 * The workspace ignore contract for the file-registration intake (PRD-006a).
 *
 * Nectar does not maintain its own bespoke ignore list. Per PRD-006a
 * ("Workspace scope and the ignore contract") and brooding-pipeline.md, the
 * live-watch intake honors the SAME ignore contract the CodeGraph discovery
 * uses: git-tracked-set semantics plus a per-repo ignore file. The daemon can
 * later inject the real CodeGraph predicate; this module provides a pragmatic,
 * dependency-free default so the intake is correct before that wiring lands.
 *
 * The default:
 *   - always skips the version-control and dependency dirs every CodeGraph
 *     discovery skips (`.git/`, `node_modules/`), and the daemon runtime dir
 *     (`.honeycomb/`) so the projection/lock/pid churn never triggers a cycle,
 *   - honors a `.honeycomb/graph-ignore.json`-style per-repo ignore file if one
 *     is present at the workspace root, matching the CodeGraph's own ignore-file
 *     convention (no nectar-specific list is invented).
 *
 * `isIgnored` takes a repo-relative, forward-slashed path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A predicate over a repo-relative (forward-slashed) path: true means "drop, never register". */
export type IgnorePredicate = (relPath: string) => boolean;

/** Path segments always dropped, independent of any ignore file. */
export const ALWAYS_IGNORED_SEGMENTS: readonly string[] = [".git", "node_modules", ".honeycomb"];

/** The per-repo ignore file the CodeGraph discovery convention uses (relative to the workspace root). */
export const GRAPH_IGNORE_FILE = ".honeycomb/graph-ignore.json";

function normalize(relPath: string): string {
  // Trim a trailing slash too, so a declared prefix like "dist/" matches "dist"
  // and "dist/x" whether or not the ignore file wrote the trailing slash.
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** True if any path segment equals one of the always-ignored dir names. */
function hasIgnoredSegment(relPath: string): boolean {
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (ALWAYS_IGNORED_SEGMENTS.includes(seg)) return true;
  }
  return false;
}

/**
 * Read the per-repo ignore file (a JSON array of prefixes, or `{ "ignore": [...] }`).
 * Missing or malformed files yield an empty list (fail-open to the built-in
 * segment rules); a hard read error other than "not found" is swallowed so the
 * intake never crashes on a bad ignore file.
 */
export function loadIgnorePrefixes(
  root: string,
  readFile: (p: string) => string | null = defaultReadFile,
): readonly string[] {
  let raw: string | null;
  try {
    raw = readFile(join(root, GRAPH_IGNORE_FILE));
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { ignore?: unknown }).ignore)
      ? (parsed as { ignore: unknown[] }).ignore
      : [];
  return list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).map(normalize);
}

function defaultReadFile(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Build the default ignore predicate for a workspace root. Combines the built-in
 * segment rules with any prefixes declared in the repo's `graph-ignore.json`.
 * A path is ignored if it (a) contains an always-ignored segment, or (b) equals
 * or sits under one of the declared ignore prefixes.
 */
export function createDefaultIgnore(
  root: string,
  readFile: (p: string) => string | null = defaultReadFile,
): IgnorePredicate {
  const prefixes = loadIgnorePrefixes(root, readFile);
  return (relPath: string): boolean => {
    const p = normalize(relPath);
    if (p === "") return true;
    if (hasIgnoredSegment(p)) return true;
    for (const prefix of prefixes) {
      if (p === prefix || p.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };
}
