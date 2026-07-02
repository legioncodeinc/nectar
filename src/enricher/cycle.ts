/**
 * One enricher cycle: pending-work selection, describe, inherit, failure handling
 * (PRD-016 index AC-1..AC-7).
 */
import type { Tenancy } from "../hive-graph/model.js";
import type { HiveGraphVersionRow } from "../hive-graph/model.js";
import { buildDescribeModelStamp } from "../portkey/describe-model.js";
import type { PortkeyEnabled } from "../portkey/config.js";
import type { DescribeViaPortkeyDeps, PortkeyFetch } from "../portkey/transport.js";
import type { EmbedProvider } from "../embeddings/provider.js";
import type { ProjectionWriter } from "../projection/write.js";
import { buildProjectionFromStore } from "../projection/generate.js";
import type { PipelineMetricsSink } from "../telemetry/metrics.js";
import type { EnricherConfig } from "./config.js";
import { resolveEnricherConfig } from "./config.js";
import {
  describeFilesBatch,
  embeddingText,
  isContextWindowError,
  type DescribeFileInput,
} from "./describe.js";
import {
  acknowledgePersistentAlert,
  advancePersistentFailureState,
  createPersistentFailureState,
  enrichmentHalted,
  splitBatch,
  type PersistentFailureState,
} from "./failure.js";
import {
  consoleCycleLogSink,
  emptyCycleStats,
  mergeCycleStats,
  type EnricherCycleLogSink,
  type EnricherCycleStats,
} from "./observability.js";
import type { EnricherStore, EnricherWorkItem } from "./store.js";

export interface ContentReader {
  /** Returns file content, or null when the path no longer exists (deleted). */
  read(path: string): string | null;
}

export interface EnricherCycleDeps {
  readonly store: EnricherStore;
  readonly tenancy: Tenancy;
  readonly readContent: ContentReader;
  readonly portkey: PortkeyEnabled | null;
  readonly embedProvider: EmbedProvider;
  readonly config?: Partial<EnricherConfig>;
  readonly projectionWriter?: ProjectionWriter;
  readonly projectionStore?: Parameters<typeof buildProjectionFromStore>[0];
  readonly metrics?: PipelineMetricsSink;
  readonly logSink?: EnricherCycleLogSink;
  readonly nowIso?: () => string;
  /** Test seam: inject Portkey fetch for deterministic describe calls. */
  readonly portkeyFetch?: PortkeyFetch;
  readonly portkeyMaxAttempts?: number;
}

export interface EnricherCycleResult {
  readonly stats: EnricherCycleStats;
  readonly failureState: PersistentFailureState;
  readonly wroteNewDescriptions: boolean;
}

function portkeyDeps(portkey: PortkeyEnabled, deps: EnricherCycleDeps): DescribeViaPortkeyDeps {
  return {
    portkey,
    fetch: deps.portkeyFetch,
    maxAttempts: deps.portkeyMaxAttempts,
  };
}

async function embedDescription(
  provider: EmbedProvider,
  title: string,
  description: string,
): Promise<number[] | null> {
  try {
    const vecs = await provider.embed([embeddingText(title, description)]);
    return vecs[0] ?? null;
  } catch {
    return null;
  }
}

function markSkippedDeleted(row: HiveGraphVersionRow, now: string): HiveGraphVersionRow {
  return {
    ...row,
    describeStatus: "skipped-deleted",
    describedAt: now,
    describeModel: "",
    lastUpdateDate: now,
  };
}

function markFailed(row: HiveGraphVersionRow, now: string): HiveGraphVersionRow {
  return { ...row, describeStatus: "failed", lastUpdateDate: now };
}

async function describeWorkBatch(
  items: readonly EnricherWorkItem[],
  deps: EnricherCycleDeps,
  strict: boolean,
  now: string,
): Promise<{ stats: EnricherCycleStats; rows: HiveGraphVersionRow[]; ok: boolean }> {
  if (deps.portkey === null) {
    return {
      stats: mergeCycleStats(emptyCycleStats(), { filesFailed: items.length }),
      rows: items.map((i) => markFailed(i.row, now)),
      ok: false,
    };
  }

  const files: DescribeFileInput[] = [];
  for (const item of items) {
    const content = deps.readContent.read(item.row.path);
    if (content === null) continue;
    files.push({ path: item.row.path, content });
  }

  if (files.length === 0) {
    return { stats: emptyCycleStats(), rows: [], ok: true };
  }

  try {
    const batch = await describeFilesBatch(files, portkeyDeps(deps.portkey, deps), strict);
    const rows: HiveGraphVersionRow[] = [];
    let stats = emptyCycleStats();
    stats = mergeCycleStats(stats, {
      inputTokens: batch.inputTokens,
      outputTokens: batch.outputTokens,
      filesDescribed: batch.descriptions.length,
    });

    let fileIdx = 0;
    for (const item of items) {
      const content = deps.readContent.read(item.row.path);
      if (content === null) continue;
      const payload = batch.descriptions[fileIdx];
      fileIdx += 1;
      if (payload === undefined) {
        rows.push(markFailed(item.row, now));
        stats = mergeCycleStats(stats, { filesDescribed: -1, filesFailed: 1 });
        continue;
      }
      const stamp = buildDescribeModelStamp(payload, batch.model, now);
      const embedding = await embedDescription(deps.embedProvider, stamp.title, stamp.description);
      if (embedding !== null) deps.metrics?.incrementEmbeddingsComputed();
      rows.push({
        ...item.row,
        title: stamp.title,
        description: stamp.description,
        concepts: stamp.concepts,
        describeModel: stamp.describeModel,
        describeStatus: stamp.describeStatus,
        describedAt: stamp.describedAt,
        embedding,
        lastUpdateDate: now,
      });
      deps.metrics?.incrementDescriptionsGenerated();
    }
    return { stats, rows, ok: true };
  } catch (err) {
    if (isContextWindowError(err) && items.length > 1) {
      const [first, second] = splitBatch(items);
      const r1 = await describeWorkBatch(first, deps, strict, now);
      const r2 = second.length > 0 ? await describeWorkBatch(second, deps, strict, now) : { stats: emptyCycleStats(), rows: [], ok: true };
      return {
        stats: mergeCycleStats(r1.stats, r2.stats),
        rows: [...r1.rows, ...r2.rows],
        ok: r1.ok && r2.ok,
      };
    }
    return {
      stats: mergeCycleStats(emptyCycleStats(), { filesFailed: items.length }),
      rows: items.map((i) => markFailed(i.row, now)),
      ok: false,
    };
  }
}

