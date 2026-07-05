/**
 * W1-N remediation: live-reload of project bindings + credentials WITHOUT a
 * daemon restart. Proves the credentials-live active-project resolver
 * (`LiveActiveProjects`) picks up a `projects.json` binding written AFTER "boot"
 * on a subsequent resolve, and that the whole path stays dormant + fail-soft
 * while credentials are absent.
 *
 * Hermetic: a temp `~/.deeplake` cache dir + a temp brooding-state dir + an
 * injected (mutable) credentials seam. No real home, no network, no fs.watch,
 * no real sleeps - the "next tick" is just a second `resolve()` call. Runs
 * against the compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveActiveProjects } from "../dist/hive-graph/live-active-projects.js";
import { assembleDaemon } from "../dist/index.js";
import type { DeepLakeCredentials } from "../dist/hive-graph/deeplake-credentials.js";
import type { AsyncHiveGraphStore } from "../dist/hive-graph/store.js";
import type { ResolvedProject } from "../dist/hive-graph/active-projects.js";
import type { RunningContext } from "../dist/project-supervisor.js";
import { get } from "node:http";

const CREDS: DeepLakeCredentials = {
  apiUrl: "https://api.deeplake.test",
  token: "tok-abcd",
  orgId: "org-1",
  workspaceId: "ws-1",
};

/** A trivial async store stand-in (the resolver never queries it; the supervisor holds it). */
const fakeStore = {} as unknown as AsyncHiveGraphStore;

