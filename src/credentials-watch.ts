/**
 * The credentials watch (PRD-003a a-AC-2).
 *
 * nectar resolves the shared `~/.deeplake/credentials.json` ONCE at daemon boot
 * (`cli.ts` `runDaemon`), so a daemon that booted before login sat degraded
 * forever. This watch closes that gap: on the daemon's existing poll cadence
 * (mirroring the {@link ActiveProjectsController} reconcile loop's use of the
 * injected {@link PollLoop} timer seam) it re-resolves whether valid credentials
 * are present and, whenever the answer CHANGES, fires `onChange`. The daemon
 * wires `onChange` to `health.setStorageState`, so `/health` transitions from
 * 503 degraded to 200 healthy the moment credentials appear - with no restart
 * and no manual step.
 *
 * The `probe` seam is what makes this a genuine re-resolution rather than a bare
 * existence check: the production probe attempts `loadDeepLakeCredentials()` and
 * reports whether a store could be built (a present-but-malformed file reads as
 * absent, exactly as the boot path treats it). Every seam is injectable so a
 * test drives the whole surface under a manual clock without touching the real
 * home or the real filesystem.
 *
 * Built-ins only (the timer seam); zero runtime dependencies.
 */
import { PollLoop, realTimer, type Timer } from "./poll-loop.js";

export interface CredentialsWatchDeps {
  /**
   * Re-resolve whether valid Deeplake credentials are currently present. The
   * production probe runs `loadDeepLakeCredentials()` and returns `false` on any
   * failure (absent / malformed / missing field); a test injects a fake.
   */
  probe(): boolean;
  /**
   * Called with the resolved presence WHENEVER it changes (including the first
   * evaluation, when the prior state is unknown). Never called twice in a row
   * with the same value.
   */
  onChange(present: boolean): void;
  /** Poll cadence in ms (default: the daemon's poll interval). */
  readonly intervalMs: number;
  /** Injected timer (tests). Default: the real timer. */
  readonly timer?: Timer;
  /** Observe a probe error routed out of the poll loop. Default: no-op. */
  readonly onError?: (err: unknown) => void;
}

export class CredentialsWatch {
  private readonly deps: CredentialsWatchDeps;
  private readonly loop: PollLoop;
  private last: boolean | undefined;
  private started = false;

  constructor(deps: CredentialsWatchDeps) {
    this.deps = deps;
    this.loop = new PollLoop({
      tick: () => this.evaluate(),
      floorMs: Math.max(1, deps.intervalMs),
      timer: deps.timer ?? realTimer,
      ...(deps.onError !== undefined ? { onError: deps.onError } : {}),
    });
  }

  /**
   * Evaluate the probe once. Fires `onChange` (and returns `true`, so the poll
   * loop treats the tick as "did work") only when the resolved presence differs
   * from the last observed value; otherwise a no-op returning `false`.
   */
  evaluate(): boolean {
    const present = this.deps.probe();
    if (present === this.last) return false;
    this.last = present;
    this.deps.onChange(present);
    return true;
  }

  /** Arm the watch (the loop fires an immediate first tick at delay 0). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.loop.start();
  }

  /** Disarm the loop and drain any in-flight probe. Idempotent. */
  async stop(): Promise<void> {
    this.loop.stop();
    await this.loop.whenIdle();
    this.started = false;
  }
}
