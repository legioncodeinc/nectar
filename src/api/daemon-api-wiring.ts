/**
 * Production wiring for the `/api/hive-graph` handlers (PRD-008b/008c).
 *
 * Builds the {@link MountHiveGraphOptions} the live `nectar daemon` mounts:
 * the injected mechanics bound to the daemon's OWN store + embed deps, reaching
 * Deep Lake solely through nectar's client (FR-6). This is where the daemon
 * imports the PRD-012a engine (`searchHiveGraph`) — the DAEMON is the engine's
 * client; the `nectar search` CLI stays a thin loopback client that never
 * imports it (AC-012b.3.1).
 *
 * Deferred (documented): `runBrood` is intentionally omitted. `runBrood`
 * consumes the SYNCHRONOUS `HiveGraphStore`, while the only durable substrate
 * (`DeepLakeHiveGraphStore`) is asynchronous; the sync/async bridge is deferred
 * by earlier waves (see `AsyncHiveGraphStore`'s docblock, and the daemon's
 * auto-brood which is likewise dormant until a sync `broodStore` is wired). Until
 * that lands, `POST /api/hive-graph/build` answers a structured 501
 * `build_unavailable` rather than pretending to brood. The handler itself
 * (in-flight guard, already-running 409, failure-as-data) is fully implemented
 * and tested with an injected runner.
 */
import { HttpDeepLakeTransport } from "../hive-graph/deeplake-transport.js";
import { searchHiveGraph } from "../hive-graph/search.js";
import { resolveEmbeddingsConfig } from "../embeddings/config.js";
import { resolveEmbedProvider } from "../embeddings/provider.js";
import { rebuildProjectionAsync, projectionFinalPath } from "../projection/write.js";
import { loadProjectionFromFile } from "../projection/load.js";
import { DEFAULT_PROJECTION_REL_PATH } from "../projection/format.js";
import { readHiveGraphStatusOverStorage } from "./status-query.js";
import type { MountHiveGraphOptions } from "./hive-graph-api.js";
import type { AsyncHiveGraphStore } from "../hive-graph/store.js";
import type { DeepLakeCredentials } from "../hive-graph/deeplake-credentials.js";
import type { Tenancy } from "../hive-graph/model.js";
import type { EmbedClient, StorageQuery } from "../hive-graph/search-types.js";

/** The context the live daemon supplies to build its `/api/hive-graph` mechanics. */
export interface DaemonHiveGraphWiring {
  readonly credentials: DeepLakeCredentials;
  readonly tenancy: Tenancy;
  readonly projectRoot: string;
  readonly store: AsyncHiveGraphStore;
  /** Reads the daemon's cumulative brood cost for the status endpoint (there is no durable cost table). */
  readonly costSpentUsd: () => number;
}

/**
 * Build the {@link MountHiveGraphOptions} for the live daemon. Search delegates
 * to the PRD-012a engine over a {@link StorageQuery} wrapping the daemon's Deep
 * Lake transport (org/workspace ride the transport headers; `project_id` is in
 * the SQL the engine builds), with the configured embed provider adapted to the
 * engine's single-text {@link EmbedClient} contract. Status/projection are wired
 * to the real fail-soft mechanics.
 */
export function buildHiveGraphApiOptions(wiring: DaemonHiveGraphWiring): MountHiveGraphOptions {
  const transport = new HttpDeepLakeTransport({
    endpoint: wiring.credentials.apiUrl,
    token: wiring.credentials.token,
    orgId: wiring.credentials.orgId,
    workspaceId: wiring.credentials.workspaceId,
  });
  const storage: StorageQuery = { query: (sql) => transport.query(sql) };

  const embeddingsConfig = resolveEmbeddingsConfig({});
  const embedProvider = resolveEmbedProvider(embeddingsConfig);
  // Adapt the batch EmbedProvider to the engine's single-text EmbedClient. When
  // embeddings are off, omit the client entirely so the engine runs lexical-only.
  const embed: EmbedClient | undefined =
    embeddingsConfig.selector === "off"
      ? undefined
      : { embed: async (text: string) => (await embedProvider.embed([text]))[0] ?? null };

  const searchDeps = embed !== undefined ? { storage, embed } : { storage };

  return {
    defaultScope: wiring.tenancy,
    searchHiveGraph: (query, scope, limit) => searchHiveGraph(query, scope, limit, searchDeps),
    readStatus: (scope) => readHiveGraphStatusOverStorage(storage, scope, { costSpentUsd: wiring.costSpentUsd() }),
    readProjection: async (scope) => {
      const path = projectionFinalPath(wiring.projectRoot, DEFAULT_PROJECTION_REL_PATH);
      const result = loadProjectionFromFile(path, { tenancy: scope });
      return result.ok ? result.doc : { present: false, reason: result.reason };
    },
    rebuildProjection: async (scope) => {
      const { doc } = await rebuildProjectionAsync(wiring.store, scope, { projectRoot: wiring.projectRoot });
      return { regenerated: true, nectarsCount: Object.keys(doc.files).length, generatedAt: doc.generated_at };
    },
  };
}
