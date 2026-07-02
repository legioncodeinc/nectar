/**
 * Resumability state machine (PRD-007c).
 *
 * A brood is resumable with NO lockfile and NO partial-state marker: the state
 * is fully derivable from `hive_graph_versions.describe_status` (the latest
 * version row per nectar). This module is the pure state machine that maps a
 * file's latest version status to one of the three resumption actions, carried
 * verbatim from `brooding-pipeline.md` § "Resumability":
 *
 *   rule 1  describe_status is terminal (described / skipped-*)  -> SKIP.
 *   rule 2  nectar minted, latest describe_status = pending      -> RE-ENQUEUE.
 *   rule 3  no nectar minted for this path                       -> DISCOVER FRESH.
 *
 * A `failed` row is treated as work-not-yet-done (re-enqueueable), so a re-run
 * of `brood` retries it (US-007c.3). `--force` opts out of rule 1's skip for the
 * non-skipped statuses (described / failed / pending all re-enqueue), while the
 * two skip-* statuses stay skipped (no description is possible for them).
 */
import type { DescribeStatus, HiveGraphVersionRow } from "../hive-graph/model.js";

/** The three resumption actions a next-boot brooder applies. */
export type ResumeAction = "skip" | "re-enqueue" | "discover-fresh";

/**
 * Terminal brood outcomes that rule 1 skips: a described file and the two skip
 * buckets. `failed` and `pending` are NON-terminal (re-enqueueable).
 */
export const BROOD_TERMINAL_STATUSES: readonly DescribeStatus[] = [
  "described",
  "skipped-binary",
  "skipped-too-large",
];

/** True when a describe status is a terminal brood outcome (rule 1 skip). */
export function isTerminalBroodStatus(status: DescribeStatus): boolean {
  return status === "described" || status === "skipped-binary" || status === "skipped-too-large";
}

/** The two skip statuses `--force` must never reset (no description is possible). */
export function isForceProtectedStatus(status: DescribeStatus): boolean {
  return status === "skipped-binary" || status === "skipped-too-large";
}

export interface ClassifyResumeOptions {
  /** `--force`: re-describe every non-skipped file, ignoring existing descriptions. */
  readonly force?: boolean;
}

/**
 * Classify one file for a resumed brood from its LATEST version row status
 * (`undefined` when no nectar was ever minted for the path). Returns the
 * resumption action; the pipeline reuses the nectar for re-enqueue and mints a
 * fresh one for discover-fresh.
 */
export function classifyResume(
  latest: HiveGraphVersionRow | undefined,
  opts: ClassifyResumeOptions = {},
): ResumeAction {
  if (latest === undefined) return "discover-fresh"; // rule 3

  if (opts.force === true) {
    // Force: skip only the two statuses no description can help; re-describe the rest.
    return isForceProtectedStatus(latest.describeStatus) ? "skip" : "re-enqueue";
  }

  if (isTerminalBroodStatus(latest.describeStatus)) return "skip"; // rule 1
  return "re-enqueue"; // rule 2 (pending) + failed re-enqueueable
}
