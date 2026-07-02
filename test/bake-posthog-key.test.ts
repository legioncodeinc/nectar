/**
 * Tests for scripts/bake-posthog-key.mjs: the release-time rewrite of
 * dist/telemetry-usage/posthog-key.js. Each test runs the real script as a
 * subprocess against a temp copy of the compiled stub and asserts the three
 * behaviors: a keyed bake emits loadable ESM with the baked values, an unkeyed
 * run is a logged no-op, and a missing target file fails loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "bake-posthog-key.mjs");
const compiledStub = join(repoRoot, "dist", "telemetry-usage", "posthog-key.js");

/** A temp dist copy holding the real tsc-emitted stub (npm test builds before running). */
function tmpDistCopy(): { root: string; dist: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "nectar-bake-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "telemetry-usage"), { recursive: true });
  const target = join(dist, "telemetry-usage", "posthog-key.js");
  copyFileSync(compiledStub, target);
  return { root, dist, target };
}

function runBake(distDir: string, env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [script, distDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      NECTAR_POSTHOG_KEY: undefined,
      NECTAR_POSTHOG_HOST: undefined,
      HONEYCOMB_POSTHOG_KEY: undefined,
      HONEYCOMB_POSTHOG_HOST: undefined,
      ...env,
    },
  });
}

test("bake: writes loadable ESM carrying the baked key and host (NECTAR_* primary)", async () => {
  const t = tmpDistCopy();
  try {
    const result = runBake(t.dist, {
      NECTAR_POSTHOG_KEY: "phc_bake_test_key",
      NECTAR_POSTHOG_HOST: "https://eu.i.posthog.com",
    });
    assert.equal(result.status, 0, `bake failed: ${result.stderr}`);
    assert.match(result.stdout, /module load verified/);

    // The emitted JS must still load as an ES module with the baked values.
    const loaded = await import(`${pathToFileURL(t.target).href}?t=${Date.now()}`);
    assert.equal(loaded.POSTHOG_KEY, "phc_bake_test_key");
    assert.equal(loaded.POSTHOG_HOST, "https://eu.i.posthog.com");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("bake: the detected HONEYCOMB_* fallback bakes when NECTAR_* is unset, and NECTAR_* wins when both are set", async () => {
  const t = tmpDistCopy();
  try {
    const fallback = runBake(t.dist, { HONEYCOMB_POSTHOG_KEY: "phc_family_fallback" });
    assert.equal(fallback.status, 0, `fallback bake failed: ${fallback.stderr}`);
    let loaded = await import(`${pathToFileURL(t.target).href}?t=${Date.now()}`);
    assert.equal(loaded.POSTHOG_KEY, "phc_family_fallback");

    const both = runBake(t.dist, {
      NECTAR_POSTHOG_KEY: "phc_nectar_primary",
      HONEYCOMB_POSTHOG_KEY: "phc_family_fallback",
    });
    assert.equal(both.status, 0, `primary-wins bake failed: ${both.stderr}`);
    loaded = await import(`${pathToFileURL(t.target).href}?t=${Date.now() + 1}`);
    assert.equal(loaded.POSTHOG_KEY, "phc_nectar_primary", "nectar's own env name wins over the detected fallback");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("bake: unset key is a logged no-op that leaves the stub untouched", () => {
  const t = tmpDistCopy();
  try {
    const before = readFileSync(t.target, "utf8");
    const result = runBake(t.dist, {});
    assert.equal(result.status, 0, `no-op run failed: ${result.stderr}`);
    assert.match(result.stdout, /unset or empty/);
    assert.equal(readFileSync(t.target, "utf8"), before, "the stub file is unchanged");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("bake: a missing target file fails loudly (catches a moved module)", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "nectar-bake-missing-"));
  try {
    const result = runBake(join(emptyRoot, "dist"), { NECTAR_POSTHOG_KEY: "phc_whatever" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target file not found/);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});
