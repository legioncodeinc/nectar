/**
 * The runtime status check-in writer (PRD-017a), per hivedoctor's
 * `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`.
 *
 * `service_status` (id=1, latest-wins) carries binding time, last-seen, and
 * health - the churning runtime layer hivedoctor merges with the static
 * registry entry (`hivedoctor-registry.ts`). Two writers:
 *   - `checkin()`   a FRESH binding: a new binding_time, an initial last_seen
 *                   equal to it, and the current health (AC-017a.2.1).
 *   - `heartbeat()` advances last_seen (and refreshes health) WITHOUT touching
 *                   binding_time, so hivedoctor can tell "quiet but alive" from
 *                   "dead" purely from the age of last_seen (AC-017a.3.1).
 *
 * `deeplake_connected`/`deeplake_last_comm` are left NULL: hivenectar has no
 * in-process "am I currently connected to Deep Lake" signal today (the
 * `DeepLakeSourceGraphStore` is a stateless per-call HTTP client, not a live
 * connection) - a documented approximation, not a fabricated value. A future
 * PRD that adds real connectivity tracking can populate these columns without
 * a schema change (see PRD-017 evidence).
 *
 * Every write is fail-soft (AC-7 / AC-017a): a locked file, a permissions
 * error, or a missing directory is caught and dropped, never propagated into
 * daemon boot or the nectar pipeline.
 */
import { HIVENECTAR_DAEMON_NAME } from "../hivedoctor-registry.js";
import type { PipelineStatus } from "../health.js";
import { realTimer, type Timer } from "../poll-loop.js";
import type { SqliteDatabaseLike } from "./db.js";

/**
 * SIGNED OFF 2026-07-02 (decision #33, `PRD-DECISIONS-AND-DEFAULTS.md`),
 * amended from the original 10s. hivedoctor polls each service's SQLite
 * roughly every 1s (ADR-0001); hivenectar's own heartbeat is a separate,
 * slower write interval (last-seen only needs to look "fresh enough" relative
 * to hivedoctor's staleness threshold, not to match its poll rate 1:1). 5s
 * halves the worst-case delay before a stale last_seen reveals a dead daemon
 * while still avoiding a write per poll tick.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export interface CheckinWriterOptions {
  readonly db: SqliteDatabaseLike;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now?(): string;
}

/** Writes/refreshes the single-row `service_status` runtime record. */
export class CheckinWriter {
  private readonly db: SqliteDatabaseLike;
  private readonly nowFn: () => string;
  private bindingTime: string | null = null;

  constructor(opts: CheckinWriterOptions) {
    this.db = opts.db;
    this.nowFn = opts.now ?? (() => new Date().toISOString());
  }

  /** The binding time recorded by the most recent {@link checkin}, or null before the first check-in. */
  get currentBindingTime(): string | null {
    return this.bindingTime;
  }

  /**
   * A fresh binding (AC-017a.2.1, AC-017a.3.2): a NEW binding_time, an initial
   * last_seen equal to it, and the current health. Called once per daemon
   * start (a restart is observed as a new binding_time while the registry
   * entry and DB path stay stable).
   */
  checkin(health: PipelineStatus): void {
    const now = this.nowFn();
    this.bindingTime = now;
    this.upsert(now, now, health);
  }

  /** Advance last_seen (and refresh health) without changing binding_time (AC-017a.3.1). */
  heartbeat(health: PipelineStatus): void {
    if (this.bindingTime === null) this.bindingTime = this.nowFn();
    this.upsert(this.bindingTime, this.nowFn(), health);
  }

  private upsert(bindingTime: string, lastSeen: string, health: PipelineStatus): void {
    try {
      this.db
        .prepare(
          `INSERT INTO service_status (id, name, binding_time, last_seen, health, deeplake_connected, deeplake_last_comm)
           VALUES (1, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             binding_time = excluded.binding_time,
             last_seen = excluded.last_seen,
             health = excluded.health`,
        )
        .run(HIVENECTAR_DAEMON_NAME, bindingTime, lastSeen, health);
    } catch {
      // fail-soft (AC-7 / AC-017a): a status write error never blocks boot or the pipeline.
    }
  }
}

export interface CheckinServiceOptions {
  readonly writer: CheckinWriter;
  /** The current health value, sourced from the SAME `PipelineStatus` `/health` reports (AC-017a.2.2). */
  readonly health: () => PipelineStatus;
  readonly intervalMs?: number;
  /** Injected timer for deterministic tests (mirrors `PollLoop`'s seam). */
  readonly timer?: Timer;
}

/**
 * Owns the check-in-then-heartbeat lifecycle: one `checkin()` on `start()`,
 * then a `heartbeat()` on a fixed interval until `stop()`. This is the piece
 * `daemon.ts` starts/stops alongside the worker and the HTTP server.
 */
export class CheckinService {
  private readonly writer: CheckinWriter;
  private readonly health: () => PipelineStatus;
  private readonly intervalMs: number;
  private readonly timer: Timer;
  private handle: unknown = null;
  private running = false;

  constructor(opts: CheckinServiceOptions) {
    this.writer = opts.writer;
    this.health = opts.health;
    this.intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.timer = opts.timer ?? realTimer;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Check in (a fresh binding_time) and arm the heartbeat. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      // `this.health()` is caller-supplied and can throw; the writer is fail-soft
      // but the sampler is not, so guard the whole sample-then-write here too.
      this.writer.checkin(this.health());
    } catch {
      // fail-soft (AC-7 / AC-017a): telemetry must never block daemon boot.
    }
    this.scheduleNext();
  }

  /** Disarm the heartbeat. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.handle = this.timer.set(() => {
      try {
        this.writer.heartbeat(this.health());
      } catch {
        // fail-soft: one bad health sample must not kill the heartbeat loop.
      }
      this.scheduleNext();
    }, this.intervalMs);
  }
}
