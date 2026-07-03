/**
 * The settled-handler registration service (PRD-006a AC-4/AC-9).
 *
 * This is the orchestrator that wires the whole file-registration pipeline end
 * to end: the debounced `WatchIntake` (006a) hands settled paths here; each path
 * is `stat`ed, classified (006b), and, for a NEW/CHANGED path, resolved through
 * the re-association ladder (006d) and persisted via the `HiveGraphStore`
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
 * `hive_graph_versions.fingerprint` column, written by the ladder), not held
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
import {
  createInMemoryStatCache,
  reassociate,
  repairLadderState,
  type FuzzyStep,
  type LadderDeps,
  type ObservedFile,
  type RepairReport,
  type ReviewCandidate,
  type StatCache,
} from "./ladder.js";
import { WatchIntake, type WatcherState, type WatchFn } from "./fs-watch.js";
import { probeCaseInsensitiveFs } from "./disk-fs.js";
import type { IgnorePredicate } from "./ignore.js";
import type { PendingReviewStore } from "./review-store.js";
import type { HiveGraphStore } from "../hive-graph/store.js";
import type { Tenancy } from "../hive-graph/model.js";
import { sha256Hex } from "../hive-graph/hash.js";
import { realTimer, type Timer } from "../poll-loop.js";
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
  /**
   * True when `relPath` currently exists on disk AS A DIRECTORY (PRD-018c
   * NEC-008 / AC-018c.5). OPTIONAL and ADDITIVE: an adapter that omits it
   * (most test fakes) simply never triggers the directory-event resync path -
   * `stat === null` for a directory is treated as "missing", the pre-018c
   * behavior, which the prefix-based missing-directory signal below still
   * catches for a genuine directory rename.
   */
  isDirectory?(relPath: string): boolean;
}

export interface RegistrationServiceOptions {
  readonly store: HiveGraphStore;
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
  /**
   * PRD-018c NEC-034 / AC-018c.8: force the case-sensitivity mode instead of
   * probing. Tests use this to exercise case-fold behavior deterministically
   * regardless of the CI host's real filesystem; production wiring omits it
   * so the REAL probe ({@link probeCaseInsensitiveFs}, run once against
   * `root` at construction) decides.
   */
  readonly caseInsensitive?: boolean;
  /** Fired whenever the watcher's liveness state changes (PRD-018c AC-018c.6/7: running/restarting/degraded/stopped). Defaults to a no-op. */
  onWatcherStateChange?(state: WatcherState): void;
  /** Backoff floor for a watcher restart-after-error (ms). Forwarded to {@link WatchIntake}. */
  readonly watcherRestartBackoffFloorMs?: number;
  /** Backoff ceiling for a watcher restart-after-error (ms). Forwarded to {@link WatchIntake}. */
  readonly watcherRestartBackoffCeilingMs?: number;
  /** Consecutive restart failures before the watcher parks degraded (PRD-018c AC-018c.7). Forwarded to {@link WatchIntake}. */
  readonly maxWatcherRestartAttempts?: number;
  /** The raw watch constructor (default: `node:fs`'s `watch`). Forwarded to {@link WatchIntake}; injectable for deterministic error/restart tests (AC-018c.6/7). */
  readonly watchFn?: WatchFn;
  /**
   * PRD-018c AC-018c.7: a slow periodic resync tick that runs regardless of
   * watcher health, so a permanently-degraded watcher still eventually
   * reconciles changes. Default {@link DEFAULT_PERIODIC_RESYNC_MS}; set 0 to
   * disable (most unit tests, which drive resync explicitly).
   */
  readonly periodicResyncMs?: number;
  /** Enrich-queue sink (PRD-016 wires the real queue later). */
  onEnrichQueued?(nectar: string): void;
  /**
   * Observability seam fired at the top of {@link RegistrationService.requestResync}
   * (PRD-018b): a pure notification (no behavior change to the ladder or the
   * settle) so the daemon can count the single cold-catch-up resync it requests
   * after auto-brood settles (AC-018b.5) and surface it to health. Defaults to a
   * no-op; existing callers are unaffected.
   */
  onResyncRequested?(): void;
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

/** PRD-018c AC-018c.7: the periodic resync backstop's default cadence. Slow enough that the descent-pruned walk (AC-018c.4) makes it cheap even while running. */
export const DEFAULT_PERIODIC_RESYNC_MS = 10 * 60 * 1000;

export class RegistrationService {
  private readonly store: HiveGraphStore;
  private readonly tenancy: Tenancy;
  private readonly fs: RegistrationFs;
  private readonly fuzzy: FuzzyStep | undefined;
  private readonly pendingReviews: PendingReviewStore | undefined;
  private readonly isIgnored: IgnorePredicate;
  private readonly nowFn: () => string;
  private readonly onEnrichQueued: (nectar: string) => void;
  private readonly onResyncRequested: () => void;
  private readonly log: (line: Record<string, unknown>) => void;
  private readonly metrics: PipelineMetricsSink | undefined;
  private readonly intake: WatchIntake;
  private readonly timer: Timer;
  private readonly caseInsensitive: boolean;
  private readonly statCache: StatCache;
  private readonly periodicResyncMs: number;

