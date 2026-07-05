/**
 * Shared Windows path resolution for nectar's OS-service module (PRD-003b).
 *
 * Both the schtasks XML template (`templates.ts`, the `conhost.exe` wrapper) and the
 * SID resolver (`windows-user-id.ts`, `whoami.exe`) need an absolute path under the
 * live Windows system directory. Neither may hard-code `C:\Windows`: on a renamed or
 * relocated system volume that literal is wrong, and a bare unqualified name (`whoami`,
 * `conhost`) risks PATH-order surprises (e.g. git-bash shadowing `whoami.exe` with its
 * own POSIX-emulation binary). `%SystemRoot%` is the OS-provided source of truth.
 *
 * Pure and total: falls back to the conventional `C:\Windows` only when the env var is
 * genuinely unset/blank, which should never happen on a real Windows host but keeps the
 * function from ever needing to throw. Always renders Windows backslashes, even when
 * this module is imported by a test running on POSIX (never uses `node:path.join`, which
 * would emit `/` there and produce an unusable path).
 */

/** Resolve `<SystemRoot>\<relativePath>`, defaulting `SystemRoot` to `C:\Windows`. */
export function windowsSystemPath(relativePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim();
  const root = systemRoot !== undefined && systemRoot !== "" ? systemRoot : "C:\\Windows";
  return `${root}\\${relativePath}`;
}
