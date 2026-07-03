/**
 * The workspace ignore contract for the file-registration intake (PRD-006a),
 * extended by PRD-018c (NEC-007) into the ONE shared predicate every leg of
 * the mission consults.
 *
 * Nectar does not maintain its own bespoke ignore list. Per PRD-006a
 * ("Workspace scope and the ignore contract") and brooding-pipeline.md, the
 * live-watch intake honors the SAME ignore contract the CodeGraph discovery
 * uses: git-tracked-set semantics plus a per-repo ignore file. The daemon can
 * later inject the real CodeGraph predicate; this module provides a pragmatic,
 * dependency-free default so the intake is correct before that wiring lands.
 *
 * The default ({@link createDefaultIgnore}):
 *   - always skips the version-control and dependency dirs every CodeGraph
 *     discovery skips (`.git/`, `node_modules/`), and the daemon runtime dir
 *     (`.honeycomb/`) so the projection/lock/pid churn never triggers a cycle,
 *   - honors a `.honeycomb/graph-ignore.json`-style per-repo ignore file if one
 *     is present at the workspace root, matching the CodeGraph's own ignore-file
 *     convention (no nectar-specific list is invented).
 *
 * PRD-018c NEC-007 adds {@link createSharedIgnore}: the default UNION
 * `.gitignore` semantics, so brooding discovery, the watch intake, and the
 * resync path all exclude exactly the same set (AC-018c.1). Gitignore
 * semantics are approximated by a cached `git ls-files --cached --others
 * --exclude-standard` snapshot (the same "tracked + untracked-but-not-ignored"
 * set brooding discovery already uses), refreshed on resync rather than
 * spawned per event, with `git check-ignore` as the per-path fallback for a
 * cache miss (a path created since the last refresh). Git genuinely absent
 * degrades to the segment/graph-ignore-only default (silent, matches the walk
 * fallback); git present but ERRORING is surfaced through `onGitError`,
 * never silently collapsed (NEC-039).
 *
 * `isIgnored` takes a repo-relative, forward-slashed path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

// ── PRD-018c NEC-007/NEC-039: the git side of the shared ignore predicate ────

/** Args for the tracked+untracked-but-not-ignored snapshot (the same set brooding discovery enumerates). */
const GIT_SNAPSHOT_ARGS: readonly string[] = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];

/** Guards a pathological repo's `ls-files` output. */
const GIT_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The 3-way result NEC-039 requires: git may be genuinely absent (no `.git`,
 * no `git` on PATH - degrading to the segment/graph-ignore-only predicate is
 * correct and silent), or present but ERRORING (non-zero exit, `ENOBUFS` -
 * this must never silently collapse the predicate), or a clean snapshot.
 */
export type GitLsFilesProbe =
  | { readonly status: "absent" }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "ok"; readonly paths: readonly string[] };

export type GitLsFilesRunner = (root: string) => GitLsFilesProbe;

/** The real `git ls-files` runner: spawns synchronously, never throws. */
export const runGitLsFiles: GitLsFilesRunner = (root: string): GitLsFilesProbe => {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", [...GIT_SNAPSHOT_ARGS], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
      windowsHide: true,
    });
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
  if (res.error !== undefined) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" }; // git not on PATH
    // ENOBUFS (output exceeded maxBuffer) and any other spawn-level error mean
    // git IS present but the call itself failed: loud, never silent (NEC-039).
    return { status: "error", reason: res.error.message };
  }
  if (res.status !== 0) {
    const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : String(res.stderr ?? "");
    if (/not a git repository/i.test(stderr)) return { status: "absent" };
    return { status: "error", reason: stderr.trim() || `git exited with status ${String(res.status)}` };
  }
  if (res.stdout === null) return { status: "error", reason: "git ls-files produced no stdout" };
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString("utf8") : String(res.stdout);
  const paths = stdout
    .split("\0")
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => p.length > 0);
  return { status: "ok", paths };
};

/** Per-path `git check-ignore` fallback for a snapshot cache miss. Returns null when it cannot be determined (git errored/absent). */
export type GitCheckIgnoreRunner = (root: string, relPath: string) => boolean | null;

export const runGitCheckIgnore: GitCheckIgnoreRunner = (root: string, relPath: string): boolean | null => {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", ["check-ignore", "-q", "--", relPath], { cwd: root, windowsHide: true });
  } catch {
    return null;
  }
  if (res.error !== undefined) return null;
  // check-ignore: exit 0 = ignored, 1 = not ignored, >1 (typically 128) = fatal error.
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return null;
};

