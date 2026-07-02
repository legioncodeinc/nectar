/**
 * 768-dim guard tests (PRD-014 AC-3 / 014b US-014b.2 / 014c US-014c.3).
 *
 * Proves a vector that is not exactly 768-dim from EITHER provider is discarded
 * to null (the column stays NULL, recall degrades to BM25) and the rejection is
 * reported through the injectable sink. Imports the compiled module from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardVector, withDimGuard } from "../dist/embeddings/guard.js";
import type { DimRejection } from "../dist/embeddings/guard.js";
import { resolveEmbedProvider } from "../dist/embeddings/provider.js";
import { resolveEmbeddingsConfig } from "../dist/embeddings/config.js";
import type { LocalNomicTransport } from "../dist/embeddings/local-nomic.js";
import { EMBED_DIMS } from "../dist/hive-graph/model.js";

// ── AC-3: wrong-dim from the LOCAL provider is discarded ───────────────────────

test("014-AC-3 a 1024-dim vector from the local provider is discarded to null and reported", async () => {
  const rejections: DimRejection[] = [];
  const bigVec: LocalNomicTransport = { async embedOne(): Promise<number[] | null> { return new Array(1024).fill(0.5); } };
  const config = resolveEmbeddingsConfig({ selector: "local", env: {} });
  const provider = resolveEmbedProvider(config, {
    localTransport: bigVec,
    onDimRejected: (r) => rejections.push(r),
  });
  const out = await provider.embed(["x"]);
  assert.deepEqual(out, [null]);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.provider, "local");
  assert.equal(rejections[0]?.expected, EMBED_DIMS);
  assert.equal(rejections[0]?.actual, 1024);
});

// ── AC-3: wrong-dim from the COHERE provider is discarded ──────────────────────

test("014-AC-3 a 767-dim vector from the cohere provider is discarded to null and reported", async () => {
  const rejections: DimRejection[] = [];
  const fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ embedding: new Array(767).fill(0.1), index: 0 }] }),
  });
  const config = resolveEmbeddingsConfig({ selector: "hosted", hosted: { apiKey: "k", configId: "c" }, env: {} });
  const provider = resolveEmbedProvider(config, { fetch, onDimRejected: (r) => rejections.push(r) });
  const out = await provider.embed(["x"]);
  assert.deepEqual(out, [null]);
  assert.equal(rejections[0]?.provider, "hosted");
  assert.equal(rejections[0]?.expected, EMBED_DIMS);
  assert.equal(rejections[0]?.actual, 767);
});

// ── the guard primitive itself ─────────────────────────────────────────────────

test("014-AC-3 guardVector passes a valid 768-dim vector and null, discards any other length", () => {
  const valid = new Array(EMBED_DIMS).fill(0.3);
  assert.equal(guardVector(valid, "local"), valid);
  assert.equal(guardVector(null, "local"), null);
  assert.equal(guardVector(new Array(10).fill(1), "hosted"), null);
  assert.equal(guardVector(new Array(1536).fill(1), "hosted"), null);
});

test("014-AC-3 a mixed batch discards only the wrong-dim entries and keeps the valid ones", async () => {
  const rejections: DimRejection[] = [];
  // A raw provider stub: first vector valid, second wrong-dim, third null.
  const raw = {
    kind: "hosted" as const,
    async embed(): Promise<(number[] | null)[]> {
      return [new Array(768).fill(0.1), new Array(5).fill(0.2), null];
    },
  };
  const guarded = withDimGuard(raw, (r) => rejections.push(r));
  const out = await guarded.embed(["a", "b", "c"]);
  assert.equal(out[0]?.length, 768);
  assert.equal(out[1], null);
  assert.equal(out[2], null);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.actual, 5);
});

test("014-AC-3 a faulty rejection sink never breaks the embed path", async () => {
  const raw = {
    kind: "local" as const,
    async embed(): Promise<(number[] | null)[]> {
      return [new Array(3).fill(1)];
    },
  };
  const guarded = withDimGuard(raw, () => {
    throw new Error("sink blew up");
  });
  assert.deepEqual(await guarded.embed(["x"]), [null]);
});
