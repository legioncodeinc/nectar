/**
 * Portkey + activeModel resolution for hivenectar (PRD-010).
 *
 * Disabled or keyless Portkey is an explicit, testable `{ enabled: false }` state;
 * this module never throws at import time. Env names follow the `HIVENECTAR_*`
 * convention used by `src/config.ts`.
 */

/** SIGNED OFF 2026-07-02 (decision #29): default description model id. */
export const DEFAULT_ACTIVE_MODEL = "gemini-2.5-flash" as const;

/** Portkey is off or not configured enough to call the gateway. */
export interface PortkeyDisabled {
  readonly enabled: false;
  readonly reason: "disabled" | "missing_api_key" | "missing_config_id";
}

/** Portkey is enabled with the credentials needed for chat completions. */
export interface PortkeyEnabled {
  readonly enabled: true;
  readonly apiKey: string;
  readonly configId: string;
  readonly activeModel: string;
}

export type PortkeyRuntimeConfig = PortkeyDisabled | PortkeyEnabled;

export interface PortkeyConfigOverrides {
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly configId?: string;
  readonly activeModel?: string;
  /** Injectable env bag for tests; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

function envStr(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = envStr(env, name);
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return undefined;
}

/**
 * Resolve Portkey enablement, credentials, and the active description model.
 *
 * Env layer (each flagged [DEFAULT - confirm before implementation] in PRD-010):
 *   - `HIVENECTAR_PORTKEY_ENABLED`     explicit on/off gate (absent => off)
 *   - `HIVENECTAR_PORTKEY_API_KEY`     Portkey API key (required when enabled)
 *   - `HIVENECTAR_PORTKEY_CONFIG`      `portkey.config` / virtual-key id (required when enabled)
 *   - `HIVENECTAR_ACTIVE_MODEL`        description model id (default `gemini-2.5-flash`, decision #29)
 */
export function resolvePortkeyConfig(overrides: PortkeyConfigOverrides = {}): PortkeyRuntimeConfig {
  const env = overrides.env ?? process.env;

  const enabled =
    overrides.enabled ??
    envBool(env, "HIVENECTAR_PORTKEY_ENABLED") ??
    false;

  if (!enabled) {
    return { enabled: false, reason: "disabled" };
  }

  const apiKey = overrides.apiKey ?? envStr(env, "HIVENECTAR_PORTKEY_API_KEY");
  if (apiKey === undefined) {
    return { enabled: false, reason: "missing_api_key" };
  }

  const configId = overrides.configId ?? envStr(env, "HIVENECTAR_PORTKEY_CONFIG");
  if (configId === undefined) {
    return { enabled: false, reason: "missing_config_id" };
  }

  const activeModel =
    overrides.activeModel ??
    envStr(env, "HIVENECTAR_ACTIVE_MODEL") ??
    DEFAULT_ACTIVE_MODEL;

  return { enabled: true, apiKey, configId, activeModel };
}

/**
 * Keys exposed on {@link PortkeyRuntimeConfig} for AC-5 structural checks: no cache or
 * guardrail toggle exists on this surface (DECISION #6).
 */
export const PORTKEY_CONFIG_SURFACE_KEYS = [
  "enabled",
  "apiKey",
  "configId",
  "activeModel",
  "reason",
] as const;
