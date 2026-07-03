/**
 * Brooding discovery (PRD-007a) - stage 1 of the pipeline.
 *
 * Enumerates the files to brood. The primary path re-implements the CodeGraph's
 * discovery command verbatim (decision #18: nectar spawns git as a child
 * process rather than importing a honeycomb module or calling an HTTP service):
 *
 *   git ls-files --cached --others --exclude-standard -z
 *
 * - `--cached`  files already tracked in the index.
 * - `--others`  untracked files on disk.
 * - `--exclude-standard`  honor `.gitignore`, `.git/info/exclude`, and
 *   `core.excludesfile` exactly, so discovery matches what the operator expects.
 * - `-z`  NUL-delimited output so paths with spaces/quotes/newlines are safe.
 *
 * When git is unavailable (no `.git`, git not on PATH, non-git workspace), it
 * falls back to a manual recursive walk that applies the SAME ignore contract
 * the CodeGraph uses (`registration/ignore.ts`, honoring
 * `.honeycomb/graph-ignore.json`). Nectar maintains no ignore list of its own.
 */
import { spawnSync } from "node:child_process";
import { createDefaultIgnore, type IgnorePredicate } from "../registration/ignore.js";
import { extOf } from "../hive-graph/paths.js";
import type { RegistrationFs } from "../registration/service.js";

/** A discovered candidate file: a repo-relative (forward-slashed) path plus its stat metadata. */
export interface DiscoveredFile {
  /** Repo-relative, forward-slashed path. */
  readonly relPath: string;
  readonly sizeBytes: number;
  /** File mtime at observation (ISO 8601). */
  readonly mtimeObserved: string;
  /** Lowercased extension without the dot (`ts`, `md`, `png`); empty if none. */
  readonly ext: string;
}

/** How the candidate set was produced (git vs the manual walk fallback). */
export type DiscoverySource = "git" | "walk";

export interface DiscoveryResult {
  readonly source: DiscoverySource;
  readonly files: readonly DiscoveredFile[];
  /**
   * Set when `source` is "walk" because git is PRESENT but ERRORED (PRD-018c
   * NEC-039 / AC-018c.10) - never set when git is genuinely absent (that walk
   * is silent and correct). Surfaced so `nectar brood --dry-run` can report
   * the degradation instead of a user discovering it only via an inflated
   * brood cost (AC-018c.11).
   */
  readonly degraded?: { readonly reason: string };
}

/** Thrown by {@link discoverFiles} when `onGitErrorPolicy` is `"abort"` and git is present but `ls-files` failed (PRD-018c NEC-039 / AC-018c.10). */
export class GitDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiscoveryError";
  }
}

/**
 * The git-discovery seam. Returns the NUL-delimited path list, or
 * `{ available: false }` when git could not run (ENOENT, non-zero exit, no
 * repo). Injectable so a test drives discovery without a real git binary.
 */
export type GitLsFiles = (root: string) => GitLsFilesResult;
export type GitLsFilesResult =
  | { readonly available: true; readonly paths: readonly string[] }
  | {
      readonly available: false;
      /**
       * PRD-018c NEC-039 / AC-018c.10: distinguishes git genuinely ABSENT
       * (no `.git`, no `git` on PATH - the walk fallback is silent and
       * correct) from git PRESENT but ERRORING (non-zero exit, `ENOBUFS` -
       * must be surfaced loudly, never a silent gitignore-blind walk).
       * Omitted by hand-written test fakes (`{ available: false }`), which
       * `discoverFiles` treats as the pre-018c "absent" behavior.
       */
      readonly reason?: "absent" | "error";
      readonly message?: string;
    };

