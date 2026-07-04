import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  renderScheduledTaskXml,
  renderUnit,
  NECTAR_RUN_COMMAND,
  RESTART_SEC,
  WINDOWS_RESTART_INTERVAL,
  quoteSystemdToken,
  escapeXml,
} from "../dist/service/templates.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveServicePlan } from "../dist/service/platform.js";

function plan(overrides: Partial<Parameters<typeof resolveServicePlan>[0]> = {}) {
  return resolveServicePlan({
    platform: "linux" as NodeJS.Platform,
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/nectar",
    ...overrides,
  });
}

test("NECTAR_RUN_COMMAND is 'daemon', distinct from doctor's 'run'", () => {
  assert.equal(NECTAR_RUN_COMMAND, "daemon");
});

test("launchd plist encodes RunAtLoad + KeepAlive + the daemon run command", () => {
  const xml = renderLaunchdPlist(plan({ platform: "darwin", home: "/Users/op" }));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, new RegExp(`<integer>${RESTART_SEC}</integer>`));
  assert.match(xml, /<string>com\.legioncode\.nectar<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
  assert.match(xml, /<string>\/Users\/op\/\.apiary\/nectar\/logs\/launchd\.out\.log<\/string>/);
});

test("c-AC-1 service templates carry no .honeycomb literal", () => {
  const src = readFileSync(fileURLToPath(new URL("../dist/service/templates.js", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /\.honeycomb/);
});

test("c-AC-2 launchd plist includes APIARY_HOME when the plan pins a custom root", () => {
  const xml = renderLaunchdPlist(plan({ platform: "darwin", home: "/Users/op", apiaryHome: "/custom/root" }));
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(xml, /<key>APIARY_HOME<\/key>/);
  assert.match(xml, /<string>\/custom\/root<\/string>/);
  assert.match(xml, /<string>\/custom\/root\/nectar\/logs\/launchd\.out\.log<\/string>/);
});

test("systemd unit encodes Restart=always + RestartSec + WantedBy + the daemon run command, prefixed by the node interpreter", () => {
  const unit = renderSystemdUnit(plan({ platform: "linux" }));
  assert.match(unit, /Restart=always/);
  assert.match(unit, new RegExp(`RestartSec=${RESTART_SEC}`));
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Type=simple/);
  // AC-018a.8: ExecStart prefixes the quoted node interpreter before the quoted CLI entry, then `daemon`.
  assert.match(unit, /ExecStart=".*" ".*nectar" daemon/);
  assert.ok(
    unit.includes(quoteSystemdToken(process.execPath)),
    "ExecStart contains the quoted process.execPath (the node interpreter), matching launchd/schtasks",
  );
});

test("c-AC-2 systemd unit pins APIARY_HOME when the plan carries a custom fleet root", () => {
  const unit = renderSystemdUnit(plan({ platform: "linux", apiaryHome: "/custom/root" }));
  assert.match(unit, /Environment="APIARY_HOME=\/custom\/root"/);
});

test("AC-018a.8 systemd unit declares finite restart rate limiting (no StartLimitIntervalSec=0 crash loop)", () => {
  const unit = renderSystemdUnit(plan({ platform: "linux" }));
  assert.match(unit, /StartLimitBurst=\d+/, "a finite StartLimitBurst is declared");
  assert.match(unit, /StartLimitIntervalSec=[1-9]\d*/, "a non-zero StartLimitIntervalSec is declared");
  assert.doesNotMatch(unit, /StartLimitIntervalSec=0\b/, "rate limiting is not disabled");
});

test("systemd ExecStart quotes a space-bearing exec path so it does not mis-split (as the second token, after node)", () => {
  const unit = renderSystemdUnit(plan({ platform: "linux", execPath: "/opt/my apps/nectar" }));
  assert.match(unit, /ExecStart=".*" "\/opt\/my apps\/nectar" daemon/);
});

test("Windows Scheduled Task XML encodes LogonTrigger + RestartOnFailure at the 1-minute floor", () => {
  const xml = renderScheduledTaskXml(plan({ platform: "win32", home: "C:/Users/op" }));
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, new RegExp(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`));
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<URI>\\nectar<\/URI>/);
  assert.match(xml, /<Arguments>[\s\S]*daemon<\/Arguments>/);
});

test("c-AC-5 Windows task XML carries APIARY_HOME through cmd when the plan pins a root", () => {
  const xml = renderScheduledTaskXml(plan({ platform: "win32", home: "C:/Users/op", apiaryHome: "C:/Pinned/Home" }));
  assert.match(xml, /<Command>cmd\.exe<\/Command>/);
  assert.match(xml, /APIARY_HOME=C:\/Pinned\/Home/);
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