/** The composed shared predicate (PRD-018c AC-018c.1) plus its resync-refresh and observability seams. */
export interface SharedIgnore {
  /** segments ∪ graph-ignore ∪ gitignore semantics. The SAME function reference every consumer shares. */
  readonly isIgnored: IgnorePredicate;
  /** Refresh the cached gitignore snapshot (call once per resync, NEC-007 point 1). */
  refresh(): void;
  /** Whether git participates at all in this workspace right now (false => the predicate is segments+graph-ignore only). */
  isGitAvailable(): boolean;
  /** The reason the last refresh degraded (git present but errored), or null when healthy or git is absent. */
  lastGitError(): string | null;
}

export interface SharedIgnoreOptions {
  /** Read the per-repo ignore file (default: real disk read). */
  readonly readFile?: (p: string) => string | null;
  /** The git ls-files snapshot runner (default: {@link runGitLsFiles}). Injectable for tests. */
  readonly gitLsFiles?: GitLsFilesRunner;
  /** The git check-ignore per-path fallback runner (default: {@link runGitCheckIgnore}). Injectable for tests. */
  readonly gitCheckIgnore?: GitCheckIgnoreRunner;
  /**
   * Called whenever a refresh finds git PRESENT but ERRORING (NEC-039): the
   * last good snapshot (if any) is kept rather than silently discarded, and
   * this hook lets the caller log or otherwise surface the degradation loudly.
   * Defaults to a no-op.
   */
  readonly onGitError?: (reason: string) => void;
}

/**
 * Build the ONE shared ignore predicate for a workspace (PRD-018c AC-018c.1):
 * {@link createDefaultIgnore}'s segments+graph-ignore UNION gitignore
 * semantics, approximated by a cached `git ls-files` snapshot with a
 * per-path `git check-ignore` fallback for cache misses. Call {@link
 * SharedIgnore.refresh} once per resync to keep the snapshot warm without
 * spawning git on every watch event.
 */
export function createSharedIgnore(root: string, opts: SharedIgnoreOptions = {}): SharedIgnore {
  const base = createDefaultIgnore(root, opts.readFile);
  const gitLsFiles = opts.gitLsFiles ?? runGitLsFiles;
  const gitCheckIgnore = opts.gitCheckIgnore ?? runGitCheckIgnore;
  const onGitError = opts.onGitError ?? (() => {});

  /** Tracked+untracked-not-ignored snapshot; null when git is absent or no snapshot has ever succeeded. */
  let eligible: Set<string> | null = null;
  let gitAvailable = false;
  let lastError: string | null = null;

  function refresh(): void {
    const probe = gitLsFiles(root);
    switch (probe.status) {
      case "ok":
        eligible = new Set(probe.paths);
        gitAvailable = true;
        lastError = null;
        return;
      case "absent":
        eligible = null;
        gitAvailable = false;
        lastError = null;
        return;
      case "error":
        // Git IS present but errored (NEC-039): the failure is ALWAYS
        // surfaced loudly via `onGitError`, regardless of caching. Whether
        // gitignore semantics stay "available" depends on whether a prior
        // successful snapshot is still cached: a still-useful (if stale)
        // snapshot is never abandoned just because the LATEST refresh failed,
        // but a workspace with no snapshot at all never silently claims full
        // gitignore coverage by spawning `check-ignore` for every single
        // path - it degrades to the segment/graph-ignore-only base instead.
        gitAvailable = eligible !== null;
        lastError = probe.reason;
        onGitError(probe.reason);
        return;
      default: {
        const _exhaustive: never = probe;
        return _exhaustive;
      }
    }
  }
  refresh(); // NEC-007 point 1: warm the cache once at construction.

  function isGitIgnored(relPath: string): boolean {
    if (eligible === null) return false; // no usable snapshot (git absent, or errored with nothing cached yet)
    if (eligible.has(relPath)) return false; // definitely NOT ignored
    // Cache miss against a real (possibly stale) snapshot: either genuinely
    // ignored, or created since the last refresh. The per-path fallback keeps
    // this correct without spawning git for every single event (NEC-007
    // point 1) - it only runs for paths the last known-good snapshot didn't
    // already resolve.
    return gitCheckIgnore(root, relPath) === true;
  }

  return {
    isIgnored: (relPath: string): boolean => base(relPath) || isGitIgnored(relPath),
    refresh,
    isGitAvailable: () => gitAvailable,
    lastGitError: () => lastError,
  };
}
