import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultIgnore,
  createSharedIgnore,
  loadIgnorePrefixes,
  type GitCheckIgnoreRunner,
  type GitLsFilesProbe,
  type GitLsFilesRunner,
} from "../dist/registration/ignore.js";

const ROOT = "/repo";

test("default ignore skips version-control, dependency, and runtime dirs", () => {
  const isIgnored = createDefaultIgnore(ROOT, () => null); // no graph-ignore file present
  assert.equal(isIgnored(".git/config"), true);
  assert.equal(isIgnored("node_modules/pkg/index.js"), true);
  assert.equal(isIgnored(".honeycomb/nectars.json"), true);
  assert.equal(isIgnored("src/deep/node_modules/x.ts"), true, "an ignored dir anywhere in the path drops it");
  assert.equal(isIgnored("src/a.ts"), false);
});

test("default ignore honors a graph-ignore.json array", () => {
  const readFile = () => JSON.stringify(["dist", "coverage"]);
  const isIgnored = createDefaultIgnore(ROOT, readFile);
  assert.equal(isIgnored("dist/bundle.js"), true);
  assert.equal(isIgnored("coverage/lcov.info"), true);
  assert.equal(isIgnored("distinct/keep.ts"), false, "prefix match is path-segment aware, not substring");
  assert.equal(isIgnored("src/a.ts"), false);
});

test("default ignore honors the { ignore: [...] } object form", () => {
  const isIgnored = createDefaultIgnore(ROOT, () => JSON.stringify({ ignore: ["build"] }));
  assert.equal(isIgnored("build/out.js"), true);
  assert.equal(isIgnored("build"), true);
  assert.equal(isIgnored("src/a.ts"), false);
});

test("a malformed graph-ignore file fails open to the built-in segment rules", () => {
  const isIgnored = createDefaultIgnore(ROOT, () => "{ not json");
  assert.equal(isIgnored("node_modules/x.ts"), true, "built-in rules still apply");
  assert.equal(isIgnored("dist/out.js"), false, "no declared prefixes survive a malformed file");
});

test("loadIgnorePrefixes returns [] for a missing file", () => {
  assert.deepEqual(loadIgnorePrefixes(ROOT, () => null), []);
});

// ── PRD-018c NEC-007 / AC-018c.1, AC-018c.2, AC-018c.3: the shared predicate ──

function fakeGitOk(paths: string[]): GitLsFilesRunner {
  return () => ({ status: "ok", paths });
}

function fakeGitAbsent(): GitLsFilesRunner {
  return () => ({ status: "absent" });
}

function fakeGitError(reason: string): GitLsFilesRunner {
  return () => ({ status: "error", reason });
}

/** A check-ignore fallback driven by an explicit ignored-path set (simulates real `git check-ignore` semantics without spawning). */
function fakeCheckIgnore(ignoredPaths: readonly string[]): GitCheckIgnoreRunner {
  return (_root, relPath) => ignoredPaths.includes(relPath);
}

test("AC-018c.1/2/3 the shared predicate is segments UNION graph-ignore UNION gitignore, all three sources composing on one function", () => {
  const readFile = () => JSON.stringify(["dist"]); // graph-ignore prefix
  const shared = createSharedIgnore(ROOT, {
    readFile,
    gitLsFiles: fakeGitOk(["src/a.ts", "src/b.ts", "README.md"]), // the tracked+untracked-eligible snapshot
    gitCheckIgnore: fakeCheckIgnore([".env", "coverage/lcov.info"]),
  });

  // Segment rule (always-ignored dirs).
  assert.equal(shared.isIgnored("node_modules/pkg/index.js"), true, "segment rule still applies");
  assert.equal(shared.isIgnored(".honeycomb/nectars.json"), true, "the committed projection is never brooded (AC-018c.3)");
  // Graph-ignore prefix rule.
  assert.equal(shared.isIgnored("dist/bundle.js"), true, "graph-ignore prefix still applies");
  // Gitignore semantics: a cache miss against the ls-files snapshot resolves via check-ignore (AC-018c.2).
  assert.equal(shared.isIgnored(".env"), true, "a gitignored file is excluded by the shared predicate");
  assert.equal(shared.isIgnored("coverage/lcov.info"), true, "gitignored, not merely a segment/graph-ignore match");
  // A path present in the ls-files snapshot is definitively NOT gitignored.
  assert.equal(shared.isIgnored("src/a.ts"), false);
  assert.equal(shared.isIgnored("README.md"), false);
});

