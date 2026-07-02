/**
 * The embeddings-provider module barrel (PRD-014).
 *
 * The single import surface for the switch and its providers. The Wave-2
 * integrator re-exports what it needs from the top-level `src/index.ts` and
 * wires `resolveEmbedProvider(resolveEmbeddingsConfig())` into the enricher /
 * brooding / recall seams (PRD-007 / 016 / 012 / 013). See the module report for
 * the exact wiring and the `src/portkey/headers.ts` duplication to unify.
 */
export {
  type EmbedProvider,
  type EmbedProviderSelector,
  type ResolveEmbedProviderDeps,
  createOffProvider,
  resolveEmbedProvider,
  DEFAULT_EMBED_PROVIDER,
} from "./provider.js";
export {
  type ResolvedEmbeddingsConfig,
  type EmbeddingsConfigOverrides,
  resolveEmbeddingsConfig,
  normalizeSelector,
} from "./config.js";
export {
  type DimRejection,
  type DimRejectionSink,
  guardVector,
  withDimGuard,
  stderrDimRejectionSink,
} from "./guard.js";
export {
  type LocalNomicConfig,
  type LocalNomicTransport,
  type LocalNomicHttpDeps,
  createLocalNomicHttpTransport,
  createLocalNomicProvider,
  DEFAULT_LOCAL_EMBED_HOST,
  DEFAULT_LOCAL_EMBED_PORT,
  DEFAULT_LOCAL_EMBED_TIMEOUT_MS,
} from "./local-nomic.js";
export {
  type HostedEmbeddingsConfig,
  type HostedPortkeyDeps,
  createHostedPortkeyProvider,
  parseEmbeddingsResponse,
  DEFAULT_HOSTED_EMBED_MODEL,
  DEFAULT_HOSTED_OUTPUT_DIMENSION,
  DEFAULT_HOSTED_MAX_ATTEMPTS,
  DEFAULT_HOSTED_RETRY_BACKOFF_MS,
  DEFAULT_HOSTED_REQUEST_TIMEOUT_MS,
  HOSTED_RETRYABLE_STATUSES,
} from "./hosted-portkey.js";
export {
  type FetchLike,
  type FetchResponseLike,
  type SleepFn,
  defaultFetch,
  defaultSleep,
} from "./http.js";
export {
  buildPortkeyHeaders,
  PORTKEY_BASE_URL,
  PORTKEY_EMBEDDINGS_URL,
  PORTKEY_API_KEY_HEADER,
  PORTKEY_CONFIG_HEADER,
} from "../portkey/headers.js";
