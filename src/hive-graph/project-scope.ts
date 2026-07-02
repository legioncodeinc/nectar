/**
 * Per-project scope resolution for nectar (ADR-0002: nectar and honeycomb are
 * SEPARATE, separately-installable products; nectar never imports honeycomb and
 * never REQUIRES a honeycomb-owned environment variable).
 *
 * This module answers "what project is THIS invocation in?" the same way
 * honeycomb's resolver does (mirrored from
 * `honeycomb/src/hooks/shared/project-resolver.ts`, never imported), over the
 * SHARED Deep Lake family surfaces on disk:
 *
 *   - `~/.deeplake/projects.json`: the folder-to-project bindings + cached
 *     registry projects the deeplake family syncs. Carries no secret. Untrusted
 *     input: hand-validated (this repo is zero-runtime-dependency; no zod) and
 *     FAIL-SOFT: a missing, malformed, or tenancy-mismatched cache reads as
 *     empty, never a throw.
 *   - the repository's own `.git/config` (read directly with `node:fs`, no
 *     shell-out) for the canonical remote signal.
 *
 * Precedence (a superset of honeycomb's ladder, with nectar's own env first):
 *   1. `NECTAR_PROJECT_ID` - nectar's OWN explicit override (source: "env").
 *   2. `HONEYCOMB_PROJECT_ID` - DETECTED when honeycomb is installed alongside
 *      and has pinned a project; honored as a convenience, never required
 *      (source: "detected-honeycomb-env").
 *   3. Folder binding - LONGEST-PREFIX path match of the cwd against the cache
 *      `bindings` (a child binding wins over a parent) (source: "binding").
 *   4. Git-remote signal - the cwd's canonicalized `origin` remote matched
 *      against the cached registry projects' `remoteSignal` (source: "git-signal").
 *   5. The workspace `__unsorted__` inbox - resolution NEVER fails; recall and
 *      registration are never dropped for lack of a binding (source: "inbox").
 *
 * Resolution is a PURE function of `(cwd, env snapshot, cache snapshot, git
 * config snapshot)`: no module-level current-project singleton, so concurrent
 * harness sessions in different folders each resolve their own scope, exactly
 * like honeycomb's per-session discipline.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CREDENTIALS_DIR_NAME } from "./deeplake-credentials.js";

/** nectar's OWN explicit project override (precedence 1). */
export const ENV_PROJECT_ID = "NECTAR_PROJECT_ID" as const;

/** Honeycomb's project pin, DETECTED (never required) when present (precedence 2). */
export const DETECTED_HONEYCOMB_PROJECT_ID = "HONEYCOMB_PROJECT_ID" as const;

/** The reserved per-workspace inbox project id (mirrors the family literal). */
export const UNSORTED_PROJECT_ID = "__unsorted__" as const;

/** The shared deeplake-family projects cache file, beside `credentials.json`. */
export const PROJECTS_CACHE_FILE_NAME = "projects.json" as const;

/** The cache schema version this reader understands. */
export const PROJECTS_CACHE_SCHEMA_VERSION = 1 as const;

/** A folder-to-project binding (longest-prefix matched against the cwd). */
export interface FolderBinding {
  readonly path: string;
  readonly projectId: string;
}

/** A cached registry project (for the offline git-signal branch). */
export interface CachedProject {
  readonly projectId: string;
  readonly name: string;
  /** The canonicalized `host/owner/repo` remote, or "" when none. */
  readonly remoteSignal: string;
  readonly boundPaths: readonly string[];
}

/** The validated (or empty) projects cache. */
export interface ProjectsCache {
  readonly schemaVersion: typeof PROJECTS_CACHE_SCHEMA_VERSION;
  readonly org: string;
  readonly workspace: string;
  readonly bindings: readonly FolderBinding[];
  readonly projects: readonly CachedProject[];
}

/** The empty cache a missing/malformed/mismatched file falls soft to. */
export function emptyProjectsCache(org = "", workspace = ""): ProjectsCache {
  return { schemaVersion: PROJECTS_CACHE_SCHEMA_VERSION, org, workspace, bindings: [], projects: [] };
}

