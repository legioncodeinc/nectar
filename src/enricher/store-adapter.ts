/**
 * A durable-backed {@link EnricherStore} for the daemon's enricher loop (PRD-016
 * daemon wiring).
 *
 * The enricher cycle consumes the SYNCHRONOUS {@link EnricherStore} seam
 * (`store.ts`): every read (`listPendingWork`, `countPending`, `getVersion`,
 * `listVersions`, `priorDescribedVersion`) and the `updateVersion` write are
 * called with no `await` inside `runEnricherCycle`. The durable substrate
 * (`DeepLakeHiveGraphStore`) is asynchronous, so a store cannot honor the sync
 * contract AND do real HTTP I/O at the same time — the exact sync/async split
 * documented on `AsyncHiveGraphStore` (`hive-graph/store.ts`).
 *
 * This adapter bridges the two the only way that keeps the cycle synchronous: it
 * holds an in-memory mirror ({@link EnricherInMemoryStore}) as the working set the
 * cycle reads from, seeds it from the durable store once at boot via an injected
 * async {@link EnricherHydrateSeam} (`hydrate()`), and writes every
 * `updateVersion` THROUGH to the durable store as a fire-and-forget, fail-soft
 * async write built with the enricher module's own {@link buildUpdateVersionSql}.
 * The mirror stays authoritative for the running cycle; the durable write-back
 * makes the description durable across restarts.
 *
 * Production hydration (enumerating a tenancy's FULL version history from Deep
 * Lake) is supplied by the caller through {@link EnricherHydrateSeam}, because
 * the `AsyncHiveGraphStore` seam exposes only latest-per-nectar reads, not the
 * per-nectar history the enricher's resumability needs — the daemon injects a
 * loader when it wires a real transport.
 */
import type { HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import { buildUpdateVersionSql } from "./sql-update.js";
import { EnricherInMemoryStore, type EnricherStore, type EnricherWorkItem } from "./store.js";

/** The async seams the durable adapter needs: load a tenancy's rows, and write one row back. */
export interface EnricherHydrateSeam {
  /** Load EVERY version row for the tenancy (full history, not latest-per-nectar) to seed the mirror. */
  loadVersions(tenancy: Tenancy): Promise<readonly HiveGraphVersionRow[]>;
  /** Persist one updated version row to the durable store. Built from {@link buildUpdateVersionSql}. */
  writeBack(sql: string): Promise<void>;
  /** Optional fail-soft sink for a write-back rejection (default: swallow). */
  onWriteBackError?(err: unknown): void;
}

/**
 * A {@link EnricherStore} backed by an in-memory mirror with durable write-through.
 * Construct, `await hydrate(tenancy)` once before starting the loop, then hand it
 * to `createEnricherLoop`.
 */
export class DeepLakeEnricherStore implements EnricherStore {
  private readonly mirror = new EnricherInMemoryStore();
  private readonly seam: EnricherHydrateSeam;
  private hydrated = false;

  constructor(seam: EnricherHydrateSeam) {
    this.seam = seam;
  }

  /** Seed the mirror from the durable store. Idempotent; a second call re-seeds. */
  async hydrate(tenancy: Tenancy): Promise<void> {
    const rows = await this.seam.loadVersions(tenancy);
    this.mirror.seedVersions(rows);
    this.hydrated = true;
  }

  /** True once {@link hydrate} has seeded the mirror at least once. */
  get isHydrated(): boolean {
    return this.hydrated;
  }

  listPendingWork(tenancy: Tenancy, batchSize: number): EnricherWorkItem[] {
    return this.mirror.listPendingWork(tenancy, batchSize);
  }

  countPending(tenancy: Tenancy): number {
    return this.mirror.countPending(tenancy);
  }

  getVersion(nectar: string, seq: number): HiveGraphVersionRow | undefined {
    return this.mirror.getVersion(nectar, seq);
  }

  listVersions(nectar: string): readonly HiveGraphVersionRow[] {
    return this.mirror.listVersions(nectar);
  }

  priorDescribedVersion(nectar: string, beforeSeq: number): HiveGraphVersionRow | undefined {
    return this.mirror.priorDescribedVersion(nectar, beforeSeq);
  }

  /**
   * Update the in-memory mirror synchronously (so the cycle sees it immediately),
   * then fire the durable write-back. The write-back is fail-soft: a rejection is
   * routed to `onWriteBackError` and never surfaces into the synchronous cycle.
   */
  updateVersion(row: HiveGraphVersionRow): void {
    this.mirror.updateVersion(row);
    const sql = buildUpdateVersionSql(row);
    void this.seam.writeBack(sql).catch((err: unknown) => {
      this.seam.onWriteBackError?.(err);
    });
  }
}
