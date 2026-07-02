/**
 * The HiveGraphStore seam (PRD-005).
 *
 * The interface both the in-memory adapter (PRD-005, this project, tests + local
 * dev) and the future Deep Lake adapter (the real substrate, per ADR-0002 reached
 * through nectar's own client) implement. The file-registration ladder
 * (PRD-006) is written entirely against this interface, so it is testable with the
 * in-memory adapter and unchanged when the Deep Lake adapter lands.
 *
 * All reads/writes are tenancy-scoped (org+workspace at the layer, project_id as a
 * column filter, per PRD-005c). "latest version" always means MAX(seq) for a nectar.
 */
import type {
  HiveGraphRow,
  HiveGraphVersionRow,
  Tenancy,
} from "./model.js";

/** A candidate for re-association: a nectar plus its latest observed version. */
export interface LatestVersion {
  readonly identity: HiveGraphRow;
  readonly version: HiveGraphVersionRow;
}

export interface HiveGraphStore {
  /** Insert a `hive_graph` identity row (mint). Throws if the nectar already exists. */
  insertIdentity(row: HiveGraphRow): void;

  /** Fetch an identity row by nectar, or undefined. */
  getIdentity(nectar: string): HiveGraphRow | undefined;

  /** Bump a nectar's `last_update_date` (called when a new version is appended). */
  touchIdentity(nectar: string, lastUpdateDate: string): void;

  /** Append a `hive_graph_versions` row. The caller supplies seq via `nextSeq`. */
  appendVersion(row: HiveGraphVersionRow): void;

  /** The next monotonic seq for a nectar (0 if it has no versions yet). */
  nextSeq(nectar: string): number;

  /** The latest (MAX seq) version row for a nectar, or undefined. */
  latestVersion(nectar: string): HiveGraphVersionRow | undefined;

  /**
   * Every nectar's latest version, scoped to the tenancy. The ladder derives the
   * known-paths set, the missing-files set, and the by-latest-hash copy index from this.
   */
  listLatestVersions(tenancy: Tenancy): LatestVersion[];

  /**
   * Every nectar's latest DESCRIBED version, scoped to the tenancy: for each
   * nectar that has at least one `describe_status = 'described'` version, the
   * highest-seq described row. Nectars with no described version are omitted.
   *
   * This is the projection scan (PRD-011c / `data/portable-registry.md` §
   * Generation and regeneration: "latest described version per nectar, scoped to
   * the project"). The projection builder overlays this onto
   * {@link listLatestVersions} so an undescribed nectar still keeps a minimal
   * entry (identity + path + content_hash) while a described one carries the
   * latest description verbatim.
   */
  listLatestDescribedVersions(tenancy: Tenancy): LatestVersion[];

  /** The latest version whose current path equals `path` (ladder steps 1-2), scoped. */
  latestVersionByPath(tenancy: Tenancy, path: string): LatestVersion | undefined;

  /**
   * A nectar whose latest version content_hash equals `contentHash` (ladder step 3
   * exact-move, and the copy-event index), scoped. Returns the first match.
   */
  latestVersionByHash(tenancy: Tenancy, contentHash: string): LatestVersion | undefined;

  /**
   * Delete a nectar (its identity row + every version row), scoped to `tenancy`.
   * This is the SOLE nectar-deletion path (`prune --confirm`, PRD-006d); the
   * re-association ladder never deletes or reuses nectars. A no-op if the nectar
   * does not exist OR its identity is outside `tenancy` (a cross-project delete
   * is refused, never applied, per AC-20).
   */
  deleteNectar(tenancy: Tenancy, nectar: string): void;
}

/**
 * The async twin of {@link HiveGraphStore} (PRD-005's Deep Lake adapter).
 *
 * `HiveGraphStore` is synchronous by design: the in-memory adapter backs it
 * with plain `Map`s, and the file-registration ladder (`registration/ladder.ts`)
 * calls it synchronously throughout, with no `await` anywhere in the ladder's
 * control flow. A real Deep Lake adapter does its work over HTTP and cannot
 * honor that synchronous contract, so this is a SEPARATE interface with the
 * same method names and semantics, each wrapped in a `Promise` — not a
 * variant of `HiveGraphStore` and not a substitute for it.
 *
 * `DeepLakeHiveGraphStore` (`deeplake-store.ts`) implements this interface,
 * not `HiveGraphStore`. Wiring the ladder to run against an async store is
 * out of scope for PRD-005's adapter work: that would mean either making the
 * ladder's own control flow async (touching `registration/ladder.ts`, which
 * this task does not touch) or adapting between the two seams at the call
 * site. Either is a future PRD's decision once a caller actually needs the
 * durable adapter wired into the live worker loop; today `InMemoryHiveGraphStore`
 * remains the ladder's only consumer and is unchanged by this addition.
 */
export interface AsyncHiveGraphStore {
  /** Insert a `hive_graph` identity row (mint). Rejects if the nectar already exists. */
  insertIdentity(row: HiveGraphRow): Promise<void>;

  /** Fetch an identity row by nectar, or undefined. */
  getIdentity(nectar: string): Promise<HiveGraphRow | undefined>;

  /** Bump a nectar's `last_update_date` (called when a new version is appended). */
  touchIdentity(nectar: string, lastUpdateDate: string): Promise<void>;

  /** Append a `hive_graph_versions` row. The caller supplies seq via `nextSeq`. */
  appendVersion(row: HiveGraphVersionRow): Promise<void>;

  /** The next monotonic seq for a nectar (0 if it has no versions yet). */
  nextSeq(nectar: string): Promise<number>;

  /** The latest (MAX seq) version row for a nectar, or undefined. */
  latestVersion(nectar: string): Promise<HiveGraphVersionRow | undefined>;

  /** Every nectar's latest version, scoped to the tenancy (soft-filtered by `project_id`). */
  listLatestVersions(tenancy: Tenancy): Promise<LatestVersion[]>;

  /**
   * Every nectar's latest DESCRIBED version, scoped to the tenancy: for each
   * nectar with at least one `describe_status = 'described'` version, the
   * highest-seq described row (nectars with no described version omitted). The
   * async twin of {@link HiveGraphStore.listLatestDescribedVersions}; the
   * projection scan (PRD-011c) the durable `rebuild-projection` CLI runs against
   * Deep Lake, overlaid onto {@link listLatestVersions} so undescribed nectars
   * keep a minimal entry.
   */
  listLatestDescribedVersions(tenancy: Tenancy): Promise<LatestVersion[]>;

  /** The latest version whose current path equals `path`, scoped. */
  latestVersionByPath(tenancy: Tenancy, path: string): Promise<LatestVersion | undefined>;

  /** A nectar whose latest version content_hash equals `contentHash`, scoped. First match. */
  latestVersionByHash(tenancy: Tenancy, contentHash: string): Promise<LatestVersion | undefined>;

  /**
   * Delete a nectar (identity + versions), scoped to `tenancy`. The SOLE
   * deletion path (`prune --confirm`); a no-op when the nectar does not exist or
   * its identity is outside `tenancy` (a cross-project delete is refused, AC-20).
   * The tenancy predicate makes the Deep Lake adapter inherit the same guard the
   * in-memory adapter enforces, so no delete crosses a project boundary.
   */
  deleteNectar(tenancy: Tenancy, nectar: string): Promise<void>;
}
