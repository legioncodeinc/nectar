/**
 * Enricher poll loop (PRD-016a): flat 30s cadence with overlap guard.
 */
import { PollLoop, type Timer } from "../poll-loop.js";
import { DEFAULT_ENRICHER_POLL_INTERVAL_MS } from "./config.js";
import { acknowledgePersistentAlert, createPersistentFailureState, type PersistentFailureState } from "./failure.js";
import { runEnricherCycle, type EnricherCycleDeps } from "./cycle.js";

export interface EnricherLoopOptions {
  readonly deps: EnricherCycleDeps;
  readonly pollIntervalMs?: number;
  readonly timer?: Timer;
  readonly onError?: (err: unknown) => void;
}

export interface EnricherLoop {
  start(): void;
  stop(): void;
  runOnce(): Promise<boolean>;
  getFailureState(): PersistentFailureState;
  acknowledgeAlert(): void;
}

/** Build the background enricher poll loop (PRD-016 / PRD-002b host seam). */
export function createEnricherLoop(opts: EnricherLoopOptions): EnricherLoop {
  const pollMs = opts.pollIntervalMs ?? opts.deps.config?.pollIntervalMs ?? DEFAULT_ENRICHER_POLL_INTERVAL_MS;
  let failureState: PersistentFailureState = createPersistentFailureState();

  const loop = new PollLoop({
    floorMs: pollMs,
    ceilingMs: pollMs,
    backoffFactor: 1,
    timer: opts.timer,
    onError: opts.onError ?? (() => {}),
    tick: async () => {
      const result = await runEnricherCycle(opts.deps, failureState);
      failureState = result.failureState;
      return result.stats.filesDescribed > 0 || result.stats.filesInherited > 0 || result.stats.filesSkippedDeleted > 0;
    },
  });

  return {
    start: () => loop.start(),
    stop: () => loop.stop(),
    runOnce: () => loop.runOnce(),
    getFailureState: () => ({ ...failureState }),
    acknowledgeAlert: () => {
      failureState = acknowledgePersistentAlert(failureState);
    },
  };
}
