# PRD-010a: Portkey transport reuse

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S (1-3h)
> **Schema changes:** None

---

## Overview

The transport that carries Hivenectar's brooding batch calls and enricher solo calls to the gateway already ships in Honeycomb. This sub-PRD reuses it verbatim rather than authoring a second Portkey transport: the `buildPortkeyHeaders(apiKey, configId)` helper, the `PORTKEY_BASE_URL` host (`https://api.portkey.ai/v1`), and the `/v1/chat/completions` endpoint. Hivenectar contributes no new transport code to the gateway path; it consumes the same `ProviderTransport` the pollinating loop already uses.

---

## Goals

- Every brooding/enricher description call POSTs the OpenAI-shaped chat-completions body to `PORTKEY_CHAT_COMPLETIONS_URL` (`https://api.portkey.ai/v1/chat/completions`) with headers from the shared `buildPortkeyHeaders`.
- The transport's secret-discipline invariant holds: the resolved Portkey key lives only in the `x-portkey-api-key` header, never in a log, thrown message, or returned value.
- The usage seam (the `UsageSink` the transport already feeds) records token usage — including upstream cached tokens when Portkey reports them — so cost accounting continues under the gateway.

## Non-Goals

- A Hivenectar-authored Portkey transport. The existing `createPortkeyTransport` is reused (DECISION: reuse, not fork).
- Streaming. The brooding/enricher path consumes whole completions; the transport's `stream` thin wrapper is inherited unchanged and out of scope here.
- Retry/backoff logic. The enricher delegates retry to Portkey's built-in rate-limit handling (`ai/enricher-and-llm-model.md` § Debouncing and rate limiting); Hivenectar implements no client-side retry.

---

## User stories

### US-010a.1 — Route a brooding batch through Portkey

**As a** brooding operator, **I want to** the batch of 30–50 file contents to reach Gemini 2.5 Flash through the Portkey gateway, **so that** the call carries the configured guardrails, cache, and fallback rather than hitting the provider directly.

**Acceptance criteria:**
- AC-010a.1.1 Given Portkey is enabled + `portkey.config` is present, when the brooding batch call runs, then it POSTs to `PORTKEY_CHAT_COMPLETIONS_URL` with headers from `buildPortkeyHeaders(resolvedKey, configId)`.
- AC-010a.1.2 Given the batch body, then the transport maps the internal OpenAI-chat request verbatim (no role hoisting) via the existing `toPortkeyBody` mapping, with `model` = the call's target model and `max_tokens` always sent.
- AC-010a.1.3 Given a network/transport failure, then the transport throws a `ProviderError` with `statusCode: 503` (status string only, never the body or key).

### US-010a.2 — Never log or surface the key

**As a** security reviewer, **I want to** the resolved Portkey key to appear only in the `x-portkey-api-key` header, **so that** no credential leaks through logs, error messages, or usage reports.

**Acceptance criteria:**
- AC-010a.2.1 Given any failure path, then the thrown/returned error carries a short status string only — never the response body (which could echo a credential) and never the key.

---

## Implementation notes

- **Reuse, do not fork.** The transport lives at `honeycomb/src/daemon/runtime/inference/transport-portkey.ts`:
  - `PORTKEY_BASE_URL = "https://api.portkey.ai/v1"` (`transport-portkey.ts:74`).
  - `PORTKEY_CHAT_COMPLETIONS_URL = ".../chat/completions"` (`transport-portkey.ts:77`).
  - `buildPortkeyHeaders(apiKey, configId)` builds the `{x-portkey-api-key, x-portkey-config, content-type}` object (`transport-portkey.ts:95-101`).
  - `toPortkeyBody(call, defaultMaxTokens)` maps the internal OpenAI-chat request onto the chat-completions body, sending `model`, `max_tokens`, and the verbatim messages (`transport-portkey.ts:192-202`).
- **Model is the call's target model.** `toPortkeyBody` sends `call.target.model` as `model` (`transport-portkey.ts:198`) — the factory builds the Portkey config with `model` = the vault `activeModel` (D-2, `model-client-factory.ts:97-98`, `:404-406`). PRD-010b owns the default-model resolution.
- **Error mapping.** On a non-2xx response the transport throws a `ProviderError` carrying the HTTP `statusCode`; a network failure maps to `503` (`transport-portkey.ts:256-263`). The thrown message is a status string, never the body or the key (`transport-portkey.ts:34-36`).
- **Usage accounting.** The transport feeds the `UsageSink` on the success path, mapping `prompt_tokens → inputTokens`, `completion_tokens → outputTokens`, and `prompt_tokens_details.cached_tokens → cacheReadInputTokens` (`transport-portkey.ts:271-279`). A missing/malformed `usage` surfaces zero counts rather than throwing (`transport-portkey.ts:277-278`). This is the seam that accounts for upstream cached tokens; it does not enable caching.

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Portkey endpoint: `https://api.portkey.ai/v1/chat/completions` (`PORTKEY_CHAT_COMPLETIONS_URL`, `transport-portkey.ts:77`). Confirmed against the Portkey API reference at Honeycomb build time; confirm the gateway still advertises this path before implementation.

---

## Related

- [`./prd-010-portkey-gateway-index.md`](./prd-010-portkey-gateway-index.md)
- [`./prd-010b-model-selection-and-describe-model.md`](./prd-010b-model-selection-and-describe-model.md) — owns the default model + the `describe_model` audit.
- [`./prd-010c-semantic-cache-and-guardrails.md`](./prd-010c-semantic-cache-and-guardrails.md) — owns the server-side cache/guardrails story.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — Portkey routing + `describe_model`.
