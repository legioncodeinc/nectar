/**
 * nectar's OS-service manager (PRD-003b) - the module the CLI's `install` /
 * `uninstall` commands delegate to.
 *
 * It does the three things PRD-003b's Goals describe:
 *   - install()   : resolve the platform plan, write the unit file (when file-based),
 *                   then run the manager's install argv. Userland scope by default,
 *                   privileged fallback ordering computed in {@link resolveServicePlan}.
 *   - uninstall() : run the manager's uninstall argv, then delete the unit file, so
 *                   the unit does not resurrect on next boot (US-003b.4).
 *   - status()    : run the manager's status argv and classify the result.
 *
 * Crash-safe: every shell-out is the injected {@link CommandRunner} (execFile, no
 * shell) which never throws; every fs call is behind the injected {@link ServiceFs}
 * and wrapped, so a permission error becomes a returned {@link ServiceResult}, never
 * a thrown stack. Mirrors doctor's service module (doctor/src/service/index.ts)
 * with nectar's own templates/argv/run command.
 *
 * Built-ins only: the production fs uses node:fs, the runner uses node:child_process.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createExecFileRunner, type CommandResult, type CommandRunner } from "./command-runner.js";
import {
  installCommands,
  legacyUninstallCommands,
  startCommands,
  statusCommand,
  stopCommands,
  uninstallCommands,
  type ServiceCommand,
} from "./argv.js";
import {
  legacyUnitPath,
  resolveServiceContext,
  resolveServicePlan,
  type ServiceEnvironment,
  type ServicePlan,
} from "./platform.js";
import { renderUnit, launchdLogDir } from "./templates.js";

function serviceStateDir(plan: Pick<ServicePlan, "home" | "apiaryHome">): string {
  return plan.apiaryHome !== undefined ? `${plan.apiaryHome}/nectar` : `${plan.home}/.apiary/nectar`;
}

/** A coarse, classified service status (what `nectar service-status` reports). */
export type ServiceStatus = "running" | "not-running" | "unknown";

/** The outcome of an install/uninstall call. */
export interface ServiceResult {
  /** True iff the operation fully succeeded. */
  readonly ok: boolean;
  /** A human-readable, secret-free result line. */
  readonly message: string;
}

/**
 * The outcome of {@link ServiceModule.uninstall}, additionally classified so a
 * caller (the lifecycle's `uninstall` verb) can tell a genuine removal failure
 * from the unit simply having been absent already (PRD-003b b-AC-2 / AC-9): a
 * boot-resurrecting unit left behind by a swallowed "it was probably already
 * gone" error is exactly the failure mode this classification exists to catch.
 */
export interface ServiceUninstallResult extends ServiceResult {
  /**
   * True when the manager reported the unit was not registered/found rather
   * than a real error (permission denied, manager unreachable, etc.). A
   * true `alreadyAbsent` is a friendly no-op; `ok` stays false either way
   * since nothing was actually removed by THIS call - callers should only
   * treat `alreadyAbsent === false` as requiring a hard failure.
   */
  readonly alreadyAbsent: boolean;
}

/** Per-command timeout for a service-manager shell-out (these are fast, local commands). */
const SERVICE_COMMAND_TIMEOUT_MS = 15_000;

/** The minimal filesystem surface the service module needs (injected so tests are hermetic). */
export interface ServiceFs {
  /** Create a directory (recursive). Must be idempotent (no throw if it already exists). */
  mkdirp(dir: string): void;
  /** Write a file's text content, overwriting. */
  writeFile(path: string, content: string): void;
  /** Remove a file. Must NOT throw when the file is already absent. */
  removeFile(path: string): void;
}

/** The production {@link ServiceFs} over node:fs. */
export function createNodeServiceFs(): ServiceFs {
  return {
    mkdirp(dir: string): void {
      mkdirSync(dir, { recursive: true });
    },
    writeFile(path: string, content: string): void {
      writeFileSync(path, content, { encoding: "utf8" });
    },
    removeFile(path: string): void {
      rmSync(path, { force: true });
    },
  };
}

