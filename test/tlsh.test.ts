import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFingerprint,
  fingerprintDistance,
  distanceToConfidence,
  createTlshFuzzyStep,
  MAX_DISTANCE,
  MIN_FUZZY_EVIDENCE_BYTES,
  DEFAULT_TUNABLE_FUZZY_CONFIG,
  FINGERPRINT_PREFIX,
} from "../dist/registration/tlsh.js";
import { reassociate, type FuzzyCandidate } from "../dist/registration/ladder.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";

const TEN = { orgId: "o1", workspaceId: "w1", projectId: "p1" };
const NOW = "2026-07-01T00:00:00.000Z";

const BASE = "The quick brown fox jumps over the lazy dog. ".repeat(24);
const SMALL_EDIT = `${BASE}One additional trailing sentence for a small edit.`;
const UNRELATED = "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod. ".repeat(24);

test("fingerprint is deterministic and prefixed", () => {
  const a = computeFingerprint(BASE);
  const b = computeFingerprint(BASE);
  assert.equal(a, b, "same content -> same fingerprint");
  assert.ok(a.startsWith(FINGERPRINT_PREFIX), "fingerprint carries the format tag");
});

test("identical content has distance 0 and confidence 1", () => {
  const fp = computeFingerprint(BASE);
  assert.equal(fingerprintDistance(fp, fp), 0);
  assert.equal(distanceToConfidence(0), 1);
});

test("a small edit is closer than unrelated content (locality sensitivity)", () => {
  const base = computeFingerprint(BASE);
  const edited = computeFingerprint(SMALL_EDIT);
  const unrelated = computeFingerprint(UNRELATED);
  const editDist = fingerprintDistance(base, edited);
  const unrelatedDist = fingerprintDistance(base, unrelated);
  assert.ok(editDist < unrelatedDist, `edit distance ${editDist} < unrelated distance ${unrelatedDist}`);
  assert.ok(distanceToConfidence(editDist) > distanceToConfidence(unrelatedDist));
  assert.ok(distanceToConfidence(editDist) > 0.5, "a small edit stays reasonably confident");
});

test("a malformed fingerprint is maximally distant (never a false match)", () => {
  assert.equal(fingerprintDistance(computeFingerprint(BASE), "not-a-fingerprint"), MAX_DISTANCE);
});

function candidateFrom(store: InMemoryHiveGraphStore, content: string, sizeOverride?: number): FuzzyCandidate {
  reassociate(
    { relPath: "seed.ts", sizeBytes: Buffer.byteLength(content, "utf8"), mtimeObserved: NOW, readContent: () => content },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  const lv = store.listLatestVersions(TEN)[0]!;
  const version = sizeOverride === undefined ? lv.version : { ...lv.version, sizeBytes: sizeOverride };
  return { identity: lv.identity, version, fingerprint: computeFingerprint(content) };
}

test("fuzzy step: an in-bucket near-duplicate matches above the high band", () => {
  const store = new InMemoryHiveGraphStore();
  const candidate = candidateFrom(store, BASE);
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  const outcome = step.match(SMALL_EDIT, [candidate]);
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.equal(outcome.nectar, candidate.identity.nectar);
    assert.ok(typeof outcome.distance === "number");
  }
});

test("fuzzy step: a mid-confidence candidate lands in the review band", () => {
  const store = new InMemoryHiveGraphStore();
  const candidate = candidateFrom(store, BASE);
  const step = createTlshFuzzyStep({ highConfidence: 0.999, reviewFloor: 0.3 });
  const outcome = step.match(SMALL_EDIT, [candidate]);
  assert.equal(outcome.kind, "review");
});

test("fuzzy step: the +/-20% size bucket excludes far-sized candidates (AC-14)", () => {
  const store = new InMemoryHiveGraphStore();
  // Identical fingerprint (distance 0) but a wildly different declared size -> excluded by the size bucket.
  const farBySize = candidateFrom(store, BASE, 5);
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  const outcome = step.match(BASE, [farBySize]);
  assert.equal(outcome.kind, "none", "a size-excluded candidate is not matched despite an identical fingerprint");
});

test("fuzzy step: a candidate without a fingerprint is skipped", () => {
  const store = new InMemoryHiveGraphStore();
  const candidate = candidateFrom(store, BASE);
  const noFp: FuzzyCandidate = { ...candidate, fingerprint: null };
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  assert.equal(step.match(SMALL_EDIT, [noFp]).kind, "none");
});

