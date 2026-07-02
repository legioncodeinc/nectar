/**
 * Portkey gateway request headers and endpoint constants (PRD-010a).
 *
 * Mirrors honeycomb's shared header builder and base URL so nectar reaches
 * the same gateway wire shape without importing honeycomb in-process (ADR-0002).
 * Canonical reference: `honeycomb/src/daemon/runtime/inference/transport-portkey.ts`
 * (`PORTKEY_BASE_URL`, `PORTKEY_CHAT_COMPLETIONS_URL`, `buildPortkeyHeaders`).
 */

/** The Portkey gateway base host. Confirmed vs Portkey docs at honeycomb build time. */
export const PORTKEY_BASE_URL = "https://api.portkey.ai/v1" as const;

/** The Portkey OpenAI-compatible chat-completions endpoint. */
export const PORTKEY_CHAT_COMPLETIONS_URL = `${PORTKEY_BASE_URL}/chat/completions` as const;

/**
 * The Portkey OpenAI-compatible embeddings endpoint (decision #30 / PRD-014b).
 * The chat, rerank, and embeddings transports all hang off {@link PORTKEY_BASE_URL};
 * the ONE difference from the chat path is `/embeddings` vs `/chat/completions`.
 * The Cohere-via-Portkey embed transport (`src/embeddings/cohere-portkey.ts`)
 * posts here. Confirm the live gateway still advertises this path before first
 * opt-in use (the decision doc flags it as a mechanical check).
 */
export const PORTKEY_EMBEDDINGS_URL = `${PORTKEY_BASE_URL}/embeddings` as const;

/** Header carrying the resolved Portkey API key (never logged or echoed). */
export const PORTKEY_API_KEY_HEADER = "x-portkey-api-key" as const;

/** Header carrying the `portkey.config` / virtual-key id (non-secret). */
export const PORTKEY_CONFIG_HEADER = "x-portkey-config" as const;

/**
 * Build the Portkey request headers shared by chat and future rerank/embed transports.
 * `apiKey` is placed ONLY in the auth header; `configId` is the non-secret config id.
 */
export function buildPortkeyHeaders(apiKey: string, configId: string): Record<string, string> {
  return {
    [PORTKEY_API_KEY_HEADER]: apiKey,
    [PORTKEY_CONFIG_HEADER]: configId,
    "content-type": "application/json",
  };
}
