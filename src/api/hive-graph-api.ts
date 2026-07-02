/**
 * `mountHiveGraphApi` — the handler-attachment module for the `/api/hive-graph`
 * group (PRD-008b + PRD-008c + the PRD-012b endpoint contract).
 *
 * Modeled on honeycomb's `mountGraphApi`
 * (`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`): resolve the group
 * once via `daemon.group("/api/hive-graph")`, no-op when the group is unknown
 * (AC-008a.3.1), and attach handlers at paths RELATIVE to the group. Every
 * handler resolves scope per-request, delegates to an injected mechanic, and
 * surfaces failure as a data body — never an unhandled throw. The daemon is the
 * only DeepLake client: no handler opens storage directly; each takes an
 * injected function that reaches storage through the daemon's client
 * (`honeycomb/src/daemon/runtime/server.ts:13-16` FR-6).
 *
 * The search endpoint (008b) and the `nectar search` CLI (012b) are two clients
 * of the ONE engine (012a `searchHiveGraph`) and return the identical result
 * shape, so the dashboard and the terminal render identically.
 */
import type { RouteContext, RouteGroup, RouteResponse } from "./router.js";
import { HIVE_GRAPH_GROUP } from "./router.js";
import { emptyDescribeStatusCounts, type HiveGraphStatus } from "./status-query.js";
import type { HiveGraphSearchResult, QueryScope } from "../hive-graph/search-types.js";

/** The `group()` accessor surface `mountHiveGraphApi` needs (a subset of `AssembledDaemon`). */
export interface RouteGroupProvider {
  group(path: string): RouteGroup | undefined;
}

/** The 400 body for a request with no resolvable tenant scope (mirrors honeycomb's `NO_ORG_BODY`). */
export const NO_ORG_BODY = {
  error: "no_org",
  message: "No resolvable tenant scope for this request.",
} as const;

/** Args passed to the injected brood runner by the `/build` handler. */
export interface BuildArgs {
  readonly scope: QueryScope;
  readonly force: boolean;
  readonly limit: number | undefined;
  readonly model: string | undefined;
}

/** The projection rebuild result the `/projection/rebuild` handler returns (PRD-011 shape). */
export interface ProjectionRebuildResult {
  readonly regenerated: boolean;
  readonly nectarsCount: number;
  readonly generatedAt: string;
}

/**
 * The injected mechanics + scope-resolution contract for the `/api/hive-graph`
 * handlers. Every mechanic is optional: when a mechanic is not wired, its
 * endpoint answers a structured, honest error rather than crashing (the group
 * stays mounted + protected regardless). Production wiring (`src/cli.ts`)
 * supplies the real delegates; tests inject fakes.
 */
export interface MountHiveGraphOptions {
  /**
   * The daemon's resolved default tenant scope, used by the default
   * {@link resolveScope}. `null`/absent means no scope resolves and every
   * endpoint returns the `NO_ORG_BODY` 400.
   */
  readonly defaultScope?: QueryScope | null;
  /**
   * Override per-request scope resolution (mirrors `mountGraphApi`'s
   * `resolveScope`, `honeycomb/src/daemon/runtime/codebase/api.ts:309-310`).
   * The default resolves the daemon's `defaultScope`, honoring an optional
   * `?project=<id>` per-request project override on top of it.
   */
  readonly resolveScope?: (ctx: RouteContext) => QueryScope | null;

