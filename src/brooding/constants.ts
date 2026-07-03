/**
 * Brooding thresholds, buckets, and batch-packing constants (PRD-007b).
 *
 * Every threshold is carried verbatim from
 * `library/knowledge/private/ai/brooding-pipeline.md` (the authoritative source):
 * `BATCH_FILE_SIZE` = 4 KB, `BATCH_TOTAL_SIZE` = 100 KB, `MAX_DESCRIBE_SIZE`
 * = 256 KB, binary detection = a NUL byte in the first 8 KB or a known-binary
 * extension. The four buckets (skip-binary, skip-too-large, batch, solo) are the
 * load-bearing structure of the pipeline.
 *
 * Batch packing is DYNAMIC per locked decision #22 (see `cost.ts` /
 * `bucketing.ts`): files are packed until the estimated input-token budget is
 * approached, capped by the 100 KB cumulative `BATCH_TOTAL_SIZE` and a max-files
 * safety ceiling drawn from the corpus's 30-50 files/call band. The fixed-40
 * default was superseded; ~40 files/call remains only the representative
 * cost-math illustration.
 */

/** Files with `size_bytes <= BATCH_FILE_SIZE` are batch candidates (4 KB; ~1K tokens of source). */
export const BATCH_FILE_SIZE = 4 * 1024;

/** Cumulative cap per batch call (100 KB); a batch never exceeds this in total bytes. */
export const BATCH_TOTAL_SIZE = 100 * 1024;

/** Files with `size_bytes > MAX_DESCRIBE_SIZE` are skipped-too-large (256 KB). */
export const MAX_DESCRIBE_SIZE = 256 * 1024;

/** Only the first 8 KB of a file are sniffed for a NUL byte during binary detection. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * The dynamic-packing input-token budget per batch call. Derived from the
 * corpus's representative batch (~40 files at ~500 tokens each = ~20K input
 * tokens, well under Gemini 2.5 Flash's 1M-token window). Packing stops once
 * adding the next file would exceed this budget. Config-overridable.
 */
export const BATCH_INPUT_TOKEN_BUDGET = 20_000;

/**
 * The max-files safety ceiling within the corpus's 30-50 files/call band
 * (decision #22). A batch never packs more than this many files even if the
 * token budget and byte cap would allow it, so a repo of tiny files still
 * produces bounded, well-shaped calls.
 */
export const MAX_BATCH_FILES = 50;

/**
 * The lower edge of the corpus's 30-50 files/call band, retained for the
 * cost-math illustration and dry-run sanity checks. Dynamic packing does not
 * force a minimum; this documents the band the representative figures assume.
 */
export const MIN_BATCH_FILES_BAND = 30;

/** Bytes-per-token estimate: "4 KB of source ~= 1K tokens" (`brooding-pipeline.md`). */
export const BYTES_PER_TOKEN = 4;

/**
 * Estimated output tokens per file in a batch response (title + short
 * description + concepts). Used to size a batch call's `max_tokens` from its
 * file count instead of inheriting the flat `PORTKEY_DEFAULT_MAX_TOKENS`
 * (NEC-013): the corpus estimates a full batch's JSON output at 2-4K tokens,
 * and the flat 4096 default sits at or below that, inviting truncation.
 */
export const BATCH_OUTPUT_TOKENS_PER_FILE = 120;

/**
 * Fixed headroom added on top of the per-file estimate to absorb JSON
 * structural overhead (array brackets, keys, quoting) and model variance, so a
 * full {@link MAX_BATCH_FILES}-file batch's output fits comfortably under the
 * requested cap rather than truncating at the edge of it.
 */
export const BATCH_OUTPUT_TOKEN_HEADROOM = 1024;

/**
 * Extensions treated as binary without reading the file (the corpus's
 * "known-binary list": `.png`, `.jpg`, `.pdf`, `.woff2`, ...). Lowercase, no
 * leading dot, matching `hive-graph/paths.ts` `extOf`. A file whose extension is
 * here is skip-binary regardless of size or content.
 */
export const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "tif", "avif", "heic",
  // documents / archives
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // audio / video
  "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  // executables / native / compiled
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "wasm", "node",
  // misc binary
  "db", "sqlite", "sqlite3", "pyc", "pdb",
  // NEC-042 item 7 / AC-018l.14: `.lock` files (yarn.lock, Cargo.lock,
  // Gemfile.lock, ...) are TEXT, not binary; classifying them skip-binary was
  // dishonest and blocked `--force` from ever re-describing them. They are
  // dropped from this list so they follow the ordinary size/NUL-sniff buckets
  // (a text lockfile becomes batch/solo; an oversized one, skipped-too-large;
  // and a genuinely binary `.lock` is still caught by the NUL content sniff).
  // `ds_store` is dropped too: it was unreachable dead config - `extOf(".DS_Store")`
  // returns "" (a dotfile has no extension), so this entry never matched.
]);

/**
 * The four brooding buckets. Every discovered, pre-check-surviving file lands in
 * exactly one (mutually exclusive) and every one lands somewhere (exhaustive).
 */
export type BroodBucket = "skip-binary" | "skip-too-large" | "batch" | "solo";
