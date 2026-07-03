/**
 * Single-instance PID/lock guard for the nectar daemon.
 *
 * Mirrors honeycomb's `acquireSingleInstanceLock` / `releaseSingleInstanceLock`
 * (honeycomb/src/daemon/runtime/assemble.ts:715-756) per PRD-002d, hardened by
 * PRD-018a against the three lock defects the daemon-api review found:
 *   - a second start with a LIVE recorded identity throws before the socket bind,
 *   - a stale lock (dead owner, or an owner from a prior boot) is reclaimed so a
 *     crashed daemon never wedges the next start,
 *   - reclaim is ATOMIC: a concurrent reclaimer can never delete the winner's
 *     fresh lock (the unconditional `rmSync` at the old `lock.ts:84` is gone),
 *   - release is OWNERSHIP-CHECKED: a process only ever removes a lock it holds,
 *   - the lock records a stronger identity than a bare pid (pid + machine boot
 *     time + a random token), so a REUSED pid after a crash/reboot is recognized
 *     as stale instead of masquerading as a live daemon (NEC-020).
 *
 * The lock file is the guard and carries the JSON identity; the pid file stays a
 * bare pid for operator convenience (`cat ~/.honeycomb/nectar.pid`) and doctor
 * supervision (`doctor-registry.ts` `pidPath`).
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DaemonAlreadyRunningError } from "./errors.js";

/** How many exclusive-create attempts an acquire makes before conceding to a live holder. */
const MAX_ACQUIRE_ATTEMPTS = 5;

/**
 * Tolerance (seconds) when comparing a recorded boot time against the current
 * one. `Date.now()` and `os.uptime()` are sampled a few milliseconds apart, so a
 * live lock written this boot can read back a second off; a real reboot moves
 * the boot time by minutes or more, so a small window cleanly separates the two.
 */
const BOOT_TOLERANCE_SEC = 5;

/**
 * The identity a live daemon stamps into its lock file. `pid` alone is not
 * enough (it is reused after death); `boot` distinguishes a pre-crash/pre-reboot
 * pid from a live one, and `token` is a per-acquire nonce used for a precise
 * ownership check on release. `boot`/`token` are optional only so a legacy
 * bare-pid lock still parses (see {@link readLockIdentity}).
 */
export interface LockIdentity {
  readonly pid: number;
  readonly boot?: number;
  readonly token?: string;
}

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

/** The current machine boot time as whole epoch seconds (stable across quick reads). */
function currentBoot(): number {
  return Math.floor(Date.now() / 1000 - uptime());
}

/** Two boot timestamps refer to the same boot when they are within the sampling tolerance. */
function sameBoot(a: number, b: number): boolean {
  return Math.abs(a - b) <= BOOT_TOLERANCE_SEC;
}

/**
 * Read and parse the identity a lock file records. Accepts the current JSON
 * shape and, for backward compatibility, a legacy bare-pid file (interpreted as
 * a pid-only identity). Absent / unreadable / unparseable returns null.
 */
export function readLockIdentity(path: string): LockIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (raw === "") return null;

  // Legacy bare-pid lock (honeycomb-style): pid is the only identity available.
  if (/^\d+$/.test(raw)) {
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  const pid = typeof rec["pid"] === "number" ? rec["pid"] : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const boot = typeof rec["boot"] === "number" ? rec["boot"] : undefined;
  const token = typeof rec["token"] === "string" ? rec["token"] : undefined;
  return {
    pid,
    ...(boot !== undefined ? { boot } : {}),
    ...(token !== undefined ? { token } : {}),
  };
}

/**
 * True when the recorded identity plausibly belongs to a LIVE nectar daemon: its
 * pid is alive AND (when the lock records a boot time) it was written this boot.
 * A live-but-foreign pid from a prior boot (PID reuse) fails the boot check and
 * is therefore reclaimable rather than a permanent wedge (NEC-020).
 */
function isLockOwnerLive(id: LockIdentity): boolean {
  if (!isPidAlive(id.pid)) return false;
  if (id.boot === undefined) return true; // legacy pid-only lock: pid liveness is all we have
  return sameBoot(id.boot, currentBoot());
}

/** Two identities are the same lock when their tokens match (or, legacy, their pid+boot). */
function sameIdentity(a: LockIdentity, b: LockIdentity): boolean {
  if (a.token !== undefined && b.token !== undefined) return a.token === b.token;
  return a.pid === b.pid && a.boot === b.boot;
}

export interface LockPaths {
  readonly lockFilePath: string;
  readonly pidFilePath: string;
}

/** Test/wiring seam: override the identity an acquire stamps (defaults to this live process). */
export interface AcquireOptions {
  readonly pid?: number;
  readonly boot?: number;
  readonly token?: string;
}

/**
 * Reclaim a stale lock atomically. Re-reads the lock immediately before removing
 * it and removes it ONLY if it still holds the same stale content we decided to
 * reclaim. If a concurrent reclaimer already replaced it (content changed, or the
 * file is gone), this is a no-op: the caller's next exclusive-create attempt
 * re-evaluates the fresh content and correctly sees a live owner. This is what
 * makes two racing reclaims yield exactly one winner without the loser deleting
 * the winner's lock (NEC-020 / the old unconditional `rmSync`).
 */
