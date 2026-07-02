/**
 * The 768-dim guard applied at the provider boundary (PRD-014 AC-3 / 014b
 * US-014b.2 / 014c US-014c.3).
 *
 * The 768-dim contract is load-bearing: it ties to the `FLOAT4[768]` column and
 * `EMBED_DIMS` (`hive-graph/model.ts`), matching `sessions.message_embedding`
 * and `memory.summary_embedding` so the hybrid recall vector index sees one
 * consistent dimensionality across every semantic arm
 * (`ai/enricher-and-llm-model.md` § Embeddings). A vector of the wrong dimension
 * from EITHER provider is discarded HERE — replaced with `null` so the caller
 * leaves the column NULL and recall degrades to BM25, never stored as valid
 * recall data. This is nectar's client-side mirror of honeycomb's
 * `embed.dim_rejected` guard (`honeycomb .../embed-client.ts` returns `null` on
 * `parsed.vector.length !== EMBEDDING_DIMS`).
 *
 * The rejection is reported through an injectable sink so the daemon can count /
 * log it (the `embed.dim_rejected` semantics) without this module depending on a
 * concrete telemetry surface. The default sink is a no-op — a wrong-dim vector
 * still fails soft to `null` whether or not a sink is wired.
 */
import { EMBED_DIMS, isValidEmbedding } from "../hive-graph/model.js";
import type { EmbedProvider, EmbedProviderSelector } from "./provider.js";

/** One discarded-vector event: which provider produced it, the contract dim, and the actual length. */
export interface DimRejection {
  /** The provider whose vector was discarded (`local` or `cohere`). */
  readonly provider: EmbedProviderSelector;
  /** The required dimension (always {@link EMBED_DIMS} = 768). */
  readonly expected: number;
  /** The actual length of the rejected vector. */
  readonly actual: number;
}

/** The observability sink for a discarded wrong-dim vector (the `embed.dim_rejected` count/log seam). */
export type DimRejectionSink = (rejection: DimRejection) => void;

/**
 * A body-free stderr sink an integrator can wire as the default observability for
 * a discarded vector: it emits the dimension mismatch (never the vector itself)
 * so an operator sees WHY recall degraded, mirroring honeycomb's "observable, not
 * silently swallowed" posture. Never throws.
 */
export function stderrDimRejectionSink(rejection: DimRejection): void {
  process.stderr.write(
    `nectar: embed.dim_rejected provider=${rejection.provider} expected=${rejection.expected} actual=${rejection.actual}\n`,
  );
}

/**
 * Apply the dim guard to ONE vector: a `null` passes through, a 768-dim vector
 * passes through, anything else is discarded to `null` and reported to `sink`.
 * `sink` is invoked defensively — a faulty sink never breaks the embed path.
 */
export function guardVector(
  vec: number[] | null,
  provider: EmbedProviderSelector,
  sink?: DimRejectionSink,
): number[] | null {
  if (isValidEmbedding(vec)) return vec;
  // `isValidEmbedding` only returns false for a non-null wrong-length vector, so `vec` is non-null here.
  const actual = vec === null ? 0 : vec.length;
  if (sink !== undefined) {
    try {
      sink({ provider, expected: EMBED_DIMS, actual });
    } catch {
      // A rejection-sink fault is swallowed: observability is best-effort, never breaks the embed path.
    }
  }
  return null;
}

/**
 * Wrap a computing provider so every returned vector passes the 768-dim guard
 * (AC-3). The wrapper preserves the provider's `kind` and its 1:1 ordering; a
 * wrong-dim vector at any position becomes `null` (reported to `sink`) while the
 * rest pass through. The wrapped `embed` inherits the provider's never-throw
 * contract.
 */
export function withDimGuard(provider: EmbedProvider, sink?: DimRejectionSink): EmbedProvider {
  return {
    kind: provider.kind,
    async embed(texts: readonly string[]): Promise<(number[] | null)[]> {
      const raw = await provider.embed(texts);
      return raw.map((vec) => guardVector(vec, provider.kind, sink));
    },
  };
}
