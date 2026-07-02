/**
 * Tests for the PostHog usage-telemetry chokepoint (src/telemetry-usage/emit.ts):
 * the gates (empty key, NECTAR_TELEMETRY=0, the detected HONEYCOMB_TELEMETRY=0, DO_NOT_TRACK), the closed
 * property allow-list, the dedupe ledger (per machine, per version for
 * updated), the distinct_id preference (install-id file over a persisted
 * UUID), the lifecycle firing helpers, and the fail-soft guarantee that a
 * telemetry failure never throws and never alters a caller's exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_POSTHOG_HOST,
  INSTALL_ID_FILE_NAME,
  USAGE_LEDGER_FILE_NAME,
  captureUrl,
  emitInstalled,
  emitUninstalled,
  emitUsageEvent,
  isOptedOut,
  recordDaemonStart,
} from "../dist/telemetry-usage/emit.js";
import type { UsageEmitDeps, UsageFetch, UsageFetchRequestInit } from "../dist/telemetry-usage/emit.js";

interface RecordedCall {
  readonly url: string;
  readonly init: UsageFetchRequestInit;
  readonly body: Record<string, unknown>;
}

function recorder(status = 200): { calls: RecordedCall[]; fetch: UsageFetch } {
  const calls: RecordedCall[] = [];
  const fetch: UsageFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: status >= 200 && status < 300, status };
  };
  return { calls, fetch };
}

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-usage-"));
}

/** Keyed deps with an isolated env so the host machine's DO_NOT_TRACK never bleeds in. */
function keyedDeps(dir: string, fetch: UsageFetch, extra: Partial<UsageEmitDeps> = {}): UsageEmitDeps {
  return { dir, fetch, posthogKey: "phc_test_key", env: {}, version: "1.2.3", ...extra };
}

function readLedger(dir: string): { distinctId?: string; reported: string[]; lastSeenVersion?: string } {
  return JSON.parse(readFileSync(join(dir, USAGE_LEDGER_FILE_NAME), "utf8"));
}

// ── Gates ────────────────────────────────────────────────────────────────

