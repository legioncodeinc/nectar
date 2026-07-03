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
  readLockIdentity,
  isLockHeldByLiveDaemon,
} from "../dist/lock.js";
import { DaemonAlreadyRunningError } from "../dist/errors.js";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "nectar-lock-"));
  return {
    dir,
    lockFilePath: join(dir, "nectar.lock"),
    pidFilePath: join(dir, "nectar.pid"),
  };
}

test("acquire records a JSON identity in the lock file and a bare pid in the pid file", () => {
  const p = tmpPaths();
  try {
    const identity = acquireSingleInstanceLock(p);
    assert.ok(existsSync(p.lockFilePath), "lock file exists");
    assert.ok(existsSync(p.pidFilePath), "pid file exists");
    // The lock file carries the full identity (pid + boot + token).
    const recorded = readLockIdentity(p.lockFilePath);
    assert.equal(recorded?.pid, process.pid);
    assert.equal(recorded?.token, identity.token, "the lock records the identity acquire returned");
    assert.ok(typeof recorded?.boot === "number", "the lock records a boot time");
    // The pid file stays a bare pid for operator/doctor consumption.
    assert.equal(readFileSync(p.pidFilePath, "utf8"), String(process.pid));
    assert.equal(readPidFile(p.pidFilePath), process.pid);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("second acquire with a live recorded identity throws DaemonAlreadyRunningError", () => {
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
    // Stamp a PID that is almost certainly dead (legacy bare-pid lock form).
    const deadPid = 2_147_483_600;
    assert.equal(isPidAlive(deadPid), false);
    writeFileSync(p.lockFilePath, String(deadPid), "utf8");
    const identity = acquireSingleInstanceLock(p);
    assert.equal(readLockIdentity(p.lockFilePath)?.pid, process.pid, "lock reclaimed by us");
    assert.equal(readLockIdentity(p.lockFilePath)?.token, identity.token);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

// ── CodeRabbit PR-18 finding #2: a present-but-corrupt lock is reclaimed ──────

test("a present-but-empty lock file is reclaimed instead of wedging every future acquire", () => {
  const p = tmpPaths();
  try {
    // Present, but empty: readLockIdentity returns null for this the same way
    // it does for "the file is gone" - the pre-fix reclaimStaleLock treated
    // both as "already gone" and never removed it, so the daemon could never
    // start again without a manual `rm`.
    writeFileSync(p.lockFilePath, "", "utf8");
    const identity = acquireSingleInstanceLock(p);
    assert.equal(readLockIdentity(p.lockFilePath)?.token, identity.token, "the corrupt lock was reclaimed, not wedged");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("a present-but-garbage (non-JSON, non-numeric) lock file is also reclaimed", () => {
  const p = tmpPaths();
  try {
    writeFileSync(p.lockFilePath, "{not valid json at all", "utf8");
    const identity = acquireSingleInstanceLock(p);
    assert.equal(readLockIdentity(p.lockFilePath)?.token, identity.token);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

// ── CodeRabbit PR-18 finding #2: a writeSync failure rolls back, no half-written lock left behind ──

test("a writeSync failure while writing the lock body rolls back and leaves no half-written lock behind", () => {
  const p = tmpPaths();
  try {
    assert.throws(
      () =>
        acquireSingleInstanceLock(p, {
          writeLockBody: () => {
            throw new Error("simulated disk-full while writing the lock body");
          },
        }),
      /simulated disk-full/,
    );
    assert.equal(existsSync(p.lockFilePath), false, "the half-written lock file was rolled back, not left behind");

    // With the write path healthy again, a fresh acquire against the same
    // paths must succeed cleanly (nothing corrupt was left wedging it).
    const identity = acquireSingleInstanceLock(p);
    assert.ok(identity.token.length > 0);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

// ── AC-018a.5: PID reuse (live-but-foreign identity) is reclaimed, not wedged ──

test("AC-018a.5 a lock recording a live pid from a prior boot is reclaimed instead of wedging startup", () => {
  const p = tmpPaths();
  try {
    // A live pid (this process) but a boot time from the distant past (epoch 1s):
    // a reused pid after a crash/reboot. It must read as stale, not "already running".
    writeFileSync(
      p.lockFilePath,
      JSON.stringify({ pid: process.pid, boot: 1, token: "pre-reboot" }),
      "utf8",
    );
    assert.equal(isPidAlive(process.pid), true, "the recorded pid is genuinely alive");
    const identity = acquireSingleInstanceLock(p);
    assert.equal(readLockIdentity(p.lockFilePath)?.token, identity.token, "the stale lock was reclaimed");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

// ── AC-018a.4: reclaim is atomic; the loser never removes the winner's lock ────

test("AC-018a.4 after one process reclaims a stale lock, a second attempt fails without removing the winner's lock", () => {
  const p = tmpPaths();
  try {
    // A stale lock two racers both observe. The first reclaims and wins.
    writeFileSync(
      p.lockFilePath,
      JSON.stringify({ pid: 2_147_483_600, boot: 1, token: "stale" }),
      "utf8",
    );
    const winner = acquireSingleInstanceLock(p);
    assert.equal(readLockIdentity(p.lockFilePath)?.token, winner.token, "winner holds the lock");

    // The loser reacts to the same stale lock but now sees the live winner.
    assert.throws(() => acquireSingleInstanceLock(p), DaemonAlreadyRunningError);
    assert.equal(
      readLockIdentity(p.lockFilePath)?.token,
      winner.token,
      "the loser's failed reclaim did NOT delete the winner's fresh lock",
    );
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("release removes both files and never throws when absent", () => {
  const p = tmpPaths();
  try {
    const identity = acquireSingleInstanceLock(p);
    releaseSingleInstanceLock(p, identity);
    assert.equal(existsSync(p.lockFilePath), false);
    assert.equal(existsSync(p.pidFilePath), false);
    // Second release is a no-op, not a throw.
    releaseSingleInstanceLock(p, identity);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

// ── AC-018a.3: release by a non-owner is a no-op ──────────────────────────────

test("AC-018a.3 releasing a lock owned by a different identity removes neither the lock nor the pid file", () => {
  const p = tmpPaths();
  try {
    // A lock + pid owned by some other live identity (a different token).
    writeFileSync(
      p.lockFilePath,
      JSON.stringify({ pid: process.pid, boot: 1, token: "not-ours" }),
      "utf8",
    );
    writeFileSync(p.pidFilePath, String(process.pid), "utf8");

    // A process that does NOT own the lock (a different token) calls release.
    releaseSingleInstanceLock(p, { pid: process.pid, boot: 1, token: "mine" });

    assert.ok(existsSync(p.lockFilePath), "the foreign lock is untouched");
    assert.ok(existsSync(p.pidFilePath), "the foreign pid file is untouched");
    assert.equal(readLockIdentity(p.lockFilePath)?.token, "not-ours");
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
    const identity = acquireSingleInstanceLock(p);
    assert.equal(isLockHeldByLiveDaemon(p.lockFilePath), true, "held by us (live)");
    releaseSingleInstanceLock(p, identity);
    assert.equal(isLockHeldByLiveDaemon(p.lockFilePath), false, "released");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
