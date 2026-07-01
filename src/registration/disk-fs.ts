/**
 * A real-disk {@link RegistrationFs} with workspace-path containment (CWE-22).
 *
 * This is the concrete filesystem seam the daemon uses to stat, read, and list
 * files under the workspace root. Every disk access is clamped by
 * {@link realpathContained}: a path that is absolute, contains a `..` segment,
 * or (via a symlink) resolves outside the real workspace root is refused before
 * any `stat`/`read`, and `listPaths` never follows a symlink out of the tree.
 * Tests and local dev may still inject an in-memory `RegistrationFs`; this is
 * the production disk implementation.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { isSafeRelPath, realpathContained } from "./paths-safe.js";
import type { RegistrationFs, StatResult } from "./service.js";

export function createDiskRegistrationFs(root: string): RegistrationFs {
  return {
    statPath(rel: string): StatResult | null {
      const abs = realpathContained(root, rel);
      if (abs === null) return null; // escapes the workspace, or does not exist
      let st;
      try {
        st = statSync(abs);
      } catch {
        return null;
      }
      if (!st.isFile()) return null;
      return {
        sizeBytes: st.size,
        mtimeObserved: st.mtime.toISOString(),
        readContent: () => readFileSync(abs),
      };
    },
    existsOnDisk(rel: string): boolean {
      const abs = realpathContained(root, rel);
      if (abs === null) return false;
      try {
        return statSync(abs).isFile(); // a directory (or anything non-file) is NOT a tracked path
      } catch {
        return false;
      }
    },
    listPaths(): Iterable<string> {
      return walk(root, root);
    },
  };
}

/** Recursively yield repo-relative, forward-slashed file paths under `dir`, never following a symlink out of `root`. */
function* walk(root: string, dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow a symlink (defeats symlink escape)
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, abs);
    } else if (entry.isFile()) {
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (isSafeRelPath(rel)) yield rel;
    }
  }
}
