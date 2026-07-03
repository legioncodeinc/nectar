/**
 * Brooding cost math (PRD-007b) - the budget contract.
 *
 * {@link BROODING_COST_REFERENCE} carries the 2000-file breakdown, the dollar
 * figures, and the scaling figures VERBATIM from `brooding-pipeline.md` (the
 * highest hallucination-risk surface in the PRD): ~$3.05 total = $0.65 input +
 * $2.40 output across ~2.15M input tokens in ~318 calls; ~$15 for a 10000-file
 * monorepo; ~$0.30 for a 200-file microservice. No number here is rounded or
 * paraphrased.
 *
 * {@link estimateBroodCost} projects those same per-bucket economics onto a
 * SPECIFIC project's actual bucket counts (what `brood --dry-run` prints), using
 * the <=200K-tier Gemini 2.5 Flash pricing (the per-call inputs are well under
 * 200K, so the <=200K rate applies per call, per the source doc).
 */
import { estimateTokens, type BucketedFiles } from "./bucketing.js";

/** Gemini 2.5 Flash pricing, carried verbatim from `brooding-pipeline.md`. */
export const GEMINI_INPUT_PRICE_PER_M_LE_200K = 0.3;
export const GEMINI_OUTPUT_PRICE_PER_M_LE_200K = 2.5;
export const GEMINI_INPUT_PRICE_PER_M_GT_200K = 0.7;
export const GEMINI_OUTPUT_PRICE_PER_M_GT_200K = 5.0;

/**
 * Average output tokens per call (~318 calls x ~3K tokens avg = ~950K output),
 * carried from `brooding-pipeline.md`. Output is the larger cost because
 * descriptions are richer than input file contents on a per-token basis.
 */
export const AVG_OUTPUT_TOKENS_PER_CALL = 3000;

/**
 * The verbatim 2000-file reference table + dollar + scaling figures from
 * `brooding-pipeline.md` § "The cost math". Reproduced exactly; if any figure
 * here disagrees with the source doc, the source doc wins.
 */
export const BROODING_COST_REFERENCE = {
  referenceFileCount: 2000,
  buckets: {
    skipBinary: { files: 200, calls: 0, inputTokens: 0 },
    skipTooLarge: { files: 20, calls: 0, inputTokens: 0 },
    batch: { files: 1500, avgSizeBytes: 2 * 1024, tokensPerFile: 500, filesPerCall: 40, calls: 38, inputTokens: 750_000 },
    solo: { files: 280, avgSizeBytes: 20 * 1024, tokensPerFile: 5000, filesPerCall: 1, calls: 280, inputTokens: 1_400_000 },
  },
  totalCalls: 318,
  totalInputTokens: 2_150_000,
  inputUsd: 0.65,
  outputUsd: 2.4,
  embeddingUsd: 0,
  totalUsd: 3.05,
  monorepo10kUsd: 15,
  microservice200Usd: 0.3,
} as const;

/** A per-project cost estimate (what `--dry-run` prints), from the 007b economics. */
export interface BroodCostEstimate {
  readonly batchCalls: number;
  readonly soloCalls: number;
  readonly totalCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputUsd: number;
  readonly outputUsd: number;
  /** $0 by default (local nomic embeddings); the hosted opt-in is priced by provider. */
  readonly embeddingUsd: number;
  readonly totalUsd: number;
}

export interface EstimateBroodCostOptions {
  /** Output tokens assumed per call (default {@link AVG_OUTPUT_TOKENS_PER_CALL}). */
  readonly outputTokensPerCall?: number;
  readonly inputPricePerM?: number;
  readonly outputPricePerM?: number;
}

/**
 * Estimate a specific project's brooding cost from its bucketed files, using the
 * <=200K-tier Gemini pricing. Input tokens are the sum of the batch groups'
 * estimated tokens plus the solo files' estimated tokens; output tokens are the
 * call count times the per-call average; embeddings are $0 by default.
 */
export function estimateBroodCost(
  bucketed: BucketedFiles,
  opts: EstimateBroodCostOptions = {},
): BroodCostEstimate {
  const outputTokensPerCall = opts.outputTokensPerCall ?? AVG_OUTPUT_TOKENS_PER_CALL;
  const inputPricePerM = opts.inputPricePerM ?? GEMINI_INPUT_PRICE_PER_M_LE_200K;
  const outputPricePerM = opts.outputPricePerM ?? GEMINI_OUTPUT_PRICE_PER_M_LE_200K;

  const batchCalls = bucketed.batches.length;
  const soloCalls = bucketed.soloFiles.length;
  const totalCalls = batchCalls + soloCalls;

  let inputTokens = 0;
  for (const group of bucketed.batches) inputTokens += group.estimatedTokens;
  for (const solo of bucketed.soloFiles) inputTokens += estimateTokens(solo.file.sizeBytes);

  const outputTokens = totalCalls * outputTokensPerCall;
  const inputUsd = (inputTokens / 1_000_000) * inputPricePerM;
  const outputUsd = (outputTokens / 1_000_000) * outputPricePerM;
  const embeddingUsd = 0;

  return {
    batchCalls,
    soloCalls,
    totalCalls,
    inputTokens,
    outputTokens,
    inputUsd,
    outputUsd,
    embeddingUsd,
    totalUsd: inputUsd + outputUsd,
  };
}

export interface UsageCostOptions {
  readonly inputPricePerM?: number;
  readonly outputPricePerM?: number;
}

/**
 * Convert REAL per-call token usage (summed from describe results) into a USD
 * figure, using the same <=200K-tier pricing {@link estimateBroodCost} assumes
 * (brooding review M4 / EX-3): the pipeline sums actual `usage` from every
 * describe call into `BroodResult`, and the daemon's health cost accounting
 * uses this instead of the pre-run estimate.
 */
export function usageCostUsd(
  inputTokens: number,
  outputTokens: number,
  opts: UsageCostOptions = {},
): number {
  const inputPricePerM = opts.inputPricePerM ?? GEMINI_INPUT_PRICE_PER_M_LE_200K;
  const outputPricePerM = opts.outputPricePerM ?? GEMINI_OUTPUT_PRICE_PER_M_LE_200K;
  return (inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM;
}