/** Construction deps for {@link createServiceModule}. All have production defaults. */
export interface ServiceModuleDeps {
  /** The absolute path to the `nectar` bin the unit execs. */
  readonly execPath: string;
  /** Opt into a system-scoped unit when privileged (enterprise path). Default false. */
  readonly preferSystemScope?: boolean;
  /** The command runner (execFile, no shell). Default: the real {@link createExecFileRunner}. */
  readonly runner?: CommandRunner;
  /** The filesystem seam. Default: the real {@link createNodeServiceFs}. */
  readonly fs?: ServiceFs;
  /** The numeric uid for launchd's `gui/<uid>` domain. Default: live uid (0 when unavailable). */
  readonly uid?: number;
  /** Override the resolved environment (tests inject a fixed platform/home/privilege). */
  readonly environment?: ServiceEnvironment;
  /** Structured log sink; defaults to a no-op. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/** Read the live numeric uid, defaulting to 0 when the platform does not expose it. */
function liveUid(): number {
  try {
    const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
    return typeof getuid === "function" ? getuid() : 0;
  } catch {
    return 0;
  }
}

/** Human-readable scope phrase for the result line. */
function scopePhrase(plan: ServicePlan): string {
  const base = plan.scope === "user" ? "user scope" : "system scope";
  return plan.fellBackToUser ? `${base} (fell back from system - unprivileged)` : base;
}

/** Cap how much of a command's own output we ever echo back in a result message. */
const MAX_FAILURE_DETAIL_CHARS = 200;

/**
 * Reduce a failed {@link CommandResult} to one short, secret-free line worth
 * surfacing to the operator (e.g. "Access is denied.", "ENOENT"). Prefers the
 * runner's own `detail` (a spawn-error code or timeout marker); otherwise falls
 * back to the last non-empty line of stderr, then stdout, since most service
 * managers (schtasks, launchctl, systemctl) print their real error there and a
 * generic "a command failed" with no reason is not actionable. Output is a
 * fixed-format OS/service-manager message, never a credential, but is still
 * length-capped defensively in case a manager is unexpectedly chatty.
 */
function describeFailure(result: CommandResult | null): string {
  if (result === null) return "unknown error";
  const candidate =
    result.detail ?? lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout) ?? "unknown error";
  return candidate.length > MAX_FAILURE_DETAIL_CHARS
    ? `${candidate.slice(0, MAX_FAILURE_DETAIL_CHARS)}...`
    : candidate;
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

/**
 * True when a failed uninstall command's result indicates the unit was
 * already absent (not currently registered) rather than a genuine removal
 * failure. Each service manager reports "not found" differently; `sc.exe`'s
 * numeric `ERROR_SERVICE_DOES_NOT_EXIST` (1060) and launchd's `ESRCH`-derived
 * exit code (3) are locale-independent, so they are checked directly. Every
 * manager additionally falls back to a broad, case-insensitive text match
 * over stdout/stderr/detail. Anything that does not match is conservatively
 * treated as a GENUINE failure (never silently swallowed) - this is the
 * classification b-AC-2 / AC-9 depend on.
 */
function isAlreadyAbsentFailure(manager: ServicePlan["manager"], result: CommandResult | null): boolean {
  if (result === null) return false;
  const text = `${result.detail ?? ""} ${result.stderr} ${result.stdout}`.toLowerCase();
  const genericAbsent = /does not exist|cannot find|no such process|not[- ]loaded|could not find|not found/;
  switch (manager) {
    case "launchd":
      return result.code === 3 || genericAbsent.test(text);
    case "systemd":
      return genericAbsent.test(text);
    case "schtasks":
      return genericAbsent.test(text);
    case "sc":
      return result.code === 1060 || genericAbsent.test(text);
    default: {
      const unreachable: never = manager;
      return unreachable;
    }
  }
}

/**
 * Run an ordered list of commands, stopping at nothing (every result is recorded)
 * but reporting the first hard failure (and its result, for {@link describeFailure}).
 * Never throws (the runner never does).
 */
async function runAll(
  runner: CommandRunner,
  commands: readonly ServiceCommand[],
): Promise<{ allOk: boolean; firstFailure: ServiceCommand | null; firstFailureResult: CommandResult | null }> {
  let firstFailure: ServiceCommand | null = null;
  let firstFailureResult: CommandResult | null = null;
  for (const cmd of commands) {
    const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
    if (!result.ok && firstFailure === null) {
      firstFailure = cmd;
      firstFailureResult = result;
    }
  }
  return { allOk: firstFailure === null, firstFailure, firstFailureResult };
}

/** The service module surface: install / uninstall / start / stop the OS service unit. */
export interface ServiceModule {
  install(): Promise<ServiceResult>;
  /** Remove the CURRENT-label unit, classified so a genuine failure is never mistaken for a no-op. */
  uninstall(): Promise<ServiceUninstallResult>;
  /** Start an already-registered unit (PRD-003b b-AC-1). */
  start(): Promise<ServiceResult>;
  /** Stop a running unit without removing it (PRD-003b b-AC-1). */
  stop(): Promise<ServiceResult>;
  /** Best-effort deregister the legacy-labelled unit + remove its unit file (PRD-003b b-AC-2). */
  deregisterLegacy(): Promise<ServiceResult>;
}

/**
 * Build the real {@link ServiceModule}. The CLI injects the resolved exec path;
 * tests inject the runner + fs + a fixed environment so nothing real runs.
 */
export function createServiceModule(deps: ServiceModuleDeps): ServiceModule {
  const runner = deps.runner ?? createExecFileRunner();
  const fs = deps.fs ?? createNodeServiceFs();
  const log = deps.log ?? ((): void => {});
  const uid = deps.uid ?? liveUid();
  const environment =
    deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);

