/**
 * PRD-003b b-AC-1 (start/stop), b-AC-4 / AC-8 (state-dir removal guard), b-AC-6
 * (friendly nothing-to-remove), AC-9 (every flow terminates). The lifecycle
 * verbs are exercised through their injectable seams (no real service manager,
 * signals, or filesystem).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runStartLifecycle,
  runStopLifecycle,
  runUninstallLifecycle,
  removeStateDir,
  type StateDirFs,
} from "../dist/lifecycle.js";
import type { ServiceModule, ServiceResult, ServiceUninstallResult } from "../dist/service/index.js";
import type { DeregisterResult } from "../dist/doctor-registry.js";

function fakeService(
  over: {
    install?: ServiceResult;
    uninstall?: ServiceUninstallResult;
    start?: ServiceResult;
    stop?: ServiceResult;
    deregisterLegacy?: ServiceResult;
  } = {},
  calls: string[] = [],
): ServiceModule {
  return {
    install: async () => {
      calls.push("install");
      return over.install ?? { ok: true, message: "installed" };
    },
    uninstall: async () => {
      calls.push("uninstall");
      return over.uninstall ?? { ok: true, alreadyAbsent: false, message: "removed unit" };
    },
    start: async () => {
      calls.push("start");
      return over.start ?? { ok: true, message: "started via systemd" };
    },
    stop: async () => {
      calls.push("stop");
      return over.stop ?? { ok: true, message: "stopped via systemd" };
    },
    deregisterLegacy: async () => {
      calls.push("deregisterLegacy");
      return over.deregisterLegacy ?? { ok: true, message: "legacy deregistered" };
    },
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const noRegistry: DeregisterResult = { files: [{ registryPath: "/x/registry.json", fileExisted: false, removed: false, error: null }], removedAny: false };
const removedRegistry: DeregisterResult = { files: [{ registryPath: "/x/registry.json", fileExisted: true, removed: true, error: null }], removedAny: true };

// ── start (b-AC-1) ──

test("b-AC-1 start: an already-running daemon is a friendly no-op (exit 0)", async () => {
  const sink = io();
  const code = await runStartLifecycle({
    service: fakeService(),
    isDaemonRunning: () => true,
    readPid: () => 4242,
    spawnDaemon: () => {
      throw new Error("must not spawn when already running");
    },
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.ok(sink.out.some((l) => /already running \(pid 4242\)/.test(l)));
});

test("b-AC-1 start: starts via the OS service when the manager start succeeds", async () => {
  const sink = io();
  let spawned = false;
  const code = await runStartLifecycle({
    service: fakeService(),
    isDaemonRunning: () => false,
    readPid: () => null,
    spawnDaemon: () => {
      spawned = true;
      return 1;
    },
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.equal(spawned, false, "no direct spawn when the OS service started it");
  assert.ok(sink.out.some((l) => /started via systemd/.test(l)));
});

test("b-AC-1 start: falls back to a direct spawn when no OS unit is registered", async () => {
  const sink = io();
  const code = await runStartLifecycle({
    service: fakeService({ start: { ok: false, message: "unit not found" } }),
    isDaemonRunning: () => false,
    readPid: () => null,
    spawnDaemon: () => 9999,
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.ok(sink.out.some((l) => /started directly \(pid 9999\)/.test(l)));
});

test("b-AC-1 / AC-9 start: a clear error when both the service and the direct spawn fail (exit 1)", async () => {
  const sink = io();
  const code = await runStartLifecycle({
    service: fakeService({ start: { ok: false, message: "unit not found" } }),
    isDaemonRunning: () => false,
    readPid: () => null,
    spawnDaemon: () => null,
    io: sink.io,
  });
  assert.equal(code, 1);
  assert.ok(sink.err.some((l) => /could not start/.test(l)));
});

// ── stop (b-AC-1) ──

test("b-AC-1 stop: a not-running daemon is a friendly no-op (exit 0)", async () => {
  const sink = io();
  const code = await runStopLifecycle({
    service: fakeService(),
    isDaemonRunning: () => false,
    readPid: () => null,
    sendSignal: () => {
      throw new Error("must not signal when nothing is running");
    },
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.ok(sink.out.some((l) => /not running; nothing to stop/.test(l)));
});

test("b-AC-1 stop: stops the OS unit AND signals the running pid", async () => {
  const sink = io();
  const signals: Array<{ pid: number; sig: string }> = [];
  const code = await runStopLifecycle({
    service: fakeService(),
    isDaemonRunning: () => true,
    readPid: () => 555,
    sendSignal: (pid, sig) => {
      signals.push({ pid, sig });
      return true;
    },
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.deepEqual(signals, [{ pid: 555, sig: "SIGTERM" }]);
  assert.ok(sink.out.some((l) => /stopped via systemd/.test(l)));
  assert.ok(sink.out.some((l) => /Sent SIGTERM.*555/.test(l)));
});

// ── uninstall (b-AC-2/3/4/6, AC-9) ──

test("b-AC-6 uninstall on a not-installed machine exits 0 with a friendly nothing-to-remove message", async () => {
  const sink = io();
  const code = await runUninstallLifecycle({
    service: fakeService({ uninstall: { ok: false, alreadyAbsent: true, message: "no unit to remove" } }),
    isDaemonRunning: () => false,
    readPid: () => null,
    sendSignal: () => false,
    deregisterFromDoctor: () => noRegistry,
    removeStateDir: () => ({ status: "absent", path: "/x/.apiary/nectar" }),
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.ok(sink.out.some((l) => /nothing to remove/.test(l)));
});

// ── uninstall unit-removal classification (b-AC-2 / AC-9) ──

test("b-AC-2 a failed current-unit removal exits nonzero and names the failure", async () => {
  const sink = io();
  const order: string[] = [];
  const code = await runUninstallLifecycle({
    service: fakeService(
      {
        uninstall: {
          ok: false,
          alreadyAbsent: false,
          message: "Could not remove the nectar launchd unit (launchctl bootout): Operation not permitted.",
        },
      },
      order,
    ),
    isDaemonRunning: () => false,
    readPid: () => null,
    sendSignal: () => false,
    deregisterFromDoctor: () => {
      order.push("deregister");
      return removedRegistry;
    },
    removeStateDir: () => {
      order.push("removeStateDir");
      return { status: "removed", path: "/x/.apiary/nectar" };
    },
    io: sink.io,
  });
  assert.equal(code, 1, "a genuine current-unit removal failure is a hard failure, never swallowed into exit 0");
  assert.ok(
    sink.err.some((l) => /Could not remove the nectar service unit/.test(l) && /Operation not permitted/.test(l)),
    "the failed step is named in plain language with the underlying error",
  );
  assert.ok(sink.err.some((l) => /one or more steps failed/.test(l)), "the final summary names re-run guidance");
  // The remaining best-effort steps still ran despite the hard failure.
  assert.ok(order.includes("deregister"), "the registry delete still ran after a failed unit removal");
  assert.ok(order.includes("removeStateDir"), "the state-dir removal still ran after a failed unit removal");
});

test("b-AC-2 an already-absent unit stays a friendly no-op with exit 0", async () => {
  const sink = io();
  const code = await runUninstallLifecycle({
    service: fakeService({
      uninstall: {
        ok: false,
        alreadyAbsent: true,
        message: "nectar launchd unit was already absent (nothing to remove).",
      },
    }),
    isDaemonRunning: () => false,
    readPid: () => null,
    sendSignal: () => false,
    deregisterFromDoctor: () => removedRegistry,
    removeStateDir: () => ({ status: "removed", path: "/x/.apiary/nectar" }),
    io: sink.io,
  });
  assert.equal(code, 0, "an already-absent unit never turns into a hard failure");
  assert.ok(
    sink.out.some((l) => /already absent/.test(l)),
    "the already-absent unit message is a friendly out-line, not an error",
  );
  assert.equal(sink.err.length, 0, "no error is printed for an already-absent unit");
});

test("b-AC-2/3/4 uninstall runs the three-part contract in order (stop, unit, registry, state dir)", async () => {
  const sink = io();
  const order: string[] = [];
  const service = fakeService({}, order);
  let signalled = false;
  const code = await runUninstallLifecycle({
    service,
    isDaemonRunning: () => true,
    readPid: () => 777,
    sendSignal: () => {
      signalled = true;
      order.push("signal");
      return true;
    },
    deregisterFromDoctor: () => {
      order.push("deregister");
      return removedRegistry;
    },
    removeStateDir: () => {
      order.push("removeStateDir");
      return { status: "removed", path: "/x/.apiary/nectar" };
    },
    io: sink.io,
  });
  assert.equal(code, 0);
  assert.equal(signalled, true);
  // stop (service.stop + signal) precedes unit removal precedes registry precedes state dir.
  const iStop = order.indexOf("stop");
  const iUnit = order.indexOf("uninstall");
  const iReg = order.indexOf("deregister");
  const iDir = order.indexOf("removeStateDir");
  assert.ok(iStop >= 0 && iStop < iUnit, "stop before unit removal");
  assert.ok(iUnit < iReg, "unit removal before registry delete");
  assert.ok(iReg < iDir, "registry delete before state-dir removal");
  assert.ok(sink.out.some((l) => /Deleted nectar's doctor registry entry/.test(l)));
  assert.ok(sink.out.some((l) => /Removed nectar's state dir/.test(l)));
});

test("AC-9 uninstall exits 1 with an actionable error when the state-dir removal fails", async () => {
  const sink = io();
  const code = await runUninstallLifecycle({
    service: fakeService(),
    isDaemonRunning: () => false,
    readPid: () => null,
    sendSignal: () => false,
    deregisterFromDoctor: () => removedRegistry,
    removeStateDir: () => ({ status: "failed", path: "/x/.apiary/nectar", reason: "EACCES" }),
    io: sink.io,
  });
  assert.equal(code, 1);
  assert.ok(sink.err.some((l) => /Could not remove nectar's state dir.*EACCES/.test(l)));
});

// ── removeStateDir guard (b-AC-4 / AC-8) ──

function stubFs(over: Partial<StateDirFs>): StateDirFs {
  return {
    isAbsolute: () => true,
    exists: () => true,
    isSymlink: () => false,
    rm: () => {},
    ...over,
  };
}

test("b-AC-4 removeStateDir removes an absent dir as a clean no-op", () => {
  const result = removeStateDir("/abs/.apiary/nectar", stubFs({ exists: () => false }));
  assert.equal(result.status, "absent");
});

test("b-AC-4 removeStateDir removes a normal absolute dir", () => {
  let removed = "";
  const result = removeStateDir("/abs/.apiary/nectar", stubFs({ rm: (p) => (removed = p) }));
  assert.equal(result.status, "removed");
  assert.equal(removed, "/abs/.apiary/nectar");
});

test("AC-8 removeStateDir refuses a non-absolute path (never a glob-relative delete)", () => {
  const result = removeStateDir("relative/nectar", stubFs({ isAbsolute: () => false }));
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /non-absolute/);
});

test("AC-8 removeStateDir refuses to delete a symlinked state dir (never follows a symlink out of the root)", () => {
  let rmCalled = false;
  const result = removeStateDir("/abs/.apiary/nectar", stubFs({ isSymlink: () => true, rm: () => (rmCalled = true) }));
  assert.equal(result.status, "skipped-symlink");
  assert.equal(rmCalled, false, "a symlinked state dir is never removed (its target is left alone)");
});
