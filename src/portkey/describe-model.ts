/**
 * The `describe_model` audit seam (PRD-010b).
 *
 * Stamps which model produced a description on a `hive_graph_versions` row and
 * computes which rows `brood --force --model <new>` must reset to `pending` before
 * re-description (AC-3). The CLI verb itself is owned by PRD-007; this module is
 * the pure field logic the integrator wires.
 */
import type { DescribeStatus, HiveGraphVersionRow } from "../hive-graph/model.js";

/** The three skip statuses that `--force` must not reset (AC-3). */
export const SKIPPED_DESCRIBE_STATUSES: readonly DescribeStatus[] = [
  "skipped-too-large",
  "skipped-binary",
  "skipped-deleted",
];

/** True when a row's describe status is one of the brooding skip outcomes. */
export function isSkippedDescribeStatus(status: DescribeStatus): boolean {
  return (
    status === "skipped-too-large" ||
    status === "skipped-binary" ||
    status === "skipped-deleted"
  );
}

/** Structured description payload returned by the Portkey call (brooding/enricher). */
export interface DescriptionPayload {
  readonly title: string;
  readonly description: string;
  readonly concepts: string;
}

/** Field patch applied when a row transitions to `describe_status = 'described'`. */
export interface DescribeModelStamp {
  readonly title: string;
  readonly description: string;
  readonly concepts: string;
  readonly describeModel: string;
  readonly describeStatus: "described";
  readonly describedAt: string;
}

/**
 * Build the audit-stamping patch for a freshly described row (AC-4).
 * `modelId` is the resolved target model for the run (explicit override or activeModel).
 */
export function buildDescribeModelStamp(
  payload: DescriptionPayload,
  modelId: string,
  describedAt: string,
): DescribeModelStamp {
  return {
    title: payload.title,
    description: payload.description,
    concepts: payload.concepts,
    describeModel: modelId,
    describeStatus: "described",
    describedAt,
  };
}

/** Minimal row shape {@link resetForRedescribe} needs. */
export interface RedescribeRow {
  readonly nectar: string;
  readonly contentHash: string;
  readonly describeStatus: DescribeStatus;
}

/** One row reset by `brood --force --model <new>`. */
export interface RedescribeReset {
  readonly nectar: string;
  readonly contentHash: string;
  readonly describeStatus: "pending";
}

/**
 * Given version rows, return the subset that `--force` resets to `pending` (AC-3):
 * every non-skipped row, regardless of prior `described` / `failed` / `pending` state.
 */
export function resetForRedescribe(rows: readonly RedescribeRow[]): RedescribeReset[] {
  const resets: RedescribeReset[] = [];
  for (const row of rows) {
    if (isSkippedDescribeStatus(row.describeStatus)) continue;
    resets.push({
      nectar: row.nectar,
      contentHash: row.contentHash,
      describeStatus: "pending",
    });
  }
  return resets;
}

/** Apply a describe stamp onto a full version row (immutable return for tests/adapters). */
export function applyDescribeModelStamp(
  row: HiveGraphVersionRow,
  stamp: DescribeModelStamp,
): HiveGraphVersionRow {
  return {
    ...row,
    title: stamp.title,
    description: stamp.description,
    concepts: stamp.concepts,
    describeModel: stamp.describeModel,
    describeStatus: stamp.describeStatus,
    describedAt: stamp.describedAt,
  };
}
