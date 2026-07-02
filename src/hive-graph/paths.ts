/**
 * Path helpers for building version rows (PRD-005 / PRD-006).
 *
 * Paths in `hive_graph_versions.path` are repo-relative with forward slashes,
 * regardless of OS. `filename` and `ext` are denormalized from the path for fast
 * filename-only search and extractor routing (per hive-graph-schema.md).
 */
import { relative, basename, extname } from "node:path";

/** Repo-relative, forward-slashed path. `root` is the project root; `absOrRel` may be absolute or already relative. */
export function toRepoRelative(absOrRel: string, root: string): string {
  const rel = relative(root, absOrRel);
  // If `absOrRel` was already relative to cwd and not under root, `relative` may
  // return it unchanged; normalize separators either way.
  const forward = (rel === "" ? absOrRel : rel).replace(/\\/g, "/");
  return forward.replace(/^\.\//, "");
}

/** Bare filename (`a.ts`) from a path. */
export function filenameOf(p: string): string {
  return basename(p.replace(/\\/g, "/"));
}

/** Lowercased extension without the leading dot (`ts`, `md`, `json`); empty string if none. */
export function extOf(p: string): string {
  const ext = extname(p);
  return ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase();
}
