/**
 * Minimal Deep Lake HTTP transport for hivenectar (PRD-005).
 *
 * Per ADR-0002, hivenectar is an independent daemon that reaches Deep Lake
 * over the network through its OWN client, never by importing the honeycomb
 * runtime in-process. This module mirrors the shape of honeycomb's
 * `HttpDeepLakeTransport` (`src/daemon/storage/transport.ts`), scoped down to
 * exactly what the two source-graph tables need: one method that posts a SQL
 * statement to the Deep Lake query endpoint and returns rows, or throws a
 * typed `TransportError`.
 *
 * Node built-ins only (`fetch` is global on Node >=22); no new runtime
 * dependency, matching hivenectar's zero-runtime-dependency rule (AGENTS.md).
 *
 * The transport is deliberately thin: no retry, no concurrency bounding.
 * Hivenectar's write volume (one file-registration event at a time, from a
 * single daemon worker loop per `worker.ts`) does not need honeycomb's
 * `Semaphore(5)` + 429/5xx retry client layer that exists to bound a
 * high-concurrency multi-harness workload; a future PRD can add that layer
 * here without changing this transport's contract if hivenectar's write
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

  /** Run one SQL statement against the configured workspace. */
  async query(sql: string): Promise<DeepLakeRow[]> {
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
          [DEEPLAKE_CLIENT_HEADER]: "hivenectar",
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
