/**
 * PRD-003b b-AC-1: the service module's `start`/`stop` front the OS unit with
 * the right per-manager argv. b-AC-2: `deregisterLegacy` best-effort removes the
 * legacy-labelled unit + its file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceModule } from "../dist/service/index.js";
import { startCommands, stopCommands } from "../dist/service/argv.js";
import { resolveServicePlan } from "../dist/service/platform.js";
import type { CommandResult, CommandRunner } from "../dist/service/command-runner.js";
import type { ServiceFs } from "../dist/service/index.js";
import type { ServiceEnvironment } from "../dist/service/platform.js";

function fakeFs(): ServiceFs & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    mkdirp() {},
    writeFile() {},
    removeFile(path: string) {
      removed.push(path);
    },
  };
}

function okRunner(calls: { command: string; args: readonly string[] }[] = []): CommandRunner {
  return {
    async run(command, args): Promise<CommandResult> {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  };
}

function failingRunner(): CommandRunner {
  return {
    async run(): Promise<CommandResult> {
      return { ok: false, code: 1, stdout: "", stderr: "boom", detail: "boom" };
    },
  };
}

function linuxEnv(overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment {
  return { platform: "linux", home: "/home/op", privileged: false, execPath: "/usr/local/bin/nectar", ...overrides };
}

test("b-AC-1 startCommands/stopCommands build the systemd start/stop argv (no create/delete)", () => {
  const plan = resolveServicePlan(linuxEnv());
  assert.deepEqual(startCommands(plan, 0), [{ command: "systemctl", args: ["--user", "start", "nectar.service"] }]);
  assert.deepEqual(stopCommands(plan, 0), [{ command: "systemctl", args: ["--user", "stop", "nectar.service"] }]);
});

test("b-AC-1 startCommands/stopCommands build the launchd argv", () => {
  const plan = resolveServicePlan(linuxEnv({ platform: "darwin", home: "/Users/op" }));
  assert.deepEqual(startCommands(plan, 501), [{ command: "launchctl", args: ["kickstart", "-k", "gui/501/com.legioncode.nectar"] }]);
  assert.deepEqual(stopCommands(plan, 501), [{ command: "launchctl", args: ["bootout", "gui/501/com.legioncode.nectar"] }]);
});

test("b-AC-1 startCommands/stopCommands build the Windows schtasks argv", () => {
  const plan = resolveServicePlan(linuxEnv({ platform: "win32", home: "C:/Users/op" }));
  assert.deepEqual(startCommands(plan, 0), [{ command: "schtasks", args: ["/Run", "/TN", "nectar"] }]);
  assert.deepEqual(stopCommands(plan, 0), [{ command: "schtasks", args: ["/End", "/TN", "nectar"] }]);
});

test("b-AC-1 service.start runs the manager start argv and reports ok", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({ execPath: "/usr/local/bin/nectar", fs: fakeFs(), runner: okRunner(calls), environment: linuxEnv() });
  const result = await svc.start();
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0]?.args, ["--user", "start", "nectar.service"]);
});

test("b-AC-1 service.start reports ok:false when no unit is registered (the manager start fails)", async () => {
  const svc = createServiceModule({ execPath: "/usr/local/bin/nectar", fs: fakeFs(), runner: failingRunner(), environment: linuxEnv() });
  const result = await svc.start();
  assert.equal(result.ok, false, "a failed manager start is reported so the CLI can fall back to a direct spawn");
  assert.match(result.message, /did not start/);
});

test("b-AC-1 service.stop runs the manager stop argv", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({ execPath: "/usr/local/bin/nectar", fs: fakeFs(), runner: okRunner(calls), environment: linuxEnv() });
  const result = await svc.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0]?.args, ["--user", "stop", "nectar.service"]);
});

test("b-AC-2 deregisterLegacy best-effort removes the legacy systemd unit + file, always ok", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({ execPath: "/usr/local/bin/nectar", fs, runner: okRunner(calls), environment: linuxEnv() });
  const result = await svc.deregisterLegacy();
  assert.equal(result.ok, true, "legacy deregister is best-effort and never fails the uninstall");
  assert.deepEqual(calls[0]?.args, ["--user", "disable", "--now", "hivenectar.service"], "targets the legacy unit name");
  assert.deepEqual(fs.removed, ["/home/op/.config/systemd/user/hivenectar.service"], "removes the legacy unit file");
});

test("b-AC-2 deregisterLegacy stays ok even when the legacy unit is already gone (runner fails)", async () => {
  const svc = createServiceModule({ execPath: "/usr/local/bin/nectar", fs: fakeFs(), runner: failingRunner(), environment: linuxEnv() });
  const result = await svc.deregisterLegacy();
  assert.equal(result.ok, true, "an already-absent legacy unit is not an error");
});
