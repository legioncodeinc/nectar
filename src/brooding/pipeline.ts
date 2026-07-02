/**
 * The brooding pipeline orchestrator (PRD-007).
 *
 * Runs the FIXED order carried verbatim from `brooding-pipeline.md`, mirroring
 * honeycomb's `runGraphBuild` discover->extract->persist composition:
 *
 *   discover -> pre-check -> bucket -> describe -> embed -> persist -> regenerate-projection
 *
 * `planBrood` runs discover -> pre-check -> bucket -> estimate with NO LLM call
 * and NO store write (the `--dry-run` cost preview). `runBrood` runs the full
 * pipeline: it inherits hash-matched files ($0), applies the resumability state
 * machine to skip already-brooded files, mints identities, describes and embeds
 * the survivors, persists the rows, and regenerates the projection.
 *
 * Every mint and every description is a committed store write (no in-memory
 * accumulation), so a killed brood resumes from `describe_status` with no
 * lockfile (PRD-007c). All stages beyond discovery reuse the existing modules:
 * `hive-graph` (store/model/ulid/hash/paths), `portkey` (transport), `embeddings`
 * (provider), `projection` (inherit/rebuild).
 */
import type {
  HiveGraphRow,
  HiveGraphVersionRow,
  Tenancy,
} from "../hive-graph/model.js";
import type { HiveGraphStore } from "../hive-graph/store.js";
import { mintNectar, nectarCreatedAt } from "../hive-graph/ulid.js";
import { filenameOf, extOf } from "../hive-graph/paths.js";
import type { RegistrationFs } from "../registration/service.js";
import type { IgnorePredicate } from "../registration/ignore.js";
import { describeViaPortkey, type PortkeyFetch } from "../portkey/transport.js";
import type { PortkeyEnabled } from "../portkey/config.js";
import type { DescriptionPayload } from "../portkey/describe-model.js";
import { createOffProvider, type EmbedProvider } from "../embeddings/provider.js";
import { isValidEmbedding } from "../hive-graph/model.js";
import {
  loadProjectionFromFile,
  type LoadProjectionResult,
} from "../projection/load.js";
import { DEFAULT_PROJECTION_REL_PATH, type PortableProjection } from "../projection/format.js";
import { projectionFinalPath, rebuildProjection } from "../projection/write.js";
import { discoverFiles, type DiscoverySource, type GitLsFiles } from "./discovery.js";
import { contentHashPrecheck, prepareFiles, type PreparedFile } from "./precheck.js";
import { bucketFiles, classifyBucket, type BucketedFiles, type PackBatchesOptions } from "./bucketing.js";
import { estimateBroodCost, type BroodCostEstimate } from "./cost.js";
import {
  describeBatchGroup,
  describeSoloFile,
  embedDescriptions,
  type DescribeFn,
  type DescribeTarget,
} from "./describe.js";
import { classifyResume } from "./resumability.js";

/** A typed pipeline error (e.g. a real brood invoked with no describe transport). */
export class BroodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroodError";
  }
}

