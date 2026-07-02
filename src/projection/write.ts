/**
 * Atomic projection writer and debounced rewrite seam (PRD-011a).
 *
 * Mirrors the CodeGraph `writeSnapshotAtomic` pattern: temp file in the same
 * directory, then `renameSync`. Trigger #1/#2 use the debounced writer; trigger
 * #3 (`rebuildProjection`) bypasses debounce and writes immediately (AC-3).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tenancy } from "../source-graph/model.js";
import type { AsyncSourceGraphStore, SourceGraphStore } from "../source-graph/store.js";
import {
  DEFAULT_PROJECTION_REL_PATH,
  canonicalSerialize,
  type PortableProjection,
} from "./format.js";
import {
  buildProjectionFromAsyncStore,
  buildProjectionFromStore,
  type BuildProjectionFromStoreOptions,
  type BuildProjectionOptions,
} from "./generate.js";

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Default timer backed by Node's global timers. */
export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_WRITE_DEBOUNCE_MS = 30_000;

export interface WriteProjectionOptions {
  /** Project root; final path is join(root, relPath). */
  readonly projectRoot: string;
  readonly relPath?: string;
  readonly pid?: number;
  readonly nowMs?: number;
}

export function projectionFinalPath(
  projectRoot: string,
  relPath: string = DEFAULT_PROJECTION_REL_PATH,
): string {
  return join(projectRoot, relPath);
}

/**
 * Serialize and write atomically (temp + rename). A crash mid-write leaves the
 * prior final file intact (AC-1).
 */
export function writeProjectionAtomic(
  doc: PortableProjection,
  opts: WriteProjectionOptions,
): string {
  const relPath = opts.relPath ?? DEFAULT_PROJECTION_REL_PATH;
  const finalPath = projectionFinalPath(opts.projectRoot, relPath);
  const dir = dirname(finalPath);
  mkdirSync(dir, { recursive: true });

  const baseName = relPath.split(/[/\\]/).pop() ?? "nectars.json";
  const pid = opts.pid ?? process.pid;
  const now = opts.nowMs ?? Date.now();
  const tmpPath = join(dir, `.${baseName}.${pid}.${now}.tmp`);

  writeFileSync(tmpPath, canonicalSerialize(doc), "utf8");
  renameSync(tmpPath, finalPath);
  return finalPath;
}

export interface ProjectionWriterOptions {
  readonly projectRoot: string;
  readonly relPath?: string;
  readonly debounceMs?: number;
  readonly timer?: Timer;
  readonly pid?: number;
  readonly nowMs?: () => number;
}

/**
 * Debounced writer for triggers #1 (end of brooding) and #2 (end of enricher
 * cycle). Coalesces rapid rewrites into one flush after `debounceMs`.
 */
export class ProjectionWriter {
  private readonly projectRoot: string;
  private readonly relPath: string;
  private readonly debounceMs: number;
  private readonly timer: Timer;
  private readonly pid: number;
  private readonly nowMs: () => number;

  private pending: PortableProjection | null = null;
  private handle: unknown = null;

  constructor(opts: ProjectionWriterOptions) {
    this.projectRoot = opts.projectRoot;
    this.relPath = opts.relPath ?? DEFAULT_PROJECTION_REL_PATH;
    this.debounceMs = opts.debounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
    this.timer = opts.timer ?? realTimer;
    this.pid = opts.pid ?? process.pid;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** Queue a debounced rewrite (AC-2). */
  scheduleWrite(doc: PortableProjection): void {
    this.pending = doc;
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = this.timer.set(() => {
      this.handle = null;
      this.flushPending();
    }, this.debounceMs);
  }

  /** Cancel a pending debounced write without flushing. */
  cancelPending(): void {
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
    this.pending = null;
  }

  /** Flush immediately if a write is queued (for tests). */
  flushNow(): string | null {
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
    return this.flushPending();
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  private flushPending(): string | null {
    const doc = this.pending;
    if (doc === null) return null;
    this.pending = null;
    return writeProjectionAtomic(doc, {
      projectRoot: this.projectRoot,
      relPath: this.relPath,
      pid: this.pid,
      nowMs: this.nowMs(),
    });
  }
}

export interface RebuildProjectionOptions extends WriteProjectionOptions, BuildProjectionFromStoreOptions {}

/**
 * Full regeneration from the store (trigger #3). Scans latest described per
 * nectar and writes immediately, bypassing debounce (AC-3).
 */
export function rebuildProjection(
  store: SourceGraphStore,
  tenancy: Tenancy,
  opts: RebuildProjectionOptions,
): { doc: PortableProjection; path: string } {
  const doc = buildProjectionFromStore(store, tenancy, opts);
  const path = writeProjectionAtomic(doc, opts);
  return { doc, path };
}

export interface RebuildProjectionAsyncOptions extends WriteProjectionOptions, BuildProjectionOptions {}

/**
 * Full regeneration from the durable {@link AsyncSourceGraphStore} (Deep Lake),
 * trigger #3 (PRD-011c). The async twin of {@link rebuildProjection}: it scans
 * the latest described version per nectar (scoped to the project) and writes
 * immediately, bypassing debounce (AC-3). The `hivenectar rebuild-projection`
 * CLI verb calls this against the real `DeepLakeSourceGraphStore`.
 */
export async function rebuildProjectionAsync(
  store: AsyncSourceGraphStore,
  tenancy: Tenancy,
  opts: RebuildProjectionAsyncOptions,
): Promise<{ doc: PortableProjection; path: string }> {
  const doc = await buildProjectionFromAsyncStore(store, tenancy, opts);
  const path = writeProjectionAtomic(doc, opts);
  return { doc, path };
}
