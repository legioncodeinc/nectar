/**
 * Adaptive poll loop for the hiveantennae worker.
 *
 * Mirrors honeycomb's poll-loop (honeycomb/src/daemon/runtime/services/poll-loop.ts)
 * per PRD-002b:
 *   - tick -> run one pass,
 *   - skip a tick if the previous run is still in flight (overlap guard),
 *   - reschedule via a backoff state machine: reset to the floor when a tick did
 *     work, step toward the ceiling when it was idle.
 * The loop owns no wall clock and no I/O: the timer seam is injected so it is
 * deterministic under a manual clock in tests.
 */

/** A single pass. Returns true if it did work (reset backoff), false if idle (step toward ceiling). */
export type Tick = () => Promise<boolean> | boolean;

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Default timer backed by Node's global timers. */
export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PollLoopOptions {
  readonly tick: Tick;
  /** Backoff floor (fast cadence when there is work). */
  readonly floorMs: number;
  /** Backoff ceiling (slow cadence when idle). Defaults to floorMs (no backoff). */
  readonly ceilingMs?: number;
  /** Multiplier applied to the delay on each idle tick. Defaults to 2. */
  readonly backoffFactor?: number;
  readonly timer?: Timer;
  readonly onError?: (err: unknown) => void;
}

export class PollLoop {
  private readonly tick: Tick;
  private readonly floorMs: number;
  private readonly ceilingMs: number;
  private readonly backoffFactor: number;
  private readonly timer: Timer;
  private readonly onError: (err: unknown) => void;

  private running = false;
  private inFlight = false;
  private handle: unknown = null;
  private currentDelayMs: number;
  /** Bumped on every start() and stop(); a pump/schedule from an older generation is ignored. */
  private generation = 0;

  constructor(opts: PollLoopOptions) {
    this.tick = opts.tick;
    this.floorMs = Math.max(1, opts.floorMs);
    this.ceilingMs = Math.max(this.floorMs, opts.ceilingMs ?? opts.floorMs);
    this.backoffFactor = Math.max(1, opts.backoffFactor ?? 2);
    this.timer = opts.timer ?? realTimer;
    this.onError = opts.onError ?? (() => {});
    this.currentDelayMs = this.floorMs;
  }

  get currentDelay(): number {
    return this.currentDelayMs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Arm the loop. Idempotent: a second start while running is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.currentDelayMs = this.floorMs;
    this.schedule(0, this.generation);
  }

  /** Disarm the loop. Idempotent. An in-flight tick is allowed to finish but cannot reschedule. */
  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
  }

  /**
   * Run exactly one lease pass. Skips (returns false) if a previous run is still
   * in flight, so a slow tick never overlaps itself. A skipped tick does NOT
   * feed the backoff state machine. Errors are routed to onError and treated as
   * idle for backoff purposes.
   */
  async runOnce(): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      return await this.tick();
    } catch (err) {
      this.onError(err);
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  private schedule(delayMs: number, gen: number): void {
    if (!this.running || gen !== this.generation) return;
    this.handle = this.timer.set(() => {
      void this.pump(gen);
    }, delayMs);
  }

  private async pump(gen: number): Promise<void> {
    if (!this.running || gen !== this.generation) return;
    const didWork = await this.runOnce();
    // A stop()/start() may have happened while the tick was in flight; if so this
    // is a stale generation and must not reschedule (that would leave two active
    // schedules on one loop).
    if (!this.running || gen !== this.generation) return;
    // Backoff: schedule the NEXT tick at the current delay, then advance the
    // delay for the tick after that. A tick that did work resets to the floor;
    // an idle tick steps toward the ceiling. This makes the first idle tick fire
    // at the floor, and only consecutive idles grow the interval.
    const nextDelay = didWork ? this.floorMs : this.currentDelayMs;
    this.currentDelayMs = didWork
      ? this.floorMs
      : Math.min(
          this.ceilingMs,
          Math.max(this.floorMs, Math.round(this.currentDelayMs * this.backoffFactor)),
        );
    this.schedule(nextDelay, gen);
  }
}
