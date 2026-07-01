import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceModule, serviceStatus } from "../dist/service/index.js";
import type { CommandResult, CommandRunner } from "../dist/service/command-runner.js";
import type { ServiceFs } from "../dist/service/index.js";
import type { ServiceEnvironment } from "../dist/service/platform.js";

function fakeFs(): ServiceFs & { written: Map<string, string>; removed: string[] } {
  const written = new Map<string, string>();
  const removed: string[] = [];
  return {
    written,
    removed,
    mkdirp() {},
    writeFile(path: string, content: string) {
      written.set(path, content);
    },
    removeFile(path: string) {
      removed.push(path);
    },
  };
}

function okRunner(recordedCalls: { command: string; args: readonly string[] }[] = []): CommandRunner {
  return {
    async run(command, args): Promise<CommandResult> {
      recordedCalls.push({ command, args });
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  };
}

function failingRunner(overrides: Partial<CommandResult> = {}): CommandRunner {
  return {
    async run(): Promise<CommandResult> {
      return { ok: false, code: 1, stdout: "", stderr: "boom", detail: "boom", ...overrides };
    },
  };
}

function linuxEnv(overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment {
  return {
    platform: "linux",
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/hivenectar",
    ...overrides,
  };
}

test("install writes the unit file then runs the manager's install argv", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner = okRunner(calls);
  const svc = createServiceModule({ execPath: "/usr/local/bin/hivenectar", fs, runner, environment: linuxEnv() });

  const result = await svc.install();
  assert.equal(result.ok, true);
  assert.match(result.message, /registered as a systemd service/);

  const unitPath = "/home/op/.config/systemd/user/hivenectar.service";
  assert.ok(fs.written.has(unitPath));
  assert.match(fs.written.get(unitPath) ?? "", /ExecStart=/);
  assert.equal(calls[0]?.command, "systemctl");
});

test("install reports ok:false when a manager command fails, but the unit file is still written", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    runner: failingRunner(),
    environment: linuxEnv(),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /service-manager command failed \(systemctl\): boom/, "the real failure detail is surfaced, not just the command name");
  assert.equal(fs.written.size, 1, "the unit file was still written before the argv ran");
});

test("install surfaces the real service-manager stderr (e.g. Windows schtasks 'Access is denied') when no runner detail is present", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    // No `detail` field at all (as a real execFile non-zero-exit failure looks: ok:false, a
    // real exit code, and only stderr text) - describeFailure must fall back to stderr.
    runner: failingRunner({ detail: undefined, stderr: "ERROR: Access is denied.\r\n" }),
    environment: linuxEnv(),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /ERROR: Access is denied\./);
});

test("a failure detail longer than the cap is truncated with an ellipsis, never silently dropped", async () => {
  const fs = fakeFs();
  const longLine = "x".repeat(500);
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    runner: failingRunner({ detail: undefined, stderr: longLine }),
    environment: linuxEnv(),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /x{200}\.\.\./);
  assert.ok(!result.message.includes(longLine), "the full 500-char line is not echoed verbatim");
});

test("install on an unsupported platform returns ok:false, never throws", async () => {
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs: fakeFs(),
    runner: okRunner(),
    environment: linuxEnv({ platform: "aix" as NodeJS.Platform }),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /unsupported platform/);
});

test("uninstall runs the manager's uninstall argv then deletes the unit file", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv(),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.command, "systemctl");
  assert.deepEqual(fs.removed, ["/home/op/.config/systemd/user/hivenectar.service"]);
});

test("uninstall tolerates a manager command failure (already-gone unit) and still removes the file", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    runner: failingRunner(),
    environment: linuxEnv(),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, false);
  assert.match(result.message, /boom/, "the real failure detail is surfaced");
  assert.equal(fs.removed.length, 1, "the unit file is removed even when the deregister command failed");
});

test("install on darwin writes the launchd plist to ~/Library/LaunchAgents and bootstraps + kickstarts", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "darwin", home: "/Users/op" }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  assert.match(result.message, /registered as a launchd service/);

  const unitPath = "/Users/op/Library/LaunchAgents/com.hivenectar.daemon.plist";
  assert.ok(fs.written.has(unitPath));
  assert.match(fs.written.get(unitPath) ?? "", /<key>KeepAlive<\/key>/);
  assert.equal(calls[0]?.command, "launchctl");
  assert.equal(calls[0]?.args[0], "bootstrap");
  assert.equal(calls[1]?.args[0], "kickstart");
});

test("uninstall on darwin bootouts the launchd target and removes the plist", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "/usr/local/bin/hivenectar",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "darwin", home: "/Users/op" }),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.args[0], "bootout");
  assert.deepEqual(fs.removed, ["/Users/op/Library/LaunchAgents/com.hivenectar.daemon.plist"]);
});

test("install on win32 stages the schtasks XML beside the workspace, then Creates and Runs it", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "C:/Program Files/hivenectar/hivenectar.js",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  assert.match(result.message, /registered as a schtasks service/);

  const stagedXml = "C:/Users/op/.honeycomb/hivenectar/hivenectar-task.xml";
  assert.ok(fs.written.has(stagedXml), "the schtasks XML is staged beside the workspace (unitPath is empty for schtasks)");
  assert.match(fs.written.get(stagedXml) ?? "", /<Task /);
  assert.equal(calls[0]?.command, "schtasks");
  assert.deepEqual(calls[0]?.args, ["/Create", "/XML", stagedXml, "/TN", "HivenectarDaemon", "/F"]);
  assert.deepEqual(calls[1]?.args, ["/Run", "/TN", "HivenectarDaemon"]);
});

test("uninstall on win32 deletes the task and removes the staged XML", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "C:/Program Files/hivenectar/hivenectar.js",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0]?.args, ["/Delete", "/TN", "HivenectarDaemon", "/F"]);
  assert.deepEqual(fs.removed, ["C:/Users/op/.honeycomb/hivenectar/hivenectar-task.xml"]);
});

test("serviceStatus classifies systemd is-active output and never throws on an unsupported platform", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner: CommandRunner = {
    async run(command, args): Promise<CommandResult> {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: "active\n", stderr: "" };
    },
  };
  const running = await serviceStatus({ execPath: "/usr/local/bin/hivenectar", runner, environment: linuxEnv() });
  assert.equal(running, "running");
  assert.equal(calls[0]?.command, "systemctl");

  const unknown = await serviceStatus({
    execPath: "/usr/local/bin/hivenectar",
    runner,
    environment: linuxEnv({ platform: "aix" as NodeJS.Platform }),
  });
  assert.equal(unknown, "unknown");
});
