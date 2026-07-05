/**
 * Exact argv construction for every service-manager command (PRD-003b).
 *
 * Mirrors doctor's `service/argv.ts` with nectar's unit/task names. Each
 * operation - install, uninstall, status - maps to one or more ordered argv arrays.
 * This module is the single source of truth for those argv arrays; it is pure (a
 * {@link ServicePlan} in, argv arrays out) so a test asserts the EXACT command line
 * per platform without ever executing it.
 *
 * Every command goes through the injected {@link CommandRunner} (execFile, no shell),
 * so a unit path or label can never be re-parsed as a shell metacharacter.
 *
 * launchd: `launchctl bootstrap gui/<uid> <plist>` (modern) to load, `bootout` to unload.
 * systemd: `systemctl --user enable --now nectar.service` to install+start,
 *          `disable --now` to remove, `is-active` for status.
 * schtasks: `/Create /XML <file> /TN nectar /F` (per-user, no admin),
 *           `/Delete /TN nectar /F`, `/Query /TN nectar` for status.
 * sc.exe:  `create` + `start` (system service, enterprise opt-in), `stop`+`delete`,
 *          `query` for status.
 *
 * Built-ins only; pure functions.
 */

import {
  LEGACY_SERVICE_LABEL,
  LEGACY_SYSTEMD_UNIT_NAME,
  LEGACY_WINDOWS_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  type ServicePlan,
} from "./platform.js";

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
      // NEC-042 item 3 / AC-018l.10: `daemon-reload` BEFORE `enable --now`, so a
      // reinstall over a changed unit file makes systemd re-read it instead of
      // keeping the cached (stale) unit definition running.
      return [
        { command: "systemctl", args: [...scopeArgs, "daemon-reload"] },
        { command: "systemctl", args: [...scopeArgs, "enable", "--now", SYSTEMD_UNIT_NAME] },
      ];
    }
    case "schtasks": {
      return [
        { command: "schtasks", args: ["/Create", "/XML", plan.unitPath, "/TN", WINDOWS_TASK_NAME, "/F"] },
        { command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
      ];
    }
    case "sc": {
      const binPath =
        plan.apiaryHome === undefined
          ? `"${process.execPath}" "${plan.execPath}" daemon`
          : `cmd.exe /d /s /c "set ""APIARY_HOME=${plan.apiaryHome.replaceAll('"', '""')}"" && ` +
            `""${process.execPath.replaceAll('"', '""')}"" ""${plan.execPath.replaceAll('"', '""')}"" daemon"`;
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

/**
 * The argv to deregister the PRE-decision-#32 unit names (`com.hivenectar.daemon` /
 * `hivenectar.service` / `HivenectarDaemon`). Run best-effort at the start of every
 * install so a re-run migrates a legacy unit; when no legacy unit exists these
 * commands fail harmlessly and the install proceeds.
 */
export function legacyUninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["bootout", `${launchdDomainTarget(plan, uid)}/${LEGACY_SERVICE_LABEL}`] }];
    case "systemd": {
      const scopeArgs = plan.scope === "user" ? ["--user"] : [];
      return [{ command: "systemctl", args: [...scopeArgs, "disable", "--now", LEGACY_SYSTEMD_UNIT_NAME] }];
    }
    case "schtasks":
      return [{ command: "schtasks", args: ["/Delete", "/TN", LEGACY_WINDOWS_TASK_NAME, "/F"] }];
    case "sc":
      return [
        { command: "sc", args: ["stop", LEGACY_WINDOWS_TASK_NAME] },
        { command: "sc", args: ["delete", LEGACY_WINDOWS_TASK_NAME] },
      ];
  }
}

/**
 * The argv to START an ALREADY-REGISTERED unit (PRD-003b b-AC-1), without
 * creating it. Fronts the existing unit the installer laid down; when no unit is
 * registered these commands fail and the CLI falls back to a direct spawn.
 *   - launchd:  `kickstart -k <domain>/<label>` (start, restarting if running).
 *   - systemd:  `systemctl [--user] start nectar.service`.
 *   - schtasks: `/Run /TN nectar`.
 *   - sc:       `sc start nectar`.
 */
export function startCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["kickstart", "-k", launchdServiceTarget(plan, uid)] }];
    case "systemd": {
      const scopeArgs = plan.scope === "user" ? ["--user"] : [];
      return [{ command: "systemctl", args: [...scopeArgs, "start", SYSTEMD_UNIT_NAME] }];
    }
    case "schtasks":
      return [{ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] }];
    case "sc":
      return [{ command: "sc", args: ["start", WINDOWS_TASK_NAME] }];
  }
}

/**
 * The argv to STOP a running unit (PRD-003b b-AC-1) WITHOUT removing it, so a
 * later `start` can bring it back.
 *   - launchd:  `bootout <domain>/<label>` (unload the running job; a KeepAlive
 *               job cannot relaunch a booted-out target in this session).
 *   - systemd:  `systemctl [--user] stop nectar.service` (a clean stop is not a
 *               crash, so `Restart=` does not relaunch it).
 *   - schtasks: `/End /TN nectar`.
 *   - sc:       `sc stop nectar`.
 */
export function stopCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] }];
    case "systemd": {
      const scopeArgs = plan.scope === "user" ? ["--user"] : [];
      return [{ command: "systemctl", args: [...scopeArgs, "stop", SYSTEMD_UNIT_NAME] }];
    }
    case "schtasks":
      return [{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] }];
    case "sc":
      return [{ command: "sc", args: ["stop", WINDOWS_TASK_NAME] }];
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
