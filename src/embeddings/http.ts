/**
 * The injectable HTTP seam shared by both embedding transports (PRD-014).
 *
 * A minimal `fetch`-shaped surface so neither the local nomic client nor the
 * hosted-via-Portkey transport touches the network in a unit test: production
 * binds `globalThis.fetch`, a test injects a fake that returns a canned
 * response. The shape is deliberately identical to the sibling chat transport's
 * `PortkeyFetch` (`src/portkey/transport.ts`) so the Wave-2 integrator can fold
 * the two onto one shared seam without a signature change.
 */

/** The subset of a `fetch` `Response` the transports read. */
export interface FetchResponseLike {
  /** True on a 2xx status. */
  readonly ok: boolean;
  /** The HTTP status code (routed to the bounded-retry decision + the fail-soft path). */
  readonly status: number;
  /** The raw response body; parsed defensively by the caller (never trusted). */
  text(): Promise<string>;
}

/** The injectable `fetch` implementation. Production: `globalThis.fetch`; tests inject a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

/** Bind the real global `fetch` to the {@link FetchLike} shape (Node >=22 ships it as a built-in). */
export function defaultFetch(): FetchLike {
  return globalThis.fetch.bind(globalThis) as unknown as FetchLike;
}

/** An injectable backoff sleep; tests pass a no-op so retry paths run without real time. */
export type SleepFn = (ms: number) => Promise<void>;

/** The production sleep, backed by a real timer. */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
