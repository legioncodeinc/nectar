/**
 * Scale-to-zero: `runEnricherCycle` must gate its durable working-set refresh on
 * `shouldRefresh`. When it returns false (an idle repo, per the registration
 * dirty-signal), the cycle issues NO Deep Lake refresh; when true (or absent),
 * it refreshes as before. Runs against the compiled module from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tenancy } from "../dist/hive-graph/model.js";
import { createOffProvider } from "../dist/embeddings/provider.js";
import { EnricherInMemoryStore, runEnricherCycle } from "../dist/enricher/index.js";

const TEN: Tenancy = { orgId: "legion", workspaceId: "eng", projectId: "nectar" };

/** Minimal idle-repo cycle deps: empty store, no LLM, a counting refresh spy. */
function idleDeps(refreshCalls: { n: number }, shouldRefresh?: () => boolean) {
  return {
    store: new EnricherInMemoryStore(),
    tenancy: TEN,
    readContent: { read: () => null },
    portkey: null,
    embedProvider: createOffProvider(),
    refreshWorkingSet: async () => {
      refreshCalls.n += 1;
    },
    ...(shouldRefresh !== undefined ? { shouldRefresh } : {}),
  };
}

test("shouldRefresh=false skips the Deep Lake refresh on an idle cycle", async () => {
  const calls = { n: 0 };
  await runEnricherCycle(idleDeps(calls, () => false));
  assert.equal(calls.n, 0, "an idle cycle must not read Deep Lake");
});

test("shouldRefresh=true performs the refresh", async () => {
  const calls = { n: 0 };
  await runEnricherCycle(idleDeps(calls, () => true));
  assert.equal(calls.n, 1);
});

test("absent shouldRefresh preserves the legacy always-refresh behavior", async () => {
  const calls = { n: 0 };
  await runEnricherCycle(idleDeps(calls)); // no shouldRefresh wired
  assert.equal(calls.n, 1);
});

test("consume-style gate refreshes once then goes quiet across cycles", async () => {
  const calls = { n: 0 };
  let armed = true; // one pending refresh, then idle forever
  const shouldRefresh = () => {
    const was = armed;
    armed = false;
    return was;
  };
  const deps = idleDeps(calls, shouldRefresh);
  await runEnricherCycle(deps);
  await runEnricherCycle(deps);
  await runEnricherCycle(deps);
  assert.equal(calls.n, 1, "only the armed cycle refreshes; later idle cycles read nothing");
});
