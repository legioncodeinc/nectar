/**
 * ULID minting (src/hive-graph/ulid.ts). Covers the NEC-042 item 6 / AC-018l.13
 * fix: nectars minted within the SAME millisecond are strictly increasing
 * (same-ms monotonic counter), so the module's "lexicographic sortability by
 * creation time" claim holds even at sub-millisecond mint rates. Runs against
 * the compiled `dist/` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintNectar, nectarTimestampMs, isValidNectar } from "../dist/hive-graph/ulid.js";

test("AC-018l.13 many nectars minted in one millisecond are strictly increasing and unique (NEC-042 item 6)", () => {
  const ms = 1_700_000_000_000;
  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) ids.push(mintNectar(ms));

  for (const id of ids) assert.ok(isValidNectar(id), "every mint is a valid 26-char ULID");
  assert.equal(new Set(ids).size, ids.length, "no collisions within a single millisecond");
  for (let i = 1; i < ids.length; i++) {
    assert.ok((ids[i] as string) > (ids[i - 1] as string), `ULID ${i} sorts strictly after ${i - 1} (monotonic within the ms)`);
  }
  // The encoded timestamp is the supplied ms exactly (never clamped forward).
  assert.equal(nectarTimestampMs(ids[0] as string), ms);
  assert.equal(nectarTimestampMs(ids[ids.length - 1] as string), ms);
});

test("a later millisecond mints a nectar that sorts after an earlier one", () => {
  const early = mintNectar(1000);
  const later = mintNectar(2000);
  assert.ok(later > early, "a later timestamp sorts after an earlier one");
  assert.equal(nectarTimestampMs(early), 1000);
  assert.equal(nectarTimestampMs(later), 2000);
});

test("real-clock mints stay unique and valid", () => {
  const a = mintNectar();
  const b = mintNectar();
  assert.notEqual(a, b, "two consecutive mints differ even at the same wall-clock millisecond");
  assert.ok(isValidNectar(a) && isValidNectar(b));
});