/** Write a schema-v1 projects.json binding `path -> projectId` into `dir/projects.json`. */
function writeProjectsCache(dir: string, org: string, workspace: string, bindings: Array<{ path: string; projectId: string }>): void {
  writeFileSync(
    join(dir, "projects.json"),
    JSON.stringify({ schemaVersion: 1, org, workspace, bindings, projects: [] }),
    "utf8",
  );
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("W1-N: a projects.json binding written AFTER boot is picked up on the next resolve (no restart)", () => {
  const cacheDir = tempDir("nectar-live-cache-");
  const stateDir = tempDir("nectar-live-state-");
  const builtFor: string[] = [];
  // Credentials are PRESENT here (the daemon booted after login); the point of
  // this test is that a BINDING added after boot activates without a restart.
  const live = new LiveActiveProjects({
    loadCredentials: () => CREDS,
    createStore: () => fakeStore,
    buildContext: ({ project }): RunningContext => {
      builtFor.push(project.projectId);
      return { projectId: project.projectId, path: project.path, watcherState: () => "running", start: async () => {}, stop: async () => {} };
    },
    controlOptions: { cacheDir, broodingState: { dir: stateDir } },
  });

  try {
    // Boot: no bindings yet -> dormant.
    writeProjectsCache(cacheDir, CREDS.orgId, CREDS.workspaceId, []);
    assert.equal(live.resolve().active.length, 0, "no bindings => nothing active at boot");

    // A project is bound AFTER boot (honeycomb writes projects.json).
    writeProjectsCache(cacheDir, CREDS.orgId, CREDS.workspaceId, [{ path: "/work/repo-a", projectId: "proj-a" }]);

    // The NEXT resolve (the reconcile loop's next tick) sees the new binding.
    const after = live.resolve();
    assert.equal(after.active.length, 1, "the post-boot binding is now active");
    assert.equal(after.active[0].projectId, "proj-a");
    assert.equal(after.active[0].path, "/work/repo-a");

    // The factory builds a context for it against the live credentials.
    const ctx = live.factory(after.active[0]);
    assert.equal(ctx.projectId, "proj-a");
    assert.deepEqual(builtFor, ["proj-a"]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-N: with credentials absent the resolver is dormant and fail-soft (empty resolution, factory is a no-op)", async () => {
  const cacheDir = tempDir("nectar-live-cache-");
  const stateDir = tempDir("nectar-live-state-");
  let present = false;
  let buildContextCalls = 0;
  const live = new LiveActiveProjects({
    loadCredentials: () => (present ? CREDS : undefined),
    createStore: () => fakeStore,
    buildContext: (): RunningContext => {
      buildContextCalls += 1;
      throw new Error("buildContext must not be reached while credentials are absent");
    },
    controlOptions: { cacheDir, broodingState: { dir: stateDir } },
  });

  try {
    // A binding exists on disk, but credentials are ABSENT -> dormant regardless.
    writeProjectsCache(cacheDir, CREDS.orgId, CREDS.workspaceId, [{ path: "/work/repo-a", projectId: "proj-a" }]);
    assert.equal(live.resolve().active.length, 0, "no credentials => dormant even with a binding present");

    // A factory reached without creds (a race) yields a no-op context, never a throw.
    const ctx = live.factory({ projectId: "proj-a", path: "/work/repo-a", brooding: "active" });
    assert.equal(buildContextCalls, 0, "buildContext is skipped without credentials");
    assert.equal(ctx.watcherState(), "stopped");
    await ctx.start(); // must not throw
    await ctx.stop();

    // Credentials appear (login lands): the SAME resolver now activates the binding.
    present = true;
    const after = live.resolve();
    assert.equal(after.active.length, 1, "credentials appearing activates the already-present binding");
    assert.equal(after.active[0].projectId, "proj-a");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-N: a mismatched-tenancy cache reads empty (the expect guard is derived from the live credentials)", () => {
  const cacheDir = tempDir("nectar-live-cache-");
  const stateDir = tempDir("nectar-live-state-");
  const live = new LiveActiveProjects({
    loadCredentials: () => CREDS, // org-1 / ws-1
    createStore: () => fakeStore,
    buildContext: ({ project }): RunningContext => ({
      projectId: project.projectId, path: project.path, watcherState: () => "running", start: async () => {}, stop: async () => {},
    }),
    controlOptions: { cacheDir, broodingState: { dir: stateDir } },
  });
  try {
    // Cache synced for a DIFFERENT tenancy -> the guard drops it (wrong projects).
    writeProjectsCache(cacheDir, "org-OTHER", "ws-OTHER", [{ path: "/work/repo-a", projectId: "proj-a" }]);
    assert.equal(live.resolve().active.length, 0, "a tenancy-mismatched cache reads empty");

    // Re-synced for the live tenancy -> activates (no restart, no reconstruction).
    writeProjectsCache(cacheDir, CREDS.orgId, CREDS.workspaceId, [{ path: "/work/repo-a", projectId: "proj-a" }]);
    assert.equal(live.resolve().active.length, 1, "the correctly-scoped cache activates");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── Integration: the daemon's reconcile loop drives LiveActiveProjects ────────

function fetchHealth(port: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    }).on("error", reject);
  });
}

/** A timer that captures scheduled callbacks without firing them (reconcile is driven explicitly). */
function inertTimer() {
  return { set: (_fn: () => void, _ms: number) => 1, clear: (_h: unknown) => {} };
}

test("W1-N integration: a daemon booted dormant activates a post-boot binding on a driven reconcile tick", async () => {
  const runtimeDir = tempDir("nectar-live-daemon-");
  const cacheDir = tempDir("nectar-live-cache-");
  const stateDir = tempDir("nectar-live-state-");
  const events: string[] = [];
  // Credentials appear AFTER boot (login lands late).
  let present = false;

  const live = new LiveActiveProjects({
    loadCredentials: () => (present ? CREDS : undefined),
    createStore: () => fakeStore,
    buildContext: ({ project }): RunningContext => {
      let state: "stopped" | "running" = "stopped";
      return {
        projectId: project.projectId,
        path: project.path,
        watcherState: () => state,
        start: async () => {
          events.push(`start:${project.projectId}`);
          state = "running";
        },
        stop: async () => {
          events.push(`stop:${project.projectId}`);
          state = "stopped";
        },
      };
    },
    controlOptions: { cacheDir, broodingState: { dir: stateDir } },
  });

  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    activeProjects: {
      resolve: () => live.resolve(),
      factory: (p: ResolvedProject) => live.factory(p),
      timer: inertTimer(),
    },
  });

  try {
    const port = await daemon.start();
    // Dormant at boot: no credentials on disk yet.
    assert.equal((await fetchHealth(port)).body.activeProjects.count, 0);

    // Login lands and honeycomb binds a project (both appear on disk).
    present = true;
    writeProjectsCache(cacheDir, CREDS.orgId, CREDS.workspaceId, [{ path: "/work/repo-a", projectId: "proj-a" }]);

    // The reconcile loop's next tick (driven explicitly) activates the project -
    // no daemon restart.
    await daemon.reconcileActiveProjects();
    assert.deepEqual(events, ["start:proj-a"]);
    const health = await fetchHealth(port);
    assert.equal(health.body.activeProjects.count, 1);
    assert.equal(health.body.activeProjects.projects[0].projectId, "proj-a");
    assert.equal(health.body.activeProjects.projects[0].watcher, "running");
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
