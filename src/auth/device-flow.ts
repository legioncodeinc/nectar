/**
 * The `api.deeplake.ai` device-flow login client for `nectar login` (PRD-003a
 * a-AC-5 / a-AC-7).
 *
 * nectar previously had no login verb - it only READ the shared
 * `~/.deeplake/credentials.json` and sat degraded until someone else wrote it.
 * This module gives nectar its own in-process device-flow client so a solo
 * install can self-serve. It speaks the SAME backend honeycomb speaks and ports
 * honeycomb's request/response shapes VERBATIM from
 * `honeycomb/src/daemon/runtime/auth/deeplake-issuer.ts` (READ as reference,
 * reimplemented with Node built-ins per ADR-0002, never imported), so the
 * written credential is byte-compatible and one login authenticates both tools.
 *
 * The HTTP contract:
 *   - POST {apiUrl}/auth/device/code   -> { device_code, user_code, verification_uri,
 *                                           verification_uri_complete, expires_in, interval }
 *   - POST {apiUrl}/auth/device/token  -> { access_token, ... }, or 400 {error:
 *                                           "authorization_pending"|"slow_down"|"expired_token"|"access_denied"}
 *   - GET  {apiUrl}/organizations      -> [{ id, name }]
 *   - GET  {apiUrl}/workspaces         -> { data: [{ id, name }] } or [{ id, name }]
 *   - POST {apiUrl}/users/me/tokens    -> mint a long-lived org-bound token { token: { token } }
 *   - GET  {apiUrl}/me                 -> { id, name, email? } (validate + display name)
 *
 * Ordering that a-AC-7 (headless) requires: the verification URL + user code are
 * PRINTED before any browser-open attempt, and the browser opener never crashes
 * or hangs the flow (a fixed-argv, no-shell, timed-out open that returns false
 * on failure). The flow then polls to completion regardless of whether a browser
 * opened.
 *
 * Tenancy is chosen EXPLICITLY, never a silent `orgs[0]` guess (parent AC-6):
 * `--org`/`--workspace` flags win; a single org/workspace auto-selects; multiple
 * prompt on a TTY; a non-TTY with no flags fails with a plain-language error
 * naming the flags.
 *
 * The token is a SECRET: it rides ONLY in the `Authorization: Bearer` header,
 * never a URL, log, or error message; the browser opener REFUSES any non-`https:`
 * `verification_uri_complete`. Every seam (fetch, sleep, opener, tty, output,
 * clock) is injectable so tests never hit the network or a real browser.
 *
 * Built-ins only (`node:child_process` for the opener) + the global `fetch`.
 */
import { execFileSync } from "node:child_process";
import {
  DEFAULT_DEEPLAKE_API_URL,
  saveDeepLakeCredentials,
  credentialsPath,
  type DiskCredentials,
} from "../hive-graph/deeplake-credentials.js";

// ── Wire shapes (ported verbatim from honeycomb's issuer) ────────────────────

/** `POST /auth/device/code` response. */
export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

/** `POST /auth/device/token` success response. */
export interface DeviceTokenResponse {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_in?: number;
}

/** `GET /me` response. */
export interface MeResponse {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
}

/** One org row from `GET /organizations`. */
export interface OrgRow {
  readonly id: string;
  readonly name: string;
}

/** One workspace row from `GET /workspaces`. */
export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
}

/** The minimal `fetch` response shape the client reads (a subset of the DOM `Response`). */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The request init the client passes (method + headers + JSON body). */
export interface FetchRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** The injectable `fetch` the client issues every request through. */
export type FetchLike = (url: string, init?: FetchRequestInit) => Promise<FetchResponse>;

/** A sleeper so the poll cadence is injectable (a test passes a no-wait sleeper). */
export type Sleeper = (ms: number) => Promise<void>;

/** The injectable browser opener; returns `true` iff it opened the URL. */
export type BrowserOpener = (url: string) => boolean;

/** The real wall-clock sleeper. */
export const realSleeper: Sleeper = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The `X-Deeplake-Client` header attributes traffic to nectar. */
export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
/** The nectar client-family value. */
export const DEEPLAKE_CLIENT_VALUE = "nectar";
/** The org-scoping header DeepLake reads. */
export const DEEPLAKE_ORG_HEADER = "X-Activeloop-Org-Id";

/** Long-lived mint duration: one year in seconds (honeycomb's `/users/me/tokens` duration). */
const MINT_DURATION_SECONDS = 365 * 24 * 3600;

