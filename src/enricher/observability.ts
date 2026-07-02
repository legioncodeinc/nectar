/**
 * Per-cycle observability (PRD-016c AC-5).
 */

import { ENRICHER_INPUT_USD_PER_TOKEN, ENRICHER_OUTPUT_USD_PER_TOKEN } from "./config.js";

export interface EnricherCycleStats {
  filesDescribed: number;
  filesInherited: number;
  filesFailed: number;
  filesSkippedDeleted: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  queueDepth: number;
}

export function emptyCycleStats(queueDepth = 0): EnricherCycleStats {
  return {
    filesDescribed: 0,
    filesInherited: 0,
    filesFailed: 0,
    filesSkippedDeleted: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    queueDepth,
  };
}

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return inputTokens * ENRICHER_INPUT_USD_PER_TOKEN + outputTokens * ENRICHER_OUTPUT_USD_PER_TOKEN;
}

export function mergeCycleStats(base: EnricherCycleStats, delta: Partial<EnricherCycleStats>): EnricherCycleStats {
  const inputTokens = base.inputTokens + (delta.inputTokens ?? 0);
  const outputTokens = base.outputTokens + (delta.outputTokens ?? 0);
  return {
    filesDescribed: base.filesDescribed + (delta.filesDescribed ?? 0),
    filesInherited: base.filesInherited + (delta.filesInherited ?? 0),
    filesFailed: base.filesFailed + (delta.filesFailed ?? 0),
    filesSkippedDeleted: base.filesSkippedDeleted + (delta.filesSkippedDeleted ?? 0),
    inputTokens,
    outputTokens,
    estimatedUsd: estimateCostUsd(inputTokens, outputTokens),
    queueDepth: delta.queueDepth ?? base.queueDepth,
  };
}

export interface EnricherCycleLogSink {
  logCycle(stats: EnricherCycleStats): void;
}

/** Default sink: structured console line (fail-soft). */
export const consoleCycleLogSink: EnricherCycleLogSink = {
  logCycle(stats) {
    try {
      console.info(
        JSON.stringify({
          component: "enricher",
          filesDescribed: stats.filesDescribed,
          filesInherited: stats.filesInherited,
          filesFailed: stats.filesFailed,
          filesSkippedDeleted: stats.filesSkippedDeleted,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          estimatedUsd: stats.estimatedUsd,
          queueDepth: stats.queueDepth,
        }),
      );
    } catch {
      // fail-soft
    }
  },
};
