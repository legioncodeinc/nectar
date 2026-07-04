/**
 * A per-project brood + watch running context (PRD-019a).
 *
 * Encapsulates ONE bound project's live machinery - the update-on-change
 * registration pipeline (a {@link StoreBridge} + {@link RegistrationService}) and
 * the auto-brood trigger - parameterized by `(root, tenancy, store)` instead of
 * the daemon's former module-level single root. The multi-root supervisor
 * (`src/project-supervisor.ts`) stands one of these up per active project and
 * tears it down on unbind / brooding-off, so discovery for one project never
 * enumerates paths under another (each context is rooted at its own bound path
 * and scoped to its own tenancy project id).
 *
 * This mirrors the single-root wiring in `src/daemon.ts` (`buildRegistration` +
 * `triggerAutoBrood`) rather than duplicating its logic inline in the daemon; the
 * ignore predicate, the disk fs, and the brood runner are the same shared pieces.
 * Each context owns its OWN brood guard so two projects can brood concurrently
 * without one blocking the other.
 */
import { createBroodGuard } from "../brood-guard.js";
import type { Timer } from "../poll-loop.js";
import type { Tenancy } from "../hive-graph/model.js";
import type { AsyncHiveGraphStore } from "../hive-graph/store.js";
import type { PipelineMetricsSink } from "../telemetry/index.js";
import { createDiskRegistrationFs } from "./disk-fs.js";
import { createSharedIgnore, type IgnorePredicate, type SharedIgnore } from "./ignore.js";
import { RegistrationService, type RegistrationFs } from "./service.js";
import type { WatcherState } from "./fs-watch.js";
import { StoreBridge } from "./store-bridge.js";
import { createTlshFuzzyStep, DEFAULT_TUNABLE_FUZZY_CONFIG, type FuzzyConfig } from "./tlsh.js";
import type { PendingReviewStore } from "./review-store.js";
import {
  discoverFiles,
  evaluateAutoBroodAsync,
  prepareFiles,
  runBroodAsync,
  shouldAutoBrood,
  type AsyncBroodConfig,
  type AsyncBroodRuntimeDeps,
  type BroodResult,
  type BroodRunOptions,
} from "../brooding/index.js";
import { runBootProjectionLoad } from "../daemon.js";
import { projectionFinalPath } from "../projection/write.js";
import { DEFAULT_PROJECTION_REL_PATH } from "../projection/format.js";
import type { InheritRow } from "../projection/inherit.js";
import type { RunningContext } from "../project-supervisor.js";
import type { ResolvedProject } from "../hive-graph/active-projects.js";

export interface ProjectContextDeps {
  readonly project: ResolvedProject;
  readonly tenancy: Tenancy;
  /** The durable async store the watch pipeline persists to and auto-brood evaluates against. */
  readonly store: AsyncHiveGraphStore;
  /** Auto-brood runtime deps (describe transport, embed provider). Absent -> auto-brood is skipped. */
  readonly broodDeps?: AsyncBroodRuntimeDeps;
  /** Extra async brood config (never overrides store/tenancy/root/fs/isIgnored). */
  readonly broodConfig?: Partial<Omit<AsyncBroodConfig, "store" | "tenancy" | "root" | "fs" | "isIgnored">>;
  readonly broodOptions?: BroodRunOptions;
  /** Disable auto-brood for this context (still watches). Default: enabled when broodDeps is present. */
  readonly autoBroodEnabled?: boolean;
  /**
   * PRD-011b AC-6, per project (PRD-019 remediation): on `start()`, load +
   * validate this root's own `<root>/.honeycomb/nectars.json` and inherit
   * hash-matched files into the durable store with ZERO LLM calls, mirroring
   * what the single-root daemon's `runBootProjectionLoad` did for the one cwd
   * root. Fail-soft: a missing/invalid projection is skipped with no error.
   * Default: enabled; set false to skip (tests that want no disk scan).
   */
  readonly projectionPreWarm?: boolean;
  /** Registration fs override (default: `createDiskRegistrationFs(root, isIgnored)`). */
  readonly registrationFs?: RegistrationFs;
  /** Shared ignore override (default: `createSharedIgnore(root)`). */
  readonly sharedIgnore?: SharedIgnore;
  readonly reviews?: PendingReviewStore;
  readonly fuzzyConfig?: FuzzyConfig;
  readonly timer?: Timer;
  readonly debounceMs?: number;
  readonly metrics?: PipelineMetricsSink;
  /** Wrap the durable store (e.g. with telemetry) before auto-brood runs against it. Default: identity. */
  readonly wrapBroodStore?: (store: AsyncHiveGraphStore) => AsyncHiveGraphStore;
  readonly log?: (line: Record<string, unknown>) => void;
  /** Observe watcher liveness changes (surfaced on `/health`). */
  readonly onWatcherStateChange?: (state: WatcherState) => void;
  /** Observe a durable-flush failure from the bridge. */
  readonly onFlushError?: (err: unknown, op: string) => void;
  /** The brood runner (default: {@link runBroodAsync}); injectable for tests. */
  readonly broodRun?: (
    config: AsyncBroodConfig,
    deps?: AsyncBroodRuntimeDeps,
    options?: BroodRunOptions,
  ) => Promise<BroodResult>;
}

