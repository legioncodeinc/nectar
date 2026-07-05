/**
 * Brood prerequisite evaluation and first-run guidance (PRD-018k / NEC-023).
 *
 * Brooding is dormant out of the box: auto-brood on boot runs only when Deep
 * Lake credentials resolve AND Portkey is explicitly enabled (via
 * `NECTAR_PORTKEY_ENABLED` + `NECTAR_PORTKEY_API_KEY` + `NECTAR_PORTKEY_CONFIG`).
 * Without those the daemon boots, serves `/health`, and describes nothing, with
 * no signal that it is waiting on configuration. This module makes the dormancy
 * loud: the daemon logs exactly which prerequisites are missing at startup, the
 * `/health` brooding slice carries a machine-readable reason, and (on an
 * interactive terminal) the CLI prints the exact steps to configure them.
 *
 * Pure and dependency-free (Node built-ins only, AGENTS.md): a caller supplies
 * whether the credentials file resolved and the Portkey env flags; this module
 * decides ready/dormant, the machine-readable reason, and the human message.
 */

/** The machine-readable dormancy reason surfaced on `/health` and in the startup log. */
export type BroodDormancyReason = "credentials_missing" | "portkey_disabled";

/** The outcome of evaluating the brood prerequisites. */
export interface BroodPrereqStatus {
  /** True when every prerequisite is satisfied (auto-brood can run). */
  readonly ready: boolean;
  /** The machine-readable reason when dormant; null when ready. */
  readonly reason: BroodDormancyReason | null;
  /** Human-readable list of exactly what is missing (empty when ready). */
  readonly missing: readonly string[];
}

/** The resolved prerequisite inputs (each already reduced to a boolean by the caller). */
export interface BroodPrereqInputs {
  /** `~/.deeplake/credentials.json` resolved and validated. */
  readonly credentialsPresent: boolean;
  /** The credentials file path, named in the missing list when absent. */
  readonly credentialsPath: string;
  /** `NECTAR_PORTKEY_ENABLED` is set to a truthy value. */
  readonly portkeyEnabled: boolean;
  /** `NECTAR_PORTKEY_API_KEY` is set (non-blank). */
  readonly portkeyApiKeySet: boolean;
  /** `NECTAR_PORTKEY_CONFIG` is set (non-blank). */
  readonly portkeyConfigSet: boolean;
}

/**
 * Evaluate the brood prerequisites. `ready` is true only when the credentials
 * file resolved and all three Portkey variables are set; otherwise `reason` is
 * `credentials_missing` (credentials take priority as the first blocker) or
 * `portkey_disabled`, and `missing` names each unsatisfied prerequisite so the
 * startup log can enumerate them (AC-018k.1 / AC-018k.2).
 */
export function evaluateBroodPrereqs(inputs: BroodPrereqInputs): BroodPrereqStatus {
  const missing: string[] = [];
  if (!inputs.credentialsPresent) missing.push(`${inputs.credentialsPath} (Deep Lake credentials)`);
  if (!inputs.portkeyEnabled) missing.push("NECTAR_PORTKEY_ENABLED");
  if (!inputs.portkeyApiKeySet) missing.push("NECTAR_PORTKEY_API_KEY");
  if (!inputs.portkeyConfigSet) missing.push("NECTAR_PORTKEY_CONFIG");

  if (missing.length === 0) return { ready: true, reason: null, missing: [] };
  const reason: BroodDormancyReason = inputs.credentialsPresent ? "portkey_disabled" : "credentials_missing";
  return { ready: false, reason, missing };
}

/** True when an env value is a recognized truthy flag (mirrors portkey/config's `envBool`). */
function envTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** True when an env value is present and non-blank. */
function envSet(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "";
}

/** Build the prerequisite status from the process env + a resolved credentials state. */
export function broodPrereqsFromEnv(opts: {
  readonly credentialsPresent: boolean;
  readonly credentialsPath: string;
  readonly env?: NodeJS.ProcessEnv;
}): BroodPrereqStatus {
  const env = opts.env ?? process.env;
  return evaluateBroodPrereqs({
    credentialsPresent: opts.credentialsPresent,
    credentialsPath: opts.credentialsPath,
    portkeyEnabled: envTruthy(env["NECTAR_PORTKEY_ENABLED"]),
    portkeyApiKeySet: envSet(env["NECTAR_PORTKEY_API_KEY"]),
    portkeyConfigSet: envSet(env["NECTAR_PORTKEY_CONFIG"]),
  });
}

/**
 * Build the guided first-run message a caller prints on an interactive terminal
 * (AC-018k.5 option B): the exact steps to satisfy the missing prerequisites.
 * Returns the empty string when nothing is missing, so a caller can print it
 * unconditionally without a "you are configured" line.
 */
export function formatFirstRunGuidance(status: BroodPrereqStatus): string {
  if (status.ready) return "";
  const lines: string[] = [
    "nectar: brooding is dormant, so no file will be described yet.",
    "To enable it, configure these prerequisites, then restart the daemon:",
  ];
  if (status.reason === "credentials_missing") {
    // Point at the Hive dashboard first: on a fleet install that is where sign-in lives, and it
    // is the path a non-technical operator can actually follow. The credentials file it produces
    // (~/.deeplake/credentials.json) is the same one a solo install signs in to directly.
    lines.push("  1. Sign in from the Hive dashboard (http://127.0.0.1:3853/) so ~/.deeplake/credentials.json");
    lines.push("     exists (the shared Deeplake credentials).");
    lines.push("  2. Enable Portkey so descriptions can be generated:");
  } else {
    lines.push("  1. Enable Portkey so descriptions can be generated:");
  }
  lines.push("       export NECTAR_PORTKEY_ENABLED=1");
  lines.push("       export NECTAR_PORTKEY_API_KEY=<your Portkey API key>");
  lines.push("       export NECTAR_PORTKEY_CONFIG=<your Portkey config id>");
  lines.push(`Missing now: ${status.missing.join(", ")}.`);
  return `${lines.join("\n")}\n`;
}
