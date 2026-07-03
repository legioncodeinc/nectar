import { test } from "node:test";
import assert from "node:assert/strict";

import { EMBED_DIMS } from "../dist/hive-graph/model.js";
import { loadDeepLakeCredentials } from "../dist/hive-graph/deeplake-credentials.js";
import { DeepLakeHiveGraphStore } from "../dist/hive-graph/deeplake-store.js";
import { HttpDeepLakeTransport, TransportError } from "../dist/hive-graph/deeplake-transport.js";
import { searchHiveGraph, type QueryScope } from "../dist/hive-graph/search.js";
import { mintNectar, nectarCreatedAt } from "../dist/hive-graph/ulid.js";
import { sha256Hex } from "../dist/hive-graph/hash.js";
import { filenameOf, extOf } from "../dist/hive-graph/paths.js";

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unitVector(firstValue: number): number[] {
  const vector = Array.from({ length: EMBED_DIMS }, () => 0);
  vector[0] = firstValue;
  return vector;
}

function identityRow(nectar: string, tenancy: QueryScope, now: string) {
  return {
    nectar,
    kind: "file" as const,
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: "",
    forkContentHash: "",
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };
}

function versionRow(nectar: string, tenancy: QueryScope, now: string, path: string, embedding: number[]) {
  const content = `018h vector ordering probe for ${path} at ${now}`;
  return {
    nectar,
    contentHash: sha256Hex(content),
    seq: 0,
    path,
    filename: filenameOf(path),
    ext: extOf(path),
    sizeBytes: content.length,
    mtimeObserved: now,
    title: `018h vector probe ${path}`,
    description: "A throwaway row written by the PRD-018h live vector ordering probe.",
    concepts: '["018h","vector-ordering"]',
    embedding,
    confidence: 1,
    fingerprint: `H1${sha256Hex(path).slice(0, 12)}`,
    describedAt: now,
    describeModel: "test",
    describeStatus: "described" as const,
    observedAt: now,
    orgId: tenancy.orgId,
    workspaceId: tenancy.workspaceId,
    projectId: tenancy.projectId,
    lastUpdateDate: now,
  };
}

test("018h-AC-1 live Deep Lake vector ordering probe ranks the near vector first", async (t) => {
  let credentials: ReturnType<typeof loadDeepLakeCredentials>;
  try {
    credentials = loadDeepLakeCredentials();
  } catch (err) {
    t.skip(`Deep Lake credentials unavailable at ~/.deeplake/credentials.json, skipping vector ordering probe: ${describeErr(err)}`);
    return;
  }

  const tenancy = {
    orgId: credentials.orgId,
    workspaceId: credentials.workspaceId,
    projectId: `nectar-prd018h-vector-probe-${Date.now()}`,
  };
  const nearNectar = mintNectar();
  const farNectar = mintNectar();
  const now = new Date().toISOString();
  const queryVector = unitVector(1);
  const nearVector = unitVector(1);
  const farVector = unitVector(-1);
  const store = new DeepLakeHiveGraphStore({ credentials });
  const transport = new HttpDeepLakeTransport({
    endpoint: credentials.apiUrl,
    token: credentials.token,
    orgId: credentials.orgId,
    workspaceId: credentials.workspaceId,
  });

  try {
    await store.insertIdentity(identityRow(nearNectar, tenancy, now));
    await store.insertIdentity(identityRow(farNectar, tenancy, now));
    await store.appendVersion(versionRow(nearNectar, tenancy, now, "src/018h-near-vector.ts", nearVector));
    await store.appendVersion(versionRow(farNectar, tenancy, now, "src/018h-far-vector.ts", farVector));

    // The query text must NOT match either row lexically: if the lexical arm
    // corroborates both rows, RRF fusion produces an exact tie (rank 1 + rank 2
    // on each side) and the fused order stops reflecting the vector ordering
    // this probe exists to measure. A nonsense term keeps the lexical arm
    // empty so the fused order is purely the semantic arm's.
    const probeQuery = "qqzzxxsemanticonlyprobe";
    // Freshly appended rows are not always immediately visible to queries on
    // this backend, so poll (bounded) until both probe rows surface before
    // asserting anything about their order.
    const maxAttempts = 40;
    const attemptDelayMs = 5000;
    let result = await searchHiveGraph(probeQuery, tenancy, 2, {
      storage: {
        query: async (sql) => transport.query(sql),
      },
      embed: {
        embed: async () => queryVector,
      },
    });
    for (let attempt = 1; result.hits.length < 2 && attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attemptDelayMs));
      result = await searchHiveGraph(probeQuery, tenancy, 2, {
        storage: {
          query: async (sql) => transport.query(sql),
        },
        embed: {
          embed: async () => queryVector,
        },
      });
    }

    assert.equal(result.arms.semantic.status, "ok", `semantic arm did not complete: ${JSON.stringify(result.arms.semantic)}`);
    assert.equal(
      result.hits.length,
      2,
      `probe rows never became visible to queries after ${maxAttempts} attempts; ` +
        `cannot determine ordering. Observed ids: ${result.hits.map((hit) => hit.id).join(", ") || "(none)"}`,
    );
    assert.equal(result.hits[0]?.id, nearNectar, [
      "Deep Lake <#> ordering probe ranked the far vector before the near vector.",
      "Do not change this test to pass by fixture order.",
      "Run the measured-contract fix for PRD-018h.2 before release.",
      `Observed ids: ${result.hits.map((hit) => hit.id).join(", ")}`,
    ].join(" "));
  } catch (err) {
    // Only genuine connectivity failures may skip. A 4xx `query`-kind error
    // after credentials loaded is a REAL failure (schema drift, heal bug, bad
    // SQL) and must fail the release gate, not silently skip it (PRD-018 QA
    // finding: an embed_model heal bug hid behind this skip). A 5xx from the
    // backend (e.g. 'failed to get database connection') is server-side
    // unreachability, the same class as connection/timeout, and may skip.
    if (
      err instanceof TransportError &&
      (err.kind === "connection" || err.kind === "timeout" || (err.status !== undefined && err.status >= 500))
    ) {
      t.skip(`Deep Lake unreachable, skipping vector ordering probe: ${err.message}`);
      return;
    }
    throw err;
  } finally {
    await store.deleteNectar(tenancy, nearNectar).catch((cleanupErr: unknown) => {
      console.log(`[hive-graph-search-live.test] cleanup failed for near nectar ${nearNectar}: ${describeErr(cleanupErr)}`);
    });
    await store.deleteNectar(tenancy, farNectar).catch((cleanupErr: unknown) => {
      console.log(`[hive-graph-search-live.test] cleanup failed for far nectar ${farNectar}: ${describeErr(cleanupErr)}`);
    });
  }
});
