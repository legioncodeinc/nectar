/**
 * A dependency-free `.gitignore` matcher for the walk fallback (PRD-019d).
 *
 * PRD-018c's shared ignore predicate approximates gitignore semantics with a
 * cached `git ls-files` snapshot. When git is genuinely absent (no `.git`, no
 * `git` on PATH), that snapshot is unavailable and the pre-019d predicate read
 * "nothing ignored" for the gitignore layer, so a bound non-git subtree ingested
 * everything but the always-ignored segments. This module fills exactly that
 * gap: a pure gitignore matcher plus a thin disk loader, used ONLY when the git
 * snapshot cannot answer. When git IS available the `ls-files` snapshot stays
 * authoritative (it already reflects `.gitignore`), so the parser is a fallback,
 * never a second opinion that could disagree.
 *
 * Node built-ins only (AGENTS.md: zero runtime dependencies). Supported: `!`
 * negation, trailing-`/` directory-only patterns, leading-`/` (or embedded-`/`)
 * anchoring, `**`, `*`, `?`, and bare basename globs. Nested `.gitignore` files
 * and `.git/info/exclude` are read by the disk loader with correct precedence
 * (deeper files override shallower; `.git/info/exclude` is lowest). Conservative
 * by design: when in doubt the matcher does NOT ignore (fail-open to inclusion is
 * safer for a memory layer than dropping a file the user expected indexed). Known
 * out of scope: `core.excludesfile` global ignores (git-present already covers
 * them) and the "a re-include cannot resurrect a file under an excluded parent"
 * rule (we favor inclusion instead).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Whether a compiled pattern set matched a path, and if so with which polarity. */
export type GitignoreDecision = "ignore" | "include" | "unmatched";

/** One compiled gitignore rule (a single non-comment, non-blank line). */
export interface GitignoreRule {
  /** A `!`-prefixed re-include rule. */
  readonly negate: boolean;
  /** A trailing-`/` directory-only rule (matches a directory and its contents). */
  readonly dirOnly: boolean;
  /** The compiled matcher over a base-relative, forward-slashed path. */
  readonly regex: RegExp;
}

/** Escape a single literal character for use inside a RegExp body. */
function escapeRegexChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Collapse redundant consecutive `**` glob runs before compilation.
 *
 * `**\/**\/` (and longer runs) are semantically a single `**\/`, and `***`+ is
 * treated as `**`. Emitting one RegExp fragment per raw run would produce a
 * chain of overlapping unbounded quantifiers (`(?:.*\/)?(?:.*\/)?...`) whose
 * match cost against a deeply nested path is exponential: a crafted `.gitignore`
 * in an untrusted, non-git bound repo could freeze the single-threaded daemon
 * (the git-absent fallback walks every path through this matcher). Collapsing
 * the runs preserves gitignore semantics and bounds the compiled pattern so no
 * such catastrophic backtracking is possible. The collapse regexes themselves
 * scan the bounded pattern linearly (each unit is fixed-width, no ambiguity).
 */
function collapseGlobStars(pattern: string): string {
  return pattern.replace(/(?:\*\*\/)+/g, "**/").replace(/\*{3,}/g, "**");
}

/**
 * Compile a single gitignore glob body (already stripped of any `!`, leading
 * `/`, and trailing `/`) into a RegExp body, honoring `**`, `*`, `?`. A `*`
 * never crosses a path separator; `**` does.
 */
function globBodyToRegex(rawPattern: string): string {
  const pattern = collapseGlobStars(rawPattern);
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++; // consume the second '*'
        if (pattern[i + 1] === "/") {
          i++; // consume the '/'
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegexChar(c);
    }
  }
  return re;
}

/**
 * Compile one gitignore line into a {@link GitignoreRule}, or null for a blank
 * line or a comment. `patternText` is a single line as written in a `.gitignore`.
 */
export function compileRule(patternText: string): GitignoreRule | null {
  let line = patternText.replace(/\r$/, "");
  // Trailing unescaped whitespace is not significant in gitignore.
  line = line.replace(/(?<!\\)\s+$/, "");
  if (line === "") return null;
  if (line.startsWith("#")) return null;
  // A leading '\' escapes an initial '#' or '!'.
  if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }
  if (line === "") return null;

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  // A separator at the start or middle anchors the pattern to the base dir;
  // otherwise it is a basename glob matched at any depth.
  const hadLeadingSlash = line.startsWith("/");
  if (hadLeadingSlash) line = line.slice(1);
  const anchored = hadLeadingSlash || line.includes("/");
  if (line === "") return null;

  const body = globBodyToRegex(line);
  const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  return { negate, dirOnly, regex: new RegExp(source) };
}

/** Split a `.gitignore` file's text into its non-empty, non-comment compiled rules. */
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    const rule = compileRule(rawLine);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

