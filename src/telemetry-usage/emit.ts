/**
 * The SINGLE PostHog usage-telemetry chokepoint for nectar.
 *
 * NOT src/telemetry/: that module is the doctor SQLite fleet-telemetry
 * store (check-ins, heartbeats, logs). THIS module is the only place in the
 * codebase that posts anonymous lifecycle events (installed, uninstalled,
 * first_run, updated) to the PostHog capture endpoint. It mirrors honeycomb's
 * emit chokepoint posture (honeycomb src/daemon/runtime/telemetry/emit.ts):
 *
 *   - body is exactly { api_key, event, properties, distinct_id }, POSTed to
 *     {host}/i/v0/e/ with a 2 second AbortController timeout;
 *   - the payload is built from a CLOSED allow-list, never from caller input:
 *     { package: "nectar", version, os, arch, node } and nothing else;
 *   - gates, in order: (1) empty baked key means hard-disabled (every dev or
 *     source build), (2) NECTAR_TELEMETRY=0 (nectar's own switch), the
 *     DETECTED HONEYCOMB_TELEMETRY=0 family opt-out, or DO_NOT_TRACK truthy
 *     means opted out, (3) the dedupe ledger means at most once per machine
 *     (per version for nectar_updated);
 *   - fail-soft everywhere: emit never throws, never blocks past the bounded
 *     timeout, and never changes a host flow's exit code. A network error, a
 *     timeout, a 4xx, a 5xx, or a ledger IO failure all resolve to a skipped
 *     outcome instead of propagating.
 *
 * The key arrives via src/telemetry-usage/posthog-key.ts, a committed-empty
 * stub that scripts/bake-posthog-key.mjs rewrites in dist/ at release time
 * (plain tsc build, so there is no esbuild define mechanism here).
 *
 * distinct_id is anonymous: the honeycomb installer's ~/.honeycomb/install-id
 * when present (so the funnel correlates across the product family), else a
 * random UUID minted once and persisted in the ledger file under nectar's
 * runtime dir (~/.honeycomb by default, resolveConfig's RUNTIME_DIR_NAME).
 * Never an email, an account id, a hostname, or a path.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_DIR_NAME } from "../config.js";
import { POSTHOG_HOST, POSTHOG_KEY } from "./posthog-key.js";

/** The pinned PostHog capture path. The full ingest URL is `${host}${POSTHOG_CAPTURE_PATH}`. */
export const POSTHOG_CAPTURE_PATH = "/i/v0/e/";

/** The default PostHog US cloud ingest host, used when no host was baked. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The bounded POST timeout: a telemetry POST never delays a CLI verb longer than this. */
export const DEFAULT_EMIT_TIMEOUT_MS = 2000;

/** nectar's OWN opt-out env var. `NECTAR_TELEMETRY=0` silences all usage telemetry (ADR-0002: nectar depends on no honeycomb env). */
export const ENV_TELEMETRY = "NECTAR_TELEMETRY";

/**
 * Honeycomb's family opt-out, DETECTED and honored when present (never
 * required): an operator who silenced the honeycomb install with
 * `HONEYCOMB_TELEMETRY=0` should not have to discover a second switch for a
 * co-installed nectar. Detection-only per ADR-0002; nectar functions
 * identically when honeycomb is absent.
 */
export const DETECTED_FAMILY_TELEMETRY = "HONEYCOMB_TELEMETRY";

/** The cross-tool opt-out standard. Any value other than empty or "0" silences all usage telemetry. */
export const ENV_DO_NOT_TRACK = "DO_NOT_TRACK";

/** The installer-minted anonymous id file shared across the honeycomb product family. */
export const INSTALL_ID_FILE_NAME = "install-id";

/** The dedupe ledger + fallback distinct id file, namespaced so it coexists in the shared runtime dir. */
export const USAGE_LEDGER_FILE_NAME = "nectar-usage-telemetry.json";

/** The four lifecycle events this chokepoint may ever emit. */
export type UsageEventName =
  | "nectar_installed"
  | "nectar_uninstalled"
  | "nectar_first_run"
  | "nectar_updated";

/** The CLOSED payload shape. Nothing outside these five keys ever leaves the machine. */
export interface UsageProperties {
  readonly package: "nectar";
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly node: string;
}

/** Why an emit did NOT send. Resolved, never thrown. */
export type UsageSkipReason = "disabled" | "opted_out" | "already_reported" | "send_failed";

