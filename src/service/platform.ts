/**
 * Platform + scope resolution for hivenectar's OS service unit (PRD-003b).
 *
 * hivenectar registers itself with the OS so it survives its own crash and a reboot,
 * mirroring hivedoctor's own self-registration module
 * (hivedoctor/src/service/platform.ts:1-187) with hivenectar's own label/unit/task
 * names and run command. WHICH service manager and at WHICH scope is decided here,
 * once, from three injected facts (the platform, the home dir, and whether the
 * process is privileged) so the rest of the service module is pure string + argv
 * construction and fully hermetic in tests.
 *
 * The binding rulings (PRD-003b):
 *   - macOS   -> launchd, user scope = LaunchAgent (`~/Library/LaunchAgents`).
 *   - Linux   -> systemd, user scope = `systemctl --user` unit (`~/.config/systemd/user`).
 *   - Windows -> Scheduled Task (per-user, no admin/UAC) is the default; a Windows
 *               Service (`sc.exe`) is the enterprise opt-in, never the userland default.
 *
 * User scope is the default everywhere (US-003b.3): it needs no root/admin and matches
 * a per-user `npm i -g`. A privileged context MAY use system scope, but an unprivileged
 * context MUST fall back to user scope rather than failing the install.
 *
 * Built-ins only; this module is pure (its inputs are injected).
 */

import { homedir, userInfo } from "node:os";

/** The OS families hivenectar knows how to register a service on. */
export type ServicePlatform = "darwin" | "linux" | "win32";

/** Which service manager backs a plan. */
export type ServiceManager = "launchd" | "systemd" | "schtasks" | "sc";

/** The privilege scope a unit is installed at. */
export type ServiceScope = "user" | "system";

/**
 * The stable label the launchd unit is registered under. Decision #32
 * (2026-07-02, `library/requirements/PRD-DECISIONS-AND-DEFAULTS.md`): the
 * fleet-wide scheme is reverse-DNS `com.legioncode.<shortname>` with the
 * product short name `nectar`, superseding the shipped `com.hivenectar.daemon`.
 */
export const SERVICE_LABEL = "com.legioncode.nectar" as const;

/** The systemd unit file name (decision #32: `<shortname>.service`). */
export const SYSTEMD_UNIT_NAME = "nectar.service" as const;

/** The Windows Scheduled Task / Service name (decision #32: the bare short name). */
export const WINDOWS_TASK_NAME = "nectar" as const;

/** The pre-decision-#32 launchd label, deregistered on install (migration path). */
export const LEGACY_SERVICE_LABEL = "com.hivenectar.daemon" as const;

/** The pre-decision-#32 systemd unit name, deregistered on install. */
export const LEGACY_SYSTEMD_UNIT_NAME = "hivenectar.service" as const;

/** The pre-decision-#32 Windows task name, deregistered on install. */
export const LEGACY_WINDOWS_TASK_NAME = "HivenectarDaemon" as const;

/** The raw facts the resolver consumes (injected so the resolver is hermetic). */
export interface ServiceEnvironment {
  /** `process.platform`. An unknown value is rejected by {@link resolveServicePlan}. */
  readonly platform: NodeJS.Platform;
  /** The user's home directory (where user-scope units are written). */
  readonly home: string;
  /** True iff the process can install a system-scoped unit (root on POSIX, admin on Windows). */
  readonly privileged: boolean;
  /** The absolute path to the `hivenectar` executable the unit will exec. */
  readonly execPath: string;
  /**
   * Opt INTO system scope when privileged (enterprise path). Default false: even as root
   * we prefer a user unit unless the operator explicitly asked for a system one.
   */
  readonly preferSystemScope?: boolean;
}

/** The fully-resolved plan: which manager, which scope, and the unit's on-disk location. */
export interface ServicePlan {
  /** The normalized platform family. */
  readonly platform: ServicePlatform;
  /** The backing service manager. */
  readonly manager: ServiceManager;
  /** The resolved install scope (user by default; system only when privileged + opted in). */
  readonly scope: ServiceScope;
  /** True when system scope was REQUESTED but the process is unprivileged, so we fell back to user. */
  readonly fellBackToUser: boolean;
  /** The absolute path the unit file is written to (plist / systemd unit). Empty for schtasks/sc. */
  readonly unitPath: string;
  /** The label/name the unit is registered under. */
  readonly label: string;
  /** The executable the unit execs. */
  readonly execPath: string;
  /** The home dir (units reference it for logs / working dir). */
  readonly home: string;
}

