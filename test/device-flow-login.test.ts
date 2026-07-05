/**
 * PRD-003a a-AC-5 / a-AC-7: `nectar login` runs the device flow to completion
 * and writes credentials nectar can read; the verification URL + code are
 * printed BEFORE any browser open; a browser-open failure never crashes the
 * flow; a non-https completion URL is never opened; and tenancy is chosen
 * EXPLICITLY (never a silent orgs[0] guess).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDeviceFlowLogin,
  validateVerificationUrl,
  defaultBrowserOpener,
  DEFAULT_MAX_POLLS,
  type FetchLike,
  type FetchResponse,
  type LoginSeams,
} from "../dist/auth/device-flow.js";
import { loadDeepLakeCredentials } from "../dist/hive-graph/deeplake-credentials.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nectar-login-"));
}

function jsonResp(status: number, ok: boolean, payload: unknown): FetchResponse {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

interface FakeBackend {
  readonly orgs?: Array<{ id: string; name: string }>;
  readonly workspaces?: Array<{ id: string; name: string }>;
  readonly completeUrl?: string;
  readonly pollsBeforeToken?: number;
}

function makeFetch(be: FakeBackend = {}): { fetch: FetchLike; tokenCall(): number } {
  let tokenPolls = 0;
  const fetch: FetchLike = async (url) => {
    if (url.endsWith("/auth/device/code")) {
      return jsonResp(200, true, {
        device_code: "dc-123",
        user_code: "WXYZ-1234",
        verification_uri: "https://login.deeplake.ai/device",
        verification_uri_complete: be.completeUrl ?? "https://login.deeplake.ai/device?code=WXYZ-1234",
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.endsWith("/auth/device/token")) {
      tokenPolls += 1;
      if (tokenPolls < (be.pollsBeforeToken ?? 1)) return jsonResp(400, false, { error: "authorization_pending" });
      return jsonResp(200, true, { access_token: "short-lived-token" });
    }
    if (url.endsWith("/organizations")) return jsonResp(200, true, be.orgs ?? [{ id: "org-1", name: "Org One" }]);
    if (url.endsWith("/workspaces")) return jsonResp(200, true, { data: be.workspaces ?? [{ id: "ws-1", name: "WS One" }] });
    if (url.endsWith("/users/me/tokens")) return jsonResp(200, true, { token: { token: "long-lived-XYZ" } });
    if (url.endsWith("/me")) return jsonResp(200, true, { id: "u1", name: "Ada Lovelace", email: "ada@x.io" });
    return jsonResp(404, false, { error: "not_found" });
  };
  return { fetch, tokenCall: () => tokenPolls };
}

test("a-AC-5 a successful device-flow login writes credentials nectar can read back", async () => {
  const dir = tmpDir();
  const opened: string[] = [];
  try {
    const { fetch } = makeFetch();
    const seams: LoginSeams = {
      fetch,
      sleep: async () => {},
      openBrowser: (url) => {
        opened.push(url);
        return true;
      },
      out: () => {},
      isTTY: false,
      now: () => "2026-07-04T00:00:00.000Z",
      dir,
    };
    const result = await runDeviceFlowLogin({}, seams);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.orgId, "org-1");
    assert.equal(result.workspaceId, "ws-1");
    assert.ok(existsSync(join(dir, "credentials.json")));

    // The written file is byte-compatible with what loadDeepLakeCredentials reads.
    const creds = loadDeepLakeCredentials({ dir });
    assert.equal(creds.token, "long-lived-XYZ", "the minted long-lived token is persisted, not the short-lived one");
    assert.equal(creds.orgId, "org-1");
    assert.equal(creds.workspaceId, "ws-1");
    assert.equal(creds.apiUrl, "https://api.deeplake.ai");

    assert.deepEqual(opened, ["https://login.deeplake.ai/device?code=WXYZ-1234"], "opened the validated https completion URL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-7 the verification URL and code are printed BEFORE any browser-open attempt", async () => {
  const dir = tmpDir();
  try {
    const { fetch } = makeFetch();
    const events: Array<{ kind: "out" | "open"; text: string }> = [];
    const seams: LoginSeams = {
      fetch,
      sleep: async () => {},
      openBrowser: (url) => {
        events.push({ kind: "open", text: url });
        return true;
      },
      out: (line) => events.push({ kind: "out", text: line }),
      isTTY: false,
      dir,
    };
    const result = await runDeviceFlowLogin({}, seams);
    assert.equal(result.ok, true);
    const codeIndex = events.findIndex((e) => e.kind === "out" && e.text.includes("WXYZ-1234"));
    const openIndex = events.findIndex((e) => e.kind === "open");
    assert.ok(codeIndex >= 0, "the user code was printed");
    assert.ok(openIndex >= 0, "the browser open was attempted");
    assert.ok(codeIndex < openIndex, "the code was printed before the browser was opened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-7 a browser-open failure never crashes the flow; it completes and writes credentials", async () => {
  const dir = tmpDir();
  try {
    const { fetch } = makeFetch();
    const out: string[] = [];
    const result = await runDeviceFlowLogin(
      {},
      {
        fetch,
        sleep: async () => {},
        openBrowser: () => false, // simulate a headless / failed open
        out: (l) => out.push(l),
        isTTY: false,
        dir,
      },
    );
    assert.equal(result.ok, true, "the flow polls to completion even when the browser could not open");
    assert.ok(existsSync(join(dir, "credentials.json")));
    assert.ok(out.some((l) => /open the URL above manually/i.test(l)), "the user is told to open the URL manually");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-7 a non-https completion URL is never opened, and the flow still completes", async () => {
  const dir = tmpDir();
  try {
    const { fetch } = makeFetch({ completeUrl: "http://insecure.example/device" });
    const opened: string[] = [];
    const result = await runDeviceFlowLogin(
      {},
      {
        fetch,
        sleep: async () => {},
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
        out: () => {},
        isTTY: false,
        dir,
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(opened, [], "a non-https verification_uri_complete is refused, never opened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-7 validateVerificationUrl accepts https and refuses everything else", () => {
  assert.equal(validateVerificationUrl("https://login.deeplake.ai/x"), "https://login.deeplake.ai/x");
  assert.equal(validateVerificationUrl("http://login.deeplake.ai/x"), null);
  assert.equal(validateVerificationUrl("not a url"), null);
  assert.equal(validateVerificationUrl("file:///etc/passwd"), null);
});

test("a-AC-7 defaultBrowserOpener refuses a non-https URL without invoking any opener", () => {
  // Returns false BEFORE any execFileSync, so this touches no subprocess.
  assert.equal(defaultBrowserOpener("http://insecure.example"), false);
  assert.equal(defaultBrowserOpener("javascript:alert(1)"), false);
});

test("a-AC-5 multiple orgs with no flags on a non-TTY fails clearly naming the flags (never a silent orgs[0])", async () => {
  const dir = tmpDir();
  try {
    const { fetch } = makeFetch({ orgs: [{ id: "org-1", name: "One" }, { id: "org-2", name: "Two" }] });
    const result = await runDeviceFlowLogin(
      {},
      { fetch, sleep: async () => {}, openBrowser: () => true, out: () => {}, isTTY: false, dir },
    );
    assert.equal(result.ok, false, "no silent guess is made");
    assert.match(result.message, /--org=/, "the error names the --org flag");
    assert.equal(existsSync(join(dir, "credentials.json")), false, "no credentials were written on the refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-5 explicit --org / --workspace flags are honored on a non-TTY multi-tenancy account", async () => {
  const dir = tmpDir();
  try {
    const { fetch } = makeFetch({ orgs: [{ id: "org-1", name: "One" }, { id: "org-2", name: "Two" }] });
    const result = await runDeviceFlowLogin(
      { org: "org-2", workspace: "ws-9" },
      { fetch, sleep: async () => {}, openBrowser: () => true, out: () => {}, isTTY: false, dir },
    );
    assert.equal(result.ok, true, result.message);
    const creds = loadDeepLakeCredentials({ dir });
    assert.equal(creds.orgId, "org-2");
    assert.equal(creds.workspaceId, "ws-9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-5 a TTY prompt selects among multiple orgs (never a silent guess)", async () => {
  const dir = tmpDir();
  try {
    const { fetch } = makeFetch({ orgs: [{ id: "org-1", name: "One" }, { id: "org-2", name: "Two" }] });
    const result = await runDeviceFlowLogin(
      {},
      {
        fetch,
        sleep: async () => {},
        openBrowser: () => true,
        out: () => {},
        isTTY: true,
        question: async () => "2", // choose the second org
        dir,
      },
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(loadDeepLakeCredentials({ dir }).orgId, "org-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-7 a slow_down poll response grows the interval (never hammers the token endpoint)", async () => {
  const dir = tmpDir();
  try {
    let tokenPolls = 0;
    const sleepCalls: number[] = [];
    const fetch: FetchLike = async (url) => {
      if (url.endsWith("/auth/device/code")) {
        return jsonResp(200, true, {
          device_code: "dc-slow",
          user_code: "SLOW-0001",
          verification_uri: "https://login.deeplake.ai/device",
          verification_uri_complete: "https://login.deeplake.ai/device?code=SLOW-0001",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/auth/device/token")) {
        tokenPolls += 1;
        // pending, then two slow_downs, then approved.
        if (tokenPolls === 1) return jsonResp(400, false, { error: "authorization_pending" });
        if (tokenPolls === 2 || tokenPolls === 3) return jsonResp(400, false, { error: "slow_down" });
        return jsonResp(200, true, { access_token: "short-lived-token" });
      }
      if (url.endsWith("/organizations")) return jsonResp(200, true, [{ id: "org-1", name: "Org One" }]);
      if (url.endsWith("/workspaces")) return jsonResp(200, true, { data: [{ id: "ws-1", name: "WS One" }] });
      if (url.endsWith("/users/me/tokens")) return jsonResp(200, true, { token: { token: "long-lived-XYZ" } });
      if (url.endsWith("/me")) return jsonResp(200, true, { id: "u1", name: "Ada Lovelace" });
      return jsonResp(404, false, { error: "not_found" });
    };
    const result = await runDeviceFlowLogin(
      {},
      {
        fetch,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        openBrowser: () => true,
        out: () => {},
        isTTY: false,
        dir,
      },
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(
      sleepCalls,
      [5000, 5000, 10000, 15000],
      "each slow_down response grows the NEXT poll wait by 5s; a plain pending never changes it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a-AC-9 poll exhaustion at DEFAULT_MAX_POLLS terminates with a plain-language, actionable error (never hangs)", async () => {
  const dir = tmpDir();
  try {
    let tokenPolls = 0;
    const fetch: FetchLike = async (url) => {
      if (url.endsWith("/auth/device/code")) {
        return jsonResp(200, true, {
          device_code: "dc-stuck",
          user_code: "STUCK-0001",
          verification_uri: "https://login.deeplake.ai/device",
          verification_uri_complete: "https://login.deeplake.ai/device?code=STUCK-0001",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/auth/device/token")) {
        tokenPolls += 1;
        // Never approved: the sign-in sits pending forever, so the flow must
        // give up at the bounded cap rather than poll indefinitely.
        return jsonResp(400, false, { error: "authorization_pending" });
      }
      return jsonResp(404, false, { error: "not_found" });
    };
    const result = await runDeviceFlowLogin(
      {},
      {
        fetch,
        sleep: async () => {},
        openBrowser: () => true,
        out: () => {},
        isTTY: false,
        dir,
      },
    );
    assert.equal(result.ok, false, "an unapproved sign-in never fabricates success");
    assert.match(result.message, /timed out/i, "a plain-language message, not a hang or an unhandled throw");
    assert.match(result.message, /nectar login/i, "names the actionable retry command");
    assert.equal(tokenPolls, DEFAULT_MAX_POLLS, "polling stops exactly at the bounded cap, never looping forever");
    assert.equal(existsSync(join(dir, "credentials.json")), false, "no credentials are written on a timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
