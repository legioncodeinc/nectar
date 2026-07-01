/**
 * In-memory SourceGraphStore adapter (PRD-005).
 *
 * A complete, correct implementation of the store seam backed by plain Maps.
 * It is the store the file-registration ladder (PRD-006), brooding (PRD-007),
 * and the search engine (PRD-012) run against in tests and local dev. The Deep
 * Lake adapter (the durable substrate, reached through hivenectar's own client
 * per ADR-0002) implements the same interface and is a drop-in replacement; no
 * consumer changes when it lands.
 *
 * "latest version" is always MAX(seq) for a nectar. All reads are tenancy-scoped
 * (org+workspace+project); project_id is a plain column predicate here, exactly
 * as the soft-filter contract (PRD-005c) specifies.
 */
import type { SourceGraphRow, SourceGraphVersionRow, Tenancy } from "./model.js";
import type { LatestVersion, SourceGraphStore } from "./store.js";

function inTenancy(row: { orgId: string; workspaceId: string; projectId: string }, t: Tenancy): boolean {
  return row.orgId === t.orgId && row.workspaceId === t.workspaceId && row.projectId === t.projectId;
}

export class InMemorySourceGraphStore implements SourceGraphStore {
  private readonly identities = new Map<string, SourceGraphRow>();
  /** nectar -> version rows in append order (seq ascending). */
  private readonly versions = new Map<string, SourceGraphVersionRow[]>();

  insertIdentity(row: SourceGraphRow): void {
    if (this.identities.has(row.nectar)) {
      throw new Error(`identity already exists for nectar ${row.nectar}`);
    }
    this.identities.set(row.nectar, { ...row });
  }

  getIdentity(nectar: string): SourceGraphRow | undefined {
    const row = this.identities.get(nectar);
    return row ? { ...row } : undefined;
  }

  touchIdentity(nectar: string, lastUpdateDate: string): void {
    const row = this.identities.get(nectar);
    if (row !== undefined) row.lastUpdateDate = lastUpdateDate;
  }

  appendVersion(row: SourceGraphVersionRow): void {
    const list = this.versions.get(row.nectar) ?? [];
    list.push({ ...row });
    this.versions.set(row.nectar, list);
  }

  nextSeq(nectar: string): number {
    const list = this.versions.get(nectar);
    if (list === undefined || list.length === 0) return 0;
    let max = -1;
    for (const v of list) if (v.seq > max) max = v.seq;
    return max + 1;
  }

  latestVersion(nectar: string): SourceGraphVersionRow | undefined {
    const list = this.versions.get(nectar);
    if (list === undefined || list.length === 0) return undefined;
    let latest = list[0] as SourceGraphVersionRow;
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
}
