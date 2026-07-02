/**
 * Describe stage (PRD-007b) - stages 4 (describe) and 5 (embed) of the pipeline.
 *
 * Batch and solo LLM call shapes, their prompts, response parsing/validation,
 * and the embedding step that follows every description. The transport (Portkey,
 * PRD-010) and the embedding provider (PRD-014) are injected seams: `--dry-run`
 * never constructs them, and a test drives describe without the network.
 *
 * The batch system prompt is reproduced VERBATIM from `brooding-pipeline.md`.
 * The batch call asks for title (<=80 chars) + 1-3 sentence description + 1-5
 * concepts; the solo call asks for a richer 3-5 sentence description + a primary
 * symbol. Malformed batch entries are re-tried solo or marked failed by the
 * pipeline (`pipeline.ts`); this module surfaces which entries parsed.
 */
import type { DescriptionPayload } from "../portkey/describe-model.js";
import type {
  ChatMessage,
  DescribeViaPortkeyRequest,
  DescribeViaPortkeyResult,
} from "../portkey/transport.js";
import type { EmbedProvider } from "../embeddings/provider.js";
import { filenameOf } from "../hive-graph/paths.js";
import type { PreparedFile } from "./precheck.js";

/** The batch system prompt, carried verbatim from `brooding-pipeline.md` § "The batch call". */
export const BATCH_SYSTEM_PROMPT = `You are describing source files in a codebase for a semantic search index.
For each file, return:
- title: <=80 chars, a human-readable name for what this file IS (not its path).
- description: 1-3 sentences, what this file does and what it is for.
- concepts: 1-5 lowercase tags for cross-file linking (e.g. "auth", "session", "jwt").
Respond as a JSON array, one object per input file, in input order.`;

/**
 * The solo system prompt, matching the corpus's solo output shape (3-5 sentence
 * description + primary symbol). The corpus specifies the OUTPUT shape verbatim;
 * this prompt is authored to that shape (the corpus does not reproduce the solo
 * prompt text the way it does the batch one).
 */
export const SOLO_SYSTEM_PROMPT = `You are describing a single source file in a codebase for a semantic search index.
Return:
- description: 3-5 sentences, what this file does, what it is for, and how it fits the codebase.
- primary_symbol: the most important function, class, or type defined in the file.
Respond as a JSON object with exactly the keys "description" and "primary_symbol".`;

/** Max title length (<=80 chars), enforced on parsed output. */
export const MAX_TITLE_CHARS = 80;
/** Max concepts kept per file (1-5), enforced on parsed output. */
export const MAX_CONCEPTS = 5;

/** The transport seam: a chat completion call. Default wires `describeViaPortkey`. */
export type DescribeFn = (req: DescribeViaPortkeyRequest) => Promise<DescribeViaPortkeyResult>;

/** One file targeted for description: its already-minted nectar + prepared content. */
export interface DescribeTarget {
  readonly nectar: string;
  readonly prepared: PreparedFile;
}

function decodeText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function clampTitle(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  const chosen = s === "" ? fallback : s;
  return chosen.slice(0, MAX_TITLE_CHARS);
}

function clampConcepts(raw: unknown): string {
  if (!Array.isArray(raw)) return "[]";
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim().toLowerCase();
    if (tag === "") continue;
    tags.push(tag);
    if (tags.length >= MAX_CONCEPTS) break;
  }
  return JSON.stringify(tags);
}

/** Build the batch user message: a JSON array of `{ nectar, path, content }`. */
export function buildBatchUserMessage(targets: readonly DescribeTarget[]): string {
  const payload = targets.map((t) => ({
    nectar: t.nectar,
    path: t.prepared.file.relPath,
    content: decodeText(t.prepared.bytes),
  }));
  return JSON.stringify(payload);
}

/** Build the solo user message: the file's path plus its full content. */
export function buildSoloUserMessage(target: DescribeTarget): string {
  return `path: ${target.prepared.file.relPath}\n\n${decodeText(target.prepared.bytes)}`;
}

/** Extract the first JSON value from model text (tolerates code fences / prose wrapping). */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate a fenced or prose-wrapped body: find the first [...] or {...} span.
    const firstArr = trimmed.indexOf("[");
    const firstObj = trimmed.indexOf("{");
    const start =
      firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstArr, firstObj);
    if (start === -1) return null;
    const open = trimmed[start];
    const close = open === "[" ? "]" : "}";
    const end = trimmed.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** One described file plus its resolved payload; or a failed nectar. */
export interface BatchDescribeResult {
  readonly described: ReadonlyArray<{ readonly nectar: string; readonly payload: DescriptionPayload }>;
  /** Nectars whose entry was missing or malformed (re-tried solo or marked failed by the pipeline). */
  readonly failed: readonly string[];
  readonly model: string;
  readonly usage: DescribeViaPortkeyResult["usage"] | null;
}

