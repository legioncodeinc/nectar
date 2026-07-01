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

// PRD-005: Source Graph data layer.
export type {
  Tenancy,
  NectarKind,
  DescribeStatus,
  SourceGraphRow,
  SourceGraphVersionRow,
} from "./source-graph/model.js";
export { DESCRIBE_STATUSES, EMBED_DIMS, isValidEmbedding } from "./source-graph/model.js";
export type { SourceGraphStore, LatestVersion } from "./source-graph/store.js";
export { InMemorySourceGraphStore } from "./source-graph/memory-store.js";
export { mintNectar, nectarCreatedAt, nectarTimestampMs, isValidNectar } from "./source-graph/ulid.js";
export { sha256Hex } from "./source-graph/hash.js";
export { toRepoRelative, filenameOf, extOf } from "./source-graph/paths.js";
export type { ColumnDef, CatalogTable, SqlType } from "./source-graph/schema.js";
export {
  SOURCE_GRAPH_TABLE,
  SOURCE_GRAPH_VERSIONS_TABLE,
  SOURCE_GRAPH_CATALOG_GROUP,
  SOURCE_GRAPH_COLUMNS,
  SOURCE_GRAPH_VERSIONS_COLUMNS,
  assertValidCatalogTable,
} from "./source-graph/schema.js";

// PRD-006: file registration protocol.
export { WatchIntake, DEFAULT_DEBOUNCE_MS } from "./registration/fs-watch.js";
export type { WatchIntakeOptions } from "./registration/fs-watch.js";
export { classifyPath } from "./registration/classify.js";
export type { PathObservation, LadderInput, LadderInputKind } from "./registration/classify.js";
export { classifyNewFile } from "./registration/copy-detect.js";
export type { NewFileDecision } from "./registration/copy-detect.js";
export { reassociate } from "./registration/ladder.js";
export type {
  ObservedFile,
  FuzzyStep,
  FuzzyOutcome,
  LadderDeps,
  LadderResult,
  LadderStep,
  LadderAction,
} from "./registration/ladder.js";
