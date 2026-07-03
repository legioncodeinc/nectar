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
 *
 * PRD-018c NEC-007 point 2 / AC-018c.4: `walk` takes an ignore predicate and
 * prunes an ignored DIRECTORY at descent time (never `readdirSync`s into it),
 * instead of enumerating the whole subtree and filtering per yielded path.
 */
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { containedPath, isSafeRelPath, realpathContained } from "./paths-safe.js";
import type { IgnorePredicate } from "./ignore.js";
import type { RegistrationFs, StatResult } from "./service.js";

/**
 * True when `rel` is itself a symlink (NEC-042 item 10 / AC-018l.17). `walk`
 * already skips every symlink entry, but `statPath`/`existsOnDisk` resolved
 * through symlinks (`realpathContained`), so a symlinked file registered via a
 * live watch event was invisible to a resync walk. Skipping symlinks in both
 * paths gives the watcher and the resync ONE contract (both skip, matching git).
 * Uses `lstat` (does not follow the link); fails closed (not-a-symlink) when the
 * path is unsafe or does not exist.
 */
function isSymlinkPath(root: string, rel: string): boolean {
  const literal = containedPath(root, rel);
  if (literal === null) return false;
  try {
    return lstatSync(literal).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The directory-listing seam `walk` uses. Injectable so a test can prove descent-time pruning by counting visited directories (default: `node:fs`'s real `readdirSync`). */
export type ReadDirSync = (dir: string) => Dirent[];

const defaultReadDirSync: ReadDirSync = (dir) => readdirSync(dir, { withFileTypes: true });

export function createDiskRegistrationFs(
  root: string,
  isIgnored: IgnorePredicate = () => false,
  readDirSync: ReadDirSync = defaultReadDirSync,
): RegistrationFs {
  return {
    statPath(rel: string): StatResult | null {
      if (isSymlinkPath(root, rel)) return null; // AC-018l.17: skip symlinks, matching walk
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
      if (isSymlinkPath(root, rel)) return false; // AC-018l.17: skip symlinks, matching walk
      const abs = realpathContained(root, rel);
      if (abs === null) return false;
      try {
        return statSync(abs).isFile(); // a directory (or anything non-file) is NOT a tracked path
      } catch {
        return false;
      }
    },
    /** True when `rel` currently exists on disk AS A DIRECTORY (PRD-018c NEC-008 / AC-018c.5). */
    isDirectory(rel: string): boolean {
      const abs = realpathContained(root, rel);
      if (abs === null) return false;
      try {
        return statSync(abs).isDirectory();
      } catch {
        return false;
      }
    },
    listPaths(): Iterable<string> {
      return walk(root, root, isIgnored, readDirSync);
    },
  };
}

/**
 * Recursively yield repo-relative, forward-slashed file paths under `dir`,
 * never following a symlink out of `root`. An ignored directory is pruned at
 * descent time (AC-018c.4): `readDirSync` is never called on it.
 */
function* walk(root: string, dir: string, isIgnored: IgnorePredicate, readDirSync: ReadDirSync): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readDirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow a symlink (defeats symlink escape)
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (isIgnored(rel)) continue; // descent-time pruning: never readDirSync an ignored subtree
      yield* walk(root, abs, isIgnored, readDirSync);
    } else if (entry.isFile()) {
      if (isSafeRelPath(rel) && !isIgnored(rel)) yield rel;
    }
  }
}

/**
 * Test/wiring seam for {@link probeCaseInsensitiveFs} (CodeRabbit PR-18
 * finding #5): defaults to `node:fs`'s real `statSync`. Lets a test simulate
 * the marker vanishing (or an EPERM/AV-interference-shaped fault) between the
 * write and the re-stat without needing a real filesystem race.
 */
export interface ProbeCaseInsensitiveFsIo {
  statSync: typeof statSync;
}

/**
 * Probe whether `root`'s filesystem is case-insensitive (PRD-018c NEC-034 /
 * AC-018c.8): a REAL filesystem probe, never a platform guess. Creates a
 * uniquely-named marker file under `root`, then stats a case-flipped version
 * of that same name; if it resolves to the identical inode, the volume is
 * case-insensitive. Fails closed (returns `false`, i.e. case-SENSITIVE, the
 * behavior-preserving default) when `root` is not writable/statable, so a
 * probe failure never silently enables case-folding.
 */
export function probeCaseInsensitiveFs(root: string, io: ProbeCaseInsensitiveFsIo = { statSync }): boolean {
  const base = `NectarCaseProbe-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const lowerRel = base.toLowerCase();
  const upperRel = base.toUpperCase();
  const lowerAbs = join(root, lowerRel);
  const upperAbs = join(root, upperRel);
  try {
    writeFileSync(lowerAbs, "", { flag: "wx" });
  } catch {
    return false; // cannot probe (root missing/unwritable) - assume case-sensitive
  }
  try {
    // CodeRabbit PR-18 finding #5: the post-write `statSync(lowerAbs)` itself
    // can throw (EPERM, antivirus interference, a marker removed out from
    // under us) just as readily as the case-flipped `statSync(upperAbs)`
    // below already accounted for. An uncaught throw here used to bubble out
    // of RegistrationService construction; wrap it the same way, failing
    // closed (case-SENSITIVE) rather than crashing the caller.
    let lowerStat;
    try {
      lowerStat = io.statSync(lowerAbs);
    } catch {
      return false; // cannot re-stat our own marker -> assume case-sensitive
    }
    let upperStat;
    try {
      upperStat = io.statSync(upperAbs);
    } catch {
      return false; // the case-flipped name does not resolve -> case-sensitive
    }
    return lowerStat.ino === upperStat.ino && lowerStat.dev === upperStat.dev;
  } finally {
    try {
      unlinkSync(lowerAbs);
    } catch {
      // best-effort cleanup; a leftover probe marker is harmless and tiny
    }
  }
}
