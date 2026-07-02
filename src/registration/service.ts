/**
 * The settled-handler registration service (PRD-006a AC-4/AC-9).
 *
 * This is the orchestrator that wires the whole file-registration pipeline end
 * to end: the debounced `WatchIntake` (006a) hands settled paths here; each path
 * is `stat`ed, classified (006b), and, for a NEW/CHANGED path, resolved through
 * the re-association ladder (006d) and persisted via the `SourceGraphStore`
 * (005). It mirrors honeycomb's discover -> resolve -> persist shape
 * (`codebase/api.ts:234-261` `runGraphBuild`) and the fire-and-forget-with-intent
 * settled handler (`file-watcher.ts:234-293` `runSyncCycle`):
 *
 *   - a per-path failure is caught and logged, and the cycle CONTINUES with the
 *     next path (the whole cycle never throws);
 *   - the running cycle's promise is tracked (`currentCyclePromise`) so a test
 *     can await idle via {@link RegistrationService._waitForIdle};
 *   - a null-filename observation triggers a full workspace resync settle (AC-3);
 *   - observations are ignore-filtered before they reach a cycle (AC-5).
 *
 * Step-4 fingerprints are PERSISTED on the version row (the
 * `source_graph_versions.fingerprint` column, written by the ladder), not held
 * in an in-process cache, so cold-catch-up fuzzy matching survives a daemon
 * restart (AC-8): step 4 reads each missing candidate's fingerprint straight
 * from the store.
 *
 * Move reconstruction (AC-9) falls out of this end-to-end: feed the intake two
 * observations (old path now missing, new path new) and, at settle, the ladder's
 * step 3 carries the nectar when the new content matches the missing file's hash.
 */
import { classifyPath } from "./classify.js";
import { isSafeRelPath } from "./paths-safe.js";
import { reassociate, type FuzzyStep, type LadderDeps, type ObservedFile, type ReviewCandidate } from "./ladder.js";
import { WatchIntake } from "./fs-watch.js";
import type { IgnorePredicate } from "./ignore.js";
import type { PendingReviewStore } from "./review-store.js";
import type { SourceGraphStore } from "../source-graph/store.js";
import type { Tenancy } from "../source-graph/model.js";
import { mintNectar } from "../source-graph/ulid.js";
import type { Timer } from "../poll-loop.js";
import type { PipelineMetricsSink } from "../telemetry/metrics.js";

/** A file's on-disk state, resolved by the injected filesystem seam. */
export interface StatResult {
  readonly sizeBytes: number;
  readonly mtimeObserved: string;
  readContent(): string | Uint8Array;
}

/** The filesystem seam. Injected so the service is testable without touching a real disk. */
export interface RegistrationFs {
  /** Stat a repo-relative path; null if it does not exist on disk. */
  statPath(relPath: string): StatResult | null;
  /** Whether a repo-relative path currently exists on disk (distinguishes move from copy). */
  existsOnDisk(relPath: string): boolean;
  /** Every current repo-relative path on disk (for the full resync settle). */
  listPaths(): Iterable<string>;
}

export interface RegistrationServiceOptions {
  readonly store: SourceGraphStore;
  readonly tenancy: Tenancy;
  readonly fs: RegistrationFs;
  readonly root: string;
  /** Step-4 fuzzy matcher (the concrete TLSH-family step). Omit to disable step 4. */
  readonly fuzzy?: FuzzyStep;
  /** Where low-confidence step-4 candidates are queued for `review-matches`. */
  readonly pendingReviews?: PendingReviewStore;
  /** Ignore contract; ignored paths never trigger a cycle (AC-5). */
  readonly isIgnored?: IgnorePredicate;
  /** Debounce window for the intake (DEFAULT 500 ms, PRD-006a). */
  readonly debounceMs?: number;
  /** Injected timer for the intake debounce (deterministic tests). */
  readonly timer?: Timer;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now?(): string;
  /** Enrich-queue sink (PRD-016 wires the real queue later). */
  onEnrichQueued?(nectar: string): void;
  /** Structured log sink; defaults to a no-op. */
  log?(line: Record<string, unknown>): void;
  /**
   * The since-restart pipeline metrics sink (PRD-017b). Counts "files
   * registered" - once per settled path actually resolved through the ladder
   * (a NEW/CHANGED path, `resolveExisting`), regardless of the ladder's
   * outcome. Nectar-mint and version-write counters are captured separately
   * by wrapping `store` with `telemetry.wrapStore()` (`telemetry/metrics.ts`)
   * before constructing this service, so this field only needs to cover the
   * one counter with no other precise 1:1 store-level hook. Omit for a no-op
   * (the default; existing callers are unaffected).
   */
  metrics?: PipelineMetricsSink;
}

