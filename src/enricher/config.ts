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

/**
 * Tunables sourced from the `~/.honeycomb/nectar.json` loader (PRD-018k /
 * NEC-041), already resolved with env-over-file precedence by
 * `resolveNectarTunables`. Only the redescribe threshold applies to the
 * enricher; a value present here is used when no explicit code override
 * (`partial`) supplies one, and both fall back to the signed-off default.
 */
export interface EnricherTunables {
  readonly redescribeThreshold?: number;
}

/**
 * Resolve the enricher config. Precedence for the redescribe threshold is:
 * explicit code override (`partial`) > the resolved config-file/env tunable
 * (`tunables`) > the signed-off {@link DEFAULT_REDESCRIBE_THRESHOLD}. The other
 * fields default from code as before.
 */
export function resolveEnricherConfig(
  partial: Partial<EnricherConfig> = {},
  tunables: EnricherTunables = {},
): EnricherConfig {
  return {
    pollIntervalMs: partial.pollIntervalMs ?? DEFAULT_ENRICHER_POLL_INTERVAL_MS,
    redescribeThreshold:
      partial.redescribeThreshold ?? tunables.redescribeThreshold ?? DEFAULT_REDESCRIBE_THRESHOLD,
    persistentFailureThreshold: partial.persistentFailureThreshold ?? DEFAULT_PERSISTENT_FAILURE_THRESHOLD,
    batchSize: partial.batchSize ?? DEFAULT_ENRICHER_BATCH_SIZE,
  };
}