  /** PRD-012a engine, bound to the daemon's own store + embed deps. */
  readonly searchHiveGraph?: (
    query: string,
    scope: QueryScope,
    limit: number | undefined,
  ) => Promise<HiveGraphSearchResult>;
  /** PRD-007 brood pipeline trigger. */
  readonly runBrood?: (args: BuildArgs) => Promise<unknown>;
  /** PRD-008c/016 status read (queue depth + describe_status counts + cost). */
  readonly readStatus?: (scope: QueryScope) => Promise<HiveGraphStatus>;
  /** PRD-011 projection read (`.honeycomb/nectars.json`). */
  readonly readProjection?: (scope: QueryScope) => Promise<unknown>;
  /** PRD-011 atomic projection regeneration. */
  readonly rebuildProjection?: (scope: QueryScope) => Promise<ProjectionRebuildResult>;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse an optional positive-integer `limit` from a raw value; undefined when absent/blank. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/**
 * The search request contract (008b / 012b), from a POST JSON body
 * (`{ query, limit }`) or a GET query string (`?q=&limit=`). A missing query is
 * treated as the empty string, so the engine returns its empty/degraded floor.
 */
export function parseSearchRequest(ctx: RouteContext): { query: string; limit: number | undefined } {
  if (ctx.method === "GET") {
    const query = ctx.query.get("q") ?? ctx.query.get("query") ?? "";
    return { query, limit: parseLimit(ctx.query.get("limit")) };
  }
  const body = ctx.body();
  if (body === undefined || body === null || typeof body !== "object") {
    return { query: "", limit: undefined };
  }
  const rec = body as Record<string, unknown>;
  const query = typeof rec["query"] === "string" ? rec["query"] : "";
  return { query, limit: parseLimit(rec["limit"]) };
}

/** The build request contract (008c): `{ force, limit, model }` from the POST body. */
export function parseBuildRequest(ctx: RouteContext): { force: boolean; limit: number | undefined; model: string | undefined } {
  const body = ctx.body();
  if (body === undefined || body === null || typeof body !== "object") {
    return { force: false, limit: undefined, model: undefined };
  }
  const rec = body as Record<string, unknown>;
  return {
    force: rec["force"] === true,
    limit: parseLimit(rec["limit"]),
    model: typeof rec["model"] === "string" && rec["model"] !== "" ? rec["model"] : undefined,
  };
}

/** Build the default per-request scope resolver from the daemon's default scope + `?project=` override. */
function defaultScopeResolver(defaultScope: QueryScope | null | undefined): (ctx: RouteContext) => QueryScope | null {
  return (ctx) => {
    if (defaultScope === null || defaultScope === undefined) return null;
    const override = ctx.query.get("project");
    if (override !== null && override.trim() !== "") {
      return { orgId: defaultScope.orgId, workspaceId: defaultScope.workspaceId, projectId: override.trim() };
    }
    return defaultScope;
  };
}

/**
 * Attach the `/api/hive-graph` handlers to the group 008a scaffolds. Mirrors
 * `mountGraphApi`'s one-line group resolution + no-op-on-unknown-group guard
 * (`honeycomb/src/daemon/runtime/codebase/api.ts:304-306`): safe to call
 * against a daemon whose `ROUTE_GROUPS` list does not include the group (it
 * attaches nothing rather than throwing). Called once after `assembleDaemon(...)`.
 */
export function mountHiveGraphApi(daemon: RouteGroupProvider, options: MountHiveGraphOptions): void {
  const group = daemon.group(HIVE_GRAPH_GROUP);
  if (group === undefined) return; // unknown daemon shape -> no-op attach (AC-008a.3.1)

  const resolveScope = options.resolveScope ?? defaultScopeResolver(options.defaultScope);

  // In-flight guard so a second /build while one is running reports already-running
  // rather than launching a concurrent brood (the resumability contract, PRD-007c).
  let broodInFlight = false;

  // ── 008b + 012b: POST/GET /api/hive-graph/search ────────────────────────────
  const searchHandler = async (ctx: RouteContext): Promise<RouteResponse> => {
    const scope = resolveScope(ctx);
    if (scope === null) return ctx.json(NO_ORG_BODY, 400);
    if (options.searchHiveGraph === undefined) {
      return ctx.json({ error: "search_unavailable", reason: "the search engine is not wired on this daemon" }, 501);
    }
    try {
      const { query, limit } = parseSearchRequest(ctx);
      const result = await options.searchHiveGraph(query, scope, limit);
      return ctx.json(result);
    } catch (err: unknown) {
      return ctx.json({ error: "search_failed", reason: errorReason(err) }, 500);
    }
  };
  group.post("/search", searchHandler);
  group.get("/search", searchHandler);

  // ── 008c: POST /api/hive-graph/build ────────────────────────────────────────
  group.post("/build", async (ctx): Promise<RouteResponse> => {
    const scope = resolveScope(ctx);
    if (scope === null) return ctx.json(NO_ORG_BODY, 400);
    if (options.runBrood === undefined) {
      return ctx.json({ error: "build_unavailable", reason: "the brood pipeline is not wired on this daemon" }, 501);
    }
    if (broodInFlight) {
      return ctx.json({ status: "already_running", message: "a brood is already in progress" }, 409);
    }
    let args: BuildArgs;
    try {
      const parsed = parseBuildRequest(ctx);
      args = { scope, force: parsed.force, limit: parsed.limit, model: parsed.model };
    } catch (err: unknown) {
      return ctx.json({ error: "build_failed", reason: errorReason(err) }, 500);
    }
    broodInFlight = true;
    try {
      const result = await options.runBrood(args);
      return ctx.json(result);
    } catch (err: unknown) {
      return ctx.json({ error: "build_failed", reason: errorReason(err) }, 500);
    } finally {
      broodInFlight = false;
    }
  });

  // ── 008c: GET /api/hive-graph/status ────────────────────────────────────────
  group.get("/status", async (ctx): Promise<RouteResponse> => {
    const scope = resolveScope(ctx);
    if (scope === null) return ctx.json(NO_ORG_BODY, 400);
    if (options.readStatus === undefined) {
      // No status mechanic wired: report a degraded empty status (never a 500).
      return ctx.json(
        { queueDepth: 0, describeStatus: emptyDescribeStatusCounts(), costSpentUsd: 0, degraded: true },
        200,
      );
    }
    try {
      return ctx.json(await options.readStatus(scope));
    } catch (err: unknown) {
      return ctx.json({ error: "status_failed", reason: errorReason(err) }, 500);
    }
  });

  // ── 008c: GET /api/hive-graph/projection ────────────────────────────────────
  group.get("/projection", async (ctx): Promise<RouteResponse> => {
    const scope = resolveScope(ctx);
    if (scope === null) return ctx.json(NO_ORG_BODY, 400);
    if (options.readProjection === undefined) {
      return ctx.json({ error: "projection_unavailable", reason: "projection read is not wired on this daemon" }, 501);
    }
    try {
      return ctx.json(await options.readProjection(scope));
    } catch (err: unknown) {
      return ctx.json({ error: "projection_read_failed", reason: errorReason(err) }, 500);
    }
  });

  // ── 008c: POST /api/hive-graph/projection/rebuild ───────────────────────────
  group.post("/projection/rebuild", async (ctx): Promise<RouteResponse> => {
    const scope = resolveScope(ctx);
    if (scope === null) return ctx.json(NO_ORG_BODY, 400);
    if (options.rebuildProjection === undefined) {
      return ctx.json(
        { error: "projection_unavailable", reason: "projection rebuild is not wired on this daemon" },
        501,
      );
    }
    try {
      return ctx.json(await options.rebuildProjection(scope));
    } catch (err: unknown) {
      return ctx.json({ error: "regenerate_failed", reason: errorReason(err) }, 500);
    }
  });
}
