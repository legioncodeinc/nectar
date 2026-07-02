/**
 * Multiset Jaccard similarity for the meaningful-change heuristic (PRD-016a).
 */

import { tokenMultiset, tokenizeSource } from "./tokenize.js";

/**
 * Multiset Jaccard: sum(min(a_i, b_i)) / sum(max(a_i, b_i)) over all token keys.
 * Returns 1 for identical multisets, 0 when disjoint.
 */
export function multisetJaccard(a: readonly string[], b: readonly string[]): number {
  const ma = tokenMultiset(a);
  const mb = tokenMultiset(b);
  const keys = new Set<string>([...ma.keys(), ...mb.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const ca = ma.get(key) ?? 0;
    const cb = mb.get(key) ?? 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  if (union === 0) return 1;
  return intersection / union;
}

/** Compare two source bodies directly. */
export function contentJaccardSimilarity(prevContent: string, nextContent: string): number {
  return multisetJaccard(tokenizeSource(prevContent), tokenizeSource(nextContent));
}
