/**
 * PRD-019b: the `nectar projects` / `nectar brooding` CLI grammar + rendering.
 * The parser is a pure function (hermetic); the write side is a thin loopback
 * client of the same POST endpoint the dashboard uses, so the parse coverage
 * plus the projects-api coverage prove b-AC-7 (CLI == API effect). Imports the
 * compiled modules from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBroodingArgs, renderProjectsTable } from "../dist/cli.js";
import type { ProjectsView } from "../dist/projects-control.js";

test("b-AC-7 parseBroodingArgs: `on/off --project <id>` targets one project", () => {
  assert.deepEqual(parseBroodingArgs(["off", "--project", "p1"]), { kind: "project", projectId: "p1", brooding: "off" });
  assert.deepEqual(parseBroodingArgs(["on", "--project=p2"]), { kind: "project", projectId: "p2", brooding: "on" });
});

test("parseBroodingArgs: `on/off --all` targets every bound project", () => {
  assert.deepEqual(parseBroodingArgs(["on", "--all"]), { kind: "all", brooding: "on" });
});

test("parseBroodingArgs: the global flags flip the global switch and take no on|off argument", () => {
  assert.deepEqual(parseBroodingArgs(["--global-pause"]), { kind: "global", global: "paused" });
  assert.deepEqual(parseBroodingArgs(["--global-resume"]), { kind: "global", global: "on" });
});

test("parseBroodingArgs: malformed invocations are reported as errors, never a silent default", () => {
  assert.equal(parseBroodingArgs(["on"]).kind, "errors", "missing --project/--all is an error");
  assert.equal(parseBroodingArgs(["maybe", "--all"]).kind, "errors", "a non on|off positional is an error");
  assert.equal(parseBroodingArgs(["on", "--project", "p", "--all"]).kind, "errors", "project + all is an error");
  assert.equal(parseBroodingArgs(["on", "--global-pause"]).kind, "errors", "global flag + on|off is an error");
  assert.equal(parseBroodingArgs(["--global-pause", "--global-resume"]).kind, "errors", "two global flags is an error");
  assert.equal(parseBroodingArgs(["off", "--nope"]).kind, "errors", "an unknown flag is an error");
});

test("renderProjectsTable renders the global switch and each project's brooding + watcher state", () => {
  const view: ProjectsView = {
    globalBrooding: "on",
    projects: [
      { projectId: "p1", name: "Repo One", path: "/work/one", brooding: "active", watcher: "running", counts: null },
      { projectId: "p2", name: "", path: "/work/two", brooding: "paused", watcher: "stopped", counts: null },
    ],
  };
  const out = renderProjectsTable(view);
  assert.match(out, /global brooding: on/);
  assert.match(out, /Repo One \(p1\)/);
  assert.match(out, /brooding: active {3}watcher: running/);
  assert.match(out, /brooding: paused {3}watcher: stopped/);
});

test("renderProjectsTable shows the empty-state guidance when there are no active projects", () => {
  const out = renderProjectsTable({ globalBrooding: "on", projects: [] });
  assert.match(out, /No active projects/);
});