/**
 * Build a {@link RunningContext} for one project. Construction is side-effect
 * light (no watcher, no brood); `start()` runs auto-brood, then hydrates the
 * bridge, starts the watcher, and requests the single cold-catch-up resync;
 * `stop()` stops the watcher and drains the bridge writes before the context is
 * released (a-AC-7).
 */
export function createProjectContext(deps: ProjectContextDeps): RunningContext {
  const { project, tenancy, store } = deps;
  const root = project.path;
  const log = deps.log ?? (() => {});
  const sharedIgnore = deps.sharedIgnore ?? createSharedIgnore(root);
  const isIgnored: IgnorePredicate = (relPath: string) => sharedIgnore.isIgnored(relPath);
  const fs = deps.registrationFs ?? createDiskRegistrationFs(root, isIgnored);
  const broodGuard = createBroodGuard();

  let watcher: WatcherState = "stopped";
  let service: RegistrationService | null = null;
  let bridge: StoreBridge | null = null;
  let closed = false;

  /**
   * The per-project projection pre-warm (PRD-011b AC-6 in the multi-root
   * world): validate `<root>/.honeycomb/nectars.json` against THIS project's
   * tenancy and inherit hash-matched files into the durable store, so a fresh
   * clone recalls without a brood. The disk scan runs only when the file
   * validates (runBootProjectionLoad defers `diskHashes` behind validation).
   */
  async function runProjectionPreWarm(): Promise<void> {
    if (deps.projectionPreWarm === false) return;
    try {
      await runBootProjectionLoad({
        tenancy,
        filePath: projectionFinalPath(root, DEFAULT_PROJECTION_REL_PATH),
        diskHashes: () => {
          const discovery = discoverFiles({ root, fs, isIgnored });
          const prepared = prepareFiles(fs, discovery.files);
          return new Map(prepared.map((p) => [p.file.relPath, p.contentHash] as const));
        },
        existingNectars: async () => {
          const latest = await store.listLatestVersions(tenancy);
          return new Set(latest.map((lv) => lv.identity.nectar));
        },
        write: async (rows: readonly InheritRow[]) => {
          for (const row of rows) {
            if ((await store.getIdentity(row.identity.nectar)) === undefined) {
              await store.insertIdentity(row.identity);
            }
            await store.appendVersion(row.version);
          }
        },
      });
    } catch (err) {
      // fail-soft: recall is simply not pre-warmed; the context still starts.
      log({ level: "error", scope: "project-context.projection", projectId: project.projectId, err: String(err) });
    }
  }

  async function runAutoBrood(): Promise<void> {
    const broodDeps = deps.broodDeps;
    if (broodDeps === undefined) return;
    if ((deps.autoBroodEnabled ?? true) === false) return;
    if (!broodGuard.tryAcquire()) return;
    try {
      if (!shouldAutoBrood(await evaluateAutoBroodAsync(store, tenancy, root))) return;
      const wrapped = deps.wrapBroodStore ? deps.wrapBroodStore(store) : store;
      const config: AsyncBroodConfig = {
        isIgnored,
        ...deps.broodConfig,
        store: wrapped,
        tenancy,
        root,
        fs,
      };
      const run = deps.broodRun ?? runBroodAsync;
      await run(config, broodDeps, deps.broodOptions ?? {});
    } catch (err) {
      log({ level: "error", scope: "project-context.brood", projectId: project.projectId, err: String(err) });
    } finally {
      broodGuard.release();
    }
  }

  return {
    projectId: project.projectId,
    path: root,
    watcherState: () => watcher,
    async start(): Promise<void> {
      if (closed) return;
      // Projection pre-warm first (inherit hash-matched files with zero LLM
      // calls, so a fresh clone's auto-brood evaluation sees the inherited
      // rows), then brood (so a first boot's brood never races the watcher
      // into a double mint), then hydrate + watch + cold-catch-up resync.
      await runProjectionPreWarm();
      if (closed) return;
      await runAutoBrood();
      if (closed) return;
      bridge = new StoreBridge({
        durable: store,
        onFlushError: (err, op) => {
          deps.onFlushError?.(err, op);
          log({ level: "error", scope: "project-context.bridge", projectId: project.projectId, op, err: String(err) });
        },
      });
      service = new RegistrationService({
        store: bridge,
        tenancy,
        fs,
        root,
        fuzzy: createTlshFuzzyStep(deps.fuzzyConfig ?? DEFAULT_TUNABLE_FUZZY_CONFIG),
        isIgnored,
        ...(deps.reviews !== undefined ? { pendingReviews: deps.reviews } : {}),
        ...(deps.timer !== undefined ? { timer: deps.timer } : {}),
        ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
        ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
        log,
        onResyncRequested: () => sharedIgnore.refresh(),
        onWatcherStateChange: (state: WatcherState) => {
          watcher = state;
          deps.onWatcherStateChange?.(state);
        },
      });
      try {
        await bridge.hydrate(tenancy);
      } catch (err) {
        log({ level: "error", scope: "project-context.hydrate", projectId: project.projectId, err: String(err) });
      }
      if (closed) return;
      service.start();
      watcher = "running";
      service.requestResync();
    },
    async stop(): Promise<void> {
      closed = true;
      if (service !== null) {
        service.stop();
        try {
          await service._waitForIdle();
        } catch {
          // best-effort drain
        }
      }
      if (bridge !== null) {
        try {
          await bridge.whenFlushed();
        } catch {
          // best-effort drain
        }
      }
      watcher = "stopped";
    },
  };
}
