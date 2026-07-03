/**
 * The pending-candidate surface for `review-matches` (PRD-006d AC-18).
 *
 * The settled handler writes a low-confidence step-4 candidate here (via
 * `onReviewNeeded`); the `review-matches` command reads them back, lets the
 * operator accept (carry the nectar) or reject (leave the fresh mint), and
 * removes each as it is resolved.
 *
 * Two implementations:
 *   - {@link InMemoryPendingReviewStore}: the in-process surface the running
 *     daemon and the tests use.
 *   - {@link FilePendingReviewStore}: a JSON file under the daemon runtime dir so
 *     a separate `review-matches` CLI process can see candidates a daemon queued.
 *     This is an ephemeral operational queue (like the PID/lock files that share
 *     the runtime dir), NOT durable domain state, so it does not conflict with
 *     the Deep-Lake-is-the-only-durable-store rule (FR-8): the durable nectar
 *     rows live in Deep Lake; this file only tracks unreviewed candidates.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** One unreviewed step-4 candidate. Carries everything an accept needs so no disk re-read is required. */
export interface PendingReviewCandidate {
  /** Stable id (a minted ULID) so accept/reject can target one entry. */
  readonly id: string;
  /** The candidate MISSING nectar the new path may be. */
  readonly candidateNectar: string;
  /** The new path (already minted fresh at review time). */
  readonly newPath: string;
  readonly confidence: number;
  readonly distance: number | null;
  /** The new file's content hash + metadata, so accept can carry without reading disk. */
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mtimeObserved: string;
  /** The fresh nectar minted for `newPath` when the candidate was raised. */
  readonly mintedNectar: string;
  readonly createdAt: string;
}

export interface PendingReviewStore {
  add(candidate: PendingReviewCandidate): void;
  list(): PendingReviewCandidate[];
  remove(id: string): void;
}

export class InMemoryPendingReviewStore implements PendingReviewStore {
  private readonly items = new Map<string, PendingReviewCandidate>();

  /**
   * Dedupe/replace by `(candidateNectar, newPath)` (PRD-018d NEC-036/AC-18d.7):
   * a re-observation of the same target while a candidate for it is already
   * pending refreshes that candidate in place instead of appending a sibling,
   * so the queue never grows per re-observation of one path.
   */
  add(candidate: PendingReviewCandidate): void {
    for (const [id, existing] of this.items) {
      if (
        id !== candidate.id &&
        existing.candidateNectar === candidate.candidateNectar &&
        existing.newPath === candidate.newPath
      ) {
        this.items.delete(id);
      }
    }
    this.items.set(candidate.id, { ...candidate });
  }

  list(): PendingReviewCandidate[] {
    return [...this.items.values()].map((c) => ({ ...c }));
  }

  remove(id: string): void {
    this.items.delete(id);
  }
}

function isCandidate(value: unknown): value is PendingReviewCandidate {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c["id"] === "string" &&
    typeof c["candidateNectar"] === "string" &&
    typeof c["newPath"] === "string" &&
    typeof c["confidence"] === "number" &&
    (c["distance"] === null || typeof c["distance"] === "number") &&
    typeof c["contentHash"] === "string" &&
    typeof c["sizeBytes"] === "number" &&
    typeof c["mtimeObserved"] === "string" &&
    typeof c["mintedNectar"] === "string" &&
    typeof c["createdAt"] === "string"
  );
}

/** How long an `add()`/`remove()` waits for the advisory lock before giving up. */
const LOCK_MAX_WAIT_MS = 5000;
/** Poll interval while waiting for the advisory lock. */
const LOCK_RETRY_DELAY_MS = 5;
/**
 * A lock file whose mtime is older than this is presumed abandoned by a
 * crashed holder (CodeRabbit PR-18 finding #4): a crash between
 * {@link acquireFileLock} and the caller's `finally` release used to leave
 * `${filePath}.lock` behind forever, wedging every later `add()`/`remove()`
 * to the full {@link LOCK_MAX_WAIT_MS} timeout. A live holder's critical
 * section (a small JSON read-modify-write) always finishes well within
 * `LOCK_MAX_WAIT_MS`; 3x that gives comfortable headroom over the slowest
 * legitimate hold (another racer's full wait plus its own critical section)
 * before this reclaims the lock as abandoned.
 */
const LOCK_STALE_MS = LOCK_MAX_WAIT_MS * 3;