export class RegistrationService {
  private readonly store: SourceGraphStore;
  private readonly tenancy: Tenancy;
  private readonly fs: RegistrationFs;
  private readonly fuzzy: FuzzyStep | undefined;
  private readonly pendingReviews: PendingReviewStore | undefined;
  private readonly isIgnored: IgnorePredicate;
  private readonly nowFn: () => string;
  private readonly onEnrichQueued: (nectar: string) => void;
  private readonly log: (line: Record<string, unknown>) => void;
  private readonly metrics: PipelineMetricsSink | undefined;
  private readonly intake: WatchIntake;

  private readonly pending = new Set<string>();
  private resyncRequested = false;
  /** The in-flight (or just-settled) cycle. Tracked so tests can await idle. */
  private currentCyclePromise: Promise<void> | null = null;

  constructor(opts: RegistrationServiceOptions) {
    this.store = opts.store;
    this.tenancy = opts.tenancy;
    this.fs = opts.fs;
    this.fuzzy = opts.fuzzy;
    this.pendingReviews = opts.pendingReviews;
    this.isIgnored = opts.isIgnored ?? (() => false);
    this.nowFn = opts.now ?? (() => new Date().toISOString());
    this.onEnrichQueued = opts.onEnrichQueued ?? (() => {});
    this.log = opts.log ?? (() => {});
    this.metrics = opts.metrics;
    this.intake = new WatchIntake({
      root: opts.root,
      debounceMs: opts.debounceMs,
      isIgnored: this.isIgnored,
      timer: opts.timer,
      onPathChanged: (relPath) => this.enqueue(relPath),
      onResync: () => this.requestResync(),
      onError: (err) => this.log({ level: "error", scope: "registration.intake", err: String(err) }),
    });
  }

  /** Begin watching the workspace root. Idempotent. */
  start(): void {
    this.intake.start();
  }

  /** Stop watching and cancel pending debounces. Idempotent. */
  stop(): void {
    this.intake.stop();
  }

  /** Feed a concrete path observation into the debounced intake (test/programmatic entry). */
  observe(relPath: string): void {
    this.intake.observe(relPath);
  }

  /** Feed a raw watch observation (null filename -> resync) into the intake. */
  observeRaw(filename: string | null | undefined): void {
    this.intake.observeRaw(filename);
  }

  /** Request a debounced full-workspace resync settle. */
  requestResync(): void {
    this.resyncRequested = true;
    this.kick();
  }

  /** Enqueue a settled path and kick the cycle. */
  private enqueue(relPath: string): void {
    if (this.isIgnored(relPath)) return;
    this.pending.add(relPath);
    this.kick();
  }

  /**
   * Drain seam for tests. Resolves once no cycle is running and nothing is
   * pending. Mirrors honeycomb's `_waitForIdle()` (`file-watcher.ts:312-314`).
   */
  async _waitForIdle(): Promise<void> {
    while (this.currentCyclePromise !== null) {
      await this.currentCyclePromise;
    }
  }

  /** Start a cycle if none is running; the finally re-kicks if work arrived during the cycle. */
  private kick(): void {
    if (this.currentCyclePromise !== null) return;
    this.currentCyclePromise = this.runCycle().finally(() => {
      this.currentCyclePromise = null;
      if (this.pending.size > 0 || this.resyncRequested) this.kick();
    });
  }

