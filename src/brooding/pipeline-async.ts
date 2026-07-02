/**
 * The async-native brooding pipeline (the sync/async bridge, Wave D dormancy closure).
 *
 * `runBrood` (`pipeline.ts`) consumes the SYNCHRONOUS {@link HiveGraphStore}; the
 * only durable substrate (`DeepLakeHiveGraphStore`) implements the ASYNC
 * {@link AsyncHiveGraphStore}. Rather than hydrate an entire repo's version rows
 * into an in-memory sync mirror (the batch-shaped brood is exactly the workload
 * where that is the wrong trade), this is an async-native variant of the same
 * pipeline: it reuses every store-agnostic stage verbatim
 * (`discoverFiles`/`prepareFiles`/`contentHashPrecheck`/`bucketFiles`/
 * `classifyResume`/`describeBatchGroup`/`describeSoloFile`/`embedDescriptions`/
 * `estimateBroodCost`) and the shared row/identity/describe helpers exported from
 * `pipeline.ts`, differing ONLY in that each store read/write is `await`ed
 * against the async store. `runBrood` was already `async` (it awaits the LLM +
 * embed stages), so the sole structural change here is threading `await` through
 * the store calls; the fixed pipeline order and every semantic (resumability via
 * `describe_status`, the #22 packing, the skip-bucket terminal writes, fail-soft
 * projection regen) is identical.
 *
 * This is the path the live `POST /api/hive-graph/build` endpoint and the
 * daemon's durable auto-brood invoke (see `api/daemon-api-wiring.ts` and
 * `daemon.ts`).
 */
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import { isValidEmbedding } from "../hive-graph/model.js";
import type { AsyncHiveGraphStore } from "../hive-graph/store.js";
import { mintNectar } from "../hive-graph/ulid.js";
import { filenameOf } from "../hive-graph/paths.js";
import type { RegistrationFs } from "../registration/service.js";
import type { IgnorePredicate } from "../registration/ignore.js";
import type { PortkeyFetch } from "../portkey/transport.js";
import type { PortkeyEnabled } from "../portkey/config.js";
import type { DescriptionPayload } from "../portkey/describe-model.js";
import { createOffProvider, type EmbedProvider } from "../embeddings/provider.js";
import type { PortableProjection } from "../projection/format.js";
import { rebuildProjectionAsync } from "../projection/write.js";
import { discoverFiles, type DiscoverySource, type GitLsFiles } from "./discovery.js";
import { contentHashPrecheck, prepareFiles, type PreparedFile } from "./precheck.js";
import { bucketFiles, classifyBucket, type PackBatchesOptions } from "./bucketing.js";
import { estimateBroodCost } from "./cost.js";
import {
  describeBatchGroup,
  describeSoloFile,
  embedDescriptions,
  type DescribeFn,
  type DescribeTarget,
} from "./describe.js";
import { classifyResume } from "./resumability.js";
import {
  BroodError,
  buildIdentity,
  buildVersionRow,
  defaultNow,
  resolveDescribeFn,
  resolveProjection,
  type BroodPlan,
  type BroodResult,
  type BroodRunOptions,
  type RowFields,
  type ToBroodItem,
} from "./pipeline.js";

