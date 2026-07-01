import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultIgnore, loadIgnorePrefixes } from "../dist/registration/ignore.js";

const ROOT = "/repo";

test("default ignore skips version-control, dependency, and runtime dirs", () => {
  const isIgnored = createDefaultIgnore(ROOT, () => null); // no graph-ignore file present
  assert.equal(isIgnored(".git/config"), true);
  assert.equal(isIgnored("node_modules/pkg/index.js"), true);
  assert.equal(isIgnored(".honeycomb/nectars.json"), true);
  assert.equal(isIgnored("src/deep/node_modules/x.ts"), true, "an ignored dir anywhere in the path drops it");
  assert.equal(isIgnored("src/a.ts"), false);
});

test("default ignore honors a graph-ignore.json array", () => {
  const readFile = () => JSON.stringify(["dist", "coverage"]);
  const isIgnored = createDefaultIgnore(ROOT, readFile);
  assert.equal(isIgnored("dist/bundle.js"), true);
  assert.equal(isIgnored("coverage/lcov.info"), true);
  assert.equal(isIgnored("distinct/keep.ts"), false, "prefix match is path-segment aware, not substring");
  assert.equal(isIgnored("src/a.ts"), false);
});

test("default ignore honors the { ignore: [...] } object form", () => {
  const isIgnored = createDefaultIgnore(ROOT, () => JSON.stringify({ ignore: ["build"] }));
  assert.equal(isIgnored("build/out.js"), true);
  assert.equal(isIgnored("build"), true);
  assert.equal(isIgnored("src/a.ts"), false);
});

test("a malformed graph-ignore file fails open to the built-in segment rules", () => {
  const isIgnored = createDefaultIgnore(ROOT, () => "{ not json");
  assert.equal(isIgnored("node_modules/x.ts"), true, "built-in rules still apply");
  assert.equal(isIgnored("dist/out.js"), false, "no declared prefixes survive a malformed file");
});

test("loadIgnorePrefixes returns [] for a missing file", () => {
  assert.deepEqual(loadIgnorePrefixes(ROOT, () => null), []);
});
