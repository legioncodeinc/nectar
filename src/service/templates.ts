/**
 * The vendored per-OS service-unit TEMPLATES for hivenectar (PRD-003b).
 *
 * Mirrors hivedoctor's own unit templates (hivedoctor/src/service/templates.ts)
 * with hivenectar's run command (`daemon`, not `run`) and hivenectar's label/unit
 * names (src/service/platform.ts). Three pure string builders, one per service
 * manager, that render the unit text from a {@link ServicePlan}. No I/O, no
 * shell-out - just deterministic text a test can snapshot-assert.
 *
 * Every template encodes the two non-negotiables of self-supervision (PRD-003b
 * Goals):
 *   - restart-on-crash  (launchd `KeepAlive`, systemd `Restart=always`, schtasks
 *                        `RestartOnFailure`);
 *   - start-on-boot     (launchd `RunAtLoad`, systemd `WantedBy=default.target`,
 *                        schtasks `LogonTrigger`).
 *
 * Built-ins only; XML/plist are hand-built with the few entities they need escaped.
 */

import { SERVICE_LABEL, WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";

/** The subcommand hivenectar's unit execs to start the process (no shell). */
export const HIVENECTAR_RUN_COMMAND = "daemon" as const;

/**
 * Seconds the OS waits before restarting a crashed hivenectar on POSIX. Used by the
 * launchd `ThrottleInterval` and the systemd `RestartSec` directives; both take
 * seconds. Mirrors hivedoctor's `RESTART_SEC` (hivedoctor/src/service/templates.ts).
 */
export const RESTART_SEC = 5 as const;

/**
 * The Windows Task Scheduler `RestartOnFailure`/`Interval` duration as an ISO-8601
 * time interval. Task Scheduler REJECTS sub-minute intervals; the minimum it accepts
 * is `PT1M`. This is Windows-only; POSIX keeps `RESTART_SEC` (seconds). Mirrors
 * hivedoctor's `WINDOWS_RESTART_INTERVAL`.
 */
export const WINDOWS_RESTART_INTERVAL = "PT1M" as const;

/**
 * Quote a single token for a systemd `ExecStart` line. systemd does NOT invoke a
 * shell, but a bare token splits on whitespace, so a space-bearing exec path would
 * mis-split. Wrapping the token in double quotes preserves the spaces.
 */
export function quoteSystemdToken(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Escape the five XML predefined entities so an exec path with `&`/quotes cannot break the doc. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Render a launchd plist (macOS). `RunAtLoad` = start-on-boot/login; `KeepAlive` =
 * restart-on-crash. `ProgramArguments` is an argv array (no shell), so a path with
 * spaces is safe. Logs go under the user's home so a LaunchAgent never needs root.
 */
export function renderLaunchdPlist(plan: ServicePlan): string {
  const node = escapeXml(process.execPath);
  const exec = escapeXml(plan.execPath);
  const home = escapeXml(plan.home);
  const label = escapeXml(plan.label);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${node}</string>
		<string>${exec}</string>
		<string>${HIVENECTAR_RUN_COMMAND}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>${RESTART_SEC}</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${home}/.honeycomb/hivenectar/launchd.out.log</string>
	<key>StandardErrorPath</key>
	<string>${home}/.honeycomb/hivenectar/launchd.err.log</string>
</dict>
</plist>
`;
}

/**
 * Render a systemd unit (Linux). `Restart=always` + `RestartSec` = restart-on-crash;
 * `WantedBy=default.target` (with `systemctl --user enable`) = start-on-login/boot.
 * `Type=simple` because hivenectar stays in the foreground of its own process.
 */
export function renderSystemdUnit(plan: ServicePlan): string {
  // Quote the exec path so a space-bearing install prefix cannot mis-split into two
  // argv tokens; the run subcommand is a fixed literal with no spaces.
  const exec = `${quoteSystemdToken(plan.execPath)} ${HIVENECTAR_RUN_COMMAND}`;
  return `[Unit]
Description=hivenectar - semantic memory layer daemon
Documentation=https://get.theapiary.sh
After=network.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=${RESTART_SEC}
StartLimitIntervalSec=0

[Install]
WantedBy=default.target
`;
}

/**
 * Render a Windows Scheduled Task definition XML (per-user, the Windows DEFAULT).
 * The `LogonTrigger` starts it at user logon (start-on-boot equivalent without
 * admin); `RestartOnFailure` gives restart-on-crash; `MultipleInstancesPolicy=IgnoreNew`
 * keeps a single instance (pairs with hivenectar's single-instance lock, PRD-003a).
 * `<Command>`/`<Arguments>` are separate (no shell parsing).
 *
 * Consumed via `schtasks /Create /XML <file>`, so the per-user task needs no admin/UAC.
 * Uses {@link WINDOWS_RESTART_INTERVAL} (`PT1M`), NOT {@link RESTART_SEC}: Task
 * Scheduler rejects sub-minute intervals.
 */
export function renderScheduledTaskXml(plan: ServicePlan): string {
  const node = escapeXml(process.execPath);
  const exec = escapeXml(plan.execPath);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>hivenectar - semantic memory layer daemon</Description>
    <URI>\\${escapeXml(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RestartOnFailure>
      <Interval>${WINDOWS_RESTART_INTERVAL}</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${node}</Command>
      <Arguments>"${exec}" ${HIVENECTAR_RUN_COMMAND}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** The single entry point: render whichever unit text the plan's manager needs. */
export function renderUnit(plan: ServicePlan): string {
  switch (plan.manager) {
    case "launchd":
      return renderLaunchdPlist(plan);
    case "systemd":
      return renderSystemdUnit(plan);
    case "schtasks":
    case "sc":
      // Both Windows backends consume the same Scheduled-Task XML when file-based; sc.exe
      // (system service) is created via argv (see argv.ts) and does not use this template,
      // but a single renderer keeps the XML available for the schtasks path.
      return renderScheduledTaskXml(plan);
  }
}

/** Re-export the label so callers building argv share one source of truth. */
export { SERVICE_LABEL };