// --- PRD-018d / NEC-010: size-aware confidence for tiny inputs (H5) ---

const TINY_A = "gitkeep123"; // 10 bytes
const TINY_B = "0123456789"; // 10 bytes, same size bucket, unrelated content

test("AC-018d.1: two unrelated ~10-byte files in the same size bucket score below the review band at the DEFAULT bands", () => {
  const store = new InMemoryHiveGraphStore();
  assert.equal(Buffer.byteLength(TINY_A, "utf8"), 10);
  assert.equal(Buffer.byteLength(TINY_B, "utf8"), 10);
  const candidate = candidateFrom(store, TINY_A);
  // The DEFAULT tunable bands (highConfidence 0.85), exactly as an operator
  // would run it - the old fixed-MAX_DISTANCE mapping scored this pair >= 0.879,
  // above highConfidence; the fix must abstain (kind "none") at these defaults.
  const step = createTlshFuzzyStep(DEFAULT_TUNABLE_FUZZY_CONFIG);
  const outcome = step.match(TINY_B, [candidate]);
  assert.equal(outcome.kind, "none", "unrelated tiny files must abstain, never auto-carry or even review");
});

test("AC-018d.2: an input below the evidence floor abstains regardless of digest distance, even with an identical (distance-0) candidate", () => {
  const store = new InMemoryHiveGraphStore();
  assert.ok(Buffer.byteLength(TINY_A, "utf8") < MIN_FUZZY_EVIDENCE_BYTES, "fixture must sit below the evidence floor");
  // Seed a candidate with the EXACT SAME tiny content (distance 0, confidence
  // would be 1 under any normalization) to prove the gate fires unconditionally.
  const candidate = candidateFrom(store, TINY_A);
  const step = createTlshFuzzyStep({ highConfidence: 0.01, reviewFloor: 0.01 }); // maximally permissive bands
  const outcome = step.match(TINY_A, [candidate]);
  assert.equal(outcome.kind, "none", "a distance-0 candidate below the evidence floor still abstains");
});

test("AC-018d.3: existing large-fixture band placement is unchanged, and the bands still read from DEFAULT_TUNABLE_FUZZY_CONFIG", () => {
  const store = new InMemoryHiveGraphStore();
  const candidate = candidateFrom(store, BASE);
  assert.ok(Buffer.byteLength(BASE, "utf8") > 130, "the corpus fixture is well above the size where the fix changes anything");

  // Same two scenarios as the pre-existing "high band" / "review band" tests
  // above, re-asserted to prove this epic introduced no regression on the
  // sanctioned auto-carry path.
  const highBandStep = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  const highOutcome = highBandStep.match(SMALL_EDIT, [candidate]);
  assert.equal(highOutcome.kind, "match", "a genuine near-duplicate at fixture size still auto-carries");

  const reviewBandStep = createTlshFuzzyStep({ highConfidence: 0.999, reviewFloor: 0.3 });
  const reviewOutcome = reviewBandStep.match(SMALL_EDIT, [candidate]);
  assert.equal(reviewOutcome.kind, "review", "the same pair still lands in review under a stricter high band");

  // The band edges are still read live from the config object, not pinned.
  assert.equal(DEFAULT_TUNABLE_FUZZY_CONFIG.highConfidence, 0.85);
  assert.equal(DEFAULT_TUNABLE_FUZZY_CONFIG.reviewFloor, 0.55);
});

test("AC-018d.3: confidence for a large-fixture pair is bit-for-bit identical to the fixed-MAX_DISTANCE mapping", () => {
  const a = computeFingerprint(BASE);
  const b = computeFingerprint(SMALL_EDIT);
  const distance = fingerprintDistance(a, b);
  // Both BASE and SMALL_EDIT carry >= 128 trigrams, so the size-aware
  // denominator collapses back to the fixed MAX_DISTANCE (see
  // achievableMaxDistance's docstring): distanceToConfidence(distance) without
  // a size argument must equal the size-aware fuzzy step's internal scoring.
  const legacyConfidence = distanceToConfidence(distance);
  const sizeAwareStep = createTlshFuzzyStep({ highConfidence: legacyConfidence - 0.001, reviewFloor: 0 });
  const store = new InMemoryHiveGraphStore();
  const candidate = candidateFrom(store, BASE);
  const outcome = sizeAwareStep.match(SMALL_EDIT, [candidate]);
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.ok(Math.abs(outcome.confidence - legacyConfidence) < 1e-9, "no regression: identical score at fixture size");
  }
});
