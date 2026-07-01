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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

  add(candidate: PendingReviewCandidate): void {
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

/** A JSON-file-backed pending-review queue in the daemon runtime dir. Fail-open on a malformed/missing file. */
export class FilePendingReviewStore implements PendingReviewStore {
  constructor(private readonly filePath: string) {}

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

  private write(items: readonly PendingReviewCandidate[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }

  add(candidate: PendingReviewCandidate): void {
    const items = this.read().filter((c) => c.id !== candidate.id);
    items.push({ ...candidate });
    this.write(items);
  }

  list(): PendingReviewCandidate[] {
    return this.read();
  }

  remove(id: string): void {
    this.write(this.read().filter((c) => c.id !== id));
  }
}
