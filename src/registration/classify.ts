/**
 * Event-to-ladder-step classification (PRD-006b).
 *
 * A pure function that maps a debounced path observation to exactly one of the
 * three inputs the re-association ladder consumes: a new path (exists, no nectar),
 * a changed path (exists, has a nectar; the ladder still hashes to decide no-op
 * vs edit), or a missing path (a known nectar's path is gone from disk). A path
 * that neither exists nor is known is a no-op (for example a temp file created
 * and deleted inside the debounce window) and classifies to null.
 *
 * PRD-018c NEC-034 / AC-018c.8: the `known` lookup takes an optional `fold`
 * function so a case-insensitive workspace can compare case-folded (the
 * caller pre-folds `knownPaths`'s entries with the SAME function, service.ts's
 * `knownPaths()`). `fold` defaults to the identity, preserving case-sensitive
 * behavior. The RETURNED `relPath` is always `obs.relPath` verbatim - the
 * fold is a lookup-only concern; stored rows keep the observed on-disk casing.
 */

export interface PathObservation {
  readonly relPath: string;
  readonly existsOnDisk: boolean;
}

export type LadderInputKind = "new-path" | "changed-path" | "missing-path";

export interface LadderInput {
  readonly kind: LadderInputKind;
  readonly relPath: string;
}

/**
 * Classify one observation against the set of paths currently known to the store
 * (from `store.listLatestVersions(...)` -> version.path). Returns null when there
 * is nothing to do.
 */
export function classifyPath(
  obs: PathObservation,
  knownPaths: ReadonlySet<string>,
  fold: (relPath: string) => string = (relPath) => relPath,
): LadderInput | null {
  const known = knownPaths.has(fold(obs.relPath));
  if (obs.existsOnDisk) {
    return { kind: known ? "changed-path" : "new-path", relPath: obs.relPath };
  }
  if (known) return { kind: "missing-path", relPath: obs.relPath };
  return null;
}
