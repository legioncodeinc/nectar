/**
 * Fresh-clone inheritance from a validated projection (PRD-011b / AC-6).
 *
 * Hash-matched files inherit nectar + description with zero LLM calls and zero
 * fuzzy matches. Writes are additive only: existing local nectars are never
 * overwritten.
 */
import { mintNectar, nectarCreatedAt } from "../hive-graph/ulid.js";
import type { HiveGraphRow, HiveGraphVersionRow, Tenancy } from "../hive-graph/model.js";
import type { PortableProjection, ProjectionFileEntry } from "./format.js";
import { buildContentHashMultiIndex } from "./load.js";

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
  // PRD-018i / NEC-019 AC-018i.5: inherited rows land in the enricher's
  // pending-selector-visible state (`pending`) with title/description/concepts
  // PRESERVED, and `embedding: null`. The enricher's re-embed path then computes
  // a 768-dim vector over the inherited `title + description` with NO LLM
  // describe call (AC-018i.6) and stamps `embed_model` on completion. Writing
  // them `described` (as before) left them invisible to the pending selector, so
  // a fresh clone's vector arm stayed permanently empty.
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
    embedModel: null,
    confidence: null,
    fingerprint: null,
    describedAt: entry.described_at,
    describeModel: entry.describe_model,
    describeStatus: "pending",
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
  const index = buildContentHashMultiIndex(doc);
  const existing = opts.existingNectars ?? new Set<string>();
  const observedAt = opts.nowIso ?? new Date().toISOString();

  const rows: InheritRow[] = [];
  let inherited = 0;
  let unmatched = 0;
  let skippedExisting = 0;

  // PRD-018i / NEC-037 AC-018i.9/.10: consume one projection entry per matched
  // path for a shared content hash so duplicate-content files each keep their own
  // nectar; when the on-disk duplicates outnumber the projection entries for that
  // hash, the surplus paths mint FRESH nectars (inheriting the identical
  // content's description) rather than reusing an already-consumed one.
  const consumed = new Map<string, number>();

  for (const [path, hash] of diskHashes) {
    const list = index.get(hash);
    if (list === undefined || list.length === 0) {
      unmatched += 1;
      continue;
    }

    const used = consumed.get(hash) ?? 0;
    if (used < list.length) {
      const hit = list[used] as { nectar: string; entry: ProjectionFileEntry };
      consumed.set(hash, used + 1);
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
    } else {
      // Surplus duplicate path: mint a fresh nectar carrying the identical
      // content's description. The originally-minted nectars are not reused, so
      // none is orphaned by a double assignment (AC-018i.10).
      const template = list[0] as { nectar: string; entry: ProjectionFileEntry };
      const nectar = mintNectar();
      const entry = { ...template.entry, path };
      rows.push({
        identity: toIdentity(nectar, entry, doc.derived, opts.tenancy),
        version: toVersion(nectar, entry, opts.tenancy, observedAt),
      });
      inherited += 1;
    }
  }

  return { inherited, unmatched, skippedExisting, rows };
}
