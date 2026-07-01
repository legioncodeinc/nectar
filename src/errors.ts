/**
 * Error types for the hivenectar daemon.
 *
 * Mirrors honeycomb's `DaemonAlreadyRunningError` contract
 * (honeycomb/src/daemon/runtime/assemble.ts:672-685) per PRD-002d: a second
 * `hivenectar daemon` start throws this BEFORE the socket bind, so port 3854 is
 * never double-bound. The error carries the PID of the already-running daemon.
 */
export class DaemonAlreadyRunningError extends Error {
  readonly existingPid: number;

  constructor(existingPid: number, lockPath: string) {
    super(
      `hivenectar daemon is already running (pid ${existingPid}); lock held at ${lockPath}`,
    );
    this.name = "DaemonAlreadyRunningError";
    this.existingPid = existingPid;
  }
}
