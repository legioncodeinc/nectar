/**
 * The 5-step re-association ladder (PRD-006d), from ai/identity-and-reassociation.md.
 *
 * Evaluated top-down per observed file, first match wins:
 *   1. (path, mtime, size) exact  -> same nectar, no-op (no content read).
 *   2. path match, content changed -> same nectar, append a version row.
 *   3. exact content-hash match to a MISSING file -> carry the nectar (move).
 *   4. TLSH fuzzy match to a missing file above a threshold -> carry, flag confidence;
 *      below the high band -> surface for review, do NOT claim, fall through to mint.
 *   5. nothing matches -> mint a fresh nectar (or a copy, with provenance).
 *
 * DELIBERATE SPEC GAP preserved: the fuzzy confidence threshold is NOT pinned
 * here. Step 4 runs only if a `fuzzy` step is injected, and that injected step
 * owns the (deliberately unpinned, "tuned during brooding") threshold. The ladder
 * itself hardcodes no number. Nectars are never deleted or reused (pruning is a
 * separate, explicit operation, `prune --confirm`, PRD-006d / prune-cli.ts).
 */
import type {
  HiveGraphRow,
  HiveGraphVersionRow,
  Tenancy,
} from "../hive-graph/model.js";
import { inTenancy } from "../hive-graph/model.js";
import type { LatestVersion, HiveGraphStore } from "../hive-graph/store.js";
import { mintNectar, nectarCreatedAt } from "../hive-graph/ulid.js";
import { sha256Hex } from "../hive-graph/hash.js";
import { filenameOf, extOf } from "../hive-graph/paths.js";
import { classifyNewFile } from "./copy-detect.js";
// Value import; tlsh's back-edge to this module is `import type` (erased), so there is no runtime cycle.
import { computeFingerprint } from "./tlsh.js";

/** A file observed on disk, ready to feed the ladder. `readContent` is called only when hashing is needed (not on the step-1 fast path). */
export interface ObservedFile {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly mtimeObserved: string;
  readContent(): string | Uint8Array;
}

/**
 * A missing-file candidate the fuzzy step (step 4) consults. It is a superset of
 * {@link LatestVersion} (so it still carries `.identity` and `.version`, keeping
 * every existing injected fuzzy step working) plus the missing nectar's latest
 * TLSH fingerprint. The fingerprint is read from the PERSISTED
 * `hive_graph_versions.fingerprint` column of the candidate's latest version,
 * so step 4 can match against a now-gone file without re-reading it AND survive a
 * daemon restart: this is how the missing-files set "carries each missing
 * nectar's latest content hash AND its TLSH fingerprint" (PRD-006b AC /
 * identity-and-reassociation.md Step 3).
 */
export interface FuzzyCandidate extends LatestVersion {
  /** The candidate's latest TLSH fingerprint, or null when none was cached. */
  readonly fingerprint: string | null;
}

/**
 * The injected fuzzy-match step (step 4). It owns fingerprinting, distance, the
 * +/-20% size-bucket optimization, and the deliberately-unpinned confidence
 * threshold. Given the new content and the missing candidates (each carrying a
 * fingerprint), it returns a confident carry, a low-confidence review, or none.
 */
export interface FuzzyStep {
  match(content: string | Uint8Array, candidates: readonly FuzzyCandidate[]): FuzzyOutcome;
}

export type FuzzyOutcome =
  | { readonly kind: "match"; readonly nectar: string; readonly confidence: number; readonly distance?: number }
  | { readonly kind: "review"; readonly nectar: string; readonly confidence: number; readonly distance?: number }
  | { readonly kind: "none" };

/** A low-confidence step-4 candidate surfaced to `review-matches` (AC-18). Carries everything an accept needs. */
export interface ReviewCandidate {
  /** The candidate MISSING nectar a human may confirm the new path is. */
  readonly nectar: string;
  /** The new path (already minted fresh at review time; accept re-associates it). */
  readonly relPath: string;
  readonly confidence: number;
  readonly distance: number | null;
  /** The new file's content hash (so accept can append the carried version row without re-reading disk). */
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mtimeObserved: string;
  /** The fresh nectar minted for `relPath` when the review was raised. */
  readonly mintedNectar: string;
}

export interface LadderDeps {
  readonly store: HiveGraphStore;
  readonly tenancy: Tenancy;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now(): string;
  /** Whether a repo-relative path currently exists on disk. Distinguishes move (source gone) from copy (source present). */
  existsOnDisk(relPath: string): boolean;
  /** Optional step 4. Omit to disable fuzzy matching entirely (then an edited-moved file mints). */
  readonly fuzzy?: FuzzyStep;
  /** Called with a low-confidence step-4 candidate (surfaced to `review-matches`); the ladder then mints. */
  onReviewNeeded?(candidate: ReviewCandidate): void;
  /** Called when a version row is appended and warrants (re)description. */
  onEnrichQueued?(nectar: string): void;
}

