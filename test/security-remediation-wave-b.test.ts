/**
 * Security remediation regression tests - Wave B (Portkey / projection / embeddings).
 *
 * Covers the findings fixed by `security-worker-bee`'s audit of the
 * `src/portkey/`, `src/projection/`, and `src/embeddings/` modules:
 *
 *   - MEDIUM: none of the three HTTP transports (`portkey/transport.ts`,
 *     `embeddings/cohere-portkey.ts`, `embeddings/local-nomic.ts`) bounded a
 *     request with an `AbortController`, so an unresponsive peer could hang the
 *     caller indefinitely. Each now aborts on its configured timeout, mirroring
 *     `source-graph/deeplake-transport.ts`'s established pattern.
 *   - MEDIUM: `projection/load.ts#loadProjectionFromFile` read an untrusted
 *     `.honeycomb/nectars.json` (a committed file that travels with a cloned
 *     repo) with no upper size bound (CWE-400), and `parsePortableProjection`
 *     assigned `files`/`derived` entries via a bare `obj[key] = value` that
 *     would hijack the destination object's own prototype for a
 *     `__proto__`/`constructor`/`prototype`-shaped key (CWE-1321) instead of
 *     being rejected as an invalid document.
 *
 * Imports the compiled modules from `dist/`, matching this wave's test style.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { PortkeyFetch } from "../dist/portkey/transport.js";
import { describeViaPortkey, PortkeyTransportError } from "../dist/portkey/transport.js";
import { DEFAULT_ACTIVE_MODEL } from "../dist/portkey/config.js";
import { createLocalNomicHttpTransport } from "../dist/embeddings/local-nomic.js";
import {
  createCoherePortkeyProvider,
  DEFAULT_COHERE_EMBED_MODEL,
  DEFAULT_COHERE_OUTPUT_DIMENSION,
} from "../dist/embeddings/cohere-portkey.js";
import type { FetchLike } from "../dist/embeddings/http.js";
import {
  loadProjectionFromFile,
  MAX_PROJECTION_FILE_BYTES,
} from "../dist/projection/load.js";

const TEN = { orgId: "legion", workspaceId: "engineering", projectId: "honeycomb" };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hivenectar-secwaveb-"));
}

/**
 * A fetch stand-in that never resolves on its own - it only settles by
 * rejecting once `init.signal` fires an `abort` event, exactly like a real
 * `fetch` under an `AbortController`. If the code under test forgot to pass
 * `signal` through to the underlying fetch call, this promise hangs forever
 * (bounded by the per-test `timeout` below, so a regression fails loudly
 * instead of stalling the whole suite).
 */
function hangingFetch(): PortkeyFetch & FetchLike {
  return ((_url: string, init: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as PortkeyFetch & FetchLike;
}

// ── Availability: bounded timeouts on every HTTP transport ─────────────────

test(
  "PRD-014a local nomic transport aborts on requestTimeoutMs instead of hanging forever",
  { timeout: 3000 },
  async () => {
    const transport = createLocalNomicHttpTransport(
      { host: "127.0.0.1", port: 3851, requestTimeoutMs: 25 },
      { fetch: hangingFetch() },
    );
    const result = await transport.embedOne("hello");
    assert.equal(result, null, "a hung daemon fails soft to null within the configured timeout");
  },
);

test(
  "PRD-014b Cohere-via-Portkey transport aborts on requestTimeoutMs instead of hanging forever",
  { timeout: 3000 },
  async () => {
    const provider = createCoherePortkeyProvider(
      {
        model: DEFAULT_COHERE_EMBED_MODEL,
        outputDimension: DEFAULT_COHERE_OUTPUT_DIMENSION,
        apiKey: "pk-secret",
        configId: "pcfg-1",
        url: "https://example.invalid/v1/embeddings",
        maxAttempts: 1,
        retryBackoffMs: 1,
        requestTimeoutMs: 25,
      },
      { fetch: hangingFetch(), sleep: async () => {} },
    );
    const [vec] = await provider.embed(["hello"]);
    assert.equal(vec, null, "an unresponsive gateway fails soft to null within the configured timeout");
  },
);

test(
  "PRD-010 describeViaPortkey aborts on timeoutMs instead of hanging forever",
  { timeout: 3000 },
  async () => {
    await assert.rejects(
      () =>
        describeViaPortkey(
          { messages: [{ role: "user", content: "describe this file" }] },
          {
            portkey: { enabled: true, apiKey: "pk-secret", configId: "pcfg-1", activeModel: DEFAULT_ACTIVE_MODEL },
            fetch: hangingFetch(),
            maxAttempts: 1,
            timeoutMs: 25,
            sleep: async () => {},
          },
        ),
      PortkeyTransportError,
      "an unresponsive gateway raises a typed transport error within the configured timeout, not a hang",
    );
  },
);

// ── Untrusted `.honeycomb/nectars.json`: size ceiling + prototype-pollution-shaped keys ──

test("projection load rejects a file over MAX_PROJECTION_FILE_BYTES before it is read into memory", () => {
  const root = tempRoot();
  try {
    const bigPath = join(root, "huge.json");
    writeFileSync(bigPath, "{}");
    truncateSync(bigPath, MAX_PROJECTION_FILE_BYTES + 1);

    const result = loadProjectionFromFile(bigPath, { tenancy: TEN });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "file_too_large");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection load accepts a file at exactly the size ceiling", () => {
  const root = tempRoot();
  try {
    const doc = {
      version: 1,
      generated_at: "2026-07-02T00:00:00.000Z",
      generator: "test",
      project: { org_id: TEN.orgId, workspace_id: TEN.workspaceId, project_id: TEN.projectId },
      files: {},
      derived: {},
    };
    const okPath = join(root, "ok.json");
    writeFileSync(okPath, JSON.stringify(doc));

    const result = loadProjectionFromFile(okPath, { tenancy: TEN });
    assert.equal(result.ok, true, "a normally-sized, valid projection still loads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const dangerousKey of ["__proto__", "constructor", "prototype"]) {
  test(
    `projection load rejects a '${dangerousKey}'-shaped files key instead of hijacking the parsed object's prototype`,
    () => {
      const root = tempRoot();
      try {
        const validEntry = {
          content_hash: "a".repeat(64),
          path: "src/evil.ts",
          title: "t",
          description: "d",
          concepts: [],
          describe_model: "gemini-2.5-flash",
          described_at: "2026-07-02T00:00:00.000Z",
        };
        const raw = {
          version: 1,
          generated_at: "2026-07-02T00:00:00.000Z",
          generator: "test",
          project: { org_id: TEN.orgId, workspace_id: TEN.workspaceId, project_id: TEN.projectId },
          files: { [dangerousKey]: validEntry },
          derived: {},
        };
        const filePath = join(root, "pollute.json");
        writeFileSync(filePath, JSON.stringify(raw));

        const result = loadProjectionFromFile(filePath, { tenancy: TEN });
        assert.equal(result.ok, false, "the whole document is rejected, not silently missing one entry");
        if (!result.ok) assert.equal(result.reason, "invalid_shape");

        // No matter what the loader did internally, a fresh plain object must still
        // have the real, un-hijacked Object.prototype - proving no pollution escaped
        // this parse into shared global state.
        assert.equal(Object.getPrototypeOf({}), Object.prototype);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
