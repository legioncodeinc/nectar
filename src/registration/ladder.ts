/**
 * The 5-step re-association ladder (PRD-006d), from ai/identity-and-reassociation.md.
 *
 * Evaluated top-down per observed file, first match wins:
 *   1. (path, mtime, size) exact  -> same nectar, no-op (no content read).
 *   2. path match, content changed -> same nectar, append a version row.
 *   3. exact content-hash match to a MISSING file -> carry the nectar (move).
 *   4. TLSH fuzzy match to a missing file above a threshold -> carry, flag confidence;
 *      below threshold -> surface for review, do NOT claim, fall through to mint.
 *   5. nothing matches -> mint a fresh nectar (or a copy, with provenance).
 *
 * DELIBERATE SPEC GAP preserved: the fuzzy confidence threshold is NOT pinned
 * here. Step 4 runs only if a `fuzzy` step is injected, and that injected step
 * owns the (deliberately unpinned, "tuned during brooding") threshold. The ladder
 * itself hardcodes no number. Nectars are never deleted or reused (pruning is a
 * separate, explicit, out-of-scope operation).
 */
import type {
  SourceGraphRow,
  SourceGraphVersionRow,
  Tenancy,
} from "../source-graph/model.js";
import type { LatestVersion, SourceGraphStore } from "../source-graph/store.js";
import { mintNectar, nectarCreatedAt } from "../source-graph/ulid.js";
import { sha256Hex } from "../source-graph/hash.js";
import { filenameOf, extOf } from "../source-graph/paths.js";
import { classifyNewFile } from "./copy-detect.js";

/** A file observed on disk, ready to feed the ladder. `readContent` is called only when hashing is needed (not on the step-1 fast path). */
export interface ObservedFile {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly mtimeObserved: string;
  readContent(): string | Uint8Array;
}

/**
 * The injected fuzzy-match step (step 4). It owns fingerprinting, distance, and
 * the deliberately-unpinned confidence threshold. Given the new content and the
 * missing candidates, it returns a confident carry, a low-confidence review, or none.
 */
export interface FuzzyStep {
  match(content: string | Uint8Array, candidates: readonly LatestVersion[]): FuzzyOutcome;
}

export type FuzzyOutcome =
  | { readonly kind: "match"; readonly nectar: string; readonly confidence: number }
  | { readonly kind: "review"; readonly nectar: string; readonly confidence: number }
  | { readonly kind: "none" };

export interface LadderDeps {
  readonly store: SourceGraphStore;
  readonly tenancy: Tenancy;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now(): string;
  /** Whether a repo-relative path currently exists on disk. Distinguishes move (source gone) from copy (source present). */
  existsOnDisk(relPath: string): boolean;
  /** Optional step 4. Omit to disable fuzzy matching entirely (then an edited-moved file mints). */
  readonly fuzzy?: FuzzyStep;
  /** Called with a low-confidence step-4 candidate (surfaced to `review-matches`); the ladder then mints. */
  onReviewNeeded?(candidate: { nectar: string; relPath: string; confidence: number }): void;
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

  // Anything past step 1 requires the content hash.
  const content = file.readContent();
  const hash = sha256Hex(content);

  // Step 2: path is known; compare content.
  if (byPath !== undefined) {
    if (byPath.version.contentHash === hash) {
      // Content identical (mtime/size changed, e.g. `touch`): still a no-op.
      return { step: 2, action: "noop", nectar: byPath.identity.nectar };
    }
    appendEditVersion(deps, byPath, file, hash);
    deps.onEnrichQueued?.(byPath.identity.nectar);
    return { step: 2, action: "append-version", nectar: byPath.identity.nectar };
  }

  // Path is NOT known. Look for an exact content-hash match to another nectar.
  const byHash = store.latestVersionByHash(tenancy, hash);
  if (byHash !== undefined) {
    const sourcePath = byHash.version.path;
    if (sourcePath !== file.relPath && !deps.existsOnDisk(sourcePath)) {
      // Step 3: the source path is gone -> this is a move. Carry the nectar,
      // inherit the description (content unchanged), enqueue no enrich.
      appendCarryVersion(deps, byHash, file, hash, null);
      return { step: 3, action: "carry-nectar", nectar: byHash.identity.nectar };
    }
    // Source still on disk -> a copy. Mint with provenance (step 5).
    return mintOrCopy(deps, file, hash);
  }