/** Resolve the cache directory (`~/.deeplake`), overridable for tests. */
export function projectsCacheDir(dir?: string): string {
  return dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** Resolve the full cache path within the (possibly overridden) dir. */
export function projectsCachePath(dir?: string): string {
  return join(projectsCacheDir(dir), PROJECTS_CACHE_FILE_NAME);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Load + hand-validate the untrusted `projects.json`. FAIL-SOFT: any missing
 * file, parse error, wrong schema version, malformed row, or dangerous key
 * shape reads as the empty cache. When `expect` is provided, a cache synced for
 * a different org/workspace also reads as empty (it would carry the wrong
 * projects), mirroring honeycomb's tenancy guard.
 */
export function loadProjectsCache(options: { dir?: string; expect?: { org: string; workspace: string } } = {}): ProjectsCache {
  const path = projectsCachePath(options.dir);
  let parsed: unknown;
  try {
    if (!existsSync(path)) return emptyProjectsCache();
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyProjectsCache();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyProjectsCache();
  const rec = parsed as Record<string, unknown>;
  if (rec.schemaVersion !== PROJECTS_CACHE_SCHEMA_VERSION) return emptyProjectsCache();
  if (!isStr(rec.org) || !isStr(rec.workspace)) return emptyProjectsCache();
  if (!Array.isArray(rec.bindings) || !Array.isArray(rec.projects)) return emptyProjectsCache();

  const bindings: FolderBinding[] = [];
  for (const b of rec.bindings) {
    if (typeof b !== "object" || b === null) return emptyProjectsCache();
    const br = b as Record<string, unknown>;
    if (!isStr(br.path) || !isStr(br.projectId)) return emptyProjectsCache();
    bindings.push({ path: br.path, projectId: br.projectId });
  }
  const projects: CachedProject[] = [];
  for (const p of rec.projects) {
    if (typeof p !== "object" || p === null) return emptyProjectsCache();
    const pr = p as Record<string, unknown>;
    if (!isStr(pr.projectId) || !isStr(pr.name) || !isStr(pr.remoteSignal) || !Array.isArray(pr.boundPaths)) {
      return emptyProjectsCache();
    }
    if (!pr.boundPaths.every(isStr)) return emptyProjectsCache();
    projects.push({
      projectId: pr.projectId,
      name: pr.name,
      remoteSignal: pr.remoteSignal,
      boundPaths: pr.boundPaths,
    });
  }

  if (options.expect !== undefined && (rec.org !== options.expect.org || rec.workspace !== options.expect.workspace)) {
    return emptyProjectsCache(rec.org, rec.workspace);
  }
  return { schemaVersion: PROJECTS_CACHE_SCHEMA_VERSION, org: rec.org, workspace: rec.workspace, bindings, projects };
}

/**
 * Fold a raw git remote URL into the canonical `host/owner/repo` identity the
 * registry stores in `remoteSignal`, so the SAME repo reached as
 * `git@github.com:org/x.git`, `https://github.com/org/x`, or
 * `ssh://git@github.com/org/x.git` produces ONE string. Mirrors honeycomb's
 * `canonicalizeRemote` (`honeycomb/src/hooks/shared/project-resolver.ts`) rule
 * for rule; pure, no IO. An input with no usable host+path returns "".
 */
export function canonicalizeRemote(rawRemote: string): string {
  const raw = rawRemote.trim();
  if (raw === "") return "";

  let rest = raw;
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rest);
  if (schemeMatch) {
    rest = rest.slice(schemeMatch[0].length);
  } else {
    const scpMatch = /^([^/:]+):(.+)$/.exec(rest);
    if (scpMatch) rest = `${scpMatch[1]}/${scpMatch[2]}`;
  }

  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) return "";
  let authority = rest.slice(0, firstSlash);
  const pathPart = rest.slice(firstSlash + 1);

  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  const colon = authority.indexOf(":");
  if (colon !== -1) authority = authority.slice(0, colon);
  const host = authority.toLowerCase();
  if (host === "") return "";

  let path = pathPart.replace(/\/+$/, "");
  path = path.replace(/\.git$/i, "");
  const segments = path
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return "";

  return `${host}/${segments.join("/")}`;
}

/**
 * Read the cwd's `origin` remote signal straight from `.git/config` with
 * `node:fs` (no shell-out, per the zero-dependency ethos). Walks up from `cwd`
 * to the repository root; understands both a `.git` DIRECTORY and a `.git`
 * FILE (a linked worktree's `gitdir: <path>` indirection). FAIL-SOFT: any
 * missing/unreadable/parse-defying config reads as "" (no git signal).
 */
export function readGitRemoteSignal(cwd: string): string {
  try {
    let dir = resolve(cwd);
    for (;;) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        const configPath = gitConfigPathFor(dotGit, dir);
        if (configPath === "") return "";
        return canonicalizeRemote(originUrlFromConfig(readFileSync(configPath, "utf8")));
      }
      const parent = dirname(dir);
      if (parent === dir) return "";
      dir = parent;
    }
  } catch {
    return "";
  }
}