async function processBatchWithRetry(
  items: readonly EnricherWorkItem[],
  deps: EnricherCycleDeps,
  now: string,
): Promise<{ stats: EnricherCycleStats; rows: HiveGraphVersionRow[]; batchFailed: boolean }> {
  let attempt = await describeWorkBatch(items, deps, false, now);
  if (!attempt.ok) {
    attempt = await describeWorkBatch(items, deps, true, now);
  }
  return { stats: attempt.stats, rows: attempt.rows, batchFailed: !attempt.ok };
}

/** Run exactly one enricher cycle. Fail-soft: never throws. */
export async function runEnricherCycle(
  deps: EnricherCycleDeps,
  failureState: PersistentFailureState = createPersistentFailureState(),
): Promise<EnricherCycleResult> {
  const config = resolveEnricherConfig(deps.config);
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const logSink = deps.logSink ?? consoleCycleLogSink;
  const queueDepth = deps.store.countPending(deps.tenancy);

  if (enrichmentHalted(failureState)) {
    const stats = mergeCycleStats(emptyCycleStats(queueDepth), {});
    logSink.logCycle(stats);
    return { stats, failureState, wroteNewDescriptions: false };
  }

  let stats = emptyCycleStats(queueDepth);
  let wroteNew = false;
  let cycleFailed = false;

  try {
    const work = deps.store.listPendingWork(deps.tenancy, config.batchSize);
    const hadWork = work.length > 0;

    if (!hadWork) {
      logSink.logCycle(stats);
      return { stats, failureState, wroteNewDescriptions: false };
    }

    // Deleted-while-pending (PRD-016c AC-3)
    const remaining: EnricherWorkItem[] = [];
    for (const item of work) {
      if (deps.readContent.read(item.row.path) === null) {
        const updated = markSkippedDeleted(item.row, now);
        deps.store.updateVersion(updated);
        stats = mergeCycleStats(stats, { filesSkippedDeleted: 1 });
      } else {
        remaining.push(item);
      }
    }

    // Solo failed rows run one at a time; pending rows may batch together
    const solo = remaining.filter((w) => w.solo);
    const batchable = remaining.filter((w) => !w.solo);

    const batches: EnricherWorkItem[][] = solo.map((s) => [s]);
    if (batchable.length > 0) batches.push(batchable);

    for (const batch of batches) {
      const result = await processBatchWithRetry(batch, deps, now);
      stats = mergeCycleStats(stats, result.stats);
      for (const row of result.rows) {
        deps.store.updateVersion(row);
        if (row.describeStatus === "described") wroteNew = true;
      }
      if (result.batchFailed) cycleFailed = true;
    }

    const nextFailure = advancePersistentFailureState(failureState, {
      hadWork: remaining.length > 0,
      cycleFailed,
      threshold: config.persistentFailureThreshold,
    });

    stats = mergeCycleStats(stats, { queueDepth: deps.store.countPending(deps.tenancy) });
    logSink.logCycle(stats);

    if (wroteNew && deps.projectionWriter !== undefined && deps.projectionStore !== undefined) {
      try {
        const doc = buildProjectionFromStore(deps.projectionStore, deps.tenancy, {});
        deps.projectionWriter.scheduleWrite(doc);
      } catch {
        // fail-soft
      }
    }

    return { stats, failureState: nextFailure, wroteNewDescriptions: wroteNew };
  } catch {
    const nextFailure = advancePersistentFailureState(failureState, {
      hadWork: true,
      cycleFailed: true,
      threshold: config.persistentFailureThreshold,
    });
    logSink.logCycle(stats);
    return { stats, failureState: nextFailure, wroteNewDescriptions: false };
  }
}