  private readonly pending = new Set<string>();
  private resyncRequested = false;
  /** The in-flight (or just-settled) cycle. Tracked so tests can await idle. */
  private currentCyclePromise: Promise<void> | null = null;
  private periodicResyncHandle: unknown = null;

  constructor(opts: RegistrationServiceOptions) {
    this.store = opts.store;
    this.tenancy = opts.tenancy;
    this.fs = opts.fs;
    this.fuzzy = opts.fuzzy;
    this.pendingReviews = opts.pendingReviews;
    this.isIgnored = opts.isIgnored ?? (() => false);
    this.nowFn = opts.now ?? (() => new Date().toISOString());
    this.onEnrichQueued = opts.onEnrichQueued ?? (() => {});
    this.onResyncRequested = opts.onResyncRequested ?? (() => {});
    this.log = opts.log ?? (() => {});
    this.metrics = opts.metrics;
    this.timer = opts.timer ?? realTimer;
    // NEC-034 / AC-018c.8: probe ONCE per workspace (never a `process.platform`
    // guess); a test overrides via `caseInsensitive` for determinism.
    this.caseInsensitive = opts.caseInsensitive ?? probeCaseInsensitiveFs(opts.root);
    this.statCache = createInMemoryStatCache();
    this.periodicResyncMs = Math.max(0, opts.periodicResyncMs ?? DEFAULT_PERIODIC_RESYNC_MS);
    this.intake = new WatchIntake({
      root: opts.root,
      debounceMs: opts.debounceMs,
      isIgnored: this.isIgnored,
      timer: opts.timer,
      onPathChanged: (relPath) => this.enqueue(relPath),
      onResync: () => this.requestResync(),
      onError: (err) => this.log({ level: "error", scope: "registration.intake", err: String(err) }),
      onStateChange: (state) => {
        this.log({ level: state === "degraded" ? "warn" : "info", scope: "registration.watcher", state });
        opts.onWatcherStateChange?.(state);
      },
      ...(opts.watcherRestartBackoffFloorMs !== undefined
        ? { restartBackoffFloorMs: opts.watcherRestartBackoffFloorMs }
        : {}),
      ...(opts.watcherRestartBackoffCeilingMs !== undefined
        ? { restartBackoffCeilingMs: opts.watcherRestartBackoffCeilingMs }
        : {}),
      ...(opts.maxWatcherRestartAttempts !== undefined ? { maxRestartAttempts: opts.maxWatcherRestartAttempts } : {}),
      ...(opts.watchFn !== undefined ? { watchFn: opts.watchFn } : {}),
    });
  }

  /** Begin watching the workspace root. Idempotent. */
  start(): void {
    this.intake.start();
    this.armPeriodicResync();
  }

  /** Stop watching, cancel pending debounces, and disarm the periodic resync backstop. Idempotent. */
  stop(): void {
    this.intake.stop();
    this.disarmPeriodicResync();
  }

