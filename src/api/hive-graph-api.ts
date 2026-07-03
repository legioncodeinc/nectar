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
 *
 * **Tenancy scope (PRD-018j / NEC-029).** The per-request `?project=` override
 * was dropped: every endpoint resolves the daemon's configured default scope
 * only. A foreign `?project=` on `POST /build` is rejected with 403; on read
 * endpoints it is ignored so a caller cannot reach another project's tenancy.
 */
import type { RouteContext, RouteGroup, RouteResponse } from "./router.js";
import { HIVE_GRAPH_GROUP, MalformedJsonError } from "./router.js";
import { emptyDescribeStatusCounts, type HiveGraphStatus } from "./status-query.js";
import type { HiveGraphSearchResult, QueryScope } from "../hive-graph/search-types.js";
import { createBroodGuard, type BroodGuard } from "../brood-guard.js";

/** The `group()` accessor surface `mountHiveGraphApi` needs (a subset of `AssembledDaemon`). */
export interface RouteGroupProvider {
  group(path: string): RouteGroup | undefined;
}

/** The 400 body for a request with no resolvable tenant scope (mirrors honeycomb's `NO_ORG_BODY`). */
export const NO_ORG_BODY = {
  error: "no_org",
  message: "No resolvable tenant scope for this request.",
} as const;

/** The 403 body when `POST /build` carries a foreign `?project=` override (PRD-018j). */
export const FOREIGN_PROJECT_BODY = {
  error: "foreign_project",
  message: "The ?project= tenancy override is not permitted on POST /build.",
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
   * The default resolves the daemon's `defaultScope` only; the `?project=`
   * override was dropped (PRD-018j / NEC-029).
   */
  readonly resolveScope?: (ctx: RouteContext) => QueryScope | null;

  /** PRD-012a engine, bound to the daemon's own store + embed deps. */
  readonly searchHiveGraph?: (
    query: string,
    scope: QueryScope,
    limit: number | undefined,
  ) => Promise<HiveGraphSearchResult>;
  /** PRD-007 brood pipeline trigger. Runs in the background behind the 202 `/build` contract (AC-018a.7). */
  readonly runBrood?: (args: BuildArgs) => Promise<unknown>;
  /**
   * Observe a background build failure (AC-018a.7). Because `/build` now returns
   * 202 and runs the brood in the background, a brood rejection can no longer
   * surface in the HTTP response; it is forwarded here instead of being
   * swallowed. Absent -> the failure is dropped after the guard clears (the
   * durable `/status` surface still reflects the brood's effect on Deep Lake).
   */
  readonly onBuildError?: (err: unknown) => void;
  /**
   * The SHARED brood guard (PRD-018g / NEC-011 AC-018g.2). When supplied, the
   * `/build` handler acquires/releases this guard so the API and the daemon's
   * boot auto-brood cannot run two broods at once. Absent (tests) -> a private
   * guard is created so the endpoint's own single-flight contract still holds.
   */
  readonly broodGuard?: BroodGuard;
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

/**
 * Raised by {@link parseSearchRequest} / {@link parseBuildRequest} when a
 * `limit` is present but not a positive integer (NEC-042 item 12 / AC-018l.19):
 * `0`, a negative, a float (`2.9`), or a non-numeric string. A distinct type so
 * the handler answers 400 at the boundary instead of silently clamping. The
 * engine's own `resolveRecallLimit` clamp stays as a backstop for internal
 * callers that bypass this parser.
 */
export class InvalidLimitError extends Error {
  constructor(raw: unknown) {
    super(`limit must be a positive integer, got ${JSON.stringify(raw)}`);
    this.name = "InvalidLimitError";
  }
}

/**
 * Parse an optional `limit`. Absent/blank -> undefined (the engine applies its
 * default). Present but not a positive integer -> throws {@link InvalidLimitError}
 * so the handler returns 400 (AC-018l.19); the engine clamp remains a backstop.
 */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) throw new InvalidLimitError(raw);
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

