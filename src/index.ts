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
export { DESCRIBE_STATUSES, EMBED_DIMS, isValidEmbedding, inTenancy } from "./source-graph/model.js";
export type { SourceGraphStore, AsyncSourceGraphStore, LatestVersion } from "./source-graph/store.js";
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
  buildCreateTableSql,
} from "./source-graph/schema.js";

// PRD-005: Deep Lake adapter for the Source Graph data layer.
export type { TransportErrorKind, DeepLakeRow, DeepLakeTransportConfig } from "./source-graph/deeplake-transport.js";
export {
  TransportError,
  HttpDeepLakeTransport,
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  DEEPLAKE_CLIENT_HEADER,
  DEEPLAKE_ORG_HEADER,
} from "./source-graph/deeplake-transport.js";
export type { DeepLakeCredentials, LoadCredentialsOptions } from "./source-graph/deeplake-credentials.js";
export {
  loadDeepLakeCredentials,
  DeepLakeCredentialsError,
  redactToken,
  credentialsDir,
  credentialsPath,
  DEFAULT_DEEPLAKE_API_URL,
} from "./source-graph/deeplake-credentials.js";
export { withHeal, isMissingTableError } from "./source-graph/deeplake-heal.js";
export type { QueryRunner } from "./source-graph/deeplake-heal.js";
export { sqlStr, sqlLike, sqlIdent, sLiteral, eLiteral, sqlFloat4Array, sqlNum } from "./source-graph/sql-guards.js";
export { DeepLakeSourceGraphStore } from "./source-graph/deeplake-store.js";
export type { DeepLakeSourceGraphStoreOptions } from "./source-graph/deeplake-store.js";

// PRD-006: file registration protocol.
export { WatchIntake, DEFAULT_DEBOUNCE_MS } from "./registration/fs-watch.js";
export type { WatchIntakeOptions } from "./registration/fs-watch.js";
export { classifyPath } from "./registration/classify.js";
export type { PathObservation, LadderInput, LadderInputKind } from "./registration/classify.js";
export { classifyNewFile } from "./registration/copy-detect.js";
export type { NewFileDecision } from "./registration/copy-detect.js";
export { reassociate, carryNectar } from "./registration/ladder.js";
export type {
  ObservedFile,
  FuzzyStep,
  FuzzyOutcome,
  FuzzyCandidate,
  ReviewCandidate,
  LadderDeps,
  LadderResult,
  LadderStep,
  LadderAction,
} from "./registration/ladder.js";
export {
  createDefaultIgnore,
  loadIgnorePrefixes,
  ALWAYS_IGNORED_SEGMENTS,
  GRAPH_IGNORE_FILE,
} from "./registration/ignore.js";
export type { IgnorePredicate } from "./registration/ignore.js";
export {
  computeFingerprint,
  fingerprintDistance,
  distanceToConfidence,
  createTlshFuzzyStep,
  DEFAULT_TUNABLE_FUZZY_CONFIG,
  MAX_DISTANCE,
  SIZE_BUCKET_TOLERANCE,
  FINGERPRINT_PREFIX,
} from "./registration/tlsh.js";
export type { FuzzyConfig } from "./registration/tlsh.js";
export { RegistrationService } from "./registration/service.js";
export type { RegistrationServiceOptions, RegistrationFs, StatResult } from "./registration/service.js";
export { createDiskRegistrationFs } from "./registration/disk-fs.js";
export { isSafeRelPath, containedPath, realpathContained } from "./registration/paths-safe.js";
export {
  InMemoryPendingReviewStore,
  FilePendingReviewStore,
} from "./registration/review-store.js";
export type { PendingReviewStore, PendingReviewCandidate } from "./registration/review-store.js";
export { runReviewMatches } from "./registration/review-cli.js";
export type { ReviewMatchesDeps, ReviewMatchesResult, ReviewDecision } from "./registration/review-cli.js";
export { runPrune, findPruneCandidates, PRUNE_GRACE_MS } from "./registration/prune-cli.js";
export type { PruneDeps, PruneCandidate, PruneResult } from "./registration/prune-cli.js";

// PRD-003b: OS service unit (launchd / systemd / schtasks).
export {
  resolveServicePlan,
  resolveServiceContext,
  SERVICE_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  HIVENECTAR_RUN_COMMAND,
  RESTART_SEC,
  WINDOWS_RESTART_INTERVAL,
  renderUnit,
  installCommands,
  uninstallCommands,
  statusCommand,
  createExecFileRunner,
  createServiceModule,
  createNodeServiceFs,
  serviceStatus,
} from "./service/index.js";
export type {
  ServicePlan,
  ServiceEnvironment,
  ServiceCommand,
  CommandRunner,
  CommandResult,
  CommandRunOptions,
  ServiceModule,
  ServiceModuleDeps,
  ServiceResult,
  ServiceStatus,
  ServiceFs,
} from "./service/index.js";

// PRD-017: service check-in and local SQLite telemetry.
export {
  createTelemetry,
  createNullTelemetry,
  wrapStoreWithMetrics,
  createLogTap,
  redactLogMessage,
  levelFromLine,
  messageFromLine,
  defaultTelemetryDbPath,
  telemetryDbPathForRuntimeDir,
  TELEMETRY_DIR_NAME,
  TELEMETRY_DB_FILE_NAME,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOG_ROW_CAP,
  MAX_LOG_MESSAGE_LENGTH,
  LOG_LEVELS,
  CheckinService,
  CheckinWriter,
  MetricsWriter,
  LogWriter,
} from "./telemetry/index.js";
export type {
  Telemetry,
  CreateTelemetryOptions,
  StartCheckinOptions,
  StopHeartbeat,
  MetricsSnapshot,
  PipelineMetricsSink,
  LogLevel,
  LogSink,
  SqliteDatabaseLike,
} from "./telemetry/index.js";

// PRD-003c: hivenectar's entry in hivedoctor's daemon registry.
export {
  HIVENECTAR_DAEMON_NAME,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_STARTUP_GRACE_MS,
  DEFAULT_RESTART_GIVE_UP_THRESHOLD,
  DEFAULT_RESTART_COOLDOWN_MS,
  HivedoctorRegistryError,
  defaultHivedoctorRegistryPath,
  buildHivenectarRegistryEntry,
  registerWithHivedoctor,
} from "./hivedoctor-registry.js";
export type {
  HivedoctorRegistryEntry,
  RegisterWithHivedoctorOptions,
  RegisterWithHivedoctorResult,
} from "./hivedoctor-registry.js";
