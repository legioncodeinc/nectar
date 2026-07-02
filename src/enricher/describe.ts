/**
 * Description call + response validation (PRD-016b).
 */
import type { DescriptionPayload } from "../portkey/describe-model.js";
import { describeViaPortkey, PortkeyTransportError, type DescribeViaPortkeyDeps } from "../portkey/transport.js";

export interface DescribeFileInput {
  readonly path: string;
  readonly content: string;
}

export interface DescribeBatchResult {
  readonly descriptions: readonly DescriptionPayload[];
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const SYSTEM_PROMPT =
  "You describe source files for a semantic code memory system. " +
  "Respond with a JSON array of objects, one per input file, each with keys: " +
  "title (string, max 80 chars), description (string, 1-3 sentences), " +
  "concepts (JSON array of short strings). No markdown fences.";

const STRICT_SUFFIX =
  " Return ONLY valid JSON. The array length MUST equal the number of input files.";

function buildUserPrompt(files: readonly DescribeFileInput[], strict: boolean): string {
  const blocks = files.map(
    (f, i) => `File ${i + 1}: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``,
  );
  const header = `Describe ${files.length} file(s):\n\n`;
  return header + blocks.join("\n\n") + (strict ? STRICT_SUFFIX : "");
}

function parseDescriptionObject(raw: unknown): DescriptionPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title : null;
  const description = typeof o.description === "string" ? o.description : null;
  let concepts = '[]';
  if (typeof o.concepts === "string") concepts = o.concepts;
  else if (Array.isArray(o.concepts)) concepts = JSON.stringify(o.concepts.map(String));
  if (title === null || description === null) return null;
  return { title, description, concepts };
}

/** Parse and validate a model response for `expectedCount` descriptions. */
export function parseDescribeResponse(content: string, expectedCount: number): DescriptionPayload[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return null;
  }
  let arr: unknown[];
  if (Array.isArray(parsed)) arr = parsed;
  else {
    const single = parseDescriptionObject(parsed);
    if (single === null) return null;
    arr = [single];
  }
  if (arr.length !== expectedCount) return null;
  const out: DescriptionPayload[] = [];
  for (const item of arr) {
    const d = parseDescriptionObject(item);
    if (d === null) return null;
    out.push(d);
  }
  return out;
}

export function isContextWindowError(err: unknown): boolean {
  if (err instanceof PortkeyTransportError) {
    if (err.statusCode === 413) return true;
    return /context|token limit|too long/i.test(err.message);
  }
  return false;
}

export async function describeFilesBatch(
  files: readonly DescribeFileInput[],
  deps: DescribeViaPortkeyDeps,
  strict: boolean,
): Promise<DescribeBatchResult> {
  const result = await describeViaPortkey(
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(files, strict) },
      ],
    },
    deps,
  );
  const descriptions = parseDescribeResponse(result.content, files.length);
  if (descriptions === null) {
    throw new Error("describe validator: malformed JSON or wrong description count");
  }
  return {
    descriptions,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}

/** Embedding input string: title + space + description (PRD-016b). */
export function embeddingText(title: string, description: string): string {
  return `${title} ${description}`;
}
