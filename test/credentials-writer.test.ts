/**
 * PRD-003a a-AC-5: `saveDeepLakeCredentials` writes the shared
 * `~/.deeplake/credentials.json` in a shape byte-compatible with honeycomb's
 * DiskCredentials, at owner-only permissions, with a server-stamped `savedAt`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveDeepLakeCredentials,
  loadDeepLakeCredentials,
  CREDENTIALS_FILE_MODE,
  CREDENTIALS_DIR_MODE,
} from "../dist/hive-graph/deeplake-credentials.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-creds-"));
}

test("a-AC-5 saveDeepLakeCredentials writes the honeycomb DiskCredentials shape, readable by loadDeepLakeCredentials", () => {
  const dir = tmpDir();
  try {
    const saved = saveDeepLakeCredentials(
      {
        token: "tok-abc",
        orgId: "org-1",
        orgName: "Org One",
        userName: "Ada",
        workspaceId: "ws-1",
        apiUrl: "https://api.deeplake.ai",
        savedAt: "IGNORED",
      },
      { dir, clock: { now: () => "2026-07-04T12:00:00.000Z" } },
    );
    assert.equal(saved.savedAt, "2026-07-04T12:00:00.000Z", "savedAt is stamped server-side, ignoring the input");

    const onDisk = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    assert.deepEqual(onDisk, {
      token: "tok-abc",
      orgId: "org-1",
      orgName: "Org One",
      userName: "Ada",
      workspaceId: "ws-1",
      apiUrl: "https://api.deeplake.ai",
      savedAt: "2026-07-04T12:00:00.000Z",
    });

    const loaded = loadDeepLakeCredentials({ dir });
    assert.equal(loaded.token, "tok-abc");
    assert.equal(loaded.orgId, "org-1");
    assert.equal(loaded.workspaceId, "ws-1");
    assert.equal(loaded.apiUrl, "https://api.deeplake.ai");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-5 the credentials file is written owner-only on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir();
  try {
    saveDeepLakeCredentials({ token: "t", orgId: "o", workspaceId: "w", savedAt: "" }, { dir });
    const mode = statSync(join(dir, "credentials.json")).mode & 0o777;
    assert.equal(mode, CREDENTIALS_FILE_MODE, "the token file is 0600 (owner read/write only)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a-AC-5 a freshly-created credentials directory is 0700 and its file is 0600, on POSIX",
  { skip: process.platform === "win32" },
  () => {
    const base = tmpDir();
    try {
      // Use a NOT-YET-EXISTING subdirectory so saveDeepLakeCredentials's
      // mkdirSync actually runs (the shared tmpDir() helper pre-creates the
      // dir itself, which would skip the mkdirSync branch entirely).
      const dir = join(base, "fresh", ".deeplake");
      assert.equal(existsSync(dir), false, "the dir must not exist yet for the mkdirSync(mode) path to be exercised");

      saveDeepLakeCredentials({ token: "t", orgId: "o", workspaceId: "w", savedAt: "" }, { dir });

      const dirMode = statSync(dir).mode & 0o777;
      assert.equal(dirMode, CREDENTIALS_DIR_MODE, "the credentials dir is created at 0700 (owner rwx only)");
      const fileMode = statSync(join(dir, "credentials.json")).mode & 0o777;
      assert.equal(fileMode, CREDENTIALS_FILE_MODE, "the credentials file is 0600 (owner rw only)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
