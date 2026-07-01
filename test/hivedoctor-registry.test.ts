import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HIVENECTAR_DAEMON_NAME,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_STARTUP_GRACE_MS,
  DEFAULT_RESTART_GIVE_UP_THRESHOLD,
  DEFAULT_RESTART_COOLDOWN_MS,
  HivedoctorRegistryError,
  buildHivenectarRegistryEntry,
  registerWithHivedoctor,
} from "../dist/hivedoctor-registry.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "hivenectar-registry-"));
}

const config = { host: "127.0.0.1", port: 3854, pidFilePath: "/home/op/.honeycomb/hivenectar.pid" };

test("buildHivenectarRegistryEntry resolves healthUrl/pidPath from config and hivedoctor's defaults", () => {
  const entry = buildHivenectarRegistryEntry(config);
  assert.equal(entry.name, HIVENECTAR_DAEMON_NAME);
  assert.equal(entry.healthUrl, "http://127.0.0.1:3854/health");
  assert.equal(entry.pidPath, "/home/op/.honeycomb/hivenectar.pid");
  assert.equal(entry.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
  assert.equal(entry.startupGraceMs, DEFAULT_STARTUP_GRACE_MS);
  assert.equal(entry.restartGiveUpThreshold, DEFAULT_RESTART_GIVE_UP_THRESHOLD);
  assert.equal(entry.restartCooldownMs, DEFAULT_RESTART_COOLDOWN_MS);
});

test("registerWithHivedoctor creates the registry file with a single hivenectar entry when absent", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "hivedoctor.daemons.json");
    const result = registerWithHivedoctor({ config, registryPath });
    assert.equal(result.created, true);
    assert.equal(result.replaced, false);
    assert.ok(existsSync(registryPath));

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 1);
    assert.equal(parsed.daemons[0].name, "hivenectar");
    assert.equal(parsed.daemons[0].healthUrl, "http://127.0.0.1:3854/health");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWithHivedoctor appends to an existing registry without touching other daemons", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "hivedoctor.daemons.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        daemons: [
          {
            name: "honeycomb",
            healthUrl: "http://127.0.0.1:3850/health",
            pidPath: "/home/op/.honeycomb/daemon.pid",
            probeIntervalMs: 30000,
            startupGraceMs: 60000,
            restartGiveUpThreshold: 3,
            restartCooldownMs: 5000,
          },
        ],
      }),
      "utf8",
    );

    const result = registerWithHivedoctor({ config, registryPath });
    assert.equal(result.created, false);
    assert.equal(result.replaced, false);

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 2);
    assert.equal(parsed.daemons[0].name, "honeycomb", "honeycomb's entry is untouched");
    assert.equal(parsed.daemons[1].name, "hivenectar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-registering replaces hivenectar's own entry rather than duplicating it (idempotent)", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "hivedoctor.daemons.json");
    registerWithHivedoctor({ config, registryPath });
    const second = registerWithHivedoctor({
      config: { ...config, port: 3999 },
      registryPath,
    });
    assert.equal(second.created, false);
    assert.equal(second.replaced, true);

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 1, "no duplicate hivenectar entries");
    assert.equal(parsed.daemons[0].healthUrl, "http://127.0.0.1:3999/health", "the entry was updated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a present-but-malformed registry file fails loudly instead of being silently clobbered", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "hivedoctor.daemons.json");
    writeFileSync(registryPath, "{ not valid json", "utf8");
    assert.throws(() => registerWithHivedoctor({ config, registryPath }), HivedoctorRegistryError);
    // The broken file must be left exactly as it was.
    assert.equal(readFileSync(registryPath, "utf8"), "{ not valid json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry file whose daemons field is not an array fails loudly", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "hivedoctor.daemons.json");
    writeFileSync(registryPath, JSON.stringify({ daemons: "nope" }), "utf8");
    assert.throws(() => registerWithHivedoctor({ config, registryPath }), HivedoctorRegistryError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
