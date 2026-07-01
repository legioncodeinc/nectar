/**
 * Step-4 fuzzy fingerprint + distance, pure TypeScript, zero runtime deps (PRD-006d AC-14/AC-17).
 *
 * PRD-006d flags the TLSH implementation as "native addon OR WASM build -
 * DEFAULT - confirm before implementation" and Hivenectar's ethos is zero
 * runtime dependencies (Node built-ins only). The native-addon / WASM options
 * therefore remain a flagged DEFAULT for later; this module ships the in-repo,
 * pure-TS DEFAULT so step 4 works today with no new dependency.
 *
 * The algorithm is a locality-sensitive near-duplicate fingerprint in the TLSH
 * family (a quartile-bucketed byte-trigram histogram), NOT byte-exact Trend
 * Micro TLSH. It satisfies the AC's behavior exactly: it produces a fixed-length
 * fingerprint, a distance between two fingerprints, size-buckets candidates by
 * +/-20%, and yields a scored confidence. Correctness of the near-duplicate
 * behavior (identical -> distance 0; a small edit -> small distance; unrelated
 * -> large distance) is what matters here, per the PRD's own guidance. The
 * `native addon or WASM` swap keeps the same fingerprint/distance interface, so
 * it can replace this module later without touching the ladder.
 *
 * DELIBERATE SPEC GAP (AC-16): NO confidence threshold is pinned in this module.
 * The distance-to-confidence mapping uses only the algorithm's theoretical
 * maximum distance as its normalization denominator (not a tuned cutoff). The
 * accept/review band edges are supplied by the caller via {@link FuzzyConfig};
 * the operator default below is explicitly a tunable operator default (tuned
 * during brooding, PRD-007), NOT a spec-pinned threshold.
 */
import type { FuzzyStep, FuzzyOutcome, FuzzyCandidate } from "./ladder.js";

/** Fingerprint format tag. Distinguishes this in-repo digest from a byte-exact TLSH string. */
export const FINGERPRINT_PREFIX = "H1";

const BUCKETS = 128; // 2 bits per bucket -> 256-bit body (32 bytes, 64 hex chars).
const BODY_HEX_LEN = 64;
const FINGERPRINT_LEN = FINGERPRINT_PREFIX.length + 4 + BODY_HEX_LEN; // prefix + header(4) + body(64).

/** Per-bucket max weighted diff (a mod-4 code distance of 3 is weighted 6). */
const BODY_MAX = BUCKETS * 6; // 768
const LEN_MAX = 32; // capped length-code contribution
const CHK_MAX = 1; // checksum-differs contribution

/** Theoretical maximum distance; the normalization denominator for confidence (algorithmic, not a threshold). */
export const MAX_DISTANCE = BODY_MAX + LEN_MAX + CHK_MAX; // 801

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new Uint8Array(Buffer.from(content, "utf8")) : content;
}

function byteLengthOf(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
}

function toHexByte(n: number): string {
  return (n & 0xff).toString(16).padStart(2, "0");
}

/** Log-scaled 1-byte length code so near-length files share it and far-length files differ. */
function lengthCode(len: number): number {
  return Math.min(255, Math.round(Math.log2(len + 1) * 8));
}

/**
 * Compute the locality-sensitive fingerprint of the given content. Deterministic
 * (no randomness), so identical bytes always produce an identical string.
 */
export function computeFingerprint(content: string | Uint8Array): string {
  const bytes = toBytes(content);
  const counts = new Array<number>(BUCKETS).fill(0);
  let checksum = 0;
  for (let i = 0; i < bytes.length; i++) {
    checksum = (checksum + (bytes[i] as number)) & 0xff;
  }
  // Contiguous byte-trigram histogram: a small edit only perturbs a handful of
  // trigrams, so most bucket counts (and thus the quartile codes) are stable.
  for (let i = 0; i + 2 < bytes.length; i++) {
    const h = (((bytes[i] as number) * 31 + (bytes[i + 1] as number)) * 31 + (bytes[i + 2] as number)) >>> 0;
    const bucket = h % BUCKETS;
    counts[bucket] = (counts[bucket] as number) + 1;
  }

  const sorted = [...counts].sort((a, b) => a - b);
  const q1 = quartile(sorted, 0.25);
  const q2 = quartile(sorted, 0.5);
  const q3 = quartile(sorted, 0.75);

  // Encode each bucket into a 2-bit quartile code, pack 4 codes per byte.
  let bodyHex = "";
  for (let b = 0; b < BUCKETS; b += 4) {
    let packed = 0;
    for (let j = 0; j < 4; j++) {
      packed = (packed << 2) | quartileCode(counts[b + j] as number, q1, q2, q3);
    }
    bodyHex += toHexByte(packed);
  }

  const header = toHexByte(checksum) + toHexByte(lengthCode(bytes.length));
  return FINGERPRINT_PREFIX + header + bodyHex;
}

function quartile(sortedAsc: readonly number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(fraction * sortedAsc.length));
  return sortedAsc[idx] as number;
}

