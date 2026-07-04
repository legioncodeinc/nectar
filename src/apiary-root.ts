import { homedir } from "node:os";
import { join, win32 } from "node:path";

/** Legacy runtime directory basename retained for migration/fallback reads. */
export const LEGACY_RUNTIME_DIR_NAME = ".honeycomb";

/** Fleet root basename when neither APIARY_HOME nor Linux XDG are set. */
export const APIARY_ROOT_DIR_NAME = ".apiary";

/** Nectar's per-product state directory basename under the fleet root. */
export const NECTAR_STATE_DIR_NAME = "nectar";

export interface ResolveApiaryRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed;
}

/**
 * Env roots are honored only when ABSOLUTE (fleet security rule, 2026-07-04; the
 * XDG Base Directory spec also requires ignoring relative values). Honoring a
 * relative value would anchor the fleet root, and everything derived from it,
 * on process.cwd(), the exact footgun ADR-0005 exists to prevent.
 * `win32.isAbsolute` accepts `/x`, `\x`, and `C:\x`, a strict superset of the
 * posix check, so a relative value is never mistaken for absolute on any host.
 */
function isAbsoluteRoot(value: string): boolean {
  return win32.isAbsolute(value);
}

/**
 * Resolve the fleet root per ADR-0005's canonical chain.
 *
 * 1) APIARY_HOME when set, non-blank, and absolute.
 * 2) Linux-only XDG_STATE_HOME/apiary when explicitly set, non-blank, and absolute.
 * 3) <homedir>/.apiary on every platform otherwise.
 */
export function resolveApiaryRoot(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveApiaryRootOptions = {},
): string {
  const configuredApiaryHome = nonBlank(env.APIARY_HOME);
  if (configuredApiaryHome !== undefined && isAbsoluteRoot(configuredApiaryHome)) {
    return configuredApiaryHome;
  }

  const platform = options.platform ?? process.platform;
  const configuredXdgStateHome = nonBlank(env.XDG_STATE_HOME);
  if (platform === "linux" && configuredXdgStateHome !== undefined && isAbsoluteRoot(configuredXdgStateHome)) {
    return join(configuredXdgStateHome, "apiary");
  }

  const home = options.home ?? homedir();
  return join(home, APIARY_ROOT_DIR_NAME);
}

/** Resolve nectar's per-product runtime state directory under the fleet root. */
export function nectarStateDir(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveApiaryRootOptions = {},
): string {
  return join(resolveApiaryRoot(env, options), NECTAR_STATE_DIR_NAME);
}

/** Resolve the legacy ~/.honeycomb runtime directory used during migration. */
export function legacyRuntimeDir(home: string = homedir()): string {
  return join(home, LEGACY_RUNTIME_DIR_NAME);
}
