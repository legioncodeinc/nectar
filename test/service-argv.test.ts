import { test } from "node:test";
import assert from "node:assert/strict";
import { installCommands, uninstallCommands, legacyUninstallCommands, statusCommand } from "../dist/service/argv.js";
import { resolveServicePlan } from "../dist/service/platform.js";

function plan(overrides: Partial<Parameters<typeof resolveServicePlan>[0]> = {}) {
  return resolveServicePlan({
    platform: "linux" as NodeJS.Platform,
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/nectar",
    ...overrides,
  });
}

test("launchd install: bootstrap into gui/<uid> then kickstart", () => {
  const p = plan({ platform: "darwin", home: "/Users/op" });
  const cmds = installCommands(p, 501);
  assert.equal(cmds[0]?.command, "launchctl");
  assert.deepEqual(cmds[0]?.args, ["bootstrap", "gui/501", p.unitPath]);
  assert.equal(cmds[1]?.args[0], "kickstart");
  assert.match(cmds[1]?.args[2] ?? "", /gui\/501\/com\.legioncode\.nectar/);
});

test("launchd uninstall: bootout the gui/<uid> service target", () => {
  const p = plan({ platform: "darwin", home: "/Users/op" });
  const cmds = uninstallCommands(p, 501);
  assert.equal(cmds[0]?.command, "launchctl");
  assert.deepEqual(cmds[0]?.args, ["bootout", "gui/501/com.legioncode.nectar"]);
});

test("systemd install/uninstall use --user scope by default and the nectar unit name", () => {
  const p = plan({ platform: "linux" });
  // NEC-042 item 3 / AC-018l.10: daemon-reload precedes enable --now.
  assert.deepEqual(installCommands(p, 0)[0]?.args, ["--user", "daemon-reload"]);
  assert.deepEqual(installCommands(p, 0)[1]?.args, ["--user", "enable", "--now", "nectar.service"]);
  assert.deepEqual(uninstallCommands(p, 0)[0]?.args, ["--user", "disable", "--now", "nectar.service"]);
  assert.deepEqual(statusCommand(p, 0).args, ["--user", "is-active", "nectar.service"]);
});

test("systemd system-scope omits --user", () => {
  const p = plan({ platform: "linux", privileged: true, preferSystemScope: true });
  assert.deepEqual(installCommands(p, 0)[0]?.args, ["daemon-reload"]);
  assert.deepEqual(installCommands(p, 0)[1]?.args, ["enable", "--now", "nectar.service"]);
});

test("AC-018l.10 systemd reinstall issues daemon-reload before enable --now (NEC-042 item 3)", () => {
  const p = plan({ platform: "linux" });
  const cmds = installCommands(p, 0);
  const reloadIdx = cmds.findIndex((c) => c.command === "systemctl" && c.args.includes("daemon-reload"));
  const enableIdx = cmds.findIndex((c) => c.command === "systemctl" && c.args.includes("enable"));
  assert.ok(reloadIdx >= 0, "a daemon-reload command is issued");
  assert.ok(enableIdx >= 0, "an enable --now command is issued");
  assert.ok(reloadIdx < enableIdx, "daemon-reload precedes enable --now");
});

test("schtasks install creates from XML then runs it; uninstall deletes; status queries", () => {
  const p = plan({ platform: "win32", home: "C:/Users/op" });
  const install = installCommands(p, 0);
  assert.equal(install[0]?.command, "schtasks");
  assert.deepEqual(install[0]?.args, ["/Create", "/XML", p.unitPath, "/TN", "nectar", "/F"]);
  assert.deepEqual(install[1]?.args, ["/Run", "/TN", "nectar"]);
  assert.deepEqual(uninstallCommands(p, 0)[0]?.args, ["/Delete", "/TN", "nectar", "/F"]);
  assert.deepEqual(statusCommand(p, 0).args, ["/Query", "/TN", "nectar"]);
});

test("sc (Windows system-scope) create + start; stop + delete; query", () => {
  const p = plan({ platform: "win32", home: "C:/Users/op", privileged: true, preferSystemScope: true });
  const install = installCommands(p, 0);
  assert.equal(install[0]?.command, "sc");
  assert.equal(install[0]?.args[0], "create");
  assert.equal(install[0]?.args[1], "nectar");
  assert.deepEqual(uninstallCommands(p, 0).map((c) => c.args[0]), ["stop", "delete"]);
  assert.deepEqual(statusCommand(p, 0).args, ["query", "nectar"]);
});

test("legacy dereg (decision #32 migration) targets the pre-rename unit names on every platform", () => {
  const mac = plan({ platform: "darwin", home: "/Users/op" });
  assert.deepEqual(legacyUninstallCommands(mac, 501)[0]?.args, ["bootout", "gui/501/com.hivenectar.daemon"]);

  const linux = plan({ platform: "linux" });
  assert.deepEqual(legacyUninstallCommands(linux, 0)[0]?.args, ["--user", "disable", "--now", "hivenectar.service"]);

  const win = plan({ platform: "win32", home: "C:/Users/op" });
  assert.deepEqual(legacyUninstallCommands(win, 0)[0]?.args, ["/Delete", "/TN", "HivenectarDaemon", "/F"]);

  const winSys = plan({ platform: "win32", home: "C:/Users/op", privileged: true, preferSystemScope: true });
  assert.deepEqual(legacyUninstallCommands(winSys, 0).map((c) => c.args.join(" ")), [
    "stop HivenectarDaemon",
    "delete HivenectarDaemon",
  ]);
});