  /** PRD-018c AC-018c.7: (re)arm the periodic resync backstop. A no-op when `periodicResyncMs` is 0 (disabled). */
  private armPeriodicResync(): void {
    if (this.periodicResyncMs <= 0) return;
    this.disarmPeriodicResync();
    this.periodicResyncHandle = this.timer.set(() => {
      this.periodicResyncHandle = null;
      this.requestResync();
      this.armPeriodicResync();
    }, this.periodicResyncMs);
  }

  private disarmPeriodicResync(): void {
    if (this.periodicResyncHandle !== null) {
      this.timer.clear(this.periodicResyncHandle);
      this.periodicResyncHandle = null;
    }
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
    this.onResyncRequested();
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
        this.runRepairSweep();
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
      // listLatestVersions walk per path. PRD-018c EX-4: the missing-paths set
      // is ALSO computed once per batch here (one `existsOnDisk` stat per known
      // path total), rather than once per known path PER new file inside the
      // ladder's step-4 candidate scan (`ladder.ts`'s `missingCandidates`).
      const known = this.knownPaths();
      const missing = this.missingPaths();
      for (const relPath of batch) {
        try {
          this.processOne(relPath, known, missing);
        } catch (err) {
          this.log({ level: "error", scope: "registration.cycle", relPath, err: String(err) });
        }
      }
    }
  }

