/**
 * Public entry point for @legioncodeinc/nectar.
 *
 * Re-exports the daemon composition root and its building blocks so the package
 * can be embedded (tests, hive aggregation, future SDK) without going through
 * the CLI. The CLI (`nectar daemon`) is the operator-facing surface;
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

// PRD-005: Hive Graph data layer.
export type {
  Tenancy,
  NectarKind,
  DescribeStatus,
  HiveGraphRow,
  HiveGraphVersionRow,
} from "./hive-graph/model.js";
export { DESCRIBE_STATUSES, EMBED_DIMS, isValidEmbedding, inTenancy } from "./hive-graph/model.js";
export type { HiveGraphStore, AsyncHiveGraphStore, LatestVersion } from "./hive-graph/store.js";
export { InMemoryHiveGraphStore } from "./hive-graph/memory-store.js";
export { mintNectar, nectarCreatedAt, nectarTimestampMs, isValidNectar } from "./hive-graph/ulid.js";
export { sha256Hex } from "./hive-graph/hash.js";
export { toRepoRelative, filenameOf, extOf } from "./hive-graph/paths.js";
export type { ColumnDef, CatalogTable, SqlType } from "./hive-graph/schema.js";
export {
  HIVE_GRAPH_TABLE,
  HIVE_GRAPH_VERSIONS_TABLE,
  HIVE_GRAPH_CATALOG_GROUP,
  HIVE_GRAPH_COLUMNS,
  HIVE_GRAPH_VERSIONS_COLUMNS,
  assertValidCatalogTable,
  buildCreateTableSql,
} from "./hive-graph/schema.js";

// PRD-005: Deep Lake adapter for the Hive Graph data layer.
export type { TransportErrorKind, DeepLakeRow, DeepLakeTransportConfig } from "./hive-graph/deeplake-transport.js";
export {
  TransportError,
  HttpDeepLakeTransport,
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  DEEPLAKE_CLIENT_HEADER,
  DEEPLAKE_ORG_HEADER,
} from "./hive-graph/deeplake-transport.js";
export type { DeepLakeCredentials, LoadCredentialsOptions } from "./hive-graph/deeplake-credentials.js";
export {
  loadDeepLakeCredentials,
  DeepLakeCredentialsError,
  redactToken,
  credentialsDir,
  credentialsPath,
  DEFAULT_DEEPLAKE_API_URL,
} from "./hive-graph/deeplake-credentials.js";
export { withHeal, isMissingTableError } from "./hive-graph/deeplake-heal.js";
export type { QueryRunner } from "./hive-graph/deeplake-heal.js";
export { sqlStr, sqlLike, sqlIdent, sLiteral, eLiteral, sqlFloat4Array, sqlNum } from "./hive-graph/sql-guards.js";
export { DeepLakeHiveGraphStore } from "./hive-graph/deeplake-store.js";
export type { DeepLakeHiveGraphStoreOptions } from "./hive-graph/deeplake-store.js";

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
  NECTAR_RUN_COMMAND,
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

// Per-project scope resolution (ADR-0002 decoupling: nectar's own ladder,
// honeycomb detected but never required).
export {
  resolveProjectScope,
  loadProjectsCache,
  emptyProjectsCache,
  canonicalizeRemote,
  readGitRemoteSignal,
  originUrlFromConfig,
  projectsCacheDir,
  projectsCachePath,
  ENV_PROJECT_ID,
  DETECTED_HONEYCOMB_PROJECT_ID,
  UNSORTED_PROJECT_ID,
  PROJECTS_CACHE_FILE_NAME,
  PROJECTS_CACHE_SCHEMA_VERSION,
} from "./hive-graph/project-scope.js";
export type {
  ResolvedProjectScope,
  ProjectScopeSource,
  ResolveProjectScopeOptions,
  ProjectsCache,
  FolderBinding,
  CachedProject,
} from "./hive-graph/project-scope.js";

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
  DEFAULT_LOG_MAX_AGE_MS,
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

// PRD-003c: nectar's entry in doctor's daemon registry.
export {
  NECTAR_DAEMON_NAME,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_STARTUP_GRACE_MS,
  DEFAULT_RESTART_GIVE_UP_THRESHOLD,
  DEFAULT_RESTART_COOLDOWN_MS,
  DoctorRegistryError,
  defaultDoctorRegistryPath,
  buildNectarRegistryEntry,
  registerWithDoctor,
} from "./doctor-registry.js";
export type {
  DoctorRegistryEntry,
  RegisterWithDoctorOptions,
  RegisterWithDoctorResult,
} from "./doctor-registry.js";

// PRD-010: Portkey gateway (chat-completions transport, config, describe_model audit).
export {
  PORTKEY_BASE_URL,
  PORTKEY_CHAT_COMPLETIONS_URL,
  PORTKEY_EMBEDDINGS_URL,
  PORTKEY_API_KEY_HEADER,
  PORTKEY_CONFIG_HEADER,
  buildPortkeyHeaders,
} from "./portkey/headers.js";
export { resolvePortkeyConfig, DEFAULT_ACTIVE_MODEL, PORTKEY_CONFIG_SURFACE_KEYS } from "./portkey/config.js";
export type {
  PortkeyRuntimeConfig,
  PortkeyEnabled,
  PortkeyDisabled,
  PortkeyConfigOverrides,
} from "./portkey/config.js";
export {
  describeViaPortkey,
  PortkeyTransportError,
  PORTKEY_DEFAULT_MAX_TOKENS,
  PORTKEY_RETRYABLE_STATUSES,
  PORTKEY_MAX_ATTEMPTS,
  PORTKEY_RETRY_BACKOFF_MS,
  PORTKEY_REQUEST_TIMEOUT_MS,
} from "./portkey/transport.js";
export type {
  ChatMessage,
  PortkeyUsage,
  DescribeViaPortkeyResult,
  DescribeViaPortkeyRequest,
  DescribeViaPortkeyDeps,
  PortkeyFetch,
} from "./portkey/transport.js";
export {
  buildDescribeModelStamp,
  resetForRedescribe,
  applyDescribeModelStamp,
  isSkippedDescribeStatus,
  SKIPPED_DESCRIBE_STATUSES,
} from "./portkey/describe-model.js";
export type {
  DescriptionPayload,
  DescribeModelStamp,
  RedescribeRow,
  RedescribeReset,
} from "./portkey/describe-model.js";

// PRD-011: portable projection (.honeycomb/nectars.json) format, generation, write, load, inherit.
export {
  PROJECTION_SCHEMA_VERSION,
  DEFAULT_PROJECTION_REL_PATH,
  DEFAULT_GENERATOR,
  isValidContentHash,
  parseProjectionJson,
  canonicalSerialize,
  canonicalSerializeExceptGeneratedAt,
} from "./projection/format.js";
export type {
  PortableProjection,
  ProjectionProject,
  ProjectionFileEntry,
  ProjectionDerivedEntry,
} from "./projection/format.js";
export {
  buildProjection,
  buildProjectionFromStore,
  buildProjectionFromAsyncStore,
} from "./projection/generate.js";
export type { BuildProjectionOptions, BuildProjectionFromStoreOptions } from "./projection/generate.js";
export { collectProjectionSources, collectProjectionSourcesAsync } from "./projection/store-adapter.js";
export type { ProjectionNectarSource, CollectProjectionSourcesOptions } from "./projection/store-adapter.js";
export {
  ProjectionWriter,
  writeProjectionAtomic,
  projectionFinalPath,
  rebuildProjection,
  rebuildProjectionAsync,
  DEFAULT_WRITE_DEBOUNCE_MS,
} from "./projection/write.js";
export type {
  WriteProjectionOptions,
  ProjectionWriterOptions,
  RebuildProjectionOptions,
  RebuildProjectionAsyncOptions,
} from "./projection/write.js";
export {
  loadProjection,
  loadProjectionFromFile,
  validateProjection,
  buildContentHashIndex,
  MAX_PROJECTION_FILE_BYTES,
} from "./projection/load.js";
export type {
  LoadIgnoreReason,
  LoadProjectionResult,
  LoadProjectionFromFileOptions,
} from "./projection/load.js";
export { inheritFromProjection } from "./projection/inherit.js";
export type {
  DiskHashMap,
  InheritRow,
  InheritSummary,
  InheritFromProjectionOptions,
} from "./projection/inherit.js";

// PRD-014: embeddings provider switching (off | local nomic | Cohere-via-Portkey) + the 768-dim guard.
export {
  resolveEmbeddingsConfig,
  normalizeSelector,
  resolveEmbedProvider,
  createOffProvider,
  DEFAULT_EMBED_PROVIDER,
  withDimGuard,
  guardVector,
  stderrDimRejectionSink,
  createLocalNomicHttpTransport,
  createLocalNomicProvider,
  createHostedPortkeyProvider,
  parseEmbeddingsResponse,
  DEFAULT_LOCAL_EMBED_HOST,
  DEFAULT_LOCAL_EMBED_PORT,
  DEFAULT_LOCAL_EMBED_TIMEOUT_MS,
  DEFAULT_HOSTED_EMBED_MODEL,
  DEFAULT_HOSTED_OUTPUT_DIMENSION,
  DEFAULT_HOSTED_MAX_ATTEMPTS,
  DEFAULT_HOSTED_RETRY_BACKOFF_MS,
  DEFAULT_HOSTED_REQUEST_TIMEOUT_MS,
  HOSTED_RETRYABLE_STATUSES,
  defaultFetch,
  defaultSleep,
} from "./embeddings/index.js";
export type {
  EmbedProvider,
  EmbedProviderSelector,
  ResolveEmbedProviderDeps,
  ResolvedEmbeddingsConfig,
  EmbeddingsConfigOverrides,
  DimRejection,
  DimRejectionSink,
  LocalNomicConfig,
  LocalNomicTransport,
  LocalNomicHttpDeps,
  HostedEmbeddingsConfig,
  HostedPortkeyDeps,
  FetchLike,
  FetchResponseLike,
  SleepFn,
} from "./embeddings/index.js";

// PRD-007 (brooding), PRD-016 (enricher), PRD-012a (hive-graph search): the
// Wave C module surfaces, re-exported as namespaces so the package can drive the
// full pipeline programmatically. Namespaced to keep each module's public API
// intact without flattening two overlapping names (e.g. both brooding and the
// enricher export an `embeddingText`) into one ambiguous top-level binding.
export * as brooding from "./brooding/index.js";
export * as enricher from "./enricher/index.js";
export * as search from "./hive-graph/search.js";
