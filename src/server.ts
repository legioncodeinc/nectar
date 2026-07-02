/**
 * The nectar HTTP surface.
 *
 * PRD-002a mounts an unprotected `/health` route (PRD-003a) on a loopback
 * socket. Implemented on `node:http` (zero runtime dependencies, mirroring
 * doctor's built-ins-only ethos) rather than importing honeycomb's Hono
 * runtime, honoring the process-boundary rule in ADR-0002 / decision #4. The
 * daemon API route groups (`/api/hive-graph/*`) are PRD-008 and mount after
 * `/health`.
 */
import { createServer, type Server } from "node:http";
import { type HealthState, healthHttpStatus } from "./health.js";

export interface HttpServer {
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly port: number;
}

/**
 * Build the daemon's HTTP server. The only route today is `GET /health`, which
 * returns 200 + the health body when ok and 503 when degraded. Any other path
 * is 404 (JSON). Importing this module never binds a socket; `listen()` does.
 */
export function createHttpServer(
  health: HealthState,
  host: string,
  port: number,
): HttpServer {
  let bound = port;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?", 1)[0];

    if (req.method === "GET" && path === "/health") {
      const body = health.snapshot();
      const code = healthHttpStatus(body.status);
      const payload = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      res.end(payload);
      return;
    }

    const notFound = JSON.stringify({ error: "not_found", path });
    res.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(notFound),
    });
    res.end(notFound);
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
