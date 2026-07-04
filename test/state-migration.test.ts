import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MIGRATION_MARKER_FILE_NAME,
  assertNoLegacyDaemonRunning,
  resolveStateReadPath,
  runStateMigration,
} from "../dist/state-migration.js";
import { DoctorRegistryError, registerWithDoctor } from "../dist/doctor-registry.js";
import { assembleDaemon } from "../dist/index.js";

function tmpPaths() {
  const root = mkdtempSync(join(tmpdir(), "nectar-state-migration-"));
  const legacyDir = join(root, "legacy");
  const fleetRoot = join(root, "apiary");
  const runtimeDir = join(fleetRoot, "nectar");
  return { root, legacyDir, fleetRoot, runtimeDir };
}

function writeFile(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const baseConfig = (runtimeDir: string) => ({
  runtimeDir,
  host: "127.0.0.1",
  port: 3854,
  pidFilePath: join(runtimeDir, "nectar.pid"),
});

test("b-AC-1 migrates allow-listed files into <fleet-root>/nectar and writes a marker", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "nectar.json"), '{"k":"v"}\n');
    writeFile(join(t.legacyDir, "pending-reviews.json"), '["a"]\n');
    writeFile(join(t.legacyDir, "telemetry", "nectar.sqlite"), "sqlite");
    writeFile(join(t.legacyDir, "nectar-usage-telemetry.json"), '{"reported":[]}\n');
    mkdirSync(t.fleetRoot, { recursive: true });

    const result = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
      nowIso: () => "2026-07-04T00:00:00.000Z",
    });

    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.moved.sort(), [
      "nectar-usage-telemetry.json",
      "nectar.json",
      "pending-reviews.json",
      "telemetry/nectar.sqlite",
    ]);
    assert.equal(existsSync(join(t.runtimeDir, "nectar.json")), true);
    assert.equal(existsSync(join(t.runtimeDir, "pending-reviews.json")), true);
    assert.equal(existsSync(join(t.runtimeDir, "telemetry", "nectar.sqlite")), true);
    assert.equal(existsSync(join(t.runtimeDir, "nectar-usage-telemetry.json")), true);
    assert.equal(existsSync(join(t.legacyDir, "nectar.json")), false);
    assert.equal(existsSync(join(t.legacyDir, "pending-reviews.json")), false);
    assert.equal(existsSync(join(t.legacyDir, "telemetry", "nectar.sqlite")), false);
    assert.equal(existsSync(join(t.legacyDir, "nectar-usage-telemetry.json")), false);
    assert.equal(existsSync(join(t.runtimeDir, MIGRATION_MARKER_FILE_NAME)), true);
    assert.equal(existsSync(join(t.fleetRoot, "registry.json")), true);
    const registry = JSON.parse(readFileSync(join(t.fleetRoot, "registry.json"), "utf8"));
    const nectarEntry = (registry.daemons as Array<{ name: string; pidPath: string; telemetryDbPath: string }>).find(
      (entry) => entry.name === "nectar",
    );
    assert.equal(nectarEntry?.pidPath, join(t.runtimeDir, "nectar.pid"));
    assert.equal(nectarEntry?.telemetryDbPath, join(t.runtimeDir, "telemetry", "nectar.sqlite"));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("b-AC-2 rerunning migration after completion is idempotent (no additional moves)", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "nectar.json"), '{"k":"v"}\n');
    mkdirSync(t.fleetRoot, { recursive: true });
    runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });
    const second = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });
    assert.equal(second.skipped, true);
    assert.deepEqual(second.moved, []);
    assert.deepEqual(second.failed, []);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("b-AC-3 failed file migration leaves legacy source intact and retries successfully on next boot", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "pending-reviews.json"), '["legacy"]\n');
    mkdirSync(t.fleetRoot, { recursive: true });
    const failed = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
      migrateFile: (sourcePath, targetPath) => {
        if (targetPath.endsWith("pending-reviews.json")) throw new Error("simulated copy failure");
        writeFile(targetPath, readFileSync(sourcePath, "utf8"));
      },
    });
    assert.deepEqual(failed.failed, ["pending-reviews.json"]);
    assert.equal(existsSync(join(t.legacyDir, "pending-reviews.json")), true);
    assert.equal(existsSync(join(t.runtimeDir, "pending-reviews.json")), false);

    const retried = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });
    assert.deepEqual(retried.failed, []);
    assert.ok(retried.moved.includes("pending-reviews.json"));
    assert.equal(existsSync(join(t.runtimeDir, "pending-reviews.json")), true);
    assert.equal(existsSync(join(t.legacyDir, "pending-reviews.json")), false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("b-AC-4 legacy live pid blocks startup; stale legacy pid allows startup guard to pass", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "nectar.pid"), String(process.pid));
    writeFile(join(t.legacyDir, "nectar.lock"), String(process.pid));
    assert.throws(
      () =>
        assertNoLegacyDaemonRunning({
          runtimeDir: t.runtimeDir,
          pidFilePath: join(t.runtimeDir, "nectar.pid"),
          lockFilePath: join(t.runtimeDir, "nectar.lock"),
          legacyDir: t.legacyDir,
        }),
      /already running/i,
    );

    writeFile(join(t.legacyDir, "nectar.pid"), "2147483600");
    assert.doesNotThrow(() =>
      assertNoLegacyDaemonRunning({
        runtimeDir: t.runtimeDir,
        pidFilePath: join(t.runtimeDir, "nectar.pid"),
        lockFilePath: join(t.runtimeDir, "nectar.lock"),
        legacyDir: t.legacyDir,
      }),
    );
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("b-AC-5 resolveStateReadPath prefers new path and falls back to legacy when new path is absent", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "pending-reviews.json"), '["legacy"]');
    const fallback = resolveStateReadPath("pending-reviews.json", { runtimeDir: t.runtimeDir, legacyDir: t.legacyDir });
    assert.equal(fallback, join(t.legacyDir, "pending-reviews.json"));

    writeFile(join(t.runtimeDir, "pending-reviews.json"), '["new"]');
    const preferred = resolveStateReadPath("pending-reviews.json", { runtimeDir: t.runtimeDir, legacyDir: t.legacyDir });
    assert.equal(preferred, join(t.runtimeDir, "pending-reviews.json"));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("b-AC-6 migration allow-list leaves non-nectar legacy files byte-identical", () => {
  const t = tmpPaths();
  try {
    const nonOwnedPath = join(t.legacyDir, "doctor.daemons.json");
    writeFile(nonOwnedPath, '{"daemons":[]}\n');
    writeFile(join(t.legacyDir, "nectar.json"), '{"k":"v"}\n');
    mkdirSync(t.fleetRoot, { recursive: true });

    runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });

    assert.equal(readFileSync(nonOwnedPath, "utf8"), '{"daemons":[]}\n');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("b-AC-7 partially migrated state completes remaining moves on next boot", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.runtimeDir, "nectar.json"), '{"already":"new"}\n');
    writeFile(join(t.legacyDir, "pending-reviews.json"), '["legacy"]\n');
    mkdirSync(t.fleetRoot, { recursive: true });
    const result = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });
    assert.ok(result.moved.includes("pending-reviews.json"));
    assert.equal(existsSync(join(t.runtimeDir, "nectar.json")), true);
    assert.equal(existsSync(join(t.runtimeDir, "pending-reviews.json")), true);
    assert.equal(existsSync(join(t.legacyDir, "pending-reviews.json")), false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("c-AC-4 a malformed registry fails loudly (logged, not clobbered) but the migration pass is fail-soft: no throw, refresh skipped, marker written", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "nectar.json"), '{"k":"v"}\n');
    mkdirSync(t.fleetRoot, { recursive: true });
    const malformed = join(t.fleetRoot, "registry.json");
    writeFile(malformed, "{ malformed json ");

    const logged: Array<Record<string, unknown>> = [];
    let result: ReturnType<typeof runStateMigration> | undefined;
    assert.doesNotThrow(() => {
      result = runStateMigration({
        config: baseConfig(t.runtimeDir),
        legacyDir: t.legacyDir,
        env: { APIARY_HOME: t.fleetRoot },
        homeDir: join(t.root, "home"),
        log: (line) => logged.push(line),
      });
    });
    // Not clobbered (the registerWithDoctor fail-loud-on-write posture stands).
    assert.equal(readFileSync(malformed, "utf8"), "{ malformed json ");
    // The refresh was skipped, the reason logged loudly with the path.
    assert.equal(result?.refreshedRegistry, false);
    const warning = logged.find((l) => l["msg"] === "doctor registry refresh skipped; the registry file could not be safely edited (not clobbered)");
    assert.ok(warning !== undefined, "the malformed-registry reason is logged loudly");
    assert.equal(warning?.["registryPath"], malformed);
    assert.ok(String(warning?.["err"]).length > 0, "the log carries why the edit was refused");
    // The pass otherwise completed: files moved and the marker written.
    assert.ok(result?.moved.includes("nectar.json"));
    assert.equal(existsSync(join(t.runtimeDir, MIGRATION_MARKER_FILE_NAME)), true);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("c-AC-4 the install verb keeps the fail-loud write posture: registerWithDoctor still throws DoctorRegistryError on a malformed registry", () => {
  const t = tmpPaths();
  try {
    mkdirSync(t.fleetRoot, { recursive: true });
    const malformed = join(t.fleetRoot, "registry.json");
    writeFile(malformed, "{ malformed json ");
    assert.throws(
      () =>
        registerWithDoctor({
          config: { host: "127.0.0.1", port: 3854, pidFilePath: join(t.runtimeDir, "nectar.pid") },
          registryPath: malformed,
        }),
      DoctorRegistryError,
    );
    assert.equal(readFileSync(malformed, "utf8"), "{ malformed json ");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("c-AC-4 a present-but-malformed doctor registry does not prevent daemon start (boot survives, /health serves)", async () => {
  const t = tmpPaths();
  const fakeHome = join(t.root, "home");
  const saved = {
    APIARY_HOME: process.env["APIARY_HOME"],
    NECTAR_RUNTIME_DIR: process.env["NECTAR_RUNTIME_DIR"],
    HOME: process.env["HOME"],
    USERPROFILE: process.env["USERPROFILE"],
  };
  try {
    // Hermetic HOME: the migration's legacy dir and the registry path both
    // derive from env, never the real user home.
    mkdirSync(fakeHome, { recursive: true });
    process.env["HOME"] = fakeHome;
    process.env["USERPROFILE"] = fakeHome;
    process.env["APIARY_HOME"] = t.fleetRoot;
    delete process.env["NECTAR_RUNTIME_DIR"];

    // Legacy state exists (triggers the refresh) and the registry is malformed.
    writeFile(join(fakeHome, ".honeycomb", "nectar.json"), '{"k":"v"}\n');
    mkdirSync(t.fleetRoot, { recursive: true });
    const malformed = join(t.fleetRoot, "registry.json");
    writeFile(malformed, "{ malformed json ");

    const daemon = assembleDaemon({ port: 0, log: () => {} });
    let port = 0;
    try {
      port = await daemon.start(); // pre-fix this threw DoctorRegistryError and bricked boot
      assert.ok(port > 0, "the daemon bound a port despite the malformed registry");
      assert.equal(readFileSync(malformed, "utf8"), "{ malformed json ", "the malformed registry is never clobbered");
    } finally {
      await daemon.shutdown();
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("registry refresh advertises the LEGACY telemetryDbPath when the SQLite move failed and the legacy DB is still live", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "telemetry", "nectar.sqlite"), "sqlite");
    mkdirSync(t.fleetRoot, { recursive: true });
    const result = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
      migrateFile: (_sourcePath, targetPath) => {
        if (targetPath.endsWith("nectar.sqlite")) throw new Error("simulated copy failure");
      },
    });
    assert.deepEqual(result.failed, ["telemetry/nectar.sqlite"]);
    assert.equal(existsSync(join(t.legacyDir, "telemetry", "nectar.sqlite")), true, "the legacy DB is still live");

    const registry = JSON.parse(readFileSync(join(t.fleetRoot, "registry.json"), "utf8"));
    const entry = (registry.daemons as Array<{ name: string; telemetryDbPath: string }>).find((e) => e.name === "nectar");
    assert.equal(
      entry?.telemetryDbPath,
      join(t.legacyDir, "telemetry", "nectar.sqlite"),
      "doctor is pointed at the DB that actually exists, not a not-yet-existing new path",
    );
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("registry refresh advertises the NEW telemetryDbPath once the SQLite move succeeded (heals on the retry boot)", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "telemetry", "nectar.sqlite"), "sqlite");
    mkdirSync(t.fleetRoot, { recursive: true });
    const result = runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });
    assert.deepEqual(result.failed, []);
    assert.ok(result.moved.includes("telemetry/nectar.sqlite"));

    const registry = JSON.parse(readFileSync(join(t.fleetRoot, "registry.json"), "utf8"));
    const entry = (registry.daemons as Array<{ name: string; telemetryDbPath: string }>).find((e) => e.name === "nectar");
    assert.equal(entry?.telemetryDbPath, join(t.runtimeDir, "telemetry", "nectar.sqlite"));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("c-AC-4 registry refresh runs after telemetry move", () => {
  const t = tmpPaths();
  try {
    writeFile(join(t.legacyDir, "telemetry", "nectar.sqlite"), "sqlite");
    mkdirSync(t.fleetRoot, { recursive: true });
    runStateMigration({
      config: baseConfig(t.runtimeDir),
      legacyDir: t.legacyDir,
      env: { APIARY_HOME: t.fleetRoot },
      homeDir: join(t.root, "home"),
    });
    const telemetryMovedAt = statSync(join(t.runtimeDir, "telemetry", "nectar.sqlite")).mtimeMs;
    const registryWrittenAt = statSync(join(t.fleetRoot, "registry.json")).mtimeMs;
    assert.ok(registryWrittenAt >= telemetryMovedAt);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