/** Gather the real {@link ServiceEnvironment} at the edge (the one impure call site). */
export function resolveServiceContext(execPath: string, preferSystemScope = false): ServiceEnvironment {
  return {
    platform: process.platform,
    home: homedir(),
    privileged: isPrivileged(),
    execPath,
    preferSystemScope,
  };
}

/**
 * Detect whether the current process can install a system-scoped unit. On POSIX that is
 * uid 0 (root); on Windows there is no cheap built-in admin check without shelling out,
 * so we conservatively report NOT privileged and let the default per-user Scheduled Task
 * path win. Never throws.
 */
export function isPrivileged(): boolean {
  try {
    if (process.platform === "win32") return false;
    const uid = userInfo().uid;
    return uid === 0;
  } catch {
    return false;
  }
}

/** Map a raw Node platform to a {@link ServicePlatform}, or null when unsupported. */
export function normalizePlatform(platform: NodeJS.Platform): ServicePlatform | null {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  return null;
}

/** Build the user-scope unit path for a given platform (where we WRITE the plist/unit file). */
function userUnitPath(platform: ServicePlatform, home: string): string {
  switch (platform) {
    case "darwin":
      return `${home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
    case "linux":
      return `${home}/.config/systemd/user/${SYSTEMD_UNIT_NAME}`;
    case "win32":
      // Scheduled Task is registered via schtasks (no file we own on disk).
      return "";
  }
}

/** Build the system-scope unit path for a given platform. */
function systemUnitPath(platform: ServicePlatform): string {
  switch (platform) {
    case "darwin":
      return `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`;
    case "linux":
      return `/etc/systemd/system/${SYSTEMD_UNIT_NAME}`;
    case "win32":
      // Windows Service is registered via sc.exe (no unit file we own on disk).
      return "";
  }
}

/**
 * The on-disk unit path the PRE-decision-#32 install would have used for this
 * plan's platform + scope. Install removes it (best-effort) so a re-run
 * migrates a legacy unit instead of leaving two units racing over one daemon.
 * Empty when the platform keeps no unit file (Windows).
 */
export function legacyUnitPath(plan: ServicePlan): string {
  switch (plan.platform) {
    case "darwin":
      return plan.scope === "system"
        ? `/Library/LaunchDaemons/${LEGACY_SERVICE_LABEL}.plist`
        : `${plan.home}/Library/LaunchAgents/${LEGACY_SERVICE_LABEL}.plist`;
    case "linux":
      return plan.scope === "system"
        ? `/etc/systemd/system/${LEGACY_SYSTEMD_UNIT_NAME}`
        : `${plan.home}/.config/systemd/user/${LEGACY_SYSTEMD_UNIT_NAME}`;
    case "win32":
      return "";
  }
}

/**
 * Resolve the service plan from the environment. The fallback ordering (US-003b.3):
 *   1. If system scope was requested AND the process is privileged -> system scope.
 *   2. Otherwise -> user scope (LaunchAgent / systemd --user / per-user Scheduled Task),
 *      recording `fellBackToUser` when a system unit was wanted but privilege was absent.
 *
 * Throws ONLY for a genuinely unsupported platform; the caller maps that to a clean
 * "unsupported platform" result rather than a stack trace (US-003b.3).
 */
export function resolveServicePlan(env: ServiceEnvironment): ServicePlan {
  const platform = normalizePlatform(env.platform);
  if (platform === null) {
    throw new Error(`unsupported platform: ${env.platform}`);
  }

  const wantsSystem = env.preferSystemScope === true;
  const canSystem = env.privileged;
  const scope: ServiceScope = wantsSystem && canSystem ? "system" : "user";
  const fellBackToUser = wantsSystem && !canSystem;

  const manager: ServiceManager =
    platform === "darwin"
      ? "launchd"
      : platform === "linux"
        ? "systemd"
        : // Windows: per-user Scheduled Task by default; Windows Service (sc) only at system scope.
          scope === "system"
          ? "sc"
          : "schtasks";

  const unitPath = scope === "system" ? systemUnitPath(platform) : userUnitPath(platform, env.home);

  return {
    platform,
    manager,
    scope,
    fellBackToUser,
    unitPath,
    label: SERVICE_LABEL,
    execPath: env.execPath,
    home: env.home,
  };
}
