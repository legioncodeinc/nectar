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
  /**
   * Nectars whose durable `insertIdentity` flush has failed (CodeRabbit PR-18
   * finding #8, layer a). If an identity's durable insert fails but a LATER
   * `appendVersion`/`touchIdentity`/`deleteNectar` for the same nectar still
   * flushed durably, `hive_graph_versions` (or a touch) would land with no
   * matching `hive_graph` row - an orphan the read path can never resolve
   * (reads join through identities). Every later write for a nectar in this
   * set is parked (never sent durably) instead, so the orphan is never
   * created in the first place. Bridge lifetime only; not persisted (a fresh
   * bridge re-derives it from a fresh `insertIdentity` failure, should one
   * happen again).
   */
  private readonly failedIdentityNectars = new Set<string>();

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
   *
   * `nectar` is checked against {@link failedIdentityNectars} at RUN time (not
   * enqueue time): because the queue is strictly serialized, by the time this
   * op's turn comes up, an earlier `insertIdentity` for the same nectar has
   * already settled, so the set is guaranteed up to date (CodeRabbit PR-18
   * finding #8, layer a). Only `appendVersion`/`touchIdentity` are parkable -
   * they are the writes that would ADD data referencing a still-missing
   * identity. `deleteNectar` is exempt and always flows through: it is
   * cleanup, not a write that can orphan anything (the durable `deleteNectar`
   * contract is itself a no-op when the identity does not exist), and letting
   * it through is what clears the nectar out of {@link failedIdentityNectars}
   * again on success.
   */
  private enqueue(op: DurableWriteOp, nectar: string, run: () => Promise<void>): void {
    this.pending += 1;
    this.tail = this.tail.then(() => {
      const parkable = op === "appendVersion" || op === "touchIdentity";
      if (parkable && this.failedIdentityNectars.has(nectar)) {
        this.pending -= 1;
        this.failures += 1;
        const err = new Error(
          `durable ${op} for nectar ${nectar} parked: its identity insert already failed durably (would orphan hive_graph_versions)`,
        );
        this.lastError = err;
        this.onFlushError(err, op);
        return;
      }
      return run().then(
        () => {
          this.pending -= 1;
          if (op === "deleteNectar") this.failedIdentityNectars.delete(nectar); // the nectar is gone; nothing left to orphan
        },
        (err: unknown) => {
          this.pending -= 1;
          this.failures += 1;
          this.lastError = err;
          if (op === "insertIdentity") this.failedIdentityNectars.add(nectar);
          this.onFlushError(err, op);
        },
      );
    });
  }

  // ── writes: apply to the mirror, then flush the identical write in order ─────

  insertIdentity(row: HiveGraphRow): void {
    this.mirror.insertIdentity(row);
    this.enqueue("insertIdentity", row.nectar, () => this.durable.insertIdentity(row));
  }

  touchIdentity(nectar: string, lastUpdateDate: string): void {
    this.mirror.touchIdentity(nectar, lastUpdateDate);
    this.enqueue("touchIdentity", nectar, () => this.durable.touchIdentity(nectar, lastUpdateDate));
  }

  appendVersion(row: HiveGraphVersionRow): void {
    this.mirror.appendVersion(row);
    // Re-allocate the seq at flush time through the durable store's single
    // lag-immune, per-nectar-serialized allocator instead of trusting the seq
    // the mirror computed synchronously (issue NEC: the rename-during-describe
    // duplicate-seq race). The mirror cannot see the enricher's independent
    // durable appends, so its `nextSeq` can hand out a value the enricher has
    // already durably taken; `appendVersionAtNextSeq` is the ONE seq authority
    // both components share (same `ctx.store` instance), so it never collides.
    // The allocated seq is reconciled back into the mirror so later synchronous
    // ladder reads agree with what actually persisted. Mint (seq 0 on a fresh
    // nectar) stays correct: the allocator returns 0 when nothing precedes it.
    const ladderSeq = row.seq;
    const from = { seq: ladderSeq, path: row.path, contentHash: row.contentHash };
    this.enqueue("appendVersion", row.nectar, async () => {
      const allocate = this.durable.appendVersionAtNextSeq;
      if (allocate === undefined) {
        // An adapter without the allocator (in-memory recorder fakes): keep the
        // pre-fix behavior and flush the caller-sequenced row as-is.
        await this.durable.appendVersion(row);
        return;
      }
      const allocated = await allocate.call(this.durable, row);
      if (allocated !== ladderSeq) this.mirror.reseqVersion(row.nectar, from, allocated);
    });
  }

  deleteNectar(tenancy: Tenancy, nectar: string): void {
    this.mirror.deleteNectar(tenancy, nectar);
    this.enqueue("deleteNectar", nectar, () => this.durable.deleteNectar(tenancy, nectar));
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

  listVersionNectars(tenancy: Tenancy): string[] {
    return this.mirror.listVersionNectars(tenancy);
  }

  /**
   * Full version history from the mirror, for the repair sweep's duplicate-seq
   * detection (issue NEC). NOTE: the mirror is seeded latest-per-nectar at
   * {@link hydrate}, so it does not itself carry a pre-existing DURABLE
   * duplicate; a live pre-fix duplicate self-heals through normal ladder
   * re-observation once the durable allocator is lag-immune (Parts 1-2), while
   * this accessor lets the sweep collapse any duplicate a caller CAN see (e.g. a
   * store seeded with full history in a test) to an unambiguous latest.
   */
  listAllVersions(tenancy: Tenancy): readonly HiveGraphVersionRow[] {
    return this.mirror.listAllVersions(tenancy);
  }
}