/** Build the default per-request scope resolver from the daemon's default scope (no `?project=` override). */
function defaultScopeResolver(defaultScope: QueryScope | null | undefined): (ctx: RouteContext) => QueryScope | null {
  return (_ctx) => {
    if (defaultScope === null || defaultScope === undefined) return null;
    return defaultScope;
  };
}

/** Trimmed `?project=` query value, or null when absent/blank. */
function projectQueryOverride(ctx: RouteContext): string | null {
  const raw = ctx.query.get("project");
  if (raw === null || raw.trim() === "") return null;
  return raw.trim();
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
  // PRD-018g / NEC-011 AC-018g.2: when the daemon supplies its shared guard, the
  // boot auto-brood participates in the SAME single-flight, so a `/build` during
  // the boot brood is refused and no two broods (or double-mints) ever overlap.
  const broodGuard: BroodGuard = options.broodGuard ?? createBroodGuard();

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
      // Client errors at the request boundary are 400, not the generic 500.
      if (err instanceof MalformedJsonError) return ctx.json({ error: "invalid_json", reason: errorReason(err) }, 400);
      if (err instanceof InvalidLimitError) return ctx.json({ error: "invalid_limit", reason: errorReason(err) }, 400);
      return ctx.json({ error: "search_failed", reason: errorReason(err) }, 500);
    }
  };
  group.post("/search", searchHandler);
  group.get("/search", searchHandler);

  // ── 008c: POST /api/hive-graph/build (async, PRD-018a AC-018a.7) ─────────────
  // A brood on a real repo takes minutes; awaiting it inside the handler let a
  // shutdown during a brood hang until the supervisor SIGKILLed the process
  // (NEC-021). The endpoint now accepts the build (202) and runs the brood in the
  // BACKGROUND; the existing `broodInFlight` guard keeps a second build at 409
  // until this one settles, and GET /api/hive-graph/status is the poll surface.
  group.post("/build", async (ctx): Promise<RouteResponse> => {
    const foreignProject = projectQueryOverride(ctx);
    if (
      foreignProject !== null &&
      options.defaultScope !== null &&
      options.defaultScope !== undefined &&
      foreignProject !== options.defaultScope.projectId
    ) {
      return ctx.json(FOREIGN_PROJECT_BODY, 403);
    }
    const scope = resolveScope(ctx);
    if (scope === null) return ctx.json(NO_ORG_BODY, 400);
    if (options.runBrood === undefined) {
      return ctx.json({ error: "build_unavailable", reason: "the brood pipeline is not wired on this daemon" }, 501);
    }
    // AC-018g.2: acquire the shared guard. A brood already in flight (from this
    // endpoint OR the boot auto-brood) is refused with 409.
    if (!broodGuard.tryAcquire()) {
      return ctx.json({ status: "already_running", message: "a brood is already in progress" }, 409);
    }
    let args: BuildArgs;
    try {
      const parsed = parseBuildRequest(ctx);
      args = { scope, force: parsed.force, limit: parsed.limit, model: parsed.model };
    } catch (err: unknown) {
      broodGuard.release();
      if (err instanceof MalformedJsonError) return ctx.json({ error: "invalid_json", reason: errorReason(err) }, 400);
      if (err instanceof InvalidLimitError) return ctx.json({ error: "invalid_limit", reason: errorReason(err) }, 400);
      return ctx.json({ error: "build_failed", reason: errorReason(err) }, 500);
    }
    const runBrood = options.runBrood;
    // Run in the background; the request returns 202 immediately below. The catch
    // forwards the failure to the optional observer (not swallowed): the request
    // already returned, so it cannot surface here.
    void (async () => {
      try {
        await runBrood(args);
      } catch (err: unknown) {
        options.onBuildError?.(err);
      } finally {
        broodGuard.release();
      }
    })();
    return ctx.json(
      { status: "accepted", message: "brood accepted; poll GET /api/hive-graph/status for progress" },
      202,
    );
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
