import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  renderScheduledTaskXml,
  renderUnit,
  HIVENECTAR_RUN_COMMAND,
  RESTART_SEC,
  WINDOWS_RESTART_INTERVAL,
  quoteSystemdToken,
  escapeXml,
} from "../dist/service/templates.js";
import { resolveServicePlan } from "../dist/service/platform.js";

function plan(overrides: Partial<Parameters<typeof resolveServicePlan>[0]> = {}) {
  return resolveServicePlan({
    platform: "linux" as NodeJS.Platform,
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/hivenectar",
    ...overrides,
  });
}

test("HIVENECTAR_RUN_COMMAND is 'daemon', distinct from hivedoctor's 'run'", () => {
  assert.equal(HIVENECTAR_RUN_COMMAND, "daemon");
});

test("launchd plist encodes RunAtLoad + KeepAlive + the daemon run command", () => {
  const xml = renderLaunchdPlist(plan({ platform: "darwin", home: "/Users/op" }));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, new RegExp(`<integer>${RESTART_SEC}</integer>`));
  assert.match(xml, /<string>com\.legioncode\.nectar<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
});

test("systemd unit encodes Restart=always + RestartSec + WantedBy + the daemon run command", () => {
  const unit = renderSystemdUnit(plan({ platform: "linux" }));
  assert.match(unit, /Restart=always/);
  assert.match(unit, new RegExp(`RestartSec=${RESTART_SEC}`));
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Type=simple/);
  assert.match(unit, /ExecStart=".*hivenectar" daemon/);
});

test("systemd ExecStart quotes a space-bearing exec path so it does not mis-split", () => {
  const unit = renderSystemdUnit(plan({ platform: "linux", execPath: "/opt/my apps/hivenectar" }));
  assert.match(unit, /ExecStart="\/opt\/my apps\/hivenectar" daemon/);
});

test("Windows Scheduled Task XML encodes LogonTrigger + RestartOnFailure at the 1-minute floor", () => {
  const xml = renderScheduledTaskXml(plan({ platform: "win32", home: "C:/Users/op" }));
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, new RegExp(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`));
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<URI>\\nectar<\/URI>/);
  assert.match(xml, /Arguments>".*hivenectar" daemon</);
});

test("renderUnit dispatches per manager", () => {
  assert.match(renderUnit(plan({ platform: "darwin", home: "/Users/op" })), /<plist/);
  assert.match(renderUnit(plan({ platform: "linux" })), /\[Unit\]/);
  assert.match(renderUnit(plan({ platform: "win32", home: "C:/Users/op" })), /<Task /);
});

test("quoteSystemdToken escapes backslash and double-quote", () => {
  assert.equal(quoteSystemdToken('a\\b"c'), '"a\\\\b\\"c"');
});

test("escapeXml escapes the five predefined XML entities", () => {
  assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
});
