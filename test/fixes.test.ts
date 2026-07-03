/**
 * Regression tests for the CodeRabbit Major (stability/data-integrity) findings
 * fixed on PR #1: blank-env normalization (config), shared in-flight start
 * (daemon), generation-guarded poll loop, and complete()-vs-fail() separation
 * (worker). The atomic-lock fix is covered by the existing stale-reclaim /
 * live-throw cases in lock.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { resolveConfig, DEFAULT_HOST, DEFAULT_PORT } from "../dist/config.js";
import { HiveantennaeWorker, type JobSource } from "../dist/worker.js";
import { PollLoop, type Timer } from "../dist/poll-loop.js";
import { assembleDaemon } from "../dist/index.js";
import {
  loadNectarFileConfig,
  resolveNectarTunables,
  NECTAR_CONFIG_FILE_NAME,
} from "../dist/config-file.js";
import { resolveEnricherConfig, DEFAULT_REDESCRIBE_THRESHOLD } from "../dist/enricher/config.js";
import { resolveRrfMultiplier, DEFAULT_RRF_MULTIPLIER } from "../dist/hive-graph/search.js";
import { evaluateBroodPrereqs, broodPrereqsFromEnv, formatFirstRunGuidance } from "../dist/brood-prereqs.js";
import { loadDeepLakeCredentials } from "../dist/hive-graph/deeplake-credentials.js";

// --- config: blank env vars must fall back to defaults ---

test("blank/whitespace env vars fall back to defaults (not '' -> cwd/invalid bind)", () => {
  try {
    process.env.NECTAR_RUNTIME_DIR = "";
    process.env.NECTAR_HOST = "   ";
    process.env.NECTAR_PORT = "";
    const cfg = resolveConfig();
    assert.equal(cfg.host, DEFAULT_HOST, "blank host -> default loopback");
    assert.equal(cfg.port, DEFAULT_PORT, "blank port -> default");
    assert.notEqual(cfg.runtimeDir, "", "blank runtime dir -> real home dir, not cwd-relative");
    assert.ok(cfg.lockFilePath.includes("nectar.lock"));
  } finally {
    delete process.env.NECTAR_RUNTIME_DIR;
    delete process.env.NECTAR_HOST;
    delete process.env.NECTAR_PORT;
  }
});

test("non-blank env values still apply", () => {
  try {
    process.env.NECTAR_HOST = "0.0.0.0";
    process.env.NECTAR_PORT = "4321";
    const cfg = resolveConfig();
    assert.equal(cfg.host, "0.0.0.0");
    assert.equal(cfg.port, 4321);
  } finally {
    delete process.env.NECTAR_HOST;
    delete process.env.NECTAR_PORT;
  }
});

// --- worker: complete() failure is not a job failure ---

test("a source.complete() failure is NOT reclassified as a job failure", async () => {
  const failed: string[] = [];
  let leased = false;
  const source: JobSource = {
    lease: () => (leased ? null : ((leased = true), { id: "j", kind: "enrich" })),
    complete: () => {
      throw new Error("queue down");
    },
    fail: (_id, reason) => void failed.push(reason),
  };
  const worker = new HiveantennaeWorker({
    source,
    handlers: { enrich: () => {} },
    pollIntervalMs: 1000,
    onError: () => {},
  });
  await assert.rejects(() => worker.runOnce(), /queue down/);
  assert.deepEqual(failed, [], "complete() failure did not trigger source.fail()");
});

// --- poll-loop: generation guard against stop/start races ---

test("a stale in-flight tick does not schedule after stop() + start()", async () => {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const timer: Timer = {
    set(fn) {
      const id = ++nextId;
      timers.set(id, fn);
      return id;
    },
    clear(h) {
      timers.delete(h as number);
    },
  };
  let release: (() => void) | null = null;
  let ticks = 0;
  const loop = new PollLoop({
    floorMs: 10,
    timer,
    tick: () => new Promise<boolean>((res) => { ticks += 1; release = () => res(false); }),
  });

  loop.start();
  assert.equal(timers.size, 1, "one schedule after start");
  // Fire the scheduled timer -> pump(gen1) -> tick in flight (pending).
  const firstId = [...timers.keys()][0] as number;
  const fn = timers.get(firstId);
  timers.delete(firstId);
  fn?.();
  await Promise.resolve();
  assert.equal(ticks, 1, "tick started and is in flight");

  // Stop then start again while the old tick is still pending.
  loop.stop();
  loop.start();
  const schedulesAfterRestart = timers.size;

  // Resolve the stale tick; its pump must see a newer generation and not reschedule.
  release?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, schedulesAfterRestart, "stale pump added no second schedule");
  loop.stop();
});

// --- daemon: concurrent start() shares one startup ---

function getStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
}

test("concurrent start() calls share one startup and return the same bound port", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "nectar-fixes-"));
  const daemon = assembleDaemon({ port: 0, runtimeDir, log: () => {} });
  try {
    const [p1, p2] = await Promise.all([daemon.start(), daemon.start()]);
    assert.equal(p1, p2, "both callers observe the same port");
    assert.ok(p1 > 0);
    assert.equal(await getStatus(p1, "/health"), 200);
  } finally {
    await daemon.shutdown();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

// ── PRD-018k / NEC-041: the ~/.honeycomb/nectar.json config-file loader ─────────

function writeNectarJson(dir: string, body: string): void {
  writeFileSync(join(dir, NECTAR_CONFIG_FILE_NAME), body, "utf8");
}

test("AC-018k.6 the redescribe threshold is sourced from nectar.json when no env var is set; the env var wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-cfg-"));
  try {
    writeNectarJson(dir, JSON.stringify({ redescribe_threshold: 0.42 }));

    // File value, no env: the file's threshold flows through resolveEnricherConfig.
    const fromFile = resolveNectarTunables({ dir, env: {}, warn: () => {} });
    assert.equal(fromFile.redescribeThreshold, 0.42);
    assert.equal(resolveEnricherConfig({}, fromFile).redescribeThreshold, 0.42);

    // Env var present: env wins over the file.
    const fromEnv = resolveNectarTunables({ dir, env: { NECTAR_REDESCRIBE_THRESHOLD: "0.9" }, warn: () => {} });
    assert.equal(fromEnv.redescribeThreshold, 0.9);
    assert.equal(resolveEnricherConfig({}, fromEnv).redescribeThreshold, 0.9);

    // Neither: the signed-off code default stands.
    const none = resolveNectarTunables({ dir: mkdtempSync(join(tmpdir(), "nectar-cfg-empty-")), env: {}, warn: () => {} });
    assert.equal(resolveEnricherConfig({}, none).redescribeThreshold, DEFAULT_REDESCRIBE_THRESHOLD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-018k.7 the recall multiplier is loaded and reaches the recall config surface (env over file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-cfg-"));
  try {
    writeNectarJson(dir, JSON.stringify({ nectar_rrf_multiplier: 2.5 }));
    const fromFile = resolveNectarTunables({ dir, env: {}, warn: () => {} });
    assert.equal(fromFile.recallMultiplier, 2.5);
    // The value reaches the recall path's config surface (search deps).
    assert.equal(resolveRrfMultiplier({ rrfMultiplier: fromFile.recallMultiplier }), 2.5);

    const fromEnv = resolveNectarTunables({ dir, env: { NECTAR_RECALL_MULTIPLIER: "3" }, warn: () => {} });
    assert.equal(fromEnv.recallMultiplier, 3);

    // A missing/invalid multiplier falls back to the neutral default at the surface.
    assert.equal(resolveRrfMultiplier({}), DEFAULT_RRF_MULTIPLIER);
    assert.equal(resolveRrfMultiplier({ rrfMultiplier: 0 }), DEFAULT_RRF_MULTIPLIER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-018k.8 a malformed nectar.json warns and falls back to env/defaults without crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-cfg-"));
  try {
    writeNectarJson(dir, "{ this is not valid json ");
    const warnings: string[] = [];
    const cfg = loadNectarFileConfig({ dir, warn: (m) => warnings.push(m) });
    assert.deepEqual(cfg, {}, "a malformed file yields no configured tunables");
    assert.ok(warnings.some((w) => w.includes("malformed")), "a warning is logged for the malformed file");
    // Resolution still succeeds and the enricher default stands.
    const tunables = resolveNectarTunables({ dir, env: {}, warn: () => {} });
    assert.equal(resolveEnricherConfig({}, tunables).redescribeThreshold, DEFAULT_REDESCRIBE_THRESHOLD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-018k.9 an unknown key in nectar.json is ignored with a warning; known keys still load", () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-cfg-"));
  try {
    writeNectarJson(dir, JSON.stringify({ redescribe_threshold: 0.5, made_up_key: 123 }));
    const warnings: string[] = [];
    const cfg = loadNectarFileConfig({ dir, warn: (m) => warnings.push(m) });
    assert.equal(cfg.redescribeThreshold, 0.5, "the known key still loads");
    assert.equal((cfg as Record<string, unknown>).made_up_key, undefined, "the unknown key is not carried");
    assert.ok(warnings.some((w) => w.includes("unknown key") && w.includes("made_up_key")), "the unknown key is warned about");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── PRD-018k / NEC-023: brood prerequisite evaluation + guided first-run ────────

test("AC-018k.1/.2 evaluateBroodPrereqs names each missing prerequisite with a machine-readable reason", () => {
  const credPath = "/home/dev/.deeplake/credentials.json";
  const noCreds = evaluateBroodPrereqs({
    credentialsPresent: false,
    credentialsPath: credPath,
    portkeyEnabled: false,
    portkeyApiKeySet: false,
    portkeyConfigSet: false,
  });
  assert.equal(noCreds.ready, false);
  assert.equal(noCreds.reason, "credentials_missing");
  assert.ok(noCreds.missing.some((m) => m.includes(credPath)), "names the credentials file");
  assert.ok(noCreds.missing.includes("NECTAR_PORTKEY_ENABLED"));

  const onlyApiKeyMissing = evaluateBroodPrereqs({
    credentialsPresent: true,
    credentialsPath: credPath,
    portkeyEnabled: true,
    portkeyApiKeySet: false,
    portkeyConfigSet: true,
  });
  assert.equal(onlyApiKeyMissing.reason, "portkey_disabled");
  assert.deepEqual(onlyApiKeyMissing.missing, ["NECTAR_PORTKEY_API_KEY"]);

  const ready = evaluateBroodPrereqs({
    credentialsPresent: true,
    credentialsPath: credPath,
    portkeyEnabled: true,
    portkeyApiKeySet: true,
    portkeyConfigSet: true,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, null);
  assert.deepEqual(ready.missing, []);
});

test("AC-018k.2 broodPrereqsFromEnv reads the three NECTAR_PORTKEY_* flags", () => {
  const status = broodPrereqsFromEnv({
    credentialsPresent: true,
    credentialsPath: "/x/credentials.json",
    env: { NECTAR_PORTKEY_ENABLED: "1", NECTAR_PORTKEY_API_KEY: "  ", NECTAR_PORTKEY_CONFIG: "cfg" },
  });
  assert.equal(status.ready, false, "a blank API key counts as unset");
  assert.deepEqual(status.missing, ["NECTAR_PORTKEY_API_KEY"]);
});

test("AC-018k.5 formatFirstRunGuidance prints the exact configuration steps when dormant, nothing when ready", () => {
  const dormant = evaluateBroodPrereqs({
    credentialsPresent: false,
    credentialsPath: "/x/credentials.json",
    portkeyEnabled: false,
    portkeyApiKeySet: false,
    portkeyConfigSet: false,
  });
  const guidance = formatFirstRunGuidance(dormant);
  assert.ok(guidance.includes("NECTAR_PORTKEY_ENABLED=1"), "the guided steps include the exact env exports");
  assert.ok(guidance.includes("NECTAR_PORTKEY_API_KEY"));
  assert.ok(guidance.includes("credentials.json"), "the credentials step is present when creds are missing");

  const ready = evaluateBroodPrereqs({
    credentialsPresent: true,
    credentialsPath: "/x/credentials.json",
    portkeyEnabled: true,
    portkeyApiKeySet: true,
    portkeyConfigSet: true,
  });
  assert.equal(formatFirstRunGuidance(ready), "", "no guidance when the prerequisites are satisfied");
});

// ── PRD-018l / NEC-042 item 13: credentials permission-mode advisory ───────────

test("AC-018l.20 a group/other-readable credentials file warns naming the mode; 0600 loads silently (POSIX)", { skip: process.platform === "win32" ? "POSIX-only permission test" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nectar-creds-"));
  try {
    const path = join(dir, "credentials.json");
    writeFileSync(path, JSON.stringify({ token: "t", orgId: "o", workspaceId: "w" }), "utf8");

    // 0644: group/other-readable -> a warning that names the octal mode.
    chmodSync(path, 0o644);
    const looseWarnings: string[] = [];
    loadDeepLakeCredentials({ dir, warn: (m) => looseWarnings.push(m) });
    assert.ok(looseWarnings.length >= 1, "a warning is emitted for a world-readable token file");
    assert.ok(looseWarnings[0]?.includes("0644"), "the warning names the file mode");

    // 0600: owner-only -> silent.
    chmodSync(path, 0o600);
    const tightWarnings: string[] = [];
    loadDeepLakeCredentials({ dir, warn: (m) => tightWarnings.push(m) });
    assert.equal(tightWarnings.length, 0, "an owner-only token file loads without a permission warning");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
