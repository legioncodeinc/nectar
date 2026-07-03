/**
 * The sync/async store bridge (PRD-018b NEC-001).
 *
 * The re-association ladder (`ladder.ts`) and the `RegistrationService`
 * (`service.ts`) are written entirely against the SYNCHRONOUS `HiveGraphStore`
 * seam: the ladder computes `nextSeq`, reads by path/hash, and appends rows with
 * no `await` in its control flow. The only durable substrate, Deep Lake
 * (`deeplake-store.ts`), implements the ASYNC twin `AsyncHiveGraphStore` because
 * it does real HTTP I/O and cannot honor the synchronous contract. That mismatch
 * is why the update-on-change pipeline was never wired into the running daemon
 * (change-detection review C1): even a one-line wiring change was impossible.
 *
 * `StoreBridge` closes that gap. It presents the synchronous `HiveGraphStore`
 * the service consumes, backed by an in-memory mirror (`InMemoryHiveGraphStore`)
 * so every read the ladder issues is served synchronously and correctly, and it
 * mirrors each write through to the async durable store in the exact order the
 * ladder produced them. This is the same shape the brooding path already uses to
 * reconcile the two interfaces; it is not a new second scheme.
 *
 * Three contracts (PRD-018b AC-018b.4):
 *   - hydration: {@link StoreBridge.hydrate} seeds the mirror from the durable
 *     store's latest-version-per-nectar (plus identities) at boot, after
 *     auto-brood settles, so cold catch-up runs against a warm mirror and seq
 *     numbering continues from the persisted state;
 *   - write-through ordering: a ladder action applies to the mirror
 *     synchronously and enqueues the identical durable write onto a single
 *     serialized queue, so durable writes land in ladder order (never
 *     interleaved, never reordered);
 *   - failure surfacing: a durable write that rejects does NOT silently vanish;
 *     it increments {@link StoreBridge.durableFlushFailures}, records the error,
 *     and is reported through the injected `onFlushError`. It does not poison the
 *     queue (later writes still flush) and it never throws back into the
 *     synchronous ladder (which has already committed the write to the mirror,
 *     the in-process source of truth). Automatic re-drive of a failed durable
 *     write is deliberately left to the enricher/brood write-pattern decision
 *     (PRD-018g) rather than inventing a second scheme here.
 */
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import type { AsyncHiveGraphStore, HiveGraphStore, LatestVersion } from "../hive-graph/store.js";
import { InMemoryHiveGraphStore } from "../hive-graph/memory-store.js";

/** The write kinds mirrored through to the durable store, for the failure report label. */
export type DurableWriteOp = "insertIdentity" | "touchIdentity" | "appendVersion" | "deleteNectar";

export interface StoreBridgeOptions {
  /** The durable async store every mirror write is flushed through to (Deep Lake). */
  readonly durable: AsyncHiveGraphStore;
  /**
   * Surfaces a failed durable flush (AC-018b.4). Called once per rejected
   * durable write with the error and the write kind. The daemon wires this to
   * `/health` and the log; a failed flush is never silently dropped.
   */
  onFlushError?(err: unknown, op: DurableWriteOp): void;
}

/**
 * A synchronous {@link HiveGraphStore} facade over an async durable store. Reads
 * hit an in-memory mirror; writes apply to the mirror synchronously and are
 * flushed to the durable store in order. Exposes {@link hydrate} to seed the
 * mirror and {@link whenFlushed} to await the durable queue draining (used by
 * the shutdown drain and by tests).
 */
export class StoreBridge implements HiveGraphStore {
  private readonly mirror = new InMemoryHiveGraphStore();
  private readonly durable: AsyncHiveGraphStore;
  private readonly onFlushError: (err: unknown, op: DurableWriteOp) => void;

  /** The serialized durable-write queue. Every enqueue chains onto this so writes flush in order. */
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failures = 0;
  private lastError: unknown = null;

  constructor(opts: StoreBridgeOptions) {
    this.durable = opts.durable;
    this.onFlushError = opts.onFlushError ?? (() => {});
  }

