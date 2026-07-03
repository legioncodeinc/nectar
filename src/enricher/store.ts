/**
 * Enricher store seam: pending-work selection + version row updates (PRD-016).
 */
import type { HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import { inTenancy } from "../hive-graph/model.js";
import { selectPendingWorkInMemory } from "./pending-query.js";

export interface EnricherWorkItem {
  readonly nectar: string;
  readonly seq: number;
  readonly row: HiveGraphVersionRow;
  /** True when retrying a `failed` row solo (PRD-016c). */
  readonly solo: boolean;
}

export interface EnricherStore {
  listPendingWork(tenancy: Tenancy, batchSize: number): EnricherWorkItem[];
  countPending(tenancy: Tenancy): number;
  getVersion(nectar: string, seq: number): HiveGraphVersionRow | undefined;
  listVersions(nectar: string): readonly HiveGraphVersionRow[];
  priorDescribedVersion(nectar: string, beforeSeq: number): HiveGraphVersionRow | undefined;
  /**
   * Mirror-only, synchronous status patch for a `failed` or `skipped-deleted`
   * outcome (PRD-018g / NEC-017): updates the in-memory working set in place so
   * the running cycle sees the new status, WITHOUT a durable write. A failed row
   * stays `pending` in the durable store so it is re-selected after a restart
   * (the fire-and-forget in-place durable UPDATE is retired).
   */
  updateVersion(row: HiveGraphVersionRow): void;
  /**
   * Durable version-bump append for a `described` (or cosmetic-inherited /
   * re-embedded) row (PRD-018g / NEC-017 AC-018g.7/.8). Appends a NEW row at
   * `seq+1` carrying the description; `row.seq` is ignored (the store owns seq
   * allocation, collision-safe). Resolves `true` only when the durable write is
   * CONFIRMED; on a durable failure it resolves `false`, the working set is left
   * unchanged (the nectar stays selectable), and the caller must NOT count the
   * file described.
   */
  commitVersion(row: HiveGraphVersionRow): Promise<boolean>;
}

/** In-memory enricher store for tests and local dev. */
export class EnricherInMemoryStore implements EnricherStore {
  /** nectar -> version rows in seq order. */
  private readonly versions = new Map<string, HiveGraphVersionRow[]>();

  seedVersion(row: HiveGraphVersionRow): void {
    const list = this.versions.get(row.nectar) ?? [];
    const idx = list.findIndex((v) => v.seq === row.seq);
    const copy = { ...row };
    if (idx >= 0) list[idx] = copy;
    else list.push(copy);
    list.sort((a, b) => a.seq - b.seq);
    this.versions.set(row.nectar, list);
  }

  seedVersions(rows: readonly HiveGraphVersionRow[]): void {
    for (const row of rows) this.seedVersion(row);
  }

  listPendingWork(tenancy: Tenancy, batchSize: number): EnricherWorkItem[] {
    const flat: HiveGraphVersionRow[] = [];
    for (const rows of this.versions.values()) {
      for (const row of rows) {
        if (inTenancy(row, tenancy)) flat.push(row);
      }
    }
    const pendingRows = selectPendingWorkInMemory(
      flat.map((r) => ({
        nectar: r.nectar,
        seq: r.seq,
        describeStatus: r.describeStatus,
        observedAt: r.observedAt,
        orgId: r.orgId,
        workspaceId: r.workspaceId,
        projectId: r.projectId,
      })),
      tenancy,
      batchSize,
    );
    const items: EnricherWorkItem[] = [];
    for (const p of pendingRows) {
      const row = this.getVersion(p.nectar, p.seq);
      if (row === undefined) continue;
      items.push({
        nectar: p.nectar,
        seq: p.seq,
        row,
        solo: row.describeStatus === "failed",
      });
    }
    return items;
  }

  countPending(tenancy: Tenancy): number {
    // Count nectars whose LATEST row is pending/failed, matching the
    // latest-is-pending selection (PRD-018g / NEC-017) so the depth cannot count
    // a superseded lower-seq pending row a version-bump append left behind.
    let count = 0;
    for (const rows of this.versions.values()) {
      let latest: HiveGraphVersionRow | undefined;
      for (const row of rows) {
        if (!inTenancy(row, tenancy)) continue;
        if (latest === undefined || row.seq > latest.seq) latest = row;
      }
      if (latest !== undefined && (latest.describeStatus === "pending" || latest.describeStatus === "failed")) {
        count += 1;
      }
    }
    return count;
  }

  getVersion(nectar: string, seq: number): HiveGraphVersionRow | undefined {
    const list = this.versions.get(nectar);
    if (list === undefined) return undefined;
    const row = list.find((v) => v.seq === seq);
    return row !== undefined ? { ...row } : undefined;
  }

  listVersions(nectar: string): readonly HiveGraphVersionRow[] {
    const list = this.versions.get(nectar);
    return list !== undefined ? list.map((v) => ({ ...v })) : [];
  }

  /** Every nectar with at least one version row in the mirror (projection scan). */
  nectars(): readonly string[] {
    return [...this.versions.keys()];
  }

  priorDescribedVersion(nectar: string, beforeSeq: number): HiveGraphVersionRow | undefined {
    const list = this.versions.get(nectar);
    if (list === undefined) return undefined;
    let best: HiveGraphVersionRow | undefined;
    for (const row of list) {
      if (row.seq >= beforeSeq) continue;
      if (row.describeStatus !== "described") continue;
      if (best === undefined || row.seq > best.seq) best = row;
    }
    return best !== undefined ? { ...best } : undefined;
  }

  updateVersion(row: HiveGraphVersionRow): void {
    const list = this.versions.get(row.nectar);
    if (list === undefined) return;
    const idx = list.findIndex((v) => v.seq === row.seq);
    if (idx < 0) return;
    list[idx] = { ...row };
  }

  /**
   * Version-bump append: allocate `MAX(seq)+1` for the nectar and append `row`
   * there (PRD-018g / NEC-017). The in-memory store never fails a durable write,
   * so this always resolves `true`.
   */
  commitVersion(row: HiveGraphVersionRow): Promise<boolean> {
    const list = this.versions.get(row.nectar) ?? [];
    let max = -1;
    for (const v of list) if (v.seq > max) max = v.seq;
    this.seedVersion({ ...row, seq: max + 1 });
    return Promise.resolve(true);
  }
}
