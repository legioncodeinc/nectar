import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveServicePlan,
  normalizePlatform,
  SERVICE_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
} from "../dist/service/platform.js";

function env(overrides: Partial<Parameters<typeof resolveServicePlan>[0]> = {}) {
  return {
    platform: "linux" as NodeJS.Platform,
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/nectar",
    ...overrides,
  };
}

test("nectar's service constants follow the decision-#32 fleet scheme (short name `nectar`)", () => {
  assert.equal(SERVICE_LABEL, "com.legioncode.nectar");
  assert.equal(SYSTEMD_UNIT_NAME, "nectar.service");
  assert.equal(WINDOWS_TASK_NAME, "nectar");
});

test("darwin resolves to launchd, user scope, LaunchAgents path", () => {
  const plan = resolveServicePlan(env({ platform: "darwin", home: "/Users/op" }));
  assert.equal(plan.manager, "launchd");
  assert.equal(plan.scope, "user");
  assert.equal(plan.unitPath, "/Users/op/Library/LaunchAgents/com.legioncode.nectar.plist");
  assert.equal(plan.fellBackToUser, false);
});

test("linux resolves to systemd, user scope, systemd --user path", () => {
  const plan = resolveServicePlan(env({ platform: "linux", home: "/home/op" }));
  assert.equal(plan.manager, "systemd");
  assert.equal(plan.scope, "user");
  assert.equal(plan.unitPath, "/home/op/.config/systemd/user/nectar.service");
});

test("win32 defaults to schtasks (per-user), never sc, unless system scope is requested+privileged", () => {
  const plan = resolveServicePlan(env({ platform: "win32", home: "C:/Users/op" }));
  assert.equal(plan.manager, "schtasks");
  assert.equal(plan.scope, "user");
  assert.equal(plan.unitPath, "", "schtasks has no file we own on disk");
});

test("system scope requested but unprivileged falls back to user scope", () => {
  const plan = resolveServicePlan(env({ platform: "linux", privileged: false, preferSystemScope: true }));
  assert.equal(plan.scope, "user");
  assert.equal(plan.fellBackToUser, true);
});

test("system scope requested and privileged is honored", () => {
  const plan = resolveServicePlan(env({ platform: "linux", privileged: true, preferSystemScope: true }));
  assert.equal(plan.scope, "system");
  assert.equal(plan.fellBackToUser, false);
  assert.equal(plan.unitPath, "/etc/systemd/system/nectar.service");
});

test("win32 system scope (privileged + requested) uses sc, not schtasks", () => {
  const plan = resolveServicePlan(env({ platform: "win32", privileged: true, preferSystemScope: true }));
  assert.equal(plan.manager, "sc");
  assert.equal(plan.scope, "system");
});

test("an unsupported platform throws rather than silently degrading", () => {
  assert.throws(() => resolveServicePlan(env({ platform: "aix" as NodeJS.Platform })), /unsupported platform/);
  assert.equal(normalizePlatform("aix" as NodeJS.Platform), null);
});
