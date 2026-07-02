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
 * LIVE brood (the Wave D dormancy closure): `POST /api/hive-graph/build` now
 * invokes {@link runBroodAsync} against the daemon's durable async store when a
 * describe transport is wired (Portkey enabled). The sync/async split is bridged
 * by `runBroodAsync` (`brooding/pipeline-async.ts`), the async-native twin of
 * `runBrood`. When Portkey is NOT configured the brood mechanic is left unwired
 * so the endpoint keeps answering a structured 501 `build_unavailable` (an
 * LLM-less daemon genuinely cannot brood) - an honest creds-absent gate, never a
 * silent success. The handler itself (in-flight guard, already-running 409,
 * failure-as-data) is unchanged.
 */
import { HttpDeepLakeTransport } from "../hive-graph/deeplake-transport.js";
import { searchHiveGraph } from "../hive-graph/search.js";
import { resolveEmbeddingsConfig } from "../embeddings/config.js";
import { resolveEmbedProvider, type EmbedProvider } from "../embeddings/provider.js";
import { rebuildProjectionAsync, projectionFinalPath } from "../projection/write.js";
import { loadProjectionFromFile } from "../projection/load.js";
import { DEFAULT_PROJECTION_REL_PATH } from "../projection/format.js";
import { createDiskRegistrationFs } from "../registration/disk-fs.js";
import {
  runBroodAsync,
  type AsyncBroodConfig,
  type AsyncBroodRuntimeDeps,
} from "../brooding/pipeline-async.js";
import type { DescribeFn } from "../brooding/describe.js";
import type { GitLsFiles } from "../brooding/discovery.js";
import type { PackBatchesOptions } from "../brooding/bucketing.js";
import { wrapAsyncStoreWithMetrics } from "../telemetry/metrics.js";
import type { PipelineMetricsSink } from "../telemetry/metrics.js";
import { readHiveGraphStatusOverStorage } from "./status-query.js";
import type { BuildArgs, MountHiveGraphOptions } from "./hive-graph-api.js";
import type { AsyncHiveGraphStore } from "../hive-graph/store.js";
import type { DeepLakeCredentials } from "../hive-graph/deeplake-credentials.js";
import type { Tenancy } from "../hive-graph/model.js";
import type { RegistrationFs } from "../registration/service.js";
import type { PortkeyRuntimeConfig } from "../portkey/config.js";
import type { PortkeyFetch } from "../portkey/transport.js";
import type { EmbedClient, StorageQuery } from "../hive-graph/search-types.js";

/**
 * The brood-wiring seam for the live `POST /api/hive-graph/build` endpoint. When
 * {@link portkey} is enabled the build endpoint runs the real async brood
 * (bridged by `runBroodAsync`); when it is disabled the brood mechanic is left
 * unwired so the endpoint honestly answers 501 `build_unavailable`.
 */
export interface DaemonBroodWiring {
  /** Portkey creds. The live build path is wired only when `portkey.enabled`. */
  readonly portkey: PortkeyRuntimeConfig;
  /** Metrics sink so live brood writes move the PRD-017 counters (default: none). */
  readonly metrics?: PipelineMetricsSink;
  /** Filesystem seam (default: `createDiskRegistrationFs(projectRoot)`). Tests inject a fake. */
  readonly fs?: RegistrationFs;
  /** git-ls-files seam (default: spawns git). Tests inject a fake. */
  readonly gitLsFiles?: GitLsFiles;
  /** Test seam: inject the describe transport directly (bypasses the Portkey HTTP path). */
  readonly describe?: DescribeFn;
  /** Injectable fetch for the default Portkey describe transport (tests). */
  readonly fetch?: PortkeyFetch;
  /** Embedding provider (default: resolved from the embeddings config). */
  readonly embedProvider?: EmbedProvider;
  /** Dynamic batch-packing overrides (default: the decision #22 constants). */
  readonly packOptions?: PackBatchesOptions;
}

/** The context the live daemon supplies to build its `/api/hive-graph` mechanics. */
export interface DaemonHiveGraphWiring {
  readonly credentials: DeepLakeCredentials;
  readonly tenancy: Tenancy;
  readonly projectRoot: string;
  readonly store: AsyncHiveGraphStore;
  /** Reads the daemon's cumulative brood cost for the status endpoint (there is no durable cost table). */
  readonly costSpentUsd: () => number;
  /**
   * Brood wiring for the live build endpoint. Absent, or present with Portkey
   * disabled, keeps the endpoint at 501 `build_unavailable` (honest creds gate).
   */
  readonly brood?: DaemonBroodWiring;
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

  const runBrood = resolveLiveBrood(wiring, embedProvider);

  return {
    defaultScope: wiring.tenancy,
    searchHiveGraph: (query, scope, limit) => searchHiveGraph(query, scope, limit, searchDeps),
    ...(runBrood !== undefined ? { runBrood } : {}),
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

/**
 * Build the live `runBrood` mechanic for the build endpoint, or `undefined` when
 * no describe transport is configured (Portkey disabled / no brood wiring), in
 * which case the endpoint stays at its honest 501 `build_unavailable`. When
 * wired, each `/build` request runs {@link runBroodAsync} against the daemon's
 * durable async store - wrapped with the telemetry metrics sink so the PRD-017
 * counters move on the live path - scoped to the per-request tenancy.
 */
function resolveLiveBrood(
  wiring: DaemonHiveGraphWiring,
  defaultEmbedProvider: EmbedProvider,
): ((args: BuildArgs) => Promise<unknown>) | undefined {
  const brood = wiring.brood;
  if (brood === undefined || !brood.portkey.enabled) return undefined;
  const portkey = brood.portkey; // narrowed to PortkeyEnabled

  return async (args: BuildArgs): Promise<unknown> => {
    const baseStore = brood.metrics !== undefined ? wrapAsyncStoreWithMetrics(wiring.store, brood.metrics) : wiring.store;
    const config: AsyncBroodConfig = {
      store: baseStore,
      tenancy: args.scope,
      root: wiring.projectRoot,
      fs: brood.fs ?? createDiskRegistrationFs(wiring.projectRoot),
      ...(brood.gitLsFiles !== undefined ? { gitLsFiles: brood.gitLsFiles } : {}),
      ...(brood.packOptions !== undefined ? { packOptions: brood.packOptions } : {}),
    };
    const deps: AsyncBroodRuntimeDeps = {
      portkey,
      embedProvider: brood.embedProvider ?? defaultEmbedProvider,
      ...(brood.describe !== undefined ? { describe: brood.describe } : {}),
      ...(brood.fetch !== undefined ? { fetch: brood.fetch } : {}),
    };
    return runBroodAsync(config, deps, { force: args.force, limit: args.limit, model: args.model });
  };
}