  function plan(): ServicePlan {
    return resolveServicePlan(environment);
  }

  return {
    async install(): Promise<ServiceResult> {
      let p: ServicePlan;
      try {
        p = plan();
      } catch (error) {
        return {
          ok: false,
          message: `Could not register the nectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }

      // 0) Migrate away from the pre-decision-#32 unit names: best-effort deregister the
      //    legacy unit (`com.hivenectar.daemon` / `hivenectar.service` / `HivenectarDaemon`)
      //    and remove its unit file, so a re-run never leaves two units racing over one
      //    daemon. Expected to fail harmlessly when no legacy unit exists; never blocks
      //    the install.
      await runAll(runner, legacyUninstallCommands(p, uid));
      try {
        const legacyPath = legacyUnitPath(p);
        if (legacyPath !== "") fs.removeFile(legacyPath);
      } catch {
        // Best-effort migration cleanup only; a remove failure never blocks the install.
      }

      // 1) Write the unit file FIRST (when this manager is file-based). schtasks consumes the
      //    XML file too, so a non-empty unitPath OR the schtasks manager means we lay down text.
      const needsFile = p.unitPath !== "" || p.manager === "schtasks";
      let unitTarget = p.unitPath;
      if (needsFile) {
        try {
          if (p.manager === "schtasks" && unitTarget === "") {
            unitTarget = `${serviceStateDir(p)}/nectar-task.xml`;
          }
          fs.mkdirp(dirname(unitTarget));
          fs.writeFile(unitTarget, renderUnit(p));
          // NEC-042 item 2 / AC-018l.9: launchd writes stdout/stderr into
          // `<home>/.apiary/nectar/logs`, but the plist lives under LaunchAgents,
          // so mkdirp(dirname(unitTarget)) above only created LaunchAgents. Create
          // the log directory too, or the daemon's macOS logs are silently lost.
          if (p.manager === "launchd") fs.mkdirp(launchdLogDir(p));
        } catch (error) {
          return {
            ok: false,
            message: `Could not write the nectar unit file at ${unitTarget}: ${error instanceof Error ? error.message : "unknown error"}.`,
          };
        }
      }

      // 2) Run the manager's install argv. For schtasks the staged file path is the unit path.
      const planForArgv: ServicePlan = unitTarget === p.unitPath ? p : { ...p, unitPath: unitTarget };
      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, installCommands(planForArgv, uid));
      if (!allOk) {
        const detail = describeFailure(firstFailureResult);
        log({
          level: "warn",
          scope: "service",
          msg: "install_command_failed",
          command: firstFailure?.command,
          detail,
        });
        return {
          ok: false,
          message: `Registered the nectar unit but a service-manager command failed (${firstFailure?.command ?? "unknown"}): ${detail}. It will start at next login/boot; run \`nectar service-status\` to check.`,
        };
      }

      log({ level: "info", scope: "service", msg: "installed", manager: p.manager, scope2: p.scope });
      return {
        ok: true,
        message: `nectar registered as a ${p.manager} service (${scopePhrase(p)}) and started. It will restart on crash and start on boot.`,
      };
    },

    async uninstall(): Promise<ServiceUninstallResult> {
      let p: ServicePlan;
      try {
        p = plan();
      } catch (error) {
        return {
          ok: false,
          alreadyAbsent: false,
          message: `Could not unregister the nectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }

      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, uninstallCommands(p, uid));

      const stagedXml = p.manager === "schtasks" ? `${serviceStateDir(p)}/nectar-task.xml` : "";
      try {
        if (p.unitPath !== "") fs.removeFile(p.unitPath);
        if (stagedXml !== "") fs.removeFile(stagedXml);
      } catch (error) {
        log({
          level: "warn",
          scope: "service",
          msg: "unit_remove_failed",
          reason: error instanceof Error ? error.message : "unknown",
        });
      }

      if (!allOk) {
        const detail = describeFailure(firstFailureResult);
        const alreadyAbsent = isAlreadyAbsentFailure(p.manager, firstFailureResult);
        log({
          level: alreadyAbsent ? "info" : "warn",
          scope: "service",
          msg: "uninstall_command_failed",
          command: firstFailure?.command,
          detail,
          alreadyAbsent,
        });
        if (alreadyAbsent) {
          return {
            ok: false,
            alreadyAbsent: true,
            message: `nectar ${p.manager} unit was already absent (nothing to remove).`,
          };
        }
        return {
          ok: false,
          alreadyAbsent: false,
          message: `Could not remove the nectar ${p.manager} unit (${firstFailure?.command ?? "unknown"}): ${detail}.`,
        };
      }
      log({ level: "info", scope: "service", msg: "uninstalled", manager: p.manager, scope2: p.scope });
      return {
        ok: true,
        alreadyAbsent: false,
        message: `nectar service unregistered (${p.manager}, ${scopePhrase(p)}). It will not start on next boot.`,
      };
    },

    async start(): Promise<ServiceResult> {
      let p: ServicePlan;
      try {
        p = plan();
      } catch (error) {
        return {
          ok: false,
          message: `Could not start the nectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }
      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, startCommands(p, uid));
      if (!allOk) {
        return {
          ok: false,
          message: `The nectar ${p.manager} unit did not start (${firstFailure?.command ?? "unknown"}): ${describeFailure(firstFailureResult)}.`,
        };
      }
      log({ level: "info", scope: "service", msg: "started", manager: p.manager });
      return { ok: true, message: `nectar started via ${p.manager} (${scopePhrase(p)}).` };
    },

    async stop(): Promise<ServiceResult> {
      let p: ServicePlan;
      try {
        p = plan();
      } catch (error) {
        return {
          ok: false,
          message: `Could not stop the nectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }
      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, stopCommands(p, uid));
      if (!allOk) {
        return {
          ok: false,
          message: `The nectar ${p.manager} unit did not stop cleanly (${firstFailure?.command ?? "unknown"}): ${describeFailure(firstFailureResult)}.`,
        };
      }
      log({ level: "info", scope: "service", msg: "stopped", manager: p.manager });
      return { ok: true, message: `nectar stopped via ${p.manager} (${scopePhrase(p)}).` };
    },

    async deregisterLegacy(): Promise<ServiceResult> {
      let p: ServicePlan;
      try {
        p = plan();
      } catch (error) {
        return {
          ok: false,
          message: `Could not deregister the legacy nectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }
      // Best-effort: legacy commands fail harmlessly when no legacy unit exists.
      const { allOk } = await runAll(runner, legacyUninstallCommands(p, uid));
      try {
        const legacyPath = legacyUnitPath(p);
        if (legacyPath !== "") fs.removeFile(legacyPath);
      } catch {
        // Best-effort cleanup only; a remove failure never fails the uninstall.
      }
      return {
        ok: true,
        message: allOk
          ? `legacy nectar unit deregistered (${p.manager}).`
          : `legacy nectar unit deregister attempted (${p.manager}); it was likely already absent.`,
      };
    },
  };
}

/**
 * Probe the current service status. Returns a coarse {@link ServiceStatus}; never
 * throws.
 */
export async function serviceStatus(deps: ServiceModuleDeps): Promise<ServiceStatus> {
  const runner = deps.runner ?? createExecFileRunner();
  const uid = deps.uid ?? liveUid();
  const environment =
    deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
  let p: ServicePlan;
  try {
    p = resolveServicePlan(environment);
  } catch {
    return "unknown";
  }
  const cmd = statusCommand(p, uid);
  const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
  if (!result.ok) {
    if (result.detail !== undefined && /ENOENT|spawn/i.test(result.detail)) return "unknown";
    return "not-running";
  }
  if (p.manager === "systemd") {
    return /\bactive\b/.test(result.stdout) && !/inactive|failed/.test(result.stdout) ? "running" : "not-running";
  }
  return "running";
}

export { resolveServicePlan, resolveServiceContext } from "./platform.js";
export type { ServicePlan, ServiceEnvironment } from "./platform.js";
export {
  SERVICE_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  LEGACY_SERVICE_LABEL,
  LEGACY_SYSTEMD_UNIT_NAME,
  LEGACY_WINDOWS_TASK_NAME,
  legacyUnitPath,
} from "./platform.js";
export { NECTAR_RUN_COMMAND, RESTART_SEC, WINDOWS_RESTART_INTERVAL, renderUnit } from "./templates.js";
export { installCommands, uninstallCommands, legacyUninstallCommands, startCommands, stopCommands, statusCommand } from "./argv.js";
export type { ServiceCommand } from "./argv.js";
export { createExecFileRunner } from "./command-runner.js";
export type { CommandRunner, CommandResult, CommandRunOptions } from "./command-runner.js";