/** The outcome of one emit call (always resolves, never rejects). */
export interface UsageEmitOutcome {
  readonly sent: boolean;
  readonly skipped?: UsageSkipReason;
}

/** The minimal fetch response shape the chokepoint reads. */
export interface UsageFetchResponse {
  readonly ok: boolean;
  readonly status: number;
}

/** The minimal request init the chokepoint passes. */
export interface UsageFetchRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/** The injectable fetch seam so tests record the POST instead of hitting PostHog. */
export type UsageFetch = (url: string, init: UsageFetchRequestInit) => Promise<UsageFetchResponse>;

/** The injectable seams. Production defaults are the global fetch, process.env, and ~/.honeycomb. */
export interface UsageEmitDeps {
  readonly fetch?: UsageFetch;
  readonly env?: NodeJS.ProcessEnv;
  /** Override the state dir (tests point this at a temp dir). Default: `~/.honeycomb`. */
  readonly dir?: string;
  /** Override the baked key (tests force the keyed branch without a bake). */
  readonly posthogKey?: string;
  /** Override the capture host. */
  readonly posthogHost?: string;
  readonly timeoutMs?: number;
  /** Override the reported version (default: read from package.json). */
  readonly version?: string;
}

/** The on-disk ledger: the fallback distinct id, the dedupe entries, and the last-seen version. */
interface UsageLedger {
  distinctId?: string;
  reported: string[];
  lastSeenVersion?: string;
}

/**
 * True when the user opted out via nectar's own env var, the detected
 * honeycomb family opt-out, or DO_NOT_TRACK (consoledonottrack.com convention).
 */
export function isOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[ENV_TELEMETRY] === "0") return true;
  if (env[DETECTED_FAMILY_TELEMETRY] === "0") return true;
  const dnt = env[ENV_DO_NOT_TRACK];
  return dnt !== undefined && dnt !== "" && dnt !== "0";
}

/** Build the full capture URL from a host (trailing slashes trimmed). */
export function captureUrl(host: string): string {
  return `${host.replace(/\/+$/, "")}${POSTHOG_CAPTURE_PATH}`;
}

/** The default state dir: nectar's runtime dir convention (shared `~/.honeycomb`). */
function defaultStateDir(): string {
  return join(homedir(), RUNTIME_DIR_NAME);
}

/**
 * The nectar version, read from the package.json two levels above this
 * module (src/telemetry-usage/ and dist/telemetry-usage/ both sit two levels
 * below the package root). Fail-soft to "0.0.0" so a packaging anomaly never
 * breaks a CLI verb.
 */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Load the ledger, treating a missing or corrupt file as a fresh one (fail-soft). */
