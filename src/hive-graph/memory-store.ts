/**
 * In-memory HiveGraphStore adapter (PRD-005).
 *
 * A complete, correct implementation of the store seam backed by plain Maps.
 * It is the store the file-registration ladder (PRD-006), brooding (PRD-007),
 * and the search engine (PRD-012) run against in tests and local dev. The Deep
 * Lake adapter (the durable substrate, reached through nectar's own client
 * per ADR-0002) implements the same interface and is a drop-in replacement; no
 * consumer changes when it lands.
 *
 * "latest version" is always MAX(seq) for a nectar. All reads are tenancy-scoped
 * (org+workspace+project); project_id is a plain column predicate here, exactly
 * as the soft-filter contract (PRD-005c) specifies.
 */
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "./model.js";
import { inTenancy } from "./model.js";
import type { LatestVersion, HiveGraphStore } from "./store.js";

export class InMemoryHiveGraphStore implements HiveGraphStore {
  private readonly identities = new Map<string, HiveGraphRow>();
  /** nectar -> version rows in append order (seq ascending). */
  private readonly versions = new Map<string, HiveGraphVersionRow[]>();

  insertIdentity(row: HiveGraphRow): void {
    if (this.identities.has(row.nectar)) {
      throw new Error(`identity already exists for nectar ${row.nectar}`);
    }
    this.identities.set(row.nectar, { ...row });
  }

  getIdentity(nectar: string): HiveGraphRow | undefined {
    const row = this.identities.get(nectar);
    return row ? { ...row } : undefined;
  }

  touchIdentity(nectar: string, lastUpdateDate: string): void {
    const row = this.identities.get(nectar);
    if (row !== undefined) row.lastUpdateDate = lastUpdateDate;
  }

  appendVersion(row: HiveGraphVersionRow): void {
    const list = this.versions.get(row.nectar) ?? [];
    list.push({ ...row });
    this.versions.set(row.nectar, list);
  }

  /**
   * Reconcile a mirrored version row's seq to the value the durable store
   * actually allocated at flush time (`StoreBridge` re-allocation, issue NEC).
   * The row is identified by its ORIGINAL `(seq, path, contentHash)` so that a
   * concurrent reconcile of a different row for the same nectar can never move
   * the wrong one (two pending flushes for one nectar can transiently share a
   * seq value mid-reconcile; matching on path+contentHash keeps each targeting
   * its own row). No-op when the row is absent or already at `toSeq`. This is a
   * mirror-only correction: the durable row was written at `toSeq` directly.
   */
  reseqVersion(nectar: string, from: { seq: number; path: string; contentHash: string }, toSeq: number): void {
    if (from.seq === toSeq) return;
    const list = this.versions.get(nectar);
    if (list === undefined) return;
    const target = list.find(
      (v) => v.seq === from.seq && v.path === from.path && v.contentHash === from.contentHash,
    );
    if (target !== undefined) target.seq = toSeq;
  }

  nextSeq(nectar: string): number {
    const list = this.versions.get(nectar);
    if (list === undefined || list.length === 0) return 0;
    let max = -1;
    for (const v of list) if (v.seq > max) max = v.seq;
    return max + 1;
  }

  latestVersion(nectar: string): HiveGraphVersionRow | undefined {
    const list = this.versions.get(nectar);
    if (list === undefined || list.length === 0) return undefined;
    let latest = list[0] as HiveGraphVersionRow;
    for (const v of list) if (v.seq > latest.seq) latest = v;
    return { ...latest };
  }

  listLatestVersions(tenancy: Tenancy): LatestVersion[] {
    const out: LatestVersion[] = [];
    for (const [nectar, identity] of this.identities) {
      if (!inTenancy(identity, tenancy)) continue;
      const version = this.latestVersion(nectar);
      if (version !== undefined) out.push({ identity: { ...identity }, version });
    }
    return out;
  }

  listLatestDescribedVersions(tenancy: Tenancy): LatestVersion[] {
    const out: LatestVersion[] = [];
    for (const [nectar, identity] of this.identities) {
      if (!inTenancy(identity, tenancy)) continue;
      const described = this.latestDescribedVersion(nectar);
      if (described !== undefined) out.push({ identity: { ...identity }, version: described });
    }
    return out;
  }

  /** The highest-seq version whose `describeStatus` is `described`, or undefined. */
  private latestDescribedVersion(nectar: string): HiveGraphVersionRow | undefined {
    const list = this.versions.get(nectar);
    if (list === undefined || list.length === 0) return undefined;
    let latest: HiveGraphVersionRow | undefined;
    for (const v of list) {
      if (v.describeStatus !== "described") continue;
      if (latest === undefined || v.seq > latest.seq) latest = v;
    }
    return latest === undefined ? undefined : { ...latest };
  }

  latestVersionByPath(tenancy: Tenancy, path: string): LatestVersion | undefined {
    for (const lv of this.listLatestVersions(tenancy)) {
      if (lv.version.path === path) return lv;
    }
    return undefined;
  }

  latestVersionByHash(tenancy: Tenancy, contentHash: string): LatestVersion | undefined {
    for (const lv of this.listLatestVersions(tenancy)) {
      if (lv.version.contentHash === contentHash) return lv;
    }
    return undefined;
  }

  deleteNectar(tenancy: Tenancy, nectar: string): void {
    const identity = this.identities.get(nectar);
    if (identity === undefined) return; // unknown nectar: no-op
    if (!inTenancy(identity, tenancy)) return; // refuse a cross-project delete (AC-20)
    this.identities.delete(nectar);
    this.versions.delete(nectar);
  }

  /** Every identity row in scope, including one with zero version rows (PRD-018d repair sweep). */
  listIdentities(tenancy: Tenancy): HiveGraphRow[] {
    const out: HiveGraphRow[] = [];
    for (const identity of this.identities.values()) {
      if (inTenancy(identity, tenancy)) out.push({ ...identity });
    }
    return out;
  }

  /** Every nectar with at least one version row in scope, including one with NO identity row (CodeRabbit PR-18 finding #8 repair sweep). Scoped via the version row's own tenancy columns, since an orphan has no identity to scope against. */
  listVersionNectars(tenancy: Tenancy): string[] {
    const out: string[] = [];
    for (const [nectar, list] of this.versions) {
      const first = list[0];
      if (first !== undefined && inTenancy(first, tenancy)) out.push(nectar);
    }
    return out;
  }

  /** Every version row (FULL history, not latest-per-nectar) in scope, for the duplicate-seq repair sweep (issue NEC). Scoped by each row's own tenancy columns. */
  listAllVersions(tenancy: Tenancy): readonly HiveGraphVersionRow[] {
    const out: HiveGraphVersionRow[] = [];
    for (const list of this.versions.values()) {
      for (const row of list) {
        if (inTenancy(row, tenancy)) out.push({ ...row });
      }
    }
    return out;
  }
}
