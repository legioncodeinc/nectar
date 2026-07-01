/**
 * hivenectar's OS-service manager (PRD-003b) - the module the CLI's `install` /
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
 * a thrown stack. Mirrors hivedoctor's service module (hivedoctor/src/service/index.ts)
 * with hivenectar's own templates/argv/run command.
 *
 * Built-ins only: the production fs uses node:fs, the runner uses node:child_process.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createExecFileRunner, type CommandResult, type CommandRunner } from "./command-runner.js";
import { installCommands, statusCommand, uninstallCommands, type ServiceCommand } from "./argv.js";
import {
  resolveServiceContext,
  resolveServicePlan,
  type ServiceEnvironment,
  type ServicePlan,
} from "./platform.js";
import { renderUnit } from "./templates.js";

/** A coarse, classified service status (what `hivenectar service-status` reports). */
export type ServiceStatus = "running" | "not-running" | "unknown";

/** The outcome of an install/uninstall call. */
export interface ServiceResult {
  /** True iff the operation fully succeeded. */
  readonly ok: boolean;
  /** A human-readable, secret-free result line. */
  readonly message: string;
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
  /** The absolute path to the `hivenectar` bin the unit execs. */
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

/** The service module surface: install / uninstall the OS service unit. */
export interface ServiceModule {
  install(): Promise<ServiceResult>;
  uninstall(): Promise<ServiceResult>;
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
          message: `Could not register the hivenectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }

      // 1) Write the unit file FIRST (when this manager is file-based). schtasks consumes the
      //    XML file too, so a non-empty unitPath OR the schtasks manager means we lay down text.
      const needsFile = p.unitPath !== "" || p.manager === "schtasks";
      let unitTarget = p.unitPath;
      if (needsFile) {
        try {
          if (p.manager === "schtasks" && unitTarget === "") {
            unitTarget = `${p.home}/.honeycomb/hivenectar/hivenectar-task.xml`;
          }
          fs.mkdirp(dirname(unitTarget));
          fs.writeFile(unitTarget, renderUnit(p));
        } catch (error) {
          return {
            ok: false,
            message: `Could not write the hivenectar unit file at ${unitTarget}: ${error instanceof Error ? error.message : "unknown error"}.`,
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
          message: `Registered the hivenectar unit but a service-manager command failed (${firstFailure?.command ?? "unknown"}): ${detail}. It will start at next login/boot; run \`hivenectar service-status\` to check.`,
        };
      }

      log({ level: "info", scope: "service", msg: "installed", manager: p.manager, scope2: p.scope });
      return {
        ok: true,
        message: `hivenectar registered as a ${p.manager} service (${scopePhrase(p)}) and started. It will restart on crash and start on boot.`,
      };
    },

    async uninstall(): Promise<ServiceResult> {
      let p: ServicePlan;
      try {
        p = plan();
      } catch (error) {
        return {
          ok: false,
          message: `Could not unregister the hivenectar service: ${error instanceof Error ? error.message : "unknown error"}.`,
        };
      }

      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, uninstallCommands(p, uid));

      const stagedXml = p.manager === "schtasks" ? `${p.home}/.honeycomb/hivenectar/hivenectar-task.xml` : "";
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
        log({
          level: "warn",
          scope: "service",
          msg: "uninstall_command_failed",
          command: firstFailure?.command,
          detail,
        });
        return {
          ok: false,
          message: `Removed the hivenectar unit file; a deregister command (${firstFailure?.command ?? "unknown"}) reported an error (often because it was already gone): ${detail}.`,
        };
      }
      log({ level: "info", scope: "service", msg: "uninstalled", manager: p.manager, scope2: p.scope });
      return {
        ok: true,
        message: `hivenectar service unregistered (${p.manager}, ${scopePhrase(p)}). It will not start on next boot.`,
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
export { SERVICE_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from "./platform.js";
export { HIVENECTAR_RUN_COMMAND, RESTART_SEC, WINDOWS_RESTART_INTERVAL, renderUnit } from "./templates.js";
export { installCommands, uninstallCommands, statusCommand } from "./argv.js";
export type { ServiceCommand } from "./argv.js";
export { createExecFileRunner } from "./command-runner.js";
export type { CommandRunner, CommandResult, CommandRunOptions } from "./command-runner.js";