  /**
   * The settled handler. Drains the resync request and the pending-path set,
   * classifying and resolving each path. It catches every per-path error and
   * continues; it never throws out of the cycle.
   */
  private async runCycle(): Promise<void> {
    while (this.resyncRequested || this.pending.size > 0) {
      if (this.resyncRequested) {
        this.resyncRequested = false;
        for (const p of this.fs.listPaths()) {
          const normalized = p.replace(/\\/g, "/");
          if (!this.isIgnored(normalized)) this.pending.add(normalized);
        }
      }
      if (this.pending.size === 0) continue;
      const batch = [...this.pending];
      this.pending.clear();
      // Snapshot the known-paths set ONCE per batch (each batch path is distinct
      // and never re-processed within the same batch), avoiding an O(N^2)
      // listLatestVersions walk per path.
      const known = this.knownPaths();
      for (const relPath of batch) {
        try {
          this.processOne(relPath, known);
        } catch (err) {
          this.log({ level: "error", scope: "registration.cycle", relPath, err: String(err) });
        }
      }
    }
  }

  /** The set of paths currently known to the store (a nectar's latest-version path), scoped. */
  private knownPaths(): Set<string> {
    const set = new Set<string>();
    for (const lv of this.store.listLatestVersions(this.tenancy)) set.add(lv.version.path);
    return set;
  }

  /** Classify one settled path and, for NEW/CHANGED, resolve it through the ladder. */
  private processOne(relPath: string, knownPaths: ReadonlySet<string>): void {
    // Containment gate (CWE-22): never stat, read, classify, or persist a path
    // that escapes the workspace (absolute or `..` traversal). This backstops the
    // intake filter for the resync/direct-enqueue paths too.
    if (!isSafeRelPath(relPath)) {
      this.log({ level: "warn", scope: "registration.cycle", relPath, msg: "dropped unsafe path" });
      return;
    }
    const stat = this.fs.statPath(relPath);
    const input = classifyPath({ relPath, existsOnDisk: stat !== null }, knownPaths);
    if (input === null) return;
    switch (input.kind) {
      case "new-path":
      case "changed-path": {
        if (stat === null) return; // defensive: classify said it exists
        this.resolveExisting(relPath, stat);
        return;
      }
      case "missing-path":
        // A known nectar whose path is gone: it feeds the missing-files set the
        // ladder consults for OTHER new paths (move reconstruction). No direct
        // action here; the nectar is never deleted (only `prune --confirm` does).
        return;
      default: {
        const _exhaustive: never = input.kind;
        return _exhaustive;
      }
    }
  }

  private resolveExisting(relPath: string, stat: StatResult): void {
    const file: ObservedFile = {
      relPath,
      sizeBytes: stat.sizeBytes,
      mtimeObserved: stat.mtimeObserved,
      readContent: () => stat.readContent(),
    };
    // The ladder persists the content fingerprint on the appended version row, so
    // there is nothing to cache here; step 4 reads it back from the store (AC-8).
    const result = reassociate(file, this.ladderDeps());
    // "files registered" (PRD-017b): one settled path actually resolved through
    // the ladder, counted here at the real completion point regardless of which
    // step fired or what action it took (noop/append/carry/mint/copy all count -
    // each is one unit of registration work). A path that never reaches here
    // (ignored, or classified "missing-path") is correctly never counted.
    this.metrics?.incrementFilesRegistered();
    this.log({ level: "debug", scope: "registration.resolve", relPath, step: result.step, action: result.action });
  }

  private ladderDeps(): LadderDeps {
    return {
      store: this.store,
      tenancy: this.tenancy,
      now: () => this.nowFn(),
      existsOnDisk: (p) => this.fs.existsOnDisk(p),
      fuzzy: this.fuzzy,
      onReviewNeeded: (candidate) => this.handleReview(candidate),
      onEnrichQueued: (nectar) => this.onEnrichQueued(nectar),
    };
  }

  /** Persist a low-confidence step-4 candidate for `review-matches` (AC-18). */
  private handleReview(candidate: ReviewCandidate): void {
    if (this.pendingReviews === undefined) return;
    this.pendingReviews.add({
      id: mintNectar(),
      candidateNectar: candidate.nectar,
      newPath: candidate.relPath,
      confidence: candidate.confidence,
      distance: candidate.distance,
      contentHash: candidate.contentHash,
      sizeBytes: candidate.sizeBytes,
      mtimeObserved: candidate.mtimeObserved,
      mintedNectar: candidate.mintedNectar,
      createdAt: this.nowFn(),
    });
  }
}
