/**
 * Nectar's in-repo router seam over `node:http` (PRD-008a).
 *
 * This is nectar's OWN minimal, zero-runtime-dependency analogue of the
 * `basePath` router honeycomb gets from Hono. It MIRRORS honeycomb's
 * `ROUTE_GROUPS` + `group()` accessor + permission-middleware-inheritance
 * pattern (`honeycomb/src/daemon/runtime/server.ts:68-106`, `:205-328`) across
 * the process boundary (`ADR-0002`, mirror-not-import) rather than importing
 * Hono, honoring nectar's zero-runtime-dependency invariant (`AGENTS.md`).
 *
 * Reconciliation with PRD-002a: PRD-002a originally sketched a Hono daemon
 * bound via `@hono/node-server`; the shipped PRD-002 diverged to a zero-runtime
 * `node:http` server (`src/server.ts`, only `/health`). PRD-008 follows the
 * shipped reality, so the `ROUTE_GROUPS`-equivalent list, the `RouteGroup`
 * handle, and the permission-middleware mount are nectar's own abstraction
 * layered over `node:http`, not a Hono app.
 *
 * The load-bearing property (honeycomb's a-AC-6): a route group's middleware is
 * mounted at bootstrap for the group prefix, and handlers attach LATER against a
 * live route table, so an endpoint filled after boot still runs the
 * already-mounted permission gate without re-wiring auth. An unfilled path under
 * a mounted group falls through to the root 501 scaffold, never a
 * 404-with-no-auth.
 */
import type { IncomingMessage } from "node:http";

/** The `/api/hive-graph` group base path (decision #34, mirrors honeycomb's `/api/graph`). */
export const HIVE_GRAPH_GROUP = "/api/hive-graph";

/**
 * Max POST/PUT/PATCH request body accepted before the dispatcher rejects with
 * `413 payload_too_large`. A sane 1 MiB cap: the search/build/projection bodies
 * are small JSON control payloads; no endpoint here streams bulk data. Bounds
 * memory so a hostile client cannot exhaust the loopback daemon.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

/**
 * A route-group spec, mirroring honeycomb's `RouteGroupSpec`
 * (`honeycomb/src/daemon/runtime/server.ts:57-61`). `protect` mounts the
 * permission gate on the group prefix; `session` would additionally mount the
 * runtime-path middleware ahead of permission (nectar has no session-capture
 * surface today, so every current group is `session: false`).
 */
export interface RouteGroupSpec {
  readonly path: string;
  readonly protect: boolean;
  readonly session: boolean;
}

/**
 * The frozen `ROUTE_GROUPS`-equivalent list (decision #34). `/api/hive-graph`
 * is `protect: true` (session-protected daemon routes) and `session: false`
 * (permission only, like honeycomb's `/api/graph` at
 * `honeycomb/src/daemon/runtime/server.ts:84`; the DEFAULT-flagged session bit
 * is resolved to `false` since these are operator graph endpoints, not
 * memory-capture surfaces). The daemon's own diagnostics endpoints (`/health`,
 * and `/api/status` if PRD-002 ever ships it) are NOT in this list: they are
 * unprotected and owned by the daemon bootstrap, not PRD-008.
 */
export const ROUTE_GROUPS: readonly RouteGroupSpec[] = Object.freeze([
  Object.freeze({ path: HIVE_GRAPH_GROUP, protect: true, session: false }),
]);

/** A fully-serialized HTTP response the dispatcher writes to the socket. */
export interface RouteResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

/**
 * The per-request context handed to a route handler. Carries the request shape
 * (method/path/query/headers/body) AND the response helpers (`json`), mirroring
 * the `c` context honeycomb's handlers receive.
 */
export interface RouteContext {
  readonly method: string;
  /** The pathname with the query string stripped. */
  readonly path: string;
  readonly rawUrl: string;
  readonly query: URLSearchParams;
  readonly headers: NodeJS.Dict<string | string[]>;
  /**
   * The parsed JSON request body, or `undefined` when the body is empty. Throws
   * a plain `Error` when the body is present but not valid JSON (the handler
   * catches it and surfaces a structured error, never an unhandled throw).
   */
  body(): unknown;
  /** Build a JSON response (default status 200). */
  json(body: unknown, status?: number): RouteResponse;
}

/** A route handler attached to a group; may be async. Never expected to throw (the dispatcher guards anyway). */
export type RouteHandler = (ctx: RouteContext) => RouteResponse | Promise<RouteResponse>;

/** A permission-gate rejection: the fail-closed 401/403 honeycomb's gate produces. */
export interface PermissionRejection {
  readonly status: 401 | 403;
  readonly body: unknown;
}

/**
 * The permission-gate seam mounted on every `protect: true` group. Returns
 * `null` to allow the request through, or a {@link PermissionRejection} to
 * fail it closed BEFORE the handler runs. This is the seam 008a scaffolds;
 * the RBAC/authenticator policy internals are the mirrored honeycomb pattern
 * and are not designed here. Nectar's loopback daemon defaults to
 * {@link allowAllPermission} (open on `127.0.0.1`); a future RBAC policy
 * attaches here.
 */
export type PermissionGate = (
  ctx: RouteContext,
  spec: RouteGroupSpec,
) => PermissionRejection | null | Promise<PermissionRejection | null>;

/** The default gate for nectar's loopback daemon: allow every request through. */
export const allowAllPermission: PermissionGate = () => null;