test("AC-018c.1 parity: discovery (git path), the watch intake, and a resync all exclude the SAME set via one shared predicate reference", () => {
  const shared = createSharedIgnore(ROOT, {
    readFile: () => JSON.stringify(["build"]),
    // A genuinely gitignored ".env" would NEVER appear in `git ls-files
    // --others --exclude-standard` output - it is a cache MISS, resolved via
    // the check-ignore fallback below, not a member of the eligible snapshot.
    gitLsFiles: fakeGitOk(["src/keep.ts", "build/out.js"]),
    gitCheckIgnore: fakeCheckIgnore([".env"]),
  });
  const candidatePaths = ["src/keep.ts", ".env", "build/out.js", "node_modules/x.ts", ".honeycomb/nectars.json"];
  // Three call sites (discovery's git-path filter, the watch intake's per-event
  // filter, the resync's per-path filter) all just call `shared.isIgnored` -
  // there is no second implementation to drift from the first.
  const excludedByDiscovery = candidatePaths.filter(shared.isIgnored);
  const excludedByWatch = candidatePaths.filter(shared.isIgnored);
  const excludedByResync = candidatePaths.filter(shared.isIgnored);
  assert.deepEqual(excludedByDiscovery, excludedByWatch);
  assert.deepEqual(excludedByWatch, excludedByResync);
  assert.deepEqual(excludedByDiscovery.sort(), [".env", ".honeycomb/nectars.json", "build/out.js", "node_modules/x.ts"].sort());
});

test("AC-018c.10 a git snapshot that is genuinely ABSENT degrades silently to segments+graph-ignore (no gitignore semantics, no error surfaced)", () => {
  const errors: string[] = [];
  const shared = createSharedIgnore(ROOT, {
    readFile: () => null,
    gitLsFiles: fakeGitAbsent(),
    onGitError: (reason) => errors.push(reason),
  });
  assert.equal(shared.isGitAvailable(), false);
  assert.equal(shared.lastGitError(), null);
  assert.deepEqual(errors, [], "git-absent is never treated as an error");
  assert.equal(shared.isIgnored("node_modules/x.ts"), true, "segment rule still applies");
  assert.equal(shared.isIgnored("src/a.ts"), false, "no gitignore semantics to exclude an otherwise-normal file");
});

test("NEC-039 a git snapshot that is PRESENT but ERRORS is surfaced loudly, never silently, and a prior good snapshot is kept", () => {
  const errors: string[] = [];
  let ls: GitLsFilesProbe = { status: "ok", paths: ["src/a.ts"] };
  const shared = createSharedIgnore(ROOT, {
    readFile: () => null,
    gitLsFiles: () => ls,
    onGitError: (reason) => errors.push(reason),
  });
  assert.equal(shared.isGitAvailable(), true);
  assert.equal(shared.isIgnored("src/a.ts"), false);

  // Now git starts erroring (e.g. ENOBUFS) on every subsequent refresh.
  ls = { status: "error", reason: "ENOBUFS: ls-files output exceeded maxBuffer" };
  shared.refresh();
  assert.deepEqual(errors, ["ENOBUFS: ls-files output exceeded maxBuffer"], "the failure is surfaced loudly");
  assert.equal(shared.lastGitError(), "ENOBUFS: ls-files output exceeded maxBuffer");
  assert.equal(shared.isGitAvailable(), true, "the prior good snapshot is kept, not silently discarded");
  assert.equal(shared.isIgnored("src/a.ts"), false, "the stale-but-good snapshot still resolves this path");
});

test("NEC-039 a git snapshot that ERRORS with no prior good snapshot degrades to segments+graph-ignore rather than spawning check-ignore for every path", () => {
  let checkIgnoreCalls = 0;
  const shared = createSharedIgnore(ROOT, {
    readFile: () => null,
    gitLsFiles: fakeGitError("git ls-files exited with status 128"),
    gitCheckIgnore: () => {
      checkIgnoreCalls += 1;
      return null;
    },
  });
  assert.equal(shared.isGitAvailable(), false, "no usable snapshot to trust yet");
  assert.equal(shared.lastGitError(), "git ls-files exited with status 128");
  assert.equal(shared.isIgnored("src/a.ts"), false);
  assert.equal(checkIgnoreCalls, 0, "never spawns a per-path check when there is no snapshot to miss against");
});