/** Max bytes captured from `git ls-files` stdout (guards a pathological repo). */
export const GIT_LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Normalize path separators to forward slashes ONLY on Windows (NEC-042 item 11
 * / AC-018l.18). On POSIX a literal backslash is a VALID filename character, so
 * rewriting `\` -> `/` corrupted `a\b.ts` into `a/b.ts` (which then failed to
 * stat and was silently dropped). Git already emits forward slashes on Windows,
 * so this is a defensive no-op there; on POSIX the path is left untouched.
 */
export function normalizeRepoSeparators(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? p.replace(/\\/g, "/") : p;
}

/**
 * The discovery command arguments, carried verbatim from `brooding-pipeline.md`:
 * `git ls-files --cached --others --exclude-standard -z`. Exposed so the exact
 * command is verifiable and reused by {@link spawnGitLsFiles}.
 */
export const GIT_LS_FILES_ARGS: readonly string[] = [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
];

/**
 * The default git runner: spawns `git ls-files --cached --others
 * --exclude-standard -z` in `root` and splits the NUL-delimited stdout. Never
 * throws - any spawn error or non-zero status reads as `{ available: false }`
 * so the caller falls back to the manual walk.
 */
export const spawnGitLsFiles: GitLsFiles = (root: string): GitLsFilesResult => {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", [...GIT_LS_FILES_ARGS], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
      windowsHide: true,
    });
  } catch (err) {
    // spawnSync itself throwing generally means the `git` binary could not be
    // resolved at all: absent, not an error (NEC-039).
    return { available: false, reason: "absent", message: err instanceof Error ? err.message : String(err) };
  }
  if (res.error !== undefined) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { available: false, reason: "absent", message: res.error.message };
    // ENOBUFS (ls-files output exceeded maxBuffer) and any other spawn-level
    // error mean git IS present but the call itself failed: loud, never silent.
    return { available: false, reason: "error", message: res.error.message };
  }
  if (res.status !== 0) {
    const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : String(res.stderr ?? "");
    if (/not a git repository/i.test(stderr)) {
      return { available: false, reason: "absent", message: stderr.trim() };
    }
    return {
      available: false,
      reason: "error",
      message: stderr.trim() || `git ls-files exited with status ${String(res.status)}`,
    };
  }
  if (res.stdout === null) {
    return { available: false, reason: "error", message: "git ls-files produced no stdout" };
  }
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString("utf8") : String(res.stdout);
  const paths = stdout
    .split("\0")
    .map((p) => normalizeRepoSeparators(p))
    .filter((p) => p.length > 0);
  return { available: true, paths };
};

export interface DiscoverFilesOptions {
  readonly root: string;
  /** Filesystem seam (default: the caller supplies a disk-backed `RegistrationFs`). */
  readonly fs: RegistrationFs;
  /** The git runner (default {@link spawnGitLsFiles}). */
  readonly gitLsFiles?: GitLsFiles;
  /**
   * The shared ignore predicate (PRD-018c AC-018c.1), applied on BOTH the git
   * path and the walk fallback (default: `createDefaultIgnore(root)`, the
   * segments+graph-ignore-only default; production wiring passes the
   * `createSharedIgnore(root).isIgnored` predicate the watch intake and resync
   * path also share).
   */
  readonly isIgnored?: IgnorePredicate;
  /**
   * PRD-018c NEC-039 / AC-018c.10: the policy when git is PRESENT but
   * `ls-files` failed. `"warn"` (default) falls back to the walk but marks the
   * result `degraded` with the reason, so the caller can surface it loudly
   * (the dry-run report does, AC-018c.11). `"abort"` throws
   * {@link GitDiscoveryError} instead of ever walking. Git genuinely ABSENT is
   * never "degraded" - the walk is the correct, silent behavior in that case.
   */
  readonly onGitErrorPolicy?: "warn" | "abort";
  /**
   * The platform whose separator convention the walk fallback applies (NEC-042
   * item 11 / AC-018l.18). Defaults to `process.platform`; injectable so a test
   * can prove a POSIX filename with a literal backslash survives regardless of
   * the host OS. On non-Windows the `\` -> `/` rewrite is skipped.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Stat a repo-relative path into a {@link DiscoveredFile}, or `null` when it is
 * not a readable file (a directory, a broken symlink, or a git-tracked path that
 * no longer exists on disk - the `--cached` set can name a since-deleted file).
 */
function toDiscovered(relPath: string, fs: RegistrationFs): DiscoveredFile | null {
  const stat = fs.statPath(relPath);
  if (stat === null) return null;
  return {
    relPath,
    sizeBytes: stat.sizeBytes,
    mtimeObserved: stat.mtimeObserved,
    ext: extOf(relPath),
  };
}

/**
 * Discover the candidate file set (pipeline stage 1). Uses `git ls-files` when
 * git is available, else the manual recursive walk with the shared ignore
 * contract. Both paths produce repo-relative, forward-slashed paths with stat
 * metadata; paths that do not stat as a readable file are dropped.
 */
export function discoverFiles(opts: DiscoverFilesOptions): DiscoveryResult {
  const gitLsFiles = opts.gitLsFiles ?? spawnGitLsFiles;
  const git = gitLsFiles(opts.root);

  if (git.available) {
    // PRD-018c NEC-007 / AC-018c.3: the git path now applies the SAME shared
    // predicate the walk fallback already did - a graph-ignore.json-excluded,
    // git-TRACKED file (and the committed `.honeycomb/nectars.json` itself,
    // via the `.honeycomb` segment rule) is no longer described just because
    // it is git-tracked.
    const isIgnored = opts.isIgnored ?? createDefaultIgnore(opts.root);
    const files: DiscoveredFile[] = [];
    const seen = new Set<string>();
    for (const rel of git.paths) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (isIgnored(rel)) continue;
      const discovered = toDiscovered(rel, opts.fs);
      if (discovered !== null) files.push(discovered);
    }
    return { source: "git", files };
  }

  // PRD-018c NEC-039 / AC-018c.10: git present but ERRORED must never
  // silently collapse into a `.gitignore`-blind walk. "absent" (or a
  // hand-written test fake omitting `reason` entirely) keeps the pre-018c
  // silent-walk behavior, since a non-git workspace has no gitignore
  // semantics to lose in the first place.
  if (git.reason === "error") {
    if ((opts.onGitErrorPolicy ?? "warn") === "abort") {
      throw new GitDiscoveryError(git.message ?? "git ls-files failed");
    }
  }

  // Fallback: manual recursive walk applying the shared CodeGraph ignore contract.
  const isIgnored = opts.isIgnored ?? createDefaultIgnore(opts.root);
  const files: DiscoveredFile[] = [];
  const seen = new Set<string>();
  for (const raw of opts.fs.listPaths()) {
    const rel = normalizeRepoSeparators(raw, opts.platform);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (isIgnored(rel)) continue;
    const discovered = toDiscovered(rel, opts.fs);
    if (discovered !== null) files.push(discovered);
  }
  const result: DiscoveryResult = { source: "walk", files };
  return git.reason === "error" ? { ...result, degraded: { reason: git.message ?? "git ls-files failed" } } : result;
}