/** Default retry budget on 429 / 5xx - bounded so a flaky backend surfaces rather than hangs. */
export const DEFAULT_MAX_RETRIES = 3;

/** The default device-flow poll cap - bounded so a stuck flow surfaces rather than hangs (a-AC-9). */
export const DEFAULT_MAX_POLLS = 900;

/** A redacted HTTP failure: carries the status + a truncated body, NEVER the token. */
export class AuthHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthHttpError";
    this.status = status;
  }
}

/**
 * Thrown when a link needs an explicit org/workspace choice but none was
 * available (multiple candidates, no flags, no TTY) - the no-guess contract
 * (parent AC-6). Carries the enumerated orgs so the CLI can print an actionable
 * list. NEVER carries a token.
 */
export class TenancySelectionRequiredError extends Error {
  readonly orgs: readonly OrgRow[];
  constructor(message: string, orgs: readonly OrgRow[]) {
    super(message);
    this.name = "TenancySelectionRequiredError";
    this.orgs = orgs;
  }
}

/** Build the JSON headers an authenticated request carries (token in the header ONLY). */
function authHeaders(token: string, orgId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    [DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE,
  };
  if (orgId !== undefined && orgId.length > 0) headers[DEEPLAKE_ORG_HEADER] = orgId;
  return headers;
}

/** True for a status the hardened-fetch posture retries (rate-limit / transient server error). */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** The poll outcome: a token, or a bounded backoff signal. */
export type PollOutcome = { readonly kind: "token"; readonly token: DeviceTokenResponse } | { readonly kind: "pending" } | { readonly kind: "slow_down" };

/** The reusable `api.deeplake.ai` auth client (device flow + enumeration + mint). */
export interface DeeplakeAuthClient {
  readonly apiUrl: string;
  requestDeviceCode(): Promise<DeviceCodeResponse>;
  pollDeviceToken(deviceCode: string): Promise<PollOutcome>;
  listOrgs(token: string): Promise<OrgRow[]>;
  listWorkspaces(token: string, orgId: string): Promise<WorkspaceRow[]>;
  reMint(token: string, orgId: string): Promise<string>;
  getMe(token: string, orgId?: string): Promise<MeResponse>;
}

/** Options for {@link createDeeplakeAuthClient} (all seams injectable). */
export interface DeeplakeAuthClientOptions {
  readonly apiUrl?: string;
  readonly fetch?: FetchLike;
  readonly sleep?: Sleeper;
  readonly maxRetries?: number;
}

/**
 * Build the reusable auth client. `fetch`, `sleep`, and the retry budget are
 * injectable; the production defaults are the global `fetch`, the real wall
 * clock, and {@link DEFAULT_MAX_RETRIES}. The token never reaches a URL or a log.
 */
