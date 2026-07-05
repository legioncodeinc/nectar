/**
 * Solo-vs-fleet detection for nectar (PRD-003a a-AC-6).
 *
 * nectar must decide whether Hive is installed alongside it BEFORE it initiates
 * any device-flow login. The rule ("authentication is a HIVE concern when Hive
 * is present; solo installs self-serve") is settled by three LIVE signals,
 * evaluated at each decision point (the `install` verb):
 *
 *   S1 - a `daemons` entry named "hive" in the registry, reading BOTH the fleet
 *        root `registry.json` (`~/.apiary/registry.json`) and the legacy
 *        `~/.honeycomb/doctor.daemons.json` (whichever exist).
 *   S2 - any HTTP response from `http://127.0.0.1:3853/health` within a short
 *        (~750ms) budget (AbortController + the global `fetch`).
 *   S3 - `@legioncodeinc/hive` present in `npm ls -g @legioncodeinc/hive
 *        --depth 0` (best-effort `execFile`, NEVER a shell; any failure means
 *        the signal is absent).
 *
 * Classification (orchestrator decision, do not re-litigate): ANY signal fired
 * means FLEET; none means SOLO. Suppressing a popup wrongly is cheap; opening
 * one wrongly is the bug this module exists to kill. The result records which
 * signals fired so the caller can log the evidence (a-AC-6).
 *
 * This mirrors honeycomb's `src/shared/fleet-detection.ts` contract but is
 * implemented independently against nectar's own `apiary-root` helpers, never
 * imported across the process boundary (ADR-0002). Every signal is behind an
 * injectable seam so tests drive the whole surface deterministically: no
 * network, no real home dir, no `npm` subprocess.
 *
 * Built-ins only (`node:fs`, `node:child_process` loaded lazily) + the global
 * `fetch`; zero runtime dependencies.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyRuntimeDir, resolveApiaryRoot } from "./apiary-root.js";

/** The Hive portal loopback host (S2). */
export const HIVE_HOST = "127.0.0.1" as const;
/** The Hive portal loopback port (S2): 3853, distinct from nectar's 3854. */
export const HIVE_PORT = 3853 as const;
/** The npm global package name that proves Hive is installed (S3). */
export const HIVE_NPM_PACKAGE = "@legioncodeinc/hive" as const;
/** The registry `daemons[].name` that proves Hive is registered (S1). */
export const HIVE_REGISTRY_NAME = "hive" as const;
/** The fleet-root registry file name (`~/.apiary/registry.json`) - S1 primary source. */
const FLEET_REGISTRY_FILE_NAME = "registry.json" as const;
/** The legacy registry file name (`~/.honeycomb/doctor.daemons.json`) - S1 compat source. */
const LEGACY_REGISTRY_FILE_NAME = "doctor.daemons.json" as const;
/** The default budget (ms) for the live Hive-port probe (S2). */
export const FLEET_PORT_PROBE_TIMEOUT_MS = 750;

/** The two mutually-exclusive machine classifications. */
export type FleetMode = "solo" | "fleet";

/** Which of the three detection signals fired. */
export interface FleetSignals {
  /** S1: a Hive entry exists in the fleet or legacy registry file. */
  readonly registryHiveEntry: boolean;
  /** S2: the Hive portal answered on 127.0.0.1:3853 within the probe budget. */
  readonly hivePortAnswering: boolean;
  /** S3: `@legioncodeinc/hive` is present in the npm global tree. */
  readonly hiveNpmGlobal: boolean;
}

/** The deterministic classification result - the mode plus the evidence for it (a-AC-6). */
export interface FleetClassification {
  /** `fleet` when ANY signal fired; `solo` when none did. */
  readonly mode: FleetMode;
  /** The raw per-signal booleans. */
  readonly signals: FleetSignals;
  /** Human-readable labels of the signals that fired (for logs / status). */
  readonly firedSignals: readonly string[];
}

/**
 * The injectable seams. Production leaves all unset (the real fs / fetch / npm
 * defaults apply); a test injects each to drive the classification without
 * touching the network, the real home, or an `npm` subprocess.
 */
