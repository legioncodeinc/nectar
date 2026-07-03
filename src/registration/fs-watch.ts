/**
 * File-watch intake with debounce (PRD-006a).
 *
 * Wraps `node:fs.watch` (directory-level, recursive) and debounces per path with
 * `setTimeout`/`clearTimeout`: multiple uncorrelated `(eventType, filename)`
 * observations on the same path within the window collapse to one "path changed"
 * signal, which then enters the re-association ladder. This mirrors honeycomb's
 * `file-watcher.ts` pattern; chokidar is deliberately NOT a dependency (decision #4).
 *
 * Two intake behaviors beyond the plain per-path debounce:
 *   - A `null`/`undefined` filename observation (some platforms emit null on a
 *     directory-level event, per honeycomb `file-watcher.ts:342-345`) triggers a
 *     debounced FULL resync settle via `onResync`, not a dropped event (AC-3).
 *   - Every observation is filtered through the injected ignore contract before
 *     it reaches the debounce scheduler, so ignored paths (`.git/`,
 *     `node_modules/`, the per-repo `graph-ignore.json` set) never trigger a
 *     cycle (AC-5). No nectar-specific ignore list is invented.
 *
 * PRD-018c NEC-009 / AC-018c.6/7: a raw `fs.watch` error (Linux `ENOSPC`,
 * `EPERM`/`EBUSY` on a renamed/recreated root) no longer kills live updates
 * permanently. The watcher is closed and re-`watch()`ed with exponential
 * backoff; a successful re-attach requests a full resync (via the SAME
 * debounced `requestResync` path AC-3 already established) so the outage
 * window is reconciled; repeated failures beyond `maxRestartAttempts` park the
 * intake in a "degraded" state instead of looping hot. `onStateChange`
 * surfaces "running" / "restarting" / "degraded" / "stopped" so `/health` can
 * show watcher liveness (AC-018c.6/7).
 *
 * The timer seam is injected so tests are deterministic under a manual clock.
 */
import { watch } from "node:fs";
import { realTimer, type Timer } from "../poll-loop.js";
import type { IgnorePredicate } from "./ignore.js";
import { isSafeRelPath } from "./paths-safe.js";

/** The watcher's own liveness state (PRD-018c AC-018c.6/7), independent of debounce state. */
export type WatcherState = "stopped" | "running" | "restarting" | "degraded";

/** The minimal shape `WatchIntake` needs from a watch handle - `node:fs`'s real `FSWatcher` satisfies this structurally. */
export interface WatchHandle {
  on(event: "error", listener: (err: unknown) => void): unknown;
  close(): void;
}

