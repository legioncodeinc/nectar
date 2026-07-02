/**
 * Enricher steady-state loop (PRD-016).
 *
 * Export surface for daemon boot integration. The orchestrator wires
 * `createEnricherLoop` alongside registration, projection, and health.
 */

export {
  DEFAULT_ENRICHER_BATCH_SIZE,
  DEFAULT_ENRICHER_POLL_INTERVAL_MS,
  DEFAULT_PERSISTENT_FAILURE_THRESHOLD,
  DEFAULT_REDESCRIBE_THRESHOLD,
  DEFAULT_WATCHER_DEBOUNCE_MS,
  ENRICHER_INPUT_USD_PER_TOKEN,
  ENRICHER_OUTPUT_USD_PER_TOKEN,
  resolveEnricherConfig,
  type EnricherConfig,
} from "./config.js";

export { tokenizeSource, tokenMultiset } from "./tokenize.js";
export { multisetJaccard, contentJaccardSimilarity } from "./jaccard.js";

export {
  applyCosmeticInheritance,
  buildCosmeticInheritancePatch,
  classifyMeaningfulChange,
  inheritedFromMarker,
  type CosmeticInheritancePatch,
  type MeaningfulChangeInput,
  type MeaningfulChangeVerdict,
} from "./meaningful-change.js";

export { buildPendingWorkSql, selectPendingWorkInMemory, type PendingWorkRow } from "./pending-query.js";
export { buildUpdateVersionSql } from "./sql-update.js";

export { EnricherInMemoryStore, type EnricherStore, type EnricherWorkItem } from "./store.js";

export {
  describeFilesBatch,
  embeddingText,
  isContextWindowError,
  parseDescribeResponse,
  type DescribeBatchResult,
  type DescribeFileInput,
} from "./describe.js";

export {
  acknowledgePersistentAlert,
  acknowledgePersistentAlert as acknowledgeEnricherAlert,
  advancePersistentFailureState,
  createPersistentFailureState,
  createPersistentFailureState as createEnricherFailureState,
  enrichmentHalted,
  enrichmentHalted as isEnrichmentHalted,
  splitBatch,
  type PersistentFailureState,
} from "./failure.js";

export {
  consoleCycleLogSink,
  emptyCycleStats,
  estimateCostUsd,
  mergeCycleStats,
  type EnricherCycleLogSink,
  type EnricherCycleStats,
} from "./observability.js";

export {
  runEnricherCycle,
  type ContentReader,
  type EnricherCycleDeps,
  type EnricherCycleResult,
} from "./cycle.js";

export { createEnricherLoop, type EnricherLoop, type EnricherLoopOptions } from "./loop.js";

/** Watcher intake debounce re-export for integrators (PRD-016a AC-2; owned by PRD-006). */
export { DEFAULT_DEBOUNCE_MS as WATCHER_INTAKE_DEBOUNCE_MS } from "../registration/fs-watch.js";
