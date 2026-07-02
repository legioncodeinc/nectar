/**
 * Thin adapter over {@link HiveGraphStore} for projection generation (PRD-011).
 *
 * The exported store lists each nectar's absolute latest version via
 * `listLatestVersions`. When that latest row is `described`, it is projected
 * verbatim. When it is not described, a minimal entry (path + content_hash,
 * empty title/description) is emitted per the corpus. The edge case where the
 * absolute latest is pending but an older described version exists requires a
 * store extension (`listVersionsForNectar` or equivalent); until wired, only
 * the absolute latest is considered.
 */
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import type { AsyncHiveGraphStore, HiveGraphStore } from "../hive-graph/store.js";

/** One nectar row selected for projection output. */
export interface ProjectionNectarSource {
  readonly identity: HiveGraphRow;
  readonly version: HiveGraphVersionRow;
}

export interface CollectProjectionSourcesOptions {
  /**
   * Optional hook to resolve the latest described version when the store's
   * absolute latest is not described. Integration can supply this once the
   * store exposes per-nectar version history.
   */
  readonly getLatestDescribedVersion?: (nectar: string) => HiveGraphVersionRow | undefined;
}

function pickVersion(
  latest: HiveGraphVersionRow,
  getLatestDescribed: ((nectar: string) => HiveGraphVersionRow | undefined) | undefined,
): HiveGraphVersionRow {
  if (latest.describeStatus === "described") return latest;
  const described = getLatestDescribed?.(latest.nectar);
  if (described !== undefined) return described;
  return latest;
}

/** Collect nectar/version pairs from the store, scoped to `tenancy`. */
export function collectProjectionSources(
  store: HiveGraphStore,
  tenancy: Tenancy,
  opts: CollectProjectionSourcesOptions = {},
): ProjectionNectarSource[] {
  const out: ProjectionNectarSource[] = [];
  for (const { identity, version: latest } of store.listLatestVersions(tenancy)) {
    out.push({ identity, version: pickVersion(latest, opts.getLatestDescribedVersion) });
  }
  return out;
}

/**
 * The async twin of {@link collectProjectionSources} for the durable
 * {@link AsyncHiveGraphStore} (Deep Lake). The sync store's synchronous
 * `getLatestDescribedVersion` hook cannot be honored over HTTP, so this reads
 * both the latest version per nectar and the latest DESCRIBED version per nectar
 * from the async store and overlays them: a nectar with a described version
 * carries that version verbatim; a minted-but-undescribed nectar keeps its
 * latest observed version (a minimal projection entry). This reproduces
 * {@link pickVersion}'s "described if any, else latest" choice against the
 * durable store without a sync bridge, and matches the PRD-011c scan (latest
 * described version per nectar, scoped to the project).
 */
export async function collectProjectionSourcesAsync(
  store: AsyncHiveGraphStore,
  tenancy: Tenancy,
): Promise<ProjectionNectarSource[]> {
  const [latest, described] = await Promise.all([
    store.listLatestVersions(tenancy),
    store.listLatestDescribedVersions(tenancy),
  ]);
  const describedByNectar = new Map<string, HiveGraphVersionRow>();
  for (const { identity, version } of described) describedByNectar.set(identity.nectar, version);
  return latest.map(({ identity, version }) => ({
    identity,
    version: describedByNectar.get(identity.nectar) ?? version,
  }));
}
