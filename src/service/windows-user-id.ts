/**
 * Windows Scheduled Task `UserId` resolution (PRD-003b), for the schtasks XML's
 * `<LogonTrigger>` and `<Principal id="Author">` elements.
 *
 * Root cause (field-proven on Windows 11 25H2 with Administrator Protection): an
 * unscoped `<LogonTrigger>`/`<Principal>` (no `<UserId>`) asks Task Scheduler to run
 * the task for ANY user's logon, which a hardened machine refuses to register without
 * elevation ("Access is denied", no admin prompt offered). Scoping both elements to
 * the installing user's SID fixes registration without ever requiring elevation.
 *
 * Resolution order:
 *   1. `whoami /user /fo csv /nh`, run via the injected {@link CommandRunner} against
 *      the absolute `<SystemRoot>\System32\whoami.exe` (never a bare `whoami`: git-bash
 *      ships its own `whoami` on PATH ahead of the Windows one; never a shell - the
 *      runner uses `execFile`). The CSV's last field is the SID; validated against
 *      `S-1-<n>(-<n>)+` so a locale-mangled or truncated line can never smuggle
 *      unexpected text into the XML.
 *   2. `<USERDOMAIN>\<USERNAME>` from the environment, when whoami's SID is
 *      unavailable or fails validation.
 *   3. `undefined` when neither resolves. The caller renders the schtasks XML WITHOUT
 *      any `<UserId>` in that case (the pre-fix behavior), so a non-hardened machine
 *      is unaffected.
 *
 * Never throws: {@link CommandRunner.run} already resolves to a result value for
 * every failure mode (spawn error, non-zero exit, timeout), so this module has no
 * try/catch of its own to reason about.
 *
 * Built-ins only; the real shell-out is the shared {@link CommandRunner} seam
 * (`node:child_process.execFile`, no shell).
 */

import type { CommandRunner } from "./command-runner.js";
import { windowsSystemPath } from "./windows-paths.js";

/** The argv passed to `whoami.exe`: one no-header CSV line, SID as the last field. */
export const WHOAMI_ARGS: readonly string[] = ["/user", "/fo", "csv", "/nh"];

/** Timeout for the `whoami.exe` shell-out (a fast, local command). */
export const WHOAMI_TIMEOUT_MS = 10_000;

/** A Windows SID: `S-1-` followed by 2+ dash-separated non-negative integers. */
const SID_PATTERN = /^S-1-[0-9]+(-[0-9]+)+$/;

/** The absolute, never-bare path to `whoami.exe` under the live system directory. */
export function resolveWhoamiPath(env: NodeJS.ProcessEnv = process.env): string {
  return windowsSystemPath("System32\\whoami.exe", env);
}

/**
 * Extract and validate the SID from `whoami /user /fo csv /nh` output. The command
 * emits exactly one CSV line (no header row): `"DOMAIN\user","S-1-5-...`". Takes the
 * LAST non-empty output line (defensive against a leading blank line) and its LAST
 * comma-separated field, strips one layer of surrounding quotes, then validates the
 * result against {@link SID_PATTERN} so anything that is not actually a SID (a
 * locale-translated header, a truncated line, empty output) returns `null` rather
 * than smuggling arbitrary text toward the XML.
 */
export function parseWhoamiCsvSid(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const lastLine = lines.at(-1);
  if (lastLine === undefined) return null;
  const lastField = lastLine.split(",").at(-1);
  if (lastField === undefined) return null;
  const candidate = lastField.trim().replace(/^"(.*)"$/, "$1").trim();
  return SID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The `<USERDOMAIN>\<USERNAME>` fallback identity, used when whoami's SID is
 * unavailable. Returns `null` when either variable is unset/blank so the caller can
 * fall through to rendering no `<UserId>` at all, rather than emitting a malformed
 * half-identity like `\username`.
 */
export function fallbackWindowsUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  const domain = env.USERDOMAIN?.trim();
  const user = env.USERNAME?.trim();
  if (domain === undefined || domain === "" || user === undefined || user === "") return null;
  return `${domain}\\${user}`;
}

/** The environment type {@link resolveWindowsUserId} consults (`SystemRoot`/`USERDOMAIN`/`USERNAME`). */
export type WindowsUserIdEnv = NodeJS.ProcessEnv;

/**
 * Resolve the identity string to embed in the schtasks XML's `<UserId>` elements:
 * the installing user's SID when `whoami.exe` succeeds and validates, else the
 * `<USERDOMAIN>\<USERNAME>` fallback, else `undefined` (render without `<UserId>`).
 * The caller (the schtasks install path) XML-escapes whichever value comes back;
 * this function returns the raw identity string.
 */
export async function resolveWindowsUserId(
  runner: CommandRunner,
  env: WindowsUserIdEnv = process.env,
): Promise<string | undefined> {
  const result = await runner.run(resolveWhoamiPath(env), WHOAMI_ARGS, { timeoutMs: WHOAMI_TIMEOUT_MS });
  if (result.ok) {
    const sid = parseWhoamiCsvSid(result.stdout);
    if (sid !== null) return sid;
  }
  return fallbackWindowsUserId(env) ?? undefined;
}
