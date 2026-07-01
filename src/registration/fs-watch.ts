/**
 * File-watch intake with debounce (PRD-006a).
 *
 * Wraps `node:fs.watch` (directory-level, recursive) and debounces per path with
 * `setTimeout`/`clearTimeout`: multiple uncorrelated `(eventType, filename)`
 * observations on the same path within the window collapse to one "path changed"
 * signal, which then enters the re-association ladder. This mirrors honeycomb's
 * `file-watcher.ts` pattern; chokidar is deliberately NOT a dependency (decision #4).
 *
 * The timer seam is injected so tests are deterministic under a manual clock.
 */
import { watch, type FSWatcher } from "node:fs";
import { realTimer, type Timer } from "../poll-loop.js";

export interface WatchIntakeOptions {
  readonly root: string;
  /** DEFAULT - confirm before implementation. Mirrors honeycomb's file-watcher debounce. */
  readonly debounceMs?: number;
  readonly onPathChanged: (relPath: string) => void;
  readonly timer?: Timer;
  readonly onError?: (err: unknown) => void;
}

export const DEFAULT_DEBOUNCE_MS = 500;

export class WatchIntake {
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly onPathChanged: (relPath: string) => void;
  private readonly timer: Timer;
  private readonly onError: (err: unknown) => void;

  private watcher: FSWatcher | null = null;
  private readonly pending = new Map<string, unknown>();

  constructor(opts: WatchIntakeOptions) {
    this.root = opts.root;
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.onPathChanged = opts.onPathChanged;
    this.timer = opts.timer ?? realTimer;
    this.onError = opts.onError ?? (() => {});
  }

  /**
   * Feed a raw watch observation into the debouncer. Public so tests can drive it
   * without a real filesystem; `start()` wires `fs.watch` to call this.
   */
  observe(relPath: string): void {
    if (relPath === "") return;
    const normalized = relPath.replace(/\\/g, "/");
    const existing = this.pending.get(normalized);
    if (existing !== undefined) this.timer.clear(existing);
    const handle = this.timer.set(() => {
      this.pending.delete(normalized);
      try {
        this.onPathChanged(normalized);
      } catch (err) {
        this.onError(err);
      }
    }, this.debounceMs);
    this.pending.set(normalized, handle);
  }

  /** Begin watching the root recursively. Idempotent. */
  start(): void {
    if (this.watcher !== null) return;
    this.watcher = watch(this.root, { recursive: true }, (_eventType, filename) => {
      if (filename === null) return;
      this.observe(String(filename));
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
