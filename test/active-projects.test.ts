/**
 * PRD-019a: active-project resolution + the pathological-root guard + the
 * `/health` slice builder. Pure functions - hermetic, no disk, no env mutation.
 * Runs against the compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  activeProjectsHealth,
  isPathologicalRoot,
  resolveActiveProjects,
} from "../dist/hive-graph/active-projects.js";
import { defaultBroodingState, withGlobalBrooding, withProjectBrooding } from "../dist/registration/brooding-state.js";

const HOME = "/home/op";

function bindings(...pairs: Array<[string, string]>): Array<{ path: string; projectId: string }> {
  return pairs.map(([path, projectId]) => ({ path, projectId }));
}

// ── index AC-1 / a-AC-1: dormant by default ─────────────────────────────────

test("index AC-1 / a-AC-1 zero bindings resolves to zero active projects (dormant)", () => {
  const resolution = resolveActiveProjects({ bindings: [], broodingState: defaultBroodingState(), home: HOME, platform: "linux" });
  assert.equal(resolution.active.length, 0);
  assert.equal(resolution.projects.length, 0);
  const health = activeProjectsHealth(resolution, () => "stopped");
  assert.equal(health.count, 0);
  assert.equal(health.reason, "no-active-projects", "the machine-readable dormancy reason");
});

// ── index AC-2 / a-AC-3: one bound, brooding-on project activates ────────────

test("index AC-2 / a-AC-3 one bound brooding-on project resolves to exactly one active project scoped to its projectId", () => {
  const resolution = resolveActiveProjects({
    bindings: bindings(["/work/repo", "proj-1"]),
    broodingState: defaultBroodingState(),
    home: HOME,
    platform: "linux",
  });
  assert.equal(resolution.active.length, 1);
  assert.equal(resolution.active[0]?.projectId, "proj-1");
  assert.equal(resolution.active[0]?.path, "/work/repo");
  assert.equal(resolution.active[0]?.brooding, "active");
  const health = activeProjectsHealth(resolution, () => "running");
  assert.equal(health.count, 1);
  assert.equal(health.reason, null);
  assert.equal(health.projects[0]?.watcher, "running");
});

// ── index AC-3 / a-AC-4: two bound projects, independent ─────────────────────

test("index AC-3 / a-AC-4 two bound brooding-on projects each resolve independently under their own projectId", () => {
  const resolution = resolveActiveProjects({
    bindings: bindings(["/work/a", "proj-a"], ["/work/b", "proj-b"]),
    broodingState: defaultBroodingState(),
    home: HOME,
    platform: "linux",
  });
  assert.deepEqual(
    resolution.active.map((p) => [p.projectId, p.path]).sort(),
    [["proj-a", "/work/a"], ["proj-b", "/work/b"]].sort(),
  );
});

// ── b-AC / brooding state gates the active set ───────────────────────────────

test("a per-project OFF removes it from the active set but keeps it visible on /health as paused", () => {
  const state = withProjectBrooding(defaultBroodingState(), "proj-off", "off");
  const resolution = resolveActiveProjects({
    bindings: bindings(["/work/on", "proj-on"], ["/work/off", "proj-off"]),
    broodingState: state,
    home: HOME,
    platform: "linux",
  });
  assert.deepEqual(resolution.active.map((p) => p.projectId), ["proj-on"]);
  const off = resolution.projects.find((p) => p.projectId === "proj-off");
  assert.equal(off?.brooding, "paused");
});

test("a global pause makes nothing active; /health reason is global-paused; per-project state reads global-paused", () => {
  const state = withGlobalBrooding(defaultBroodingState(), "paused");
  const resolution = resolveActiveProjects({
    bindings: bindings(["/work/a", "proj-a"]),
    broodingState: state,
    home: HOME,
    platform: "linux",
  });
  assert.equal(resolution.active.length, 0);
  assert.equal(resolution.globalPaused, true);
  const health = activeProjectsHealth(resolution, () => "stopped");
  assert.equal(health.reason, "global-paused");
  assert.equal(health.projects[0]?.brooding, "global-paused");
});

// ── a-AC-6 / pathological-root guard ─────────────────────────────────────────

test("a-AC-6 a binding that resolves to $HOME / a filesystem root / System32 is refused, not activated", () => {
  const resolution = resolveActiveProjects({
    bindings: bindings(["/home/op", "p-home"], ["/", "p-root"], ["C:/Windows/System32", "p-sys"], ["/work/ok", "p-ok"]),
    broodingState: defaultBroodingState(),
    home: HOME,
    platform: "win32",
    env: { WINDIR: "C:\\Windows" },
  });
  assert.deepEqual(resolution.active.map((p) => p.projectId), ["p-ok"], "only the safe binding activates");
  const refusedIds = resolution.refused.map((r) => r.projectId).sort();
  assert.deepEqual(refusedIds, ["p-home", "p-root", "p-sys"].sort());
  assert.ok(resolution.refused.every((r) => r.reason === "pathological-root"));
  const health = activeProjectsHealth(resolution, () => "running");
  assert.equal(health.refused.length, 3);
});

test("isPathologicalRoot: $HOME, POSIX root, Windows drive root, and System32 are guarded; a normal path is not", () => {
  assert.equal(isPathologicalRoot("/home/op", { home: "/home/op", platform: "linux" }), true);
  assert.equal(isPathologicalRoot("/", { platform: "linux" }), true);
  assert.equal(isPathologicalRoot("C:\\", { platform: "win32" }), true);
  assert.equal(isPathologicalRoot("C:\\Windows\\System32", { platform: "win32", env: { WINDIR: "C:\\Windows" } }), true);
  assert.equal(isPathologicalRoot("/work/my-repo", { home: "/home/op", platform: "linux" }), false);
  assert.equal(isPathologicalRoot(join("/home/op", "projects", "x"), { home: "/home/op", platform: "linux" }), false);
});

test("de-duplicates bindings by projectId (first binding wins) and skips blank ids/paths", () => {
  const resolution = resolveActiveProjects({
    bindings: bindings(["/work/a", "dup"], ["/work/a2", "dup"], ["", "blank-path"], ["/work/c", "  "]),
    broodingState: defaultBroodingState(),
    home: HOME,
    platform: "linux",
  });
  assert.deepEqual(resolution.projects.map((p) => p.projectId), ["dup"]);
  assert.equal(resolution.projects[0]?.path, "/work/a", "the first binding for a projectId wins");
});
