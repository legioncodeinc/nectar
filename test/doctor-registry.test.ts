import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NECTAR_DAEMON_NAME,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_STARTUP_GRACE_MS,
  DEFAULT_RESTART_GIVE_UP_THRESHOLD,
  DEFAULT_RESTART_COOLDOWN_MS,
  DoctorRegistryError,
  buildNectarRegistryEntry,
  registerWithDoctor,
} from "../dist/doctor-registry.js";
import { TELEMETRY_DB_FILE_NAME, TELEMETRY_DIR_NAME } from "../dist/telemetry/db.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "nectar-registry-"));
}

const config = { host: "127.0.0.1", port: 3854, pidFilePath: "/home/op/.honeycomb/nectar.pid" };

test("buildNectarRegistryEntry resolves healthUrl/pidPath from config and doctor's defaults", () => {
  const entry = buildNectarRegistryEntry(config);
  assert.equal(entry.name, NECTAR_DAEMON_NAME);
  assert.equal(entry.healthUrl, "http://127.0.0.1:3854/health");
  assert.equal(entry.pidPath, "/home/op/.honeycomb/nectar.pid");
  assert.equal(entry.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
  assert.equal(entry.startupGraceMs, DEFAULT_STARTUP_GRACE_MS);
  assert.equal(entry.restartGiveUpThreshold, DEFAULT_RESTART_GIVE_UP_THRESHOLD);
  assert.equal(entry.restartCooldownMs, DEFAULT_RESTART_COOLDOWN_MS);
});

test("AC-018a.9 buildNectarRegistryEntry marks restarts as owned by the OS unit (restartPolicy: external)", () => {
  const entry = buildNectarRegistryEntry(config);
  assert.equal(entry.restartPolicy, "external", "the OS service unit is the single restart authority (NEC-030)");
});

test("AC-018a.9 the registry entry nectar install writes marks the OS unit as restart owner", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    const result = registerWithDoctor({ config, registryPath });
    assert.equal(result.entry.restartPolicy, "external");

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons[0].restartPolicy, "external", "the persisted entry marks restarts external");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildNectarRegistryEntry declares the absolute telemetry SQLite DB path, colocated with pidPath's runtime dir (AC-1 / AC-017a.1.1)", () => {
  const entry = buildNectarRegistryEntry(config);
  assert.equal(entry.telemetryDbPath, join("/home/op/.honeycomb", TELEMETRY_DIR_NAME, TELEMETRY_DB_FILE_NAME));
});

test("telemetryDbPath is overridable, mirroring the other per-daemon override fields", () => {
  const entry = buildNectarRegistryEntry(config, { telemetryDbPath: "/custom/telemetry.sqlite" });
  assert.equal(entry.telemetryDbPath, "/custom/telemetry.sqlite");
});

test("registerWithDoctor creates the registry file with a single nectar entry when absent", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    const result = registerWithDoctor({ config, registryPath });
    assert.equal(result.created, true);
    assert.equal(result.replaced, false);
    assert.ok(existsSync(registryPath));

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 1);
    assert.equal(parsed.daemons[0].name, "nectar");
    assert.equal(parsed.daemons[0].healthUrl, "http://127.0.0.1:3854/health");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWithDoctor appends to an existing registry without touching other daemons", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
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

    const result = registerWithDoctor({ config, registryPath });
    assert.equal(result.created, false);
    assert.equal(result.replaced, false);

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 2);
    assert.equal(parsed.daemons[0].name, "honeycomb", "honeycomb's entry is untouched");
    assert.equal(parsed.daemons[1].name, "nectar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-registering replaces nectar's own entry rather than duplicating it (idempotent)", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    registerWithDoctor({ config, registryPath });
    const second = registerWithDoctor({
      config: { ...config, port: 3999 },
      registryPath,
    });
    assert.equal(second.created, false);
    assert.equal(second.replaced, true);

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 1, "no duplicate nectar entries");
    assert.equal(parsed.daemons[0].healthUrl, "http://127.0.0.1:3999/health", "the entry was updated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-registration (reinstall/upgrade) refreshes the entry idempotently while telemetryDbPath stays stable (AC-017a.1.2)", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    const first = registerWithDoctor({ config, registryPath });
    const second = registerWithDoctor({ config: { ...config, port: 3999 }, registryPath });

    assert.equal(second.entry.telemetryDbPath, first.entry.telemetryDbPath, "the DB path is stable across reinstall");

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.daemons.length, 1, "no duplicate nectar entries");
    assert.equal(parsed.daemons[0].telemetryDbPath, first.entry.telemetryDbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registering nectar preserves another daemon's entry byte-for-byte, including its own fields (untouched by the telemetryDbPath extension)", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    const honeycombEntry = {
      name: "honeycomb",
      healthUrl: "http://127.0.0.1:3850/health",
      pidPath: "/home/op/.honeycomb/daemon.pid",
      probeIntervalMs: 30000,
      startupGraceMs: 60000,
      restartGiveUpThreshold: 3,
      restartCooldownMs: 5000,
    };
    writeFileSync(registryPath, JSON.stringify({ daemons: [honeycombEntry] }), "utf8");

    registerWithDoctor({ config, registryPath });

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.deepEqual(parsed.daemons[0], honeycombEntry, "honeycomb's entry is byte-for-byte unchanged (no telemetryDbPath added to it)");
    assert.ok(parsed.daemons[1].telemetryDbPath, "nectar's own entry carries the new field");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a present-but-malformed registry file fails loudly instead of being silently clobbered", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    writeFileSync(registryPath, "{ not valid json", "utf8");
    assert.throws(() => registerWithDoctor({ config, registryPath }), DoctorRegistryError);
    // The broken file must be left exactly as it was.
    assert.equal(readFileSync(registryPath, "utf8"), "{ not valid json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry file whose daemons field is not an array fails loudly", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    writeFileSync(registryPath, JSON.stringify({ daemons: "nope" }), "utf8");
    assert.throws(() => registerWithDoctor({ config, registryPath }), DoctorRegistryError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("018j-AC-018j.5 registry rewrite uses temp file plus rename, not in-place write to the final path", () => {
  const src = readFileSync(fileURLToPath(new URL("../dist/doctor-registry.js", import.meta.url)), "utf8");
  assert.match(src, /renameSync/, "write lands via same-directory rename");
  assert.match(src, /\.tmp/, "write uses a temp file in the registry directory");
  assert.doesNotMatch(src, /writeFileSync\(registryPath/);
});

test("018j-AC-018j.6 unknown top-level keys survive a rewrite; only daemons is replaced", () => {
  const dir = tmpDir();
  try {
    const registryPath = join(dir, "doctor.daemons.json");
    writeFileSync(
      registryPath,
      JSON.stringify({ schemaHint: 1, daemons: [] }, null, 2) + "\n",
      "utf8",
    );

    registerWithDoctor({ config, registryPath });

    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(parsed.schemaHint, 1, "unknown top-level key survives");
    assert.equal(parsed.daemons.length, 1);
    assert.equal(parsed.daemons[0].name, "nectar");
    assert.equal(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")).length,
      0,
      "no temp files left after atomic rename",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("018j-AC-018j.7 the concurrent-install read-modify-write race is documented in the module", () => {
  const src = readFileSync(fileURLToPath(new URL("../dist/doctor-registry.js", import.meta.url)), "utf8");
  assert.match(src, /read-modify-write/i);
  assert.match(src, /concurrent installs/i);
});
