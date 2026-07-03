/**
 * `nectar review-matches` command logic (PRD-006d AC-18).
 *
 * Lists the pending low-confidence step-4 candidates (new path <-> candidate
 * missing nectar, with confidence / TLSH distance and a diff preview) and lets
 * the operator accept or reject each:
 *   - accept -> carry the candidate nectar onto the new path (as a
 *     high-confidence step 4 would have) and drop the pending entry;
 *   - reject -> leave the new path minted fresh (it already was, at review time)
 *     and the missing entry in the set; drop the pending entry;
 *   - skip  -> leave the entry for a later review.
 *
 * DELIBERATE SPEC GAP (AC-18): the accept/reject interaction defaults to
 * interactive (list -> choose -> confirm). This module takes the per-candidate
 * decision through an injected `decide` seam so the interactive prompt (wired in
 * the CLI) is the default while tests supply a scripted decider. NO
 * `--accept`/`--reject`/`--all` flag grammar is invented; the flag surface
 * remains a flagged implementation decision.
 */
import type { HiveGraphStore } from "../hive-graph/store.js";
import type { Tenancy } from "../hive-graph/model.js";
import { inTenancy } from "../hive-graph/model.js";
import type { PendingReviewStore, PendingReviewCandidate } from "./review-store.js";
import { carryNectar } from "./ladder.js";

export type ReviewDecision = "accept" | "reject" | "skip";

export interface ReviewMatchesDeps {
  readonly store: HiveGraphStore;
  readonly tenancy: Tenancy;
  readonly pendingReviews: PendingReviewStore;
  /** Per-candidate decision. The interactive prompt (default) or a scripted test decider. */
  decide(candidate: PendingReviewCandidate, preview: string): Promise<ReviewDecision> | ReviewDecision;
  /** Output sink (stdout in the CLI, a capture in tests). */
  out(line: string): void;
  now(): string;
  onEnrichQueued?(nectar: string): void;
}

export interface ReviewMatchesResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly staleDropped: number;
}

/** Build a short human-readable preview for one candidate. */
function buildPreview(store: HiveGraphStore, candidate: PendingReviewCandidate): string {
  const source = store.latestVersion(candidate.candidateNectar);
  const lastKnownPath = source?.path ?? "(unknown)";
  const distance = candidate.distance === null ? "n/a" : String(candidate.distance);
  return [
    `candidate ${candidate.id}`,
    `  new path:        ${candidate.newPath}`,
    `  maybe nectar:    ${candidate.candidateNectar} (last known at ${lastKnownPath})`,
    `  confidence:      ${candidate.confidence.toFixed(3)}  (distance ${distance})`,
    `  new content hash: ${candidate.contentHash}`,
  ].join("\n");
}

export async function runReviewMatches(deps: ReviewMatchesDeps): Promise<ReviewMatchesResult> {
  const items = deps.pendingReviews.list();
  if (items.length === 0) {
    deps.out("No pending matches to review.");
    return { accepted: 0, rejected: 0, skipped: 0, staleDropped: 0 };
  }

  let accepted = 0;
  let rejected = 0;
  let skipped = 0;
  let staleDropped = 0;

  for (const candidate of items) {
    const preview = buildPreview(deps.store, candidate);
    deps.out(preview);
    const decision = await deps.decide(candidate, preview);
    switch (decision) {
      case "accept": {
        // Verify the candidate nectar exists AND is in this tenancy before carrying;
        // an accept must never re-associate a nectar from another project (AC-20).
        const identity = deps.store.getIdentity(candidate.candidateNectar);
        if (identity === undefined || !inTenancy(identity, deps.tenancy)) {
          deps.pendingReviews.remove(candidate.id);
          deps.out(`candidate ${candidate.candidateNectar} is not in scope; dropped stale review`);
          staleDropped += 1;
          break;
        }
        // Stale-content guard (PRD-018d NEC-036, AC-018d.8): the candidate's
        // `contentHash` is a snapshot taken when the review was raised. If the
        // placeholder mint (`mintedNectar`) has since seen a further edit at
        // `newPath` (a step-2 append onto that SAME identity, keyed by path),
        // its latest content hash no longer matches what was queued, so the
        // recorded hash/size/mtime metadata this accept would carry onto the
        // identity is outdated. Resolve as stale instead of carrying it.
        // Checked against the mintedNectar's own version (not "whatever is
        // currently at newPath") so it is precise even when mintedNectar is a
        // synthetic id in a test fixture that was never actually minted (in
        // which case there is nothing to compare and the accept proceeds).
        const mintedVersion = deps.store.latestVersion(candidate.mintedNectar);
        if (mintedVersion !== undefined && mintedVersion.contentHash !== candidate.contentHash) {
          deps.pendingReviews.remove(candidate.id);
          deps.out(
            `candidate ${candidate.candidateNectar} is stale (content at ${candidate.newPath} changed since queued); dropped stale review`,
          );
          staleDropped += 1;
          break;
        }
        const carried = carryNectar(
          deps.store,
          deps.tenancy,
          deps.now(),
          candidate.candidateNectar,
          {
            relPath: candidate.newPath,
            contentHash: candidate.contentHash,
            sizeBytes: candidate.sizeBytes,
            mtimeObserved: candidate.mtimeObserved,
          },
          candidate.confidence,
        );
        deps.pendingReviews.remove(candidate.id);
        if (carried) {
          // Retire the placeholder nectar the ladder minted for newPath at review
          // time, so exactly one identity (the carried one) points at newPath and
          // there is no duplicate. Only when the carry succeeded, and only for a
          // real, in-scope mint that is not the carried nectar itself. The
          // tenancy-scoped delete is the sole deletion path.
          let retiredNote = "";
          const minted = candidate.mintedNectar;
          if (minted !== "" && minted !== candidate.candidateNectar) {
            const mintIdentity = deps.store.getIdentity(minted);
            if (mintIdentity !== undefined && inTenancy(mintIdentity, deps.tenancy)) {
              deps.store.deleteNectar(deps.tenancy, minted);
              retiredNote = `; retired placeholder mint ${minted}`;
            }
          }
          deps.onEnrichQueued?.(candidate.candidateNectar);
          deps.out(`accepted: carried ${candidate.candidateNectar} to ${candidate.newPath}${retiredNote}`);
          accepted += 1;
        } else {
          deps.out(`candidate ${candidate.candidateNectar} no longer exists; dropped stale review`);
          staleDropped += 1;
        }
        break;
      }
      case "reject": {
        deps.pendingReviews.remove(candidate.id);
        deps.out(`rejected: ${candidate.newPath} keeps its fresh nectar ${candidate.mintedNectar}`);
        rejected += 1;
        break;
      }
      case "skip": {
        deps.out(`skipped: ${candidate.newPath} left for later review`);
        skipped += 1;
        break;
      }
      default: {
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  }

  return { accepted, rejected, skipped, staleDropped };
}