/** The raw `fs.watch`-shaped constructor. Injectable (PRD-018c AC-018c.6/7) so a test can simulate a watcher error/restart cycle without a real filesystem. Defaults to `node:fs`'s `watch`. */
export type WatchFn = (
  path: string,
  options: { readonly recursive: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => WatchHandle;

export interface WatchIntakeOptions {
  readonly root: string;
  /** DEFAULT - confirm before implementation. Mirrors honeycomb's file-watcher debounce. */
  readonly debounceMs?: number;
  readonly onPathChanged: (relPath: string) => void;
  /**
   * Max total deferral for a single path (NEC-042 item 9 / AC-018l.16). A path
   * written more often than `debounceMs` never settles under a pure debounce; a
   * max-wait cap forces the change through once this window elapses since the
   * FIRST observation of the burst, regardless of continuing events. Default:
   * {@link DEFAULT_MAX_WAIT_MULTIPLIER} x `debounceMs`.
   */
  readonly maxWaitMs?: number;
  /** Fired (debounced) when a null-filename observation demands a full workspace resync (AC-3). */
  readonly onResync?: () => void;
  /** Ignore contract; an ignored path never reaches the scheduler (AC-5). Defaults to allow-all. */
  readonly isIgnored?: IgnorePredicate;
  readonly timer?: Timer;
  readonly onError?: (err: unknown) => void;
  /** Fired whenever the watcher's liveness state changes (AC-018c.6/7). Defaults to a no-op. */
  readonly onStateChange?: (state: WatcherState) => void;
  /** Backoff floor for a restart-after-error (ms). DEFAULT 1000. */
  readonly restartBackoffFloorMs?: number;
  /** Backoff ceiling for a restart-after-error (ms). DEFAULT 30000. */
  readonly restartBackoffCeilingMs?: number;
  /** Consecutive restart failures before parking "degraded" (AC-018c.7). DEFAULT 5. */
  readonly maxRestartAttempts?: number;
  /** The raw watch constructor (default: `node:fs`'s `watch`). Injectable for deterministic error/restart tests (AC-018c.6/7). */
  readonly watchFn?: WatchFn;
}

export const DEFAULT_DEBOUNCE_MS = 500;
/** Default max-wait cap as a multiple of the debounce window (NEC-042 item 9 / AC-018l.16). */
export const DEFAULT_MAX_WAIT_MULTIPLIER = 10;
export const DEFAULT_RESTART_BACKOFF_FLOOR_MS = 1_000;
export const DEFAULT_RESTART_BACKOFF_CEILING_MS = 30_000;
export const DEFAULT_MAX_RESTART_ATTEMPTS = 5;

/** The sentinel debounce key for the full-resync settle (kept distinct from any real path). */
const RESYNC_KEY = "\u0000resync";

export class WatchIntake {
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onPathChanged: (relPath: string) => void;
  private readonly onResync: () => void;
  private readonly isIgnored: IgnorePredicate;
  private readonly timer: Timer;
  private readonly onError: (err: unknown) => void;
  private readonly onStateChange: (state: WatcherState) => void;
  private readonly restartBackoffFloorMs: number;
  private readonly restartBackoffCeilingMs: number;
  private readonly maxRestartAttempts: number;
  private readonly watchFn: WatchFn;

  private watcher: WatchHandle | null = null;
  private readonly pending = new Map<string, unknown>();
  /** Per-key max-wait timers (AC-018l.16): armed once per burst, NOT reset per observation. */
  private readonly maxWaitPending = new Map<string, unknown>();
  /** Per-key burst guard so the debounce timer and the max-wait cap fire the settle at most once. */
  private readonly bursts = new Map<string, { fired: boolean }>();
  private state: WatcherState = "stopped";
  private restartAttempts = 0;
  private restartHandle: unknown = null;
  /** Set by `stop()`; suppresses any restart scheduled by a since-superseded error. */
  private stopped = true;

  constructor(opts: WatchIntakeOptions) {
    this.root = opts.root;
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    // The cap never sits below the debounce window (a cap shorter than the
    // debounce would defeat the debounce entirely).
    this.maxWaitMs = Math.max(this.debounceMs, opts.maxWaitMs ?? this.debounceMs * DEFAULT_MAX_WAIT_MULTIPLIER);
    this.onPathChanged = opts.onPathChanged;
    this.onResync = opts.onResync ?? (() => {});
    this.isIgnored = opts.isIgnored ?? (() => false);
    this.timer = opts.timer ?? realTimer;
    this.onError = opts.onError ?? (() => {});
    this.onStateChange = opts.onStateChange ?? (() => {});
    this.restartBackoffFloorMs = Math.max(1, opts.restartBackoffFloorMs ?? DEFAULT_RESTART_BACKOFF_FLOOR_MS);
    this.restartBackoffCeilingMs = Math.max(
      this.restartBackoffFloorMs,
      opts.restartBackoffCeilingMs ?? DEFAULT_RESTART_BACKOFF_CEILING_MS,
    );
    this.maxRestartAttempts = Math.max(1, opts.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS);
    this.watchFn = opts.watchFn ?? (watch as unknown as WatchFn);
  }

  /** The watcher's current liveness state (AC-018c.6/7). */
  get watcherState(): WatcherState {
    return this.state;
  }

  /**
   * Route one raw `fs.watch` observation. A null/undefined filename (a
   * directory-level event with no specific path on some platforms) requests a
   * full resync; a concrete filename goes through the per-path debounce. Public
   * so tests can drive both branches without a real filesystem.
   */
  observeRaw(filename: string | null | undefined): void {
    if (filename === null || filename === undefined) {
      this.requestResync();
      return;
    }
    this.observe(String(filename));
  }

  /**
   * Feed a concrete path observation into the debouncer. Ignored paths are
   * dropped before scheduling. Public so tests can drive it without a real
   * filesystem; `start()` wires `fs.watch` through `observeRaw` to call this.
   */
  observe(relPath: string): void {
    if (relPath === "") return;
    const normalized = relPath.replace(/\\/g, "/");
    // Containment first (CWE-22): an absolute path or a `..` traversal is dropped
    // before it can be ignore-tested, scheduled, or ever reach a stat/read.
    if (!isSafeRelPath(normalized)) return;
    if (this.isIgnored(normalized)) return;
    this.schedule(normalized, () => this.onPathChanged(normalized));
  }

  /**
   * Request a debounced full-workspace resync settle (AC-3). Collapses a burst
   * of null-filename events into a single `onResync` the same way a per-path
   * burst collapses into one signal.
   */
  requestResync(): void {
    this.schedule(RESYNC_KEY, () => this.onResync());
  }

  private schedule(key: string, fire: () => void): void {
    // One guard per burst, shared by the debounce timer AND the max-wait cap so
    // whichever elapses first fires the settle exactly once and the other becomes
    // a no-op (even if a test timer fires both from one snapshot).
    let burst = this.bursts.get(key);
    if (burst === undefined) {
      burst = { fired: false };
      this.bursts.set(key, burst);
    }
    const guard = burst;
    const fireOnce = (): void => {
      if (guard.fired) return;
      guard.fired = true;
      const debounceHandle = this.pending.get(key);
      if (debounceHandle !== undefined) {
        this.timer.clear(debounceHandle);
        this.pending.delete(key);
      }
      const maxWaitHandle = this.maxWaitPending.get(key);
      if (maxWaitHandle !== undefined) {
        this.timer.clear(maxWaitHandle);
        this.maxWaitPending.delete(key);
      }
      this.bursts.delete(key);
      try {
        fire();
      } catch (err) {
        this.onError(err);
      }
    };

    // (Re)arm the per-observation debounce timer.
    const existing = this.pending.get(key);
    if (existing !== undefined) this.timer.clear(existing);
    this.pending.set(key, this.timer.set(fireOnce, this.debounceMs));

    // Arm the max-wait cap ONCE per burst (AC-018l.16): it is NOT reset by later
    // observations, so a path written faster than the debounce still settles when
    // the cap elapses. Only meaningful when the cap exceeds the debounce window.
    if (this.maxWaitMs > this.debounceMs && !this.maxWaitPending.has(key)) {
      this.maxWaitPending.set(key, this.timer.set(fireOnce, this.maxWaitMs));
    }
  }

  /** Begin watching the root recursively. Idempotent. */
  start(): void {
    if (this.watcher !== null) return;
    this.stopped = false;
    this.restartAttempts = 0;
    if (this.restartHandle !== null) {
      this.timer.clear(this.restartHandle);
      this.restartHandle = null;
    }
    this.attach();
  }

  private attach(): void {
    this.watcher = this.watchFn(this.root, { recursive: true }, (_eventType, filename) => {
      this.observeRaw(filename === null ? null : String(filename));
    });
    this.watcher.on("error", (err) => this.handleWatcherError(err));
    this.setState("running");
  }

  /**
   * PRD-018c NEC-009 / AC-018c.6/7: an `fs.watch` error means the underlying
   * `FSWatcher` is typically dead. Close it, log via `onError` (preserving the
   * pre-018c logging behavior), and - unless `stop()` already superseded this
   * error - schedule a backoff-guarded restart rather than leaving live
   * updates dead while `/health` still reports the daemon healthy.
   */
  private handleWatcherError(err: unknown): void {
    this.onError(err);
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // already dead; nothing to clean up
      }
      this.watcher = null;
    }
    if (this.stopped) return; // an owner-initiated stop() wins; never restart after that
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    this.restartAttempts += 1;
    if (this.restartAttempts > this.maxRestartAttempts) {
      // AC-018c.7: repeated failures park the watcher degraded instead of
      // looping hot. The periodic resync backstop (service.ts) is the
      // remaining reconciliation path while degraded.
      this.setState("degraded");
      return;
    }
    this.setState("restarting");
    const delay = Math.min(
      this.restartBackoffCeilingMs,
      Math.round(this.restartBackoffFloorMs * Math.pow(2, this.restartAttempts - 1)),
    );
    this.restartHandle = this.timer.set(() => {
      this.restartHandle = null;
      if (this.stopped) return;
      try {
        this.attach();
        this.restartAttempts = 0; // a successful re-attach resets the backoff
        // AC-018c.6: reconcile the outage window through the SAME debounced
        // resync path a null-filename observation already uses (AC-3).
        this.requestResync();
      } catch (err) {
        this.onError(err);
        this.scheduleRestart(); // still failing; keep backing off
      }
    }, delay);
  }

  private setState(next: WatcherState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(next);
  }

  /** Stop watching, cancel every pending debounce, and cancel any scheduled restart. Idempotent. */
  stop(): void {
    this.stopped = true;
    for (const handle of this.pending.values()) this.timer.clear(handle);
    this.pending.clear();
    for (const handle of this.maxWaitPending.values()) this.timer.clear(handle);
    this.maxWaitPending.clear();
    this.bursts.clear();
    if (this.restartHandle !== null) {
      this.timer.clear(this.restartHandle);
      this.restartHandle = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    this.setState("stopped");
  }
}
