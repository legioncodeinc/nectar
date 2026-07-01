/**
 * Workspace path containment for the file-registration surface (CWE-22).
 *
 * `fs.watch` and any injected filesystem seam can hand the pipeline a path that
 * escapes the workspace: an absolute path (Node `path.join(root, abs)` discards
 * `root`), a `..` traversal (`join(root, "../../etc/passwd")` resolves outside
 * `root`), or a symlink inside the root that points out of it. This module is
 * the single, dependency-free (Node built-ins only) guard the intake, the
 * persistence path, and the CLI all use so no such path is ever stat-ed, read,
 * persisted, or allowed to trigger a cycle.
 *
 * Two levels:
 *   - {@link isSafeRelPath} / {@link containedPath}: purely lexical (no disk
 *     access). Reject absolute paths and `..` segments, resolve, and require the
 *     result to stay under the resolved root. Used everywhere a path is handled.
 *   - {@link realpathContained}: the symlink clamp. Resolves symlinks on both the
 *     candidate and the root via `realpathSync` and requires the REAL candidate
 *     to stay under the REAL root. Used only where content is actually read from
 *     a real disk (a symlink inside the root pointing outside is a lexical pass
 *     but a real-path escape).
 */
import { isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * True when `relPath` is a safe workspace-relative path: non-empty, not absolute
 * (POSIX `/...`, Windows `C:\...`, or a UNC/backslash root), and with no `..`
 * segment. This is a lexical check only; it does not touch the disk.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath === "") return false;
  const norm = relPath.replace(/\\/g, "/");
  if (norm.startsWith("/")) return false; // POSIX absolute (or a leading-slash escape)
  if (/^[a-zA-Z]:/.test(norm)) return false; // Windows drive prefix (C:/... or C:\...)
  if (isAbsolute(relPath)) return false; // catches remaining platform-absolute forms
  for (const segment of norm.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

/**
 * Resolve `relPath` under `root` and return the absolute path ONLY if it stays
 * within `root` (inclusive of `root` itself); otherwise null. Lexical: it does
 * not resolve symlinks. Returns null for any path {@link isSafeRelPath} rejects.
 */
export function containedPath(root: string, relPath: string): string | null {
  if (!isSafeRelPath(relPath)) return null;
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, relPath);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null;
  return candidate;
}

/**
 * The symlink clamp for real disk reads: resolve symlinks on both the candidate
 * and the root, and return the real candidate path ONLY if it stays under the
 * real root; otherwise null. Returns null when the candidate does not exist (a
 * broken symlink or missing file), when it is lexically unsafe, or when the real
 * path escapes the root. Use this before reading content from a real filesystem.
 */
export function realpathContained(root: string, relPath: string): string | null {
  const candidate = containedPath(root, relPath);
  if (candidate === null) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return null;
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return null; // does not exist, or a broken symlink
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) return null;
  return realCandidate;
}
