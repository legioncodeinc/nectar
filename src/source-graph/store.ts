/**
 * The SourceGraphStore seam (PRD-005).
 *
 * The interface both the in-memory adapter (PRD-005, this project, tests + local
 * dev) and the future Deep Lake adapter (the real substrate, per ADR-0002 reached
 * through hivenectar's own client) implement. The file-registration ladder
 * (PRD-006) is written entirely against this interface, so it is testable with the
 * in-memory adapter and unchanged when the Deep Lake adapter lands.
 *
 * All reads/writes are tenancy-scoped (org+workspace at the layer, project_id as a
 * column filter, per PRD-005c). "latest version" always means MAX(seq) for a nectar.
 */
import type {
  SourceGraphRow,
  SourceGraphVersionRow,
  Tenancy,
} from "./model.js";

/** A candidate for re-association: a nectar plus its latest observed version. */
export interface LatestVersion {
  readonly identity: SourceGraphRow;
  readonly version: SourceGraphVersionRow;
}

export interface SourceGraphStore {
  /** Insert a `source_graph` identity row (mint). Throws if the nectar already exists. */
  insertIdentity(row: SourceGraphRow): void;

  /** Fetch an identity row by nectar, or undefined. */
  getIdentity(nectar: string): SourceGraphRow | undefined;

  /** Bump a nectar's `last_update_date` (called when a new version is appended). */
  touchIdentity(nectar: string, lastUpdateDate: string): void;

  /** Append a `source_graph_versions` row. The caller supplies seq via `nextSeq`. */
  appendVersion(row: SourceGraphVersionRow): void;

  /** The next monotonic seq for a nectar (0 if it has no versions yet). */
  nextSeq(nectar: string): number;

  /** The latest (MAX seq) version row for a nectar, or undefined. */
  latestVersion(nectar: string): SourceGraphVersionRow | undefined;

  /**
   * Every nectar's latest version, scoped to the tenancy. The ladder derives the
   * known-paths set, the missing-files set, and the by-latest-hash copy index from this.
   */
  listLatestVersions(tenancy: Tenancy): LatestVersion[];

  /** The latest version whose current path equals `path` (ladder steps 1-2), scoped. */
  latestVersionByPath(tenancy: Tenancy, path: string): LatestVersion | undefined;

  /**
   * A nectar whose latest version content_hash equals `contentHash` (ladder step 3
   * exact-move, and the copy-event index), scoped. Returns the first match.
   */
  latestVersionByHash(tenancy: Tenancy, contentHash: string): LatestVersion | undefined;
}
