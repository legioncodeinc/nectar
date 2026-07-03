/**
 * Embeddings-provider config resolution (PRD-014a).
 *
 * Resolves the ONE embeddings switch (DECISION #5) plus each provider's
 * settings, with the daemon's precedence: explicit overrides -> environment ->
 * built-in defaults (mirrors `src/config.ts` and `src/portkey/config.ts`). The
 * selector is a three-value setting (`off | local | hosted`) that EXTENDS the
 * vault `embeddings.enabled` boolean rather than sitting beside a parallel enable
 * flag: a legacy truthy/falsey env value maps onto `local`/`off` so the switch is
 * a genuine superset of the old boolean. Never throws at import time.
 *
 * Env names follow the `NECTAR_*` convention:
 *   - `NECTAR_EMBEDDINGS_PROVIDER`          off | local | hosted (default local, AC-1)
 *   - `NECTAR_EMBED_HOST` / `_PORT` / `_TIMEOUT_MS`   local nomic daemon transport
 *   - `NECTAR_EMBEDDINGS_HOSTED_MODEL`      hosted embed model id (default text-embedding-3-small, decision #30 as amended)
 *   - `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION`  requested output dim (default 768, decision #30)
 *   - `NECTAR_PORTKEY_API_KEY` / `_CONFIG`  the SAME gateway credentials the chat transport reads
 */
import {
  DEFAULT_HOSTED_EMBED_MODEL,
  DEFAULT_HOSTED_MAX_ATTEMPTS,
  DEFAULT_HOSTED_OUTPUT_DIMENSION,
  DEFAULT_HOSTED_REQUEST_TIMEOUT_MS,
  DEFAULT_HOSTED_RETRY_BACKOFF_MS,
  type HostedEmbeddingsConfig,
} from "./hosted-portkey.js";
import {
  DEFAULT_LOCAL_EMBED_HOST,
  DEFAULT_LOCAL_EMBED_PORT,
  DEFAULT_LOCAL_EMBED_TIMEOUT_MS,
  LOCAL_NOMIC_MODEL_ID,
  type LocalNomicConfig,
} from "./local-nomic.js";
import { PORTKEY_EMBEDDINGS_URL } from "../portkey/headers.js";
import { EMBED_DIMS } from "../hive-graph/model.js";
import { DEFAULT_EMBED_PROVIDER, type EmbedProviderSelector } from "./provider.js";

/** The fully-resolved embeddings config the switch (`resolveEmbedProvider`) consumes. */
export interface ResolvedEmbeddingsConfig {
  readonly selector: EmbedProviderSelector;
  readonly local: LocalNomicConfig;
  readonly hosted: HostedEmbeddingsConfig;
}

/** Explicit overrides for {@link resolveEmbeddingsConfig} (each wins over env + defaults). */
export interface EmbeddingsConfigOverrides {
  readonly selector?: EmbedProviderSelector;
  readonly local?: Partial<LocalNomicConfig>;
  readonly hosted?: Partial<HostedEmbeddingsConfig>;
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
  if (v === "off" || v === "local" || v === "hosted") return v;
  if (v === "true" || v === "1" || v === "on" || v === "yes") return "local";
  if (v === "false" || v === "0" || v === "no") return "off";
  return undefined;
}

/**
 * Resolve the embeddings config. Overrides win, then env, then defaults. The
 * selector defaults to `local` (AC-1 / DECISION #5); the hosted credentials
 * resolve to `null` when Portkey is not keyed (the hosted provider then fails
 * soft to nulls).
 */
