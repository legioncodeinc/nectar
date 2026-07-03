/**
 * One enricher cycle: working-set refresh, brood coordination, pending-work
 * selection, cosmetic-inherit gate, re-embed, describe, durable version-bump
 * write-back, failure handling, and the projection regeneration trigger
 * (PRD-016 index AC-1..AC-7, hardened by PRD-018g + PRD-018i).
 */
import type { Tenancy } from "../hive-graph/model.js";
import type { HiveGraphVersionRow } from "../hive-graph/model.js";
import { buildDescribeModelStamp } from "../portkey/describe-model.js";
import type { PortkeyEnabled } from "../portkey/config.js";
import type { DescribeViaPortkeyDeps, PortkeyFetch } from "../portkey/transport.js";
import type { EmbedProvider } from "../embeddings/provider.js";
import type { ProjectionWriter } from "../projection/write.js";
import { buildProjectionFromStore } from "../projection/generate.js";
import type { PortableProjection } from "../projection/format.js";
import type { PipelineMetricsSink } from "../telemetry/metrics.js";
import type { EnricherConfig } from "./config.js";
import { resolveEnricherConfig } from "./config.js";
import type { PriorContentCache } from "./content-cache.js";
import {
  applyCosmeticInheritance,
  classifyMeaningfulChange,
} from "./meaningful-change.js";
import {
  describeFilesBatch,
  DescribeTruncatedError,
  embeddingText,
  isContextWindowError,
  type DescribeFileInput,
} from "./describe.js";
import {
  advancePersistentFailureState,
  createPersistentFailureState,
  enrichmentHalted,
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
  /** Preferred projection-doc source for trigger #2 (PRD-018g / NEC-031); wins over `projectionStore`. */
  readonly projectionDoc?: () => PortableProjection | undefined;
  readonly metrics?: PipelineMetricsSink;
  readonly logSink?: EnricherCycleLogSink;
  /**
   * Called with the underlying error when a describe batch fails (transport,
   * parse, or unexpected throw). Without this seam a failing batch is only
   * visible as a silent `filesFailed` count, which made a 5-consecutive-cycle
   * production stall undiagnosable (2026-07-03 soak). Optional and fail-soft:
   * a throwing sink is ignored.
   */
  readonly onDescribeError?: (err: unknown, paths: readonly string[]) => void;
  readonly nowIso?: () => string;
  /** Test seam: inject Portkey fetch for deterministic describe calls. */
  readonly portkeyFetch?: PortkeyFetch;
  readonly portkeyMaxAttempts?: number;
  /**
   * True while a brood is in flight (PRD-018g / NEC-011 AC-018g.1): the enricher
   * pauses so it never describes rows a brood is mid-describe on.
   */
  readonly broodActive?: () => boolean;
  /**
   * Re-seed the working set from the durable store before selection (PRD-018g /
   * NEC-016 AC-018g.6) so post-boot pending rows are picked up without a restart.
   */
  readonly refreshWorkingSet?: () => Promise<void>;
  /** Prior-content cache for the cosmetic-change gate (PRD-018g / NEC-026 AC-018g.9). */
  readonly priorContentCache?: PriorContentCache;
  /** Active embedding model id stamped on rows carrying an embedding (PRD-018i / NEC-018 AC-018i.1). */
  readonly embedModel?: string | null;
}

export interface EnricherCycleResult {
  readonly stats: EnricherCycleStats;
  readonly failureState: PersistentFailureState;
  readonly wroteNewDescriptions: boolean;
}