  /**
   * Seed the mirror from the durable store's latest-version-per-nectar so the
   * ladder starts warm (AC-018b.4 hydration): identities and the single latest
   * version per nectar are enough for every read the ladder issues, and the
   * mirror's `nextSeq` (MAX(seq)+1) continues correctly from the persisted
   * seq. Idempotent: a nectar already in the mirror is skipped, so a re-hydrate
   * never double-appends. Does NOT re-flush anything (the rows are already
   * durable); it writes only to the mirror.
   */
  async hydrate(tenancy: Tenancy): Promise<void> {
    const latest = await this.durable.listLatestVersions(tenancy);
    for (const lv of latest) {
      if (this.mirror.getIdentity(lv.identity.nectar) !== undefined) continue;
      this.mirror.insertIdentity(lv.identity);
      this.mirror.appendVersion(lv.version);
    }
  }

  /** Resolves once every durable write enqueued so far has settled (success or surfaced failure). */
  whenFlushed(): Promise<void> {
    return this.tail.then(() => {});
  }

  /** How many durable flushes have failed since construction (surfaced to `/health`). */
  get durableFlushFailures(): number {
    return this.failures;
  }

  /** The most recent durable-flush error, or null when none has failed. */
  get lastFlushError(): unknown {
    return this.lastError;
  }

  /** Durable writes enqueued but not yet settled. */
  get pendingDurableWrites(): number {
    return this.pending;
  }

  /**
   * Chain one durable write onto the serialized queue. The op's rejection is
   * caught HERE (never rethrown into the synchronous ladder, and never left to
   * become an unhandled rejection), so the queue keeps draining and every
   * failure is surfaced exactly once.
   */
  private enqueue(op: DurableWriteOp, run: () => Promise<void>): void {
    this.pending += 1;
    this.tail = this.tail.then(run).then(
      () => {
        this.pending -= 1;
      },
      (err: unknown) => {
        this.pending -= 1;
        this.failures += 1;
        this.lastError = err;
        this.onFlushError(err, op);
      },
    );
  }

  // ── writes: apply to the mirror, then flush the identical write in order ─────

  insertIdentity(row: HiveGraphRow): void {
    this.mirror.insertIdentity(row);
    this.enqueue("insertIdentity", () => this.durable.insertIdentity(row));
  }

  touchIdentity(nectar: string, lastUpdateDate: string): void {
    this.mirror.touchIdentity(nectar, lastUpdateDate);
    this.enqueue("touchIdentity", () => this.durable.touchIdentity(nectar, lastUpdateDate));
  }

  appendVersion(row: HiveGraphVersionRow): void {
    this.mirror.appendVersion(row);
    this.enqueue("appendVersion", () => this.durable.appendVersion(row));
  }

  deleteNectar(tenancy: Tenancy, nectar: string): void {
    this.mirror.deleteNectar(tenancy, nectar);
    this.enqueue("deleteNectar", () => this.durable.deleteNectar(tenancy, nectar));
  }

  // ── reads: served synchronously from the mirror ──────────────────────────────

  getIdentity(nectar: string): HiveGraphRow | undefined {
    return this.mirror.getIdentity(nectar);
  }

  nextSeq(nectar: string): number {
    return this.mirror.nextSeq(nectar);
  }

  latestVersion(nectar: string): HiveGraphVersionRow | undefined {
    return this.mirror.latestVersion(nectar);
  }

  listLatestVersions(tenancy: Tenancy): LatestVersion[] {
    return this.mirror.listLatestVersions(tenancy);
  }

  listLatestDescribedVersions(tenancy: Tenancy): LatestVersion[] {
    return this.mirror.listLatestDescribedVersions(tenancy);
  }

  latestVersionByPath(tenancy: Tenancy, path: string): LatestVersion | undefined {
    return this.mirror.latestVersionByPath(tenancy, path);
  }

  latestVersionByHash(tenancy: Tenancy, contentHash: string): LatestVersion | undefined {
    return this.mirror.latestVersionByHash(tenancy, contentHash);
  }

  listIdentities(tenancy: Tenancy): HiveGraphRow[] {
    return this.mirror.listIdentities(tenancy);
  }
}