function quartileCode(count: number, q1: number, q2: number, q3: number): number {
  if (count <= q1) return 0;
  if (count <= q2) return 1;
  if (count <= q3) return 2;
  return 3;
}

interface ParsedFingerprint {
  readonly checksum: number;
  readonly lengthCode: number;
  readonly codes: readonly number[];
}

function parse(fp: string): ParsedFingerprint | null {
  if (!fp.startsWith(FINGERPRINT_PREFIX) || fp.length !== FINGERPRINT_LEN) return null;
  const checksum = Number.parseInt(fp.slice(2, 4), 16);
  const lenCode = Number.parseInt(fp.slice(4, 6), 16);
  if (Number.isNaN(checksum) || Number.isNaN(lenCode)) return null;
  const bodyHex = fp.slice(6);
  const codes: number[] = [];
  for (let i = 0; i < bodyHex.length; i += 2) {
    const byte = Number.parseInt(bodyHex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    codes.push((byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3, byte & 3);
  }
  return { checksum, lengthCode: lenCode, codes };
}

/**
 * Distance between two fingerprints. 0 for identical content; small for a small
 * edit; large for unrelated content. Returns {@link MAX_DISTANCE} when either
 * fingerprint is malformed (treated as maximally distant, never a false match).
 */
export function fingerprintDistance(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return MAX_DISTANCE;

  let bodyDist = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const diff = Math.abs((pa.codes[i] as number) - (pb.codes[i] as number));
    bodyDist += diff === 3 ? 6 : diff;
  }
  const lenDist = Math.min(LEN_MAX, Math.abs(pa.lengthCode - pb.lengthCode));
  const chkDist = pa.checksum === pb.checksum ? 0 : CHK_MAX;
  return bodyDist + lenDist + chkDist;
}

/** Map a fingerprint distance to a [0,1] confidence using the theoretical max distance (not a tuned cutoff). */
export function distanceToConfidence(distance: number): number {
  if (distance <= 0) return 1;
  const c = 1 - distance / MAX_DISTANCE;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** The +/-20% size-bucket half-width from the corpus (brooding-pipeline.md), an algorithmic optimization, not a threshold. */
export const SIZE_BUCKET_TOLERANCE = 0.2;

/**
 * The step-4 confidence bands. Supplied by the caller (the daemon config), NOT
 * pinned by the corpus or PRD-006d. `highConfidence` is the auto-carry floor;
 * `reviewFloor` is the floor for surfacing to `review-matches`; below it the
 * file falls through to a fresh mint (step 5).
 */
export interface FuzzyConfig {
  readonly highConfidence: number;
  readonly reviewFloor: number;
}

/**
 * OPERATOR DEFAULT, tunable during brooding (PRD-007). This is NOT a
 * spec-pinned threshold: PRD-006d and identity-and-reassociation.md deliberately
 * pin no number ("configurable, default tuned during brooding"). These values
 * exist only so the daemon has a runnable fuzzy step out of the box; an operator
 * overrides them via daemon config, and brooding calibrates them against the
 * actual codebase's near-duplicate distribution. Do NOT treat these as the spec.
 */
export const DEFAULT_TUNABLE_FUZZY_CONFIG: FuzzyConfig = {
  highConfidence: 0.85,
  reviewFloor: 0.55,
};

/**
 * Build the concrete, pure-TS step-4 fuzzy matcher. Size-buckets the candidates
 * by +/-20% of the new content's byte length, fingerprints the new content,
 * scores each in-bucket candidate that carries a fingerprint, and bands the best
 * score by the injected {@link FuzzyConfig}. The band edges come from `config`;
 * this function pins none.
 */
export function createTlshFuzzyStep(config: FuzzyConfig): FuzzyStep {
  return {
    match(content: string | Uint8Array, candidates: readonly FuzzyCandidate[]): FuzzyOutcome {
      const newSize = byteLengthOf(content);
      const lo = newSize * (1 - SIZE_BUCKET_TOLERANCE);
      const hi = newSize * (1 + SIZE_BUCKET_TOLERANCE);
      const newFingerprint = computeFingerprint(content);

      let best: { nectar: string; confidence: number; distance: number } | null = null;
      for (const candidate of candidates) {
        if (candidate.fingerprint === null) continue;
        const size = candidate.version.sizeBytes;
        if (size < lo || size > hi) continue; // outside the +/-20% size bucket
        const distance = fingerprintDistance(newFingerprint, candidate.fingerprint);
        const confidence = distanceToConfidence(distance);
        if (best === null || confidence > best.confidence) {
          best = { nectar: candidate.identity.nectar, confidence, distance };
        }
      }

      if (best === null) return { kind: "none" };
      if (best.confidence >= config.highConfidence) {
        return { kind: "match", nectar: best.nectar, confidence: best.confidence, distance: best.distance };
      }
      if (best.confidence >= config.reviewFloor) {
        return { kind: "review", nectar: best.nectar, confidence: best.confidence, distance: best.distance };
      }
      return { kind: "none" };
    },
  };
}
