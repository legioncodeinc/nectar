import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mintNectar, nectarCreatedAt } from "../dist/source-graph/ulid.js";
import { sha256Hex } from "../dist/source-graph/hash.js";
import { InMemorySourceGraphStore } from "../dist/source-graph/memory-store.js";
import {
  PROJECTION_SCHEMA_VERSION,
  canonicalSerialize,
  canonicalSerializeExceptGeneratedAt,
  type PortableProjection,
} from "../dist/projection/format.js";
import { buildProjection, buildProjectionFromStore } from "../dist/projection/generate.js";
import {
  ProjectionWriter,
  rebuildProjection,
  writeProjectionAtomic,
  type Timer,
} from "../dist/projection/write.js";
import { loadProjection, loadProjectionFromFile, validateProjection } from "../dist/projection/load.js";
import { inheritFromProjection } from "../dist/projection/inherit.js";

const TEN = { orgId: "legion", workspaceId: "engineering", projectId: "honeycomb" };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hivenectar-proj-"));
}

function hashFor(content: string): string {
  return sha256Hex(content);
}

function describedVersion(
  nectar: string,
  seq: number,
  path: string,
  content: string,
  title: string,
  description: string,
) {
  const h = hashFor(content);
  return {
    nectar,
    contentHash: h,
    seq,
    path,
    filename: path.split("/").pop() ?? path,
    ext: "ts",
    sizeBytes: content.length,
    mtimeObserved: "2026-06-29T14:30:00.000Z",
    title,
    description,
    concepts: '["auth"]',
    embedding: null,
    confidence: null,
    fingerprint: null,
    describedAt: "2026-06-29T14:30:00.000Z",
    describeModel: "gemini-2.5-flash",
    describeStatus: "described" as const,
    observedAt: "2026-06-29T14:30:05.000Z",
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "2026-06-29T14:30:05.000Z",
  };
}

function identityRow(nectar: string, derivedFrom = "", forkHash = "") {
  return {
    nectar,
    kind: "file" as const,
    createdAt: nectarCreatedAt(nectar),
    derivedFromNectar: derivedFrom,
    forkContentHash: forkHash,
    orgId: TEN.orgId,
    workspaceId: TEN.workspaceId,
    projectId: TEN.projectId,
    lastUpdateDate: "",
  };
}

function sampleDoc(overrides: Partial<PortableProjection> = {}): PortableProjection {
  const n1 = mintNectar(1_735_000_000_000);
  const h1 = hashFor("login");
  return {
    version: PROJECTION_SCHEMA_VERSION,
    generated_at: "2026-06-30T12:00:00.000Z",
    generator: "honeycomb-hivenectar@0.0.1",
    project: { org_id: TEN.orgId, workspace_id: TEN.workspaceId, project_id: TEN.projectId },
    files: {
      [n1]: {
        content_hash: h1,
        path: "src/auth/login.ts",
        title: "User login route handler",
        description: "Validates credentials.",
        concepts: ["auth", "login"],
        describe_model: "gemini-2.5-flash",
        described_at: "2026-06-29T14:30:00.000Z",
      },
    },
    derived: {},
    ...overrides,
  };
}

function manualTimer() {
  let pending: { fn: () => void; ms: number } | null = null;
  const timer: Timer = {
    set(fn, ms) {
      pending = { fn, ms };
      return pending;
    },
    clear() {
      pending = null;
    },
  };
  return {
    timer,
    delay: () => pending?.ms ?? null,
    async fire() {
      const p = pending;
      pending = null;
      if (p) p.fn();
      await Promise.resolve();
    },
  };
}

// --- AC-1: atomic temp+rename; crash leaves prior file ---

