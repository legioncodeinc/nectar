/**
 * Prior-content cache for the cosmetic-change (Jaccard) gate (PRD-018g / NEC-026).
 *
 * The gate needs the PRIOR described version's file content to compare against
 * the new content, but the hive-graph tables store only a `content_hash`, never
 * the bytes. This bounded in-process cache is the chosen prior-content strategy:
 * whenever the enricher reads a file's content on the describe path, it records
 * `{ contentHash, content }` keyed by nectar, so the NEXT observation of that
 * file can compute Jaccard(priorContent, newContent) without a paid re-describe.
 *
 * The cache is per-daemon-process and lost on restart, so the FIRST post-boot
 * edit of a file cannot inherit (the prior content is unknown) and takes the full
 * describe path - the honest degradation `cli.ts` already documents for a cold
 * boot. The `contentHash` stored alongside lets the gate confirm the cached
 * content actually corresponds to the prior described version before trusting it.
 */
export interface PriorContentEntry {
  readonly contentHash: string;
  readonly content: string;
}

export interface PriorContentCache {
  get(nectar: string): PriorContentEntry | undefined;
  set(nectar: string, contentHash: string, content: string): void;
}

/** Default cap on cached entries; FIFO eviction keeps memory bounded on a large repo. */
export const DEFAULT_PRIOR_CONTENT_CACHE_MAX = 4096;

/** Build a bounded FIFO prior-content cache. */
export function createPriorContentCache(maxEntries: number = DEFAULT_PRIOR_CONTENT_CACHE_MAX): PriorContentCache {
  const cap = Math.max(1, Math.floor(maxEntries));
  const map = new Map<string, PriorContentEntry>();
  return {
    get(nectar: string): PriorContentEntry | undefined {
      return map.get(nectar);
    },
    set(nectar: string, contentHash: string, content: string): void {
      if (map.has(nectar)) map.delete(nectar);
      map.set(nectar, { contentHash, content });
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}