test("gate: empty baked key hard-disables (no fetch, no state written)", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const outcome = await emitUsageEvent("nectar_installed", keyedDeps(dir, rec.fetch, { posthogKey: "" }));
    assert.deepEqual(outcome, { sent: false, skipped: "disabled" });
    assert.equal(rec.calls.length, 0);
    assert.ok(!existsSync(join(dir, USAGE_LEDGER_FILE_NAME)), "no ledger written behind the disabled gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: NECTAR_TELEMETRY=0 (nectar's own switch) opts out (no fetch, no state written)", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const outcome = await emitUsageEvent(
      "nectar_installed",
      keyedDeps(dir, rec.fetch, { env: { NECTAR_TELEMETRY: "0" } }),
    );
    assert.deepEqual(outcome, { sent: false, skipped: "opted_out" });
    assert.equal(rec.calls.length, 0);
    assert.ok(!existsSync(join(dir, USAGE_LEDGER_FILE_NAME)), "no ledger written behind the opt-out gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: the DETECTED family opt-out (HONEYCOMB_TELEMETRY=0) is honored without being required", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const outcome = await emitUsageEvent(
      "nectar_installed",
      keyedDeps(dir, rec.fetch, { env: { HONEYCOMB_TELEMETRY: "0" } }),
    );
    assert.deepEqual(outcome, { sent: false, skipped: "opted_out" });
    assert.equal(rec.calls.length, 0);
    // Detection-only per ADR-0002: honeycomb's env ABSENT means no opt-out from that branch.
    assert.equal(isOptedOut({}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: DO_NOT_TRACK truthy opts out; empty or '0' does not", async () => {
  assert.equal(isOptedOut({ DO_NOT_TRACK: "1" }), true);
  assert.equal(isOptedOut({ DO_NOT_TRACK: "true" }), true);
  assert.equal(isOptedOut({ DO_NOT_TRACK: "0" }), false);
  assert.equal(isOptedOut({ DO_NOT_TRACK: "" }), false);
  assert.equal(isOptedOut({}), false);

  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const blocked = await emitUsageEvent(
      "nectar_installed",
      keyedDeps(dir, rec.fetch, { env: { DO_NOT_TRACK: "1" } }),
    );
    assert.deepEqual(blocked, { sent: false, skipped: "opted_out" });
    assert.equal(rec.calls.length, 0);

    const allowed = await emitUsageEvent(
      "nectar_installed",
      keyedDeps(dir, rec.fetch, { env: { DO_NOT_TRACK: "0" } }),
    );
    assert.equal(allowed.sent, true);
    assert.equal(rec.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── POST shape + the closed allow-list ───────────────────────────────────

test("POST goes to {host}/i/v0/e/ with body {api_key, event, properties, distinct_id}", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const outcome = await emitUsageEvent(
      "nectar_first_run",
      keyedDeps(dir, rec.fetch, { posthogHost: "https://ph.example.com/" }),
    );
    assert.equal(outcome.sent, true);
    assert.equal(rec.calls.length, 1);
    const call = rec.calls[0]!;
    assert.equal(call.url, "https://ph.example.com/i/v0/e/");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["Content-Type"], "application/json");
    assert.ok(call.init.signal instanceof AbortSignal, "an abort signal bounds the POST");

    assert.deepEqual(Object.keys(call.body).sort(), ["api_key", "distinct_id", "event", "properties"]);
    assert.equal(call.body["api_key"], "phc_test_key");
    assert.equal(call.body["event"], "nectar_first_run");

    const props = call.body["properties"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(props).sort(), ["arch", "node", "os", "package", "version"]);
    assert.equal(props["package"], "nectar");
    assert.equal(props["version"], "1.2.3");
    assert.equal(props["node"], process.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default host is the PostHog US cloud when none was baked", () => {
  assert.equal(captureUrl(DEFAULT_POSTHOG_HOST), "https://us.i.posthog.com/i/v0/e/");
});

// ── Dedupe ───────────────────────────────────────────────────────────────

test("dedupe: an event sends once per machine; the second attempt is already_reported", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const first = await emitInstalled(keyedDeps(dir, rec.fetch));
    const second = await emitInstalled(keyedDeps(dir, rec.fetch));
    assert.equal(first.sent, true);
    assert.deepEqual(second, { sent: false, skipped: "already_reported" });
    assert.equal(rec.calls.length, 1);
    assert.ok(readLedger(dir).reported.includes("nectar_installed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedupe: nectar_updated dedupes PER VERSION, so a new version fires again", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const v1a = await emitUsageEvent("nectar_updated", keyedDeps(dir, rec.fetch, { version: "1.0.0" }));
    const v1b = await emitUsageEvent("nectar_updated", keyedDeps(dir, rec.fetch, { version: "1.0.0" }));
    const v2 = await emitUsageEvent("nectar_updated", keyedDeps(dir, rec.fetch, { version: "1.1.0" }));
    assert.equal(v1a.sent, true);
    assert.deepEqual(v1b, { sent: false, skipped: "already_reported" });
    assert.equal(v2.sent, true);
    assert.equal(rec.calls.length, 2);
    const reported = readLedger(dir).reported;
    assert.ok(reported.includes("nectar_updated@1.0.0"));
    assert.ok(reported.includes("nectar_updated@1.1.0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedupe: a failed send is NOT recorded, so the next attempt retries", async () => {
  const dir = tmpStateDir();
  const bad = recorder(500);
  const good = recorder(200);
  try {
    const failed = await emitInstalled(keyedDeps(dir, bad.fetch));
    assert.deepEqual(failed, { sent: false, skipped: "send_failed" });
    const retried = await emitInstalled(keyedDeps(dir, good.fetch));
    assert.equal(retried.sent, true);
    assert.equal(good.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── distinct_id preference ───────────────────────────────────────────────

test("distinct_id: prefers ~/.honeycomb/install-id when present", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    writeFileSync(join(dir, INSTALL_ID_FILE_NAME), "installer-minted-id-42\n", "utf8");
    await emitInstalled(keyedDeps(dir, rec.fetch));
    assert.equal(rec.calls[0]!.body["distinct_id"], "installer-minted-id-42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinct_id: without install-id, a UUID is minted once, persisted, and stays stable", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    await emitInstalled(keyedDeps(dir, rec.fetch));
    await emitUsageEvent("nectar_first_run", keyedDeps(dir, rec.fetch));
    const id1 = rec.calls[0]!.body["distinct_id"] as string;
    const id2 = rec.calls[1]!.body["distinct_id"] as string;
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(id1, id2, "the minted UUID is stable across events");
    assert.equal(readLedger(dir).distinctId, id1, "the minted UUID is persisted in the ledger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fail-soft: never throws, never alters exit codes ─────────────────────

test("fail-soft: a rejecting fetch resolves to send_failed, never throws", async () => {
  const dir = tmpStateDir();
  const rejecting: UsageFetch = async () => {
    throw new Error("network down");
  };
  try {
    const outcome = await emitUninstalled(keyedDeps(dir, rejecting));
    assert.deepEqual(outcome, { sent: false, skipped: "send_failed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-soft: a hung fetch is aborted by the bounded timeout and resolves send_failed", async () => {
  const dir = tmpStateDir();
  const hung: UsageFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  try {
    const outcome = await emitInstalled(keyedDeps(dir, hung, { timeoutMs: 25 }));
    assert.deepEqual(outcome, { sent: false, skipped: "send_failed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-soft: a caller's exit code is unchanged when telemetry fails (uninstall shape)", async () => {
  const dir = tmpStateDir();
  const rejecting: UsageFetch = async () => {
    throw new Error("posthog unreachable");
  };
  // Mirrors runUninstall's shape in src/cli.ts: fire before teardown, await after.
  async function runUninstallShaped(): Promise<number> {
    const telemetryDone = emitUninstalled(keyedDeps(dir, rejecting));
    const teardownOk = true; // the real teardown result drives the code, telemetry never does
    await telemetryDone;
    return teardownOk ? 0 : 1;
  }
  try {
    assert.equal(await runUninstallShaped(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Daemon-start hook: first_run + updated ───────────────────────────────

test("recordDaemonStart: first start fires first_run once, no updated, persists the version", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const first = await recordDaemonStart(keyedDeps(dir, rec.fetch, { version: "1.0.0" }));
    assert.equal(first.firstRun?.sent, true);
    assert.equal(first.updated, null, "no updated event on the first-ever start");
    assert.equal(readLedger(dir).lastSeenVersion, "1.0.0");

    const second = await recordDaemonStart(keyedDeps(dir, rec.fetch, { version: "1.0.0" }));
    assert.deepEqual(second.firstRun, { sent: false, skipped: "already_reported" });
    assert.equal(second.updated, null, "same version means no updated event");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.body["event"], "nectar_first_run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordDaemonStart: a version change fires updated once per version, then persists it", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    await recordDaemonStart(keyedDeps(dir, rec.fetch, { version: "1.0.0" }));
    const upgraded = await recordDaemonStart(keyedDeps(dir, rec.fetch, { version: "1.1.0" }));
    assert.equal(upgraded.updated?.sent, true);
    assert.equal(readLedger(dir).lastSeenVersion, "1.1.0");

    const again = await recordDaemonStart(keyedDeps(dir, rec.fetch, { version: "1.1.0" }));
    assert.equal(again.updated, null, "restart on the same version does not re-fire");

    const events = rec.calls.map((c) => c.body["event"]);
    assert.deepEqual(events, ["nectar_first_run", "nectar_updated"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordDaemonStart: version bookkeeping advances even when opted out, and never throws", async () => {
  const dir = tmpStateDir();
  const rec = recorder();
  try {
    const optedOut = keyedDeps(dir, rec.fetch, { version: "2.0.0", env: { DO_NOT_TRACK: "1" } });
    const outcome = await recordDaemonStart(optedOut);
    assert.deepEqual(outcome.firstRun, { sent: false, skipped: "opted_out" });
    assert.equal(rec.calls.length, 0);
    assert.equal(readLedger(dir).lastSeenVersion, "2.0.0", "local bookkeeping is not telemetry egress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
