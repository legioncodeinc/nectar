/**
 * `nectar prune [--confirm]` command logic (PRD-006d AC-19).
 *
 * The SOLE nectar-deletion path. The re-association ladder never deletes or
 * reuses a nectar; deletion is a separate, explicit, human-triggered operation:
 *   - bare `prune`         -> a preview/list of prune candidates (no deletion);
 *   - `prune --confirm`    -> the destructive act (delete each candidate).
 *
 * A prune candidate is a nectar whose latest-version path is absent from disk and
 * whose last observed change is older than the grace period. The grace period
 * exists because a "missing" file may be on another checked-out branch or return
 * after a merge, so pruning is conservative.
 *
 * DEFAULT (flagged, not load-bearing on any algorithm): the grace period is 30
 * days ({@link PRUNE_GRACE_MS}), configurable via `graceMs`.
 */
import type { HiveGraphStore } from "../hive-graph/store.js";
import type { Tenancy } from "../hive-graph/model.js";
import { inTenancy } from "../hive-graph/model.js";

/** Prune grace period: 30 days - DEFAULT - confirm before implementation. Configurable via `graceMs`. */
export const PRUNE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PruneDeps {
  readonly store: HiveGraphStore;
  readonly tenancy: Tenancy;
  /** Whether a repo-relative path currently exists on disk. */
  existsOnDisk(relPath: string): boolean;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now(): string;
  /** Grace window in ms; defaults to {@link PRUNE_GRACE_MS}. */
  readonly graceMs?: number;
  /** true = delete (the destructive act); false/undefined = preview only. */
  readonly confirm?: boolean;
  out(line: string): void;
}

export interface PruneCandidate {
  readonly nectar: string;
  readonly path: string;
  readonly lastUpdateDate: string;
  readonly ageMs: number;
}

export interface PruneResult {
  readonly candidates: readonly PruneCandidate[];
  readonly deleted: number;
  readonly confirmed: boolean;
}

/** Compute the prune candidates: latest path absent from disk AND older than the grace window. */
export function findPruneCandidates(deps: PruneDeps): PruneCandidate[] {
  const graceMs = deps.graceMs ?? PRUNE_GRACE_MS;
  const nowMs = Date.parse(deps.now());
  const out: PruneCandidate[] = [];
  for (const lv of deps.store.listLatestVersions(deps.tenancy)) {
    if (deps.existsOnDisk(lv.version.path)) continue;
    const lastMs = Date.parse(lv.identity.lastUpdateDate);
    const ageMs = Number.isNaN(lastMs) ? Number.POSITIVE_INFINITY : nowMs - lastMs;
    if (ageMs > graceMs) {
      out.push({ nectar: lv.identity.nectar, path: lv.version.path, lastUpdateDate: lv.identity.lastUpdateDate, ageMs });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function runPrune(deps: PruneDeps): PruneResult {
  const candidates = findPruneCandidates(deps);
  const confirmed = deps.confirm === true;

  if (candidates.length === 0) {
    deps.out("Nothing to prune: no nectar is missing beyond the grace period.");
    return { candidates, deleted: 0, confirmed };
  }

  if (!confirmed) {
    deps.out(`${candidates.length} nectar(s) missing beyond the grace period (preview only):`);
    for (const c of candidates) {
      const days = Math.floor(c.ageMs / (24 * 60 * 60 * 1000));
      deps.out(`  ${c.nectar}  ${c.path}  (missing/last-updated ${c.lastUpdateDate}, ~${days}d)`);
    }
    deps.out("Run 'nectar prune --confirm' to delete these nectars. This is the only deletion path.");
    return { candidates, deleted: 0, confirmed: false };
  }

  let deleted = 0;
  for (const c of candidates) {
    // Re-check ELIGIBILITY immediately before each destructive delete: the file
    // may have reappeared (path returned to disk) between candidate computation
    // and now, in which case it is no longer a prune candidate and must be kept.
    if (deps.existsOnDisk(c.path)) continue;
    // Defense in depth: re-verify the identity is in scope, even though candidates
    // already come from a scoped listLatestVersions. The delete itself is
    // tenancy-scoped too (AC-20).
    const identity = deps.store.getIdentity(c.nectar);
    if (identity === undefined || !inTenancy(identity, deps.tenancy)) continue;
    deps.store.deleteNectar(deps.tenancy, c.nectar);
    deps.out(`pruned ${c.nectar} (${c.path})`);
    deleted += 1;
  }
  deps.out(`Pruned ${deleted} nectar(s).`);
  return { candidates, deleted, confirmed: true };
}
