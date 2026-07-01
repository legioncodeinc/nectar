import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFingerprint,
  fingerprintDistance,
  distanceToConfidence,
  createTlshFuzzyStep,
  MAX_DISTANCE,
  FINGERPRINT_PREFIX,
} from "../dist/registration/tlsh.js";
import { reassociate, type FuzzyCandidate } from "../dist/registration/ladder.js";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";

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

function candidateFrom(store: InMemorySourceGraphStore, content: string, sizeOverride?: number): FuzzyCandidate {
  reassociate(
    { relPath: "seed.ts", sizeBytes: Buffer.byteLength(content, "utf8"), mtimeObserved: NOW, readContent: () => content },
    { store, tenancy: TEN, now: () => NOW, existsOnDisk: () => true },
  );
  const lv = store.listLatestVersions(TEN)[0]!;
  const version = sizeOverride === undefined ? lv.version : { ...lv.version, sizeBytes: sizeOverride };
  return { identity: lv.identity, version, fingerprint: computeFingerprint(content) };
}

test("fuzzy step: an in-bucket near-duplicate matches above the high band", () => {
  const store = new InMemorySourceGraphStore();
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
  const store = new InMemorySourceGraphStore();
  const candidate = candidateFrom(store, BASE);
  const step = createTlshFuzzyStep({ highConfidence: 0.999, reviewFloor: 0.3 });
  const outcome = step.match(SMALL_EDIT, [candidate]);
  assert.equal(outcome.kind, "review");
});

test("fuzzy step: the +/-20% size bucket excludes far-sized candidates (AC-14)", () => {
  const store = new InMemorySourceGraphStore();
  // Identical fingerprint (distance 0) but a wildly different declared size -> excluded by the size bucket.
  const farBySize = candidateFrom(store, BASE, 5);
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  const outcome = step.match(BASE, [farBySize]);
  assert.equal(outcome.kind, "none", "a size-excluded candidate is not matched despite an identical fingerprint");
});

test("fuzzy step: a candidate without a fingerprint is skipped", () => {
  const store = new InMemorySourceGraphStore();
  const candidate = candidateFrom(store, BASE);
  const noFp: FuzzyCandidate = { ...candidate, fingerprint: null };
  const step = createTlshFuzzyStep({ highConfidence: 0.5, reviewFloor: 0.3 });
  assert.equal(step.match(SMALL_EDIT, [noFp]).kind, "none");
});