  /**
   * PRD-018d (NEC-036): run the idempotent ladder-state repair sweep once per
   * full resync, so cold catch-up (the moment corruption from a pre-fix or
   * mid-crash daemon is most likely to have accumulated) is also the moment it
   * self-heals. Never throws; a per-path cycle failure is isolated the same
   * way `runCycle` isolates `processOne` failures, but a sweep failure is rare
   * enough (it touches only already-persisted rows, no disk I/O) that it is
   * logged rather than silently swallowed.
   */
  private runRepairSweep(): void {
    let report: RepairReport;
    try {
      report = repairLadderState(this.store, this.tenancy);
    } catch (err) {
      this.log({ level: "error", scope: "registration.repair", err: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (
      report.healedOrphanIdentities > 0 ||
      report.healedOrphanVersions > 0 ||
      report.healedStaleLastUpdate > 0 ||
      report.healedDuplicatePaths > 0
    ) {
      this.log({ level: "info", scope: "registration.repair", ...report });
    }
  }

  /** Case-fold a path for lookup purposes only (NEC-034 / AC-018c.8); identity when the workspace is case-sensitive. Never applied to a path that gets stat'd, read, or persisted. */
  private fold(relPath: string): string {
    return this.caseInsensitive ? relPath.toLowerCase() : relPath;
  }

  /** The set of paths currently known to the store (a nectar's latest-version path), scoped and fold-normalized for lookup. */
  private knownPaths(): Set<string> {
    const set = new Set<string>();
    for (const lv of this.store.listLatestVersions(this.tenancy)) set.add(this.fold(lv.version.path));
    return set;
  }

  /**
   * PRD-018c EX-4: the set of known (real-cased) paths currently missing from
   * disk, computed once per batch/cycle so the ladder's step-4 candidate scan
   * (`missingCandidates`) is an O(1) lookup instead of an `existsOnDisk` stat
   * per candidate per new file.
   */
  private missingPaths(): Set<string> {
    const set = new Set<string>();
    for (const lv of this.store.listLatestVersions(this.tenancy)) {
      if (!this.fs.existsOnDisk(lv.version.path)) set.add(lv.version.path);
    }
    return set;
  }

  /**
   * PRD-018c NEC-008 / AC-018c.5: true when `relPath` (case-folded) is a
   * directory PREFIX of some known file path - the signature of a directory
   * that was renamed/moved out from under its known children. `knownPaths` is
   * already fold-normalized by `knownPaths()`.
   */
  private isKnownPrefix(relPath: string, knownPaths: ReadonlySet<string>): boolean {
    const prefix = `${this.fold(relPath)}/`;
    for (const p of knownPaths) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Classify one settled path and, for NEW/CHANGED, resolve it through the ladder. */
  private processOne(relPath: string, knownPaths: ReadonlySet<string>, missingPaths: ReadonlySet<string>): void {
    // Containment gate (CWE-22): never stat, read, classify, or persist a path
    // that escapes the workspace (absolute or `..` traversal). This backstops the
    // intake filter for the resync/direct-enqueue paths too.
    if (!isSafeRelPath(relPath)) {
      this.log({ level: "warn", scope: "registration.cycle", relPath, msg: "dropped unsafe path" });
      return;
    }
    // PRD-018c NEC-008 / AC-018c.5(a): the settled path itself IS a directory
    // right now (a directory-level watch event, or a rename landing back on an
    // existing directory name). A directory is never a registrable path; a
    // resync reconciles every child in one scoped reconciliation instead of
    // this event being silently dropped.
    if (this.fs.isDirectory?.(relPath) === true) {
      this.log({ level: "info", scope: "registration.cycle", relPath, msg: "directory event: requesting resync" });
      this.requestResync();
      return;
    }
    const stat = this.fs.statPath(relPath);
    const input = classifyPath({ relPath, existsOnDisk: stat !== null }, knownPaths, (p) => this.fold(p));
    if (input === null) {
      // PRD-018c NEC-008 / AC-018c.5(b): the path is missing AND is a prefix of
      // known paths - the OTHER directory-rename signature (the directory name
      // itself is gone, only its former children are still known). A resync
      // re-associates every child to its new location via the ladder.
      if (stat === null && this.isKnownPrefix(relPath, knownPaths)) {
        this.log({
          level: "info",
          scope: "registration.cycle",
          relPath,
          msg: "missing directory prefix: requesting resync",
        });
        this.requestResync();
      }
      return;
    }
    switch (input.kind) {
      case "new-path":
      case "changed-path": {
        if (stat === null) return; // defensive: classify said it exists
        this.resolveExisting(relPath, stat, missingPaths);
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

  private resolveExisting(relPath: string, stat: StatResult, missingPaths: ReadonlySet<string>): void {
    const file: ObservedFile = {
      relPath,
      sizeBytes: stat.sizeBytes,
      mtimeObserved: stat.mtimeObserved,
      readContent: () => stat.readContent(),
    };
    // The ladder persists the content fingerprint on the appended version row, so
    // there is nothing to cache here; step 4 reads it back from the store (AC-8).
    const result = reassociate(file, this.ladderDeps(missingPaths));
    // "files registered" (PRD-017b): one settled path actually resolved through
    // the ladder, counted here at the real completion point regardless of which
    // step fired or what action it took (noop/append/carry/mint/copy all count -
    // each is one unit of registration work). A path that never reaches here
    // (ignored, or classified "missing-path") is correctly never counted.
    this.metrics?.incrementFilesRegistered();
    this.log({ level: "debug", scope: "registration.resolve", relPath, step: result.step, action: result.action });
  }

  private ladderDeps(missingPaths?: ReadonlySet<string>): LadderDeps {
    return {
      store: this.store,
      tenancy: this.tenancy,
      now: () => this.nowFn(),
      existsOnDisk: (p) => this.fs.existsOnDisk(p),
      fuzzy: this.fuzzy,
      statCache: this.statCache,
      caseInsensitive: this.caseInsensitive,
      missingPaths,
      onReviewNeeded: (candidate) => this.handleReview(candidate),
      onEnrichQueued: (nectar) => this.onEnrichQueued(nectar),
    };
  }

  /**
   * Persist a low-confidence step-4 candidate for `review-matches` (AC-18).
   *
   * The id is derived deterministically from `(candidateNectar, newPath)`
   * (PRD-018d NEC-036/AC-018d.7) rather than freshly minted per call: a
   * re-observation of the same target while it is still pending review then
   * naturally lands on the SAME id, so the store's own id-based replace (and
   * its belt-and-suspenders tuple-based dedupe) refreshes the one candidate in
   * place instead of accumulating a sibling per settle.
   */
  private handleReview(candidate: ReviewCandidate): void {
    if (this.pendingReviews === undefined) return;
    this.pendingReviews.add({
      id: sha256Hex(`${candidate.nectar}|${candidate.relPath}`),
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