/** Resolve the config file for a `.git` entry (directory, or worktree `gitdir:` file). */
function gitConfigPathFor(dotGit: string, repoDir: string): string {
  try {
    const direct = join(dotGit, "config");
    if (existsSync(direct)) return direct;
    // A linked worktree keeps `.git` as a FILE: `gitdir: <path>`; the shared
    // config lives two levels up from `<gitdir>/worktrees/<name>`.
    const content = readFileSync(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
    if (m === null) return "";
    const gitdir = isAbsolute(m[1] ?? "") ? (m[1] ?? "") : resolve(repoDir, m[1] ?? "");
    const worktreeConfig = join(gitdir, "config");
    if (existsSync(worktreeConfig)) return worktreeConfig;
    const commonConfig = resolve(gitdir, "..", "..", "config");
    return existsSync(commonConfig) ? commonConfig : "";
  } catch {
    return "";
  }
}

/** Extract the `[remote "origin"]` url from a git config text; "" when absent. */
export function originUrlFromConfig(configText: string): string {
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const section = /^\[(.+)\]$/.exec(trimmed);
    if (section !== null) {
      inOrigin = /^remote\s+"origin"$/.test(section[1] ?? "");
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.+)$/.exec(trimmed);
    if (kv !== null) return (kv[1] ?? "").trim();
  }
  return "";
}

/** Normalize a path for prefix comparison (forward slashes, no trailing slash, lowercased drive-insensitively on win32 shapes). */
function normalizeForPrefix(p: string): string {
  const forward = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/** True when `candidate` equals `prefix` or sits beneath it (segment-safe). */
function isPathWithin(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/** How the scope was resolved, in ladder order. */
export type ProjectScopeSource = "env" | "detected-honeycomb-env" | "binding" | "git-signal" | "inbox";

export interface ResolvedProjectScope {
  readonly projectId: string;
  readonly source: ProjectScopeSource;
}

export interface ResolveProjectScopeOptions {
  /** The working directory the scope is resolved for. */
  readonly cwd: string;
  /** Env snapshot (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Cache dir override (tests). Default `~/.deeplake`. */
  readonly cacheDir?: string;
  /** Tenancy guard for the cache (org/workspace the caller authenticated as). */
  readonly expect?: { org: string; workspace: string };
  /** Injectable git-signal reader (tests). Default {@link readGitRemoteSignal}. */
  readonly gitRemoteSignal?: (cwd: string) => string;
}

/**
 * Resolve the project scope for `cwd` per the ladder in the module doc.
 * NEVER throws and NEVER returns an empty id: the terminal fallback is the
 * workspace `__unsorted__` inbox, so callers (recall, registration, the
 * projection CLI) always have a usable, correctly-scoped project id.
 */
export function resolveProjectScope(options: ResolveProjectScopeOptions): ResolvedProjectScope {
  const env = options.env ?? process.env;

  const own = (env[ENV_PROJECT_ID] ?? "").trim();
  if (own !== "") return { projectId: own, source: "env" };

  const detected = (env[DETECTED_HONEYCOMB_PROJECT_ID] ?? "").trim();
  if (detected !== "") return { projectId: detected, source: "detected-honeycomb-env" };

  const cache = loadProjectsCache({ dir: options.cacheDir, expect: options.expect });
  const cwdNorm = normalizeForPrefix(options.cwd);

  let best: FolderBinding | null = null;
  let bestLen = -1;
  for (const b of cache.bindings) {
    const prefix = normalizeForPrefix(b.path);
    if (isPathWithin(cwdNorm, prefix) && prefix.length > bestLen) {
      best = b;
      bestLen = prefix.length;
    }
  }
  if (best !== null && best.projectId.trim() !== "") {
    return { projectId: best.projectId, source: "binding" };
  }

  const readSignal = options.gitRemoteSignal ?? readGitRemoteSignal;
  const signal = readSignal(options.cwd);
  if (signal !== "") {
    const match = cache.projects.find((p) => p.remoteSignal === signal);
    if (match !== undefined && match.projectId.trim() !== "") {
      return { projectId: match.projectId, source: "git-signal" };
    }
  }

  return { projectId: UNSORTED_PROJECT_ID, source: "inbox" };
}