  // Step 4: fuzzy match to a missing file (only if an injected fuzzy step exists).
  if (deps.fuzzy !== undefined) {
    const candidates = missingCandidates(deps, file.relPath);
    const outcome = deps.fuzzy.match(content, candidates);
    if (outcome.kind === "match") {
      const carried = store.latestVersion(outcome.nectar);
      const identity = store.getIdentity(outcome.nectar);
      if (carried !== undefined && identity !== undefined) {
        appendCarryVersion(deps, { identity, version: carried }, file, hash, outcome.confidence);
        return { step: 4, action: "carry-nectar", nectar: outcome.nectar };
      }
    } else if (outcome.kind === "review") {
      deps.onReviewNeeded?.({ nectar: outcome.nectar, relPath: file.relPath, confidence: outcome.confidence });
      // Do not claim a low-confidence match; fall through to mint.
    }
  }

  // Step 5: mint (or copy, with provenance).
  return mintOrCopy(deps, file, hash);
}

/** Missing candidates: known latest versions whose current path is gone from disk (and is not this file's path). */
function missingCandidates(deps: LadderDeps, selfPath: string): LatestVersion[] {
  return deps.store
    .listLatestVersions(deps.tenancy)
    .filter((lv) => lv.version.path !== selfPath && !deps.existsOnDisk(lv.version.path));
}

function baseVersion(deps: LadderDeps, file: ObservedFile, hash: string, seq: number): SourceGraphVersionRow {
  const now = deps.now();
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
    describedAt: "",
    describeModel: "",
    describeStatus: "pending",
    observedAt: now,
    orgId: deps.tenancy.orgId,
    workspaceId: deps.tenancy.workspaceId,
    projectId: deps.tenancy.projectId,
    lastUpdateDate: now,
  };
}

/** Step 2: append an edited version (new content, pending description). */
function appendEditVersion(deps: LadderDeps, prev: LatestVersion, file: ObservedFile, hash: string): void {
  const seq = deps.store.nextSeq(prev.identity.nectar);
  const row = baseVersion(deps, file, hash, seq);
  row.nectar = prev.identity.nectar;
  deps.store.appendVersion(row);
  deps.store.touchIdentity(prev.identity.nectar, deps.now());
}

/** Step 3/4: carry a nectar to a new path, inheriting the prior description (content did not change for step 3). */
function appendCarryVersion(
  deps: LadderDeps,
  source: LatestVersion,
  file: ObservedFile,
  hash: string,
  confidence: number | null,
): void {
  const seq = deps.store.nextSeq(source.identity.nectar);
  const row = baseVersion(deps, file, hash, seq);
  row.nectar = source.identity.nectar;
  // Inherit the existing description (the content is the same for an exact move;
  // for a fuzzy carry the enricher can refresh it later, but we keep provenance).
  row.title = source.version.title;
  row.description = source.version.description;
  row.concepts = source.version.concepts;
  row.embedding = source.version.embedding;
  row.describedAt = source.version.describedAt;
  row.describeModel = source.version.describeModel;
  row.describeStatus = source.version.describeStatus;
  row.confidence = confidence;
  deps.store.appendVersion(row);
  deps.store.touchIdentity(source.identity.nectar, deps.now());
}

/** Step 5: mint a fresh nectar, or record a copy with provenance. */
function mintOrCopy(deps: LadderDeps, file: ObservedFile, hash: string): LadderResult {
  const decision = classifyNewFile(deps.store, deps.tenancy, hash);
  const nectar = mintNectar();
  const now = deps.now();

  const identity: SourceGraphRow = {
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

  const row = baseVersion(deps, file, hash, 0);
  row.nectar = nectar;
  deps.store.appendVersion(row);
  deps.onEnrichQueued?.(nectar);

  return { step: 5, action: decision.action === "copy" ? "copy" : "mint", nectar };
}