/** Shared configuration for {@link planBrood} and {@link runBrood}. */
export interface BroodConfig {
  readonly store: HiveGraphStore;
  readonly tenancy: Tenancy;
  /** The project root discovery walks and the projection is written under. */
  readonly root: string;
  /** Filesystem seam (stat/read/list); typically `createDiskRegistrationFs(root)`. */
  readonly fs: RegistrationFs;
  /** git-ls-files seam (default spawns git); overridden in tests. */
  readonly gitLsFiles?: GitLsFiles;
  /** Ignore predicate for the walk fallback (default: the shared CodeGraph ignore). */
  readonly isIgnored?: IgnorePredicate;
  /**
   * The committed projection consulted by the pre-check. `undefined` -> attempt
   * to load `<root>/.honeycomb/nectars.json`; `null` -> no projection (every
   * candidate is a survivor).
   */
  readonly projection?: PortableProjection | null;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  readonly now?: () => string;
  /** Dynamic batch-packing overrides (default: the decision #22 constants). */
  readonly packOptions?: PackBatchesOptions;
  /** Structured log sink; defaults to a no-op. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/** Options that shape a full {@link runBrood} (the CLI flags). */
export interface BroodRunOptions {
  /** `--force`: re-describe every non-skipped file, ignoring existing descriptions. */
  readonly force?: boolean;
  /** `--limit N`: brood at most N pending (describe-eligible) files (cost cap). */
  readonly limit?: number;
  /** `--dry-run`: discover + bucket + estimate, no LLM call, no writes. */
  readonly dryRun?: boolean;
  /** `--model <new>`: the resolved describe model id (audit-stamped on each row). */
  readonly model?: string;
}

/** Transport + provider seams a full describe run needs (never touched by dry-run). */
export interface BroodRuntimeDeps {
  /** The chat transport. Default wires {@link describeViaPortkey} against `portkey`. */
  readonly describe?: DescribeFn;
  /** Portkey credentials used to build the default `describe` when none is given. */
  readonly portkey?: PortkeyEnabled;
  /** Injectable fetch for the default describe transport (tests). */
  readonly fetch?: PortkeyFetch;
  /** The embedding provider (default: the disabled provider -> NULL embeddings, BM25 fallback). */
  readonly embedProvider?: EmbedProvider;
  /** Projection regeneration seam (default: `rebuildProjection` from the store). Return the written path. */
  readonly regenerateProjection?: (store: HiveGraphStore, tenancy: Tenancy, root: string) => string;
}

/** The bucket + estimate a dry-run (or the plan phase of a run) produces. */
export interface BroodPlan {
  readonly source: DiscoverySource;
  readonly discoveredCount: number;
  readonly inheritedCount: number;
  readonly survivorCount: number;
  readonly skipBinaryCount: number;
  readonly skipTooLargeCount: number;
  readonly batchFileCount: number;
  readonly soloFileCount: number;
  readonly batchCalls: number;
  readonly soloCalls: number;
  readonly estimate: BroodCostEstimate;
}

/** The full outcome of a {@link runBrood}. */
export interface BroodResult extends BroodPlan {
  readonly dryRun: boolean;
  /** Files skipped on resume because already terminally brooded (rule 1). */
  readonly skippedResumeCount: number;
  /** Files whose nectar was reused (rule 2 re-enqueue). */
  readonly reenqueueCount: number;
  /** Files minted fresh (rule 3 discover-fresh). */
  readonly freshCount: number;
  /** Files that reached `describe_status = 'described'` this run. */
  readonly describedCount: number;
  /** Files whose description failed this run (re-enqueueable). */
  readonly failedCount: number;
  /** The projection path written at end-of-brood, or null on dry-run. */
  readonly projectionPath: string | null;
}

export function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * The store-agnostic subset {@link resolveProjection} needs. Both the sync
 * {@link BroodConfig} and the async brood config (`pipeline-async.ts`) satisfy
 * it, so the projection-resolution + row-building helpers below are shared
 * verbatim across the sync and async pipelines rather than duplicated.
 */
export interface BroodProjectionContext {
  readonly root: string;
  readonly tenancy: Tenancy;
  readonly projection?: PortableProjection | null;
}

/** Resolve the projection to consult: explicit value, else a disk load, else null. */
export function resolveProjection(config: BroodProjectionContext): PortableProjection | null {
  if (config.projection !== undefined) return config.projection;
  const path = projectionFinalPath(config.root, DEFAULT_PROJECTION_REL_PATH);
  const result: LoadProjectionResult = loadProjectionFromFile(path, { tenancy: config.tenancy });
  return result.ok ? result.doc : null;
}

/** The set of nectars already present in the store (skip re-inheriting these). */
function existingNectarSet(store: HiveGraphStore, tenancy: Tenancy): Set<string> {
  const set = new Set<string>();
  for (const lv of store.listLatestVersions(tenancy)) set.add(lv.identity.nectar);
  return set;
}

/** Stage 1-3: discover -> pre-check -> bucket, returning the survivors + buckets. */
function discoverPrecheckBucket(config: BroodConfig): {
  source: DiscoverySource;
  discoveredCount: number;
  inheritedRows: readonly { identity: HiveGraphRow; version: HiveGraphVersionRow }[];
  survivors: readonly PreparedFile[];
  bucketed: BucketedFiles;
} {
  const discovery = discoverFiles({
    root: config.root,
    fs: config.fs,
    gitLsFiles: config.gitLsFiles,
    isIgnored: config.isIgnored,
  });
  const prepared = prepareFiles(config.fs, discovery.files);
  const precheck = contentHashPrecheck(prepared, {
    tenancy: config.tenancy,
    projection: resolveProjection(config),
    existingNectars: existingNectarSet(config.store, config.tenancy),
    nowIso: (config.now ?? defaultNow)(),
  });
  const bucketed = bucketFiles(precheck.survivors, config.packOptions);
  return {
    source: discovery.source,
    discoveredCount: discovery.files.length,
    inheritedRows: precheck.inheritedRows,
    survivors: precheck.survivors,
    bucketed,
  };
}

/**
 * The `--dry-run` cost preview (PRD-007d): discover -> pre-check -> bucket ->
 * estimate. Makes NO LLM call and writes NOTHING (no rows, no projection).
 */
export function planBrood(config: BroodConfig): BroodPlan {
  const { source, discoveredCount, inheritedRows, bucketed } = discoverPrecheckBucket(config);
  const estimate = estimateBroodCost(bucketed);
  return {
    source,
    discoveredCount,
    inheritedCount: inheritedRows.length,
    survivorCount: bucketed.skipBinary.length + bucketed.skipTooLarge.length + bucketed.batchFileCount + bucketed.soloFileCount,
    skipBinaryCount: bucketed.skipBinary.length,
    skipTooLargeCount: bucketed.skipTooLarge.length,
    batchFileCount: bucketed.batchFileCount,
    soloFileCount: bucketed.soloFileCount,
    batchCalls: bucketed.batches.length,
    soloCalls: bucketed.soloFiles.length,
    estimate,
  };
}

export interface RowFields {
  readonly title?: string;
  readonly description?: string;
  readonly concepts?: string;
  readonly describeStatus: HiveGraphVersionRow["describeStatus"];
  readonly describeModel?: string;
  readonly describedAt?: string;
  readonly embedding?: number[] | null;
}

/** Build a version row for a prepared file at `seq` with the given describe fields. */
export function buildVersionRow(
  tenancy: Tenancy,
  now: string,
  prepared: PreparedFile,
  nectar: string,
  seq: number,
  fields: RowFields,
): HiveGraphVersionRow {
  const f = prepared.file;
  return {
    nectar,
    contentHash: prepared.contentHash,
    seq,
    path: f.relPath,
    filename: filenameOf(f.relPath),
    ext: extOf(f.relPath),
    sizeBytes: f.sizeBytes,
    mtimeObserved: f.mtimeObserved,
    title: fields.title ?? "",
    description: fields.description ?? "",
    concepts: fields.concepts ?? "[]",
    embedding: fields.embedding ?? null,
    confidence: null,
    fingerprint: null,
    describedAt: fields.describedAt ?? "",
    describeModel: fields.describeModel ?? "",
    describeStatus: fields.describeStatus,
    observedAt: now,
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };
}

/** Mint a fresh identity row for a brooded file (originally minted; no copy provenance). */
export function buildIdentity(tenancy: Tenancy, now: string, nectar: string): HiveGraphRow {
  return {
    nectar,
    kind: "file",
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };
}

export interface ToBroodItem {
  readonly prepared: PreparedFile;
  readonly action: "fresh" | "re-enqueue";
  /** The existing nectar for a re-enqueue; undefined for fresh (minted in phase A). */
  readonly existingNectar?: string;
  /** True when the re-enqueue's latest version is already `pending` (no new pending write needed). */
  readonly latestPending?: boolean;
}

/**
 * The full brooding run (PRD-007). Applies resumability, mints, describes,
 * embeds, persists, and regenerates the projection. On `dryRun`, delegates to
 * {@link planBrood} and returns without any LLM call or store write.
 */
export async function runBrood(
  config: BroodConfig,
  deps: BroodRuntimeDeps = {},
  options: BroodRunOptions = {},
): Promise<BroodResult> {
  const now = config.now ?? defaultNow;

  if (options.dryRun === true) {
    const plan = planBrood(config);
    return {
      ...plan,
      dryRun: true,
      skippedResumeCount: 0,
      reenqueueCount: 0,
      freshCount: 0,
      describedCount: 0,
      failedCount: 0,
      projectionPath: null,
    };
  }

  // ── Stage 1-2: discover + pre-check (writes inherited rows, $0) ──────────────
  const discovery = discoverFiles({
    root: config.root,
    fs: config.fs,
    gitLsFiles: config.gitLsFiles,
    isIgnored: config.isIgnored,
  });
  const prepared = prepareFiles(config.fs, discovery.files);
  const precheck = contentHashPrecheck(prepared, {
    tenancy: config.tenancy,
    projection: resolveProjection(config),
    existingNectars: existingNectarSet(config.store, config.tenancy),
    nowIso: now(),
  });
  for (const row of precheck.inheritedRows) {
    if (config.store.getIdentity(row.identity.nectar) === undefined) {
      config.store.insertIdentity(row.identity);
    }
    config.store.appendVersion(row.version);
  }

  // ── Resumability: partition survivors into skip / re-enqueue / fresh ─────────
  let skippedResumeCount = 0;
  const toBrood: ToBroodItem[] = [];
  for (const p of precheck.survivors) {
    const existing = config.store.latestVersionByPath(config.tenancy, p.file.relPath);
    const action = classifyResume(existing?.version, { force: options.force });
    if (action === "skip") {
      skippedResumeCount += 1;
      continue;
    }
    if (action === "re-enqueue") {
      toBrood.push({
        prepared: p,
        action: "re-enqueue",
        existingNectar: existing?.identity.nectar,
        latestPending: existing?.version.describeStatus === "pending",
      });
    } else {
      toBrood.push({ prepared: p, action: "fresh" });
    }
  }

  // ── Stage 3: bucket. Skip buckets are terminal writes; batch/solo get described.
  const skipItems: ToBroodItem[] = [];
  const describeItems: ToBroodItem[] = [];
  for (const item of toBrood) {
    const bucket = classifyBucket(item.prepared);
    if (bucket === "skip-binary" || bucket === "skip-too-large") skipItems.push(item);
    else describeItems.push(item);
  }

  // Persist the skip buckets (mint nectar / reuse; write a terminal skip row).
  let skipBinaryCount = 0;
  let skipTooLargeCount = 0;
  for (const item of skipItems) {
    const bucket = classifyBucket(item.prepared);
    const status = bucket === "skip-binary" ? "skipped-binary" : "skipped-too-large";
    if (status === "skipped-binary") skipBinaryCount += 1;
    else skipTooLargeCount += 1;
    persistTerminal(config, now(), item, {
      title: filenameOf(item.prepared.file.relPath),
      describeStatus: status,
    });
  }

  // ── `--limit N`: cap describe-eligible files (the rest resume on a later run).
  const capped =
    options.limit !== undefined && options.limit >= 0
      ? describeItems.slice(0, options.limit)
      : describeItems;

  // ── Phase A: mint identities + write pending rows for the describe set ───────
  const nectarByPrepared = new Map<PreparedFile, string>();
  let freshCount = 0;
  let reenqueueCount = 0;
  for (const item of capped) {
    if (item.action === "fresh") {
      freshCount += 1;
      const nectar = mintNectar();
      config.store.insertIdentity(buildIdentity(config.tenancy, now(), nectar));
      config.store.appendVersion(
        buildVersionRow(config.tenancy, now(), item.prepared, nectar, 0, { describeStatus: "pending" }),
      );
      nectarByPrepared.set(item.prepared, nectar);
    } else {
      reenqueueCount += 1;
      const nectar = item.existingNectar as string;
      if (item.latestPending !== true) {
        // Make the latest version pending again (re-enqueue a failed/described row).
        const seq = config.store.nextSeq(nectar);
        config.store.appendVersion(
          buildVersionRow(config.tenancy, now(), item.prepared, nectar, seq, { describeStatus: "pending" }),
        );
        config.store.touchIdentity(nectar, now());
      }
      nectarByPrepared.set(item.prepared, nectar);
    }
  }

  // ── Stage 4: describe (batch + solo), with malformed-batch solo retry ────────
  const describe = resolveDescribeFn(deps, capped.length);
  const bucketed = bucketFiles(
    capped.map((i) => i.prepared),
    config.packOptions,
  );

  const describedByNectar = new Map<string, { prepared: PreparedFile; payload: DescriptionPayload; model: string }>();
  const failedNectars = new Set<string>();

  const targetFor = (p: PreparedFile): DescribeTarget => ({ nectar: nectarByPrepared.get(p) as string, prepared: p });

  for (const group of bucketed.batches) {
    const targets = group.files.map(targetFor);
    const result = await describeBatchGroup(targets, describe, options.model);
    for (const d of result.described) {
      const target = targets.find((t) => t.nectar === d.nectar);
      if (target !== undefined) describedByNectar.set(d.nectar, { prepared: target.prepared, payload: d.payload, model: result.model });
    }
    // Malformed batch entries: re-try solo, then mark failed (PRD-007b).
    for (const nectar of result.failed) {
      const target = targets.find((t) => t.nectar === nectar);
      if (target === undefined) {
        failedNectars.add(nectar);
        continue;
      }
      const solo = await describeSoloFile(target, describe, options.model);
      if (solo.payload !== null) {
        describedByNectar.set(nectar, { prepared: target.prepared, payload: solo.payload, model: solo.model });
      } else {
        failedNectars.add(nectar);
      }
    }
  }

  for (const p of bucketed.soloFiles) {
    const target = targetFor(p);
    const solo = await describeSoloFile(target, describe, options.model);
    if (solo.payload !== null) {
      describedByNectar.set(target.nectar, { prepared: p, payload: solo.payload, model: solo.model });
    } else {
      failedNectars.add(target.nectar);
    }
  }

  // ── Stage 5: embed (over title + ' ' + description) ─────────────────────────
  const embedProvider = deps.embedProvider ?? createOffProvider();
  const describedEntries = [...describedByNectar.entries()];
  const vectors = await embedDescriptions(
    embedProvider,
    describedEntries.map(([, v]) => v.payload),
  );

  // ── Stage 6: persist described + failed rows ────────────────────────────────
  let describedCount = 0;
  describedEntries.forEach(([nectar, v], i) => {
    const raw = vectors[i] ?? null;
    const embedding = isValidEmbedding(raw) ? raw : null;
    const seq = config.store.nextSeq(nectar);
    config.store.appendVersion(
      buildVersionRow(config.tenancy, now(), v.prepared, nectar, seq, {
        title: v.payload.title,
        description: v.payload.description,
        concepts: v.payload.concepts,
        describeStatus: "described",
        describeModel: v.model,
        describedAt: now(),
        embedding,
      }),
    );
    config.store.touchIdentity(nectar, now());
    describedCount += 1;
  });

  let failedCount = 0;
  for (const nectar of failedNectars) {
    const prepared = [...nectarByPrepared.entries()].find(([, n]) => n === nectar)?.[0];
    if (prepared === undefined) continue;
    const seq = config.store.nextSeq(nectar);
    config.store.appendVersion(
      buildVersionRow(config.tenancy, now(), prepared, nectar, seq, { describeStatus: "failed" }),
    );
    config.store.touchIdentity(nectar, now());
    failedCount += 1;
  }

  // ── Stage 7: regenerate the projection ──────────────────────────────────────
  const regenerate =
    deps.regenerateProjection ??
    ((store, tenancy, root) => rebuildProjection(store, tenancy, { projectRoot: root }).path);
  const projectionPath = regenerate(config.store, config.tenancy, config.root);

  const estimate = estimateBroodCost(bucketed);
  return {
    source: discovery.source,
    discoveredCount: discovery.files.length,
    inheritedCount: precheck.inheritedRows.length,
    survivorCount: precheck.survivors.length,
    skipBinaryCount,
    skipTooLargeCount,
    batchFileCount: bucketed.batchFileCount,
    soloFileCount: bucketed.soloFileCount,
    batchCalls: bucketed.batches.length,
    soloCalls: bucketed.soloFiles.length,
    estimate,
    dryRun: false,
    skippedResumeCount,
    reenqueueCount,
    freshCount,
    describedCount,
    failedCount,
    projectionPath,
  };
}

/** Persist a terminal (skip) row: mint+insert for fresh, append+touch for re-enqueue. */
function persistTerminal(
  config: BroodConfig,
  now: string,
  item: ToBroodItem,
  fields: RowFields,
): void {
  if (item.action === "fresh") {
    const nectar = mintNectar();
    config.store.insertIdentity(buildIdentity(config.tenancy, now, nectar));
    config.store.appendVersion(buildVersionRow(config.tenancy, now, item.prepared, nectar, 0, fields));
  } else {
    const nectar = item.existingNectar as string;
    const seq = config.store.nextSeq(nectar);
    config.store.appendVersion(buildVersionRow(config.tenancy, now, item.prepared, nectar, seq, fields));
    config.store.touchIdentity(nectar, now);
  }
}

/** The describe-transport seams shared by the sync and async brood runtime deps. */
export interface DescribeSeams {
  readonly describe?: DescribeFn;
  readonly portkey?: PortkeyEnabled;
  readonly fetch?: PortkeyFetch;
}

/** Resolve the describe transport: explicit seam, else build one from Portkey creds. */
export function resolveDescribeFn(deps: DescribeSeams, describeCount: number): DescribeFn {
  if (deps.describe !== undefined) return deps.describe;
  if (describeCount === 0) {
    // Nothing to describe; return a transport that is never called.
    return () => Promise.reject(new BroodError("describe transport not configured"));
  }
  const portkey = deps.portkey;
  if (portkey === undefined) {
    throw new BroodError(
      "runBrood: a describe transport is required (pass deps.describe, or deps.portkey to build the default)",
    );
  }
  return (req) => describeViaPortkey(req, { portkey, fetch: deps.fetch });
}
