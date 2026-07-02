/**
 * Embeddings provider-switch tests (PRD-014a / 014c).
 *
 * Proves AC-1 (default resolution -> local path invoked) and AC-4 (off /
 * failed-warm -> nulls, no throw, caller-visible degraded state). Imports the
 * compiled module from `dist/` (the suite builds first, per package.json).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEmbedProvider } from "../dist/embeddings/provider.js";
import { resolveEmbeddingsConfig } from "../dist/embeddings/config.js";
import { createLocalNomicHttpTransport } from "../dist/embeddings/local-nomic.js";
import type { LocalNomicTransport } from "../dist/embeddings/local-nomic.js";

/** A fake local transport that records each call and returns a fixed-dim vector. */
function fakeLocal(dim: number): { transport: LocalNomicTransport; calls: () => number } {
  let n = 0;
  return {
    transport: {
      async embedOne(): Promise<number[] | null> {
        n += 1;
        return new Array(dim).fill(0.1);
      },
    },
    calls: () => n,
  };
}

// ── AC-1: no explicit selection -> local provider, and it is actually invoked ──

test("014-AC-1 no explicit selection resolves to the local nomic provider", () => {
  const config = resolveEmbeddingsConfig({ env: {} });
  assert.equal(config.selector, "local");
  const provider = resolveEmbedProvider(config, { localTransport: fakeLocal(768).transport });
  assert.equal(provider.kind, "local");
});

test("014-AC-1 the default (local) path is invoked once per text and returns the vectors", async () => {
  const config = resolveEmbeddingsConfig({ env: {} });
  const local = fakeLocal(768);
  const provider = resolveEmbedProvider(config, { localTransport: local.transport });
  const out = await provider.embed(["title one", "title two"]);
  assert.equal(local.calls(), 2);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.length, 768);
  assert.equal(out[1]?.length, 768);
});

test("014-AC-1 selecting cohere does NOT exercise the local daemon path (AC-014a.2.2)", async () => {
  const config = resolveEmbeddingsConfig({
    selector: "cohere",
    cohere: { apiKey: "k", configId: "c" },
    env: {},
  });
  const local = fakeLocal(768);
  const fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ embedding: new Array(768).fill(0.2), index: 0 }] }),
  });
  const provider = resolveEmbedProvider(config, { localTransport: local.transport, fetch });
  assert.equal(provider.kind, "cohere");
  await provider.embed(["x"]);
  assert.equal(local.calls(), 0);
});

// ── AC-4: off / failed-warm -> nulls, no throw, caller-visible degraded state ──

test("014-AC-4 the off selector yields a null per text and never throws", async () => {
  const config = resolveEmbeddingsConfig({ selector: "off", env: {} });
  const provider = resolveEmbedProvider(config);
  assert.equal(provider.kind, "off");
  const out = await provider.embed(["a", "b", "c"]);
  assert.deepEqual(out, [null, null, null]);
});

test("014-AC-4 a dead local daemon (transport returns null) degrades to nulls, no throw", async () => {
  const config = resolveEmbeddingsConfig({ selector: "local", env: {} });
  const dead: LocalNomicTransport = { async embedOne(): Promise<number[] | null> { return null; } };
  const provider = resolveEmbedProvider(config, { localTransport: dead });
  assert.deepEqual(await provider.embed(["x", "y"]), [null, null]);
});

test("014-AC-4 a throwing local transport is caught (never-throw contract holds)", async () => {
  const config = resolveEmbeddingsConfig({ selector: "local", env: {} });
  const throwing: LocalNomicTransport = {
    async embedOne(): Promise<number[] | null> {
      throw new Error("ECONNREFUSED 127.0.0.1:3851");
    },
  };
  const provider = resolveEmbedProvider(config, { localTransport: throwing });
  assert.deepEqual(await provider.embed(["x"]), [null]);
});

test("014-AC-4 the real local HTTP transport fails soft on a dead daemon and a 503 not-warm", async () => {
  const config = resolveEmbeddingsConfig({ selector: "local", env: {} });

  // Dead daemon: fetch rejects (ECONNREFUSED) -> null, no throw.
  const deadFetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const deadTransport = createLocalNomicHttpTransport(config.local, { fetch: deadFetch });
  assert.equal(await deadTransport.embedOne("x"), null);

  // Not-warm daemon: 503 -> null.
  const notWarmFetch = async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: "model not ready" }) });
  const notWarmTransport = createLocalNomicHttpTransport(config.local, { fetch: notWarmFetch });
  assert.equal(await notWarmTransport.embedOne("x"), null);

  // Warm daemon returning a 768-dim vector -> passes through.
  const warmFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ vector: new Array(768).fill(0.4) }) });
  const warmTransport = createLocalNomicHttpTransport(config.local, { fetch: warmFetch });
  const vec = await warmTransport.embedOne("x");
  assert.equal(vec?.length, 768);
});
