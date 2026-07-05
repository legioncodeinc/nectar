/**
 * PRD-003a a-AC-3: `nectar install` opens the device-flow popup ONLY when solo
 * AND no credentials exist; fleet detected or credentials present -> no popup.
 * Plus the `nectar login` flag parsing (a-AC-5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideInstallLoginAction, parseLoginFlags } from "../dist/cli.js";

test("a-AC-3 fleet detected -> defer to hive (never a popup), regardless of credentials", () => {
  assert.equal(decideInstallLoginAction("fleet", false), "defer-to-hive");
  assert.equal(decideInstallLoginAction("fleet", true), "defer-to-hive");
});

test("a-AC-3 solo with credentials present -> no popup", () => {
  assert.equal(decideInstallLoginAction("solo", true), "already-signed-in");
});

test("a-AC-3 solo with NO credentials -> open the sign-in popup", () => {
  assert.equal(decideInstallLoginAction("solo", false), "open-sign-in");
});

test("a-AC-5 parseLoginFlags accepts --org=<id> / --workspace=<id> and the spaced forms", () => {
  assert.deepEqual(parseLoginFlags(["--org=o1", "--workspace=w1"]), { flags: { org: "o1", workspace: "w1" }, errors: [] });
  assert.deepEqual(parseLoginFlags(["--org", "o2", "--workspace", "w2"]), { flags: { org: "o2", workspace: "w2" }, errors: [] });
  assert.deepEqual(parseLoginFlags([]), { flags: {}, errors: [] });
});

test("a-AC-5 parseLoginFlags reports a missing value and an unknown flag", () => {
  const missing = parseLoginFlags(["--org"]);
  assert.deepEqual(missing.flags, {});
  assert.ok(missing.errors.some((e) => /--org requires a value/.test(e)));

  const unknown = parseLoginFlags(["--nope"]);
  assert.ok(unknown.errors.some((e) => /unknown flag '--nope'/.test(e)));
});
