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
}

/**
 * The git-discovery seam. Returns the NUL-delimited path list, or
 * `{ available: false }` when git could not run (ENOENT, non-zero exit, no
 * repo). Injectable so a test drives discovery without a real git binary.
 */
export type GitLsFiles = (root: string) => GitLsFilesResult;
export type GitLsFilesResult =
  | { readonly available: true; readonly paths: readonly string[] }
  | { readonly available: false };

/** Max bytes captured from `git ls-files` stdout (guards a pathological repo). */
export const GIT_LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;

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
  } catch {
    return { available: false };
  }
  if (res.error !== undefined || res.status !== 0 || res.stdout === null) {
    return { available: false };
  }
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString("utf8") : String(res.stdout);
  const paths = stdout
    .split("\0")
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => p.length > 0);
  return { available: true, paths };
};

export interface DiscoverFilesOptions {
  readonly root: string;
  /** Filesystem seam (default: the caller supplies a disk-backed `RegistrationFs`). */
  readonly fs: RegistrationFs;
  /** The git runner (default {@link spawnGitLsFiles}). */
  readonly gitLsFiles?: GitLsFiles;
  /** The ignore predicate for the WALK fallback (default: `createDefaultIgnore(root)`). */
  readonly isIgnored?: IgnorePredicate;
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
    const files: DiscoveredFile[] = [];
    const seen = new Set<string>();
    for (const rel of git.paths) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const discovered = toDiscovered(rel, opts.fs);
      if (discovered !== null) files.push(discovered);
    }
    return { source: "git", files };
  }

  // Fallback: manual recursive walk applying the shared CodeGraph ignore contract.
  const isIgnored = opts.isIgnored ?? createDefaultIgnore(opts.root);
  const files: DiscoveredFile[] = [];
  const seen = new Set<string>();
  for (const raw of opts.fs.listPaths()) {
    const rel = raw.replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (isIgnored(rel)) continue;
    const discovered = toDiscovered(rel, opts.fs);
    if (discovered !== null) files.push(discovered);
  }
  return { source: "walk", files };
}
