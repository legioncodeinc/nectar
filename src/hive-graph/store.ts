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

  /**
   * Every `hive_graph` identity row, scoped to `tenancy` - INCLUDING an
   * identity with zero `hive_graph_versions` rows (which
   * {@link listLatestVersions} can never surface, since it joins through the
   * latest version). OPTIONAL and ADDITIVE (PRD-018d): the ladder's crash-repair
   * sweep (`repairLadderState`) uses this to find an orphan identity left by a
   * mint crashing between `insertIdentity` and `appendVersion`. Omit on an
   * adapter that has no cheap way to enumerate bare identities; the sweep skips
   * orphan-identity healing (only) when this is undefined, and reports the gap
   * rather than guessing.
   */
  listIdentities?(tenancy: Tenancy): HiveGraphRow[];

  /**
   * Every distinct nectar that has AT LEAST ONE `hive_graph_versions` row,
   * scoped to `tenancy` (via the version rows' own tenancy columns, since an
   * orphan version's nectar may have no `hive_graph` identity row to scope
   * against). OPTIONAL and ADDITIVE (PRD-018 close-out, CodeRabbit PR-18
   * finding #8): the ladder's crash-repair sweep (`repairLadderState`) uses
   * this, together with {@link getIdentity}, to find an orphan VERSION - a
   * version row whose nectar has no matching identity (the inverse of the
   * orphan-IDENTITY case {@link listIdentities} already heals) - left by a
   * durable identity-insert flush that failed after a later version for the
   * same nectar still landed. Omit on an adapter with no cheap way to
   * enumerate distinct version nectars; the sweep skips orphan-version
   * healing (only) when this is undefined.
   */
  listVersionNectars?(tenancy: Tenancy): string[];

  /**
   * Every `hive_graph_versions` row (FULL history, not latest-per-nectar),
   * scoped to `tenancy` via each row's own tenancy columns. OPTIONAL and
   * ADDITIVE (issue NEC, the rename-during-describe duplicate-seq race): the
   * crash-repair sweep (`repairLadderState`) uses it to detect a duplicate
   * `(nectar, seq)` pair - two rows sharing one nectar's MAX seq, which makes
   * latest-version resolution ambiguous. {@link listLatestVersions} collapses
   * each nectar to a single row and so can never reveal such a duplicate; this
   * exposes the raw rows the sweep needs. Omit on an adapter with no cheap way
   * to enumerate full history; the sweep skips duplicate-seq healing (only) when
   * this is undefined.
   */
  listAllVersions?(tenancy: Tenancy): readonly HiveGraphVersionRow[];
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

  /**
   * Allocate the next monotonic seq for `row.nectar` through the store's single
   * per-nectar-serialized, in-process-high-water allocator and append `row` at
   * it, resolving the seq actually written (`row.seq` is ignored). OPTIONAL and
   * ADDITIVE (issue NEC): it is the ONE seq authority the live daemon routes
   * every version append through - the enricher commit AND the registration
   * bridge flush - so two components with independent store views cannot mint a
   * duplicate `(nectar, seq)` even under Deep Lake read-after-write lag.
   * `DeepLakeHiveGraphStore` implements it; an in-memory recorder fake may omit
   * it (a caller then falls back to `appendVersion` with the supplied seq).
   */
  appendVersionAtNextSeq?(row: HiveGraphVersionRow): Promise<number>;

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
