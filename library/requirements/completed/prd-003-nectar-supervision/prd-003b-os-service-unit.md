# PRD-003b: OS service unit definition + install

> Parent: [`prd-003-nectar-supervision-index.md`](./prd-003-nectar-supervision-index.md)

## Overview

nectar ships an **OS service unit** that starts it on boot and restarts it on crash, modeled on doctor's own self-registration service module. doctor already vendors per-OS unit templates (launchd plist / systemd unit / Windows Scheduled Task XML) and a platform/scope resolver; nectar reuses that exact shape — the two non-negotiables of self-supervision (restart-on-crash + start-on-boot) carry over verbatim — with nectar's own label, exec path, and run command.

This is the nectar-side analog of [`prd-004d-hive-service-unit-and-registration`](../prd-004-doctor-registry-and-hive/prd-004d-hive-service-unit-and-registration.md): each workload daemon registers its own OS service unit so it survives its own crash and a reboot. doctor supervises nectar by probing `/health` and restarting it through this unit; the OS unit is what makes "restart" a real action and what brings nectar back after a reboot while doctor itself is still coming up.

## Goals

- nectar defines a launchd LaunchAgent, a systemd `--user` unit, and a Windows Scheduled Task, each encoding restart-on-crash and start-on-boot (the two self-supervision non-negotiables from `doctor/src/service/templates.ts`).
- nectar's installer resolves the platform + scope (user scope by default, no root/admin) and writes the unit file, mirroring doctor's `createServiceModule.install` (`doctor/src/service/index.ts:129-234`).
- The unit execs the `nectar daemon` run command (no shell), so a crash restarts the daemon and a reboot brings it back.
- The unit name is distinct from doctor's and hive's so the three service units coexist.

## Non-Goals

- doctor's service module, templates, and platform resolver — those live in the doctor package and are the *pattern* this PRD mirrors, not code nectar vendors. nectar's installer produces equivalent output for its own daemon.
- hive's service unit — **PRD-004d**.
- Auto-update of the nectar package — each daemon's update is its own concern (PRD-004a non-goal: auto-update stays scoped to the honeycomb primary package).
- The remediation ladder's reinstall rung (rung 2) — doctor owns it; this PRD's unit is rung-1 restart's target.

---

## Unit definition per platform

doctor's templates encode the two self-supervision non-negotiables — restart-on-crash and start-on-boot — through platform-specific directives (`doctor/src/service/templates.ts` header). nectar's units adopt the same directives with nectar's label, exec, and run command.

