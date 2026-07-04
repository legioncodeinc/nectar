/**
 * PRD-019b: the nectar-owned brooding-state store. Hermetic - every test points
 * the store at a temp dir under `os.tmpdir()` via the `dir` override, NEVER the
 * real user home. Runs against the compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROODING_STATE_FILE_NAME,
  defaultBroodingState,
  effectiveBrooding,
  loadBroodingState,
  writeBroodingState,
  withGlobalBrooding,
  withProjectBrooding,
} from "../dist/registration/brooding-state.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-brooding-"));
}

test("b-AC-1 a missing file (and missing dir) reads as defaults: global on, a new project defaults to on; the first write creates the dir", () => {
  const parent = tempDir();
  try {
    const dir = join(parent, "does-not-exist-yet"); // not created
    const state = loadBroodingState({ dir });
    assert.equal(state.globalBrooding, "on", "global defaults to on");
    assert.equal(effectiveBrooding(state, "proj-x"), "active", "a newly-seen project defaults to on -> active");
    assert.equal(existsSync(dir), false, "loading never creates the dir");

    // First write creates the dir + file.
    writeBroodingState(withProjectBrooding(state, "proj-x", "on"), { dir });
    assert.equal(existsSync(join(dir, BROODING_STATE_FILE_NAME)), true, "the first write creates the file (and its dir)");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("b-AC-2 a malformed / non-object file warns and falls back to defaults (never throws)", () => {
  const dir = tempDir();
  try {
    const warnings: string[] = [];
    writeFileSync(join(dir, BROODING_STATE_FILE_NAME), "{ not json", "utf8");
    const malformed = loadBroodingState({ dir, warn: (m) => warnings.push(m) });
    assert.deepEqual(malformed, defaultBroodingState(), "malformed JSON -> defaults");
    assert.ok(warnings.length >= 1, "a warning was emitted");

    writeFileSync(join(dir, BROODING_STATE_FILE_NAME), JSON.stringify([1, 2, 3]), "utf8");
    const nonObject = loadBroodingState({ dir, warn: () => {} });
    assert.deepEqual(nonObject, defaultBroodingState(), "a non-object payload -> defaults");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown top-level keys and malformed per-project values warn and are skipped (forward compatibility)", () => {
  const dir = tempDir();
  try {
    const warnings: string[] = [];
    writeFileSync(
      join(dir, BROODING_STATE_FILE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        globalBrooding: "paused",
        futureKey: { anything: true },
        projects: { good: { brooding: "off" }, bad: { brooding: "maybe" }, junk: 7 },
      }),
      "utf8",
    );
    const state = loadBroodingState({ dir, warn: (m) => warnings.push(m) });
    assert.equal(state.globalBrooding, "paused");
    assert.equal(state.projects["good"], "off", "a valid project survives");
    assert.equal(state.projects["bad"], undefined, "an invalid brooding value is skipped");
    assert.equal(state.projects["junk"], undefined, "a malformed project entry is skipped");
    assert.ok(warnings.some((w) => w.includes("futureKey")), "the unknown key is warned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectiveBrooding: global pause beats a per-project on; a per-project off pauses; else active", () => {
  const base = defaultBroodingState();
  assert.equal(effectiveBrooding(base, "p"), "active");
  assert.equal(effectiveBrooding(withProjectBrooding(base, "p", "off"), "p"), "paused");
  const paused = withGlobalBrooding(withProjectBrooding(base, "p", "on"), "paused");
  assert.equal(effectiveBrooding(paused, "p"), "global-paused", "global pause wins over per-project on");
});

test("b-AC-6 an atomic write round-trips; a write to an unwritable location throws so the caller can preserve prior state", () => {
  const dir = tempDir();
  try {
    const next = withProjectBrooding(withGlobalBrooding(defaultBroodingState(), "on"), "p1", "off");
    writeBroodingState(next, { dir });
    const reloaded = loadBroodingState({ dir });
    assert.equal(reloaded.projects["p1"], "off", "the write round-trips");
    assert.equal(reloaded.globalBrooding, "on");
    // The on-disk shape carries the per-project { brooding } object form.
    const raw = JSON.parse(readFileSync(join(dir, BROODING_STATE_FILE_NAME), "utf8"));
    assert.deepEqual(raw.projects.p1, { brooding: "off" });
    assert.equal(raw.schemaVersion, 1);

    // A write whose parent path is a FILE (not a dir) fails hard (mkdir throws),
    // so the toggle API surfaces a 500 and preserves the prior state.
    const filePath = join(dir, "as-a-file");
    writeFileSync(filePath, "x", "utf8");
    assert.throws(() => writeBroodingState(next, { dir: join(filePath, "nested") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
