import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { nectarStateDir, resolveApiaryRoot } from "../dist/apiary-root.js";
import { resolveConfig } from "../dist/config.js";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

test("a-AC-1 resolveApiaryRoot defaults to <home>/.apiary and nectarStateDir to <home>/.apiary/nectar", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(resolveApiaryRoot(env, { platform: "darwin", home: "/home/op" }), join("/home/op", ".apiary"));
  assert.equal(nectarStateDir(env, { platform: "darwin", home: "/home/op" }), join("/home/op", ".apiary", "nectar"));
});

test("a-AC-2 APIARY_HOME wins when set and non-blank; blank is treated as unset", () => {
  const envSet: NodeJS.ProcessEnv = { APIARY_HOME: " /custom/root " };
  assert.equal(resolveApiaryRoot(envSet, { platform: "darwin", home: "/home/op" }), "/custom/root");

  const envBlank: NodeJS.ProcessEnv = { APIARY_HOME: "   " };
  assert.equal(resolveApiaryRoot(envBlank, { platform: "darwin", home: "/home/op" }), join("/home/op", ".apiary"));
});

test("a-AC-3 Linux uses XDG_STATE_HOME only when explicitly set and non-blank", () => {
  const linuxXdg: NodeJS.ProcessEnv = { XDG_STATE_HOME: "/xdg/state" };
  assert.equal(resolveApiaryRoot(linuxXdg, { platform: "linux", home: "/home/op" }), join("/xdg/state", "apiary"));
  assert.equal(resolveApiaryRoot({}, { platform: "linux", home: "/home/op" }), join("/home/op", ".apiary"));
  assert.equal(
    resolveApiaryRoot({ XDG_STATE_HOME: "/xdg/state" }, { platform: "win32", home: "/home/op" }),
    join("/home/op", ".apiary"),
  );
});

test("security: a relative APIARY_HOME or XDG_STATE_HOME is ignored (env roots honored only when absolute; never cwd-anchored)", () => {
  const relApiary: NodeJS.ProcessEnv = { APIARY_HOME: "relative/root" };
  assert.equal(resolveApiaryRoot(relApiary, { platform: "linux", home: "/home/op" }), join("/home/op", ".apiary"));

  const relXdg: NodeJS.ProcessEnv = { XDG_STATE_HOME: "relative/state" };
  assert.equal(resolveApiaryRoot(relXdg, { platform: "linux", home: "/home/op" }), join("/home/op", ".apiary"));

  // Windows-shaped absolutes are still honored on any host (win32.isAbsolute superset).
  const winAbs: NodeJS.ProcessEnv = { APIARY_HOME: "C:\\fleet\\root" };
  assert.equal(resolveApiaryRoot(winAbs, { platform: "win32", home: "C:\\Users\\op" }), "C:\\fleet\\root");
});

test("a-AC-4 NECTAR_RUNTIME_DIR keeps precedence over APIARY_HOME for runtimeDir/pid/lock", () => {
  withEnv("APIARY_HOME", "/custom/root", () => {
    withEnv("NECTAR_RUNTIME_DIR", "/tmp/nectar-runtime", () => {
      const cfg = resolveConfig();
      assert.equal(cfg.runtimeDir, "/tmp/nectar-runtime");
      assert.equal(cfg.pidFilePath, join("/tmp/nectar-runtime", "nectar.pid"));
      assert.equal(cfg.lockFilePath, join("/tmp/nectar-runtime", "nectar.lock"));
    });
  });
});
