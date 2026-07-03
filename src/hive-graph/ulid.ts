/**
 * ULID minting for nectars (PRD-005 / PRD-006, per ai/identity-and-reassociation.md).
 *
 * A nectar is a 26-char ULID: 48-bit millisecond timestamp + 80 bits of
 * randomness, Crockford base32, uppercase. Two load-bearing properties (per the
 * corpus): lexicographic sortability by creation time - MONOTONIC even within a
 * single millisecond via a same-ms counter (NEC-042 item 6 / AC-018l.13), so two
 * nectars minted in the same millisecond still sort in creation order - and
 * registry-free collision resistance so minting is lock-free and parallel-safe.
 * Node built-ins only (`node:crypto`); no `ulid` package dependency.
 *
 * The same-ms counter is the standard `monotonicFactory` behavior: within one
 * millisecond, the 80-bit random component is INCREMENTED per mint instead of
 * re-randomized, so the ULIDs are strictly increasing. The encoded timestamp is
 * always the supplied `nowMs` (never clamped forward), so `nectarTimestampMs`
 * decodes it exactly; a new millisecond re-randomizes the component.
 */
import { randomBytes } from "node:crypto";

/** Crockford base32 alphabet (excludes I, L, O, U). 32 symbols, 5 bits each. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits, covers the 48-bit ms timestamp
const RANDOM_LEN = 16; // 16 chars * 5 bits = 80 bits of randomness

function encodeTime(ms: number, len: number): string {
  let now = Math.floor(ms);
  let out = "";
  for (let i = 0; i < len; i++) {
    out = ENCODING[now % 32] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

/** Fresh randomness as `len` base32 symbol indices (0..31). 256 % 32 == 0, so `byte % 32` is unbiased. */
function freshRandomDigits(len: number): number[] {
  const bytes = randomBytes(len);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push((bytes[i] as number) % 32);
  return out;
}

/**
 * Increment a base32-digit array by one (least-significant last), carrying on a
 * 31 -> 0 rollover. On a full overflow (every digit was 31, astronomically
 * unlikely with 80 bits) it falls back to fresh randomness rather than throwing,
 * so minting never crashes.
 */
function incrementDigits(digits: readonly number[]): number[] {
  const out = digits.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i] as number;
    if (d < 31) {
      out[i] = d + 1;
      return out;
    }
    out[i] = 0;
  }
  return freshRandomDigits(out.length);
}

function digitsToString(digits: readonly number[]): string {
  let out = "";
  for (const d of digits) out += ENCODING[d];
  return out;
}

/** The last millisecond minted at, and its (possibly incremented) random component, for same-ms monotonicity. */
let lastMintMs = -1;
let lastRandomDigits: number[] = [];

/**
 * Mint a fresh nectar (26-char ULID). Never derived from content; created once.
 * Within the same millisecond the random component is incremented (monotonic),
 * so `mintNectar(t)` called repeatedly at the same `t` yields strictly
 * increasing ULIDs; a new millisecond re-randomizes it.
 */
export function mintNectar(nowMs: number = Date.now()): string {
  const t = Math.floor(nowMs);
  if (t === lastMintMs) {
    lastRandomDigits = incrementDigits(lastRandomDigits);
  } else {
    lastMintMs = t;
    lastRandomDigits = freshRandomDigits(RANDOM_LEN);
  }
  return encodeTime(t, TIME_LEN) + digitsToString(lastRandomDigits);
}

/** Decode a nectar's embedded 48-bit timestamp back to milliseconds since epoch. */
export function nectarTimestampMs(nectar: string): number {
  const timeChars = nectar.slice(0, TIME_LEN);
  let ms = 0;
  for (const ch of timeChars) {
    const idx = ENCODING.indexOf(ch);
    if (idx === -1) throw new Error(`invalid ULID time char: ${ch}`);
    ms = ms * 32 + idx;
  }
  return ms;
}

/** The nectar's creation time as an ISO 8601 string (for hive_graph.created_at). */
export function nectarCreatedAt(nectar: string): string {
  return new Date(nectarTimestampMs(nectar)).toISOString();
}

/** Shape check: 26 chars, all in the Crockford alphabet. */
export function isValidNectar(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) if (ENCODING.indexOf(ch) === -1) return false;
  return true;
}
