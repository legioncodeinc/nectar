/**
 * The hosted-via-Portkey embeddings transport (PRD-014b — the operator opt-in).
 *
 * Modeled on honeycomb's shipped Cohere-rerank-via-Portkey transport
 * (`honeycomb/src/daemon/runtime/recall/rerank-portkey.ts`): it reuses the SAME
 * `x-portkey-api-key` + `x-portkey-config` auth pair (via
 * {@link buildPortkeyHeaders}) and the SAME gateway host; the ONE difference is
 * the path — `/v1/embeddings` ({@link PORTKEY_EMBEDDINGS_URL}) instead of
 * `/v1/rerank` — and the request/response shape.
 *
 * ── Model + dimension are config, not hardcoded (decision #30 as amended) ────
 * The opt-in targets OpenAI `text-embedding-3-small` with `dimensions: 768` so
 * it produces contract-valid 768-dim vectors with no client-side math. Both the
 * model id and the dimension are config values
 * ({@link HostedEmbeddingsConfig}); recall's 768-dim guard (`guard.ts`) stays as
 * the backstop for whatever the gateway actually returns.
 *
 * ── Fail-soft is the cardinal rule (AC-4 / US-014b.3) ────────────────────────
 * EVERY failure path — Portkey not keyed, a network/transport error, a non-2xx
 * gateway status, or a malformed body — resolves to `null` for the affected
 * texts, NEVER a throw into the caller's hot path. A bounded retry covers 429 +
 * transient 5xx (the same statuses the sibling chat transport retries); the
 * bound is exhausted to nulls rather than thrown.
 *
 * ── The secret-never-logged invariant (US-014b.3) ────────────────────────────
 * The resolved key is placed ONLY in the `x-portkey-api-key` header (via
 * {@link buildPortkeyHeaders}) and is NEVER included in a returned value, a log
 * line, or an error. On any failure the response body is not read into a message
 * (it could echo a credential).
 */
import { buildPortkeyHeaders, PORTKEY_EMBEDDINGS_URL } from "../portkey/headers.js";
import { defaultFetch, defaultSleep, type FetchLike, type SleepFn } from "./http.js";
import type { EmbedProvider } from "./provider.js";

/**
 * SIGNED OFF 2026-07-02 (decision #30 AS AMENDED, PM): the hosted embed model
 * the opt-in targets. OpenAI `text-embedding-3-small` natively supports a 768
 * `dimensions` request, so the opt-in produces contract-valid vectors with no
 * client-side math. (The original #30 pick, Cohere embed-v4.0, accepts only
 * [256, 512, 1024, 1536] and was amended away; it stays reachable by config
 * for an operator whose gateway maps dimensions, with the guard as backstop.)
 * Config-overridable.
 */
export const DEFAULT_HOSTED_EMBED_MODEL = "text-embedding-3-small" as const;

/**
 * SIGNED OFF 2026-07-02 (decision #30 as amended): the requested output
 * dimension. 768 keeps the opt-in on the fixed 768-dim contract; the guard
 * discards anything else. Config-overridable.
 */
export const DEFAULT_HOSTED_OUTPUT_DIMENSION = 768 as const;

