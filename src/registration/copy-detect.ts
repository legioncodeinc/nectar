/**
 * Copy-paste detection (PRD-006c), from ai/identity-and-reassociation.md.
 *
 * When a new path's content hash equals some existing nectar's LATEST version
 * hash, that is a copy event: the new file gets a fresh nectar with
 * `derived_from_nectar` pointing at the source and `fork_content_hash` = the
 * shared content hash. Otherwise it is a genuinely new file and mints plainly.
 *
 * This is the step-5 decision for a new path that is NOT a move (moves are caught
 * earlier by the ladder's step 3, gated on the source path being gone from disk).
 */
import type { Tenancy } from "../source-graph/model.js";
import type { SourceGraphStore } from "../source-graph/store.js";

export type NewFileDecision =
  | { readonly action: "mint" }
  | { readonly action: "copy"; readonly sourceNectar: string; readonly forkContentHash: string };

export function classifyNewFile(
  store: SourceGraphStore,
  tenancy: Tenancy,
  newContentHash: string,
): NewFileDecision {
  const existing = store.latestVersionByHash(tenancy, newContentHash);
  if (existing !== undefined) {
    return {
      action: "copy",
      sourceNectar: existing.identity.nectar,
      forkContentHash: newContentHash,
    };
  }
  return { action: "mint" };
}