> **`NECTAR_RUN_COMMAND`** = `daemon` — the subcommand the unit execs to start the nectar process (mirrors doctor's `DOCTOR_RUN_COMMAND = "run"` at `doctor/src/service/templates.ts`).

### macOS — launchd LaunchAgent

nectar renders a launchd plist mirroring `renderLaunchdPlist` (`doctor/src/service/templates.ts`):

- `RunAtLoad` → start-on-boot/login.
- `KeepAlive` → restart-on-crash.
- `ThrottleInterval` = `RESTART_SEC` (5s) — the macOS restart throttle.
- `ProgramArguments` = `[node, <nectar exec>, daemon]` (argv array, no shell).
- `StandardOutPath` / `StandardErrorPath` under `~/.honeycomb/nectar/`.

| Property | Value | Citation / status |
|---|---|---|
| Label | `com.hivenectar.daemon` | **DEFAULT — confirm before implementation** (doctor's is `com.legioncode.hivedoctor` at `doctor/src/service/platform.ts:37`) |
| Unit path (user) | `~/Library/LaunchAgents/com.hivenectar.daemon.plist` | mirrors `doctor/src/service/platform.ts:118-130` `userUnitPath("darwin")` |
| Restart throttle | `RESTART_SEC` (5s) | `doctor/src/service/templates.ts` `RESTART_SEC = 5` |

### Linux — systemd `--user` unit

nectar renders a systemd unit mirroring `renderSystemdUnit` (`doctor/src/service/templates.ts`):

- `Restart=always` + `RestartSec` = `RESTART_SEC` (5s) → restart-on-crash.
- `WantedBy=default.target` (with `systemctl --user enable`) → start-on-login/boot.
- `Type=simple` (nectar stays in the foreground).
- `ExecStart` = `"<nectar exec>" daemon` (quoted so a space-bearing install prefix cannot mis-split; mirrors `quoteSystemdToken`).

| Property | Value | Citation / status |
|---|---|---|
| Unit name | `hivenectar.service` | **DEFAULT — confirm before implementation** (doctor's is `hivedoctor.service` at `doctor/src/service/platform.ts:40`) |
| Unit path (user) | `~/.config/systemd/user/hivenectar.service` | mirrors `doctor/src/service/platform.ts:118-130` `userUnitPath("linux")` |
| Restart directives | `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0` | mirrors `doctor/src/service/templates.ts` `renderSystemdUnit` |

### Windows — Scheduled Task (per-user default)

nectar renders a Scheduled Task XML mirroring `renderScheduledTaskXml` (`doctor/src/service/templates.ts`):

- `LogonTrigger` → start at user logon (start-on-boot equivalent without admin).
- `RestartOnFailure` with `Interval` = `WINDOWS_RESTART_INTERVAL` (`PT1M`) → restart-on-crash.
- `MultipleInstancesPolicy=IgnoreNew` → a single instance (pairs with the single-instance lock).
- `<Command>` = node, `<Arguments>` = `"<nectar exec>" daemon` (separate elements, no shell parsing).

| Property | Value | Citation / status |
|---|---|---|
| Task name | `HivenectarDaemon` | **DEFAULT — confirm before implementation** (doctor's is `HiveDoctor` at `doctor/src/service/platform.ts:43`) |
| Restart interval | `WINDOWS_RESTART_INTERVAL` (`PT1M`) | `doctor/src/service/templates.ts` — Task Scheduler rejects sub-minute intervals (`PT5S` fails `/Create /XML`) |
| Manager | `schtasks` (per-user, no admin/UAC) | `doctor/src/service/platform.ts:154-173` — Windows default; `sc.exe` (Windows Service) is the enterprise opt-in at system scope only |

> **Windows restart interval is `PT1M`, not the POSIX 5s.** Task Scheduler rejects sub-minute intervals (`PT5S` makes `schtasks /Create /XML` fail with "(29,24):Interval:PT5S ... incorrectly formatted or out of range"); the minimum it accepts is `PT1M`. POSIX keeps `RESTART_SEC` (seconds). This is doctor's `WINDOWS_RESTART_INTERVAL` constant (`doctor/src/service/templates.ts`) — nectar adopts the same split.

---

## Platform + scope resolution

nectar's installer resolves which manager and which scope from three injected facts (platform, home dir, privilege), mirroring doctor's `resolveServicePlan` (`doctor/src/service/platform.ts:154-187`):

| Platform | Manager | User-scope path | Citation |
|---|---|---|---|
| macOS (`darwin`) | launchd | `~/Library/LaunchAgents/<label>.plist` | `doctor/src/service/platform.ts:118-130` |
| Linux (`linux`) | systemd | `~/.config/systemd/user/<unit>.service` | `doctor/src/service/platform.ts:118-130` |
| Windows (`win32`) | schtasks (per-user task) | registered via `schtasks /Create /XML` (no owned file on disk) | `doctor/src/service/platform.ts:118-130,154-173` |

**User scope is the default everywhere** (mirrors `doctor/src/service/platform.ts:15-19`): it needs no root/admin and matches a per-user `npm i -g`. A privileged context MAY install a system-scoped unit; an unprivileged context MUST fall back to user scope rather than failing (the fallback ordering at `doctor/src/service/platform.ts:160-163`: `wantsSystem && canSystem ? "system" : "user"`, recording `fellBackToUser`). An unsupported platform throws and the installer surfaces a clean "unsupported platform" result.

---

## Install flow

nectar's installer follows doctor's `createServiceModule.install` order (`doctor/src/service/index.ts:143-192`):

1. **Resolve the plan** — platform + manager + scope + unit path (`doctor/src/service/index.ts:138-152`); an unsupported platform returns `ok: false` with a message, not a thrown stack.
2. **Write the unit file first** (when file-based) — `mkdirp` the target dir, then `writeFile` the rendered unit text (`doctor/src/service/index.ts:154-172`); for schtasks the XML is staged beside the workspace (`~/.honeycomb/nectar/nectar-task.xml`) so `schtasks /Create /XML` can read it.
3. **Run the manager's install argv** — `launchctl bootstrap` / `systemctl --user enable --now` / `schtasks /Create` (the `installCommands` argv, run via `execFile` with no shell and a per-command timeout); a manager-command failure returns `ok: false` so the CLI maps it to a non-zero exit (`doctor/src/service/index.ts:174-185`).
4. **Surface an honest result message** naming the manager and scope (`doctor/src/service/index.ts:186-191`).

Every shell-out is `execFile` (no shell) and never throws; every fs call is wrapped so a permission error becomes a returned `ServiceResult`, never a thrown stack (the crash-safe posture at `doctor/src/service/index.ts:14-18`). The uninstall reverses this: run the manager's uninstall argv (idempotent — a missing unit is tolerated), then delete the unit file so it cannot resurrect on next boot (`doctor/src/service/index.ts:194-232`).

---

## User stories

### US-003b.1 — The OS restarts nectar on crash
**As an** operator, **when** nectar crashes, **the** OS service unit restarts it within the platform's throttle, **so that** nectar self-heals before doctor's restart rung even needs to fire.

- Acceptance: on macOS, the plist has `KeepAlive=true` + `ThrottleInterval=5` (mirrors `doctor/src/service/templates.ts` `renderLaunchdPlist`).
- Acceptance: on Linux, the unit has `Restart=always` + `RestartSec=5` (mirrors `renderSystemdUnit`).
- Acceptance: on Windows, the task has `RestartOnFailure` with `Interval=PT1M` + `Count=999` (mirrors `renderScheduledTaskXml`).

### US-003b.2 — nectar starts on boot
**As an** operator, **when** the OS boots (or the user logs in), **the** service unit starts nectar, **so that** the hive-graph daemon is up without a manual command.

- Acceptance: macOS `RunAtLoad=true`; Linux `WantedBy=default.target`; Windows `LogonTrigger` enabled (mirrors the start-on-boot directives across all three templates).
- Acceptance: the unit execs the `nectar daemon` run command (no shell).

### US-003b.3 — User scope by default; no root/admin needed
**As an** operator, **when** I install nectar without root/admin, **the** installer registers a user-scope unit, **so that** a per-user `npm i -g` is sufficient.

- Acceptance: an unprivileged install registers a LaunchAgent / `systemctl --user` unit / per-user Scheduled Task (mirrors `doctor/src/service/platform.ts:15-19,160-163`).
- Acceptance: an unsupported platform returns a clean `ok: false` result, not a thrown stack (mirrors `doctor/src/service/index.ts:138-152`).

### US-003b.4 — Uninstall removes the unit so it does not resurrect
**As an** operator, **when** I uninstall nectar, **the** installer deregisters the unit and deletes the unit file, **so that** nectar does not start on the next boot.

- Acceptance: uninstall runs the manager's uninstall argv (idempotent on a missing unit) then removes the unit file (mirrors `doctor/src/service/index.ts:194-232`).

---

## Implementation notes

- Unit templates (the pattern to mirror): `doctor/src/service/templates.ts` — `renderLaunchdPlist`, `renderSystemdUnit`, `renderScheduledTaskXml`, `renderUnit`; `RESTART_SEC = 5`; `WINDOWS_RESTART_INTERVAL = "PT1M"`; `quoteSystemdToken`; `escapeXml`.
- Platform + scope resolution (the pattern to mirror): `doctor/src/service/platform.ts` — `SERVICE_LABEL`/`SYSTEMD_UNIT_NAME`/`WINDOWS_TASK_NAME` (`:37-43`); `resolveServicePlan` (`:154-187`); `userUnitPath`/`systemUnitPath` (`:117-143`); user-scope default + fallback ordering (`:15-19,160-163`).
- Install/uninstall flow (the pattern to mirror): `doctor/src/service/index.ts:129-234` — `createServiceModule.install` (write-unit-first, then manager argv, `:143-192`); `uninstall` (deregister + delete unit, `:194-232`); crash-safe `execFile` runner + injected `ServiceFs` (`:14-18,111-123`).
- Service argv (install/uninstall/status commands): `doctor/src/service/argv.ts` (`installCommands`, `uninstallCommands`, `statusCommand`).
- Sibling PRD: [`prd-004d-hive-service-unit-and-registration`](../prd-004-doctor-registry-and-hive/prd-004d-hive-service-unit-and-registration.md) — hive's own service unit (the other workload daemon's analog).

No open questions. The unit names (`com.hivenectar.daemon` / `nectar` / `HivenectarDaemon`) are flagged defaults above.
