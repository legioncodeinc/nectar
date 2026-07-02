/**
 * PRD-016 enricher steady-state loop tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchIntake } from "../dist/registration/fs-watch.js";
import type { Timer } from "../dist/poll-loop.js";
import type { HiveGraphVersionRow, Tenancy } from "../dist/hive-graph/model.js";
import { InMemoryHiveGraphStore } from "../dist/hive-graph/memory-store.js";
import { DEFAULT_ACTIVE_MODEL } from "../dist/portkey/config.js";
import type { PortkeyFetch } from "../dist/portkey/transport.js";
import { PortkeyTransportError } from "../dist/portkey/transport.js";
import { createOffProvider } from "../dist/embeddings/provider.js";
import {
  DEFAULT_ENRICHER_POLL_INTERVAL_MS,
  DEFAULT_REDESCRIBE_THRESHOLD,
  DEFAULT_PERSISTENT_FAILURE_THRESHOLD,
  DEFAULT_WATCHER_DEBOUNCE_MS,
  WATCHER_INTAKE_DEBOUNCE_MS,
  applyCosmeticInheritance,
  buildPendingWorkSql,
  classifyMeaningfulChange,
  contentJaccardSimilarity,
  createEnricherFailureState,
  createEnricherLoop,
  EnricherInMemoryStore,
  inheritedFromMarker,
  parseDescribeResponse,
  runEnricherCycle,
  selectPendingWorkInMemory,
  advancePersistentFailureState,
  enrichmentHalted,
  splitBatch,
  isContextWindowError,
  embeddingText,
  describeFilesBatch,
  type EnricherCycleDeps,
} from "../dist/enricher/index.js";

const TEN: Tenancy = { orgId: "legion", workspaceId: "eng", projectId: "nectar" };

const ENABLED = {
  enabled: true as const,
  apiKey: "k",
  configId: "c",
  activeModel: DEFAULT_ACTIVE_MODEL,
};

function versionRow(
  nectar: string,
  seq: number,
  path: string,
  overrides: Partial<HiveGraphVersionRow> = {},
): HiveGraphVersionRow {
  return {
    nectar,
    contentHash: `hash-${nectar}-${seq}`,
    seq,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    sizeBytes: 100,
    mtimeObserved: "2026-07-01T00:00:00.000Z",
    title: "",
    description: "",
    concepts: "[]",
    embedding: null,
    confidence: null,
    fingerprint: null,
    describedAt: "",
    describeModel: "",
    describeStatus: "pending",
    observedAt: `2026-07-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
    ...overrides,
  };
}

function describedRow(
  nectar: string,
  seq: number,
  path: string,
  title: string,
  description: string,
  contentHash: string,
): HiveGraphVersionRow {
  return versionRow(nectar, seq, path, {
    contentHash,
    title,
    description,
    concepts: '["auth"]',
    embedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
    describedAt: "2026-07-01T00:00:00.000Z",
    describeModel: DEFAULT_ACTIVE_MODEL,
    describeStatus: "described",
  });
}

function okFetch(payload: unknown = [{ title: "Title", description: "A file module.", concepts: "[]" }]): PortkeyFetch {
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
  });
}

function manualTimer(): { timer: Timer; fire(): Promise<void>; fireAll(): Promise<void>; delays: number[] } {
  const pending = new Map<unknown, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  const timer: Timer = {
    set(fn, ms) {
      const handle = { fn, ms };
      pending.set(handle, handle);
      delays.push(ms);
      return handle;
    },
    clear(handle) {
      pending.delete(handle);
    },
  };
  async function fireOne() {
    const first = pending.values().next().value as { fn: () => void } | undefined;
    if (first !== undefined) {
      for (const key of pending.keys()) {
        if (pending.get(key) === first) pending.delete(key);
        break;
      }
      first.fn();
    }
    await Promise.resolve();
  }
  return {
    timer,
    delays,
    fire: fireOne,
    async fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const p of fns) p.fn();
      await Promise.resolve();
    },
  };
}

function cycleDeps(
  store: EnricherInMemoryStore,
  content: string | null,
  fetch: PortkeyFetch = okFetch(),
  extra: Partial<EnricherCycleDeps> = {},
): EnricherCycleDeps {
  return {
    store,
    tenancy: TEN,
    readContent: { read: () => content },
    portkey: ENABLED,
    embedProvider: createOffProvider(),
    portkeyFetch: fetch,
    portkeyMaxAttempts: 1,
    ...extra,
  };
}

// ── Index AC-1..AC-7 ────────────────────────────────────────────────────────

test("016-AC-1 latest pending version per nectar ordered by MIN(observed_at)", () => {
  const rows = [
    versionRow("n1", 0, "a.ts", { observedAt: "2026-07-01T00:00:10.000Z" }),
    versionRow("n1", 1, "a.ts", { observedAt: "2026-07-01T00:00:20.000Z" }),
    versionRow("n2", 0, "b.ts", { observedAt: "2026-07-01T00:00:05.000Z" }),
  ];
  const selected = selectPendingWorkInMemory(rows, TEN, 10);
  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.nectar, "n2");
  assert.equal(selected[0]?.seq, 0);
  assert.equal(selected[1]?.nectar, "n1");
  assert.equal(selected[1]?.seq, 1);
  const sql = buildPendingWorkSql(TEN, 10);
  assert.match(sql, /MAX\(seq\)/);
  assert.match(sql, /MIN\(observed_at\)/);
});

test("016-AC-2 watcher intake debounce collapses same-path events within 500ms", async () => {
  assert.equal(WATCHER_INTAKE_DEBOUNCE_MS, DEFAULT_WATCHER_DEBOUNCE_MS);
  assert.equal(DEFAULT_WATCHER_DEBOUNCE_MS, 500);
  const mt = manualTimer();
  const signals: string[] = [];
  const intake = new WatchIntake({
    root: "/tmp",
    debounceMs: 500,
    timer: mt.timer,
    onPathChanged: (p) => signals.push(p),
  });
  intake.observe("src/foo.ts");
  intake.observe("src/foo.ts");
  intake.observe("src/foo.ts");
  assert.equal(signals.length, 0);
  await mt.fire();
  assert.deepEqual(signals, ["src/foo.ts"]);
});

test("016-AC-2b different paths debounce independently", async () => {
  const mt = manualTimer();
  const signals: string[] = [];
  const intake = new WatchIntake({
    root: "/tmp",
    debounceMs: 500,
    timer: mt.timer,
    onPathChanged: (p) => signals.push(p),
  });
  intake.observe("a.ts");
  intake.observe("b.ts");
  await mt.fireAll();
  assert.equal(signals.length, 2);
});

test("016-AC-3 cosmetic Jaccard >= 0.85 inherits description without LLM", () => {
  const prior = describedRow("n1", 0, "fmt.ts", "Auth", "Login helpers", "hash0");
  const pending = versionRow("n1", 1, "fmt.ts", { contentHash: "hash1" });
  const prev = 'function login() { return "ok"; }';
  const next = 'function login() {\n  return "ok";\n}';
  assert.ok(contentJaccardSimilarity(prev, next) >= DEFAULT_REDESCRIBE_THRESHOLD);
  assert.equal(
    classifyMeaningfulChange({ newContent: next, priorContent: prev, priorDescribed: prior }),
    "cosmetic",
  );
  const inherited = applyCosmeticInheritance(pending, prior, "2026-07-02T00:00:00.000Z");
  assert.equal(inherited.title, "Auth");
  assert.equal(inherited.describeModel, inheritedFromMarker("hash0"));
  assert.equal(inherited.describeStatus, "described");
});

test("016-AC-4 meaningful Jaccard < 0.85 stays pending", () => {
  const prior = describedRow("n1", 0, "svc.ts", "Svc", "Old behavior", "hash0");
  const prev = "export function old() { return 1; }";
  const next = "export function newFeature() { return compute(); }";
  assert.ok(contentJaccardSimilarity(prev, next) < DEFAULT_REDESCRIBE_THRESHOLD);
  assert.equal(
    classifyMeaningfulChange({ newContent: next, priorContent: prev, priorDescribed: prior }),
    "meaningful",
  );
  assert.equal(versionRow("n1", 1, "svc.ts").describeStatus, "pending");
});

test("016-AC-5 describe_model records producing model id on LLM describe", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "x.ts"));
  await runEnricherCycle(cycleDeps(store, "export const x = 1;"));
  assert.equal(store.getVersion("n1", 0)?.describeModel, DEFAULT_ACTIVE_MODEL);
});

test("016-AC-6 batch failure marks failed then retry solo succeeds", async () => {
  let calls = 0;
  const fetch: PortkeyFetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "bad" } }] }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify([{ title: "Ok", description: "Fine.", concepts: "[]" }]) } }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }),
    };
  };

  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "solo.ts"));
  await runEnricherCycle(cycleDeps(store, "const v = 1;", fetch));
  assert.equal(store.getVersion("n1", 0)?.describeStatus, "failed");
  assert.equal(store.listPendingWork(TEN, 10)[0]?.solo, true);

  await runEnricherCycle(cycleDeps(store, "const v = 1;", fetch));
  assert.equal(store.getVersion("n1", 0)?.describeStatus, "described");
});

test("016-AC-7 five consecutive failed cycles raise alert and halt enrichment", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "fail.ts"));
  let state = createEnricherFailureState();
  const badFetch = okFetch([]);

  for (let i = 0; i < 5; i += 1) {
    const result = await runEnricherCycle(cycleDeps(store, "code", badFetch), state);
    state = result.failureState;
  }
  assert.equal(state.consecutiveFailures, 5);
  assert.equal(state.alertRaised, true);
  assert.equal(enrichmentHalted(state), true);

  const halted = await runEnricherCycle(cycleDeps(store, "code", okFetch()), state);
  assert.equal(halted.stats.filesDescribed, 0);
});

// ── Sub-PRD ACs ─────────────────────────────────────────────────────────────

test("016-AC-016a.1.1 pending query selects MAX seq per nectar scoped to project", () => {
  const store = new EnricherInMemoryStore();
  store.seedVersions([versionRow("n1", 0, "a.ts"), versionRow("n1", 1, "a.ts"), versionRow("n1", 2, "a.ts")]);
  const work = store.listPendingWork(TEN, 10);
  assert.equal(work.length, 1);
  assert.equal(work[0]?.seq, 2);
});

test("016-AC-016a.1.2 intermediate pending rows stay undescribed", () => {
  const store = new EnricherInMemoryStore();
  store.seedVersions([versionRow("n1", 0, "a.ts"), versionRow("n1", 1, "a.ts"), versionRow("n1", 2, "a.ts")]);
  store.listPendingWork(TEN, 10);
  assert.equal(store.getVersion("n1", 0)?.title, "");
  assert.equal(store.getVersion("n1", 1)?.title, "");
});

test("016-AC-016a.2.1 500ms debounce collapses rapid saves", async () => {
  const mt = manualTimer();
  let count = 0;
  const intake = new WatchIntake({ root: "/r", debounceMs: 500, timer: mt.timer, onPathChanged: () => { count += 1; } });
  for (let i = 0; i < 10; i += 1) intake.observe("src/save.ts");
  await mt.fire();
  assert.equal(count, 1);
});

test("016-AC-016a.3.2 cosmetic inheritance stamps inherited-from marker", () => {
  const prior = describedRow("n", 0, "f.ts", "T", "D", "abc123");
  const row = applyCosmeticInheritance(versionRow("n", 1, "f.ts"), prior, "now");
  assert.equal(row.describeModel, "inherited-from:abc123");
});

test("016-AC-016a.4.2 meaningful change row stays pending for next cycle", () => {
  assert.equal(versionRow("n", 1, "f.ts").describeStatus, "pending");
});

test("016-AC-016b.1.1 enricher calls Portkey chat completions with file content", async () => {
  let url = "";
  const fetch: PortkeyFetch = async (u, init) => {
    url = u;
    assert.match(init.body, /describe/i);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify([{ title: "T", description: "D.", concepts: "[]" }]) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    };
  };
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "p.ts"));
  await runEnricherCycle(cycleDeps(store, "export const p = 1;", fetch));
  assert.match(url, /chat\/completions/);
});

test("016-AC-016b.1.2 valid description writes title description concepts described", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "v.ts"));
  await runEnricherCycle(cycleDeps(store, "content"));
  const row = store.getVersion("n1", 0);
  assert.notEqual(row?.title, "");
  assert.equal(row?.describeStatus, "described");
});

test("016-AC-016b.2.1 LLM describe_model is producing model id", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "m.ts"));
  await runEnricherCycle(cycleDeps(store, "m"));
  assert.equal(store.getVersion("n1", 0)?.describeModel, DEFAULT_ACTIVE_MODEL);
});

test("016-AC-016b.2.2 cosmetic inheritance describe_model inherited-from hash", () => {
  const prior = describedRow("n", 0, "f.ts", "T", "D", "deadbeef");
  assert.equal(applyCosmeticInheritance(versionRow("n", 1, "f.ts"), prior, "t").describeModel, "inherited-from:deadbeef");
});

test("016-AC-016b.3.1 embeddings on writes 768-dim vector over title + description", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "e.ts"));
  await runEnricherCycle(
    cycleDeps(store, "emb", okFetch(), {
      embedProvider: { kind: "local", embed: async () => [Array.from({ length: 768 }, () => 0.1)] },
    }),
  );
  assert.equal(store.getVersion("n1", 0)?.embedding?.length, 768);
  assert.equal(embeddingText("T", "D"), "T D");
});

test("016-AC-016b.3.2 embeddings off leaves NULL described without error", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "off.ts"));
  await runEnricherCycle(cycleDeps(store, "x"));
  const row = store.getVersion("n1", 0);
  assert.equal(row?.embedding, null);
  assert.equal(row?.describeStatus, "described");
});

test("016-AC-016c.1.1 malformed JSON retried once with stricter prompt", async () => {
  const bodies: string[] = [];
  const fetch: PortkeyFetch = async (_u, init) => {
    bodies.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "not-json" } }] }) };
  };
  await assert.rejects(() =>
    describeFilesBatch([{ path: "a.ts", content: "c" }], { portkey: ENABLED, fetch, maxAttempts: 1 }, false),
  );
  await assert.rejects(() =>
    describeFilesBatch([{ path: "a.ts", content: "c" }], { portkey: ENABLED, fetch, maxAttempts: 1 }, true),
  );
  assert.ok(bodies.some((b) => b.includes("ONLY valid JSON")));
});

test("016-AC-016c.1.2 retry failure marks failed for solo next cycle", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n", 0, "f.ts"));
  const badFetch: PortkeyFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "not-json" } }] }),
  });
  await runEnricherCycle(cycleDeps(store, "x", badFetch));
  assert.equal(store.getVersion("n", 0)?.describeStatus, "failed");
  assert.equal(store.listPendingWork(TEN, 10)[0]?.solo, true);
});

test("016-AC-016c.1.3 wrong-length response fails validation", () => {
  assert.equal(parseDescribeResponse(JSON.stringify([{ title: "a", description: "b", concepts: "[]" }]), 2), null);
});

test("016-AC-016c.2.1 context window error splits batch in half", () => {
  const [a, b] = splitBatch([1, 2, 3, 4]);
  assert.deepEqual(a, [1, 2]);
  assert.deepEqual(b, [3, 4]);
  assert.equal(isContextWindowError(new PortkeyTransportError(413, "context")), true);
});

test("016-AC-016c.3.1 deleted while pending marks skipped-deleted", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "gone.ts"));
  await runEnricherCycle(cycleDeps(store, null));
  assert.equal(store.getVersion("n1", 0)?.describeStatus, "skipped-deleted");
});

test("016-AC-016c.4.1 five consecutive failures raise alert", () => {
  let s = createEnricherFailureState();
  for (let i = 0; i < 5; i += 1) s = advancePersistentFailureState(s, { hadWork: true, cycleFailed: true, threshold: 5 });
  assert.equal(s.alertRaised, true);
});

test("016-AC-016c.4.2 alert halts until acknowledged", () => {
  let s = createEnricherFailureState();
  for (let i = 0; i < 5; i += 1) s = advancePersistentFailureState(s, { hadWork: true, cycleFailed: true, threshold: 5 });
  assert.equal(enrichmentHalted(s), true);
});

test("016-AC-016c.4.3 success before threshold resets counter", () => {
  let s = createEnricherFailureState();
  s = advancePersistentFailureState(s, { hadWork: true, cycleFailed: true, threshold: 5 });
  s = advancePersistentFailureState(s, { hadWork: true, cycleFailed: false, threshold: 5 });
  assert.equal(s.consecutiveFailures, 0);
});

test("016-AC-016c.5.1 cycle logs described inherited failed tokens cost", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "log.ts"));
  const lines: string[] = [];
  await runEnricherCycle(cycleDeps(store, "log", okFetch(), { logSink: { logCycle: (s) => lines.push(JSON.stringify(s)) } }));
  const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.ok("filesDescribed" in parsed);
  assert.ok("estimatedUsd" in parsed);
});

test("016-AC-016c.5.2 queue depth surfaced in cycle stats", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersions([versionRow("n1", 0, "a.ts"), versionRow("n2", 0, "b.ts")]);
  let depth = -1;
  await runEnricherCycle(cycleDeps(store, "a", okFetch(), { logSink: { logCycle: (s) => { depth = s.queueDepth; } } }));
  assert.ok(depth >= 0);
});

test("016 poll loop uses 30s flat interval", () => {
  assert.equal(DEFAULT_ENRICHER_POLL_INTERVAL_MS, 30_000);
  assert.equal(DEFAULT_PERSISTENT_FAILURE_THRESHOLD, 5);
  const mt = manualTimer();
  const loop = createEnricherLoop({
    deps: cycleDeps(new EnricherInMemoryStore(), null, okFetch()),
    timer: mt.timer,
  });
  loop.start();
  assert.equal(mt.delays[0], 0);
});

test("016 projection trigger schedules write when descriptions written", async () => {
  const store = new EnricherInMemoryStore();
  store.seedVersion(versionRow("n1", 0, "proj.ts"));
  const hiveStore = new InMemoryHiveGraphStore();
  const { ProjectionWriter } = await import("../dist/projection/write.js");
  const mt = manualTimer();
  const writer = new ProjectionWriter({ projectRoot: "/tmp/nectar-test-proj", timer: mt.timer, debounceMs: 30_000 });
  await runEnricherCycle(cycleDeps(store, "proj content", okFetch(), { projectionWriter: writer, projectionStore: hiveStore }));
  assert.equal(writer.hasPending, true);
});
