/**
 * PRD-019a: the daemon's multi-root, dormant-by-default active-project wiring,
 * exercised end to end against a bound socket with a FAKE context factory and an
 * injected (manually-driven) reconcile timer. Hermetic: an ephemeral port + a
 * temp runtime dir; no disk under the real home, no network. Runs against the
 * compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { assembleDaemon } from "../dist/index.js";
import type { ActiveProjectResolution, ResolvedProject } from "../dist/hive-graph/active-projects.js";

const silent = () => {};

/** A timer that captures scheduled callbacks without firing them (so reconcile is driven explicitly). */
function inertTimer() {
  return { set: (_fn: () => void, _ms: number) => 1, clear: (_h: unknown) => {} };
}

function fetchHealth(port: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    }).on("error", reject);
  });
}

function tempRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-ap-"));
}

test("index AC-1 / a-AC-1 / a-AC-2 a daemon with zero active projects broods nothing and /health reports activeProjects:0 reason no-active-projects", async () => {
  const runtimeDir = tempRuntimeDir();
  let factoryCalls = 0;
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    activeProjects: {
      resolve: (): ActiveProjectResolution => ({ projects: [], refused: [], active: [], globalPaused: false }),
      factory: () => {
        factoryCalls += 1;
        throw new Error("factory must not be called when there are no active projects");
      },
      timer: inertTimer(),
    },
  });
  try {
    const port = await daemon.start();
    const health = await fetchHealth(port);
    assert.equal(health.body.activeProjects.count, 0);
    assert.equal(health.body.activeProjects.reason, "no-active-projects");
    assert.equal(factoryCalls, 0, "no context is constructed => nothing is brooded/watched (never the cwd)");
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a-AC-5 / index AC-7 reconcileActiveProjects starts a newly-active project and stops it on unbind, updating /health", async () => {
  const runtimeDir = tempRuntimeDir();
  const events: string[] = [];
  let active: ResolvedProject[] = [];
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    activeProjects: {
      resolve: (): ActiveProjectResolution => ({ projects: active, refused: [], active, globalPaused: false }),
      factory: (p: ResolvedProject) => {
        let state: "stopped" | "running" = "stopped";
        return {
          projectId: p.projectId,
          path: p.path,
          watcherState: () => (state === "running" ? "running" : "stopped"),
          start: async () => {
            events.push(`start:${p.projectId}`);
            state = "running";
          },
          stop: async () => {
            events.push(`stop:${p.projectId}`);
            state = "stopped";
          },
        };
      },
      timer: inertTimer(),
    },
  });
  try {
    const port = await daemon.start();
    // Dormant at boot.
    assert.equal((await fetchHealth(port)).body.activeProjects.count, 0);

    // Bind a project, then reconcile (as the 019b toggle API would).
    active = [{ projectId: "proj-1", path: "/work/repo", brooding: "active" }];
    await daemon.reconcileActiveProjects();
    assert.deepEqual(events, ["start:proj-1"]);
    let health = await fetchHealth(port);
    assert.equal(health.body.activeProjects.count, 1);
    assert.equal(health.body.activeProjects.projects[0].projectId, "proj-1");
    assert.equal(health.body.activeProjects.projects[0].watcher, "running");

    // Unbind it; the next reconcile stops the context with no daemon restart.
    active = [];
    await daemon.reconcileActiveProjects();
    assert.deepEqual(events, ["start:proj-1", "stop:proj-1"]);
    health = await fetchHealth(port);
    assert.equal(health.body.activeProjects.count, 0);
    assert.equal(health.body.activeProjects.reason, "no-active-projects");
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a-AC-6 a pathological bound root is surfaced on /health as refused: pathological-root and not started", async () => {
  const runtimeDir = tempRuntimeDir();
  let factoryCalls = 0;
  const resolution: ActiveProjectResolution = {
    projects: [],
    refused: [{ projectId: "p-home", path: "/home/op", reason: "pathological-root" }],
    active: [],
    globalPaused: false,
  };
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: silent,
    activeProjects: {
      resolve: () => resolution,
      factory: () => {
        factoryCalls += 1;
        throw new Error("a pathological root must never be activated");
      },
      timer: inertTimer(),
    },
  });
  try {
    const port = await daemon.start();
    const health = await fetchHealth(port);
    assert.equal(health.body.activeProjects.count, 0);
    assert.equal(health.body.activeProjects.refused.length, 1);
    assert.equal(health.body.activeProjects.refused[0].reason, "pathological-root");
    assert.equal(factoryCalls, 0);
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a legacy single-root daemon (no activeProjects option) is unaffected: /health still carries the default activeProjects slice", async () => {
  const runtimeDir = tempRuntimeDir();
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: silent });
  try {
    const port = await daemon.start();
    const health = await fetchHealth(port);
    assert.equal(health.body.activeProjects.count, 0);
    assert.equal(health.body.activeProjects.reason, "no-active-projects");
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
