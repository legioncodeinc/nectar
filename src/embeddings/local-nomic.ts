/**
 * The local nomic embedding provider (PRD-014a — the zero-marginal-cost DEFAULT).
 *
 * Talks to the local nomic embed daemon the corpus describes
 * (`ai/enricher-and-llm-model.md` § Embeddings: "the local nomic path
 * (`nomic-embed-text-v1.5`, q8 quantization)"). Honeycomb's embed daemon
 * (`honeycomb/embeddings/src/index.ts`) serves that model over a loopback
 * request surface (`POST /embed { text } -> { vector }`, `GET /health`) on
 * `127.0.0.1:3851`. Hivenectar reaches it over the network through its OWN
 * client rather than importing the honeycomb runtime in-process (ADR-0002); the
 * daemon owns the pinned `MODEL_ID` / `MODEL_REVISION` / `MODEL_QUANTIZATION` /
 * `DOCUMENT_PREFIX` consts (PRD-014a keeps them pinned), so this client only
 * carries the text and receives the vector.
 *
 * ── Fail-soft is the cardinal rule (AC-4) ────────────────────────────────────
 * A dead daemon (connection refused), a not-yet-warm daemon (503 `model not
 * ready`), a non-2xx, or a malformed body ALL resolve to `null` for that text —
 * NEVER a throw into the caller's hot path. A `null` means the caller leaves the
 * column NULL and recall degrades to BM25 (`ai/enricher-and-llm-model.md`). The
 * dimension is NOT checked here; the 768-dim guard (`guard.ts`) owns that at the
 * provider boundary, so a wrong-dim daemon output is discarded there (AC-3).
 *
 * The transport is an injectable seam ({@link LocalNomicTransport}) so a unit
 * test drives the provider without binding a socket or running the ~600 MB model.
 */
import { defaultFetch, type FetchLike } from "./http.js";
import type { EmbedProvider } from "./provider.js";

/** The local embed daemon's loopback host (matches honeycomb's `EMBED_HOST`). */
export const DEFAULT_LOCAL_EMBED_HOST = "127.0.0.1" as const;

/** The local embed daemon's loopback port (matches honeycomb's `EMBED_PORT` / `src/config.ts` note). */
export const DEFAULT_LOCAL_EMBED_PORT = 3851 as const;

/** The per-text request timeout (ms) before the client gives up and returns `null` (fail-soft). */
export const DEFAULT_LOCAL_EMBED_TIMEOUT_MS = 10_000 as const;

/** The resolved local-nomic client config (host/port/timeout). */
export interface LocalNomicConfig {
  readonly host: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
}

/**
 * The injectable local-daemon transport seam. `embedOne` returns the daemon's
 * RAW vector for one text, or `null` on ANY failure (dead/not-warm daemon,
 * non-2xx, malformed body). It never throws. The returned vector is NOT
 * dimension-checked here — the guard owns that.
 */
export interface LocalNomicTransport {
  embedOne(text: string): Promise<number[] | null>;
}

/** Construction deps for {@link createLocalNomicHttpTransport}; the fetch is injectable for tests. */
export interface LocalNomicHttpDeps {
  /** The `fetch` implementation; defaults to `globalThis.fetch`. A test injects a fake (no socket). */
  readonly fetch?: FetchLike;
}

/** Build the `/embed` URL for the resolved host/port. */
function embedUrl(config: LocalNomicConfig): string {
  return `http://${config.host}:${config.port}/embed`;
}

/**
 * Parse the daemon's `{ vector: number[] }` body defensively. Returns the vector
 * when the body is the expected shape with a finite-number array, else `null`
 * (a malformed body fails soft, same as a transport error). Never throws.
 */
function parseVector(raw: string): number[] | null {
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const vector = (body as { vector?: unknown }).vector;
  if (!Array.isArray(vector)) return null;
  if (!vector.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return vector as number[];
}

/**
 * Build the REAL local-nomic transport: a loopback HTTP client to the embed
 * daemon's `POST /embed` (PRD-014a). Every failure path — a network error
 * (daemon down), a non-2xx (e.g. 503 not-warm), or a malformed body — resolves
 * to `null` (fail-soft, AC-4), NEVER a throw. Production uses `globalThis.fetch`;
 * a test injects a fake `fetch` so no socket is bound. An `AbortController`
 * bounds each call so a hung daemon cannot stall the embed path.
 */
export function createLocalNomicHttpTransport(
  config: LocalNomicConfig,
  deps: LocalNomicHttpDeps = {},
): LocalNomicTransport {
  const doFetch = deps.fetch ?? defaultFetch();
  const url = embedUrl(config);
  return {
    async embedOne(text: string): Promise<number[] | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        return parseVector(await res.text());
      } catch {
        // Dead daemon (ECONNREFUSED), our own abort on `requestTimeoutMs` (a hung/not-warm
        // daemon), or any other transport fault -> null. Never surface the error (fail-soft):
        // the caller leaves the column NULL and recall stays lexical (AC-4).
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Build the local nomic {@link EmbedProvider} over an injected transport. The
 * provider embeds each text through the daemon (order-preserving, 1:1) and maps
 * ANY per-text failure to `null` — a rejected transport promise is caught here so
 * the provider's never-throw contract holds even if a future transport rejects
 * (AC-4). The returned vectors are dimension-guarded by the caller (`guard.ts`).
 */
export function createLocalNomicProvider(transport: LocalNomicTransport): EmbedProvider {
  return {
    kind: "local",
    embed(texts: readonly string[]): Promise<(number[] | null)[]> {
      return Promise.all(
        texts.map(async (text) => {
          try {
            return await transport.embedOne(text);
          } catch {
            return null;
          }
        }),
      );
    },
  };
}