function normalizeRel(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** True when `rule` matches `subPath` (or an ancestor directory of it, so a matched dir carries its contents). */
function ruleMatches(rule: GitignoreRule, subPath: string, isDir: boolean): boolean {
  // The full path itself: a dir-only rule may only match when the path is a dir.
  if (!rule.dirOnly || isDir) {
    if (rule.regex.test(subPath)) return true;
  }
  // Any ancestor directory prefix (these are directories): a matched directory
  // ignores everything under it, so `dist/` catches `dist/app.js` even though
  // the caller did not flag `dist/app.js` as a directory.
  const parts = subPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    if (rule.regex.test(prefix)) return true;
  }
  return false;
}

/** Evaluate a compiled rule set over a base-relative path (last matching rule wins). */
export function decideRules(rules: readonly GitignoreRule[], subPath: string, isDir: boolean): GitignoreDecision {
  let decision: GitignoreDecision = "unmatched";
  for (const rule of rules) {
    if (ruleMatches(rule, subPath, isDir)) decision = rule.negate ? "include" : "ignore";
  }
  return decision;
}

/**
 * Compile a flat list of gitignore pattern lines (all relative to one base, e.g.
 * the repo root) into a boolean predicate. Pure and disk-free, so the core is
 * unit-testable without a filesystem. `relPath` is base-relative and
 * forward-slashed; `isDir` defaults to false.
 */
export function compileGitignore(patterns: readonly string[]): (relPath: string, isDir?: boolean) => boolean {
  const rules: GitignoreRule[] = [];
  for (const p of patterns) {
    const rule = compileRule(p);
    if (rule !== null) rules.push(rule);
  }
  return (relPath: string, isDir = false): boolean => decideRules(rules, normalizeRel(relPath), isDir) === "ignore";
}

/** The `.git/info/exclude` path relative to a repo root. */
export const GIT_INFO_EXCLUDE = ".git/info/exclude";

/** The per-directory gitignore filename. */
export const GITIGNORE_FILE = ".gitignore";

/** A disk-backed gitignore predicate over a repo-relative, forward-slashed path. */
export type DiskGitignore = (relPath: string, isDir?: boolean) => boolean;

export interface DiskGitignoreOptions {
  /** Read a file by absolute path; return null when it does not exist. Injectable for tests. */
  readonly readFile?: (p: string) => string | null;
}

function ancestorDirs(relPath: string): string[] {
  const parts = relPath.split("/");
  const dirs: string[] = [""];
  for (let i = 0; i < parts.length - 1; i++) {
    dirs.push(parts.slice(0, i + 1).join("/"));
  }
  return dirs; // "", "packages", "packages/a", ...
}

/**
 * Build a disk-backed gitignore matcher for `root` that honors the root
 * `.gitignore`, nested `.gitignore` files, and `.git/info/exclude`. Rules are
 * loaded lazily and cached per directory. Precedence (highest first): the
 * deepest applicable `.gitignore`, then shallower ones, then the root
 * `.gitignore`, then `.git/info/exclude`; the first source with a definitive
 * decision wins (matching git's last-match-wins over the ordered concatenation).
 */
export function createDiskGitignore(root: string, opts: DiskGitignoreOptions = {}): DiskGitignore {
  const readFile = opts.readFile ?? defaultReadFileOrNull;
  /** dir (relative to root, "" for root) -> compiled rules, or null when no `.gitignore` there. */
  const dirRules = new Map<string, readonly GitignoreRule[] | null>();
  let excludeRules: readonly GitignoreRule[] | null | undefined;

  function rulesForDir(dir: string): readonly GitignoreRule[] | null {
    const cached = dirRules.get(dir);
    if (cached !== undefined) return cached;
    const path = dir === "" ? join(root, GITIGNORE_FILE) : join(root, dir, GITIGNORE_FILE);
    const text = safeRead(readFile, path);
    const compiled = text === null ? null : parseGitignore(text);
    dirRules.set(dir, compiled);
    return compiled;
  }

  function rulesForExclude(): readonly GitignoreRule[] | null {
    if (excludeRules === undefined) {
      const text = safeRead(readFile, join(root, GIT_INFO_EXCLUDE));
      excludeRules = text === null ? null : parseGitignore(text);
    }
    return excludeRules;
  }

  return (relPath: string, isDir = false): boolean => {
    const rel = normalizeRel(relPath);
    if (rel === "") return false;
    // Deepest applicable directory first (highest precedence).
    const dirs = ancestorDirs(rel).reverse();
    for (const dir of dirs) {
      const rules = rulesForDir(dir);
      if (rules === null) continue;
      const subPath = dir === "" ? rel : rel.slice(dir.length + 1);
      const decision = decideRules(rules, subPath, isDir);
      if (decision !== "unmatched") return decision === "ignore";
    }
    const exclude = rulesForExclude();
    if (exclude !== null) {
      const decision = decideRules(exclude, rel, isDir);
      if (decision !== "unmatched") return decision === "ignore";
    }
    return false;
  };
}

function safeRead(readFile: (p: string) => string | null, path: string): string | null {
  try {
    return readFile(path);
  } catch {
    return null;
  }
}

function defaultReadFileOrNull(p: string): string | null {
  // Any failure (missing/unreadable) reads as "no such gitignore", never a throw.
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
