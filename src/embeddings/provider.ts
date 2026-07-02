/**
 * The embedding provider strategy switch (PRD-014a / DECISION #5).
 *
 * Hivenectar's embeddings come from two strategies behind ONE selector:
 *   - `local`  the local nomic daemon (`nomic-embed-text-v1.5`, q8) — the
 *              zero-marginal-cost DEFAULT (`local-nomic.ts`).
 *   - `cohere` the Cohere-via-Portkey embeddings transport — an operator opt-in
 *              (`cohere-portkey.ts`).
 * plus the disabled state:
 *   - `off`    no vector is computed; every embed resolves to `null` so the
 *              caller leaves the column NULL and recall falls back to BM25
 *              (`ai/enricher-and-llm-model.md` § Embeddings).
 *
 * The selector EXTENDS the vault `embeddings.enabled` switch into a three-value
 * setting rather than adding a parallel enable mechanism (DECISION #5): `off` is
 * the disabled value, `local`/`cohere` pick the provider. No explicit selection
 * resolves to `local` ({@link DEFAULT_EMBED_PROVIDER}, AC-1).
 *
 * Both computing providers are wrapped by the 768-dim guard (`guard.ts`) at this
 * boundary, so a vector of the wrong dimension from EITHER provider is discarded
 * to `null` — the 768-dim contract (`EMBED_DIMS`, `source-graph/model.ts`) is
 * never violated in storage (AC-3). The disabled provider needs no guard: it
 * already returns only nulls.
 */
import type { ResolvedEmbeddingsConfig } from "./config.js";
import { withDimGuard, type DimRejectionSink } from "./guard.js";
import { defaultFetch, defaultSleep, type FetchLike, type SleepFn } from "./http.js";
import { createLocalNomicProvider, createLocalNomicHttpTransport, type LocalNomicTransport } from "./local-nomic.js";
import { createCoherePortkeyProvider } from "./cohere-portkey.js";

/**
 * The provider selector — the single embeddings switch (DECISION #5). `off`
 * disables embeddings (NULL column, BM25 fallback); `local` and `cohere` pick
 * the computing strategy.
 */
export type EmbedProviderSelector = "off" | "local" | "cohere";

/** The default provider when none is explicitly selected: the local nomic daemon (AC-1 / DECISION #5). */
export const DEFAULT_EMBED_PROVIDER: EmbedProviderSelector = "local";

/**
 * The strategy contract both computing providers implement. `embed` maps each
 * input text to a vector OR `null` (1:1, order-preserving): `null` means "no
 * usable embedding for this text" — disabled, transport failure, or a wrong-dim
 * vector the guard discarded. `embed` NEVER throws into the caller's hot path
 * (the fail-soft contract, AC-4); a failure surfaces as nulls.
 */
export interface EmbedProvider {
  /** Which strategy this instance is (used for observability + AC verification). */
  readonly kind: EmbedProviderSelector;
  /** Embed a batch; returns one `number[] | null` per input, in input order. Never rejects. */
  embed(texts: readonly string[]): Promise<(number[] | null)[]>;
}

/**
 * The disabled provider: every text maps to `null` regardless of input. This is
 * the `off` selector and the fail-soft floor — the caller leaves the embedding
 * column NULL and recall degrades to BM25 with no error and no quality cliff
 * (AC-4). Pure + total; never touches the network.
 */
export function createOffProvider(): EmbedProvider {
  return {
    kind: "off",
    embed(texts: readonly string[]): Promise<(number[] | null)[]> {
      return Promise.resolve(texts.map(() => null));
    },
  };
}

/** Injectable seams for {@link resolveEmbedProvider} so a test drives it without the network. */
export interface ResolveEmbedProviderDeps {
  /**
   * The local nomic transport (test seam). When absent, a real loopback HTTP
   * transport is built from `config.local`. A test injects a fake so AC-1 can
   * assert the local path was invoked without a running embed daemon.
   */
  readonly localTransport?: LocalNomicTransport;
  /** The `fetch` for the Cohere-via-Portkey transport (test seam); defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** The backoff sleep for the Cohere transport's bounded retry; a test passes a no-op. */
  readonly sleep?: SleepFn;
  /** Where a discarded wrong-dim vector is reported (AC-3); defaults to a no-op. */
  readonly onDimRejected?: DimRejectionSink;
}

/**
 * Resolve the configured {@link EmbedProvider} (the switch, PRD-014a / 014c). The
 * selector routes to the strategy; both computing strategies are wrapped by the
 * 768-dim guard so a wrong-dim vector from either is discarded (AC-3). A test
 * injects a fake `localTransport` / `fetch` so no unit test touches the network.
 */
export function resolveEmbedProvider(
  config: ResolvedEmbeddingsConfig,
  deps: ResolveEmbedProviderDeps = {},
): EmbedProvider {
  const onDimRejected = deps.onDimRejected;
  switch (config.selector) {
    case "off":
      return createOffProvider();
    case "local": {
      const transport = deps.localTransport ?? createLocalNomicHttpTransport(config.local, { fetch: deps.fetch });
      return withDimGuard(createLocalNomicProvider(transport), onDimRejected);
    }
    case "cohere": {
      const provider = createCoherePortkeyProvider(config.cohere, {
        fetch: deps.fetch ?? defaultFetch(),
        sleep: deps.sleep ?? defaultSleep,
      });
      return withDimGuard(provider, onDimRejected);
    }
    default: {
      // Exhaustiveness: a new selector variant fails the build here until handled.
      const unreachable: never = config.selector;
      return unreachable;
    }
  }
}
