import { test } from "node:test";
import assert from "node:assert/strict";
import { installCommands, uninstallCommands, statusCommand } from "../dist/service/argv.js";
import { resolveServicePlan } from "../dist/service/platform.js";

function plan(overrides: Partial<Parameters<typeof resolveServicePlan>[0]> = {}) {
  return resolveServicePlan({
    platform: "linux" as NodeJS.Platform,
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/hivenectar",
    ...overrides,
  });
}

test("launchd install: bootstrap into gui/<uid> then kickstart", () => {
  const p = plan({ platform: "darwin", home: "/Users/op" });
  const cmds = installCommands(p, 501);
  assert.equal(cmds[0]?.command, "launchctl");
  assert.deepEqual(cmds[0]?.args, ["bootstrap", "gui/501", p.unitPath]);
  assert.equal(cmds[1]?.args[0], "kickstart");
  assert.match(cmds[1]?.args[2] ?? "", /gui\/501\/com\.hivenectar\.daemon/);
});

test("launchd uninstall: bootout the gui/<uid> service target", () => {
  const p = plan({ platform: "darwin", home: "/Users/op" });
  const cmds = uninstallCommands(p, 501);
  assert.equal(cmds[0]?.command, "launchctl");
  assert.deepEqual(cmds[0]?.args, ["bootout", "gui/501/com.hivenectar.daemon"]);
});

test("systemd install/uninstall use --user scope by default and the hivenectar unit name", () => {
  const p = plan({ platform: "linux" });
  assert.deepEqual(installCommands(p, 0)[0]?.args, ["--user", "enable", "--now", "hivenectar.service"]);
  assert.deepEqual(uninstallCommands(p, 0)[0]?.args, ["--user", "disable", "--now", "hivenectar.service"]);
  assert.deepEqual(statusCommand(p, 0).args, ["--user", "is-active", "hivenectar.service"]);
});

test("systemd system-scope omits --user", () => {
  const p = plan({ platform: "linux", privileged: true, preferSystemScope: true });
  assert.deepEqual(installCommands(p, 0)[0]?.args, ["enable", "--now", "hivenectar.service"]);
});

test("schtasks install creates from XML then runs it; uninstall deletes; status queries", () => {
  const p = plan({ platform: "win32", home: "C:/Users/op" });
  const install = installCommands(p, 0);
  assert.equal(install[0]?.command, "schtasks");
  assert.deepEqual(install[0]?.args, ["/Create", "/XML", p.unitPath, "/TN", "HivenectarDaemon", "/F"]);
  assert.deepEqual(install[1]?.args, ["/Run", "/TN", "HivenectarDaemon"]);
  assert.deepEqual(uninstallCommands(p, 0)[0]?.args, ["/Delete", "/TN", "HivenectarDaemon", "/F"]);
  assert.deepEqual(statusCommand(p, 0).args, ["/Query", "/TN", "HivenectarDaemon"]);
});

test("sc (Windows system-scope) create + start; stop + delete; query", () => {
  const p = plan({ platform: "win32", home: "C:/Users/op", privileged: true, preferSystemScope: true });
  const install = installCommands(p, 0);
  assert.equal(install[0]?.command, "sc");
  assert.equal(install[0]?.args[0], "create");
  assert.equal(install[0]?.args[1], "HivenectarDaemon");
  assert.deepEqual(uninstallCommands(p, 0).map((c) => c.args[0]), ["stop", "delete"]);
  assert.deepEqual(statusCommand(p, 0).args, ["query", "HivenectarDaemon"]);
});
