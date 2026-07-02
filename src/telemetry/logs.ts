/**
 * Bounded, rotated log emission to local SQLite (PRD-017c), per doctor's
 * `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.
 *
 * `service_logs` is append-only but bounded: every write opportunistically
 * rotates out rows older than {@link DEFAULT_LOG_MAX_AGE_MS} (AC-017c.2), so
 * the store never grows without limit and stays cheap for doctor's ~1s
 * poll cycle. The retention policy is an AGE bound (decision #33, 2026-07-02,
 * `PRD-DECISIONS-AND-DEFAULTS.md`), superseding the original 5,000-row cap:
 * a quiet daemon keeps at most a day of history instead of an unbounded-age
 * tail of stale lines. Consumers are unaffected (doctor reads whatever
 * rows exist).
 *
 * `createLogTap` mirrors nectar's EXISTING structured daemon log sink
 * (`daemon.ts`'s `(line: Record<string, unknown>) => void`) into this table,
 * rather than introducing a second logging framework: every line the daemon
 * already logs to stderr is ALSO redacted and written here, unchanged in its
 * original stderr behavior. nectar's structured log lines only ever carry
 * scope/message/error-string/path fields (see `daemon.ts`, `registration/
 * service.ts`) - never raw file content or an LLM description body - so the
 * redaction pass below is defense-in-depth, not the sole guarantee.
 */
import type { SqliteDatabaseLike } from "./db.js";

export type LogLevel = "error" | "warn" | "info" | "debug";
export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** The maximum age a log row is retained (decision #33: 24h age bound, superseding Contract B's 5,000-row cap). */
export const DEFAULT_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * A message longer than this is dropped rather than written (PRD-017c: "if a
 * line cannot be safely redacted it is dropped"). A nectar structured log
 * line (scope + a short message + maybe a path/error string) is always well
 * under this; anything longer is far more likely to be an accidentally-passed
 * file body or LLM description than a real operational log line, so length
 * alone is a cheap, effective backstop against exactly the two payloads
 * AC-017c.3.2 forbids.
 */
export const MAX_LOG_MESSAGE_LENGTH = 2_000;

/** Secret-shaped substrings redacted before a line is written (defense-in-depth; see module doc). */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s"',}\]]+/gi,
  /"?(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|client[_-]?secret)"?\s*[:=]\s*"?[^",}\s]+"?/gi,
];

/**
 * Redact secret-shaped substrings from `message`. Returns null (drop the line
 * entirely) when the message is too long to plausibly be a normal operational
 * log line (AC-017c.3.2's "cannot be safely redacted" case).
 */
export function redactLogMessage(message: string): string | null {
  if (message.length > MAX_LOG_MESSAGE_LENGTH) return null;
  let out = message;
  for (const pattern of SENSITIVE_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

export interface LogWriterOptions {
  readonly db: SqliteDatabaseLike;
  /** Retention age bound in milliseconds (default: {@link DEFAULT_LOG_MAX_AGE_MS}). */
  readonly maxAgeMs?: number;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now?(): string;
}

export class LogWriter {
  private readonly db: SqliteDatabaseLike;
  private readonly maxAgeMs: number;
  private readonly nowFn: () => string;

  constructor(opts: LogWriterOptions) {
    this.db = opts.db;
    this.maxAgeMs = Math.max(1, opts.maxAgeMs ?? DEFAULT_LOG_MAX_AGE_MS);
    this.nowFn = opts.now ?? (() => new Date().toISOString());
  }

  /** Append one log row (AC-017c.1.1/3.1) and rotate. Fail-soft (AC-7 / AC-017c). */
  write(level: LogLevel, message: string): void {
    const safeMessage = redactLogMessage(message);
    if (safeMessage === null) return; // unredactable/oversized: dropped, never written (AC-017c.3.2).
    try {
      this.db.prepare("INSERT INTO service_logs (ts, level, message) VALUES (?, ?, ?)").run(this.nowFn(), level, safeMessage);
      this.rotate();
    } catch {
      // fail-soft: a log write error never surfaces into the pipeline.
    }
  }

  /**
   * Delete rows older than the `maxAgeMs` bound (AC-017c.2.1/2.2). ISO-8601 UTC
   * timestamps compare correctly as strings, so the cutoff is a plain `<`.
   * Fail-soft, including against a non-parseable injected "now" (no cutoff can
   * be computed, so nothing is deleted rather than everything).
   */
  private rotate(): void {
    try {
      const nowMs = Date.parse(this.nowFn());
      if (!Number.isFinite(nowMs)) return;
      const cutoff = new Date(nowMs - this.maxAgeMs).toISOString();
      this.db.prepare("DELETE FROM service_logs WHERE ts < ?").run(cutoff);
    } catch {
      // fail-soft: a rotation error never surfaces into the pipeline.
    }
  }
}

/** True iff `value` is one of the four declared verbosity levels. */
function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Map a structured log line's `level` field to a declared verbosity, defaulting to "info". */
export function levelFromLine(line: Record<string, unknown>): LogLevel {
  return isLogLevel(line["level"]) ? line["level"] : "info";
}

/** Render a structured log line (minus its `level`, stored in its own column) as the row's message text. */
export function messageFromLine(line: Record<string, unknown>): string {
  const { level: _level, ...rest } = line;
  try {
    return JSON.stringify(rest);
  } catch {
    return String(rest);
  }
}

/** The minimal sink `createLogTap` mirrors lines into (satisfied by the `Telemetry` facade in `index.ts`). */
export interface LogSink {
  log(level: LogLevel, message: string): void;
}

/**
 * Wrap nectar's existing structured log sink so every line is ALSO
 * mirrored into the telemetry log table, unchanged in its original behavior
 * (the wrapped sink is always called first, with the exact original line).
 * A telemetry-mirror failure is swallowed here too, on top of `LogWriter`'s
 * own fail-soft `write()`, so a telemetry hiccup can never affect the
 * caller's real log sink.
 */
export function createLogTap(
  baseLog: (line: Record<string, unknown>) => void,
  sink: LogSink,
): (line: Record<string, unknown>) => void {
  return (line: Record<string, unknown>): void => {
    baseLog(line);
    try {
      sink.log(levelFromLine(line), messageFromLine(line));
    } catch {
      // fail-soft: never let the telemetry mirror affect the real log sink above.
    }
  };
}
