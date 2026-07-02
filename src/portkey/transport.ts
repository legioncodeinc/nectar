/**
 * Portkey chat-completions client for hivenectar description calls (PRD-010a).
 *
 * POSTs the OpenAI-compatible chat body to {@link PORTKEY_CHAT_COMPLETIONS_URL}
 * with headers from {@link buildPortkeyHeaders}. Mirrors honeycomb's error mapping
 * (status string only, never body or key) and usage surfacing (including cached
 * read tokens when Portkey reports them). Bounded retry on 429/5xx follows the
 * same "retry once on transient failure" discipline as `deeplake-heal.ts` (one
 * heal-then-retry path), extended here to a small cap for rate limits.
 */
import {
  buildPortkeyHeaders,
  PORTKEY_CHAT_COMPLETIONS_URL,
} from "./headers.js";
import { DEFAULT_ACTIVE_MODEL, type PortkeyEnabled } from "./config.js";

/** Sane completion ceiling when the caller omits `maxTokens`. */
export const PORTKEY_DEFAULT_MAX_TOKENS = 4096 as const;

/** HTTP statuses that trigger a bounded retry (429 rate limit + transient 5xx). */
export const PORTKEY_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Maximum attempts including the first POST (DEFAULT - confirm before implementation). */
export const PORTKEY_MAX_ATTEMPTS = 3 as const;

/** Backoff between retryable failures in ms (DEFAULT - confirm before implementation). */
export const PORTKEY_RETRY_BACKOFF_MS = 250 as const;

/**
 * Per-attempt request timeout (ms), mirroring `source-graph/deeplake-transport.ts`'s
 * `DEFAULT_TRANSPORT_TIMEOUT_MS` AbortController pattern: an unresponsive gateway
 * aborts rather than hanging the caller indefinitely.
 */
export const PORTKEY_REQUEST_TIMEOUT_MS = 15_000 as const;

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface PortkeyUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface DescribeViaPortkeyResult {
  readonly content: string;
  readonly model: string;
  readonly usage: PortkeyUsage;
}

export interface DescribeViaPortkeyRequest {
  readonly messages: readonly ChatMessage[];
  /** Explicit model wins over configured `activeModel` (AC-2). */
  readonly model?: string;
  readonly maxTokens?: number;
}

/** Injectable fetch seam (mirrors honeycomb's `FetchLike`). */
export type PortkeyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface DescribeViaPortkeyDeps {
  readonly portkey: PortkeyEnabled;
  readonly fetch?: PortkeyFetch;
  readonly url?: string;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
  /** Per-attempt request timeout (ms) before the attempt aborts (default {@link PORTKEY_REQUEST_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Injectable sleep for deterministic retry tests. */
  sleep?(ms: number): Promise<void>;
}

/**
 * Typed failure from {@link describeViaPortkey}. The message is a short status
 * string only; the API key is never included.
 */
export class PortkeyTransportError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PortkeyTransportError";
    this.statusCode = statusCode;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveModel(explicit: string | undefined, activeModel: string): string {
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  if (activeModel.trim() !== "") return activeModel;
  return DEFAULT_ACTIVE_MODEL;
}

interface ParsedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function parseUsage(raw: unknown): PortkeyUsage {
  if (typeof raw !== "object" || raw === null) {
    return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  }
  const u = raw as ParsedUsage;
  const inputTokens = typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : 0;
  const outputTokens =
    typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens) ? u.completion_tokens : 0;
  const cached = u.prompt_tokens_details?.cached_tokens;
  const cacheReadInputTokens =
    typeof cached === "number" && Number.isFinite(cached) ? cached : 0;
  return { inputTokens, outputTokens, cacheReadInputTokens };
}

function joinChoiceContent(choices: unknown): string {
  if (!Array.isArray(choices)) return "";
  return choices
    .map((choice) => {
      if (typeof choice !== "object" || choice === null) return "";
      const message = (choice as { message?: { content?: unknown } }).message;
      const content = message?.content;
      return typeof content === "string" ? content : "";
    })
    .filter((part) => part.length > 0)
    .join("");
}

function parseChatResponse(raw: unknown): { content: string; usage: PortkeyUsage } {
  if (typeof raw !== "object" || raw === null) {
    throw new PortkeyTransportError(502, "portkey transport: malformed gateway response");
  }
  const body = raw as { choices?: unknown; usage?: unknown };
  return {
    content: joinChoiceContent(body.choices),
    usage: parseUsage(body.usage),
  };
}

/**
 * POST a chat-completions request through Portkey and return the joined assistant text.
 * Resolves the model as: explicit arg > configured `activeModel` > `gemini-2.5-flash`.
 */
export async function describeViaPortkey(
  request: DescribeViaPortkeyRequest,
  deps: DescribeViaPortkeyDeps,
): Promise<DescribeViaPortkeyResult> {
  const doFetch = deps.fetch ?? (globalThis.fetch.bind(globalThis) as PortkeyFetch);
  const url = deps.url ?? PORTKEY_CHAT_COMPLETIONS_URL;
  const maxAttempts = deps.maxAttempts ?? PORTKEY_MAX_ATTEMPTS;
  const retryBackoffMs = deps.retryBackoffMs ?? PORTKEY_RETRY_BACKOFF_MS;
  const timeoutMs = deps.timeoutMs ?? PORTKEY_REQUEST_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;

  const model = resolveModel(request.model, deps.portkey.activeModel);
  const body = JSON.stringify({
    model,
    max_tokens: request.maxTokens ?? PORTKEY_DEFAULT_MAX_TOKENS,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const headers = buildPortkeyHeaders(deps.portkey.apiKey, deps.portkey.configId);

  let lastStatus = 503;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await doFetch(url, { method: "POST", headers, body, signal: controller.signal });
    } catch (err) {
      lastStatus = 503;
      if (attempt < maxAttempts) {
        await sleep(retryBackoffMs * attempt);
        continue;
      }
      // Our own abort on `timeoutMs` surfaces as an AbortError here, same as any other
      // network fault; never include the response body (it could echo a credential).
      const detail = err instanceof Error ? err.name : "network error";
      throw new PortkeyTransportError(503, `portkey transport: request failed (${detail})`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      lastStatus = res.status;
      if (attempt < maxAttempts && PORTKEY_RETRYABLE_STATUSES.has(res.status)) {
        await sleep(retryBackoffMs * attempt);
        continue;
      }
      throw new PortkeyTransportError(
        res.status,
        `portkey transport: gateway returned status ${res.status}`,
      );
    }

    let raw: unknown;
    try {
      const text = await res.text();
      raw = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw new PortkeyTransportError(502, "portkey transport: malformed gateway response");
    }

    const parsed = parseChatResponse(raw);
    return { content: parsed.content, model, usage: parsed.usage };
  }

  throw new PortkeyTransportError(
    lastStatus,
    `portkey transport: gateway returned status ${lastStatus}`,
  );
}
