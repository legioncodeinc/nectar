/**
 * Minimal Deep Lake HTTP transport for nectar (PRD-005).
 *
 * Per ADR-0002, nectar is an independent daemon that reaches Deep Lake
 * over the network through its OWN client, never by importing the honeycomb
 * runtime in-process. This module mirrors the shape of honeycomb's
 * `HttpDeepLakeTransport` (`src/daemon/storage/transport.ts`), scoped down to
 * exactly what the two hive-graph tables need: one method that posts a SQL
 * statement to the Deep Lake query endpoint and returns rows, or throws a
 * typed `TransportError`.
 *
 * Node built-ins only (`fetch` is global on Node >=22); no new runtime
 * dependency, matching nectar's zero-runtime-dependency rule (AGENTS.md).
 *
 * The transport is deliberately thin: no retry, no concurrency bounding.
 * Nectar's write volume (one file-registration event at a time, from a
 * single daemon worker loop per `worker.ts`) does not need honeycomb's
 * `Semaphore(5)` + 429/5xx retry client layer that exists to bound a
 * high-concurrency multi-harness workload; a future PRD can add that layer
 * here without changing this transport's contract if nectar's write
 * volume grows to need it.
 */

/** What kind of failure the transport hit. */
export type TransportErrorKind = "query" | "connection" | "timeout";

/**
 * A typed failure raised by {@link HttpDeepLakeTransport}. `status` carries
 * the HTTP status for query failures (e.g. 404, 500) so heal logic
 * (`deeplake-heal.ts`) can classify the failure message.
 */
export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly status?: number;
  constructor(kind: TransportErrorKind, message: string, status?: number) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** One row of a Deep Lake query result: column name -> raw JSON value. */
export type DeepLakeRow = Record<string, unknown>;

/** Header name Deep Lake reads to attribute traffic by client family. */
export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
/** Header name Deep Lake reads to scope a request to an org partition. */
export const DEEPLAKE_ORG_HEADER = "X-Activeloop-Org-Id";
/** Default per-statement timeout when the caller does not override it. */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 15_000;

/** Fixed connection details a transport instance targets for its lifetime. */
export interface DeepLakeTransportConfig {
  /** Deep Lake HTTP query endpoint, e.g. https://api.deeplake.ai. */
  readonly endpoint: string;
  /** Bearer token. Never logged in full; see `deeplake-credentials.ts#redactToken`. */
  readonly token: string;
  /** Org id sent as a request header so Deep Lake enforces tenancy. */
  readonly orgId: string;
  /** Workspace/partition the statement targets (the URL path segment). */
  readonly workspaceId: string;
  /** Per-statement timeout in ms; defaults to {@link DEFAULT_TRANSPORT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Real HTTP transport against the Deep Lake SQL endpoint. POSTs
 * `{ query: sql }` to `${endpoint}/workspaces/${workspaceId}/tables/query`
 * with a bearer token, the org header, and a client-family header, exactly
 * mirroring honeycomb's `HttpDeepLakeTransport.query` shape. Maps a fetch
 * failure / abort / non-ok response into a typed `TransportError` the heal
 * logic and the store can branch on.
 */
export class HttpDeepLakeTransport {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly orgId: string;
  private readonly workspaceId: string;
  private readonly timeoutMs: number;

  constructor(config: DeepLakeTransportConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.token = config.token;
    this.orgId = config.orgId;
    this.workspaceId = config.workspaceId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
  }

  /**
   * Run one SQL statement against the configured workspace.
   *
   * Transient failures (HTTP 429 and 5xx, e.g. the backend's intermittent
   * 'failed to get database connection' 500) are retried with bounded
   * exponential backoff plus jitter before the TransportError propagates:
   * a single upstream blip must not abort a minutes-long brood or an
   * enricher cycle. Non-transient failures (4xx other than 429: schema
   * errors, bad SQL, auth) fail fast on the first attempt so heal and
   * fail-soft classification see them unchanged.
   */
  async query(sql: string): Promise<DeepLakeRow[]> {
    let lastTransient: TransportError | null = null;
    for (let attempt = 0; attempt < QUERY_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const backoff = QUERY_TRANSIENT_BASE_BACKOFF_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * backoff));
      }
      try {
        return await this.queryOnce(sql);
      } catch (err: unknown) {
        if (
          err instanceof TransportError &&
          err.kind === "query" &&
          err.status !== undefined &&
          (err.status === 429 || err.status >= 500)
        ) {
          lastTransient = err;
          continue;
        }
        throw err;
      }
    }
    // lastTransient is always set when the loop exhausts.
    throw lastTransient ?? new TransportError("query", "transient retry loop exhausted without an error");
  }

  private async queryOnce(sql: string): Promise<DeepLakeRow[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${this.endpoint}/workspaces/${encodeURIComponent(this.workspaceId)}/tables/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          [DEEPLAKE_ORG_HEADER]: this.orgId,
          [DEEPLAKE_CLIENT_HEADER]: "nectar",
        },
        signal: controller.signal,
        body: JSON.stringify({ query: sql }),
      });
    } catch (e: unknown) {
      // AbortError fires when our own timeout aborts the request. Map it to
      // the timeout kind so callers can distinguish it from a dropped socket.
      if (e instanceof Error && e.name === "AbortError") {
        throw new TransportError("timeout", `request aborted after ${this.timeoutMs}ms`);
      }
      const message = e instanceof Error ? e.message : String(e);
      throw new TransportError("connection", message);
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new TransportError("query", `${resp.status}: ${text.slice(0, 200)}`, resp.status);
    }
    const raw = (await resp.json().catch(() => null)) as { columns?: string[]; rows?: unknown[][] } | null;
    if (!raw?.rows || !raw?.columns) return [];
    const columns = raw.columns;
    return raw.rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
  }
}

/** Bounded attempts for transient (429/5xx) query failures. */
export const QUERY_TRANSIENT_MAX_ATTEMPTS = 4;
/** First-retry backoff; doubles per attempt, with up-to-equal jitter added. */
export const QUERY_TRANSIENT_BASE_BACKOFF_MS = 500;
