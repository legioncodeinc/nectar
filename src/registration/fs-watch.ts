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
 * The timer seam is injected so tests are deterministic under a manual clock.
 */
import { watch, type FSWatcher } from "node:fs";
import { realTimer, type Timer } from "../poll-loop.js";
import type { IgnorePredicate } from "./ignore.js";
import { isSafeRelPath } from "./paths-safe.js";

export interface WatchIntakeOptions {
  readonly root: string;
  /** DEFAULT - confirm before implementation. Mirrors honeycomb's file-watcher debounce. */
  readonly debounceMs?: number;
  readonly onPathChanged: (relPath: string) => void;
  /** Fired (debounced) when a null-filename observation demands a full workspace resync (AC-3). */
  readonly onResync?: () => void;
  /** Ignore contract; an ignored path never reaches the scheduler (AC-5). Defaults to allow-all. */
  readonly isIgnored?: IgnorePredicate;
  readonly timer?: Timer;
  readonly onError?: (err: unknown) => void;
}

export const DEFAULT_DEBOUNCE_MS = 500;

/** The sentinel debounce key for the full-resync settle (kept distinct from any real path). */
const RESYNC_KEY = "\u0000resync";

export class WatchIntake {
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly onPathChanged: (relPath: string) => void;
  private readonly onResync: () => void;
  private readonly isIgnored: IgnorePredicate;
  private readonly timer: Timer;
  private readonly onError: (err: unknown) => void;

  private watcher: FSWatcher | null = null;
  private readonly pending = new Map<string, unknown>();

  constructor(opts: WatchIntakeOptions) {
    this.root = opts.root;
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.onPathChanged = opts.onPathChanged;
    this.onResync = opts.onResync ?? (() => {});
    this.isIgnored = opts.isIgnored ?? (() => false);
    this.timer = opts.timer ?? realTimer;
    this.onError = opts.onError ?? (() => {});
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
    const existing = this.pending.get(key);
    if (existing !== undefined) this.timer.clear(existing);
    const handle = this.timer.set(() => {
      this.pending.delete(key);
      try {
        fire();
      } catch (err) {
        this.onError(err);
      }
    }, this.debounceMs);
    this.pending.set(key, handle);
  }

  /** Begin watching the root recursively. Idempotent. */
  start(): void {
    if (this.watcher !== null) return;
    this.watcher = watch(this.root, { recursive: true }, (_eventType, filename) => {
      this.observeRaw(filename === null ? null : String(filename));
    });
    this.watcher.on("error", (err) => this.onError(err));
  }

  /** Stop watching and cancel every pending debounce. Idempotent. */
  stop(): void {
    for (const handle of this.pending.values()) this.timer.clear(handle);
    this.pending.clear();
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