export function resolveEmbeddingsConfig(overrides: EmbeddingsConfigOverrides = {}): ResolvedEmbeddingsConfig {
  const env = overrides.env ?? process.env;

  const selector =
    overrides.selector ?? normalizeSelector(env.NECTAR_EMBEDDINGS_PROVIDER) ?? DEFAULT_EMBED_PROVIDER;

  const local: LocalNomicConfig = {
    host: overrides.local?.host ?? envStr(env, "NECTAR_EMBED_HOST") ?? DEFAULT_LOCAL_EMBED_HOST,
    port: overrides.local?.port ?? envInt(env, "NECTAR_EMBED_PORT") ?? DEFAULT_LOCAL_EMBED_PORT,
    requestTimeoutMs:
      overrides.local?.requestTimeoutMs ??
      envInt(env, "NECTAR_EMBED_TIMEOUT_MS") ??
      DEFAULT_LOCAL_EMBED_TIMEOUT_MS,
  };

  const hosted: HostedEmbeddingsConfig = {
    model: overrides.hosted?.model ?? envStr(env, "NECTAR_EMBEDDINGS_HOSTED_MODEL") ?? DEFAULT_HOSTED_EMBED_MODEL,
    outputDimension:
      overrides.hosted?.outputDimension ??
      envInt(env, "NECTAR_EMBEDDINGS_OUTPUT_DIMENSION") ??
      DEFAULT_HOSTED_OUTPUT_DIMENSION,
    apiKey: overrides.hosted?.apiKey ?? envStr(env, "NECTAR_PORTKEY_API_KEY") ?? null,
    configId: overrides.hosted?.configId ?? envStr(env, "NECTAR_PORTKEY_CONFIG") ?? null,
    url: overrides.hosted?.url ?? PORTKEY_EMBEDDINGS_URL,
    maxAttempts: overrides.hosted?.maxAttempts ?? DEFAULT_HOSTED_MAX_ATTEMPTS,
    retryBackoffMs: overrides.hosted?.retryBackoffMs ?? DEFAULT_HOSTED_RETRY_BACKOFF_MS,
    requestTimeoutMs: overrides.hosted?.requestTimeoutMs ?? DEFAULT_HOSTED_REQUEST_TIMEOUT_MS,
  };

  return { selector, local, hosted };
}

/**
 * The model id that produces embeddings under a resolved config, for stamping
 * `embed_model` on persisted rows (PRD-018i / NEC-018 AC-018i.1):
 *   - `off`    -> `null` (no embeddings are computed)
 *   - `local`  -> the pinned {@link LOCAL_NOMIC_MODEL_ID}
 *   - `hosted` -> the configured hosted model id
 */
export function activeEmbedModelId(config: ResolvedEmbeddingsConfig): string | null {
  switch (config.selector) {
    case "off":
      return null;
    case "local":
      return LOCAL_NOMIC_MODEL_ID;
    case "hosted":
      return config.hosted.model;
    default: {
      const unreachable: never = config.selector;
      return unreachable;
    }
  }
}

/** The outcome of validating the requested hosted output dimension (PRD-018i / NEC-028 AC-018i.7). */
export interface EmbedDimensionValidation {
  readonly ok: boolean;
  readonly requested: number;
  readonly expected: number;
  readonly message?: string;
}

/**
 * Validate that a hosted output dimension matches the fixed {@link EMBED_DIMS}
 * contract (PRD-018i / NEC-028 AC-018i.7). Any other value is pointless: the
 * `FLOAT4[768]` column and the dim guard reject it, silently nulling every
 * hosted vector. The caller warns loudly or refuses to start on `ok === false`.
 * `off`/`local` selectors do not carry a requested dimension and always pass.
 */
export function validateEmbedDimension(config: ResolvedEmbeddingsConfig): EmbedDimensionValidation {
  if (config.selector !== "hosted") {
    return { ok: true, requested: EMBED_DIMS, expected: EMBED_DIMS };
  }
  const requested = config.hosted.outputDimension;
  if (requested === EMBED_DIMS) {
    return { ok: true, requested, expected: EMBED_DIMS };
  }
  return {
    ok: false,
    requested,
    expected: EMBED_DIMS,
    message:
      `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION=${requested} does not match the fixed ${EMBED_DIMS}-dim ` +
      `embedding contract (FLOAT4[${EMBED_DIMS}]); every hosted vector would be guard-discarded to null ` +
      `and semantic recall would be permanently lexical-only. Set it to ${EMBED_DIMS} or unset it.`,
  };
}
