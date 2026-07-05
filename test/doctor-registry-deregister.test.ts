/**
 * PRD-003b b-AC-3: `deregisterFromDoctor` deletes nectar's entry from doctor's
 * registry, leaving every other entry and unknown top-level key intact, atomic
 * (temp + rename), and best-effort (a malformed file is reported, not clobbered
 * or thrown).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deregisterFromDoctor } from "../dist/doctor-registry.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-dereg-"));
}

test("b-AC-3 deletes nectar's entry and preserves every other daemon + unknown top-level key", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "registry.json");
    const honeycomb = { name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", pidPath: "/x/hc.pid" };
    writeFileSync(
      registryPath,
      JSON.stringify({ schemaHint: 7, daemons: [honeycomb, { name: "nectar", healthUrl: "http://127.0.0.1:3854/health" }] }, null, 2) + "\n",
      "utf8",
    );

    const result = deregisterFromDoctor({ registryPaths: [registryPath] });
    assert.equal(result.removedAny, true);
    assert.equal(result.files[0]?.removed, true);
    assert.equal(result.files[0]?.error, null);

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.schemaHint, 7, "unknown top-level key survives");
    assert.equal(parsed.daemons.length, 1, "only nectar was removed");
    assert.deepEqual(parsed.daemons[0], honeycomb, "honeycomb's entry is byte-for-byte intact");
    assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0, "atomic rename left no temp file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b-AC-3 an absent registry file is a clean no-op (fileExisted false, removed false)", () => {
  const dir = tmpDir();
  try {
    const result = deregisterFromDoctor({ registryPaths: [join(dir, "registry.json")] });
    assert.equal(result.removedAny, false);
    assert.equal(result.files[0]?.fileExisted, false);
    assert.equal(result.files[0]?.removed, false);
    assert.equal(result.files[0]?.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b-AC-3 a registry with no nectar entry is left untouched (removed false, no error)", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "registry.json");
    const body = JSON.stringify({ daemons: [{ name: "hive" }] }, null, 2) + "\n";
    writeFileSync(registryPath, body, "utf8");
    const result = deregisterFromDoctor({ registryPaths: [registryPath] });
    assert.equal(result.removedAny, false);
    assert.equal(result.files[0]?.removed, false);
    assert.equal(readFileSync(registryPath, "utf8"), body, "the file is untouched when nectar is absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b-AC-3 a malformed registry is reported as an error, never clobbered or thrown (best-effort)", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "registry.json");
    writeFileSync(registryPath, "{ not valid json", "utf8");
    const result = deregisterFromDoctor({ registryPaths: [registryPath] });
    assert.equal(result.removedAny, false);
    assert.notEqual(result.files[0]?.error, null, "the malformed file is reported as an error");
    assert.equal(readFileSync(registryPath, "utf8"), "{ not valid json", "the broken file is left exactly as it was");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b-AC-3 removes nectar from whichever of the two candidate files carries it", () => {
  const dir = tmpDir();
  try {
    const fleet = join(dir, "registry.json");
    const legacy = join(dir, "doctor.daemons.json");
    writeFileSync(fleet, JSON.stringify({ daemons: [{ name: "hive" }] }), "utf8");
    writeFileSync(legacy, JSON.stringify({ daemons: [{ name: "nectar" }, { name: "doctor" }] }), "utf8");

    const result = deregisterFromDoctor({ registryPaths: [fleet, legacy] });
    assert.equal(result.removedAny, true);
    assert.equal(result.files[0]?.removed, false, "the fleet file had no nectar entry");
    assert.equal(result.files[1]?.removed, true, "the legacy file's nectar entry was removed");

    const legacyParsed = JSON.parse(readFileSync(legacy, "utf8"));
    assert.deepEqual(legacyParsed.daemons.map((d: { name: string }) => d.name), ["doctor"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
