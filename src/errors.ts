/**
 * Error types for the nectar daemon.
 *
 * Mirrors honeycomb's `DaemonAlreadyRunningError` contract
 * (honeycomb/src/daemon/runtime/assemble.ts:672-685) per PRD-002d: a second
 * `nectar daemon` start throws this BEFORE the socket bind, so port 3854 is
 * never double-bound. The error carries the PID of the already-running daemon.
 */
export class DaemonAlreadyRunningError extends Error {
  readonly existingPid: number;

  constructor(existingPid: number, lockPath: string) {
    super(
      `nectar daemon is already running (pid ${existingPid}); lock held at ${lockPath}`,
    );
    this.name = "DaemonAlreadyRunningError";
    this.existingPid = existingPid;
  }
}

/**
 * Thrown by `start()` when a concurrent `shutdown()` won the race between lock
 * acquisition and the socket bind completing (daemon-api review M6). The start
 * unwinds: it closes the socket it just bound and releases the lock it acquired,
 * so the daemon never ends up listening without holding the lock. The rollback
 * path treats this as an ordinary start failure.
 */
export class DaemonStartAbortedError extends Error {
  constructor() {
    super("nectar daemon start was aborted by a concurrent shutdown");
    this.name = "DaemonStartAbortedError";
  }
}

/**
 * Thrown when a runtime configuration value is malformed or out of range
 * (daemon-api review L6): e.g. `NECTAR_PORT=3854abc` (trailing garbage), a port
 * outside 1-65535, or a poll interval below the safe floor. Surfaced as a clear
 * startup error instead of an opaque bind failure or a 1 ms tight poll.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Thrown when `start()` would bind off loopback with {@link allowAllPermission}
 * as the active gate (PRD-018j / NEC-029): without a real permission gate the API
 * would be network-reachable with no authentication.
 */
export class NonLoopbackOpenApiError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(
      `refusing to start: NECTAR_HOST=${host} binds off loopback but no permission gate is configured; ` +
        "the API would be reachable without authentication. Use 127.0.0.1 or configure a PermissionGate.",
    );
    this.name = "NonLoopbackOpenApiError";
    this.host = host;
  }
}
