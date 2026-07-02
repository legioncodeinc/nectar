/**
 * The nectar HTTP surface.
 *
 * PRD-002a mounts an unprotected `/health` route (PRD-003a) on a loopback
 * socket. Implemented on `node:http` (zero runtime dependencies, mirroring
 * doctor's built-ins-only ethos) rather than importing honeycomb's Hono
 * runtime, honoring the process-boundary rule in ADR-0002 / decision #4. The
 * daemon API route groups (`/api/hive-graph/*`) are PRD-008: they mount after
 * `/health` through nectar's own in-repo router seam ({@link NectarRouter}),
 * which mirrors honeycomb's `ROUTE_GROUPS` + permission-inheritance pattern
 * across the process boundary without importing Hono.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type HealthState, healthHttpStatus } from "./health.js";
import {
  BodyTooLargeError,
  buildRouteContext,
  type NectarRouter,
  type RouteResponse,
} from "./api/router.js";

export interface HttpServer {
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly port: number;
}

function writeJson(res: ServerResponse, code: number, payload: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function writeRouteResponse(res: ServerResponse, response: RouteResponse): void {
  res.writeHead(response.status, {
    "content-type": response.contentType,
    "content-length": Buffer.byteLength(response.body),
    "cache-control": "no-store",
  });
  res.end(response.body);
}

/**
 * Build the daemon's HTTP server. `GET /health` returns 200 + the health body
 * when ok and 503 when degraded (unprotected, exactly as shipped). When a
 * {@link NectarRouter} is supplied, any path under a mounted route group
 * (`/api/hive-graph/*`) is dispatched through it — running the group's
 * permission middleware, then the attached handler, or the root 501 scaffold
 * for an unfilled path. Any other path is 404 (JSON). Importing this module
 * never binds a socket; `listen()` does.
 */
export function createHttpServer(
  health: HealthState,
  host: string,
  port: number,
  router?: NectarRouter,
): HttpServer {
  let bound = port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const path = url.split("?", 1)[0] ?? "/";

    if (req.method === "GET" && path === "/health") {
      const body = health.snapshot();
      const code = healthHttpStatus(body.status);
      writeJson(res, code, JSON.stringify(body), { "cache-control": "no-store" });
      return;
    }

    if (router !== undefined && router.matchGroup(path) !== undefined) {
      let response: RouteResponse | undefined;
      try {
        const ctx = await buildRouteContext(req, path, url);
        response = await router.dispatch(ctx);
      } catch (err: unknown) {
        if (err instanceof BodyTooLargeError) {
          writeJson(res, 413, JSON.stringify({ error: "payload_too_large" }));
          return;
        }
        // A malformed request the dispatcher never saw (e.g. a stream error):
        // fail soft with a structured 400 rather than crashing the daemon.
        const reason = err instanceof Error ? err.message : String(err);
        writeJson(res, 400, JSON.stringify({ error: "bad_request", reason }));
        return;
      }
      if (response !== undefined) {
        writeRouteResponse(res, response);
        return;
      }
    }

    writeJson(res, 404, JSON.stringify({ error: "not_found", path }));
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Last-resort guard: never let a handler rejection crash the process.
      if (!res.headersSent) {
        const reason = err instanceof Error ? err.message : String(err);
        writeJson(res, 500, JSON.stringify({ error: "internal_error", reason }));
      } else {
        res.end();
      }
    });
  });

  return {
    get port() {
      return bound;
    },
    listen() {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          const addr = server.address();
          if (addr && typeof addr === "object") bound = addr.port;
          resolve(bound);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Close idle keep-alive sockets so the process can exit promptly.
        server.closeIdleConnections?.();
      });
    },
  };
}