function payloadFromEntry(entry: unknown, fallbackTitle: string): DescriptionPayload | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  const description = typeof rec.description === "string" ? rec.description.trim() : "";
  if (description === "") return null;
  return {
    title: clampTitle(rec.title, fallbackTitle),
    description,
    concepts: clampConcepts(rec.concepts),
  };
}

/**
 * Run one batch call for `targets` and parse the response into per-nectar
 * payloads. Response entries are matched by their `nectar` field, falling back
 * to input order. A whole-call transport error marks every target failed (all
 * re-enqueueable). Malformed individual entries are reported in `failed`.
 */
export async function describeBatchGroup(
  targets: readonly DescribeTarget[],
  describe: DescribeFn,
  model?: string,
): Promise<BatchDescribeResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: BATCH_SYSTEM_PROMPT },
    { role: "user", content: buildBatchUserMessage(targets) },
  ];

  let result: DescribeViaPortkeyResult;
  try {
    result = await describe({ messages, model });
  } catch {
    return { described: [], failed: targets.map((t) => t.nectar), model: model ?? "", usage: null };
  }

  const parsed = extractJson(result.content);
  const entries = Array.isArray(parsed) ? parsed : null;
  if (entries === null) {
    return { described: [], failed: targets.map((t) => t.nectar), model: result.model, usage: result.usage };
  }

  const byNectar = new Map<string, unknown>();
  for (const e of entries) {
    if (typeof e === "object" && e !== null && typeof (e as { nectar?: unknown }).nectar === "string") {
      byNectar.set((e as { nectar: string }).nectar, e);
    }
  }

  const described: Array<{ nectar: string; payload: DescriptionPayload }> = [];
  const failed: string[] = [];
  targets.forEach((t, i) => {
    const entry = byNectar.get(t.nectar) ?? entries[i];
    const payload = payloadFromEntry(entry, filenameOf(t.prepared.file.relPath));
    if (payload === null) failed.push(t.nectar);
    else described.push({ nectar: t.nectar, payload });
  });

  return { described, failed, model: result.model, usage: result.usage };
}

/** One solo describe outcome. */
export interface SoloDescribeResult {
  readonly nectar: string;
  readonly payload: DescriptionPayload | null;
  readonly model: string;
  readonly usage: DescribeViaPortkeyResult["usage"] | null;
}

/**
 * Run one solo call for a single (larger) file and parse the `{ description,
 * primary_symbol }` response. The primary symbol becomes the title (a
 * human-readable name), falling back to the filename. A transport error or
 * malformed body yields `payload: null` (the pipeline marks it failed).
 */
export async function describeSoloFile(
  target: DescribeTarget,
  describe: DescribeFn,
  model?: string,
): Promise<SoloDescribeResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SOLO_SYSTEM_PROMPT },
    { role: "user", content: buildSoloUserMessage(target) },
  ];

  let result: DescribeViaPortkeyResult;
  try {
    result = await describe({ messages, model });
  } catch {
    return { nectar: target.nectar, payload: null, model: model ?? "", usage: null };
  }

  const parsed = extractJson(result.content);
  const fallbackTitle = target.prepared.file.relPath;
  if (typeof parsed !== "object" || parsed === null) {
    return { nectar: target.nectar, payload: null, model: result.model, usage: result.usage };
  }
  const rec = parsed as Record<string, unknown>;
  const description = typeof rec.description === "string" ? rec.description.trim() : "";
  if (description === "") {
    return { nectar: target.nectar, payload: null, model: result.model, usage: result.usage };
  }
  const primarySymbol = typeof rec.primary_symbol === "string" ? rec.primary_symbol.trim() : "";
  const payload: DescriptionPayload = {
    title: clampTitle(primarySymbol, fallbackTitle),
    description,
    concepts: "[]",
  };
  return { nectar: target.nectar, payload, model: result.model, usage: result.usage };
}

/** The embedding text for a description: `title + ' ' + description` (PRD-014). */
export function embeddingText(payload: DescriptionPayload): string {
  return `${payload.title} ${payload.description}`;
}

/**
 * Embed a batch of described payloads over `title + ' ' + description` (stage 5).
 * Returns one vector-or-null per input, in order. Never throws: the provider's
 * fail-soft contract leaves the column NULL (recall degrades to BM25).
 */
export async function embedDescriptions(
  provider: EmbedProvider,
  payloads: readonly DescriptionPayload[],
): Promise<(number[] | null)[]> {
  if (payloads.length === 0) return [];
  return provider.embed(payloads.map(embeddingText));
}
