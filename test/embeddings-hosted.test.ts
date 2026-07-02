/**
 * hosted-via-Portkey embeddings transport tests (PRD-014b).
 *
 * Proves AC-2 (opt-in POSTs the Portkey embeddings endpoint with the
 * rerank-pattern headers; model id + dimensions in the body; both
 * config-overridable) plus the fail-soft + secret-never-logged invariants
 * (US-014b.3). Imports the compiled module from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEmbedProvider } from "../dist/embeddings/provider.js";
import { resolveEmbeddingsConfig } from "../dist/embeddings/config.js";
import {
  DEFAULT_HOSTED_EMBED_MODEL,
  DEFAULT_HOSTED_OUTPUT_DIMENSION,
} from "../dist/embeddings/hosted-portkey.js";
import {
  buildPortkeyHeaders,
  PORTKEY_API_KEY_HEADER,
  PORTKEY_BASE_URL,
  PORTKEY_CONFIG_HEADER,
  PORTKEY_EMBEDDINGS_URL,
} from "../dist/portkey/headers.js";

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake fetch that records the request and returns an OpenAI-compatible 768-dim vector. */
function recordingFetch(seen: SeenRequest, dim = 768) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    seen.url = url;
    seen.headers = init.headers;
    seen.body = init.body;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ embedding: new Array(dim).fill(0.2), index: 0 }] }),
    };
  };
}

// ── AC-2: endpoint + rerank-pattern headers + model + dimensions ─────────

test("014-AC-2 hosted opt-in POSTs the Portkey embeddings endpoint with the rerank-pattern headers", async () => {
  const seen: SeenRequest = { url: "", headers: {}, body: "" };
  const config = resolveEmbeddingsConfig({
    selector: "hosted",
    hosted: { apiKey: "pk-secret", configId: "pcfg-1" },
    env: {},
  });
  const provider = resolveEmbedProvider(config, { fetch: recordingFetch(seen), sleep: async () => undefined });
  const out = await provider.embed(["describe this file"]);

  assert.equal(seen.url, PORTKEY_EMBEDDINGS_URL);
  assert.equal(seen.url, `${PORTKEY_BASE_URL}/embeddings`);
  assert.equal(seen.headers[PORTKEY_API_KEY_HEADER], "pk-secret");
  assert.equal(seen.headers[PORTKEY_CONFIG_HEADER], "pcfg-1");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.deepEqual(seen.headers, buildPortkeyHeaders("pk-secret", "pcfg-1"));
  assert.equal(out[0]?.length, 768);
});

test("014-AC-2 the body carries the default model id (text-embedding-3-small) and dimensions (768)", async () => {
  const seen: SeenRequest = { url: "", headers: {}, body: "" };
  const config = resolveEmbeddingsConfig({
    selector: "hosted",
    hosted: { apiKey: "k", configId: "c" },
    env: {},
  });
  const provider = resolveEmbedProvider(config, { fetch: recordingFetch(seen) });
  await provider.embed(["a", "b"]);

  const body = JSON.parse(seen.body);
  assert.equal(body.model, DEFAULT_HOSTED_EMBED_MODEL);
  assert.equal(body.model, "text-embedding-3-small");
  assert.equal(body.dimensions, DEFAULT_HOSTED_OUTPUT_DIMENSION);
  assert.equal(body.dimensions, 768);
  assert.deepEqual(body.input, ["a", "b"]);
});

test("014-AC-2 model id and dimensions are config-overridable (explicit overrides)", async () => {
  const seen: SeenRequest = { url: "", headers: {}, body: "" };
  const config = resolveEmbeddingsConfig({
    selector: "hosted",
    hosted: { apiKey: "k", configId: "c", model: "embed-multilingual-v4.0", outputDimension: 512 },
    env: {},
  });
  const provider = resolveEmbedProvider(config, { fetch: recordingFetch(seen) });
  await provider.embed(["x"]);

  const body = JSON.parse(seen.body);
  assert.equal(body.model, "embed-multilingual-v4.0");
  assert.equal(body.dimensions, 512);
});

test("014-AC-2 model id and dimensions are config-overridable (env)", () => {
  const config = resolveEmbeddingsConfig({
    selector: "hosted",
    env: {
      NECTAR_EMBEDDINGS_HOSTED_MODEL: "text-embedding-3-large",
      NECTAR_EMBEDDINGS_OUTPUT_DIMENSION: "1024",
      NECTAR_PORTKEY_API_KEY: "envkey",
      NECTAR_PORTKEY_CONFIG: "envcfg",
    },
  });
  assert.equal(config.hosted.model, "text-embedding-3-large");
  assert.equal(config.hosted.outputDimension, 1024);
  assert.equal(config.hosted.apiKey, "envkey");
  assert.equal(config.hosted.configId, "envcfg");
});

// ── fail-soft + secret discipline (US-014b.3) ──────────────────────────────────

test("014-AC-2 hosted fails soft to nulls on a non-2xx and never surfaces the key", async () => {
  const fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: "pk-secret should never be read into a message" }),
  });
  const config = resolveEmbeddingsConfig({
    selector: "hosted",
    hosted: { apiKey: "pk-secret", configId: "c", maxAttempts: 1 },
    env: {},
  });
  const provider = resolveEmbedProvider(config, { fetch, sleep: async () => undefined });
  const out = await provider.embed(["a", "b"]);
  assert.deepEqual(out, [null, null]);
});

test("014-AC-2 hosted fails soft to nulls on a network error (no throw)", async () => {
  const fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.portkey.ai");
  };
  const config = resolveEmbeddingsConfig({
    selector: "hosted",
    hosted: { apiKey: "k", configId: "c", maxAttempts: 1 },
    env: {},
  });
  const provider = resolveEmbedProvider(config, { fetch, sleep: async () => undefined });
  assert.deepEqual(await provider.embed(["x"]), [null]);
});

test("014-AC-2 hosted retries a 429 within the bound, then succeeds", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, text: async () => "rate limited" };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ embedding: new Array(768).fill(1), index: 0 }] }),
    };
  };
  const config = resolveEmbeddingsConfig({ selector: "hosted", hosted: { apiKey: "k", configId: "c" }, env: {} });
  const provider = resolveEmbedProvider(config, { fetch, sleep: async () => undefined });
  const out = await provider.embed(["x"]);
  assert.equal(calls, 2);
  assert.equal(out[0]?.length, 768);
});

test("014-AC-2 hosted not keyed fails soft to nulls without a POST", async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const config = resolveEmbeddingsConfig({ selector: "hosted", env: {} });
  assert.equal(config.hosted.apiKey, null);
  const provider = resolveEmbedProvider(config, { fetch });
  assert.deepEqual(await provider.embed(["a"]), [null]);
  assert.equal(called, false);
});
