/**
 * The hiveantennae worker harness.
 *
 * Per PRD-002b the worker is a lease-based harness driving the four operating
 * modes (brooding / live watch / cold catch-up / projection sync) over a durable
 * queue. The concrete queue + handlers land with later PRDs (006 re-association,
 * 007 brooding, 011 projection, 016 enricher); this harness is the real,
 * testable engine those handlers plug into. It exposes `runOnce()` (the
 * deterministic unit a test asserts against), `start()`/`stop()` (the continuous
 * adaptive poll loop), and a pluggable job source so no mode is hardcoded.
 */
import { PollLoop, type Timer } from "./poll-loop.js";

/** nectar's own job kinds (distinct from honeycomb's memory_* kinds). */
export type JobKind =
  | "brood"
  | "reassociate"
  | "enrich"
  | "projection-sync";

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload?: unknown;
}

/** A handler does the stage's work and returns on success / throws on failure. It never touches the queue. */
export type JobHandler = (job: Job) => Promise<void> | void;

/**
 * The job source the worker leases from. Returns the next runnable job, or null
 * when nothing is leasable. Later PRDs back this with the durable Deep Lake
 * queue; tests back it with an in-memory array.
 */
export interface JobSource {
  lease(kinds: readonly JobKind[]): Promise<Job | null> | Job | null;
  complete(id: string): Promise<void> | void;
  fail(id: string, reason: string): Promise<void> | void;
}

export interface WorkerOptions {
  readonly source: JobSource;
  readonly handlers: Partial<Record<JobKind, JobHandler>>;
  readonly pollIntervalMs: number;
  readonly ceilingMs?: number;
  readonly timer?: Timer;
  readonly onError?: (err: unknown) => void;
}

export class HiveantennaeWorker {
  private readonly source: JobSource;
  private readonly handlers: Partial<Record<JobKind, JobHandler>>;
  private readonly kinds: readonly JobKind[];
  private readonly loop: PollLoop;
  private readonly onError: (err: unknown) => void;

  constructor(opts: WorkerOptions) {
    this.source = opts.source;
    this.handlers = opts.handlers;
    this.kinds = Object.keys(opts.handlers) as JobKind[];
    this.onError = opts.onError ?? (() => {});
    this.loop = new PollLoop({
      tick: () => this.runOnce(),
      floorMs: opts.pollIntervalMs,
      ceilingMs: opts.ceilingMs,
      timer: opts.timer,
      onError: this.onError,
    });
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  /**
   * Lease exactly one job (filtered to this worker's own kinds), route it to its
   * handler, and complete/fail through the source. Returns true if a job ran,
   * false if the queue was idle. A handler throw becomes `source.fail` (never a
   * swallowed catch); a crash mid-handler leaves the lease for the queue's
   * reaper (crash-safety, PRD-002b).
   */
  async runOnce(): Promise<boolean> {
    const job = await this.source.lease(this.kinds);
    if (job === null) return false;

    const handler = this.handlers[job.kind];
    if (handler === undefined) {
      // Foreign/unknown kind: fail loudly rather than silently complete.
      await this.source.fail(job.id, `no handler for kind '${job.kind}'`);
      return true;
    }

    try {
      await handler(job);
    } catch (err) {
      this.onError(err);
      const reason = err instanceof Error ? err.message : String(err);
      await this.source.fail(job.id, reason);
      return true;
    }
    // Completion is deliberately OUTSIDE the handler try: a transient
    // source.complete() failure is a queue problem, not a job failure. Routing
    // it to source.fail() after the handler already committed its side effects
    // could duplicate work or corrupt queue state, so let it propagate instead.
    await this.source.complete(job.id);
    return true;
  }

  /** Start the continuous adaptive poll loop. Idempotent. */
  start(): void {
    this.loop.start();
  }

  /** Stop the loop. Idempotent; an in-flight job is allowed to finish. */
  stop(): void {
    this.loop.stop();
  }
}

/** A no-op job source: leases nothing. The daemon boots with this until the Deep Lake queue (PRD-005/006) lands. */
export const emptyJobSource: JobSource = {
  lease: () => null,
  complete: () => {},
  fail: () => {},
};
