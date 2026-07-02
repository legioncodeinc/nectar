/**
 * Embeddings-provider config resolution (PRD-014a).
 *
 * Resolves the ONE embeddings switch (DECISION #5) plus each provider's
 * settings, with the daemon's precedence: explicit overrides -> environment ->
 * built-in defaults (mirrors `src/config.ts` and `src/portkey/config.ts`). The
 * selector is a three-value setting (`off | local | cohere`) that EXTENDS the
 * vault `embeddings.enabled` boolean rather than sitting beside a parallel enable
 * flag: a legacy truthy/falsey env value maps onto `local`/`off` so the switch is
 * a genuine superset of the old boolean. Never throws at import time.
 *
 * Env names follow the `HIVENECTAR_*` convention:
 *   - `HIVENECTAR_EMBEDDINGS_PROVIDER`          off | local | cohere (default local, AC-1)
 *   - `HIVENECTAR_EMBED_HOST` / `_PORT` / `_TIMEOUT_MS`   local nomic daemon transport
 *   - `HIVENECTAR_EMBEDDINGS_COHERE_MODEL`      Cohere embed model id (default embed-v4.0, decision #30)
 *   - `HIVENECTAR_EMBEDDINGS_OUTPUT_DIMENSION`  requested output dim (default 768, decision #30)
 *   - `HIVENECTAR_PORTKEY_API_KEY` / `_CONFIG`  the SAME gateway credentials the chat transport reads
 */
import {
  DEFAULT_COHERE_EMBED_MODEL,
  DEFAULT_COHERE_MAX_ATTEMPTS,
  DEFAULT_COHERE_OUTPUT_DIMENSION,
  DEFAULT_COHERE_REQUEST_TIMEOUT_MS,
  DEFAULT_COHERE_RETRY_BACKOFF_MS,
  type CohereEmbeddingsConfig,
} from "./cohere-portkey.js";
import {
  DEFAULT_LOCAL_EMBED_HOST,
  DEFAULT_LOCAL_EMBED_PORT,
  DEFAULT_LOCAL_EMBED_TIMEOUT_MS,
  type LocalNomicConfig,
} from "./local-nomic.js";
import { PORTKEY_EMBEDDINGS_URL } from "../portkey/headers.js";
import { DEFAULT_EMBED_PROVIDER, type EmbedProviderSelector } from "./provider.js";

/** The fully-resolved embeddings config the switch (`resolveEmbedProvider`) consumes. */
export interface ResolvedEmbeddingsConfig {
  readonly selector: EmbedProviderSelector;
  readonly local: LocalNomicConfig;
  readonly cohere: CohereEmbeddingsConfig;
}

/** Explicit overrides for {@link resolveEmbeddingsConfig} (each wins over env + defaults). */
export interface EmbeddingsConfigOverrides {
  readonly selector?: EmbedProviderSelector;
  readonly local?: Partial<LocalNomicConfig>;
  readonly cohere?: Partial<CohereEmbeddingsConfig>;
  /** Injectable env bag for tests; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

function envStr(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = envStr(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Normalize a raw selector value into an {@link EmbedProviderSelector}, or
 * `undefined` when it is unrecognized (so the caller falls back to the default).
 * Accepts the three canonical values AND the legacy boolean vocabulary the vault
 * `embeddings.enabled` key used (`true`/`1`/`on`/`yes` -> `local`,
 * `false`/`0`/`off`/`no` -> `off`) so the selector is a superset of the boolean.
 */
export function normalizeSelector(raw: string | undefined): EmbedProviderSelector | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "local" || v === "cohere") return v;
  if (v === "true" || v === "1" || v === "on" || v === "yes") return "local";
  if (v === "false" || v === "0" || v === "no") return "off";
  return undefined;
}

/**
 * Resolve the embeddings config. Overrides win, then env, then defaults. The
 * selector defaults to `local` (AC-1 / DECISION #5); the Cohere credentials
 * resolve to `null` when Portkey is not keyed (the cohere provider then fails
 * soft to nulls).
 */
export function resolveEmbeddingsConfig(overrides: EmbeddingsConfigOverrides = {}): ResolvedEmbeddingsConfig {
  const env = overrides.env ?? process.env;

  const selector =
    overrides.selector ?? normalizeSelector(env.HIVENECTAR_EMBEDDINGS_PROVIDER) ?? DEFAULT_EMBED_PROVIDER;

  const local: LocalNomicConfig = {
    host: overrides.local?.host ?? envStr(env, "HIVENECTAR_EMBED_HOST") ?? DEFAULT_LOCAL_EMBED_HOST,
    port: overrides.local?.port ?? envInt(env, "HIVENECTAR_EMBED_PORT") ?? DEFAULT_LOCAL_EMBED_PORT,
    requestTimeoutMs:
      overrides.local?.requestTimeoutMs ??
      envInt(env, "HIVENECTAR_EMBED_TIMEOUT_MS") ??
      DEFAULT_LOCAL_EMBED_TIMEOUT_MS,
  };

  const cohere: CohereEmbeddingsConfig = {
    model: overrides.cohere?.model ?? envStr(env, "HIVENECTAR_EMBEDDINGS_COHERE_MODEL") ?? DEFAULT_COHERE_EMBED_MODEL,
    outputDimension:
      overrides.cohere?.outputDimension ??
      envInt(env, "HIVENECTAR_EMBEDDINGS_OUTPUT_DIMENSION") ??
      DEFAULT_COHERE_OUTPUT_DIMENSION,
    apiKey: overrides.cohere?.apiKey ?? envStr(env, "HIVENECTAR_PORTKEY_API_KEY") ?? null,
    configId: overrides.cohere?.configId ?? envStr(env, "HIVENECTAR_PORTKEY_CONFIG") ?? null,
    url: overrides.cohere?.url ?? PORTKEY_EMBEDDINGS_URL,
    maxAttempts: overrides.cohere?.maxAttempts ?? DEFAULT_COHERE_MAX_ATTEMPTS,
    retryBackoffMs: overrides.cohere?.retryBackoffMs ?? DEFAULT_COHERE_RETRY_BACKOFF_MS,
    requestTimeoutMs: overrides.cohere?.requestTimeoutMs ?? DEFAULT_COHERE_REQUEST_TIMEOUT_MS,
  };

  return { selector, local, cohere };
}
