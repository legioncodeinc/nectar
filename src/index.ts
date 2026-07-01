/**
 * Public entry point for @legioncodeinc/hivenectar.
 *
 * Re-exports the daemon composition root and its building blocks so the package
 * can be embedded (tests, thehive aggregation, future SDK) without going through
 * the CLI. The CLI (`hivenectar daemon`) is the operator-facing surface;
 * `assembleDaemon` is the programmatic one.
 */
export { assembleDaemon } from "./daemon.js";
export type { AssembleOptions, AssembledDaemon } from "./daemon.js";
export {
  resolveConfig,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PID_FILE_NAME,
  DEFAULT_LOCK_FILE_NAME,
  RUNTIME_DIR_NAME,
} from "./config.js";
export type { RuntimeConfig, RuntimeConfigOverrides } from "./config.js";
export {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  isPidAlive,
  readPidFile,
  isLockHeldByLiveDaemon,
} from "./lock.js";
export type { LockPaths } from "./lock.js";
export { HealthState, healthHttpStatus } from "./health.js";
export type { HealthBody, PipelineStatus } from "./health.js";
export { PollLoop, realTimer } from "./poll-loop.js";
export type { PollLoopOptions, Tick, Timer } from "./poll-loop.js";
export { HiveantennaeWorker, emptyJobSource } from "./worker.js";
export type { Job, JobHandler, JobKind, JobSource, WorkerOptions } from "./worker.js";
export { createHttpServer } from "./server.js";
export type { HttpServer } from "./server.js";
export { DaemonAlreadyRunningError } from "./errors.js";