/** HTTP statuses that trigger a bounded retry (429 rate limit + transient 5xx), matching the chat transport. */
export const HOSTED_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Maximum attempts including the first POST (mirrors `src/portkey/transport.ts`'s `PORTKEY_MAX_ATTEMPTS`). */
export const DEFAULT_HOSTED_MAX_ATTEMPTS = 3 as const;

/** Backoff between retryable failures in ms (mirrors `src/portkey/transport.ts`'s backoff). */
export const DEFAULT_HOSTED_RETRY_BACKOFF_MS = 250 as const;

/**
 * Per-attempt request timeout (ms), mirroring `deeplake-transport.ts`'s
 * `DEFAULT_TRANSPORT_TIMEOUT_MS` AbortController pattern: an unresponsive gateway
 * aborts rather than hanging the embed path indefinitely (fail-soft, AC-4).
 */
export const DEFAULT_HOSTED_REQUEST_TIMEOUT_MS = 15_000 as const;

/** The resolved hosted-via-Portkey config. `apiKey`/`configId` are `null` when Portkey is not keyed. */
export interface HostedEmbeddingsConfig {
  /** The hosted embed model id (default {@link DEFAULT_HOSTED_EMBED_MODEL}). Config-overridable (AC-2). */
  readonly model: string;
  /** The requested output dimension (default {@link DEFAULT_HOSTED_OUTPUT_DIMENSION}). Config-overridable (AC-2). */
  readonly outputDimension: number;
  /** The resolved Portkey API key, or `null` when unkeyed (then embed fails soft to nulls). */
  readonly apiKey: string | null;
  /** The `portkey.config` / virtual-key id, or `null` when unset. */
  readonly configId: string | null;
  /** The endpoint URL (default {@link PORTKEY_EMBEDDINGS_URL}); overridable for a fake-fetch test. */
  readonly url: string;
  /** Max attempts including the first POST. */
  readonly maxAttempts: number;
  /** Backoff between retryable failures (ms). */
  readonly retryBackoffMs: number;
  /** Per-attempt request timeout (ms) before the attempt aborts (default {@link DEFAULT_HOSTED_REQUEST_TIMEOUT_MS}). */
  readonly requestTimeoutMs: number;
}

/** Construction deps for {@link createHostedPortkeyProvider}; fetch + sleep are injectable for tests. */
export interface HostedPortkeyDeps {
  /** The `fetch` implementation; defaults to `globalThis.fetch`. Tests inject a fake (no network). */
  readonly fetch?: FetchLike;
  /** The backoff sleep; a test passes a no-op so retry paths run without real time. */
  readonly sleep?: SleepFn;
}

/** All-nulls result of length `n` (the fail-soft shape, built in one place). */
function allNull(n: number): (number[] | null)[] {
  return new Array<number[] | null>(n).fill(null);
}

/**
 * Parse the embeddings response into one vector (or `null`) per input index,
 * defensively. Primary shape is Portkey's OpenAI-compatible
 * `{ data: [{ embedding: number[], index }] }`; a Cohere-native
 * `{ embeddings: number[][] }` or `{ embeddings: { float: number[][] } }` body is
 * tolerated as a fallback. Anything else yields all-nulls. Never throws. The
 * per-vector dimension is NOT checked here — the guard owns that (AC-3).
 */
export function parseEmbeddingsResponse(raw: string, count: number): (number[] | null)[] {
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return allNull(count);
  }
  if (typeof body !== "object" || body === null) return allNull(count);

  const out = allNull(count);
  const asFinite = (v: unknown): number[] | null =>
    Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? (v as number[]) : null;

  // Primary: OpenAI-compatible `data: [{ embedding, index }]`.
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    data.forEach((entry, i) => {
      if (typeof entry !== "object" || entry === null) return;
      const e = entry as { embedding?: unknown; index?: unknown };
      const idx = typeof e.index === "number" && Number.isInteger(e.index) ? e.index : i;
      if (idx < 0 || idx >= count) return;
      out[idx] = asFinite(e.embedding);
    });
    return out;
  }

  // Fallback: Cohere-native `embeddings: number[][]` or `embeddings: { float: number[][] }`.
  const embeddings = (body as { embeddings?: unknown }).embeddings;
  const rows = Array.isArray(embeddings)
    ? embeddings
    : typeof embeddings === "object" && embeddings !== null && Array.isArray((embeddings as { float?: unknown }).float)
      ? ((embeddings as { float: unknown[] }).float)
      : null;
  if (rows !== null) {
    rows.forEach((row, i) => {
      if (i < count) out[i] = asFinite(row);
    });
    return out;
  }

  return allNull(count);
}

/**
 * Build the hosted-via-Portkey embeddings {@link EmbedProvider} (PRD-014b). A
 * batch is sent as ONE POST reusing the rerank transport's auth pattern; the body
 * carries the config model id + `dimensions` (AC-2). Every failure resolves
 * to nulls for the batch (fail-soft, AC-4); the key is never logged or thrown.
 */
export function createHostedPortkeyProvider(
  config: HostedEmbeddingsConfig,
  deps: HostedPortkeyDeps = {},
): EmbedProvider {
  const doFetch = deps.fetch ?? defaultFetch();
  const sleep = deps.sleep ?? defaultSleep;

  return {
    kind: "hosted",
    async embed(texts: readonly string[]): Promise<(number[] | null)[]> {
      if (texts.length === 0) return [];
      // Not keyed -> fail soft to nulls (no POST). A missing key is a misconfiguration, not a crash (AC-4).
      if (config.apiKey === null || config.configId === null) return allNull(texts.length);

      const headers = buildPortkeyHeaders(config.apiKey, config.configId);
      // The embeddings body (decision #30 as amended): the config model id + the
      // OpenAI-compatible `dimensions` field (Portkey's unified API maps it to the
      // provider's own parameter, e.g. Cohere's `output_dimension`), both overridable (AC-2).
      const body = JSON.stringify({
        model: config.model,
        input: [...texts],
        dimensions: config.outputDimension,
      });

      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        let res;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
        try {
          res = await doFetch(config.url, { method: "POST", headers, body, signal: controller.signal });
        } catch {
          // Network/transport failure, or our own abort on `requestTimeoutMs` (an unresponsive
          // gateway) -> retry within the bound, else fail soft to nulls. Never surface the error
          // (it could carry a body/key); only the fail-soft nulls escape.
          if (attempt < config.maxAttempts) {
            await sleep(config.retryBackoffMs * attempt);
            continue;
          }
          return allNull(texts.length);
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          // A non-2xx gateway status: retry the retryable ones within the bound, else fail soft. Never
          // read the body into a message (it could echo a credential).
          if (attempt < config.maxAttempts && HOSTED_RETRYABLE_STATUSES.has(res.status)) {
            await sleep(config.retryBackoffMs * attempt);
            continue;
          }
          return allNull(texts.length);
        }
        // A 2xx: parse defensively. A malformed body fails soft to nulls (the gateway was reachable,
        // the body was just unusable) rather than throwing.
        const text = await res.text().catch(() => "");
        return parseEmbeddingsResponse(text, texts.length);
      }
      return allNull(texts.length);
    },
  };
}
