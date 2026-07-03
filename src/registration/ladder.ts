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

/**
 * The fast-path stat cache (PRD-018c NEC-035 / AC-018c.9): a side structure
 * (never a hive-graph column) recording each path's freshest observed
 * mtime/size when step 2 finds the content UNCHANGED (a touch, a branch-switch
 * mtime bump). `hive_graph_versions.mtimeObserved`/`sizeBytes` are documented
 * as "not authoritative; a fast-path cache key only" (model.ts) - the version
 * ROW is never rewritten (append-only stays append-only); this cache is the
 * "cheap side column" the PRD's fix direction offers as the alternative to an
 * in-place UPDATE, so it carries no PRD-018g NEC-017 precedent. Step 1 prefers
 * a cache hit over the stored version row's stat so a touch is remembered
 * without a new version row, keeping the step-1 fast path fast forever
 * instead of degrading to a full re-hash on every future observation.
 */
export interface StatCache {
  get(relPath: string): { readonly mtimeObserved: string; readonly sizeBytes: number } | undefined;
  set(relPath: string, stat: { readonly mtimeObserved: string; readonly sizeBytes: number }): void;
  delete(relPath: string): void;
}

/** A simple `Map`-backed {@link StatCache}. One instance persists for the lifetime of a `RegistrationService` (across cycles, not across a daemon restart - a restart re-warms via the store's own version-row stat, just without the touch optimization until the next touch). */
export function createInMemoryStatCache(): StatCache {
  const map = new Map<string, { mtimeObserved: string; sizeBytes: number }>();
  return {
    get: (relPath) => map.get(relPath),
    set: (relPath, stat) => {
      map.set(relPath, { mtimeObserved: stat.mtimeObserved, sizeBytes: stat.sizeBytes });
    },
    delete: (relPath) => {
      map.delete(relPath);
    },
  };
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
  /**
   * PRD-018c NEC-035 / AC-018c.9: the fast-path stat cache. Omit to preserve
   * pre-018c behavior (a step-2 touch is never remembered, so every future
   * observation re-hashes).
   */
  readonly statCache?: StatCache;
  /**
   * PRD-018c NEC-034 / AC-018c.8: true when the workspace filesystem is
   * case-insensitive (probed once per workspace, never guessed from
   * `process.platform`). Enables the step-3 case-only-rename guard below.
   * Omit/false preserves pre-018c case-sensitive behavior exactly.
   */
  readonly caseInsensitive?: boolean;
  /**
   * PRD-018c EX-4 (change-detection review M7): the set of KNOWN paths
   * currently missing from disk, computed ONCE per resync/settle cycle
   * (`service.ts`'s `runCycle`) and passed in here so step 4's candidate scan
   * is an O(1) set lookup instead of an `existsOnDisk` stat per known path per
   * new file. Omit to fall back to the pre-018c per-candidate `existsOnDisk`
   * stat (unit tests calling `reassociate` directly need no change).
   */
  readonly missingPaths?: ReadonlySet<string>;
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

  // Step 1: (path, mtime, size) exact -> unchanged, no read, no hash. A
  // fast-path cache hit (NEC-035 / AC-018c.9) takes precedence over the
  // stored version row's own stat: it is the freshest stat the ladder has
  // ever observed for this path since the content last actually changed.
  const cachedStat = deps.statCache?.get(file.relPath);
  const effectiveMtime = cachedStat?.mtimeObserved ?? byPath?.version.mtimeObserved;
  const effectiveSize = cachedStat?.sizeBytes ?? byPath?.version.sizeBytes;
  if (byPath !== undefined && effectiveMtime === file.mtimeObserved && effectiveSize === file.sizeBytes) {
    return { step: 1, action: "noop", nectar: byPath.identity.nectar };
  }

  // Anything past step 1 requires the content hash (and the persisted fingerprint).
  const content = file.readContent();
  const hash = sha256Hex(content);
  const fingerprint = computeFingerprint(content);

  // Step 2: path is known; compare content.
  if (byPath !== undefined) {
    if (byPath.version.contentHash === hash) {
      // Content identical (mtime/size changed, e.g. `touch`): still a no-op,
      // but remember the fresh stat (NEC-035) so the NEXT observation of this
      // unchanged file takes the step-1 fast path instead of re-hashing.
      deps.statCache?.set(file.relPath, { mtimeObserved: file.mtimeObserved, sizeBytes: file.sizeBytes });
      return { step: 2, action: "noop", nectar: byPath.identity.nectar };
    }
    // Real content change: the fresh version row already carries the correct
    // stat, so any stale cache entry from a prior touch must not shadow it.
    deps.statCache?.delete(file.relPath);
    appendEditVersion(deps, byPath, file, hash, fingerprint);
    deps.onEnrichQueued?.(byPath.identity.nectar);
    return { step: 2, action: "append-version", nectar: byPath.identity.nectar };
  }

  // Path is NOT known. Look for an exact content-hash match to another nectar.
  const byHash = store.latestVersionByHash(tenancy, hash);
  if (byHash !== undefined) {
    const sourcePath = byHash.version.path;
    // NEC-034 / AC-018c.8: on a case-insensitive filesystem, a case-only
    // rename (`Foo.ts` -> `foo.ts`) leaves `existsOnDisk(sourcePath)` true
    // (the OS resolves either casing to the same file), which would
    // misclassify the rename as a copy. `file.relPath` is the TRUE on-disk
    // casing of the just-observed path (from `fs.watch`/`readdir`, never
    // user-typed), so a source that case-folds equal but differs in exact
    // casing is unambiguously the same file, renamed - no filesystem
    // existence check needed for that specific determination.
    const caseOnlyRename =
      deps.caseInsensitive === true &&
      sourcePath !== file.relPath &&
      sourcePath.toLowerCase() === file.relPath.toLowerCase();
    if (sourcePath !== file.relPath && (caseOnlyRename || !deps.existsOnDisk(sourcePath))) {
      // Step 3: the source path is gone (or case-only renamed) -> this is a
      // move. Carry the nectar, inherit the description (content unchanged),
      // enqueue no enrich. The carry is refused (falls through to mint) if
      // the source is out of tenancy. `file.relPath` (the fresh casing) is
      // what gets written, so stored rows preserve on-disk casing.
      if (writeCarriedRow(store, tenancy, deps.now(), byHash, file, hash, null, fingerprint)) {
        deps.statCache?.delete(sourcePath);
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

/**
 * Missing candidates: known latest versions whose current path is gone from
 * disk (and is not this file's path). PRD-018c EX-4 (change-detection review
 * M7): when the caller supplies `deps.missingPaths` (computed ONCE per
 * settle/resync cycle in `service.ts`'s `runCycle`), this is an O(1) set
 * lookup per known version instead of an `existsOnDisk` stat - eliminating the
 * O(known-files) stat-per-new-file cost the review flagged. Falls back to the
 * pre-018c per-candidate `existsOnDisk` stat when `missingPaths` is omitted
 * (unit tests calling `reassociate` directly need no change).
 */
function missingCandidates(deps: LadderDeps, selfPath: string): LatestVersion[] {
  const missing = deps.missingPaths;
  if (missing !== undefined) {
    return deps.store
      .listLatestVersions(deps.tenancy)
      .filter((lv) => lv.version.path !== selfPath && missing.has(lv.version.path));
  }
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

/**
 * PRD-018d (NEC-036): the idempotent crash-repair sweep for the ladder's
 * multi-write actions.
 *
 * Every ladder action that mutates the store is a SEQUENCE of two writes
 * (mint = `insertIdentity` + `appendVersion`; edit/carry = `appendVersion` +
 * `touchIdentity`; review-accept = carry + `deleteNectar` of the placeholder,
 * `review-cli.ts`), with no atomicity across a crash between them (the
 * sync/async store bridge that would let these be one transaction is
 * PRD-018b's construction, a Non-Goal here). This sweep heals the three
 * resulting invariant violations instead, and is idempotent: running it again
 * on an already-healed store finds nothing to do.
 *
 *   1. An orphan identity (a mint that crashed after `insertIdentity`, before
 *      `appendVersion`): zero version rows. There is no content to construct a
 *      version from, so the only sound repair is deleting the orphan (the same
 *      `deleteNectar` review-accept already uses to retire a placeholder -
 *      this sweep is not a new deletion path, just a new caller of the
 *      existing one). Requires the OPTIONAL `store.listIdentities` (skipped,
 *      not guessed at, when the adapter omits it).
 *   2. A stale `identity.lastUpdateDate` (an edit/carry that crashed after
 *      `appendVersion`, before `touchIdentity`): the identity's timestamp
 *      predates its own latest version's `lastUpdateDate`, which feeds prune
 *      eligibility directly (`prune-cli.ts`). Healed by re-running
 *      `touchIdentity` with the version's own timestamp.
 *   3. Two identities both claiming one path as their latest version's `path`
 *      (a review-accept that crashed after the carry landed, before the
 *      placeholder delete ran): under normal ladder operation a carry only
 *      ever targets a path with NO existing identity, so this can only be a
 *      crash artifact. The carried identity's version always has a strictly
 *      later `observedAt` than the placeholder's original mint, so the
 *      survivor is the entry with the latest `observedAt`; every other
 *      claimant is deleted.
 */
export function repairLadderState(store: HiveGraphStore, tenancy: Tenancy): RepairReport {
  let healedOrphanIdentities = 0;
  if (store.listIdentities !== undefined) {
    for (const identity of store.listIdentities(tenancy)) {
      if (store.latestVersion(identity.nectar) === undefined) {
        store.deleteNectar(tenancy, identity.nectar);
        healedOrphanIdentities += 1;
      }
    }
  }

  // 4. An orphan VERSION (CodeRabbit PR-18 finding #8, layer b): a version row
  // whose nectar has no identity row at all - the inverse of the orphan-
  // identity case above. This happens when a durable `insertIdentity` flush
  // failed but a later `appendVersion` for the same nectar still landed (the
  // sync/async bridge's layer-a fix, `store-bridge.ts`, prevents this for NEW
  // writes; this heals any that already exist). Reads join through identities
  // (`listLatestVersions` et al never surface the row), so the only sound
  // repair is reconstructing a minimal identity from the version row itself:
  // the nectar ULID encodes `createdAt`, and the version row carries its own
  // tenancy + `lastUpdateDate`. Requires the OPTIONAL `store.listVersionNectars`
  // (skipped, not guessed at, when the adapter omits it, mirroring how
  // orphan-identity healing above skips when `listIdentities` is omitted).
  let healedOrphanVersions = 0;
  if (store.listVersionNectars !== undefined) {
    for (const nectar of store.listVersionNectars(tenancy)) {
      if (store.getIdentity(nectar) !== undefined) continue; // already has an identity
      const version = store.latestVersion(nectar);
      if (version === undefined) continue; // nothing to reconstruct from
      store.insertIdentity({
        nectar,
        kind: "file",
        createdAt: nectarCreatedAt(nectar),
        derivedFromNectar: "",
        forkContentHash: "",
        orgId: version.orgId,
        workspaceId: version.workspaceId,
        projectId: version.projectId,
        lastUpdateDate: version.lastUpdateDate,
      });
      healedOrphanVersions += 1;
    }
  }

  const latest = store.listLatestVersions(tenancy);

  let healedStaleLastUpdate = 0;
  for (const lv of latest) {
    const identityMs = Date.parse(lv.identity.lastUpdateDate);
    const versionMs = Date.parse(lv.version.lastUpdateDate);
    if (Number.isNaN(versionMs)) continue; // nothing trustworthy to catch up to
    if (Number.isNaN(identityMs) || identityMs < versionMs) {
      store.touchIdentity(lv.identity.nectar, lv.version.lastUpdateDate);
      healedStaleLastUpdate += 1;
    }
  }

  let healedDuplicatePaths = 0;
  const byPath = new Map<string, LatestVersion[]>();
  for (const lv of latest) {
    const group = byPath.get(lv.version.path) ?? [];
    group.push(lv);
    byPath.set(lv.version.path, group);
  }
  for (const group of byPath.values()) {
    if (group.length <= 1) continue;
    let survivor = group[0] as LatestVersion;
    for (const lv of group) {
      if (Date.parse(lv.version.observedAt) > Date.parse(survivor.version.observedAt)) survivor = lv;
    }
    for (const lv of group) {
      if (lv.identity.nectar === survivor.identity.nectar) continue;
      store.deleteNectar(tenancy, lv.identity.nectar);
      healedDuplicatePaths += 1;
    }
  }

  return { healedOrphanIdentities, healedOrphanVersions, healedStaleLastUpdate, healedDuplicatePaths };
}

/** What {@link repairLadderState} healed in one sweep pass. */
export interface RepairReport {
  readonly healedOrphanIdentities: number;
  /** Orphan version rows (no matching identity) healed by reconstructing a minimal identity (CodeRabbit PR-18 finding #8). */
  readonly healedOrphanVersions: number;
  readonly healedStaleLastUpdate: number;
  readonly healedDuplicatePaths: number;
}
