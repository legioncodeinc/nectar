/**
 * `mountProjectsApi` - the projects + brooding-control endpoints on the
 * `/api/hive-graph` group (PRD-019b), consumed by Hive's dashboard (019c).
 *
 * - `GET  /api/hive-graph/projects`          - the active-project set joined with
 *   the brooding state and each project's watcher slice (read-only).
 * - `POST /api/hive-graph/projects/brooding` - set a single project's brooding
 *   (`{ projectId, brooding }`) or the global switch (`{ global }`). On success it
 *   persists, triggers an immediate reconcile, then returns the new view.
 *
 * Both routes sit under the already-mounted `/api/hive-graph` permission gate
 * (PRD-008a / PRD-018j) and are loopback-only. The body is hand-validated
 * (nectar is zero-runtime-dependency, so no zod at runtime); an invalid body is a
 * 400, a persist (disk) failure is a redacted 500 that leaves the prior state
 * intact and does NOT reconcile (b-AC-6).
 */
import type { RouteContext, RouteGroup, RouteResponse } from "./router.js";
import { HIVE_GRAPH_GROUP, MalformedJsonError } from "./router.js";
import type { ProjectsView } from "../projects-control.js";
import type { ProjectBrooding, GlobalBrooding } from "../registration/brooding-state.js";

/** The `group()` accessor surface `mountProjectsApi` needs. */
export interface RouteGroupProvider {
  group(path: string): RouteGroup | undefined;
}

/** The injected mechanics for the projects endpoints. */
export interface MountProjectsOptions {
  /** Build the current read view (resolve bindings + brooding state + watcher liveness). */
  view(): ProjectsView;
  /** Persist a per-project brooding change. Throws on a write failure (mapped to 500, prior state intact). */
  setProject(projectId: string, brooding: ProjectBrooding): void;
  /** Persist the global switch. Throws on a write failure. */
  setGlobal(global: GlobalBrooding): void;
  /** Trigger an immediate active-set reconcile after a successful persist. */
  reconcile(): Promise<void>;
  /**
   * The brooding-state file path included in the REDACTED persist-failure body
   * (b-AC-6): the caller learns WHICH file could not be written, never the raw
   * OS error internals. Absent -> the body carries the stable reason only.
   */
  readonly stateFilePath?: string;
  /**
   * Observe the RAW persist failure server-side (for the daemon log). The HTTP
   * body never carries the raw error (b-AC-6 redaction); this seam keeps the
   * diagnostics from being lost. Default: no-op.
   */
  readonly onPersistError?: (err: unknown) => void;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A validated brooding toggle request: one of a per-project change or a global change. */
export type BroodingToggleRequest =
  | { readonly kind: "project"; readonly projectId: string; readonly brooding: ProjectBrooding }
  | { readonly kind: "global"; readonly global: GlobalBrooding };

/** Thrown by {@link parseBroodingToggle} for a body that is neither a valid project nor global change. */
export class InvalidBroodingToggleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBroodingToggleError";
  }
}

/**
 * Hand-validate the toggle body. Accepts exactly one of
 * `{ projectId: string, brooding: "on"|"off" }` or `{ global: "on"|"paused" }`.
 * Anything else throws {@link InvalidBroodingToggleError} (mapped to 400).
 */
export function parseBroodingToggle(body: unknown): BroodingToggleRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidBroodingToggleError("body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  const hasGlobal = rec["global"] !== undefined;
  const hasProject = rec["projectId"] !== undefined || rec["brooding"] !== undefined;
  if (hasGlobal && hasProject) {
    throw new InvalidBroodingToggleError("provide either { global } or { projectId, brooding }, not both");
  }
  if (hasGlobal) {
    const global = rec["global"];
    if (global !== "on" && global !== "paused") {
      throw new InvalidBroodingToggleError('global must be "on" or "paused"');
    }
    return { kind: "global", global };
  }
  const projectId = rec["projectId"];
  const brooding = rec["brooding"];
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new InvalidBroodingToggleError("projectId must be a non-empty string");
  }
  if (brooding !== "on" && brooding !== "off") {
    throw new InvalidBroodingToggleError('brooding must be "on" or "off"');
  }
  return { kind: "project", projectId: projectId.trim(), brooding };
}

/**
 * Attach the projects + brooding-control handlers to the `/api/hive-graph` group.
 * Safe to call against a daemon whose group is unknown (no-op attach). Called
 * once after `assembleDaemon(...)`, alongside `mountHiveGraphApi`.
 */
export function mountProjectsApi(daemon: RouteGroupProvider, options: MountProjectsOptions): void {
  const group = daemon.group(HIVE_GRAPH_GROUP);
  if (group === undefined) return;

  group.get("/projects", (ctx): RouteResponse => {
    try {
      return ctx.json(options.view());
    } catch (err: unknown) {
      return ctx.json({ error: "projects_read_failed", reason: errorReason(err) }, 500);
    }
  });

  group.post("/projects/brooding", async (ctx): Promise<RouteResponse> => {
    let request: BroodingToggleRequest;
    try {
      request = parseBroodingToggle(ctx.body());
    } catch (err: unknown) {
      if (err instanceof MalformedJsonError) return ctx.json({ error: "invalid_json", reason: errorReason(err) }, 400);
      if (err instanceof InvalidBroodingToggleError) return ctx.json({ error: "invalid_request", reason: errorReason(err) }, 400);
      return ctx.json({ error: "invalid_request", reason: errorReason(err) }, 400);
    }
    // Persist first; on a write failure the prior state is intact and we do NOT
    // reconcile against a half-written file (b-AC-6).
    try {
      if (request.kind === "project") options.setProject(request.projectId, request.brooding);
      else options.setGlobal(request.global);
    } catch (err: unknown) {
      // b-AC-6: the error is REDACTED. The body carries a stable reason plus the
      // state-file path only, never the raw OS error text (errno strings embed
      // local paths and OS internals). The raw failure routes to the server-side
      // observer so diagnostics land in the daemon log, not the HTTP response.
      options.onPersistError?.(err);
      const where = options.stateFilePath !== undefined ? ` (${options.stateFilePath})` : "";
      return ctx.json({ error: "persist_failed", reason: `could not persist the brooding state${where}` }, 500);
    }
    // Reconcile so the change takes effect within this call (b-AC-3/4/5).
    try {
      await options.reconcile();
    } catch (err: unknown) {
      return ctx.json({ error: "reconcile_failed", reason: errorReason(err) }, 500);
    }
    return ctx.json(options.view());
  });
}
