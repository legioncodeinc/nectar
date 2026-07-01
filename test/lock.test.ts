import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  isPidAlive,
  readPidFile,
  isLockHeldByLiveDaemon,
} from "../dist/lock.js";
import { DaemonAlreadyRunningError } from "../dist/errors.js";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "hivenectar-lock-"));
  return {
    dir,
    lockFilePath: join(dir, "hivenectar.lock"),
    pidFilePath: join(dir, "hivenectar.pid"),
  };
}

test("acquire writes pid + lock files with this process's pid", () => {
  const p = tmpPaths();
  try {
    acquireSingleInstanceLock(p);
    assert.ok(existsSync(p.lockFilePath), "lock file exists");
    assert.ok(existsSync(p.pidFilePath), "pid file exists");
    assert.equal(readFileSync(p.lockFilePath, "utf8"), String(process.pid));
    assert.equal(readPidFile(p.pidFilePath), process.pid);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("second acquire with a live recorded pid throws DaemonAlreadyRunningError", () => {
  const p = tmpPaths();
  try {
    acquireSingleInstanceLock(p);
    assert.throws(
      () => acquireSingleInstanceLock(p),
      (err: unknown) => {
        assert.ok(err instanceof DaemonAlreadyRunningError);
        assert.equal(err.existingPid, process.pid);
        return true;
      },
    );
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("a stale lock (dead pid) is reclaimed", () => {
  const p = tmpPaths();
  try {
    // Stamp a PID that is almost certainly dead.
    const deadPid = 2_147_483_600;
    assert.equal(isPidAlive(deadPid), false);
    // Write the stale lock manually, then acquire should reclaim it.
    writeFileSync(p.lockFilePath, String(deadPid), "utf8");
    acquireSingleInstanceLock(p);
    assert.equal(readPidFile(p.lockFilePath), process.pid, "lock reclaimed by us");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("release removes both files and never throws when absent", () => {
  const p = tmpPaths();
  try {
    acquireSingleInstanceLock(p);
    releaseSingleInstanceLock(p);
    assert.equal(existsSync(p.lockFilePath), false);
    assert.equal(existsSync(p.pidFilePath), false);
    // Second release is a no-op, not a throw.
    releaseSingleInstanceLock(p);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("isPidAlive true for current process, false for garbage", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
});

test("isLockHeldByLiveDaemon reflects a live holder", () => {
  const p = tmpPaths();
  try {
    assert.equal(isLockHeldByLiveDaemon(p.lockFilePath), false, "no lock yet");
    acquireSingleInstanceLock(p);
    assert.equal(isLockHeldByLiveDaemon(p.lockFilePath), true, "held by us (live)");
    releaseSingleInstanceLock(p);
    assert.equal(isLockHeldByLiveDaemon(p.lockFilePath), false, "released");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
