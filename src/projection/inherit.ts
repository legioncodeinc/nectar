/**
 * Fresh-clone inheritance from a validated projection (PRD-011b / AC-6).
 *
 * Hash-matched files inherit nectar + description with zero LLM calls and zero
 * fuzzy matches. Writes are additive only: existing local nectars are never
 * overwritten.
 */
import { nectarCreatedAt } from "../hive-graph/ulid.js";
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import type { PortableProjection, ProjectionFileEntry } from "./format.js";
import { buildContentHashIndex } from "./load.js";

/** Repo-relative path -> content hash (from disk scan). */
export type DiskHashMap = ReadonlyMap<string, string>;

export interface InheritRow {
  readonly identity: HiveGraphRow;
  readonly version: HiveGraphVersionRow;
}

export interface InheritSummary {
  readonly inherited: number;
  readonly unmatched: number;
  readonly skippedExisting: number;
  readonly rows: readonly InheritRow[];
}

export interface InheritFromProjectionOptions {
  readonly tenancy: Tenancy;
  readonly nowIso?: string;
  /** Nectars already present in the local store; never overwritten. */
  readonly existingNectars?: ReadonlySet<string>;
}

function conceptsToJson(concepts: readonly string[]): string {
  return JSON.stringify([...concepts]);
}

function toIdentity(nectar: string, entry: ProjectionFileEntry, derived: PortableProjection["derived"], tenancy: Tenancy): HiveGraphRow {
  const d = derived[nectar];
  return {
    nectar,
    kind: "file",
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: d?.from_nectar ?? "",
    forkContentHash: d?.fork_content_hash ?? "",
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: "",
  };
}

function filenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function extOf(path: string): string {
  const name = filenameOf(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function toVersion(
  nectar: string,
  entry: ProjectionFileEntry,
  tenancy: Tenancy,
  observedAt: string,
): HiveGraphVersionRow {
  const described = entry.title !== "" || entry.description !== "";
  return {
    nectar,
    contentHash: entry.content_hash,
    seq: 0,
    path: entry.path,
    filename: filenameOf(entry.path),
    ext: extOf(entry.path),
    sizeBytes: 0,
    mtimeObserved: observedAt,
    title: entry.title,
    description: entry.description,
    concepts: conceptsToJson(entry.concepts),
    embedding: null,
    confidence: null,
    fingerprint: null,
    describedAt: entry.described_at,
    describeModel: entry.describe_model,
    describeStatus: described ? "described" : "pending",
    observedAt,
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: observedAt,
  };
}

/**
 * Given a validated projection and on-disk hashes, produce rows to insert for
 * hash-matched paths. Unmatched disk files are counted but not mutated here
 * (the re-association ladder handles them in PRD-006).
 */
export function inheritFromProjection(
  doc: PortableProjection,
  diskHashes: DiskHashMap,
  opts: InheritFromProjectionOptions,
): InheritSummary {
  const index = buildContentHashIndex(doc);
  const existing = opts.existingNectars ?? new Set<string>();
  const observedAt = opts.nowIso ?? new Date().toISOString();

  const rows: InheritRow[] = [];
  let inherited = 0;
  let unmatched = 0;
  let skippedExisting = 0;

  for (const [path, hash] of diskHashes) {
    const hit = index.get(hash);
    if (hit === undefined) {
      unmatched += 1;
      continue;
    }

    if (existing.has(hit.nectar)) {
      skippedExisting += 1;
      continue;
    }

    const entry = { ...hit.entry, path };
    rows.push({
      identity: toIdentity(hit.nectar, entry, doc.derived, opts.tenancy),
      version: toVersion(hit.nectar, entry, opts.tenancy, observedAt),
    });
    inherited += 1;
  }

  return { inherited, unmatched, skippedExisting, rows };
}