/** A pending item paired with the content read for it exactly once this cycle (AC-018g.5). */
interface WorkPair {
  readonly item: EnricherWorkItem;
  readonly content: string;
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

/** A row carrying a preserved description but no embedding is a re-embed candidate (AC-018i.5/.6). */
function isReembedCandidate(row: HiveGraphVersionRow): boolean {
  return row.embedding === null && (row.title !== "" || row.description !== "");
}

function splitPairs(pairs: readonly WorkPair[]): [WorkPair[], WorkPair[]] {
  const mid = Math.ceil(pairs.length / 2);
  return [pairs.slice(0, mid), pairs.slice(mid)];
}

/**
 * Describe a batch of already-read pairs and durably commit each result
 * (PRD-018g AC-018g.4/.5/.7/.8). `files[i]` and `included[i]` share the ONE
 * content read per item, so a file deleted after this point cannot shift
 * attribution: `descriptions[i]` is zipped with `included[i]` positionally and
 * `parseDescribeResponse` guarantees equal lengths.
 */
async function describeAndCommitBatch(
  pairs: readonly WorkPair[],
  deps: EnricherCycleDeps,
  strict: boolean,
  now: string,
): Promise<{ stats: EnricherCycleStats; wroteNew: boolean; ok: boolean }> {
  if (deps.portkey === null || pairs.length === 0) {
    return {
      stats: mergeCycleStats(emptyCycleStats(), { filesFailed: pairs.length }),
      wroteNew: false,
      ok: pairs.length === 0,
    };
  }

  const files: DescribeFileInput[] = pairs.map((p) => ({ path: p.item.row.path, content: p.content }));
  const included: readonly EnricherWorkItem[] = pairs.map((p) => p.item);

  try {
    const batch = await describeFilesBatch(files, portkeyDeps(deps.portkey, deps), strict);
    let stats = mergeCycleStats(emptyCycleStats(), {
      inputTokens: batch.inputTokens,
      outputTokens: batch.outputTokens,
    });
    let wroteNew = false;

    for (let i = 0; i < included.length; i++) {
      const item = included[i] as EnricherWorkItem;
      const payload = batch.descriptions[i];
      // Cache the content we just described so a future cosmetic edit can inherit.
      deps.priorContentCache?.set(item.nectar, item.row.contentHash, files[i]?.content ?? "");
      if (payload === undefined) {
        deps.store.updateVersion(markFailed(item.row, now));
        stats = mergeCycleStats(stats, { filesFailed: 1 });
        continue;
      }
      const stamp = buildDescribeModelStamp(payload, batch.model, now);
      const embedding = await embedDescription(deps.embedProvider, stamp.title, stamp.description);
      if (embedding !== null) deps.metrics?.incrementEmbeddingsComputed();
      const row: HiveGraphVersionRow = {
        ...item.row,
        title: stamp.title,
        description: stamp.description,
        concepts: stamp.concepts,
        describeModel: stamp.describeModel,
        describeStatus: stamp.describeStatus,
        describedAt: stamp.describedAt,
        embedding,
        embedModel: embedding !== null ? (deps.embedModel ?? null) : null,
        lastUpdateDate: now,
      };
      const committed = await deps.store.commitVersion(row);
      if (committed) {
        stats = mergeCycleStats(stats, { filesDescribed: 1 });
        deps.metrics?.incrementDescriptionsGenerated();
        wroteNew = true;
      } else {
        // Durable write not confirmed (AC-018g.7): do NOT count described; the
        // nectar's latest stays pending and is re-selected next cycle.
        stats = mergeCycleStats(stats, { filesFailed: 1 });
      }
    }
    return { stats, wroteNew, ok: true };
  } catch (err) {
    if ((isContextWindowError(err) || err instanceof DescribeTruncatedError) && pairs.length > 1) {
      const [first, second] = splitPairs(pairs);
      const r1 = await describeAndCommitBatch(first, deps, strict, now);
      const r2 =
        second.length > 0
          ? await describeAndCommitBatch(second, deps, strict, now)
          : { stats: emptyCycleStats(), wroteNew: false, ok: true };
      return {
        stats: mergeCycleStats(r1.stats, r2.stats),
        wroteNew: r1.wroteNew || r2.wroteNew,
        ok: r1.ok && r2.ok,
      };
    }
    try {
      deps.onDescribeError?.(
        err,
        pairs.map((p) => p.item.row.path),
      );
    } catch {
      // A throwing error sink must never mask the failure handling itself.
    }
    for (const p of pairs) deps.store.updateVersion(markFailed(p.item.row, now));
    return {
      stats: mergeCycleStats(emptyCycleStats(), { filesFailed: pairs.length }),
      wroteNew: false,
      ok: false,
    };
  }
}

async function processDescribeBatch(
  pairs: readonly WorkPair[],
  deps: EnricherCycleDeps,
  now: string,
): Promise<{ stats: EnricherCycleStats; wroteNew: boolean; batchFailed: boolean }> {
  let attempt = await describeAndCommitBatch(pairs, deps, false, now);
  if (!attempt.ok) {
    attempt = await describeAndCommitBatch(pairs, deps, true, now);
  }
  return { stats: attempt.stats, wroteNew: attempt.wroteNew, batchFailed: !attempt.ok };
}

/**
 * Re-embed an inherited/requeued row over its preserved `title + description`
 * with NO LLM describe call (PRD-018i AC-018i.6). On a computed embedding it is
 * durably committed with `embed_model`; if the provider yields no vector the row
 * is left pending so a later cycle (with a provider available) can complete it.
 */
async function reembedRow(
  item: EnricherWorkItem,
  deps: EnricherCycleDeps,
  now: string,
): Promise<{ stats: EnricherCycleStats; wroteNew: boolean }> {
  const embedding = await embedDescription(deps.embedProvider, item.row.title, item.row.description);
  if (embedding === null) {
    return { stats: emptyCycleStats(), wroteNew: false };
  }
  deps.metrics?.incrementEmbeddingsComputed();
  const row: HiveGraphVersionRow = {
    ...item.row,
    embedding,
    embedModel: deps.embedModel ?? null,
    describeStatus: "described",
    lastUpdateDate: now,
  };
  const committed = await deps.store.commitVersion(row);
  if (!committed) return { stats: emptyCycleStats(), wroteNew: false };
  return { stats: mergeCycleStats(emptyCycleStats(), { filesInherited: 1 }), wroteNew: true };
}

/**
 * Try the cosmetic-inherit gate for one item (PRD-018g AC-018g.9): when the
 * prior described version's cached content is present and the new content's token
 * Jaccard similarity is at/above the threshold, inherit the prior description +
 * embedding with no LLM call. Returns undefined when the gate does not apply so
 * the caller falls through to the full describe path.
 */
async function tryCosmeticInherit(
  item: EnricherWorkItem,
  content: string,
  deps: EnricherCycleDeps,
  threshold: number,
  now: string,
): Promise<{ stats: EnricherCycleStats; wroteNew: boolean } | undefined> {
  const cache = deps.priorContentCache;
  if (cache === undefined) return undefined;
  const prior = deps.store.priorDescribedVersion(item.nectar, item.seq);
  if (prior === undefined) return undefined;
  const cached = cache.get(item.nectar);
  if (cached === undefined || cached.contentHash !== prior.contentHash) return undefined;

  const verdict = classifyMeaningfulChange({
    newContent: content,
    priorContent: cached.content,
    priorDescribed: prior,
    threshold,
  });
  if (verdict !== "cosmetic") return undefined;

  const inherited = applyCosmeticInheritance(item.row, prior, now);
  const row: HiveGraphVersionRow = {
    ...inherited,
    embedModel: prior.embedModel ?? null,
    lastUpdateDate: now,
  };
  const committed = await deps.store.commitVersion(row);
  if (!committed) return undefined;
  // The inherited content becomes the new prior for the next observation.
  cache.set(item.nectar, item.row.contentHash, content);
  return { stats: mergeCycleStats(emptyCycleStats(), { filesInherited: 1 }), wroteNew: true };
}

/** Run exactly one enricher cycle. Fail-soft: never throws. */
export async function runEnricherCycle(
  deps: EnricherCycleDeps,
  failureState: PersistentFailureState = createPersistentFailureState(),
): Promise<EnricherCycleResult> {
  const config = resolveEnricherConfig(deps.config);
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const logSink = deps.logSink ?? consoleCycleLogSink;

  // Working-set freshness (AC-018g.6): re-seed from the durable store first.
  if (deps.refreshWorkingSet !== undefined) {
    try {
      await deps.refreshWorkingSet();
    } catch {
      // fail-soft: a refresh failure never aborts the cycle.
    }
  }

  const queueDepth = deps.store.countPending(deps.tenancy);

  // Brood coordination (AC-018g.1): pause while a brood is in flight so the
  // enricher never describes rows the brood is mid-describe on.
  if (deps.broodActive?.() === true) {
    const stats = emptyCycleStats(queueDepth);
    logSink.logCycle(stats);
    return { stats, failureState, wroteNewDescriptions: false };
  }

  if (enrichmentHalted(failureState)) {
    const stats = emptyCycleStats(queueDepth);
    logSink.logCycle(stats);
    return { stats, failureState, wroteNewDescriptions: false };
  }

  let stats = emptyCycleStats(queueDepth);
  let wroteNew = false;
  let cycleFailed = false;

  try {
    const work = deps.store.listPendingWork(deps.tenancy, config.batchSize);
    if (work.length === 0) {
      logSink.logCycle(stats);
      return { stats, failureState, wroteNewDescriptions: false };
    }

    const describePairs: WorkPair[] = [];
    let hadWork = false;

    for (const item of work) {
      hadWork = true;
      const content = deps.readContent.read(item.row.path);
      if (content === null) {
        // Deleted-while-pending (PRD-016c AC-3): mirror-only skip, stays deleted.
        deps.store.updateVersion(markSkippedDeleted(item.row, now));
        stats = mergeCycleStats(stats, { filesSkippedDeleted: 1 });
        continue;
      }

      // Re-embed path (AC-018i.6): inherited/requeued rows carry a preserved
      // description and a null embedding - embed only, no LLM describe.
      if (isReembedCandidate(item.row)) {
        const r = await reembedRow(item, deps, now);
        stats = mergeCycleStats(stats, r.stats);
        if (r.wroteNew) wroteNew = true;
        deps.priorContentCache?.set(item.nectar, item.row.contentHash, content);
        continue;
      }

      // Cosmetic-inherit gate (AC-018g.9): similarity >= threshold inherits with
      // no LLM call; otherwise fall through to the full describe path (AC-018g.10).
      const cosmetic = await tryCosmeticInherit(item, content, deps, config.redescribeThreshold, now);
      if (cosmetic !== undefined) {
        stats = mergeCycleStats(stats, cosmetic.stats);
        if (cosmetic.wroteNew) wroteNew = true;
        continue;
      }

      describePairs.push({ item, content });
    }

    // Solo failed rows run one at a time; pending rows may batch together.
    const solo = describePairs.filter((p) => p.item.solo);
    const batchable = describePairs.filter((p) => !p.item.solo);
    const batches: WorkPair[][] = solo.map((s) => [s]);
    if (batchable.length > 0) batches.push(batchable);

    for (const batch of batches) {
      const result = await processDescribeBatch(batch, deps, now);
      stats = mergeCycleStats(stats, result.stats);
      if (result.wroteNew) wroteNew = true;
      if (result.batchFailed) cycleFailed = true;
    }

    const nextFailure = advancePersistentFailureState(failureState, {
      hadWork,
      cycleFailed,
      threshold: config.persistentFailureThreshold,
    });

    stats = mergeCycleStats(stats, { queueDepth: deps.store.countPending(deps.tenancy) });
    logSink.logCycle(stats);

    if (wroteNew && deps.projectionWriter !== undefined) {
      try {
        const doc =
          deps.projectionDoc?.() ??
          (deps.projectionStore !== undefined
            ? buildProjectionFromStore(deps.projectionStore, deps.tenancy, {})
            : undefined);
        if (doc !== undefined) deps.projectionWriter.scheduleWrite(doc);
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
