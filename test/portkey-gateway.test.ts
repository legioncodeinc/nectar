/**
 * Portkey gateway module tests (PRD-010).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPortkeyHeaders,
  PORTKEY_BASE_URL,
  PORTKEY_CHAT_COMPLETIONS_URL,
  PORTKEY_API_KEY_HEADER,
  PORTKEY_CONFIG_HEADER,
} from "../dist/portkey/headers.js";
import {
  DEFAULT_ACTIVE_MODEL,
  PORTKEY_CONFIG_SURFACE_KEYS,
  resolvePortkeyConfig,
} from "../dist/portkey/config.js";
import {
  buildDescribeModelStamp,
  isSkippedDescribeStatus,
  resetForRedescribe,
} from "../dist/portkey/describe-model.js";
import {
  describeViaPortkey,
  PortkeyTransportError,
  PORTKEY_MAX_ATTEMPTS,
  PORTKEY_REQUEST_TIMEOUT_MS,
  PORTKEY_BATCH_REQUEST_TIMEOUT_MS,
} from "../dist/portkey/transport.js";
import type { PortkeyFetch } from "../dist/portkey/transport.js";

const ENABLED = {
  enabled: true as const,
  apiKey: "pk-test-secret",
  configId: "pcfg-test",
  activeModel: DEFAULT_ACTIVE_MODEL,
};

// ── AC-1: exact URL + both headers on the wire ─────────────────────────────

test("010-AC-1 posts chat completions URL with portkey auth headers", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const fetch: PortkeyFetch = async (url, init) => {
    seenUrl = url;
    seenHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    };
  };

  await describeViaPortkey(
    { messages: [{ role: "user", content: "describe this file" }] },
    { portkey: ENABLED, fetch },
  );

  assert.equal(seenUrl, PORTKEY_CHAT_COMPLETIONS_URL);
  assert.equal(seenUrl, `${PORTKEY_BASE_URL}/chat/completions`);
  assert.equal(seenHeaders[PORTKEY_API_KEY_HEADER], "pk-test-secret");
  assert.equal(seenHeaders[PORTKEY_CONFIG_HEADER], "pcfg-test");
  assert.equal(seenHeaders["content-type"], "application/json");
  assert.deepEqual(buildPortkeyHeaders("pk-test-secret", "pcfg-test"), seenHeaders);
});

test("010-AC-1 buildPortkeyHeaders never echoes the key in returned object keys beyond the header slot", () => {
  const headers = buildPortkeyHeaders("super-secret-key", "cfg-1");
  assert.equal(Object.keys(headers).length, 3);
  assert.equal(headers[PORTKEY_API_KEY_HEADER], "super-secret-key");
});

// ── AC-2: model resolves to gemini-2.5-flash when unset; override wins ───────

test("010-AC-2 default model is gemini-2.5-flash when unset", async () => {
  let body = "";
  const fetch: PortkeyFetch = async (_url, init) => {
    body = init.body;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    };
  };

  await describeViaPortkey(
    { messages: [{ role: "user", content: "x" }] },
    { portkey: { ...ENABLED, activeModel: DEFAULT_ACTIVE_MODEL }, fetch },
  );

  assert.equal(JSON.parse(body).model, "gemini-2.5-flash");

  const cfg = resolvePortkeyConfig({ enabled: true, apiKey: "k", configId: "c" });
  assert.equal(cfg.enabled, true);
  if (cfg.enabled) assert.equal(cfg.activeModel, DEFAULT_ACTIVE_MODEL);
});

test("010-AC-2 explicit model override wins over activeModel", async () => {
  let body = "";
  const fetch: PortkeyFetch = async (_url, init) => {
    body = init.body;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    };
  };

  const result = await describeViaPortkey(
    { messages: [{ role: "user", content: "x" }], model: "claude-haiku-4-5" },
    { portkey: ENABLED, fetch },
  );

  assert.equal(JSON.parse(body).model, "claude-haiku-4-5");
  assert.equal(result.model, "claude-haiku-4-5");
});

// ── AC-3: resetForRedescribe + re-describe stamp carries new model ───────────

test("010-AC-3 resetForRedescribe resets every non-skipped row to pending", () => {
  const rows = [
    { nectar: "n1", contentHash: "h1", describeStatus: "described" as const },
    { nectar: "n2", contentHash: "h2", describeStatus: "pending" as const },
    { nectar: "n3", contentHash: "h3", describeStatus: "failed" as const },
    { nectar: "n4", contentHash: "h4", describeStatus: "skipped-binary" as const },
    { nectar: "n5", contentHash: "h5", describeStatus: "skipped-too-large" as const },
    { nectar: "n6", contentHash: "h6", describeStatus: "skipped-deleted" as const },
  ];

  const resets = resetForRedescribe(rows);
  assert.equal(resets.length, 3);
  assert.deepEqual(
    resets.map((r) => r.nectar).sort(),
    ["n1", "n2", "n3"],
  );
  for (const reset of resets) {
    assert.equal(reset.describeStatus, "pending");
  }
  assert.ok(isSkippedDescribeStatus("skipped-binary"));
  assert.ok(!isSkippedDescribeStatus("described"));
});

test("010-AC-3 re-describe stamp carries the new model id", () => {
  const stamp = buildDescribeModelStamp(
    { title: "Auth", description: "Handles login.", concepts: '["auth"]' },
    "gpt-4.1",
    "2026-07-02T12:00:00.000Z",
  );
  assert.equal(stamp.describeModel, "gpt-4.1");
  assert.equal(stamp.describeStatus, "described");
  assert.equal(stamp.describedAt, "2026-07-02T12:00:00.000Z");
});

// ── AC-4: stamp writes describe_model ───────────────────────────────────────

test("010-AC-4 buildDescribeModelStamp sets describeModel on described rows", () => {
  const stamp = buildDescribeModelStamp(
    { title: "Worker", description: "Poll loop.", concepts: "[]" },
    DEFAULT_ACTIVE_MODEL,
    "2026-07-02T00:00:00.000Z",
  );
  assert.equal(stamp.describeModel, "gemini-2.5-flash");
  assert.equal(stamp.describeStatus, "described");
  assert.equal(stamp.title, "Worker");
});

// ── AC-5: no cache/guardrail toggle on config surface ───────────────────────

test("010-AC-5 config surface has no cache or guardrail toggle keys", () => {
  const surface = new Set(PORTKEY_CONFIG_SURFACE_KEYS);
  assert.ok(!surface.has("cacheEnabled" as never));
  assert.ok(!surface.has("cache" as never));
  assert.ok(!surface.has("guardrails" as never));
  assert.ok(!surface.has("portkeyCache" as never));

  const disabled = resolvePortkeyConfig({ enabled: false });
  assert.equal(disabled.enabled, false);

  const missingKey = resolvePortkeyConfig({ enabled: true, configId: "cfg" });
  assert.equal(missingKey.enabled, false);
  if (!missingKey.enabled) assert.equal(missingKey.reason, "missing_api_key");
});

// ── transport extras: retry, usage, errors ──────────────────────────────────

test("010 transport retries on 429 then succeeds", async () => {
  let calls = 0;
  const fetch: PortkeyFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, text: async () => "rate limited" };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "after retry" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
    };
  };

  const result = await describeViaPortkey(
    { messages: [{ role: "user", content: "x" }] },
    { portkey: ENABLED, fetch, sleep: async () => undefined },
  );

  assert.equal(calls, 2);
  assert.equal(result.content, "after retry");
  assert.equal(result.usage.cacheReadInputTokens, 40);
});

test("010 transport error message never contains the api key", async () => {
  const fetch: PortkeyFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: "pk-test-secret leaked" }),
  });

  await assert.rejects(
    () =>
      describeViaPortkey(
        { messages: [{ role: "user", content: "x" }] },
        { portkey: ENABLED, fetch, maxAttempts: 1 },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PortkeyTransportError);
      assert.equal(err.statusCode, 401);
      assert.equal(err.message, "portkey transport: gateway returned status 401");
      assert.ok(!err.message.includes("pk-test-secret"));
      return true;
    },
  );
});

// ── NEC-013 / AC-018f.2-4: finish_reason surfacing, maxTokens passthrough, batch timeout ──

test("018f-AC-3 finish_reason is surfaced from the gateway response (length = truncated)", async () => {
  const fetch: PortkeyFetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: "partial" }, finish_reason: "length" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
  });
  const result = await describeViaPortkey({ messages: [{ role: "user", content: "x" }] }, { portkey: ENABLED, fetch });
  assert.equal(result.finishReason, "length");
});

test("018f-AC-3 finish_reason is null when the gateway omits it", async () => {
  const fetch: PortkeyFetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
  });
  const result = await describeViaPortkey({ messages: [{ role: "user", content: "x" }] }, { portkey: ENABLED, fetch });
  assert.equal(result.finishReason, null);
});

test("018f-AC-2 an explicit maxTokens is sent as max_tokens on the wire", async () => {
  let body = "";
  const fetch: PortkeyFetch = async (_url, init) => {
    body = init.body;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  };
  await describeViaPortkey(
    { messages: [{ role: "user", content: "x" }], maxTokens: 9000 },
    { portkey: ENABLED, fetch },
  );
  assert.equal(JSON.parse(body).max_tokens, 9000);
});

test("018f-AC-4 the batch timeout is raised above the solo default, and a per-request timeoutMs overrides it", async () => {
  assert.ok(
    PORTKEY_BATCH_REQUEST_TIMEOUT_MS > PORTKEY_REQUEST_TIMEOUT_MS,
    "the batch call timeout is raised above the solo default",
  );

  let aborted = false;
  const fetch: PortkeyFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  await assert.rejects(() =>
    describeViaPortkey(
      { messages: [{ role: "user", content: "x" }], timeoutMs: 20 },
      { portkey: ENABLED, fetch, maxAttempts: 1 },
    ),
  );
  assert.ok(aborted, "the request-level timeoutMs value (not the solo default) aborted the attempt");
});

test("010 transport exhausts bounded retries on persistent 503", async () => {
  let calls = 0;
  const fetch: PortkeyFetch = async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => "unavailable" };
  };

  await assert.rejects(
    () =>
      describeViaPortkey(
        { messages: [{ role: "user", content: "x" }] },
        { portkey: ENABLED, fetch, sleep: async () => undefined },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PortkeyTransportError);
      assert.equal(err.statusCode, 503);
      return true;
    },
  );
  assert.equal(calls, PORTKEY_MAX_ATTEMPTS);
});
