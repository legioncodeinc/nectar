/**
 * PRD-012b: the `nectar search` CLI as a THIN loopback client of the daemon's
 * `POST /api/hive-graph/search` endpoint, and the endpoint/CLI shape identity.
 *
 * Covers: loopback success + rendering, --limit / --json flags, the
 * no-engine-import posture (AC-012b.3.1), the daemon-not-running error with no
 * local fallback (AC-012b.3.2), and CLI-vs-endpoint byte-identical JSON.
 * Imports the compiled modules from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleDaemon } from "../dist/index.js";
import {
  searchViaDaemon,
  DaemonUnreachableError,
} from "../dist/api/loopback-client.js";
import { parseSearchArgs, renderSearchTable } from "../dist/cli.js";
import { rmDirWithRetry } from "./telemetry/test-helpers.ts";

const SCOPE = { orgId: "org", workspaceId: "ws", projectId: "proj" };

const ENGINE_RESULT = {
  hits: [
    { source: "nectar", id: "n1", path: "src/auth/session.ts", title: "Session refresh", body: "Refreshes the session token.", concepts: '["auth","session"]', content_hash: "h1" },
    { source: "nectar", id: "n2", path: "src/auth/login.ts", title: "Login handler", body: "Handles the login POST.", concepts: '["auth"]', content_hash: "h2" },
  ],
  sources: ["nectar"],
  degraded: false,
};

function tmpRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-search-cli-"));
}

/** A raw POST helper to prove the endpoint returns the byte-identical JSON the CLI client gets. */
function rawPost(port: number, path: string, payload: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload ?? {});
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// ── parseSearchArgs (the CLI flag grammar) ─────────────────────────────────────

test("012b-AC-1.x parseSearchArgs parses the query, --limit, and --json; flags malformed input", () => {
  const run = parseSearchArgs(["everything about logins"]);
  assert.equal(run.kind, "run");
  assert.ok(run.kind === "run" && run.query === "everything about logins");
  assert.ok(run.kind === "run" && run.limit === undefined && run.json === false);

  const multi = parseSearchArgs(["find", "the", "login", "flow"]);
  assert.ok(multi.kind === "run" && multi.query === "find the login flow", "unquoted tokens join into the query");

  const limited = parseSearchArgs(["logins", "--limit", "5", "--json"]);
  assert.ok(limited.kind === "run" && limited.limit === 5 && limited.json === true);

  const eqForm = parseSearchArgs(["logins", "--limit=8"]);
  assert.ok(eqForm.kind === "run" && eqForm.limit === 8);

  const badLimit = parseSearchArgs(["logins", "--limit", "abc"]);
  assert.equal(badLimit.kind, "errors");

  const noQuery = parseSearchArgs(["--json"]);
  assert.equal(noQuery.kind, "errors");

  const unknown = parseSearchArgs(["logins", "--nope"]);
  assert.equal(unknown.kind, "errors");
});

// ── AC-012b.3.1: thin client never imports the engine or any Deep Lake path ─────

test("012b-AC-3.1 the loopback client module imports no engine or Deep Lake code (thin client)", () => {
  const clientPath = fileURLToPath(new URL("../dist/api/loopback-client.js", import.meta.url));
  const src = readFileSync(clientPath, "utf8");
  // The only import must be node:http; the result-shape import is type-only (erased).
  assert.ok(src.includes('from "node:http"'), "uses node:http for the loopback request");
  assert.ok(!/from ".*hive-graph\/search/.test(src), "never imports the search engine");
  assert.ok(!/from ".*deeplake/.test(src), "never imports any Deep Lake path");
  assert.ok(!/from ".*deeplake-store/.test(src), "never imports the Deep Lake store");
});

// ── AC-012b.3.2: daemon not running -> a clear error, no local fallback ─────────

test("012b-AC-3.2 a daemon-not-running connection failure throws DaemonUnreachableError (no local fallback)", async () => {
  // Nothing is listening on this port.
  await assert.rejects(
    () => searchViaDaemon({ host: "127.0.0.1", port: 1, query: "logins", timeoutMs: 1000 }),
    (err: unknown) => {
      assert.ok(err instanceof DaemonUnreachableError, "surfaces the daemon-unreachable error");
      return true;
    },
  );
});

// ── AC-012b.1.x + endpoint/CLI shape identity (over a real loopback socket) ─────

test("012b-AC-1.1/1.2 the CLI client reaches the daemon over loopback, passes the limit, and returns the engine result", async () => {
  const runtimeDir = tmpRuntimeDir();
  let seenLimit: number | undefined = -1;
  let seenQuery = "";
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    hiveGraphApi: {
      defaultScope: SCOPE,
      searchHiveGraph: async (query, _scope, limit) => {
        seenQuery = query;
        seenLimit = limit;
        return ENGINE_RESULT;
      },
    },
  });
  try {
    const port = await daemon.start();
    const result = await searchViaDaemon({ host: "127.0.0.1", port, query: "logins", limit: 9 });
    assert.deepEqual(result, ENGINE_RESULT, "the client returns the engine result verbatim");
    assert.equal(seenQuery, "logins", "AC-1.1 the query reached the daemon over loopback");
    assert.equal(seenLimit, 9, "AC-1.2 the limit was passed through to the engine");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

test("012b-AC-2.1/1.3 the CLI --json output is byte-identical to the raw endpoint JSON (one engine, two clients)", async () => {
  const runtimeDir = tmpRuntimeDir();
  const daemon = assembleDaemon({
    port: 0,
    runtimeDir,
    log: () => {},
    hiveGraphApi: { defaultScope: SCOPE, searchHiveGraph: async () => ENGINE_RESULT },
  });
  try {
    const port = await daemon.start();

    // The CLI's --json output is exactly JSON.stringify(result).
    const clientResult = await searchViaDaemon({ host: "127.0.0.1", port, query: "logins" });
    const cliJson = JSON.stringify(clientResult);

    // A raw POST to the endpoint returns the identical JSON body.
    const raw = await rawPost(port, "/api/hive-graph/search", { query: "logins" });
    assert.equal(raw.status, 200);
    assert.equal(cliJson, raw.text.trim(), "CLI --json and the endpoint emit byte-identical JSON");
  } finally {
    await daemon.shutdown();
    rmDirWithRetry(runtimeDir);
  }
});

// ── Human rendering (default, non-JSON) ────────────────────────────────────────

test("012b-AC-1.1 renderSearchTable lists ranked hits with path + title and a degraded footer", () => {
  const table = renderSearchTable(ENGINE_RESULT);
  assert.match(table, /src\/auth\/session\.ts/);
  assert.match(table, /src\/auth\/login\.ts/);
  assert.match(table, /Session refresh/);
  assert.doesNotMatch(table, /degraded/, "a non-degraded result carries no degraded footer");

  const degraded = renderSearchTable({ hits: [], sources: [], degraded: true });
  assert.match(degraded, /No matching files/);
  assert.match(degraded, /degraded/, "the degraded footer shows when the semantic arm did not run");
});