export interface FleetDetectionSeams {
  /** Override S1 wholesale (else the default reads the two registry files under `home`/`env`). */
  readonly readRegistrySignal?: () => boolean;
  /** Override S2 wholesale (else the default probes 127.0.0.1:3853/health). */
  readonly probeHivePort?: (timeoutMs: number) => Promise<boolean>;
  /** Override S3 wholesale (else the default runs `npm ls -g` best-effort). */
  readonly npmGlobalHasHive?: () => Promise<boolean>;
  /** The home dir the registry paths resolve under. Defaults to `os.homedir()`. */
  readonly home?: string;
  /** The env the fleet root resolves from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The platform (steers the npm binary name). Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** True when the registry document at `path` carries a `daemons[]` entry named "hive". */
function registryFileHasHive(path: string): boolean {
  if (!existsSync(path)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const daemons = (parsed as { daemons?: unknown }).daemons;
  if (!Array.isArray(daemons)) return false;
  return daemons.some(
    (entry) => typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === HIVE_REGISTRY_NAME,
  );
}

/** The candidate registry paths S1 reads: the fleet-root file, then the legacy file. */
export function registryCandidatePaths(seams: FleetDetectionSeams = {}): readonly string[] {
  const env = seams.env ?? process.env;
  const home = seams.home ?? homedir();
  const rootOptions = {
    ...(seams.home !== undefined ? { home: seams.home } : {}),
    ...(seams.platform !== undefined ? { platform: seams.platform } : {}),
  };
  return [
    join(resolveApiaryRoot(env, rootOptions), FLEET_REGISTRY_FILE_NAME),
    join(legacyRuntimeDir(home), LEGACY_REGISTRY_FILE_NAME),
  ];
}

/** The default S1: read the fleet + legacy registry files for a Hive entry. */
export function defaultReadRegistrySignal(seams: FleetDetectionSeams = {}): boolean {
  return registryCandidatePaths(seams).some(registryFileHasHive);
}

/** The default S2: any HTTP answer from the Hive portal within `timeoutMs` proves it is up. */
export async function defaultProbeHivePort(timeoutMs: number = FLEET_PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    await fetch(`http://${HIVE_HOST}:${HIVE_PORT}/health`, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The default S3: `npm ls -g @legioncodeinc/hive --depth 0`, best-effort and
 * fixed-argv. Any failure (npm missing, a non-zero exit because the package
 * is absent, a timeout) resolves `false` - the signal is present only when npm
 * exits 0 AND names the package. `npm` ships as `npm.cmd` on Windows, and since
 * Node's CVE-2024-27980 hardening a `.cmd` cannot be spawned with `shell: false`
 * (it throws EINVAL, which would silently blind this signal on every Windows
 * machine), so win32 alone sets `shell: true` - safe here because every argv
 * element is a compile-time constant, never user input.
 */
export function defaultNpmGlobalHasHive(seams: FleetDetectionSeams = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const platform = seams.platform ?? process.platform;
      const win32 = platform === "win32";
      execFile(
        win32 ? "npm.cmd" : "npm",
        ["ls", "-g", HIVE_NPM_PACKAGE, "--depth", "0"],
        { timeout: 5000, windowsHide: true, shell: win32 },
        (err, stdout) => {
          if (err) {
            resolve(false);
            return;
          }
          resolve(typeof stdout === "string" && stdout.includes(HIVE_NPM_PACKAGE));
        },
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Classify the machine solo-vs-fleet from the three LIVE signals (a-AC-6). ANY
 * signal fired means FLEET; none means SOLO. Deterministic for a given machine
 * state, and the result records which signals fired so the caller can log the
 * evidence. S2 (the network probe) and S3 (the npm read) run concurrently; S1
 * is a cheap synchronous file read.
 */
export async function classifyFleet(seams: FleetDetectionSeams = {}): Promise<FleetClassification> {
  const registryHiveEntry = (seams.readRegistrySignal ?? (() => defaultReadRegistrySignal(seams)))();
  const [hivePortAnswering, hiveNpmGlobal] = await Promise.all([
    (seams.probeHivePort ?? defaultProbeHivePort)(FLEET_PORT_PROBE_TIMEOUT_MS),
    (seams.npmGlobalHasHive ?? (() => defaultNpmGlobalHasHive(seams)))(),
  ]);
  const signals: FleetSignals = { registryHiveEntry, hivePortAnswering, hiveNpmGlobal };
  const firedSignals: string[] = [];
  if (registryHiveEntry) firedSignals.push("registry Hive entry");
  if (hivePortAnswering) firedSignals.push("Hive portal on 127.0.0.1:3853");
  if (hiveNpmGlobal) firedSignals.push(`npm global ${HIVE_NPM_PACKAGE}`);
  return { mode: firedSignals.length > 0 ? "fleet" : "solo", signals, firedSignals };
}

/** A one-line, log-friendly summary of a classification (a-AC-6 supportability). */
export function fleetSignalLine(classification: FleetClassification): string {
  if (classification.mode === "fleet") {
    return `fleet detection: FLEET (signals fired: ${classification.firedSignals.join(", ")}).`;
  }
  return "fleet detection: SOLO (no Hive signals fired: no registry entry, no 127.0.0.1:3853 answer, no npm global).";
}
