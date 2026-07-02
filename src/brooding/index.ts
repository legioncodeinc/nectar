/**
 * The brooding module barrel (PRD-007).
 *
 * The clean module surface the orchestrator wires into the CLI verb, the daemon
 * boot (background auto-trigger), and the HTTP `POST /api/hive-graph/build`
 * seam. Nothing here touches `src/cli.ts`, `src/daemon.ts`, or any other agent's
 * file: the orchestrator imports {@link runBrood} / {@link planBrood} /
 * {@link parseBroodArgs} / {@link shouldAutoBrood} and wires the seams.
 *
 * Pipeline order (fixed, PRD-007):
 *   discover -> pre-check -> bucket -> describe -> embed -> persist -> regenerate-projection
 */

// Stage constants + buckets (PRD-007b).
export {
  BATCH_FILE_SIZE,
  BATCH_TOTAL_SIZE,
  MAX_DESCRIBE_SIZE,
  BINARY_SNIFF_BYTES,
  BATCH_INPUT_TOKEN_BUDGET,
  MAX_BATCH_FILES,
  MIN_BATCH_FILES_BAND,
  BYTES_PER_TOKEN,
  KNOWN_BINARY_EXTENSIONS,
  type BroodBucket,
} from "./constants.js";

// Stage 1: discovery (PRD-007a).
export {
  discoverFiles,
  spawnGitLsFiles,
  GIT_LS_FILES_MAX_BUFFER,
  GIT_LS_FILES_ARGS,
  type DiscoveredFile,
  type DiscoveryResult,
  type DiscoverySource,
  type DiscoverFilesOptions,
  type GitLsFiles,
  type GitLsFilesResult,
} from "./discovery.js";

// Stage 2: content-hash pre-check (PRD-007a).
export {
  prepareFile,
  prepareFiles,
  contentHashPrecheck,
  type PreparedFile,
  type PrecheckOptions,
  type PrecheckResult,
} from "./precheck.js";

// Stage 3: bucketing + dynamic packing (PRD-007b).
export {
  estimateTokens,
  classifyBucket,
  packBatches,
  bucketFiles,
  type BatchGroup,
  type PackBatchesOptions,
  type BucketedFiles,
} from "./bucketing.js";

// Cost math (PRD-007b).
export {
  GEMINI_INPUT_PRICE_PER_M_LE_200K,
  GEMINI_OUTPUT_PRICE_PER_M_LE_200K,
  GEMINI_INPUT_PRICE_PER_M_GT_200K,
  GEMINI_OUTPUT_PRICE_PER_M_GT_200K,
  AVG_OUTPUT_TOKENS_PER_CALL,
  BROODING_COST_REFERENCE,
  estimateBroodCost,
  type BroodCostEstimate,
  type EstimateBroodCostOptions,
} from "./cost.js";

// Stages 4-5: describe + embed (PRD-007b).
export {
  BATCH_SYSTEM_PROMPT,
  SOLO_SYSTEM_PROMPT,
  MAX_TITLE_CHARS,
  MAX_CONCEPTS,
  buildBatchUserMessage,
  buildSoloUserMessage,
  extractJson,
  describeBatchGroup,
  describeSoloFile,
  embeddingText,
  embedDescriptions,
  type DescribeFn,
  type DescribeTarget,
  type BatchDescribeResult,
  type SoloDescribeResult,
} from "./describe.js";

// Resumability state machine (PRD-007c).
export {
  BROOD_TERMINAL_STATUSES,
  isTerminalBroodStatus,
  isForceProtectedStatus,
  classifyResume,
  type ResumeAction,
  type ClassifyResumeOptions,
} from "./resumability.js";

// Orchestrator (PRD-007).
export {
  BroodError,
  planBrood,
  runBrood,
  resolveProjection,
  buildVersionRow,
  buildIdentity,
  resolveDescribeFn,
  defaultNow,
  type BroodConfig,
  type BroodRunOptions,
  type BroodRuntimeDeps,
  type BroodPlan,
  type BroodResult,
  type BroodProjectionContext,
  type DescribeSeams,
  type RowFields,
  type ToBroodItem,
} from "./pipeline.js";

// Async-native orchestrator: the sync/async store bridge (Wave D dormancy closure).
export {
  planBroodAsync,
  runBroodAsync,
  type AsyncBroodConfig,
  type AsyncBroodRuntimeDeps,
} from "./pipeline-async.js";

// CLI verb surface + dry-run (PRD-007d).
export {
  parseBroodArgs,
  shouldAutoBrood,
  evaluateAutoBrood,
  evaluateAutoBroodAsync,
  formatDryRunReport,
  type ParsedBroodArgs,
  type AutoBroodCheck,
  type DryRunPreviewInput,
} from "./cli.js";
