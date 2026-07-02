/**
 * Bounded, rotated log emission to local SQLite (PRD-017c), per hivedoctor's
 * `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.
 *
 * `service_logs` is append-only but capped: every write opportunistically
 * rotates the table back to {@link DEFAULT_LOG_ROW_CAP} rows (AC-017c.2), so
 * the store never grows without limit and stays cheap for hivedoctor's ~1s
 * poll cycle.
 *
 * `createLogTap` mirrors hivenectar's EXISTING structured daemon log sink
 * (`daemon.ts`'s `(line: Record<string, unknown>) => void`) into this table,
 * rather than introducing a second logging framework: every line the daemon
 * already logs to stderr is ALSO redacted and written here, unchanged in its
 * original stderr behavior. hivenectar's structured log lines only ever carry
 * scope/message/error-string/path fields (see `daemon.ts`, `registration/
 * service.ts`) - never raw file content or an LLM description body - so the
 * redaction pass below is defense-in-depth, not the sole guarantee.
 */
import type { SqliteDatabaseLike } from "./db.js";

export type LogLevel = "error" | "warn" | "info" | "debug";
export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** The row cap the log table rotates back to on every write (Contract B: "cap ~5,000 rows"). */
export const DEFAULT_LOG_ROW_CAP = 5_000;

/**
 * A message longer than this is dropped rather than written (PRD-017c: "if a
 * line cannot be safely redacted it is dropped"). A hivenectar structured log
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
  readonly rowCap?: number;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now?(): string;
}

export class LogWriter {
  private readonly db: SqliteDatabaseLike;
  private readonly rowCap: number;
  private readonly nowFn: () => string;

  constructor(opts: LogWriterOptions) {
    this.db = opts.db;
    this.rowCap = Math.max(1, opts.rowCap ?? DEFAULT_LOG_ROW_CAP);
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

  /** Keep only the newest `rowCap` rows (AC-017c.2.1/2.2). Fail-soft. */
  private rotate(): void {
    try {
      this.db
        .prepare("DELETE FROM service_logs WHERE id <= (SELECT id FROM service_logs ORDER BY id DESC LIMIT 1 OFFSET ?)")
        .run(this.rowCap);
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
 * Wrap hivenectar's existing structured log sink so every line is ALSO
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