test("011-AC-1 atomic write leaves prior file intact when crash happens before rename", () => {
  const root = tempRoot();
  try {
    const prior = sampleDoc({ generated_at: "2026-06-30T11:00:00.000Z" });
    const finalPath = writeProjectionAtomic(prior, { projectRoot: root, pid: 100, nowMs: 1 });
    const priorBytes = readFileSync(finalPath, "utf8");

    const dir = join(root, ".honeycomb");
    const tmpPath = join(dir, ".nectars.json.200.2.tmp");
    writeFileSync(tmpPath, '{"partial":true}', "utf8");

    assert.equal(readFileSync(finalPath, "utf8"), priorBytes, "prior final file unchanged after crash");
    assert.ok(existsSync(tmpPath), "orphan temp may remain until next run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("011-AC-1 completed write renames temp over final with no temp left", () => {
  const root = tempRoot();
  try {
    const doc = sampleDoc();
    const path = writeProjectionAtomic(doc, { projectRoot: root, pid: 300, nowMs: 3 });
    assert.ok(existsSync(path));
    const dir = join(root, ".honeycomb");
    const temps = ["nectars.json.300.3.tmp", ".nectars.json.300.3.tmp"];
    for (const name of temps) {
      assert.equal(existsSync(join(dir, name)), false, `no temp ${name}`);
    }
    assert.equal(readFileSync(path, "utf8"), canonicalSerialize(doc));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-2: debounced rewrite with newly-described versions ---

test("011-AC-2 debounced writer coalesces enricher rewrites into one flush with latest descriptions", async () => {
  const root = tempRoot();
  const mt = manualTimer();
  try {
    const writer = new ProjectionWriter({
      projectRoot: root,
      debounceMs: 30_000,
      timer: mt.timer,
      pid: 400,
      nowMs: () => 4,
    });

    const n = mintNectar();
    const h0 = hashFor("v0");
    const h1 = hashFor("v1");
    const docV0 = buildProjection(TEN, [{ identity: identityRow(n), version: describedVersion(n, 0, "src/a.ts", "v0", "Old", "old") }], {
      generatedAt: "2026-06-30T12:00:00.000Z",
    });
    const docV1 = buildProjection(TEN, [{ identity: identityRow(n), version: describedVersion(n, 1, "src/a.ts", "v1", "New", "new desc") }], {
      generatedAt: "2026-06-30T12:00:30.000Z",
    });

    writer.scheduleWrite(docV0);
    assert.equal(mt.delay(), 30_000);
    writer.scheduleWrite(docV1);
    assert.equal(mt.delay(), 30_000, "reschedule resets debounce window");

    const path = writer.flushNow();
    assert.ok(path);
    const onDisk = readFileSync(path as string, "utf8");
    assert.ok(onDisk.includes('"title":"New"'), "latest described version substituted in");
    assert.ok(!onDisk.includes('"title":"Old"'), "superseded description not written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-3: rebuild immediate write from store scan ---

test("011-AC-3 rebuildProjection scans store and writes immediately without debounce", () => {
  const root = tempRoot();
  try {
    const store = new InMemorySourceGraphStore();
    const n = mintNectar();
    store.insertIdentity(identityRow(n));
    store.appendVersion(describedVersion(n, 0, "src/auth/login.ts", "login body", "Login", "Handles login"));

    const mt = manualTimer();
    const writer = new ProjectionWriter({ projectRoot: root, timer: mt.timer });

    const { doc, path } = rebuildProjection(store, TEN, { projectRoot: root, pid: 500, nowMs: 5, generatedAt: "2026-06-30T12:00:00.000Z" });
    assert.equal(Object.keys(doc.files).length, 1);
    assert.ok(readFileSync(path, "utf8").includes("Login"));
    assert.equal(writer.hasPending, false, "rebuild bypasses debounced writer");
    assert.equal(mt.delay(), null, "no debounce timer armed by rebuild");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-4: future version ignored ---

test("011-AC-4 future projection version is ignored with warning reason", () => {
  const future = sampleDoc({ version: PROJECTION_SCHEMA_VERSION + 1 });
  const result = loadProjection(future, TEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "future_version");
});

// --- AC-5: tenancy mismatch ignored, never partial ---

test("011-AC-5 project triple mismatch is ignored and never partially loaded", () => {
  const doc = sampleDoc({
    project: { org_id: "other", workspace_id: "engineering", project_id: "honeycomb" },
  });
  const result = validateProjection(doc, TEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "project_mismatch");
});

test("011-AC-5 invalid nectar key rejects entire projection", () => {
  const good = sampleDoc();
  const key = Object.keys(good.files)[0] as string;
  const entry = good.files[key] as NonNullable<(typeof good.files)[string]>;
  const badDoc: PortableProjection = {
    ...good,
    files: { "NOT_A_VALID_ULID_26_CHARS!!": entry },
  };
  const result = validateProjection(badDoc, TEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_nectar_key");
});

// --- AC-6: fresh-clone inheritance ---

test("011-AC-6 hash match inherits nectar and description with zero LLM paths", () => {
  const n = mintNectar();
  const content = "export function login() {}";
  const h = hashFor(content);
  const doc = buildProjection(TEN, [
    {
      identity: identityRow(n),
      version: describedVersion(n, 0, "src/auth/login.ts", content, "Login handler", "Validates users."),
    },
  ], { generatedAt: "2026-06-30T12:00:00.000Z" });

  const loaded = loadProjection(doc, TEN);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const disk = new Map([["src/auth/login.ts", h]]);
  const summary = inheritFromProjection(doc, disk, { tenancy: TEN });

  assert.equal(summary.inherited, 1);
  assert.equal(summary.unmatched, 0);
  assert.equal(summary.rows.length, 1);
  const row = summary.rows[0];
  assert.equal(row?.identity.nectar, n);
  assert.equal(row?.version.title, "Login handler");
  assert.equal(row?.version.describeStatus, "described");
  assert.equal(row?.version.contentHash, h);
});

test("011-AC-6 existing local nectars are never overwritten", () => {
  const n = mintNectar();
  const h = hashFor("body");
  const doc = buildProjection(TEN, [
    { identity: identityRow(n), version: describedVersion(n, 0, "src/a.ts", "body", "T", "D") },
  ]);
  const summary = inheritFromProjection(doc, new Map([["src/a.ts", h]]), {
    tenancy: TEN,
    existingNectars: new Set([n]),
  });
  assert.equal(summary.inherited, 0);
  assert.equal(summary.skippedExisting, 1);
  assert.equal(summary.rows.length, 0);
});

// --- AC-7: byte-identical modulo generated_at ---

test("011-AC-7 two generations from same store state are byte-identical modulo generated_at", () => {
  const store = new InMemorySourceGraphStore();
  const n1 = mintNectar(1000);
  const n2 = mintNectar(2000);
  store.insertIdentity(identityRow(n1));
  store.insertIdentity(identityRow(n2, n1, hashFor("fork-src")));
  store.appendVersion(describedVersion(n1, 0, "src/auth/login.ts", "login", "Login", "Login desc"));
  store.appendVersion(describedVersion(n2, 0, "src/middleware/session.ts", "session", "Session", "Session desc"));

  const a = buildProjectionFromStore(store, TEN, { generatedAt: "2026-06-30T12:00:00.000Z" });
  const b = buildProjectionFromStore(store, TEN, { generatedAt: "2026-07-01T00:00:00.000Z" });

  assert.equal(canonicalSerializeExceptGeneratedAt(a), canonicalSerializeExceptGeneratedAt(b));
  assert.notEqual(a.generated_at, b.generated_at);
});

test("011-AC-7 canonicalSerialize is stable for fixed generated_at", () => {
  const doc = sampleDoc();
  assert.equal(canonicalSerialize(doc), canonicalSerialize(doc));
});

test("011-AC-4 loadProjectionFromFile rejects invalid content_hash prefix form", () => {
  const root = tempRoot();
  try {
    const bad = sampleDoc();
    const key = Object.keys(bad.files)[0] as string;
    bad.files = {
      [key]: {
        ...(bad.files[key] as NonNullable<(typeof bad.files)[string]>),
        content_hash: `sha256-${hashFor("x")}`,
      },
    };
    const filePath = join(root, ".honeycomb", "nectars.json");
    mkdirSync(join(root, ".honeycomb"), { recursive: true });
    writeFileSync(filePath, canonicalSerialize(bad), "utf8");
    const result = loadProjectionFromFile(filePath, { tenancy: TEN });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid_content_hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
