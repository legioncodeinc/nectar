/**
 * Build a portable projection from store state (PRD-011a / AC-3).
 *
 * Pure generation core plus a store-backed entry point via the thin adapter in
 * `store-adapter.ts`.
 */
import type { Tenancy } from "../hive-graph/model.js";
import type { AsyncHiveGraphStore, HiveGraphStore } from "../hive-graph/store.js";
import {
  DEFAULT_GENERATOR,
  PROJECTION_SCHEMA_VERSION,
  type PortableProjection,
  type ProjectionDerivedEntry,
  type ProjectionFileEntry,
  type ProjectionProject,
} from "./format.js";
import {
  collectProjectionSources,
  collectProjectionSourcesAsync,
  type CollectProjectionSourcesOptions,
  type ProjectionNectarSource,
} from "./store-adapter.js";

export interface BuildProjectionOptions {
  readonly generatedAt?: string;
  readonly generator?: string;
}

function parseConcepts(raw: string): string[] {
  if (raw === "" || raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function toFileEntry(version: ProjectionNectarSource["version"]): ProjectionFileEntry {
  const described = version.describeStatus === "described";
  return {
    content_hash: version.contentHash,
    path: version.path,
    title: described ? version.title : "",
    description: described ? version.description : "",
    concepts: described ? parseConcepts(version.concepts) : [],
    describe_model: described ? version.describeModel : "",
    described_at: described ? version.describedAt : "",
  };
}

function toDerivedEntry(identity: ProjectionNectarSource["identity"]): ProjectionDerivedEntry | undefined {
  if (identity.derivedFromNectar === "" && identity.forkContentHash === "") return undefined;
  if (identity.derivedFromNectar === "" || identity.forkContentHash === "") return undefined;
  return {
    from_nectar: identity.derivedFromNectar,
    fork_content_hash: identity.forkContentHash,
  };
}

function tenancyToProject(t: Tenancy): ProjectionProject {
  return {
    org_id: t.orgId,
    workspace_id: t.workspaceId,
    project_id: t.projectId,
  };
}

/** Pure builder from pre-selected nectar/version rows. */
export function buildProjection(
  tenancy: Tenancy,
  sources: readonly ProjectionNectarSource[],
  opts: BuildProjectionOptions = {},
): PortableProjection {
  const files: Record<string, ProjectionFileEntry> = {};
  const derived: Record<string, ProjectionDerivedEntry> = {};

  const sorted = [...sources].sort((a, b) => a.identity.nectar.localeCompare(b.identity.nectar));
  for (const { identity, version } of sorted) {
    files[identity.nectar] = toFileEntry(version);
    const d = toDerivedEntry(identity);
    if (d !== undefined) derived[identity.nectar] = d;
  }

  return {
    version: PROJECTION_SCHEMA_VERSION,
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    generator: opts.generator ?? DEFAULT_GENERATOR,
    project: tenancyToProject(tenancy),
    files,
    derived,
  };
}

export interface BuildProjectionFromStoreOptions extends BuildProjectionOptions, CollectProjectionSourcesOptions {}

/** Scan the store and build a complete projection document. */
export function buildProjectionFromStore(
  store: HiveGraphStore,
  tenancy: Tenancy,
  opts: BuildProjectionFromStoreOptions = {},
): PortableProjection {
  const sources = collectProjectionSources(store, tenancy, opts);
  return buildProjection(tenancy, sources, opts);
}

/**
 * Scan the durable {@link AsyncHiveGraphStore} (Deep Lake) and build a
 * complete projection document (PRD-011c). The async twin of
 * {@link buildProjectionFromStore}: it collects the projection sources via
 * {@link collectProjectionSourcesAsync} (latest described version per nectar,
 * scoped to the project) and denormalizes them through the SAME pure
 * {@link buildProjection} core, so the async path produces byte-identical
 * output to the sync one for the same state (modulo `generated_at`).
 */
export async function buildProjectionFromAsyncStore(
  store: AsyncHiveGraphStore,
  tenancy: Tenancy,
  opts: BuildProjectionOptions = {},
): Promise<PortableProjection> {
  const sources = await collectProjectionSourcesAsync(store, tenancy);
  return buildProjection(tenancy, sources, opts);
}
