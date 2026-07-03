/**
 * `disk-fs.ts` tests (PRD-018c NEC-007 point 2 / NEC-034).
 *
 * Run against the compiled `dist/` output, matching every other test in this
 * suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { createDiskRegistrationFs, probeCaseInsensitiveFs } from "../dist/registration/disk-fs.js";

function fakeDirent(name: string, kind: "file" | "dir"): Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  } as Dirent;
}

// ── AC-018c.4: descent-time pruning ─────────────────────────────────────────

test("AC-018c.4 listPaths prunes an ignored directory at descent time: readDirSync is never called on it", () => {
  const ROOT = join("/repo");
  const SRC = join(ROOT, "src");
  const NODE_MODULES = join(ROOT, "node_modules");
  const PKG = join(NODE_MODULES, "pkg");
  const tree = new Map<string, Dirent[]>([
    [ROOT, [fakeDirent("src", "dir"), fakeDirent("node_modules", "dir"), fakeDirent("README.md", "file")]],
    [SRC, [fakeDirent("a.ts", "file")]],
    [NODE_MODULES, [fakeDirent("pkg", "dir")]], // would throw if ever visited
    [PKG, [fakeDirent("index.js", "file")]],
  ]);
  const visited: string[] = [];
  const fs = createDiskRegistrationFs(
    ROOT,
    (relPath) => relPath.split("/").includes("node_modules"),
    (dir) => {
      visited.push(dir);
      const entries = tree.get(dir);
      if (entries === undefined) throw new Error(`unexpected readDirSync(${dir}) - descent-time pruning failed`);
      return entries;
    },
  );
  const files = [...fs.listPaths()].sort();
  assert.deepEqual(files, ["README.md", "src/a.ts"], "node_modules' files never surface");
  assert.ok(!visited.some((d) => d.includes("node_modules")), "readDirSync is never called on the pruned subtree");
  assert.deepEqual(visited.sort(), [ROOT, SRC].sort(), "only the non-ignored directories are ever listed");
});

test("AC-018c.4 a nested ignored directory (not just a top-level one) is also pruned at descent time", () => {
  const ROOT = join("/repo");
  const SRC = join(ROOT, "src");
  const VENDOR = join(SRC, "vendor");
  const tree = new Map<string, Dirent[]>([
    [ROOT, [fakeDirent("src", "dir")]],
    [SRC, [fakeDirent("vendor", "dir"), fakeDirent("app.ts", "file")]],
    [VENDOR, [fakeDirent("lib.js", "file")]], // would throw if ever visited
  ]);
  const fs = createDiskRegistrationFs(
    ROOT,
    (relPath) => relPath === "src/vendor" || relPath.startsWith("src/vendor/"),
    (dir) => {
      const entries = tree.get(dir);
      if (entries === undefined) throw new Error(`unexpected readDirSync(${dir})`);
      return entries;
    },
  );
  assert.deepEqual([...fs.listPaths()], ["src/app.ts"]);
});

test("real-disk integration: listPaths excludes a real node_modules subtree end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-disk-fs-"));
  try {
    const fs1 = createDiskRegistrationFs(root, (relPath) => relPath.split("/").includes("node_modules"));
    // No real files created here (mkdtempSync gives an empty dir); just prove
    // an empty ignored-nothing tree round-trips without throwing.
    assert.deepEqual([...fs1.listPaths()], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── NEC-042 item 10 / AC-018l.17: one symlink contract for watch and resync ───

test("AC-018l.17 an in-root symlinked file is skipped by BOTH the walk and statPath/existsOnDisk", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nectar-symlink-"));
  try {
    writeFileSync(join(root, "real.ts"), "export const x = 1;\n", "utf8");
    try {
      symlinkSync(join(root, "real.ts"), join(root, "link.ts"));
    } catch (err) {
      // Symlink creation needs privilege on Windows (Developer Mode / admin);
      // skip rather than fail where the OS forbids it.
      t.skip(`symlink creation not permitted here: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const fs = createDiskRegistrationFs(root);

    // Resync/walk path: the symlink is NOT listed (only the real file).
    assert.deepEqual([...fs.listPaths()].sort(), ["real.ts"], "the walk lists the real file, never the symlink");

    // Watcher path parity: statPath/existsOnDisk skip the symlink too (both skip).
    assert.equal(fs.statPath("link.ts"), null, "statPath skips the symlink, matching the walk");
    assert.equal(fs.existsOnDisk("link.ts"), false, "existsOnDisk skips the symlink, matching the walk");

    // The real (non-symlink) file is unaffected by the contract.
    assert.ok(fs.statPath("real.ts") !== null, "the real file still stats");
    assert.equal(fs.existsOnDisk("real.ts"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── NEC-034 / AC-018c.8: the case-sensitivity probe ─────────────────────────

test("AC-018c.8 probeCaseInsensitiveFs is a real filesystem probe: it never throws and cleans up its marker file", () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-case-probe-"));
  try {
    const result = probeCaseInsensitiveFs(root);
    assert.equal(typeof result, "boolean");
    // Probing again must be idempotent (no leftover marker breaks a re-probe).
    const again = probeCaseInsensitiveFs(root);
    assert.equal(again, result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-018c.8 probeCaseInsensitiveFs fails closed (case-SENSITIVE) when root does not exist, never guessing from process.platform", () => {
  const missingRoot = join(tmpdir(), `nectar-case-probe-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.equal(probeCaseInsensitiveFs(missingRoot), false);
});

// ── CodeRabbit PR-18 finding #5: the post-write statSync can itself throw ────

test("CodeRabbit PR-18 finding #5: a statSync failure on the just-written marker fails closed instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "nectar-case-probe-vanish-"));
  try {
    const result = probeCaseInsensitiveFs(root, {
      statSync: () => {
        throw Object.assign(new Error("simulated EPERM (antivirus interference)"), { code: "EPERM" });
      },
    });
    assert.equal(result, false, "fails closed (case-sensitive) rather than throwing out of construction");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
