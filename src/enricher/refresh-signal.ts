/**
 * The enricher working-set refresh signal (scale-to-zero).
 *
 * The steady-state enricher cycle re-seeds its in-memory mirror from Deep Lake
 * (`refreshWorkingSet` -> `DeepLakeEnricherStore.refresh` -> a
 * `SELECT ... FROM hive_graph_versions`) so version rows the registration watcher
 * appended after boot become visible to the enricher's SEPARATE mirror. Doing
 * that unconditionally on every ~30s tick means an idle repo (no file changes,
 * nothing to enrich) still issues a Deep Lake read every 30s forever, which keeps
 * the Activeloop serverless pod warm and defeats its scale-to-zero. That is the
 * same idle-burn class honeycomb removed in PRD-062b; nectar re-introduced it by
 * refreshing on every cycle.
 *
 * This one-bit signal gates the refresh. The registration leg is the ONLY
 * producer of new durable rows this daemon writes, so it `markDirty()`s after
 * each successful durable write; the enricher `consume()`s the flag to decide
 * whether a refresh is worth a network round trip. When no file has changed the
 * flag stays clear, the enricher issues NO Deep Lake read, and the pod idles to
 * zero. The enricher's own describe write-backs go through a different store and
 * never mark this signal, so there is no self-triggering refresh loop.
 */

/** A read-and-clear "durable rows may have changed" flag shared by producer and consumer. */
export interface RefreshSignal {
  /** Producer (registration): a durable write happened; the next enricher tick should refresh. */
  markDirty(): void;
  /** Consumer (enricher): read-and-clear. Returns true (and resets to clean) when a refresh is warranted. */
  consume(): boolean;
  /** Non-destructive read, for tests and observability. Does NOT clear the flag. */
  readonly dirty: boolean;
}

/**
 * Create a {@link RefreshSignal}. Defaults to dirty so the FIRST enricher cycle
 * always refreshes once (picking up any rows persisted before this boot, e.g. a
 * prior session that appended `pending` rows but never described them); every
 * subsequent refresh is gated on real registration activity.
 */
export function createRefreshSignal(initiallyDirty = true): RefreshSignal {
  let dirty = initiallyDirty;
  return {
    markDirty(): void {
      dirty = true;
    },
    consume(): boolean {
      const was = dirty;
      dirty = false;
      return was;
    },
    get dirty(): boolean {
      return dirty;
    },
  };
}