/** A synchronous, event-loop-blocking sleep (Node allows `Atomics.wait` on the main thread; browsers do not). */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire an advisory, exclusive-create file lock at `lockPath`, blocking
 * (synchronously) until it is free or `LOCK_MAX_WAIT_MS` elapses. Mirrors the
 * daemon's single-instance lock's exclusive-create-is-the-atomic-winner-picker
 * idiom (`lock.ts` `acquireSingleInstanceLock`), scaled down to a short-lived
 * critical section instead of a whole-process-lifetime lock: unlike the daemon
 * lock, this one carries no owner identity and is never force-reclaimed, so
 * two racing holders can never both believe they hold it (PRD-018d NEC-036 /
 * AC-018d.6 - this is what turns the read-modify-write in {@link
 * FilePendingReviewStore.add}/{@link FilePendingReviewStore.remove} into a
 * SERIALIZED critical section across the daemon and the `review-matches` CLI,
 * the store's stated two-writer use case).
 */
/** True when `lockPath`'s mtime is older than {@link LOCK_STALE_MS} (an abandoned lock). False when it no longer exists (the caller's ENOENT race: another process reclaimed first). */
function isLockStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // gone already; the create-retry below will settle it
  }
}

function acquireFileLock(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // CodeRabbit PR-18 finding #4: reclaim an abandoned lock by mtime instead
      // of waiting out the full timeout behind it every time.
      if (isLockStale(lockPath)) {
        try {
          rmSync(lockPath);
        } catch (rmErr) {
          // ENOENT: another process reclaimed it first between our stat and
          // our rm; anything else is a real filesystem problem.
          if ((rmErr as NodeJS.ErrnoException).code !== "ENOENT") throw rmErr;
        }
        continue; // re-attempt the exclusive create immediately
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the pending-review lock at ${lockPath}`);
      }
      sleepSyncMs(LOCK_RETRY_DELAY_MS);
    }
  }
}

/** Release the advisory lock. Never throws (a missing lock on release is fine; the goal already holds). */
function releaseFileLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // best-effort; nothing more to do if removal itself fails
  }
}

/** A JSON-file-backed pending-review queue in the daemon runtime dir. Fail-open on a malformed/missing file. */
export class FilePendingReviewStore implements PendingReviewStore {
  constructor(private readonly filePath: string) {}

  /** Sibling lock file guarding the read-modify-write critical section in `add`/`remove`. */
  private lockPath(): string {
    return `${this.filePath}.lock`;
  }

  private read(): PendingReviewCandidate[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCandidate);
  }

  /**
   * Atomic write: serialize to a unique temp file in the same directory, then
   * `renameSync` it over the target (atomic on the same filesystem). A reader
   * therefore never sees a torn/partial file, and two concurrent writers cannot
   * interleave bytes (last rename wins). This queue is ephemeral, last-write-wins
   * operational state (not durable domain state, which lives in Deep Lake, FR-8).
   * `write()` on its own only guarantees atomicity (no torn file); it is the
   * callers `add`/`remove` that additionally guarantee no LOST update, by
   * holding {@link acquireFileLock} across their whole read-then-write
   * (PRD-018d AC-018d.6). The temp file is cleaned up on failure.
   */
  private write(items: readonly PendingReviewCandidate[]): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${basename(this.filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup; surface the original write error below
      }
      throw err;
    }
  }

  /**
   * Serialized (PRD-018d AC-018d.6) read-modify-write: the advisory lock makes
   * this critical section mutually exclusive with any other `add`/`remove`
   * call on the same file, from this process or another, so a daemon `add()`
   * racing a CLI `remove()` can no longer resurrect a resolved candidate or
   * silently drop a fresh one (M5) - whichever call wins the lock re-reads
   * AFTER acquiring it, so it always sees the other's already-applied write.
   *
   * Also dedupes/replaces by `(candidateNectar, newPath)` (AC-018d.7): a
   * re-observation of the same target refreshes the existing candidate in
   * place rather than appending a sibling, so the queue does not grow per
   * re-observation of one path (M6).
   */
  add(candidate: PendingReviewCandidate): void {
    const lockPath = this.lockPath();
    acquireFileLock(lockPath);
    try {
      const items = this.read().filter(
        (c) => c.id !== candidate.id && !(c.candidateNectar === candidate.candidateNectar && c.newPath === candidate.newPath),
      );
      items.push({ ...candidate });
      this.write(items);
    } finally {
      releaseFileLock(lockPath);
    }
  }

  list(): PendingReviewCandidate[] {
    return this.read();
  }

  /** Serialized (PRD-018d AC-018d.6) the same way as {@link add}. */
  remove(id: string): void {
    const lockPath = this.lockPath();
    acquireFileLock(lockPath);
    try {
      this.write(this.read().filter((c) => c.id !== id));
    } finally {
      releaseFileLock(lockPath);
    }
  }
}
