# Security Audit - PRD-003 (fleet lifecycle: device-flow login, credentials writer, lifecycle verbs)

- **Date:** 2026-07-04
- **Auditor:** security-worker-bee
- **Scope:** UNCOMMITTED changes on `feature/fleet-lifecycle` @ `C:/Users/mario/GitHub/the-apiary/nectar` (HEAD `a5b1b56`): the new in-process device-flow client `src/auth/device-flow.ts`, the credentials writer additions in `src/hive-graph/deeplake-credentials.ts`, `src/credentials-watch.ts`, `src/fleet-detection.ts`, `src/lifecycle.ts`, the doctor-registry deregister (`src/doctor-registry.ts`), service start/stop argv (`src/service/argv.ts`, `src/service/index.ts`), health storage posture (`src/health.ts`, `src/daemon.ts`), and the CLI login/install/start/stop/uninstall wiring (`src/cli.ts`), plus the ten new test suites.
- **Ordering:** ran BEFORE `quality-worker-bee`. The only quality report on disk (`library/qa/quality/2026-07-02-wave-cde-quality-closeout.md`) predates this branch's work and does not cover it; no ordering inversion.
- **Threat model:** same class as Hivemind - Deeplake credentials (`~/.deeplake/credentials.json`), device-flow auth against `api.deeplake.ai`, loopback daemon. This repo is zero-runtime-dependency TypeScript/Node, so the Deeplake SQL, MCP, and harness catalog items do not apply here; credential/token handling, subprocess hygiene, and filesystem containment items apply in full.

---

## Executive summary

**One High finding and two Medium findings, all remediated in-session. Four Low findings documented and accepted. No Critical findings. Gates green post-fix (the single full-suite failure is the known environment-flaky live Deeplake ordering probe, excluded from judgment).**

## Findings

