/**
 * Projection validation on load (PRD-011b).
 *
 * A projection that fails any check is ignored with a typed reason; it is never
 * partially loaded and this module never throws on validation failure (AC-4,
 * AC-5).
 *
 * `.honeycomb/nectars.json` is a committed file that travels with a cloned repo,
 * so it must be treated as untrusted input: {@link loadProjectionFromFile} rejects
 * a file over {@link MAX_PROJECTION_FILE_BYTES} before it is ever read into memory
 * (CWE-400), and the parser below rejects the whole document (fail-closed, never
 * a partial parse) the moment a `files`/`derived` key would hijack the
 * destination object's own prototype (`__proto__`, `constructor`, `prototype`) -
 * these keys never reach a bare `obj[key] = value` assignment.
 */
import { readFileSync, statSync } from "node:fs";
import { isValidNectar } from "../source-graph/ulid.js";
import type { Tenancy } from "../source-graph/model.js";
import {
  PROJECTION_SCHEMA_VERSION,
  isValidContentHash,
  parseProjectionJson,
  type PortableProjection,
  type ProjectionDerivedEntry,
  type ProjectionFileEntry,
  type ProjectionProject,
} from "./format.js";

/**
 * Defensive ceiling on `.honeycomb/nectars.json` before it is read into memory
 * (CWE-400): the file is untrusted (committed content from a cloned repo), and
 * nothing about the projection format needs to exceed this to hold a legitimate
 * per-file description index for even a very large monorepo.
 */
export const MAX_PROJECTION_FILE_BYTES = 100 * 1024 * 1024;

/** Keys that would hijack a plain object's own prototype via `obj[key] = value` (CWE-1321). */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type LoadIgnoreReason =
  | "file_missing"
  | "file_too_large"
  | "invalid_json"
  | "invalid_shape"
  | "future_version"
  | "project_mismatch"
  | "invalid_nectar_key"
  | "invalid_content_hash"
  | "invalid_derived_entry";

export type LoadProjectionResult =
  | { readonly ok: true; readonly doc: PortableProjection }
  | { readonly ok: false; readonly reason: LoadIgnoreReason; readonly detail: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseProject(raw: unknown): ProjectionProject | null {
  if (!isRecord(raw)) return null;
  if (!isString(raw.org_id) || !isString(raw.workspace_id) || !isString(raw.project_id)) return null;
  return { org_id: raw.org_id, workspace_id: raw.workspace_id, project_id: raw.project_id };
}

function parseFileEntry(raw: unknown): ProjectionFileEntry | null {
  if (!isRecord(raw)) return null;
  if (!isString(raw.content_hash) || !isString(raw.path)) return null;
  if (!isString(raw.title) || !isString(raw.description)) return null;
  if (!isStringArray(raw.concepts)) return null;
  if (!isString(raw.describe_model) || !isString(raw.described_at)) return null;
  return {
    content_hash: raw.content_hash,
    path: raw.path,
    title: raw.title,
    description: raw.description,
    concepts: raw.concepts,
    describe_model: raw.describe_model,
    described_at: raw.described_at,
  };
}

function parseDerivedEntry(raw: unknown): ProjectionDerivedEntry | null {
  if (!isRecord(raw)) return null;
  if (!isString(raw.from_nectar) || !isString(raw.fork_content_hash)) return null;
  return { from_nectar: raw.from_nectar, fork_content_hash: raw.fork_content_hash };
}

function parsePortableProjection(raw: unknown): PortableProjection | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.version !== "number") return null;
  if (!isString(raw.generated_at) || !isString(raw.generator)) return null;
  const project = parseProject(raw.project);
  if (project === null) return null;
  if (!isRecord(raw.files) || !isRecord(raw.derived)) return null;

  const files: Record<string, ProjectionFileEntry> = {};
  for (const [nectar, entryRaw] of Object.entries(raw.files)) {
    // Reject the whole document rather than skip: a `__proto__`/`constructor`/`prototype`
    // key would hijack `files`'s own prototype via the assignment below rather than
    // becoming an inert own property, and a silent skip would be a partial load (AC-5).
    if (DANGEROUS_KEYS.has(nectar)) return null;
    const entry = parseFileEntry(entryRaw);
    if (entry === null) return null;
    files[nectar] = entry;
  }

  const derived: Record<string, ProjectionDerivedEntry> = {};
  for (const [nectar, entryRaw] of Object.entries(raw.derived)) {
    if (DANGEROUS_KEYS.has(nectar)) return null;
    const entry = parseDerivedEntry(entryRaw);
    if (entry === null) return null;
    derived[nectar] = entry;
  }

  return {
    version: raw.version,
    generated_at: raw.generated_at,
    generator: raw.generator,
    project,
    files,
    derived,
  };
}