function reclaimStaleLock(lockFilePath: string, expected: LockIdentity | null): void {
  const current = readLockIdentity(lockFilePath);
  if (current === null) return; // already gone; the retry loop re-creates it
  if (expected !== null && !sameIdentity(current, expected)) return; // changed under us
  if (isLockOwnerLive(current)) return; // became live under us; loop re-evaluates
  rmSync(lockFilePath, { force: true });
}

/**
 * Acquire the single-instance lock. Called BEFORE the socket bind (PRD-002a).
 * Throws `DaemonAlreadyRunningError` if a LIVE daemon already holds the lock;
 * atomically reclaims a stale lock otherwise. Returns the identity it stamped so
 * the caller can pass it back to {@link releaseSingleInstanceLock} for an
 * ownership-checked release (PRD-018a NEC-002).
 */
export function acquireSingleInstanceLock(paths: LockPaths, options: AcquireOptions = {}): LockIdentity {
  mkdirSync(dirname(paths.lockFilePath), { recursive: true });
  const identity: LockIdentity = {
    pid: options.pid ?? process.pid,
    boot: options.boot ?? currentBoot(),
    token: options.token ?? randomUUID(),
  };
  const serialized = JSON.stringify(identity);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      // Exclusive create is the atomic winner-picker: only ONE process can create
      // the lock with "wx"; every other concurrent creator gets EEXIST.
      fd = openSync(paths.lockFilePath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readLockIdentity(paths.lockFilePath);
      if (existing !== null && isLockOwnerLive(existing)) {
        throw new DaemonAlreadyRunningError(existing.pid, paths.lockFilePath);
      }
      // Stale (dead owner / prior boot / unreadable): reclaim and retry.
      reclaimStaleLock(paths.lockFilePath, existing);
      continue;
    }

    try {
      writeSync(fd, serialized);
    } finally {
      closeSync(fd);
    }

    // Verify-after-create: confirm the lock still records OUR token. A concurrent
    // reclaimer cannot have replaced it (our "wx" create means the file existed
    // for everyone else, who then read our live identity and threw), so this is
    // belt-and-suspenders; on a mismatch we retry rather than proceed unsafely.
    const readback = readLockIdentity(paths.lockFilePath);
    if (readback === null || readback.token !== identity.token) continue;

    // Write the operator-facing pid file (bare pid). On failure, roll the lock
    // back so a partial acquisition never leaves a stale lock wedging the next
    // start; the lock was just created by us, so removing it is safe.
    try {
      writeFileSync(paths.pidFilePath, String(identity.pid), "utf8");
    } catch (err) {
      rmSync(paths.lockFilePath, { force: true });
      throw err;
    }
    return identity;
  }

  // Every attempt lost to a live lock created between our checks.
  const raced = readLockIdentity(paths.lockFilePath);
  throw new DaemonAlreadyRunningError(raced?.pid ?? -1, paths.lockFilePath);
}

/** Does the recorded lock belong to `identity` (or, absent one, to this live process)? */
function lockOwnedBy(recorded: LockIdentity, identity: LockIdentity | undefined): boolean {
  if (identity !== undefined) {
    if (identity.token !== undefined && recorded.token !== undefined) {
      return recorded.token === identity.token;
    }
    return recorded.pid === identity.pid && bootMatches(recorded.boot, identity.boot);
  }
  // No identity supplied: own it iff this live process wrote it (pid + this boot).
  return recorded.pid === process.pid && (recorded.boot === undefined || sameBoot(recorded.boot, currentBoot()));
}

function bootMatches(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameBoot(a, b);
}

/**
 * Release the lock: remove both files, but ONLY when this process owns the lock
 * (PRD-018a NEC-002). Called by a process that does not own the lock (a failed
 * second start), it is a no-op, so a failed start can never delete the live
 * daemon's lock and pid. Pass the identity returned by
 * {@link acquireSingleInstanceLock} for a precise token-based check; omit it to
 * fall back to a pid+boot check against this live process. Never throws (a
 * missing lock on shutdown is fine; the goal already holds).
 */
export function releaseSingleInstanceLock(paths: LockPaths, identity?: LockIdentity): void {
  const recorded = readLockIdentity(paths.lockFilePath);
  // Own the lock, or it is already gone: safe to clear both files. Otherwise the
  // lock belongs to a live, different owner and we touch nothing.
  if (recorded === null || lockOwnedBy(recorded, identity)) {
    rmSync(paths.lockFilePath, { force: true });
    rmSync(paths.pidFilePath, { force: true });
  }
}

/** True if a live daemon currently holds this lock (used by health/status). */
export function isLockHeldByLiveDaemon(lockFilePath: string): boolean {
  const id = readLockIdentity(lockFilePath);
  return id !== null && isLockOwnerLive(id);
}
