/**
 * PRD-019a: the multi-root ProjectSupervisor + the ActiveProjectsController
 * reconcile driver, exercised with FAKE contexts so the start/stop/drain and
 * reconcile-on-change behavior is deterministic and hermetic (no disk, no
 * network). Runs against the compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSupervisor } from "../dist/project-supervisor.js";
import { ActiveProjectsController } from "../dist/active-projects-runtime.js";
import { createProjectContext } from "../dist/registration/project-context.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { readActiveProjects, persistProjectBrooding } from "../dist/projects-control.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";

type Ev = string;

function fakeContext(events: Ev[], projectId: string, path: string, opts: { failStop?: boolean } = {}) {
  let state: "stopped" | "running" = "stopped";
  return {
    projectId,
    path,
    watcherState: () => (state === "running" ? "running" : "stopped"),
    async start() {
      events.push(`start:${projectId}`);
      state = "running";
    },
    async stop() {
      events.push(`stop:${projectId}`);
      state = "stopped";
      if (opts.failStop === true) throw new Error("boom");
    },
  } as const;
}

test("a-AC-3/a-AC-4 reconcile starts one context per active project", async () => {
  const events: Ev[] = [];
  const sup = new ProjectSupervisor({
    factory: (p) => fakeContext(events, p.projectId, p.path),
  });
  await sup.reconcile([
    { projectId: "a", path: "/a", brooding: "active" },
    { projectId: "b", path: "/b", brooding: "active" },
  ]);
  assert.deepEqual(events.sort(), ["start:a", "start:b"]);
  assert.equal(sup.contexts().length, 2);
  assert.equal(sup.watcherStateFor("a"), "running");
  assert.equal(sup.watcherStateFor("missing"), "stopped");
});

test("a-AC-5 reconcile starts a newly-bound project and stops an unbound one with no restart", async () => {
  const events: Ev[] = [];
  const sup = new ProjectSupervisor({ factory: (p) => fakeContext(events, p.projectId, p.path) });
  await sup.reconcile([{ projectId: "a", path: "/a", brooding: "active" }]);
  events.length = 0;
  // 'a' unbound, 'b' newly bound.
  await sup.reconcile([{ projectId: "b", path: "/b", brooding: "active" }]);
  assert.deepEqual(events.sort(), ["start:b", "stop:a"]);
  assert.deepEqual(sup.contexts().map((c) => c.projectId), ["b"]);
});

test("reconcile restarts a context whose bound path changed", async () => {
  const events: Ev[] = [];
  const sup = new ProjectSupervisor({ factory: (p) => fakeContext(events, p.projectId, p.path) });
  await sup.reconcile([{ projectId: "a", path: "/old", brooding: "active" }]);
  events.length = 0;
  await sup.reconcile([{ projectId: "a", path: "/new", brooding: "active" }]);
  assert.deepEqual(events, ["stop:a", "start:a"], "a path change stops the old and starts the new");
  assert.equal(sup.get("a")?.path, "/new");
});

test("a-AC-7 stopAll stops every running context (drain on teardown); a failing stop is isolated, not thrown", async () => {
  const events: Ev[] = [];
  const errors: Array<[string, string]> = [];
  const sup = new ProjectSupervisor({
    factory: (p) => fakeContext(events, p.projectId, p.path, { failStop: p.projectId === "b" }),
    onError: (scope, id) => errors.push([scope, id]),
  });
  await sup.reconcile([
    { projectId: "a", path: "/a", brooding: "active" },
    { projectId: "b", path: "/b", brooding: "active" },
  ]);
  events.length = 0;
  await sup.stopAll();
  assert.deepEqual(events.sort(), ["stop:a", "stop:b"]);
  assert.equal(sup.contexts().length, 0);
  assert.deepEqual(errors, [["stop", "b"]], "the failing stop routes to onError, never throws out of reconcile");
});

test("reconciles are serialized: two concurrent reconciles never double-start a context", async () => {
  const events: Ev[] = [];
  const sup = new ProjectSupervisor({ factory: (p) => fakeContext(events, p.projectId, p.path) });
  const active = [{ projectId: "a", path: "/a", brooding: "active" as const }];
  await Promise.all([sup.reconcile(active), sup.reconcile(active)]);
  assert.deepEqual(
    events.filter((e) => e === "start:a"),
    ["start:a"],
    "'a' is started exactly once despite two overlapping reconciles",
  );
});

// ── b-AC-4: OFF then ON resumes watch + brood with a cold-catch-up resync ────

test("b-AC-4 a paused project set back to on: the reconcile resumes its watch + brood and a cold-catch-up resync runs (019a start path)", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "nectar-bac4-"));
  const projectRoot = join(tempRoot, "repo");
  const stateDir = join(tempRoot, "state");
  const cacheDir = join(tempRoot, "deeplake");
  try {
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    // One bound project in a hermetic (temp) shared-cache dir.
    writeFileSync(
      join(cacheDir, "projects.json"),
      JSON.stringify({
        schemaVersion: 1,
        org: "o",
        workspace: "w",
        bindings: [{ path: projectRoot, projectId: "p1" }],
        projects: [],
      }),
      "utf8",
    );
    const controlOptions = { cacheDir, broodingState: { dir: stateDir } } as const;

    // A REAL project context (the 019a start path): its start() hydrates,
    // starts the watcher, and requests the cold-catch-up resync, which funnels
    // through the shared-ignore refresh seam counted here.
    let resyncs = 0;
    const sharedIgnore = {
      isIgnored: () => false,
      refresh: () => {
        resyncs += 1;
      },
      isGitAvailable: () => false,
      lastGitError: () => null,
    };
    const emptyFs = { statPath: () => null, existsOnDisk: () => false, isDirectory: () => false, listPaths: () => [] };
    const inner = new InMemoryHiveGraphStore();
    const store: AsyncHiveGraphStore = {
      insertIdentity: async (r) => inner.insertIdentity(r),
      getIdentity: async (n) => inner.getIdentity(n),
      touchIdentity: async (n, d) => inner.touchIdentity(n, d),
      appendVersion: async (r) => inner.appendVersion(r),
      nextSeq: async (n) => inner.nextSeq(n),
      latestVersion: async (n) => inner.latestVersion(n),
      listLatestVersions: async (t) => inner.listLatestVersions(t),
      listLatestDescribedVersions: async (t) => inner.listLatestDescribedVersions(t),
      latestVersionByPath: async (t, p) => inner.latestVersionByPath(t, p),
      latestVersionByHash: async (t, h) => inner.latestVersionByHash(t, h),
      deleteNectar: async (t, n) => inner.deleteNectar(t, n),
    };

    const controller = new ActiveProjectsController({
      resolve: () => readActiveProjects(controlOptions).resolution,
      factory: (project) =>
        createProjectContext({
          project,
          tenancy: { orgId: "o", workspaceId: "w", projectId: project.projectId },
          store,
          registrationFs: emptyFs as any,
          sharedIgnore: sharedIgnore as any,
        } as any),
      setHealth: () => {},
      intervalMs: 60_000,
    });
    try {
      // 1. Bound + brooding-on by default: the first reconcile starts the
      //    context (watch running, one cold-catch-up resync).
      await controller.reconcileNow();
      assert.equal(controller.supervisor.watcherStateFor("p1"), "running");
      assert.equal(resyncs, 1, "the initial start ran its cold-catch-up resync");

      // 2. Pause it (the persisted OFF the toggle API writes): the reconcile
      //    stops its watch + brood.
      persistProjectBrooding("p1", "off", controlOptions);
      await controller.reconcileNow();
      assert.equal(controller.supervisor.watcherStateFor("p1"), "stopped", "OFF stopped the watch");

      // 3. b-AC-4: set it back to ON. The reconcile resumes watch + brood via
      //    the 019a start path, and a FRESH cold-catch-up resync runs.
      persistProjectBrooding("p1", "on", controlOptions);
      await controller.reconcileNow();
      assert.equal(controller.supervisor.watcherStateFor("p1"), "running", "ON resumed the watch");
      assert.equal(resyncs, 2, "the resume ran a fresh cold-catch-up resync");
    } finally {
      await controller.stop();
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── ActiveProjectsController: resolve + reconcile + health publish ───────────

test("ActiveProjectsController.reconcileNow resolves, reconciles, and publishes the /health slice", async () => {
  const events: Ev[] = [];
  const slices: Array<{ count: number; reason: string | null }> = [];
  let active = [{ projectId: "a", path: "/a", brooding: "active" as const }];
  const controller = new ActiveProjectsController({
    resolve: () => ({ projects: active, refused: [], active, globalPaused: false }),
    factory: (p) => fakeContext(events, p.projectId, p.path),
    setHealth: (slice) => slices.push({ count: slice.count, reason: slice.reason }),
    intervalMs: 1000,
  });
  await controller.reconcileNow();
  assert.deepEqual(events, ["start:a"]);
  assert.equal(slices.at(-1)?.count, 1);
  assert.equal(slices.at(-1)?.reason, null);

  // Empty the active set; a reconcile stops the context and health goes dormant.
  active = [];
  await controller.reconcileNow();
  assert.deepEqual(events, ["start:a", "stop:a"]);
  assert.equal(slices.at(-1)?.count, 0);
  assert.equal(slices.at(-1)?.reason, "no-active-projects");
  await controller.stop();
});
