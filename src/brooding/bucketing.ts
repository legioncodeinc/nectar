/**
 * Bucketing + dynamic batch packing (PRD-007b) - stage 3 of the pipeline.
 *
 * Files that survive the pre-check are bucketed by size and parsability into the
 * four buckets, carried verbatim from `brooding-pipeline.md`:
 *
 *   - skip-binary     NUL in first 8 KB, or a known-binary extension. No LLM call.
 *   - skip-too-large  size_bytes > MAX_DESCRIBE_SIZE (256 KB). No LLM call.
 *   - batch           text, size_bytes <= BATCH_FILE_SIZE (4 KB), cumulative <= 100 KB.
 *   - solo            text, size_bytes > BATCH_FILE_SIZE but <= MAX_DESCRIBE_SIZE.
 *
 * The buckets are mutually exclusive and exhaustive. Batch packing is DYNAMIC
 * (locked decision #22): files are packed until the estimated input-token budget
 * is approached, capped by the 100 KB cumulative `BATCH_TOTAL_SIZE` and the
 * max-files safety ceiling in the corpus's 30-50 band - it adapts to actual file
 * sizes rather than counting a fixed number of files, and preserves the cost
 * math (~40 files/call remains the representative average at ~2 KB/file).
 */
import {
  BATCH_FILE_SIZE,
  BATCH_INPUT_TOKEN_BUDGET,
  BATCH_TOTAL_SIZE,
  BYTES_PER_TOKEN,
  KNOWN_BINARY_EXTENSIONS,
  MAX_BATCH_FILES,
  MAX_DESCRIBE_SIZE,
  type BroodBucket,
} from "./constants.js";
import type { PreparedFile } from "./precheck.js";

/** Estimated input tokens for a byte count ("4 KB of source ~= 1K tokens"). */
export function estimateTokens(sizeBytes: number): number {
  return Math.ceil(sizeBytes / BYTES_PER_TOKEN);
}

/**
 * True when an extension is in the known-binary list, with NO dependence on
 * file content or size. Exposed so {@link "./precheck.js" | precheck.ts} can
 * short-circuit a known-binary file before reading any bytes (NEC-012 /
 * AC-018e.5), the same predicate {@link classifyBucket} applies after prepare.
 */
export function isKnownBinaryExtension(ext: string): boolean {
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

/**
 * Classify one prepared file into exactly one bucket. Order: known-binary
 * extension first (no size dependence), then too-large, then NUL-sniffed binary,
 * then the batch/solo size split.
 */
export function classifyBucket(prepared: PreparedFile): BroodBucket {
  if (isKnownBinaryExtension(prepared.file.ext)) return "skip-binary";
  if (prepared.file.sizeBytes > MAX_DESCRIBE_SIZE) return "skip-too-large";
  if (prepared.hasNulInSniff) return "skip-binary";
  if (prepared.file.sizeBytes <= BATCH_FILE_SIZE) return "batch";
  return "solo";
}

/** A packed batch call: the files it carries plus its cumulative byte + token estimate. */
export interface BatchGroup {
  readonly files: readonly PreparedFile[];
  readonly totalBytes: number;
  readonly estimatedTokens: number;
}

export interface PackBatchesOptions {
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly tokenBudget?: number;
}

/**
 * Pack batch-eligible files into {@link BatchGroup}s with dynamic token-budget
 * packing (decision #22). A file starts a new group when adding it to the
 * current group would exceed the max-files ceiling, the cumulative byte cap, or
 * the input-token budget. A single file always fits (a batch file is <= 4 KB).
 */
export function packBatches(
  batchFiles: readonly PreparedFile[],
  opts: PackBatchesOptions = {},
): BatchGroup[] {
  const maxFiles = opts.maxFiles ?? MAX_BATCH_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? BATCH_TOTAL_SIZE;
  const tokenBudget = opts.tokenBudget ?? BATCH_INPUT_TOKEN_BUDGET;

  const groups: BatchGroup[] = [];
  let current: PreparedFile[] = [];
  let bytes = 0;
  let tokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      groups.push({ files: current, totalBytes: bytes, estimatedTokens: tokens });
      current = [];
      bytes = 0;
      tokens = 0;
    }
  };

  for (const f of batchFiles) {
    const fileTokens = estimateTokens(f.file.sizeBytes);
    const wouldExceed =
      current.length + 1 > maxFiles ||
      bytes + f.file.sizeBytes > maxTotalBytes ||
      tokens + fileTokens > tokenBudget;
    if (current.length > 0 && wouldExceed) flush();
    current.push(f);
    bytes += f.file.sizeBytes;
    tokens += fileTokens;
  }
  flush();
  return groups;
}

/** The full bucketing outcome for a set of survivors. */
export interface BucketedFiles {
  readonly skipBinary: readonly PreparedFile[];
  readonly skipTooLarge: readonly PreparedFile[];
  /** Batch-eligible files packed into dynamic groups. */
  readonly batches: readonly BatchGroup[];
  readonly soloFiles: readonly PreparedFile[];
  /** Flat count of files in the batch bucket (across all groups). */
  readonly batchFileCount: number;
  /** Count of solo files. */
  readonly soloFileCount: number;
}

/** Bucket survivors into the four buckets, packing the batch bucket dynamically. */
export function bucketFiles(
  survivors: readonly PreparedFile[],
  opts: PackBatchesOptions = {},
): BucketedFiles {
  const skipBinary: PreparedFile[] = [];
  const skipTooLarge: PreparedFile[] = [];
  const batchEligible: PreparedFile[] = [];
  const soloFiles: PreparedFile[] = [];

  for (const p of survivors) {
    const bucket = classifyBucket(p);
    switch (bucket) {
      case "skip-binary":
        skipBinary.push(p);
        break;
      case "skip-too-large":
        skipTooLarge.push(p);
        break;
      case "batch":
        batchEligible.push(p);
        break;
      case "solo":
        soloFiles.push(p);
        break;
      default: {
        const _exhaustive: never = bucket;
        return _exhaustive;
      }
    }
  }

  const batches = packBatches(batchEligible, opts);
  return {
    skipBinary,
    skipTooLarge,
    batches,
    soloFiles,
    batchFileCount: batchEligible.length,
    soloFileCount: soloFiles.length,
  };
}
