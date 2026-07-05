/**
 * PRD-003a a-AC-6: solo/fleet classification is deterministic for a given
 * machine state, ANY signal means FLEET, and which signals fired is visible for
 * supportability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFleet,
  fleetSignalLine,
  defaultReadRegistrySignal,
  registryCandidatePaths,
  HIVE_NPM_PACKAGE,
} from "../dist/fleet-detection.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-fleet-"));
}

test("a-AC-6 no signals fired -> SOLO, and the log line says so", async () => {
  const result = await classifyFleet({
    readRegistrySignal: () => false,
    probeHivePort: async () => false,
    npmGlobalHasHive: async () => false,
  });
  assert.equal(result.mode, "solo");
  assert.deepEqual(result.signals, { registryHiveEntry: false, hivePortAnswering: false, hiveNpmGlobal: false });
  assert.deepEqual(result.firedSignals, []);
  assert.match(fleetSignalLine(result), /SOLO/);
});

test("a-AC-6 the live port answer alone means FLEET (any signal wins)", async () => {
  const result = await classifyFleet({
    readRegistrySignal: () => false,
    probeHivePort: async () => true,
    npmGlobalHasHive: async () => false,
  });
  assert.equal(result.mode, "fleet");
  assert.deepEqual(result.firedSignals, ["Hive portal on 127.0.0.1:3853"]);
  assert.match(fleetSignalLine(result), /FLEET/);
  assert.match(fleetSignalLine(result), /127\.0\.0\.1:3853/);
});

test("a-AC-6 the registry Hive entry alone means FLEET", async () => {
  const result = await classifyFleet({
    readRegistrySignal: () => true,
    probeHivePort: async () => false,
    npmGlobalHasHive: async () => false,
  });
  assert.equal(result.mode, "fleet");
  assert.deepEqual(result.firedSignals, ["registry Hive entry"]);
});

test("a-AC-6 the npm-global signal alone means FLEET and names the package", async () => {
  const result = await classifyFleet({
    readRegistrySignal: () => false,
    probeHivePort: async () => false,
    npmGlobalHasHive: async () => true,
  });
  assert.equal(result.mode, "fleet");
  assert.deepEqual(result.firedSignals, [`npm global ${HIVE_NPM_PACKAGE}`]);
});

test("a-AC-6 all three signals are recorded when they all fire (deterministic evidence)", async () => {
  const result = await classifyFleet({
    readRegistrySignal: () => true,
    probeHivePort: async () => true,
    npmGlobalHasHive: async () => true,
  });
  assert.equal(result.mode, "fleet");
  assert.equal(result.firedSignals.length, 3);
});

test("a-AC-6 S1 reads a hive entry from the fleet-root registry.json", () => {
  const dir = tmpDir();
  try {
    const fleetRoot = join(dir, "apiary");
    mkdirSync(fleetRoot, { recursive: true });
    writeFileSync(
      join(fleetRoot, "registry.json"),
      JSON.stringify({ daemons: [{ name: "hive" }, { name: "nectar" }] }),
      "utf8",
    );
    const fired = defaultReadRegistrySignal({ env: { APIARY_HOME: fleetRoot }, home: dir });
    assert.equal(fired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-6 S1 is absent when neither registry file names hive", () => {
  const dir = tmpDir();
  try {
    const fleetRoot = join(dir, "apiary");
    mkdirSync(fleetRoot, { recursive: true });
    writeFileSync(join(fleetRoot, "registry.json"), JSON.stringify({ daemons: [{ name: "nectar" }] }), "utf8");
    const fired = defaultReadRegistrySignal({ env: { APIARY_HOME: fleetRoot }, home: dir });
    assert.equal(fired, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-6 S1 reads BOTH the fleet-root and legacy registry candidate paths", () => {
  const dir = tmpDir();
  try {
    const fleetRoot = join(dir, "apiary");
    const paths = registryCandidatePaths({ env: { APIARY_HOME: fleetRoot }, home: dir });
    assert.equal(paths.length, 2);
    assert.ok(paths[0]?.endsWith(join("apiary", "registry.json")));
    assert.ok(paths[1]?.endsWith(join(".honeycomb", "doctor.daemons.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
