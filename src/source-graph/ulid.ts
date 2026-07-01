/**
 * ULID minting for nectars (PRD-005 / PRD-006, per ai/identity-and-reassociation.md).
 *
 * A nectar is a 26-char ULID: 48-bit millisecond timestamp + 80 bits of
 * randomness, Crockford base32, uppercase. Two load-bearing properties (per the
 * corpus): lexicographic sortability by creation time, and registry-free
 * collision resistance so minting is lock-free and parallel-safe. Node built-ins
 * only (`node:crypto`); no `ulid` package dependency.
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

function encodeRandom(len: number): string {
  // 256 is divisible by 32, so byte % 32 is unbiased across 0..31.
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ENCODING[(bytes[i] as number) % 32];
  return out;
}

/** Mint a fresh nectar (26-char ULID). Never derived from content; created once. */
export function mintNectar(nowMs: number = Date.now()): string {
  return encodeTime(nowMs, TIME_LEN) + encodeRandom(RANDOM_LEN);
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

/** The nectar's creation time as an ISO 8601 string (for source_graph.created_at). */
export function nectarCreatedAt(nectar: string): string {
  return new Date(nectarTimestampMs(nectar)).toISOString();
}

/** Shape check: 26 chars, all in the Crockford alphabet. */
export function isValidNectar(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) if (ENCODING.indexOf(ch) === -1) return false;
  return true;
}
