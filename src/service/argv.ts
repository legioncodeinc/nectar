/**
 * Exact argv construction for every service-manager command (PRD-003b).
 *
 * Mirrors hivedoctor's `service/argv.ts` with hivenectar's unit/task names. Each
 * operation - install, uninstall, status - maps to one or more ordered argv arrays.
 * This module is the single source of truth for those argv arrays; it is pure (a
 * {@link ServicePlan} in, argv arrays out) so a test asserts the EXACT command line
 * per platform without ever executing it.
 *
 * Every command goes through the injected {@link CommandRunner} (execFile, no shell),
 * so a unit path or label can never be re-parsed as a shell metacharacter.
 *
 * launchd: `launchctl bootstrap gui/<uid> <plist>` (modern) to load, `bootout` to unload.
 * systemd: `systemctl --user enable --now hivenectar.service` to install+start,
 *          `disable --now` to remove, `is-active` for status.
 * schtasks: `/Create /XML <file> /TN HivenectarDaemon /F` (per-user, no admin),
 *           `/Delete /TN HivenectarDaemon /F`, `/Query /TN HivenectarDaemon` for status.
 * sc.exe:  `create` + `start` (system service, enterprise opt-in), `stop`+`delete`,
 *          `query` for status.
 *
 * Built-ins only; pure functions.
 */

import { SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";

/** A single command: the executable + its argv (no shell). */
export interface ServiceCommand {
  /** The binary to exec (e.g. `launchctl`, `systemctl`, `schtasks`, `sc`). */
  readonly command: string;
  /** The argv array (no shell parsing). */
  readonly args: readonly string[];
}

/** Build the launchd `gui/<uid>` domain-target string used by bootstrap/bootout. */
export function launchdDomainTarget(plan: ServicePlan, uid: number): string {
  return plan.scope === "system" ? "system" : `gui/${uid}`;
}

/** The launchd service target (`<domain>/<label>`) used by `bootout` + `kickstart`. */
export function launchdServiceTarget(plan: ServicePlan, uid: number): string {
  return `${launchdDomainTarget(plan, uid)}/${plan.label}`;
}

/**
 * The argv to INSTALL (register + start) the service for this plan. Returns the
 * ordered list of commands to run; the caller writes the unit file first (when the
 * plan has a unitPath), then runs these.
 */
export function installCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd": {
      const domain = launchdDomainTarget(plan, uid);
      return [
        { command: "launchctl", args: ["bootstrap", domain, plan.unitPath] },
        { command: "launchctl", args: ["kickstart", "-k", launchdServiceTarget(plan, uid)] },
      ];
    }
    case "systemd": {
      const scopeArgs = plan.scope === "user" ? ["--user"] : [];
      return [{ command: "systemctl", args: [...scopeArgs, "enable", "--now", SYSTEMD_UNIT_NAME] }];
    }
    case "schtasks": {
      return [
        { command: "schtasks", args: ["/Create", "/XML", plan.unitPath, "/TN", WINDOWS_TASK_NAME, "/F"] },
        { command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
      ];
    }
    case "sc": {
      const binPath = `"${process.execPath}" "${plan.execPath}" daemon`;
      return [
        { command: "sc", args: ["create", WINDOWS_TASK_NAME, `binPath=${binPath}`, "start=", "auto"] },
        { command: "sc", args: ["start", WINDOWS_TASK_NAME] },
      ];
    }
  }
}

/** The argv to UNINSTALL (stop + remove) the service for this plan, in order. */
export function uninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] }];
    case "systemd": {
      const scopeArgs = plan.scope === "user" ? ["--user"] : [];
      return [{ command: "systemctl", args: [...scopeArgs, "disable", "--now", SYSTEMD_UNIT_NAME] }];
    }
    case "schtasks":
      return [{ command: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"] }];
    case "sc":
      return [
        { command: "sc", args: ["stop", WINDOWS_TASK_NAME] },
        { command: "sc", args: ["delete", WINDOWS_TASK_NAME] },
      ];
  }
}

/** The single argv to QUERY status. The caller interprets the command's exit/stdout. */
export function statusCommand(plan: ServicePlan, uid: number): ServiceCommand {
  switch (plan.manager) {
    case "launchd":
      return { command: "launchctl", args: ["print", launchdServiceTarget(plan, uid)] };
    case "systemd": {
      const scopeArgs = plan.scope === "user" ? ["--user"] : [];
      return { command: "systemctl", args: [...scopeArgs, "is-active", SYSTEMD_UNIT_NAME] };
    }
    case "schtasks":
      return { command: "schtasks", args: ["/Query", "/TN", WINDOWS_TASK_NAME] };
    case "sc":
      return { command: "sc", args: ["query", WINDOWS_TASK_NAME] };
  }
}