export type LadderStep = 1 | 2 | 3 | 4 | 5;
export type LadderAction = "noop" | "append-version" | "carry-nectar" | "mint" | "copy";

export interface LadderResult {
  readonly step: LadderStep;
  readonly action: LadderAction;
  readonly nectar: string;
}

/** Run the ladder for one observed file. Returns which step fired and the nectar it resolved to. */
export function reassociate(file: ObservedFile, deps: LadderDeps): LadderResult {
  const { store, tenancy } = deps;
  const byPath = store.latestVersionByPath(tenancy, file.relPath);

  // Step 1: (path, mtime, size) exact -> unchanged, no read, no hash.
  if (
    byPath !== undefined &&
    byPath.version.mtimeObserved === file.mtimeObserved &&
    byPath.version.sizeBytes === file.sizeBytes
  ) {
    return { step: 1, action: "noop", nectar: byPath.identity.nectar };
  }

  // Anything past step 1 requires the content hash (and the persisted fingerprint).
  const content = file.readContent();
  const hash = sha256Hex(content);
  const fingerprint = computeFingerprint(content);

  // Step 2: path is known; compare content.
  if (byPath !== undefined) {
    if (byPath.version.contentHash === hash) {
      // Content identical (mtime/size changed, e.g. `touch`): still a no-op.
      return { step: 2, action: "noop", nectar: byPath.identity.nectar };
    }
    appendEditVersion(deps, byPath, file, hash, fingerprint);
    deps.onEnrichQueued?.(byPath.identity.nectar);
    return { step: 2, action: "append-version", nectar: byPath.identity.nectar };
  }

  // Path is NOT known. Look for an exact content-hash match to another nectar.
  const byHash = store.latestVersionByHash(tenancy, hash);
  if (byHash !== undefined) {
    const sourcePath = byHash.version.path;
    if (sourcePath !== file.relPath && !deps.existsOnDisk(sourcePath)) {
      // Step 3: the source path is gone -> this is a move. Carry the nectar,
      // inherit the description (content unchanged), enqueue no enrich. The
      // carry is refused (falls through to mint) if the source is out of tenancy.
      if (writeCarriedRow(store, tenancy, deps.now(), byHash, file, hash, null, fingerprint)) {
        return { step: 3, action: "carry-nectar", nectar: byHash.identity.nectar };
      }
    }
    // Source still on disk -> a copy. Mint with provenance (step 5).
    return mintOrCopy(deps, file, hash, fingerprint);
  }

  // Step 4: fuzzy match to a missing file (only if an injected fuzzy step exists).
  // Candidates read the missing nectar's PERSISTED fingerprint column, so the
  // match survives a daemon restart (no in-process cache).
  let review: { nectar: string; confidence: number; distance: number | null } | null = null;
  if (deps.fuzzy !== undefined) {
    const candidates: FuzzyCandidate[] = missingCandidates(deps, file.relPath).map((lv) => ({
      ...lv,
      fingerprint: lv.version.fingerprint ?? null,
    }));
    const outcome = deps.fuzzy.match(content, candidates);
    switch (outcome.kind) {
      case "match": {
        const carried = store.latestVersion(outcome.nectar);
        const identity = store.getIdentity(outcome.nectar);
        if (
          carried !== undefined &&
          identity !== undefined &&
          writeCarriedRow(
            store,
            tenancy,
            deps.now(),
            { identity, version: carried },
            file,
            hash,
            outcome.confidence,
            fingerprint,
          )
        ) {
          // High-confidence carry: content changed, so (re)describe (PRD-006d AC step-4 high band).
          deps.onEnrichQueued?.(outcome.nectar);
          return { step: 4, action: "carry-nectar", nectar: outcome.nectar };
        }
        break;
      }
      case "review": {
        review = { nectar: outcome.nectar, confidence: outcome.confidence, distance: outcome.distance ?? null };
        break;
      }
      case "none":
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  // Step 5: mint (or copy, with provenance). A below-high fuzzy candidate is
  // surfaced for review AFTER the fresh mint so the record can name the minted
  // nectar; accepting it later re-associates the missing nectar onto this path.
  const result = mintOrCopy(deps, file, hash, fingerprint);
  if (review !== null) {
    deps.onReviewNeeded?.({
      nectar: review.nectar,
      relPath: file.relPath,
      confidence: review.confidence,
      distance: review.distance,
      contentHash: hash,
      sizeBytes: file.sizeBytes,
      mtimeObserved: file.mtimeObserved,
      mintedNectar: result.nectar,
    });
  }
  return result;
}

/** Missing candidates: known latest versions whose current path is gone from disk (and is not this file's path). */
function missingCandidates(deps: LadderDeps, selfPath: string): LatestVersion[] {
  return deps.store
    .listLatestVersions(deps.tenancy)
    .filter((lv) => lv.version.path !== selfPath && !deps.existsOnDisk(lv.version.path));
}

function baseVersion(
  tenancy: Tenancy,
  now: string,
  file: { relPath: string; sizeBytes: number; mtimeObserved: string },
  hash: string,
  seq: number,
  fingerprint: string | null,
): HiveGraphVersionRow {
  return {
    nectar: "",
    contentHash: hash,
    seq,
    path: file.relPath,
    filename: filenameOf(file.relPath),
    ext: extOf(file.relPath),
    sizeBytes: file.sizeBytes,
    mtimeObserved: file.mtimeObserved,
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    fingerprint,
    describedAt: "",
    describeModel: "",
    describeStatus: "pending",
    observedAt: now,
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };
}

/** Step 2: append an edited version (new content, pending description). Persists the content fingerprint. */
function appendEditVersion(
  deps: LadderDeps,
  prev: LatestVersion,
  file: ObservedFile,
  hash: string,
  fingerprint: string,
): void {
  const seq = deps.store.nextSeq(prev.identity.nectar);
  const row = baseVersion(deps.tenancy, deps.now(), file, hash, seq, fingerprint);
  row.nectar = prev.identity.nectar;
  deps.store.appendVersion(row);
  deps.store.touchIdentity(prev.identity.nectar, deps.now());
}

/**
 * Step 3/4 carry: append a version row that carries `source`'s nectar to a new
 * path, inheriting the prior description (content is identical for an exact
 * step-3 move; a fuzzy carry keeps provenance and can be re-described later).
 * Shared by the ladder and by `review-matches` accept.
 *
 * Returns false (and writes nothing) when `source.identity` is outside
 * `tenancy`: a carry must never move a nectar minted under another project onto
 * a path in this one (AC-20). Callers treat false as "no carry" and fall through
 * to a fresh mint.
 */
function writeCarriedRow(
  store: HiveGraphStore,
  tenancy: Tenancy,
  now: string,
  source: LatestVersion,
  file: { relPath: string; sizeBytes: number; mtimeObserved: string },
  hash: string,
  confidence: number | null,
  fingerprint: string | null,
): boolean {
  if (!inTenancy(source.identity, tenancy)) return false; // refuse a cross-project carry
  const seq = store.nextSeq(source.identity.nectar);
  const row = baseVersion(tenancy, now, file, hash, seq, fingerprint);
  row.nectar = source.identity.nectar;
  row.title = source.version.title;
  row.description = source.version.description;
  row.concepts = source.version.concepts;
  row.embedding = source.version.embedding;
  row.describedAt = source.version.describedAt;
  row.describeModel = source.version.describeModel;
  row.describeStatus = source.version.describeStatus;
  row.confidence = confidence;
  store.appendVersion(row);
  store.touchIdentity(source.identity.nectar, now);
  return true;
}

/**
 * Carry an existing nectar onto a new path (the `review-matches` accept path,
 * AC-18): append a carried version row for `sourceNectar` at `target`. Returns
 * false if the source nectar no longer exists. This is exactly what a
 * high-confidence step 4 does, applied on human confirmation instead.
 *
 * The carried row's `fingerprint` is left NULL here: the accept path works from
 * the persisted pending-candidate metadata (hash/size/mtime), not the file
 * content, so there is nothing to fingerprint. It self-heals on the next
 * observation of the file (a step-2 edit persists a fresh fingerprint), per the
 * nullable-column contract.
 */
export function carryNectar(
  store: HiveGraphStore,
  tenancy: Tenancy,
  now: string,
  sourceNectar: string,
  target: { relPath: string; contentHash: string; sizeBytes: number; mtimeObserved: string },
  confidence: number | null,
): boolean {
  const version = store.latestVersion(sourceNectar);
  const identity = store.getIdentity(sourceNectar);
  if (version === undefined || identity === undefined) return false;
  // writeCarriedRow enforces the tenancy guard and returns false on a cross-project source.
  return writeCarriedRow(
    store,
    tenancy,
    now,
    { identity, version },
    { relPath: target.relPath, sizeBytes: target.sizeBytes, mtimeObserved: target.mtimeObserved },
    target.contentHash,
    confidence,
    null,
  );
}

/** Step 5: mint a fresh nectar, or record a copy with provenance. Persists the content fingerprint. */
function mintOrCopy(deps: LadderDeps, file: ObservedFile, hash: string, fingerprint: string): LadderResult {
  const decision = classifyNewFile(deps.store, deps.tenancy, hash);
  const nectar = mintNectar();
  const now = deps.now();

  const identity: HiveGraphRow = {
    nectar,
    kind: "file",
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: decision.action === "copy" ? decision.sourceNectar : "",
    forkContentHash: decision.action === "copy" ? decision.forkContentHash : "",
    orgId: deps.tenancy.orgId,
    workspaceId: deps.tenancy.workspaceId,
    projectId: deps.tenancy.projectId,
    lastUpdateDate: now,
  };
  deps.store.insertIdentity(identity);

  const row = baseVersion(deps.tenancy, now, file, hash, 0, fingerprint);
  row.nectar = nectar;
  deps.store.appendVersion(row);
  deps.onEnrichQueued?.(nectar);

  return { step: 5, action: decision.action === "copy" ? "copy" : "mint", nectar };
}
