/**
 * PRD-019d: the dependency-free `.gitignore` parser + its wiring into the shared
 * ignore predicate and the CLI/walk discovery path. Runs against the compiled
 * `dist/` output. Hermetic: the pure-core tests touch no disk; the disk tests
 * use temp dirs under `os.tmpdir()` (never the real user home) and clean up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGitignore, createDiskGitignore } from "../dist/registration/gitignore.js";
import {
  createSharedIgnore,
  type GitLsFilesRunner,
  type DiskGitignore,
} from "../dist/registration/ignore.js";
import { createDiskRegistrationFs } from "../dist/registration/disk-fs.js";
import { discoverFiles } from "../dist/brooding/discovery.js";

// ── d-AC-1 / d-AC-3: the pure core ──────────────────────────────────────────

test("d-AC-1 compileGitignore: a dir-only pattern and a basename glob exclude the right paths; a normal file is included", () => {
  const match = compileGitignore(["dist/", "*.log"]);
  assert.equal(match("dist/bundle.js"), true, "under dist/ is excluded");
  assert.equal(match("dist", true), true, "the dist directory itself is excluded");
  assert.equal(match("app.log"), true, "*.log is excluded at the root");
  assert.equal(match("logs/app.log"), true, "*.log is a basename glob matched at any depth");
  assert.equal(match("src/x.ts"), false, "a normal source file is included");
});

test("d-AC-3 compileGitignore: a negation re-includes a file an earlier pattern excluded", () => {
  const match = compileGitignore(["*.log", "!keep.log"]);
  assert.equal(match("keep.log"), false, "keep.log is re-included by the negation");
  assert.equal(match("other.log"), true, "other *.log files stay excluded");
});

// ── Security remediation regression: the collapseGlobStars code path ─────────
// The 2026-07-04 security pass rewrote how `**` runs compile (collapsing
// consecutive `**/` units and `***`+ before compilation) to remove a ReDoS.
// These tests pin (a) that `**` semantics survived the rewrite and (b) that a
// pathological consecutive-globstar pattern stays bounded.

test("security-regression collapseGlobStars: ** semantics preserved (leading **/, trailing /**, interior a/**/b, consecutive **/**/ collapse)", () => {
  // Leading `**/`: matches at any depth, including the root.
  const leading = compileGitignore(["**/dist"]);
  assert.equal(leading("dist", true), true);
  assert.equal(leading("a/dist", true), true);
  assert.equal(leading("a/b/dist", true), true);
  assert.equal(leading("a/distX", true), false);

  // Trailing `/**`: everything inside the directory.
  const trailing = compileGitignore(["a/**"]);
  assert.equal(trailing("a/b"), true);
  assert.equal(trailing("a/b/c/d"), true);
  assert.equal(trailing("b/x"), false);

  // Interior `a/**/b`: zero or more intermediate segments.
  const interior = compileGitignore(["a/**/b"]);
  assert.equal(interior("a/b"), true, "** matches zero segments");
  assert.equal(interior("a/x/b"), true);
  assert.equal(interior("a/x/y/z/b"), true);
  assert.equal(interior("a/x/bb"), false);

  // Consecutive `**/**/` collapses to one `**/` with identical semantics.
  const consecutive = compileGitignore(["**/**/x"]);
  assert.equal(consecutive("x"), true);
  assert.equal(consecutive("a/x"), true);
  assert.equal(consecutive("a/b/c/x"), true);
  assert.equal(consecutive("a/xy"), false);

  // `***`+ is treated as `**`.
  const tripleStar = compileGitignore(["a/***"]);
  assert.equal(tripleStar("a/b/c"), true);
  assert.equal(tripleStar("b/c"), false);
});

test("security-regression collapseGlobStars: a pathological consecutive-globstar pattern (20 groups) compiles and matches in bounded time", () => {
  // The shape the security report cited: a long `**/**/**/...` chain, which
  // pre-fix compiled to a chain of overlapping unbounded quantifiers with
  // exponential backtracking against a deep NON-matching path.
  const pathological = `${"**/".repeat(20)}*.x`;
  const deepNonMatch = `${Array.from({ length: 40 }, (_, i) => `seg${i}`).join("/")}/leaf.txt`;
  const deepMatch = `${Array.from({ length: 40 }, (_, i) => `seg${i}`).join("/")}/leaf.x`;

  const startedAt = Date.now();
  const match = compileGitignore([pathological]);
  assert.equal(match(deepNonMatch), false, "the non-matching deep path is rejected");
  assert.equal(match(deepMatch), true, "the matching deep path is accepted");
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 250, `compile + both matches must stay bounded; took ${elapsedMs}ms (ceiling 250ms)`);
});

test("compileGitignore: anchored (leading-slash / embedded-slash) patterns bind to the root", () => {
  const match = compileGitignore(["/build", "a/b"]);
  assert.equal(match("build/x"), true, "top-level build is anchored");
  assert.equal(match("pkg/build/x"), false, "a nested build is NOT matched by the anchored /build");
  assert.equal(match("a/b"), true, "an embedded slash anchors the pattern");
  assert.equal(match("z/a/b"), false, "the anchored a/b does not match at a deeper level");
});

// ── d-AC-2: nested .gitignore via the disk loader (injected readFile) ────────

test("d-AC-2 createDiskGitignore honors a nested .gitignore relative to its own directory", () => {
  const files = new Map<string, string>([[join("/repo", "packages/a", ".gitignore"), "build/\n"]]);
  const match = createDiskGitignore("/repo", { readFile: (p) => files.get(p) ?? null });
  assert.equal(match("packages/a/build/out.js"), true, "packages/a/build is excluded by its own .gitignore");
  assert.equal(match("packages/b/build/out.js"), false, "packages/b has no such rule, so it is included");
});

test("createDiskGitignore: a deeper .gitignore negation overrides a shallower ignore", () => {
  const files = new Map<string, string>([
    [join("/repo", ".gitignore"), "*.log\n"],
    [join("/repo", "keep", ".gitignore"), "!*.log\n"],
  ]);
  const match = createDiskGitignore("/repo", { readFile: (p) => files.get(p) ?? null });
  assert.equal(match("a.log"), true, "root *.log excludes a.log");
  assert.equal(match("keep/a.log"), false, "the deeper !*.log re-includes keep/a.log");
});

test("createDiskGitignore reads .git/info/exclude at the lowest precedence", () => {
  const files = new Map<string, string>([[join("/repo", ".git/info/exclude"), "secret.txt\n"]]);
  const match = createDiskGitignore("/repo", { readFile: (p) => files.get(p) ?? null });
  assert.equal(match("secret.txt"), true, "a .git/info/exclude entry is honored");
  assert.equal(match("public.txt"), false);
});

// ── d-AC-4 / d-AC-5: the git-present cases (parser is NOT consulted) ─────────

function gitOk(paths: string[]): GitLsFilesRunner {
  return () => ({ status: "ok", paths });
}
function gitAbsent(): GitLsFilesRunner {
  return () => ({ status: "absent" });
}
function gitError(reason: string): GitLsFilesRunner {
  return () => ({ status: "error", reason });
}

test("d-AC-4 when git IS available the ls-files snapshot stays authoritative; the gitignore parser is never consulted", () => {
  let fallbackCalls = 0;
  const fallback: DiskGitignore = () => {
    fallbackCalls += 1;
    return true;
  };
  const shared = createSharedIgnore("/repo", {
    readFile: () => null,
    gitLsFiles: gitOk(["src/a.ts"]),
    gitignoreFallback: fallback,
  });
  assert.equal(shared.isIgnored("src/a.ts"), false, "a tracked file is not ignored");
  assert.equal(fallbackCalls, 0, "the parser fallback is never consulted while git is present");
});

test("d-AC-5 git PRESENT but ERRORING keeps the degradation loud and does NOT silently mask it with the parser", () => {
  const errors: string[] = [];
  let fallbackCalls = 0;
  const fallback: DiskGitignore = () => {
    fallbackCalls += 1;
    return true;
  };
  const shared = createSharedIgnore("/repo", {
    readFile: () => null,
    gitLsFiles: gitError("git ls-files exited with status 128"),
    gitignoreFallback: fallback,
    onGitError: (reason) => errors.push(reason),
  });
  assert.equal(shared.isIgnored("whatever.ts"), false, "no snapshot + errored => not masked by the parser");
  assert.equal(fallbackCalls, 0, "the parser is NOT consulted in the errored case");
  assert.deepEqual(errors, ["git ls-files exited with status 128"], "the degradation is surfaced loudly");
});

test("git GENUINELY ABSENT consults the gitignore parser fallback so a non-git subtree is not gitignore-blind", () => {
  let fallbackCalls = 0;
  const fallback: DiskGitignore = (rel) => {
    fallbackCalls += 1;
    return rel === "dist/x.js";
  };
  const shared = createSharedIgnore("/repo", {
    readFile: () => null,
    gitLsFiles: gitAbsent(),
    gitignoreFallback: fallback,
  });
  assert.equal(shared.isIgnored("dist/x.js"), true, "the parser verdict is honored when git is absent");
  assert.equal(shared.isIgnored("src/a.ts"), false);
  assert.ok(fallbackCalls >= 1, "the parser fallback is consulted when git is genuinely absent");
});

// ── d-AC-6: the walk fallback honors .gitignore on a real non-git root ───────

test("d-AC-6 a non-git root: discoverFiles' walk fallback excludes dist/ and *.log via the shared predicate, keeps src/x.ts", () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-gitignore-"));
  try {
    writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n", "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n", "utf8");
    writeFileSync(join(root, "dist", "bundle.js"), "1;\n", "utf8");
    writeFileSync(join(root, "app.log"), "log\n", "utf8");

    const isIgnored = createSharedIgnore(root).isIgnored;
    const fs = createDiskRegistrationFs(root, isIgnored);
    // Force the walk fallback (git absent for this temp dir) explicitly.
    const result = discoverFiles({ root, fs, isIgnored, gitLsFiles: () => ({ available: false, reason: "absent" }) });
    const paths = result.files.map((f) => f.relPath).sort();
    // `.gitignore` itself is not ignored (git tracks it); dist/ and *.log are excluded.
    assert.deepEqual(paths, [".gitignore", "src/x.ts"], "dist/ and *.log are excluded; src/x.ts (and .gitignore) survive");
    assert.ok(!paths.includes("dist/bundle.js"), "dist/ is excluded");
    assert.ok(!paths.includes("app.log"), "*.log is excluded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── d-AC-7: createDiskRegistrationFs default drops the always-ignored segments ─

test("d-AC-7 createDiskRegistrationFs with NO predicate still drops .git / node_modules / .honeycomb (default is createDefaultIgnore, not () => false)", () => {
  const ROOT = join("/repo");
  const tree = new Map([
    [ROOT, [dirent("src", "dir"), dirent("node_modules", "dir"), dirent(".git", "dir"), dirent("README.md", "file")]],
    [join(ROOT, "src"), [dirent("a.ts", "file")]],
    [join(ROOT, "node_modules"), [dirent("pkg", "dir")]],
    [join(ROOT, ".git"), [dirent("config", "file")]],
  ]);
  const fs = createDiskRegistrationFs(ROOT, undefined, (dir) => tree.get(dir) ?? []);
  const files = [...fs.listPaths()].sort();
  assert.deepEqual(files, ["README.md", "src/a.ts"], "node_modules and .git are dropped by the default predicate");
});

function dirent(name: string, kind: "file" | "dir"): import("node:fs").Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  } as import("node:fs").Dirent;
}
