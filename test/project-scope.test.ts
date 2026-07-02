/**
 * Per-project scope resolution (hive-graph/project-scope.ts): the ADR-0002
 * decoupling ladder. nectar's own env is primary, honeycomb's env is DETECTED
 * (never required), the shared ~/.deeplake/projects.json binding + git-remote
 * signal follow, and the workspace __unsorted__ inbox is the never-fails floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeRemote,
  emptyProjectsCache,
  loadProjectsCache,
  originUrlFromConfig,
  resolveProjectScope,
  UNSORTED_PROJECT_ID,
} from "../dist/hive-graph/project-scope.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nectar-scope-"));
}

function writeCache(dir: string, cache: unknown): void {
  writeFileSync(join(dir, "projects.json"), JSON.stringify(cache), "utf8");
}

const CACHE = {
  schemaVersion: 1,
  org: "org1",
  workspace: "ws1",
  bindings: [
    { path: "C:/work/monorepo", projectId: "proj-mono" },
    { path: "C:/work/monorepo/packages/deep", projectId: "proj-deep" },
  ],
  projects: [
    { projectId: "proj-git", name: "git-proj", remoteSignal: "github.com/org/x", boundPaths: [] },
  ],
};

test("scope ladder 1: NECTAR_PROJECT_ID (nectar's own env) wins over everything", () => {
  const dir = tmp();
  try {
    writeCache(dir, CACHE);
    const scope = resolveProjectScope({
      cwd: "C:/work/monorepo/packages/deep",
      env: { NECTAR_PROJECT_ID: "explicit", HONEYCOMB_PROJECT_ID: "detected" },
      cacheDir: dir,
      gitRemoteSignal: () => "github.com/org/x",
    });
    assert.deepEqual(scope, { projectId: "explicit", source: "env" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope ladder 2: HONEYCOMB_PROJECT_ID is DETECTED when nectar's own env is absent, never required", () => {
  const dir = tmp();
  try {
    writeCache(dir, CACHE);
    const detected = resolveProjectScope({
      cwd: "C:/elsewhere",
      env: { HONEYCOMB_PROJECT_ID: "hc-pin" },
      cacheDir: dir,
      gitRemoteSignal: () => "",
    });
    assert.deepEqual(detected, { projectId: "hc-pin", source: "detected-honeycomb-env" });

    // Absent honeycomb env: resolution proceeds down the ladder, no dependency.
    const without = resolveProjectScope({
      cwd: "C:/elsewhere",
      env: {},
      cacheDir: dir,
      gitRemoteSignal: () => "",
    });
    assert.equal(without.projectId, UNSORTED_PROJECT_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope ladder 3: longest-prefix folder binding (a child binding wins over a parent)", () => {
  const dir = tmp();
  try {
    writeCache(dir, CACHE);
    const deep = resolveProjectScope({
      cwd: "C:/work/monorepo/packages/deep/src",
      env: {},
      cacheDir: dir,
      gitRemoteSignal: () => "",
    });
    assert.deepEqual(deep, { projectId: "proj-deep", source: "binding" });

    const shallow = resolveProjectScope({
      cwd: "C:/work/monorepo/other",
      env: {},
      cacheDir: dir,
      gitRemoteSignal: () => "",
    });
    assert.deepEqual(shallow, { projectId: "proj-mono", source: "binding" });

    // A sibling that only shares a string prefix (not a path segment) does NOT match.
    const sibling = resolveProjectScope({
      cwd: "C:/work/monorepo-other",
      env: {},
      cacheDir: dir,
      gitRemoteSignal: () => "",
    });
    assert.equal(sibling.source, "inbox");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope ladder 4: the canonicalized git-remote signal matches a cached registry project", () => {
  const dir = tmp();
  try {
    writeCache(dir, CACHE);
    const scope = resolveProjectScope({
      cwd: "C:/elsewhere/clone",
      env: {},
      cacheDir: dir,
      gitRemoteSignal: () => "github.com/org/x",
    });
    assert.deepEqual(scope, { projectId: "proj-git", source: "git-signal" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope ladder 5: the __unsorted__ inbox is the never-fails floor", () => {
  const dir = tmp();
  try {
    // No cache file at all.
    const scope = resolveProjectScope({ cwd: "C:/nowhere", env: {}, cacheDir: dir, gitRemoteSignal: () => "" });
    assert.deepEqual(scope, { projectId: UNSORTED_PROJECT_ID, source: "inbox" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache guard: a malformed or wrong-schema projects.json fails soft to empty (inbox), never throws", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "projects.json"), "not json {", "utf8");
    assert.deepEqual(loadProjectsCache({ dir }), emptyProjectsCache());

    writeCache(dir, { ...CACHE, schemaVersion: 99 });
    assert.deepEqual(loadProjectsCache({ dir }), emptyProjectsCache());

    writeCache(dir, { ...CACHE, bindings: [{ path: 5, projectId: "x" }] });
    assert.deepEqual(loadProjectsCache({ dir }), emptyProjectsCache());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache guard: a cache synced for a different org/workspace is ignored (tenancy guard)", () => {
  const dir = tmp();
  try {
    writeCache(dir, CACHE);
    const scope = resolveProjectScope({
      cwd: "C:/work/monorepo",
      env: {},
      cacheDir: dir,
      expect: { org: "other-org", workspace: "ws1" },
      gitRemoteSignal: () => "",
    });
    assert.equal(scope.source, "inbox", "a mismatched-tenancy cache must not supply bindings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalizeRemote folds every remote form of the same repo to one identity", () => {
  const expected = "github.com/org/x";
  for (const raw of [
    "git@github.com:org/x.git",
    "https://github.com/org/x",
    "https://github.com/org/x.git",
    "ssh://git@github.com/org/x.git",
    "https://user@GitHub.com:443/Org/X/",
  ]) {
    assert.equal(canonicalizeRemote(raw), expected, raw);
  }
  assert.equal(canonicalizeRemote(""), "");
  assert.equal(canonicalizeRemote("just-a-word"), "");
});

test("originUrlFromConfig extracts the origin url from a real-shaped .git/config", () => {
  const config = [
    "[core]",
    "\trepositoryformatversion = 0",
    '[remote "upstream"]',
    "\turl = https://github.com/other/y.git",
    '[remote "origin"]',
    "\turl = git@github.com:org/x.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  ].join("\n");
  assert.equal(originUrlFromConfig(config), "git@github.com:org/x.git");
  assert.equal(originUrlFromConfig("[core]\n\tbare = false\n"), "");
});

test("end to end: a .git directory on disk yields the canonical signal through resolveProjectScope", () => {
  const dir = tmp();
  const repo = join(dir, "repo");
  try {
    writeCache(dir, CACHE);
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/org/x.git\n', "utf8");
    const scope = resolveProjectScope({ cwd: repo, env: {}, cacheDir: dir });
    assert.deepEqual(scope, { projectId: "proj-git", source: "git-signal" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