/**
 * A route-group handle: nectar's zero-dependency analogue of honeycomb's Hono
 * `basePath` router. `.get`/`.post` register a handler at a subpath RELATIVE to
 * the group base (`/search`, not `/api/hive-graph/search`); the group base is
 * prepended when the handler is stored on the shared live route table.
 */
export interface RouteGroup {
  readonly base: string;
  get(subpath: string, handler: RouteHandler): RouteGroup;
  post(subpath: string, handler: RouteHandler): RouteGroup;
}

function jsonResponse(body: unknown, status = 200): RouteResponse {
  return {
    status,
    body: JSON.stringify(body ?? null),
    contentType: "application/json; charset=utf-8",
  };
}

/** The root 501 scaffold for an unfilled path under a mounted group (mirrors honeycomb's `notFound`). */
export function notImplementedScaffold(path: string): RouteResponse {
  return jsonResponse({ error: "not_implemented", path }, 501);
}

function joinBase(base: string, subpath: string): string {
  const sub = subpath.startsWith("/") ? subpath : `/${subpath}`;
  if (sub === "/") return base;
  return `${base}${sub}`;
}

/**
 * The nectar router: holds the frozen group specs, the shared live route table,
 * and the permission gate. Constructed side-effect free at daemon assembly
 * (importing/constructing binds no socket); handlers attach to it via `group()`
 * either before or after the socket binds (the table is consulted per request,
 * so late attachment is picked up — the "keeps the binding live" property).
 */
export class NectarRouter {
  private readonly specs: readonly RouteGroupSpec[];
  private readonly permission: PermissionGate;
  /** `${METHOD} ${fullPath}` -> handler. */
  private readonly routes = new Map<string, RouteHandler>();

  constructor(specs: readonly RouteGroupSpec[] = ROUTE_GROUPS, permission: PermissionGate = allowAllPermission) {
    this.specs = specs;
    this.permission = permission;
  }

  /**
   * Return the {@link RouteGroup} handle for a known group base, or `undefined`
   * for an unknown group path (mirrors honeycomb's accessor contract,
   * `honeycomb/src/daemon/runtime/server.ts:205-214`). Handlers register at
   * paths relative to the group and inherit its already-mounted middleware.
   */
  group(path: string): RouteGroup | undefined {
    const spec = this.specs.find((s) => s.path === path);
    if (spec === undefined) return undefined;
    const register = (method: string, subpath: string, handler: RouteHandler): void => {
      this.routes.set(`${method} ${joinBase(spec.path, subpath)}`, handler);
    };
    const handle: RouteGroup = {
      base: spec.path,
      get(subpath, handler) {
        register("GET", subpath, handler);
        return handle;
      },
      post(subpath, handler) {
        register("POST", subpath, handler);
        return handle;
      },
    };
    return handle;
  }

  /** The group spec whose base the request path sits under (exact base or `${base}/...`), or undefined. */
  matchGroup(path: string): RouteGroupSpec | undefined {
    return this.specs.find((s) => path === s.path || path.startsWith(`${s.path}/`));
  }

  /**
   * Dispatch a request whose path is under a mounted group. Returns `undefined`
   * when the path is under NO group (the caller then serves its own 404,
   * preserving the shipped daemon's `not_found` for non-group paths). For a
   * matched group: runs the permission gate first (protect groups), then the
   * handler behind it; an unfilled path falls to the 501 scaffold; a handler
   * that throws unexpectedly is caught and surfaced as a 500 data body, never
   * crashing the request pipeline.
   */
  async dispatch(ctx: RouteContext): Promise<RouteResponse | undefined> {
    const spec = this.matchGroup(ctx.path);
    if (spec === undefined) return undefined;

    if (spec.protect) {
      const rejection = await this.permission(ctx, spec);
      if (rejection !== null) return jsonResponse(rejection.body, rejection.status);
    }

    const handler = this.routes.get(`${ctx.method} ${ctx.path}`);
    if (handler === undefined) return notImplementedScaffold(ctx.path);

    try {
      return await handler(ctx);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: "handler_error", reason }, 500);
    }
  }
}

/** Raised by {@link buildRouteContext} when the request body exceeds {@link MAX_REQUEST_BODY_BYTES}. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the maximum allowed size");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body up to the cap and build a {@link RouteContext}. Reading
 * the (bounded) body up front keeps the context synchronous for handlers and
 * enforces the size cap before any handler runs. Rejects with
 * {@link BodyTooLargeError} when the body exceeds {@link MAX_REQUEST_BODY_BYTES}.
 */
export function buildRouteContext(req: IncomingMessage, path: string, rawUrl: string): Promise<RouteContext> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return; // over-cap: drain remaining data, never buffer it
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        // Stop buffering and reject, but do NOT destroy the socket: the server
        // still needs to write the 413 response back to the client. Remaining
        // request data is drained (discarded) by the `aborted` guard above.
        aborted = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      let parsedOnce = false;
      const queryString = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
      resolve({
        method: (req.method ?? "GET").toUpperCase(),
        path,
        rawUrl,
        query: new URLSearchParams(queryString),
        headers: req.headers,
        body() {
          if (parsedOnce) return parsed;
          parsedOnce = true;
          const trimmed = raw.trim();
          parsed = trimmed === "" ? undefined : JSON.parse(trimmed);
          return parsed;
        },
        json: jsonResponse,
      });
    });
  });
}