function tenancyMatchesProject(tenancy: Tenancy, project: ProjectionProject): boolean {
  return (
    tenancy.orgId === project.org_id &&
    tenancy.workspaceId === project.workspace_id &&
    tenancy.projectId === project.project_id
  );
}

/**
 * Validate a parsed projection against the current tenancy. All checks are a
 * single gate: any failure rejects the whole document (AC-5).
 */
export function validateProjection(doc: PortableProjection, tenancy: Tenancy): LoadProjectionResult {
  if (doc.version > PROJECTION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "future_version",
      detail: `projection version ${doc.version} exceeds daemon schema ${PROJECTION_SCHEMA_VERSION}`,
    };
  }

  if (!tenancyMatchesProject(tenancy, doc.project)) {
    return {
      ok: false,
      reason: "project_mismatch",
      detail: "projection project triple does not match current context",
    };
  }

  for (const nectar of Object.keys(doc.files)) {
    if (!isValidNectar(nectar)) {
      return {
        ok: false,
        reason: "invalid_nectar_key",
        detail: `invalid nectar key in files: ${nectar}`,
      };
    }
    const entry = doc.files[nectar];
    if (entry === undefined) continue;
    if (!isValidContentHash(entry.content_hash)) {
      return {
        ok: false,
        reason: "invalid_content_hash",
        detail: `invalid content_hash for nectar ${nectar}`,
      };
    }
  }

  for (const nectar of Object.keys(doc.derived)) {
    if (!isValidNectar(nectar)) {
      return {
        ok: false,
        reason: "invalid_nectar_key",
        detail: `invalid nectar key in derived: ${nectar}`,
      };
    }
    const entry = doc.derived[nectar];
    if (entry === undefined) continue;
    if (!isValidNectar(entry.from_nectar)) {
      return {
        ok: false,
        reason: "invalid_nectar_key",
        detail: `invalid from_nectar in derived[${nectar}]`,
      };
    }
    if (!isValidContentHash(entry.fork_content_hash)) {
      return {
        ok: false,
        reason: "invalid_content_hash",
        detail: `invalid fork_content_hash in derived[${nectar}]`,
      };
    }
  }

  return { ok: true, doc };
}

export interface LoadProjectionFromFileOptions {
  readonly tenancy: Tenancy;
}

/** Read and validate a projection file. Never throws on validation failure. */
export function loadProjectionFromFile(
  filePath: string,
  opts: LoadProjectionFromFileOptions,
): LoadProjectionResult {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_PROJECTION_FILE_BYTES) {
      return {
        ok: false,
        reason: "file_too_large",
        detail: `projection file exceeds ${MAX_PROJECTION_FILE_BYTES} bytes (${stat.size}): ${filePath}`,
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "file_missing", detail: `projection not found: ${filePath}` };
    }
    throw err;
  }

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "file_missing", detail: `projection not found: ${filePath}` };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseProjectionJson(text);
  } catch {
    return { ok: false, reason: "invalid_json", detail: "projection file is not valid JSON" };
  }

  const doc = parsePortableProjection(parsed);
  if (doc === null) {
    return { ok: false, reason: "invalid_shape", detail: "projection JSON does not match the expected shape" };
  }

  return validateProjection(doc, opts.tenancy);
}

/** Validate an in-memory projection document (for tests and daemon boot). */
export function loadProjection(
  doc: PortableProjection,
  tenancy: Tenancy,
): LoadProjectionResult {
  return validateProjection(doc, tenancy);
}

/** Build a content_hash -> nectar index after validation passes (AC-6). */
export function buildContentHashIndex(
  doc: PortableProjection,
): ReadonlyMap<string, { nectar: string; entry: ProjectionFileEntry }> {
  const index = new Map<string, { nectar: string; entry: ProjectionFileEntry }>();
  for (const [nectar, entry] of Object.entries(doc.files)) {
    index.set(entry.content_hash, { nectar, entry });
  }
  return index;
}
