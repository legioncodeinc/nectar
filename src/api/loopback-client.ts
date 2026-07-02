/**
 * The thin loopback HTTP client for `nectar search` (PRD-012b).
 *
 * AC-012b.3.1: `nectar search` is a THIN client that reaches the running daemon
 * over loopback (`127.0.0.1:3854`) and NEVER imports the search engine
 * (`hive-graph/search.ts`) or any DeepLake path. This module depends only on
 * `node:http` (a Node built-in, no runtime dependency) plus a TYPE-ONLY import
 * of the result shape (erased at compile time under `verbatimModuleSyntax`), so
 * the CLI process carries none of the engine's or storage layer's runtime code.
 *
 * AC-012b.3.2: when the daemon is not running, a connection failure surfaces as
 * {@link DaemonUnreachableError} — the CLI reports it clearly and exits
 * non-zero, with NO local fallback (search reflects the daemon's live state or
 * nothing).
 */
import { request } from "node:http";
import type { HiveGraphSearchResult } from "../hive-graph/search-types.js";

/** Raised when the loopback request cannot reach the daemon (not running / refused / timed out). */
export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}

/** Raised when the daemon answered but with a non-2xx status or an unparseable body. */
export class DaemonSearchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DaemonSearchError";
    this.status = status;
  }
}

export interface LoopbackSearchOptions {
  readonly host: string;
  readonly port: number;
  readonly query: string;
  readonly limit?: number | undefined;
  /** Per-request timeout; defaults to 15s (the transport's default statement timeout). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SEARCH_PATH = "/api/hive-graph/search";

/**
 * POST the search request to the daemon's `/api/hive-graph/search` endpoint and
 * return the engine's result shape verbatim (byte-identical to what the
 * endpoint emits, so the CLI's `--json` output equals a raw `curl`). A
 * connection-level failure (daemon down) throws {@link DaemonUnreachableError};
 * a non-2xx response throws {@link DaemonSearchError}.
 */
export function searchViaDaemon(options: LoopbackSearchOptions): Promise<HiveGraphSearchResult> {
  const payload = JSON.stringify({
    query: options.query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HiveGraphSearchResult>((resolve, reject) => {
    const req = request(
      {
        host: options.host,
        port: options.port,
        method: "POST",
        path: SEARCH_PATH,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new DaemonSearchError(`daemon returned HTTP ${status}: ${text.slice(0, 200)}`, status));
            return;
          }
          try {
            resolve(JSON.parse(text) as HiveGraphSearchResult);
          } catch {
            reject(new DaemonSearchError("daemon returned a non-JSON response", status));
          }
        });
      },
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED / ENOTFOUND / ECONNRESET all mean "no daemon there".
      reject(new DaemonUnreachableError(err.message));
    });
    req.on("timeout", () => {
      req.destroy(new DaemonUnreachableError(`request to ${options.host}:${options.port} timed out after ${timeoutMs}ms`));
    });

    req.end(payload);
  });
}
