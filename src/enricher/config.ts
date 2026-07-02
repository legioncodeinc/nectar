/**
 * Enricher tunables (PRD-016 / decision #34).
 *
 * All values are config-overridable via `~/.honeycomb/nectar.json`; these are
 * the signed-off defaults from `ai/enricher-and-llm-model.md`.
 */

/** Default enricher poll interval (30s). */
export const DEFAULT_ENRICHER_POLL_INTERVAL_MS = 30_000 as const;

/** Watcher intake debounce lives in `registration/fs-watch.ts` (500ms). */
export const DEFAULT_WATCHER_DEBOUNCE_MS = 500 as const;

/** Cosmetic-change inheritance threshold (Jaccard on token multisets). */
export const DEFAULT_REDESCRIBE_THRESHOLD = 0.85 as const;

/** Consecutive failed cycles before the persistent alert fires. */
export const DEFAULT_PERSISTENT_FAILURE_THRESHOLD = 5 as const;

/** Default batch size for pending-work selection (non-solo). */
export const DEFAULT_ENRICHER_BATCH_SIZE = 10 as const;

/** Rough USD estimate for Gemini 2.5 Flash per-token (observability only). */
export const ENRICHER_INPUT_USD_PER_TOKEN = 0.65 / 1_000_000;
export const ENRICHER_OUTPUT_USD_PER_TOKEN = 2.4 / 1_000_000;

export interface EnricherConfig {
  readonly pollIntervalMs: number;
  readonly redescribeThreshold: number;
  readonly persistentFailureThreshold: number;
  readonly batchSize: number;
}

export function resolveEnricherConfig(partial: Partial<EnricherConfig> = {}): EnricherConfig {
  return {
    pollIntervalMs: partial.pollIntervalMs ?? DEFAULT_ENRICHER_POLL_INTERVAL_MS,
    redescribeThreshold: partial.redescribeThreshold ?? DEFAULT_REDESCRIBE_THRESHOLD,
    persistentFailureThreshold: partial.persistentFailureThreshold ?? DEFAULT_PERSISTENT_FAILURE_THRESHOLD,
    batchSize: partial.batchSize ?? DEFAULT_ENRICHER_BATCH_SIZE,
  };
}
