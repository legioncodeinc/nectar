/**
 * The shared in-process brood guard (PRD-018g / NEC-011 AC-018g.1/.2).
 *
 * ONE guard instance, owned by the daemon composition root, is shared by every
 * path that can start a brood - the boot auto-brood and the API's
 * `POST /api/hive-graph/build` handler - so at most one brood runs per daemon at
 * a time (no concurrent double-brood, no double-mint). The same instance also
 * lets the enricher cycle observe that a brood is active (`active()`) and pause,
 * so it never describes rows the brood is mid-describe on.
 *
 * This lives in its own module (not `daemon.ts`) so both `daemon.ts` and
 * `api/hive-graph-api.ts` can import it without a circular dependency.
 */
export interface BroodGuard {
  /** Begin a brood if none is in flight. Returns true on acquisition, false if one is already active. */
  tryAcquire(): boolean;
  /** End the in-flight brood, allowing the next acquisition. Idempotent. */
  release(): void;
  /** True while a brood is in flight. */
  active(): boolean;
}

/** Build a fresh, unheld {@link BroodGuard}. */
export function createBroodGuard(): BroodGuard {
  let inFlight = false;
  return {
    tryAcquire(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release(): void {
      inFlight = false;
    },
    active(): boolean {
      return inFlight;
    },
  };
}