/** Shared configuration for {@link planBroodAsync} and {@link runBroodAsync} (the async twin of `BroodConfig`). */
export interface AsyncBroodConfig {
  /** The durable async store the brood reads from and writes to (Deep Lake). */
  readonly store: AsyncHiveGraphStore;
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
   * to load `<root>/.honeycomb/nectars.json`; `null` -> no projection.
   */
  readonly projection?: PortableProjection | null;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  readonly now?: () => string;
  /** Dynamic batch-packing overrides (default: the decision #22 constants). */
  readonly packOptions?: PackBatchesOptions;
  /** Structured log sink; defaults to a no-op. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/** Transport + provider seams a full async describe run needs (never touched by dry-run). */
export interface AsyncBroodRuntimeDeps {
  /** The chat transport. Default wires `describeViaPortkey` against `portkey`. */
  readonly describe?: DescribeFn;
  /** Portkey credentials used to build the default `describe` when none is given. */
  readonly portkey?: PortkeyEnabled;
  /** Injectable fetch for the default describe transport (tests). */
  readonly fetch?: PortkeyFetch;
  /** The embedding provider (default: the disabled provider -> NULL embeddings, BM25 fallback). */
  readonly embedProvider?: EmbedProvider;
  /**
   * Projection regeneration seam (default: {@link rebuildProjectionAsync} from
   * the async store). Returns the written path. The async twin of the sync
   * pipeline's `regenerateProjection`.
   */
  readonly regenerateProjection?: (store: AsyncHiveGraphStore, tenancy: Tenancy, root: string) => Promise<string>;
}

/** The set of nectars already present in the async store (skip re-inheriting these). */
async function existingNectarSetAsync(store: AsyncHiveGraphStore, tenancy: Tenancy): Promise<Set<string>> {
  const set = new Set<string>();
  for (const lv of await store.listLatestVersions(tenancy)) set.add(lv.identity.nectar);
  return set;
}

/** Stage 1-3: discover -> pre-check -> bucket against the async store, returning survivors + buckets. */
async function discoverPrecheckBucketAsync(config: AsyncBroodConfig): Promise<{
  source: DiscoverySource;
  discoveredCount: number;
  inheritedRows: readonly { identity: HiveGraphRow; version: HiveGraphVersionRow }[];
  survivors: readonly PreparedFile[];
  bucketed: ReturnType<typeof bucketFiles>;
}> {
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
    existingNectars: await existingNectarSetAsync(config.store, config.tenancy),
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
 * The `--dry-run` cost preview against the async store (the async twin of
 * {@link planBrood}): discover -> pre-check -> bucket -> estimate. Makes NO LLM
 * call and writes NOTHING (no rows, no projection); it only reads the async
 * store's latest-per-nectar set for the pre-check's already-brooded skip.
 */
export async function planBroodAsync(config: AsyncBroodConfig): Promise<BroodPlan> {
  const { source, discoveredCount, inheritedRows, bucketed } = await discoverPrecheckBucketAsync(config);
  const estimate = estimateBroodCost(bucketed);
  return {
    source,
    discoveredCount,
    inheritedCount: inheritedRows.length,
    survivorCount:
      bucketed.skipBinary.length + bucketed.skipTooLarge.length + bucketed.batchFileCount + bucketed.soloFileCount,
    skipBinaryCount: bucketed.skipBinary.length,
    skipTooLargeCount: bucketed.skipTooLarge.length,
    batchFileCount: bucketed.batchFileCount,
    soloFileCount: bucketed.soloFileCount,
    batchCalls: bucketed.batches.length,
    soloCalls: bucketed.soloFiles.length,
    estimate,
  };
}

/** Persist a terminal (skip) row against the async store: mint+insert for fresh, append+touch for re-enqueue. */
async function persistTerminalAsync(
  config: AsyncBroodConfig,
  now: string,
  item: ToBroodItem,
  fields: RowFields,
): Promise<void> {
  if (item.action === "fresh") {
    const nectar = mintNectar();
    await config.store.insertIdentity(buildIdentity(config.tenancy, now, nectar));
    await config.store.appendVersion(buildVersionRow(config.tenancy, now, item.prepared, nectar, 0, fields));
  } else {
    const nectar = item.existingNectar as string;
    const seq = await config.store.nextSeq(nectar);
    await config.store.appendVersion(buildVersionRow(config.tenancy, now, item.prepared, nectar, seq, fields));
    await config.store.touchIdentity(nectar, now);
  }
}

/**
 * The full brooding run against the durable {@link AsyncHiveGraphStore} (the
 * sync/async bridge). Applies resumability, mints, describes, embeds, persists,
 * and regenerates the projection - identical in behavior to {@link runBrood},
 * awaiting the async store throughout. On `dryRun`, delegates to
 * {@link planBroodAsync} and returns without any LLM call or store write.
 */
export async function runBroodAsync(
  config: AsyncBroodConfig,
  deps: AsyncBroodRuntimeDeps = {},
  options: BroodRunOptions = {},
): Promise<BroodResult> {
  const now = config.now ?? defaultNow;

  if (options.dryRun === true) {
    const plan = await planBroodAsync(config);
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
    existingNectars: await existingNectarSetAsync(config.store, config.tenancy),
    nowIso: now(),
  });
  for (const row of precheck.inheritedRows) {
    if ((await config.store.getIdentity(row.identity.nectar)) === undefined) {
      await config.store.insertIdentity(row.identity);
    }
    await config.store.appendVersion(row.version);
  }

  // ── Resumability: partition survivors into skip / re-enqueue / fresh ─────────
  let skippedResumeCount = 0;
  const toBrood: ToBroodItem[] = [];
  for (const p of precheck.survivors) {
    const existing = await config.store.latestVersionByPath(config.tenancy, p.file.relPath);
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
    await persistTerminalAsync(config, now(), item, {
      title: filenameOf(item.prepared.file.relPath),
      describeStatus: status,
    });
  }

  // ── `--limit N`: cap describe-eligible files (the rest resume on a later run).
  const capped =
    options.limit !== undefined && options.limit >= 0 ? describeItems.slice(0, options.limit) : describeItems;

  // ── Phase A: mint identities + write pending rows for the describe set ───────
  const nectarByPrepared = new Map<PreparedFile, string>();
  let freshCount = 0;
  let reenqueueCount = 0;
  for (const item of capped) {
    if (item.action === "fresh") {
      freshCount += 1;
      const nectar = mintNectar();
      await config.store.insertIdentity(buildIdentity(config.tenancy, now(), nectar));
      await config.store.appendVersion(
        buildVersionRow(config.tenancy, now(), item.prepared, nectar, 0, { describeStatus: "pending" }),
      );
      nectarByPrepared.set(item.prepared, nectar);
    } else {
      reenqueueCount += 1;
      const nectar = item.existingNectar as string;
      if (item.latestPending !== true) {
        const seq = await config.store.nextSeq(nectar);
        await config.store.appendVersion(
          buildVersionRow(config.tenancy, now(), item.prepared, nectar, seq, { describeStatus: "pending" }),
        );
        await config.store.touchIdentity(nectar, now());
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
      if (target !== undefined)
        describedByNectar.set(d.nectar, { prepared: target.prepared, payload: d.payload, model: result.model });
    }
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
  for (let i = 0; i < describedEntries.length; i++) {
    const [nectar, v] = describedEntries[i] as [string, { prepared: PreparedFile; payload: DescriptionPayload; model: string }];
    const raw = vectors[i] ?? null;
    const embedding = isValidEmbedding(raw) ? raw : null;
    const seq = await config.store.nextSeq(nectar);
    await config.store.appendVersion(
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
    await config.store.touchIdentity(nectar, now());
    describedCount += 1;
  }

  let failedCount = 0;
  for (const nectar of failedNectars) {
    const prepared = [...nectarByPrepared.entries()].find(([, n]) => n === nectar)?.[0];
    if (prepared === undefined) continue;
    const seq = await config.store.nextSeq(nectar);
    await config.store.appendVersion(
      buildVersionRow(config.tenancy, now(), prepared, nectar, seq, { describeStatus: "failed" }),
    );
    await config.store.touchIdentity(nectar, now());
    failedCount += 1;
  }

  // ── Stage 7: regenerate the projection ──────────────────────────────────────
  const regenerate =
    deps.regenerateProjection ??
    (async (store, tenancy, root) => (await rebuildProjectionAsync(store, tenancy, { projectRoot: root })).path);
  const projectionPath = await regenerate(config.store, config.tenancy, config.root);

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
