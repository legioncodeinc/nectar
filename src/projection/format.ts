/**
 * Portable projection document types and canonical serialization (PRD-011a).
 *
 * The JSON shape matches `library/knowledge/private/data/portable-registry.md`
 * § The file format. `content_hash` values are bare lowercase sha256 hex (64
 * chars), aligned to `source-graph/hash.ts`, not a `sha256-` prefixed form.
 */

/** Current projection schema version. Old daemons refuse to load a higher value. */
export const PROJECTION_SCHEMA_VERSION = 1;

/** Default path relative to the project root (decision #31). */
export const DEFAULT_PROJECTION_REL_PATH = ".honeycomb/nectars.json";

/** Default generator string when none is supplied. */
export const DEFAULT_GENERATOR = "honeycomb-hivenectar@0.0.1";

export interface ProjectionProject {
  readonly org_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
}

export interface ProjectionFileEntry {
  readonly content_hash: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly concepts: readonly string[];
  readonly describe_model: string;
  readonly described_at: string;
}

export interface ProjectionDerivedEntry {
  readonly from_nectar: string;
  readonly fork_content_hash: string;
}

export interface PortableProjection {
  readonly version: number;
  readonly generated_at: string;
  readonly generator: string;
  readonly project: ProjectionProject;
  readonly files: Readonly<Record<string, ProjectionFileEntry>>;
  readonly derived: Readonly<Record<string, ProjectionDerivedEntry>>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Syntactic check: 64 lowercase hex chars, no prefix (PRD-011b / hash.ts). */
export function isValidContentHash(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** Parse JSON text into an unknown value; throws on invalid JSON. */
export function parseProjectionJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function quoteString(s: string): string {
  return JSON.stringify(s);
}

function serializeStringArray(arr: readonly string[]): string {
  return `[${arr.map((v) => quoteString(v)).join(",")}]`;
}

function serializeFileEntry(entry: ProjectionFileEntry): string {
  const parts = [
    `"content_hash":${quoteString(entry.content_hash)}`,
    `"path":${quoteString(entry.path)}`,
    `"title":${quoteString(entry.title)}`,
    `"description":${quoteString(entry.description)}`,
    `"concepts":${serializeStringArray(entry.concepts)}`,
    `"describe_model":${quoteString(entry.describe_model)}`,
    `"described_at":${quoteString(entry.described_at)}`,
  ];
  return `{${parts.join(",")}}`;
}

function serializeDerivedEntry(entry: ProjectionDerivedEntry): string {
  return `{${[
    `"from_nectar":${quoteString(entry.from_nectar)}`,
    `"fork_content_hash":${quoteString(entry.fork_content_hash)}`,
  ].join(",")}}`;
}

function serializeProject(project: ProjectionProject): string {
  return `{${[
    `"org_id":${quoteString(project.org_id)}`,
    `"workspace_id":${quoteString(project.workspace_id)}`,
    `"project_id":${quoteString(project.project_id)}`,
  ].join(",")}}`;
}

/**
 * Deterministic JSON bytes: stable key order at every object level so two
 * generations from the same store state differ only in `generated_at` (AC-7).
 */
export function canonicalSerialize(doc: PortableProjection): string {
  const fileKeys = Object.keys(doc.files).sort();
  const filesBody = fileKeys
    .map((k) => `${quoteString(k)}:${serializeFileEntry(doc.files[k] as ProjectionFileEntry)}`)
    .join(",");

  const derivedKeys = Object.keys(doc.derived).sort();
  const derivedBody = derivedKeys
    .map((k) => `${quoteString(k)}:${serializeDerivedEntry(doc.derived[k] as ProjectionDerivedEntry)}`)
    .join(",");

  return `{${[
    `"version":${doc.version}`,
    `"generated_at":${quoteString(doc.generated_at)}`,
    `"generator":${quoteString(doc.generator)}`,
    `"project":${serializeProject(doc.project)}`,
    `"files":{${filesBody}}`,
    `"derived":{${derivedBody}}`,
  ].join(",")}}\n`;
}

/** Strip `generated_at` for byte-identical comparisons (AC-7). */
export function canonicalSerializeExceptGeneratedAt(doc: PortableProjection): string {
  const without = { ...doc, generated_at: "1970-01-01T00:00:00.000Z" };
  return canonicalSerialize(without);
}