function loadLedger(dir: string): UsageLedger {
  try {
    const raw = readFileSync(join(dir, USAGE_LEDGER_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<UsageLedger>;
    return {
      ...(typeof parsed.distinctId === "string" ? { distinctId: parsed.distinctId } : {}),
      reported: Array.isArray(parsed.reported) ? parsed.reported.filter((e) => typeof e === "string") : [],
      ...(typeof parsed.lastSeenVersion === "string" ? { lastSeenVersion: parsed.lastSeenVersion } : {}),
    };
  } catch {
    return { reported: [] };
  }
}

/** Persist the ledger, creating the state dir (0o700) when needed. Throws on IO failure; callers swallow. */
function saveLedger(dir: string, ledger: UsageLedger): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, USAGE_LEDGER_FILE_NAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** Read the installer's anonymous install-id when present and non-empty, else undefined. */
function readInstallId(dir: string): string | undefined {
  try {
    const raw = readFileSync(join(dir, INSTALL_ID_FILE_NAME), "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** The dedupe ledger key: plain event name, except updated which dedupes per version. */
function dedupeKey(event: UsageEventName, version: string): string {
  return event === "nectar_updated" ? `${event}@${version}` : event;
}

/** Assemble the closed allow-list payload. This is the only payload builder; no caller input flows in. */
function buildProperties(version: string): UsageProperties {
  return { package: "nectar", version, os: platform(), arch: arch(), node: process.version };
}

/**
 * THE CHOKEPOINT. Emit one lifecycle event through the gates (disabled, opted
 * out, already reported) and, past all three, a single bounded fire-and-forget
 * POST. On a 2xx the dedupe key is recorded in the ledger. Never throws.
 */
export async function emitUsageEvent(event: UsageEventName, deps: UsageEmitDeps = {}): Promise<UsageEmitOutcome> {
  const key = deps.posthogKey ?? POSTHOG_KEY;

  // Gate 1: empty baked key means hard-disabled (dev or source build). No IO, no network.
  if (key.length === 0) return { sent: false, skipped: "disabled" };

  // Gate 2: opted out via either env var. No IO, no network.
  if (isOptedOut(deps.env ?? process.env)) return { sent: false, skipped: "opted_out" };

  try {
    const dir = deps.dir ?? defaultStateDir();
    const version = deps.version ?? readPackageVersion();
    const ledger = loadLedger(dir);

    // distinct_id preference: the installer's install-id when present, else a
    // UUID minted once and persisted in the ledger so it stays stable.
    let distinctId = readInstallId(dir);
    if (distinctId === undefined) {
      if (ledger.distinctId === undefined) {
        ledger.distinctId = randomUUID();
        saveLedger(dir, ledger);
      }
      distinctId = ledger.distinctId;
    }

    // Gate 3: dedupe. Each event sends at most once per machine (per version for updated).
    const dedupe = dedupeKey(event, version);
    if (ledger.reported.includes(dedupe)) return { sent: false, skipped: "already_reported" };

    const ok = await postCapture(event, buildProperties(version), distinctId, key, deps);
    if (!ok) return { sent: false, skipped: "send_failed" };

    // 2xx: record the dedupe key. The persist is best-effort; a failure here
    // must not flip a successful send into send_failed.
    try {
      ledger.reported.push(dedupe);
      saveLedger(dir, ledger);
    } catch {
      // A persist hiccup after a successful send is non-fatal.
    }
    return { sent: true };
  } catch {
    // Fail-soft: any unexpected error (IO, a thrown fetch) is swallowed.
    return { sent: false, skipped: "send_failed" };
  }
}

/** Issue the ONE bounded-timeout POST and report whether it was a 2xx. Swallows everything. */
async function postCapture(
  event: UsageEventName,
  properties: UsageProperties,
  distinctId: string,
  key: string,
  deps: UsageEmitDeps,
): Promise<boolean> {
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as UsageFetch);
  const host = deps.posthogHost ?? (POSTHOG_HOST.length > 0 ? POSTHOG_HOST : DEFAULT_POSTHOG_HOST);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
  const body = { api_key: key, event, properties, distinct_id: distinctId };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await doFetch(captureUrl(host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    // A dropped lifecycle event is acceptable; a hung CLI verb is not.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Fired by `nectar install` after the installer succeeds. Once per machine. */
export async function emitInstalled(deps: UsageEmitDeps = {}): Promise<UsageEmitOutcome> {
  return emitUsageEvent("nectar_installed", deps);
}

/** Fired by `nectar uninstall` before teardown. Fire-and-forget. */
export function emitUninstalled(deps: UsageEmitDeps = {}): Promise<UsageEmitOutcome> {
  return emitUsageEvent("nectar_uninstalled", deps);
}

/** The outcome of the daemon-start hook: which of the two events were attempted. */
export interface DaemonStartTelemetry {
  readonly firstRun: UsageEmitOutcome | null;
  readonly updated: UsageEmitOutcome | null;
}

/**
 * The daemon-start hook: fires `nectar_first_run` (once per machine) and,
 * when the persisted last-seen version differs from the current one, fires
 * `nectar_updated` (deduped per version), then persists the new version.
 * The version bookkeeping is a local file write and happens regardless of the
 * emit gates, so a later opt-in never replays a stale backlog. Never throws.
 */
export async function recordDaemonStart(deps: UsageEmitDeps = {}): Promise<DaemonStartTelemetry> {
  try {
    const dir = deps.dir ?? defaultStateDir();
    const version = deps.version ?? readPackageVersion();
    const lastSeen = loadLedger(dir).lastSeenVersion;

    const firstRun = await emitUsageEvent("nectar_first_run", deps);

    let updated: UsageEmitOutcome | null = null;
    if (lastSeen !== undefined && lastSeen !== version) {
      updated = await emitUsageEvent("nectar_updated", deps);
    }

    if (lastSeen !== version) {
      // Reload: the emits above may have persisted dedupe entries or a distinct id.
      const ledger = loadLedger(dir);
      ledger.lastSeenVersion = version;
      try {
        saveLedger(dir, ledger);
      } catch {
        // Best-effort; the updated event's per-version dedupe is the backstop.
      }
    }

    return { firstRun, updated };
  } catch {
    return { firstRun: null, updated: null };
  }
}
