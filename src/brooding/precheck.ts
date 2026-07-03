/**
 * Content-hash pre-check (PRD-007a) - stage 2 of the pipeline, the fresh-clone
 * shortcut.
 *
 * Every discovered candidate is read once, sha256-hashed, and sniffed for a NUL
 * byte in its first 8 KB (so a later bucketing pass needs no second read). A
 * candidate whose `content_hash` matches an entry in the committed portable
 * projection (`.honeycomb/nectars.json`) INHERITS that entry's nectar and
 * description and makes NO LLM call - this is how a fresh clone pays $0. Only
 * candidates with no projection match survive into bucketing (`bucketing.ts`).
 *
 * Row building for inherited files reuses `projection/inherit.ts`
 * (`inheritFromProjection`) verbatim; this module owns the read-and-partition.
 *
 * Memory bounding (NEC-012): a known-binary extension is classified WITHOUT
 * reading any content at all (AC-018e.5) - `classifyBucket` would put it in
 * `skip-binary` regardless of bytes, so a multi-GB tracked asset is never
 * buffered. A file that turns out to be a terminal skip bucket after a read
 * (too-large by `stat.sizeBytes`, or NUL-sniffed binary) has its `bytes`
 * dropped once hashed rather than retained for the run's duration (AC-018e.6):
 * only batch/solo-eligible files - the ones an LLM call will actually see -
 * keep their content resident past this function.
 */
import { sha256Hex } from "../hive-graph/hash.js";
import type { Tenancy } from "../hive-graph/model.js";
import type { RegistrationFs } from "../registration/service.js";
import {
  inheritFromProjection,
  type DiskHashMap,
  type InheritRow,
} from "../projection/inherit.js";
import { buildContentHashIndex } from "../projection/load.js";
import type { PortableProjection } from "../projection/format.js";
import { BINARY_SNIFF_BYTES, MAX_DESCRIBE_SIZE } from "./constants.js";
import { isKnownBinaryExtension } from "./bucketing.js";
import type { DiscoveredFile } from "./discovery.js";

/** A discovered file read once: its content bytes, content hash, and binary sniff result. */
export interface PreparedFile {
  readonly file: DiscoveredFile;
  /**
   * Raw content bytes (decoded to text lazily by the describe stage). Empty
   * for a terminal skip bucket (known-binary extension, too-large, or
   * NUL-sniffed binary) - those bytes are never sent to an LLM, so they are
   * never retained (NEC-012 / AC-018e.5, AC-018e.6).
   */
  readonly bytes: Uint8Array;
  /** sha256 hex of the content (the `hive_graph_versions.content_hash`). */
  readonly contentHash: string;
  /** True when a NUL byte appears in the first {@link BINARY_SNIFF_BYTES} bytes. */
  readonly hasNulInSniff: boolean;
}

const EMPTY_BYTES: Uint8Array = new Uint8Array(0);

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function nulInFirst(bytes: Uint8Array, limit: number): boolean {
  const end = Math.min(bytes.length, limit);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * A metadata-only content-hash surrogate for a known-binary file that is
 * never read (NEC-012 / AC-018e.5). It is stable across a fresh clone (path +
 * size only, deliberately excluding `mtimeObserved` which a checkout does not
 * preserve) but is NOT a hash of the file's actual bytes; this is safe because
 * a `skip-binary` row is never LLM-described and never enters the portable
 * projection's content-hash inherit index for anything other than itself (a
 * described file's hash always comes from real content).
 */
function metadataPseudoHash(file: DiscoveredFile): string {
  return sha256Hex(`nectar-binary-skip:${file.relPath}:${file.sizeBytes}`);
}

/**
 * Read one discovered file and prepare it (hash + binary sniff). Returns `null`
 * when the file cannot be read (it vanished between discovery and read, or the
 * fs seam refuses it) so the caller drops it from the candidate set.
 */
export function prepareFile(fs: RegistrationFs, file: DiscoveredFile): PreparedFile | null {
  const stat = fs.statPath(file.relPath);
  if (stat === null) return null;

  // Known-binary extensions are classified before any read (NEC-012 /
  // AC-018e.5): `classifyBucket` would route this to `skip-binary` purely from
  // the extension, so its content is never worth buffering.
  if (isKnownBinaryExtension(file.ext)) {
    return {
      file,
      bytes: EMPTY_BYTES,
      contentHash: metadataPseudoHash(file),
      hasNulInSniff: false,
    };
  }

  let raw: string | Uint8Array;
  try {
    raw = stat.readContent();
  } catch {
    return null;
  }
  const bytes = toBytes(raw);
  const contentHash = sha256Hex(bytes);
  const hasNulInSniff = nulInFirst(bytes, BINARY_SNIFF_BYTES);

  // A too-large or NUL-sniffed file is a terminal `skip-*` bucket
  // (`bucketing.ts` classifyBucket): it is hashed for the persisted row, but
  // its bytes are dropped immediately rather than retained for the run's
  // duration (NEC-012 / AC-018e.6).
  const isTerminalSkip = file.sizeBytes > MAX_DESCRIBE_SIZE || hasNulInSniff;
  return {
    file,
    bytes: isTerminalSkip ? EMPTY_BYTES : bytes,
    contentHash,
    hasNulInSniff,
  };
}

/** Read + prepare every discovered file (hash + sniff), dropping any that vanish. */
export function prepareFiles(fs: RegistrationFs, files: readonly DiscoveredFile[]): PreparedFile[] {
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const p = prepareFile(fs, file);
    if (p !== null) prepared.push(p);
  }
  return prepared;
}

export interface PrecheckOptions {
  readonly tenancy: Tenancy;
  /** The validated committed projection to inherit from, or `null` when none exists. */
  readonly projection: PortableProjection | null;
  /** Nectars already present in the local store; never re-inherited (PRD-011b). */
  readonly existingNectars?: ReadonlySet<string>;
  /** ISO 8601 "now" for inherited rows; injectable for deterministic tests. */
  readonly nowIso?: string;
}

export interface PrecheckResult {
  /** Identity + version rows to write for hash-matched (inherited) files. No LLM call. */
  readonly inheritedRows: readonly InheritRow[];
  /** Files with no projection match; these enter bucketing (`bucketing.ts`). */
  readonly survivors: readonly PreparedFile[];
  readonly inheritedCount: number;
  readonly survivorCount: number;
}

/**
 * Partition prepared candidates against the committed projection (stage 2). A
 * `content_hash` match inherits (no LLM call); a non-match survives into
 * bucketing. With no projection, every candidate survives.
 */
export function contentHashPrecheck(
  prepared: readonly PreparedFile[],
  opts: PrecheckOptions,
): PrecheckResult {
  if (opts.projection === null) {
    return {
      inheritedRows: [],
      survivors: [...prepared],
      inheritedCount: 0,
      survivorCount: prepared.length,
    };
  }

  const index = buildContentHashIndex(opts.projection);
  const diskHashes: Map<string, string> = new Map();
  const survivors: PreparedFile[] = [];
  for (const p of prepared) {
    if (index.has(p.contentHash)) {
      // A hash match feeds the inherit builder (path -> hash); it never enters bucketing.
      diskHashes.set(p.file.relPath, p.contentHash);
    } else {
      survivors.push(p);
    }
  }

  const summary = inheritFromProjection(opts.projection, diskHashes as DiskHashMap, {
    tenancy: opts.tenancy,
    nowIso: opts.nowIso,
    existingNectars: opts.existingNectars,
  });

  return {
    inheritedRows: summary.rows,
    survivors,
    inheritedCount: summary.rows.length,
    survivorCount: survivors.length,
  };
}
