/**
 * Enricher failure ladder + persistent alert state (PRD-016c).
 */

import { DEFAULT_PERSISTENT_FAILURE_THRESHOLD } from "./config.js";

export interface PersistentFailureState {
  consecutiveFailures: number;
  alertRaised: boolean;
  acknowledged: boolean;
}

export function createPersistentFailureState(): PersistentFailureState {
  return { consecutiveFailures: 0, alertRaised: false, acknowledged: false };
}

export interface CycleFailureInput {
  readonly hadWork: boolean;
  readonly cycleFailed: boolean;
  readonly threshold?: number;
}

/**
 * Update persistent-failure counters after a cycle.
 *
 * Idle cycles (no work) neither increment nor reset. Successful cycles reset.
 */
export function advancePersistentFailureState(
  state: PersistentFailureState,
  input: CycleFailureInput,
): PersistentFailureState {
  const threshold = input.threshold ?? DEFAULT_PERSISTENT_FAILURE_THRESHOLD;
  if (!input.hadWork) return state;
  if (!input.cycleFailed) {
    return { ...state, consecutiveFailures: 0 };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  const alertRaised = consecutiveFailures >= threshold;
  return {
    consecutiveFailures,
    alertRaised,
    acknowledged: alertRaised ? false : state.acknowledged,
  };
}

export function acknowledgePersistentAlert(state: PersistentFailureState): PersistentFailureState {
  return {
    ...state,
    alertRaised: false,
    acknowledged: true,
    consecutiveFailures: 0,
  };
}

export function enrichmentHalted(state: PersistentFailureState): boolean {
  return state.alertRaised && !state.acknowledged;
}

/** Split a batch in half for context-window recovery (PRD-016c AC-2). */
export function splitBatch<T>(items: readonly T[]): [T[], T[]] {
  if (items.length <= 1) return [[...items], []];
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}
