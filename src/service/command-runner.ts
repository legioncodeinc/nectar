/**
 * Injectable command-runner boundary for the service module (PRD-003b).
 *
 * Every OS-service shell-out (`launchctl`, `systemctl`, `schtasks`, `sc`) goes
 * through this {@link CommandRunner} interface so the service module is hermetic
 * and testable: a unit test injects a fake that records the argv and returns a
 * canned {@link CommandResult}, and the CLI wires the real built-in runner
 * ({@link createExecFileRunner}) in production.
 *
 * The real runner uses `node:child_process.execFile` (NOT `exec`): execFile takes
 * an argv array and does NOT spawn a shell, so a unit path or label can never be
 * interpreted as a shell metacharacter. Mirrors hivedoctor's `CommandRunner` seam
 * (hivedoctor/src/rungs/command-runner.ts), scoped to hivenectar's OS-service
 * commands (no npm-launch special-casing needed here).
 *
 * Crash-safety: `run` resolves to a {@link CommandResult} for BOTH success and
 * failure - a non-zero exit, a spawn error (manager not found), or a timeout all
 * become a result with `ok:false`, never a thrown error.
 *
 * Built-ins only: node:child_process.
 */

import { execFile } from "node:child_process";

/** The outcome of running one external command. Never throws; failure is a value. */
export interface CommandResult {
  /** True iff the process exited 0 within the timeout and did not fail to spawn. */
  readonly ok: boolean;
  /** The exit code, or null when the process was killed / failed to spawn. */
  readonly code: number | null;
  /** Captured stdout (size-capped). */
  readonly stdout: string;
  /** Captured stderr (size-capped). */
  readonly stderr: string;
  /** A short failure note (spawn error class / timeout), when `ok` is false. */
  readonly detail?: string;
}

/** Options for a single {@link CommandRunner.run} call. */
export interface CommandRunOptions {
  /** Hard timeout in ms; the process is killed and the result is `ok:false` after it. */
  readonly timeoutMs?: number;
}

/** The injectable boundary the service module calls. */
export interface CommandRunner {
  /**
   * Run `command` with `args` (argv, no shell). Resolves to a {@link CommandResult}
   * for success AND failure - NEVER rejects.
   */
  run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

/** The default per-command timeout (these are fast, local commands): 15 seconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Cap captured output so a chatty service manager can never balloon memory. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Build the REAL command runner over `node:child_process.execFile`, no shell. Every
 * failure mode (non-zero exit, ENOENT spawn failure, timeout kill) is mapped to a
 * {@link CommandResult} rather than a thrown error.
 */
export function createExecFileRunner(): CommandRunner {
  return {
    run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult> {
      const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise<CommandResult>((resolve) => {
        execFile(
          command,
          args,
          { timeout, maxBuffer: MAX_BUFFER_BYTES, shell: false, windowsHide: true },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ ok: true, code: 0, stdout, stderr });
              return;
            }
            const errWithMeta = error as NodeJS.ErrnoException & { code?: number | string };
            const numericCode = typeof errWithMeta.code === "number" ? errWithMeta.code : null;
            const detail =
              typeof errWithMeta.code === "string"
                ? errWithMeta.code
                : error instanceof Error
                  ? error.message
                  : "command-failed";
            resolve({ ok: false, code: numericCode, stdout, stderr, detail });
          },
        );
      });
    },
  };
}
