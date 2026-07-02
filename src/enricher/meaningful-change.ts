/**
 * The meaningful-change heuristic (PRD-016a / AC-3, AC-4).
 */

import type { HiveGraphVersionRow } from "../hive-graph/model.js";
import { DEFAULT_REDESCRIBE_THRESHOLD } from "./config.js";
import { contentJaccardSimilarity } from "./jaccard.js";

export type MeaningfulChangeVerdict = "cosmetic" | "meaningful";

export interface MeaningfulChangeInput {
  readonly newContent: string;
  readonly priorContent: string;
  readonly priorDescribed: HiveGraphVersionRow;
  readonly threshold?: number;
}

export interface CosmeticInheritancePatch {
  readonly title: string;
  readonly description: string;
  readonly concepts: string;
  readonly embedding: number[] | null;
  readonly describeModel: string;
  readonly describeStatus: "described";
  readonly describedAt: string;
}

export function inheritedFromMarker(prevContentHash: string): string {
  return `inherited-from:${prevContentHash}`;
}

/** Classify a content delta as cosmetic (inherit) or meaningful (queue). */
export function classifyMeaningfulChange(input: MeaningfulChangeInput): MeaningfulChangeVerdict {
  const threshold = input.threshold ?? DEFAULT_REDESCRIBE_THRESHOLD;
  const similarity = contentJaccardSimilarity(input.priorContent, input.newContent);
  return similarity >= threshold ? "cosmetic" : "meaningful";
}

/** Build the row patch for a cosmetic inheritance (no LLM call). */
export function buildCosmeticInheritancePatch(
  priorDescribed: HiveGraphVersionRow,
  describedAt: string,
): CosmeticInheritancePatch {
  return {
    title: priorDescribed.title,
    description: priorDescribed.description,
    concepts: priorDescribed.concepts,
    embedding: priorDescribed.embedding,
    describeModel: inheritedFromMarker(priorDescribed.contentHash),
    describeStatus: "described",
    describedAt,
  };
}

/** Apply a cosmetic inheritance patch onto a pending version row. */
export function applyCosmeticInheritance(
  row: HiveGraphVersionRow,
  priorDescribed: HiveGraphVersionRow,
  describedAt: string,
): HiveGraphVersionRow {
  const patch = buildCosmeticInheritancePatch(priorDescribed, describedAt);
  return {
    ...row,
    title: patch.title,
    description: patch.description,
    concepts: patch.concepts,
    embedding: patch.embedding,
    describeModel: patch.describeModel,
    describeStatus: patch.describeStatus,
    describedAt: patch.describedAt,
  };
}
