/**
 * Single-instance PID/lock guard for the hivenectar daemon.
 *
 * Mirrors honeycomb's `acquireSingleInstanceLock` / `releaseSingleInstanceLock`
 * (honeycomb/src/daemon/runtime/assemble.ts:715-756) per PRD-002d:
 *   - a second start with a live recorded PID throws before the socket bind,
 *   - a stale lock (dead PID) is reclaimed so a crashed daemon never wedges the
 *     next start,
 *   - the lock file is the guard; the PID file is operator-facing convenience
 *     (`cat ~/.honeycomb/hivenectar.pid`).
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { DaemonAlreadyRunningError } from "./errors.js";

/**
 * Probe whether a PID is alive via signal 0.
 *   - `ESRCH` -> no such process (stale),
 *   - `EPERM` -> alive but owned by another user (treated as alive),
 *   - success -> alive.
 * Mirrors honeycomb's `isPidAlive` (assemble.ts:692-705).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // alive, different user
    return false; // ESRCH or anything else -> not alive
  }
}

/** Read the PID from a lock/pid file; absent/unreadable/garbage returns null. */
export function readPidFile(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "") return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface LockPaths {
  readonly lockFilePath: string;
  readonly pidFilePath: string;
}

/**
 * Acquire the single-instance lock. Called BEFORE the socket bind (PRD-002a).
 * Throws `DaemonAlreadyRunningError` if a live daemon already holds the lock;
 * reclaims a stale lock otherwise. Stamps this process's PID into both files.
 */
export function acquireSingleInstanceLock(paths: LockPaths): void {
  mkdirSync(dirname(paths.lockFilePath), { recursive: true });
  const pid = String(process.pid);

  // Acquire the lock via an atomic exclusive-create ("wx"), so two concurrent
  // launches cannot both win the read-then-write race. If the lock already
  // exists, reclaim it only when its recorded PID is dead, then retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(paths.lockFilePath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existingPid = readPidFile(paths.lockFilePath);
      if (existingPid !== null && isPidAlive(existingPid)) {
        throw new DaemonAlreadyRunningError(existingPid, paths.lockFilePath);
      }
      // Stale lock (dead or unreadable PID): drop it and retry the exclusive create.
      rmSync(paths.lockFilePath, { force: true });
      continue;
    }

    try {
      writeSync(fd, pid);
    } finally {
      closeSync(fd);
    }

    // Write the operator-facing PID file; on failure, roll the lock back so a
    // partial acquisition never leaves a stale lock wedging the next start.
    try {
      writeFileSync(paths.pidFilePath, pid, "utf8");
    } catch (err) {
      rmSync(paths.lockFilePath, { force: true });
      throw err;
    }
    return;
  }

  // Both attempts lost to a live lock created between our checks.
  const racedPid = readPidFile(paths.lockFilePath);
  throw new DaemonAlreadyRunningError(racedPid ?? -1, paths.lockFilePath);
}

/**
 * Release the lock: remove both files. Never throws (a missing lock on shutdown
 * is fine, the goal already holds). Mirrors `releaseSingleInstanceLock`.
 */
export function releaseSingleInstanceLock(paths: LockPaths): void {
  rmSync(paths.lockFilePath, { force: true });
  rmSync(paths.pidFilePath, { force: true });
}

/** True if a live daemon currently holds this lock (used by health/status). */
export function isLockHeldByLiveDaemon(lockFilePath: string): boolean {
  if (!existsSync(lockFilePath)) return false;
  const pid = readPidFile(lockFilePath);
  return pid !== null && isPidAlive(pid);
}