| # | Severity | Location | Finding | Disposition |
|---|---|---|---|---|
| H1 | **High** | `src/hive-graph/deeplake-credentials.ts:216-228` (pre-fix) | The credentials writer used a direct `writeFileSync` on the SHARED `~/.deeplake/credentials.json`. Two consequences: (a) a crash mid-write leaves a truncated/partial token file that breaks BOTH nectar and honeycomb until re-login (and flaps nectar's own credentials watch, which polls this file); (b) `writeFileSync`'s `mode: 0o600` applies only at file CREATION, so a pre-existing group/other-readable file (hand-written, or laid down loose by another tool) would receive the freshly minted long-lived org-bound token while STAYING world-readable - credential exposure, never-downgrade class. | **Fixed**: atomic same-directory temp + rename. The temp file is created at `0600` from birth (no write-then-chmod window), the rename replaces the old inode so a loose-mode predecessor never carries the new token, and the token-bearing temp is force-removed on any failure so no partial file survives. Verified by `test/credentials-writer.test.ts` (mode + shape assertions still green). |
| M1 | Medium | `src/fleet-detection.ts:154-175` (pre-fix) | The S3 npm probe ran `execFile("npm.cmd", ..., { shell: false })` on win32. Since Node's CVE-2024-27980 hardening (all Node >= 20.12, and this repo requires >= 22), spawning a `.cmd` with `shell: false` throws EINVAL, so the probe's catch resolved `false` on EVERY Windows machine - silently blinding one of the three signals that suppress the auto sign-in popup, weakening the fleet-detection control on the product's primary platform. | **Fixed**: `shell: true` on win32 only. Safe here because every argv element is a compile-time constant (`ls -g @legioncodeinc/hive --depth 0`); no user input reaches the command line. Non-Windows platforms keep `shell: false`. |
| M2 | Medium | `src/auth/device-flow.ts:481` and `:218` (pre-fix) | Server-derived strings reached the terminal unvalidated: the PRINTED `verification_uri` skipped the https-only check (only the browser-open path validated), and `verification_uri`, `user_code`, and truncated HTTP error bodies were echoed raw, allowing ANSI/control-character terminal escape injection from a compromised or spoofed auth response. Printing a non-https URL also instructs the user to open it manually, sidestepping the opener's https guard. | **Fixed**: the printed URL now goes through `validateVerificationUrl` and the flow refuses (clear `{ ok: false }` message, no hang) on a non-https `verification_uri`; a new `sanitizeForTerminal` strips C0/C1 control characters (including ESC) from the printed user code and from the truncated error bodies carried in `AuthHttpError`. |
| L1 | Low | `src/hive-graph/deeplake-credentials.ts`, `src/doctor-registry.ts:217` | Predictable temp-file names (`pid` + timestamp) for the atomic writes. | Documented, accepted: consistent with the prior audit's accepted posture (2026-07-04 L4); the credentials dir is owner-only (`0700`) and the registry dir lives under the user-owned fleet root; rename is atomic. |
| L2 | Low | `src/service/index.ts` `isAlreadyAbsentFailure` | The generic case-insensitive text fallback (`does not exist|cannot find|no such process|not[- ]loaded|could not find|not found`) could misclassify a GENUINE uninstall failure whose stderr coincidentally contains one of those phrases (for example a "config file not found" sub-error) as already-absent, masking a boot-resurrecting unit while `nectar uninstall` reports a friendly no-op. The locale-independent numeric checks (sc 1060, launchd exit 3) are correct. | Documented, accepted for now: the misclassification window is narrow, the conservative default (anything unmatched is a genuine failure) points the right way, and a per-manager pre-flight status query would be the robust follow-up. |
| L3 | Low | `src/hive-graph/deeplake-credentials.ts` `saveDeepLakeCredentials` | The writer does not tighten a PRE-EXISTING loose-mode `~/.deeplake` DIRECTORY (`0700` applies only when nectar creates it), and `existsSync` follows a symlinked `~/.deeplake` into its target. The loader's `warnIfWorldReadable` advisory covers the file, not the dir. | Documented, accepted: the dir is shared with honeycomb/hivemind and chmod-ing it from nectar risks cross-tool surprise; a symlinked `~/.deeplake` requires home-directory write access, at which point the attacker already owns the trust boundary. |
| L4 | Low | `src/auth/device-flow.ts` `resolveTenancy` | An explicit `--org=<id>` not present in the enumerated org list is accepted (`orgs.find(...) ?? { id: flags.org, name: flags.org }`) and passed to the mint. | Documented, accepted by design: the server is the authorization authority and refuses a mint for an org the account cannot access; the client-side list is UX, not an access control. |

## Focus-area verification (checked clean)

1. **Auth client token hygiene** (`src/auth/device-flow.ts`):
   - The token rides ONLY in the `Authorization: Bearer` header (`authHeaders`); it never appears in a URL, log line, error message, or the `out` sink. `AuthHttpError` carries status + truncated server body only; the catch-all in `runDeviceFlowLogin` surfaces `err.message`, never response payloads that carry tokens (the only token-bearing responses are `resp.ok` paths that never feed an error).
   - `device_code` is never printed; only `user_code` (by design, the user must type it) and the validated verification URL reach the terminal.
   - Browser opener: fixed-argv `execFileSync`, `shell` never set (no shell), 5s timeout, `stdio: "ignore"`, https-only gate BEFORE any spawn; `open` (darwin) / `rundll32 url.dll,FileProtocolHandler` (win32) / `xdg-open` (else). Opener failure returns `false`, never crashes the flow (proven by `test/device-flow-login.test.ts` a-AC-7 cases).
   - Poll floors honored: `Math.max(grant.interval || 5, 5) * 1000` floors at 5s, `slow_down` adds 5s and never shrinks, the poll count is hard-capped at `DEFAULT_MAX_POLLS` (900), and the retry budget for 429/5xx is bounded (3, exponential backoff). No hammering path exists.
   - No token in any spawned process argv: the opener receives only the URL; the daemon direct-spawn (`src/cli.ts` `spawnDaemonDetached`) passes only `--experimental-sqlite <script> daemon`.
2. **Credentials writer** (`src/hive-graph/deeplake-credentials.ts`): post-H1-fix the write is atomic (same-dir `0600` temp + rename), no partial file survives failure, no world-readable window exists at any point (mode set at open, rename swaps inodes), `savedAt` is stamped server-side ignoring caller input, and the dir is created `0700` when absent (test-verified on POSIX). Symlinked-dir posture documented as L3.
3. **Fleet detection** (`src/fleet-detection.ts`): the S2 loopback probe is bounded by a 750ms `AbortController` with an unref'd, cleared timer; malformed or non-object registry JSON is tolerated (`registryFileHasHive` returns `false`, never throws); the S3 npm probe is fixed-argv `execFile` with a 5s timeout (M1 fixed the win32 leg). Fail direction is explicit and documented: any signal fires means FLEET (popup suppressed).
4. **Uninstall / lifecycle** (`src/lifecycle.ts`, `src/cli.ts`, `src/doctor-registry.ts`): state-dir removal takes the RESOLVED absolute `nectarStateDir()` only (non-absolute refused), refuses a symlinked dir via `lstat` (no follow), and `rmSync(recursive)` does not follow symlinks inside the tree; only the `nectar` subdirectory of the fleet root is removed, never the root or another product's dir. The registry deregister rewrites atomically (temp + same-dir rename), removes ONLY entries with `name === "nectar"`, preserves every other daemon entry and unknown top-level key, reports (never clobbers) a present-but-malformed file, and treats an absent file as a clean no-op. A genuine current-unit removal failure is a hard exit-1, never swallowed (`ServiceUninstallResult.alreadyAbsent` classification).
5. **Credentials watch** (`src/credentials-watch.ts`): a single `PollLoop` with a floored cadence (config floor 1s, default 30s), change-only `onChange` (never re-fires on the same value), idempotent start/stop with drain; the per-tick cost is one small-file read + parse. No unbounded resource growth, no re-read amplification.
6. **Service start/stop argv** (`src/service/argv.ts`): every command is a constant-argv shape (`launchctl kickstart`/`bootout`, `systemctl start|stop`, `schtasks /Run|/End`, `sc start|stop`) executed through the existing `execFile` runner with `shell: false`; the only variables are the numeric `uid` and compile-time label constants.
7. **Health surface** (`src/health.ts`, `src/daemon.ts`): the `storage.reason` value is the machine-readable constant `"credentials-missing"`; no path, org id, or token detail is added to the loopback `/health` body. Daemon log lines on the watch's `onChange` carry fixed strings, never credential values.
8. **Supply chain:** `npm audit` reports 0 vulnerabilities (the package has zero runtime dependencies); no new dependencies were introduced by this branch.
9. **Token-in-logs sweep:** repo-wide regex sweep over the changed files for token/secret-bearing writes to stdout/stderr/logs found none.

## Files changed by remediation

| File | Change |
|---|---|
| `src/hive-graph/deeplake-credentials.ts` | H1: atomic `0600` temp + rename write, temp cleanup on failure, doc update. |
| `src/fleet-detection.ts` | M1: win32-only `shell: true` for the constant-argv `npm.cmd` probe, doc update. |
| `src/auth/device-flow.ts` | M2: https-only validation of the PRINTED verification URL (refuse on non-https), new `sanitizeForTerminal` applied to the printed user code and truncated error bodies. |

## Baseline verification (after remediation)

| Check | Result |
|---|---|
| `npm run build` | clean |
| `npm run typecheck` | clean |
| Full `npm test` | 1 failing = `test/hive-graph-search-live.test.ts` (the known environment-flaky live Deeplake ordering probe; excluded from judgment per the orchestrator), 6 skipped (platform-conditional); everything else green |
| Targeted suites (`device-flow-login`, `credentials-writer`, `fleet-detection`, `install-login-decision`, `lifecycle`) | 42 tests: 40 pass, 2 skipped (POSIX-mode checks on win32), 0 fail |
| `npm audit` | 0 vulnerabilities |

## Tooling note

The workspace-mandated Aikido MCP scan was attempted on the remediated files but the local scanner is degraded: Opengrep exits with code 2 and returns an empty issues array (with an identical boilerplate log regardless of input), and the Checkov binary is missing (`checkov.exe ENOENT`). Run `/aikido:setup` to repair it; the manual catalog-driven audit above is the effective coverage for this branch.

## Follow-ups (not blocking)

- L2: consider a pre-flight `statusCommand` query in `ServiceModule.uninstall` so already-absent is determined by state, not stderr text matching.
- The device-flow client does not honor the grant's `expires_in` (it relies on the 900-poll cap and the server's `expired_token` signal); wiring `expires_in` into the loop bound would tighten the failure message. Cosmetic.
