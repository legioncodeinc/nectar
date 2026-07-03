/**
 * Deep Lake credentials loader for nectar (PRD-005).
 *
 * Reads the SHARED `~/.deeplake/credentials.json` file that `hivemind login`
 * (and honeycomb) already write, mirroring the shape honeycomb's
 * `loadDiskCredentials` / `deeplakeCredentialsFileProvider`
 * (`src/daemon/runtime/auth/credentials-store.ts`,
 * `src/daemon/storage/config.ts`) read: `{ apiUrl, token, orgId, workspaceId }`.
 * Per ADR-0002, nectar never imports honeycomb's runtime for this; it
 * reads the same on-disk file with its own loader.
 *
 * Fail-closed by design (mirrors honeycomb's `StorageConfigError` posture): a
 * missing file, malformed JSON, or a missing required field throws a
 * `DeepLakeCredentialsError` listing exactly what is wrong, rather than
 * returning a partially-undefined credential object a caller could
 * accidentally use. `apiUrl` is the one field with a documented default (a
 * legacy or hand-written file may omit it); `token`, `orgId`, and
 * `workspaceId` are load-bearing and always required.
 *
 * The token is never logged or included in an error message in full;
 * `redactToken` keeps only the last 4 characters, exactly like honeycomb's
 * `redactToken` (`src/daemon/runtime/auth/credentials-store.ts:254-257`, its
 * `defaultCredentialProvider` variant).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The SHARED credentials directory name under the user's home. */
export const CREDENTIALS_DIR_NAME = ".deeplake";
/** The credentials file name within the dir. */
export const CREDENTIALS_FILE_NAME = "credentials.json";
/** The canonical Deep Lake API base URL used when a file omits `apiUrl`. */
export const DEFAULT_DEEPLAKE_API_URL = "https://api.deeplake.ai";

/** The validated Deep Lake connection details the transport is built from. */
export interface DeepLakeCredentials {
  /** Deep Lake HTTP query endpoint. Defaults to {@link DEFAULT_DEEPLAKE_API_URL}. */
  readonly apiUrl: string;
  /** The org-bound bearer token (SECRET; never logged in full). */
  readonly token: string;
  /** The org id the token is bound to. */
  readonly orgId: string;
  /** The active workspace id. */
  readonly workspaceId: string;
}

/**
 * Options for {@link loadDeepLakeCredentials}, injectable so a test points the
 * file read at a temp dir without touching the real `~/.deeplake` (mirrors
 * honeycomb's `CredentialsFileProviderOptions`). All optional.
 */
export interface LoadCredentialsOptions {
  /** Override the credentials directory (tests). Defaults to `~/.deeplake`. */
  readonly dir?: string;
  /**
   * Warning sink for the group/other-readable advisory (NEC-042 item 13 /
   * AC-018l.20). Defaults to stderr. A no-op on Windows, where POSIX mode bits
   * do not map to a meaningful readability check.
   */
  readonly warn?: (message: string) => void;
  /**
   * The platform whose permission model applies (default: `process.platform`).
   * Injectable so a test can exercise the POSIX advisory path deterministically.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Structured, fail-closed rejection. Carries exactly which fields were missing
 * or invalid so a caller (or an operator reading a log line) knows what to
 * fix without the loader ever echoing the file's contents (which may hold the
 * token).
 */
export class DeepLakeCredentialsError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`Invalid Deep Lake credentials: ${missing.join("; ")}`);
    this.name = "DeepLakeCredentialsError";
    this.missing = missing;
  }
}

/** Resolve the credentials directory, honoring the test override. */
export function credentialsDir(options: LoadCredentialsOptions = {}): string {
  return options.dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** Resolve the full credentials file path within the (possibly overridden) dir. */
export function credentialsPath(options: LoadCredentialsOptions = {}): string {
  return join(credentialsDir(options), CREDENTIALS_FILE_NAME);
}

/**
 * Load and validate `~/.deeplake/credentials.json` (or the overridden dir in
 * `options.dir`). Throws {@link DeepLakeCredentialsError} listing every
 * problem found: a missing file, invalid JSON, a non-object payload, or a
 * missing/empty `token` / `orgId` / `workspaceId`. Never returns a partial
 * credential — the caller either gets a fully-populated `DeepLakeCredentials`
 * or a clear, typed reason it could not.
 */
export function loadDeepLakeCredentials(options: LoadCredentialsOptions = {}): DeepLakeCredentials {
  const path = credentialsPath(options);
  if (!existsSync(path)) {
    throw new DeepLakeCredentialsError([`credentials file not found at ${path}`]);
  }

  warnIfWorldReadable(path, options);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DeepLakeCredentialsError([`credentials file at ${path} is not valid JSON`]);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DeepLakeCredentialsError([`credentials file at ${path} does not contain a JSON object`]);
  }

  const record = parsed as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof record.token !== "string" || record.token.length === 0) missing.push("token");
  if (typeof record.orgId !== "string" || record.orgId.length === 0) missing.push("orgId");
  if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) missing.push("workspaceId");
  if (missing.length > 0) {
    throw new DeepLakeCredentialsError(missing);
  }

  const apiUrl =
    typeof record.apiUrl === "string" && record.apiUrl.length > 0 ? record.apiUrl : DEFAULT_DEEPLAKE_API_URL;

  return {
    apiUrl,
    token: record.token as string,
    orgId: record.orgId as string,
    workspaceId: record.workspaceId as string,
  };
}

/**
 * Advisory (NEC-042 item 13 / AC-018l.20): warn when the token file is
 * group- or other-readable on a POSIX platform, naming the octal mode, mirroring
 * ssh's posture toward a loose private key. nectar is not the file's writer, so
 * this never throws or blocks the load; it is a no-op on Windows (mode bits do
 * not map) and when the stat itself fails.
 */
function warnIfWorldReadable(path: string, options: LoadCredentialsOptions): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return; // cannot stat; skip the advisory rather than failing the load
  }
  if ((mode & 0o077) === 0) return; // owner-only (0600/0400): silent
  const octal = `0${mode.toString(8).padStart(3, "0")}`;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  warn(
    `nectar: ${path} is group/other-readable (mode ${octal}); this token file should be owner-only. ` +
      `Tighten it with: chmod 600 ${path}`,
  );
}

/**
 * Redact a token for logs and errors. Never echoes a token in full: keeps the
 * last 4 chars for correlation, masks the rest. An empty/short value collapses
 * to a fixed mask so length isn't leaked either. Mirrors honeycomb's
 * `redactToken` (`src/daemon/runtime/auth/credentials-store.ts:254-257`).
 */
export function redactToken(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}
