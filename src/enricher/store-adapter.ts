/**
 * A durable-backed {@link EnricherStore} for the daemon's enricher loop (PRD-016
 * daemon wiring, hardened by PRD-018g).
 *
 * The enricher cycle consumes the SYNCHRONOUS reads of the {@link EnricherStore}
 * seam (`store.ts`): `listPendingWork`, `countPending`, `getVersion`,
 * `listVersions`, `priorDescribedVersion`, and the mirror-only `updateVersion`
 * are all called with no `await` inside `runEnricherCycle`. The durable substrate
 * (`DeepLakeHiveGraphStore`) is asynchronous, so a store cannot honor the sync
 * read contract AND do real HTTP I/O at the same time - the exact sync/async
 * split documented on `AsyncHiveGraphStore` (`hive-graph/store.ts`).
 *
 * This adapter bridges the two by holding an in-memory mirror
 * ({@link EnricherInMemoryStore}) as the working set the cycle reads from, and:
 *
 *   - **Durable describe write-back is a VERSION-BUMP APPEND (PRD-018g / NEC-017,
 *     user-confirmed decision).** `commitVersion` appends a NEW row at `seq+1`
 *     carrying the description through the injected {@link EnricherHydrateSeam}
 *     `appendVersion` (collision-safe seq allocation), and is AWAITED by the
 *     cycle: only on a CONFIRMED durable write does the mirror gain the described
 *     row (so the latest-is-pending selector stops re-selecting the nectar) and
 *     the cycle count the file. On failure the mirror is untouched (the nectar
 *     stays selectable) and `commitVersion` resolves `false`. The retired
 *     fire-and-forget in-place `UPDATE` (`sql-update.ts`) is no longer used.
 *
 *   - **Mirror-only status patches** (`failed`, `skipped-deleted`) go through
 *     `updateVersion` and write ONLY the mirror: the durable row stays `pending`,
 *     so a failed row is re-selected after a restart re-hydrates.
 *
 *   - **Working-set freshness (PRD-018g / NEC-016):** `refresh` re-seeds the
 *     mirror from the durable store so version rows appended after boot (a
 *     `POST /build` brood's `failed`/`pending` rows, teammate-synced rows, the
 *     watcher's appends) become visible without a daemon restart.
 */
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import { nectarCreatedAt } from "../hive-graph/ulid.js";
import { buildProjection } from "../projection/generate.js";
import type { ProjectionNectarSource } from "../projection/store-adapter.js";
import type { PortableProjection } from "../projection/format.js";
import { EnricherInMemoryStore, type EnricherStore, type EnricherWorkItem } from "./store.js";

/** The async seams the durable adapter needs: load a tenancy's rows, and append one row back. */
export interface EnricherHydrateSeam {
  /** Load EVERY version row for the tenancy (full history, not latest-per-nectar) to seed the mirror. */
  loadVersions(tenancy: Tenancy): Promise<readonly HiveGraphVersionRow[]>;
  /**
   * Durably append `row` as a version-bump at the next collision-safe seq for
   * its nectar (PRD-018g / NEC-017), resolving the seq actually written. Wired
   * to `DeepLakeHiveGraphStore.appendVersionAtNextSeq`.
   */
  appendVersion(row: HiveGraphVersionRow): Promise<number>;
  /** Optional fail-soft sink for a durable append rejection (default: swallow). */
  onWriteBackError?(err: unknown): void;
}

/**
 * A {@link EnricherStore} backed by an in-memory mirror with durable
 * version-bump append. Construct, `await hydrate(tenancy)` once before starting
 * the loop (and `refresh(tenancy)` periodically), then hand it to
 * `createEnricherLoop`.
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

  /**
   * Re-seed the mirror from the durable store so post-boot rows become visible
   * without a restart (PRD-018g / NEC-016 AC-018g.6). Fail-soft: a load failure
   * is routed to the write-back error sink and leaves the mirror unchanged.
   */
  async refresh(tenancy: Tenancy): Promise<void> {
    try {
      const rows = await this.seam.loadVersions(tenancy);
      this.mirror.seedVersions(rows);
    } catch (err: unknown) {
      this.seam.onWriteBackError?.(err);
    }
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

  /** Mirror-only status patch (failed / skipped-deleted); no durable write (NEC-017). */
  updateVersion(row: HiveGraphVersionRow): void {
    this.mirror.updateVersion(row);
  }

  /**
   * Durable version-bump append (PRD-018g / NEC-017 AC-018g.7/.8): append the
   * described row at the next collision-safe seq, and ONLY on a confirmed durable
   * write add it to the mirror (so the nectar drops out of the latest-is-pending
   * selection). A durable failure leaves the mirror untouched - the nectar's
   * latest stays `pending` and is re-selected next cycle - and resolves `false`.
   */
  async commitVersion(row: HiveGraphVersionRow): Promise<boolean> {
    try {
      const seq = await this.seam.appendVersion(row);
      this.mirror.seedVersion({ ...row, seq });
      return true;
    } catch (err: unknown) {
      this.seam.onWriteBackError?.(err);
      return false;
    }
  }

  /**
   * Build a portable projection document from the mirror's latest-described rows
   * (PRD-018g / NEC-031 trigger #2). Identity rows are synthesized from the
   * version rows (nectar + tenancy), which is all the projection generator needs;
   * derived-from provenance is not carried in the enricher mirror and defaults to
   * absent (a steady-state description update never changes fork provenance).
   */
  buildProjectionDoc(tenancy: Tenancy): PortableProjection {
    const sources: ProjectionNectarSource[] = [];
    for (const nectar of this.mirrorNectars()) {
      const described = this.latestDescribed(nectar, tenancy);
      if (described === undefined) continue;
      sources.push({ identity: synthesizeIdentity(described), version: described });
    }
    return buildProjection(tenancy, sources);
  }

  private mirrorNectars(): readonly string[] {
    // listVersions works per nectar; enumerate via the mirror's pending+described
    // reach by scanning through a wide pending call is not enough, so expose the
    // set from the mirror directly.
    return this.mirror.nectars();
  }

  private latestDescribed(nectar: string, tenancy: Tenancy): HiveGraphVersionRow | undefined {
    let best: HiveGraphVersionRow | undefined;
    for (const row of this.mirror.listVersions(nectar)) {
      if (row.orgId !== tenancy.orgId || row.workspaceId !== tenancy.workspaceId || row.projectId !== tenancy.projectId) {
        continue;
      }
      if (row.describeStatus !== "described") continue;
      if (best === undefined || row.seq > best.seq) best = row;
    }
    return best;
  }
}

/** Synthesize an identity row for a version row (enricher mirror has no identity table). */
function synthesizeIdentity(version: HiveGraphVersionRow): HiveGraphRow {
  return {
    nectar: version.nectar,
    kind: "file",
    createdAt: nectarCreatedAt(version.nectar),
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: version.orgId,
    workspaceId: version.workspaceId,
    projectId: version.projectId,
    lastUpdateDate: version.lastUpdateDate,
  };
}