export function createDeeplakeAuthClient(options: DeeplakeAuthClientOptions = {}): DeeplakeAuthClient {
  const apiUrl = (options.apiUrl ?? DEFAULT_DEEPLAKE_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = options.sleep ?? realSleeper;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  async function request(path: string, init: FetchRequestInit, expectJson: boolean): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const resp = await doFetch(`${apiUrl}${path}`, init);
      if (resp.ok) {
        return expectJson ? await resp.json().catch(() => null) : null;
      }
      lastStatus = resp.status;
      if (isRetryable(resp.status) && attempt < maxRetries) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      const body = await resp.text().catch(() => "");
      throw new AuthHttpError(resp.status, `auth API ${resp.status} for ${path}: ${sanitizeForTerminal(body.slice(0, 200))}`);
    }
    throw new AuthHttpError(lastStatus, `auth API ${lastStatus} for ${path} after ${maxRetries} retries`);
  }

  return {
    apiUrl,
    async requestDeviceCode(): Promise<DeviceCodeResponse> {
      const body = await request(
        "/auth/device/code",
        { method: "POST", headers: { "Content-Type": "application/json", [DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE } },
        true,
      );
      return body as DeviceCodeResponse;
    },
    async pollDeviceToken(deviceCode: string): Promise<PollOutcome> {
      const resp = await doFetch(`${apiUrl}/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      if (resp.ok) return { kind: "token", token: (await resp.json()) as DeviceTokenResponse };
      if (resp.status === 400) {
        const err = (await resp.json().catch(() => null)) as { error?: string } | null;
        if (err?.error === "authorization_pending") return { kind: "pending" };
        if (err?.error === "slow_down") return { kind: "slow_down" };
        if (err?.error === "expired_token") throw new AuthHttpError(400, "the sign-in code expired; run 'nectar login' again");
        if (err?.error === "access_denied") throw new AuthHttpError(400, "sign-in was denied");
      }
      throw new AuthHttpError(resp.status, `device-token poll failed: HTTP ${resp.status}`);
    },
    async listOrgs(token: string): Promise<OrgRow[]> {
      const body = await request("/organizations", { method: "GET", headers: authHeaders(token) }, true);
      return Array.isArray(body) ? (body as OrgRow[]) : [];
    },
    async listWorkspaces(token: string, orgId: string): Promise<WorkspaceRow[]> {
      const body = await request("/workspaces", { method: "GET", headers: authHeaders(token, orgId) }, true);
      const data = (body as { data?: WorkspaceRow[] } | null)?.data ?? body;
      return Array.isArray(data) ? (data as WorkspaceRow[]) : [];
    },
    async reMint(token: string, orgId: string): Promise<string> {
      const name = `nectar-cli-${Date.now()}`;
      const body = await request(
        "/users/me/tokens",
        {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ name, duration: MINT_DURATION_SECONDS, organization_id: orgId }),
        },
        true,
      );
      const minted = (body as { token?: { token?: unknown } } | null)?.token?.token;
      if (typeof minted !== "string" || minted.length === 0) throw new AuthHttpError(0, "auth API minted no token");
      return minted;
    },
    async getMe(token: string, orgId?: string): Promise<MeResponse> {
      const body = await request("/me", { method: "GET", headers: authHeaders(token, orgId) }, true);
      const me = body as Record<string, unknown> | null;
      const id = typeof me?.id === "string" ? me.id : "";
      const name = typeof me?.name === "string" ? me.name : "";
      const email = typeof me?.email === "string" ? me.email : undefined;
      return email !== undefined ? { id, name, email } : { id, name };
    },
  };
}

/**
 * Strip C0/C1 control characters (including ESC) from a server-derived string
 * before it reaches the terminal, so a compromised auth response cannot inject
 * ANSI escape sequences into the user's terminal (security audit 2026-07-04).
 */
export function sanitizeForTerminal(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl) out += ch;
  }
  return out;
}

/**
 * Validate that a server-derived verification URL is safe to open. Returns the
 * normalized href when it parses AND its scheme is `https:`; `null` otherwise -
 * so a non-https `verification_uri_complete` is never opened.
 */
export function validateVerificationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Open `url` in the OS browser - but ONLY if it is an `https:` URL. On open it
 * uses a fixed-argv `execFileSync` (never a shell), bounded by a 5s timeout, and
 * returns `false` on any failure so the caller's flow never crashes or hangs
 * (a-AC-7): `open` (darwin) / `rundll32 url.dll,FileProtocolHandler` (win32) /
 * `xdg-open` (linux).
 */
export function defaultBrowserOpener(url: string): boolean {
  const safe = validateVerificationUrl(url);
  if (safe === null) return false;
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [safe], { stdio: "ignore", timeout: 5000, windowsHide: true });
    } else if (process.platform === "win32") {
      execFileSync("rundll32", ["url.dll,FileProtocolHandler", safe], { stdio: "ignore", timeout: 5000, windowsHide: true });
    } else {
      execFileSync("xdg-open", [safe], { stdio: "ignore", timeout: 5000, windowsHide: true });
    }
    return true;
  } catch {
    return false;
  }
}

/** The explicit flags a caller passes for tenancy selection. */
export interface LoginFlags {
  /** `--org=<id>`: pin the org, skipping the prompt. */
  readonly org?: string;
  /** `--workspace=<id>`: pin the workspace, skipping the prompt. */
  readonly workspace?: string;
}

/** The resolved tenancy choice (ids + display names), never a silent guess. */
export interface ResolvedTenancy {
  readonly orgId: string;
  readonly orgName: string;
  readonly workspaceId: string;
}

/** The seams the login flow runs against (all injectable so tests never hit the network/browser). */
export interface LoginSeams {
  /** The injectable `fetch` (defaults to the global `fetch`). */
  readonly fetch?: FetchLike;
  /** The injectable poll sleeper (defaults to the real wall clock). */
  readonly sleep?: Sleeper;
  /** The browser opener (defaults to {@link defaultBrowserOpener}). */
  readonly openBrowser?: BrowserOpener;
  /** The user-facing output sink (defaults to stdout). NEVER receives the token. */
  readonly out?: (line: string) => void;
  /** Whether this is an interactive terminal (defaults to `process.stdin.isTTY === true`). */
  readonly isTTY?: boolean;
  /** Ask an interactive question (required to prompt for tenancy on a TTY). */
  readonly question?: (prompt: string) => Promise<string>;
  /** ISO "now" stamped into `savedAt` (defaults to the real clock). */
  readonly now?: () => string;
  /** Credentials dir override (tests point this at a temp HOME). */
  readonly dir?: string;
  /** The Deep Lake API base URL (defaults to {@link DEFAULT_DEEPLAKE_API_URL}). */
  readonly apiUrl?: string;
  /** A safety cap on poll attempts (defaults to {@link DEFAULT_MAX_POLLS}). */
  readonly maxPolls?: number;
}

/** The result of a login attempt: success/failure + a plain-language message (a-AC-9). */
export interface LoginResult {
  readonly ok: boolean;
  readonly message: string;
  readonly credentialsPath?: string;
  readonly orgId?: string;
  readonly workspaceId?: string;
}

/**
 * Resolve the EXPLICIT tenancy for a login (parent AC-6): flags win, a single
 * org/workspace auto-selects, multiple prompt on a TTY, and a non-TTY with no
 * flags throws {@link TenancySelectionRequiredError} naming the flags. NEVER a
 * silent `orgs[0]` guess.
 */
export async function resolveTenancy(
  client: DeeplakeAuthClient,
  token: string,
  flags: LoginFlags,
  seams: LoginSeams,
): Promise<ResolvedTenancy> {
  const isTTY = seams.isTTY ?? process.stdin.isTTY === true;
  const orgs = await client.listOrgs(token);
  if (orgs.length === 0) throw new AuthHttpError(0, "no organizations are available for this account");

  // ── choose the org ──
  let org: OrgRow;
  if (flags.org !== undefined && flags.org.length > 0) {
    org = orgs.find((o) => o.id === flags.org) ?? { id: flags.org, name: flags.org };
  } else if (orgs.length === 1) {
    org = orgs[0] as OrgRow;
  } else if (isTTY && seams.question !== undefined) {
    org = await promptChoice(seams, orgs, "organization");
  } else {
    const list = orgs.map((o) => `${o.id} (${o.name})`).join(", ");
    throw new TenancySelectionRequiredError(
      `this account has multiple organizations; choose one with --org=<id> (and --workspace=<id>). Available orgs: ${list}`,
      orgs,
    );
  }

  // ── choose the workspace ──
  let workspaceId: string;
  if (flags.workspace !== undefined && flags.workspace.length > 0) {
    workspaceId = flags.workspace;
  } else {
    const workspaces = await client.listWorkspaces(token, org.id);
    if (workspaces.length === 1) {
      workspaceId = (workspaces[0] as WorkspaceRow).id;
    } else if (workspaces.length === 0) {
      workspaceId = "default";
    } else if (isTTY && seams.question !== undefined) {
      workspaceId = (await promptChoice(seams, workspaces, "workspace")).id;
    } else {
      const list = workspaces.map((w) => `${w.id} (${w.name})`).join(", ");
      throw new TenancySelectionRequiredError(
        `org ${org.id} has multiple workspaces; choose one with --workspace=<id>. Available: ${list}`,
        orgs,
      );
    }
  }
  return { orgId: org.id, orgName: org.name, workspaceId };
}

/** Prompt the user to pick one of `rows` on a TTY; re-asks until a valid choice is made. */
async function promptChoice<T extends { id: string; name: string }>(
  seams: LoginSeams,
  rows: readonly T[],
  label: string,
): Promise<T> {
  const out =
    seams.out ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const question = seams.question;
  if (question === undefined) throw new AuthHttpError(0, `cannot prompt for a ${label} without an interactive terminal`);
  out(`Select a ${label}:`);
  rows.forEach((r, i) => out(`  ${i + 1}. ${r.id} (${r.name})`));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = (await question(`  Enter 1-${rows.length}: `)).trim();
    const byNumber = Number.parseInt(answer, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= rows.length) return rows[byNumber - 1] as T;
    const byId = rows.find((r) => r.id === answer);
    if (byId !== undefined) return byId;
    out(`  '${answer}' is not a valid ${label}; try again.`);
  }
  throw new AuthHttpError(0, `no valid ${label} was chosen`);
}

/**
 * Run the `api.deeplake.ai` device flow to completion and persist the shared
 * credential (a-AC-5). Never throws - every failure is caught and returned as a
 * `{ ok: false, message }` with a plain-language, actionable message (a-AC-9).
 *
 * Ordering (a-AC-7): the verification URL + user code are PRINTED before any
 * browser-open attempt; the opener failing never crashes the flow; polling runs
 * to completion regardless.
 */
export async function runDeviceFlowLogin(flags: LoginFlags = {}, seams: LoginSeams = {}): Promise<LoginResult> {
  const out =
    seams.out ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const sleep = seams.sleep ?? realSleeper;
  const opener = seams.openBrowser ?? defaultBrowserOpener;
  const maxPolls = seams.maxPolls ?? DEFAULT_MAX_POLLS;
  const apiUrl = seams.apiUrl ?? DEFAULT_DEEPLAKE_API_URL;
  const client = createDeeplakeAuthClient({
    apiUrl,
    ...(seams.fetch !== undefined ? { fetch: seams.fetch } : {}),
    ...(seams.sleep !== undefined ? { sleep: seams.sleep } : {}),
  });

  try {
    const grant = await client.requestDeviceCode();

    // a-AC-7: PRINT the code + URL BEFORE any browser open, so a headless run
    // always shows the user how to finish even if no browser can open. The URL
    // must validate https-only even for the PRINTED path (the user is being
    // told to open it), and both server-derived strings are stripped of
    // terminal control characters before echo (security audit 2026-07-04).
    const printableUri = validateVerificationUrl(grant.verification_uri ?? "");
    if (printableUri === null) {
      return { ok: false, message: "sign-in failed: the auth service returned a non-https verification URL; refusing to continue." };
    }
    out(`To finish signing in, open ${printableUri} and enter code: ${sanitizeForTerminal(grant.user_code ?? "")}`);

    const safe = validateVerificationUrl(grant.verification_uri_complete);
    if (safe !== null) {
      const opened = opener(safe);
      out(opened ? "Opened your browser. Waiting for sign in..." : "Could not open a browser; open the URL above manually. Waiting for sign in...");
    } else {
      out("Waiting for sign in...");
    }

    // Poll to completion, honoring the grant interval and any slow_down backoff.
    let intervalMs = Math.max(grant.interval || 5, 5) * 1000;
    let accessToken: string | undefined;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      await sleep(intervalMs);
      const outcome = await client.pollDeviceToken(grant.device_code);
      if (outcome.kind === "token") {
        accessToken = outcome.token.access_token;
        break;
      }
      if (outcome.kind === "slow_down") intervalMs += 5000;
    }
    if (accessToken === undefined) {
      return { ok: false, message: "sign-in timed out before it was approved; run 'nectar login' again." };
    }

    // Resolve tenancy EXPLICITLY (never a silent orgs[0] guess), mint the
    // long-lived org-bound token, validate + hydrate the user name via /me.
    const tenancy = await resolveTenancy(client, accessToken, flags, seams);
    const longLived = await client.reMint(accessToken, tenancy.orgId);
    const me = await client.getMe(longLived, tenancy.orgId);
    const userName = me.name.length > 0 ? me.name : me.email !== undefined ? (me.email.split("@")[0] ?? "unknown") : "unknown";

    const disk: DiskCredentials = {
      token: longLived,
      orgId: tenancy.orgId,
      orgName: tenancy.orgName,
      userName,
      workspaceId: tenancy.workspaceId,
      apiUrl: client.apiUrl,
      savedAt: "",
    };
    const saveOptions = {
      ...(seams.dir !== undefined ? { dir: seams.dir } : {}),
      ...(seams.now !== undefined ? { clock: { now: seams.now } } : {}),
    };
    saveDeepLakeCredentials(disk, saveOptions);
    const path = credentialsPath(seams.dir !== undefined ? { dir: seams.dir } : {});
    out(`Signed in as ${userName}. Using org ${tenancy.orgName} (${tenancy.orgId}), workspace ${tenancy.workspaceId}.`);
    return {
      ok: true,
      message: `nectar login: signed in; credentials written to ${path}.`,
      credentialsPath: path,
      orgId: tenancy.orgId,
      workspaceId: tenancy.workspaceId,
    };
  } catch (err: unknown) {
    if (err instanceof TenancySelectionRequiredError) {
      return { ok: false, message: `nectar login: ${err.message}` };
    }
    if (err instanceof AuthHttpError) {
      return { ok: false, message: `nectar login: ${err.message}` };
    }
    return { ok: false, message: `nectar login: ${err instanceof Error ? err.message : String(err)}` };
  }
}
