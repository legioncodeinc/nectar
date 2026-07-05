import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServiceModule,
  serviceStatus,
  resolveWindowsUserId,
  resolveWhoamiPath,
  parseWhoamiCsvSid,
  fallbackWindowsUserId,
  WHOAMI_ARGS,
} from "../dist/service/index.js";
import type { CommandResult, CommandRunner } from "../dist/service/command-runner.js";
import type { ServiceFs } from "../dist/service/index.js";
import type { ServiceEnvironment } from "../dist/service/platform.js";

function fakeFs(): ServiceFs & { written: Map<string, string>; removed: string[]; dirs: string[] } {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const dirs: string[] = [];
  return {
    written,
    removed,
    dirs,
    mkdirp(dir: string) {
      dirs.push(dir);
    },
    writeFile(path: string, content: string) {
      written.set(path, content);
    },
    removeFile(path: string) {
      removed.push(path);
    },
  };
}

function okRunner(recordedCalls: { command: string; args: readonly string[] }[] = []): CommandRunner {
  return {
    async run(command, args): Promise<CommandResult> {
      recordedCalls.push({ command, args });
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  };
}

function failingRunner(overrides: Partial<CommandResult> = {}): CommandRunner {
  return {
    async run(): Promise<CommandResult> {
      return { ok: false, code: 1, stdout: "", stderr: "boom", detail: "boom", ...overrides };
    },
  };
}

function linuxEnv(overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment {
  return {
    platform: "linux",
    home: "/home/op",
    privileged: false,
    execPath: "/usr/local/bin/nectar",
    ...overrides,
  };
}

test("install writes the unit file then runs the manager's install argv", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner = okRunner(calls);
  const svc = createServiceModule({ execPath: "/usr/local/bin/nectar", fs, runner, environment: linuxEnv() });

  const result = await svc.install();
  assert.equal(result.ok, true);
  assert.match(result.message, /registered as a systemd service/);

  const unitPath = "/home/op/.config/systemd/user/nectar.service";
  assert.ok(fs.written.has(unitPath));
  assert.match(fs.written.get(unitPath) ?? "", /ExecStart=/);
  // Decision #32 migration: the legacy unit is deregistered (and its file removed) FIRST.
  assert.deepEqual(calls[0]?.args, ["--user", "disable", "--now", "hivenectar.service"]);
  assert.deepEqual(fs.removed, ["/home/op/.config/systemd/user/hivenectar.service"]);
  // AC-018l.10: daemon-reload precedes enable --now on reinstall.
  assert.deepEqual(calls[1]?.args, ["--user", "daemon-reload"]);
  assert.deepEqual(calls[2]?.args, ["--user", "enable", "--now", "nectar.service"]);
});

test("install reports ok:false when a manager command fails, but the unit file is still written", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: failingRunner(),
    environment: linuxEnv(),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /service-manager command failed \(systemctl\): boom/, "the real failure detail is surfaced, not just the command name");
  assert.equal(fs.written.size, 1, "the unit file was still written before the argv ran");
});

test("install surfaces the real service-manager stderr (e.g. Windows schtasks 'Access is denied') when no runner detail is present", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    // No `detail` field at all (as a real execFile non-zero-exit failure looks: ok:false, a
    // real exit code, and only stderr text) - describeFailure must fall back to stderr.
    runner: failingRunner({ detail: undefined, stderr: "ERROR: Access is denied.\r\n" }),
    environment: linuxEnv(),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /ERROR: Access is denied\./);
});

test("a failure detail longer than the cap is truncated with an ellipsis, never silently dropped", async () => {
  const fs = fakeFs();
  const longLine = "x".repeat(500);
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: failingRunner({ detail: undefined, stderr: longLine }),
    environment: linuxEnv(),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /x{200}\.\.\./);
  assert.ok(!result.message.includes(longLine), "the full 500-char line is not echoed verbatim");
});

test("install on an unsupported platform returns ok:false, never throws", async () => {
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs: fakeFs(),
    runner: okRunner(),
    environment: linuxEnv({ platform: "aix" as NodeJS.Platform }),
  });
  const result = await svc.install();
  assert.equal(result.ok, false);
  assert.match(result.message, /unsupported platform/);
});

test("uninstall runs the manager's uninstall argv then deletes the unit file", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv(),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.command, "systemctl");
  assert.deepEqual(fs.removed, ["/home/op/.config/systemd/user/nectar.service"]);
});

test("uninstall tolerates a manager command failure (already-gone unit) and still removes the file", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: failingRunner(),
    environment: linuxEnv(),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, false);
  assert.match(result.message, /boom/, "the real failure detail is surfaced");
  assert.equal(fs.removed.length, 1, "the unit file is removed even when the deregister command failed");
});

test("install on darwin writes the launchd plist to ~/Library/LaunchAgents and bootstraps + kickstarts", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "darwin", home: "/Users/op" }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  assert.match(result.message, /registered as a launchd service/);

  const unitPath = "/Users/op/Library/LaunchAgents/com.legioncode.nectar.plist";
  assert.ok(fs.written.has(unitPath));
  assert.match(fs.written.get(unitPath) ?? "", /<key>KeepAlive<\/key>/);
  // Decision #32 migration: the legacy label is booted out and its plist removed first.
  assert.equal(calls[0]?.command, "launchctl");
  assert.equal(calls[0]?.args[0], "bootout");
  assert.ok(calls[0]?.args[1]?.endsWith("/com.hivenectar.daemon"));
  assert.deepEqual(fs.removed, ["/Users/op/Library/LaunchAgents/com.hivenectar.daemon.plist"]);
  assert.equal(calls[1]?.args[0], "bootstrap");
  assert.equal(calls[2]?.args[0], "kickstart");
});

test("c-AC-2 install renders APIARY_HOME into launchd when the plan pins a custom root", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: okRunner(),
    environment: linuxEnv({ platform: "darwin", home: "/Users/op", apiaryHome: "/custom/root" }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  const unitPath = "/Users/op/Library/LaunchAgents/com.legioncode.nectar.plist";
  const plist = fs.written.get(unitPath) ?? "";
  assert.match(plist, /<key>APIARY_HOME<\/key>/);
  assert.match(plist, /<string>\/custom\/root<\/string>/);
  assert.ok(fs.dirs.includes("/custom/root/nectar/logs"), "launchd log dir follows the pinned root");
});

test("AC-018l.9 the macOS (launchd) install creates the log directory the plist writes to (NEC-042 item 2)", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: okRunner(),
    environment: linuxEnv({ platform: "darwin", home: "/Users/op" }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  // The plist writes stdout/stderr to <home>/.apiary/nectar/logs; that dir must exist.
  assert.ok(
    fs.dirs.includes("/Users/op/.apiary/nectar/logs"),
    `the launchd log directory was mkdirp'd (saw: ${JSON.stringify(fs.dirs)})`,
  );
});

test("uninstall on darwin bootouts the launchd target and removes the plist", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "/usr/local/bin/nectar",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "darwin", home: "/Users/op" }),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.args[0], "bootout");
  assert.deepEqual(fs.removed, ["/Users/op/Library/LaunchAgents/com.legioncode.nectar.plist"]);
});

test("install on win32 stages the schtasks XML beside the workspace, then Creates and Runs it", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
    windowsUserIdEnv: {},
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  assert.match(result.message, /registered as a schtasks service/);

  const stagedXml = "C:/Users/op/.apiary/nectar/nectar-task.xml";
  assert.ok(fs.written.has(stagedXml), "the schtasks XML is staged beside the workspace (unitPath is empty for schtasks)");
  assert.match(fs.written.get(stagedXml) ?? "", /<Task /);
  // Decision #32 migration: the legacy task name is deleted first.
  assert.equal(calls[0]?.command, "schtasks");
  assert.deepEqual(calls[0]?.args, ["/Delete", "/TN", "HivenectarDaemon", "/F"]);
  // The SID/UserId resolution shell-out (whoami.exe) runs through the same injected
  // runner as every other schtasks command, before the unit file is rendered/written.
  assert.match(calls[1]?.command ?? "", /whoami\.exe$/);
  assert.deepEqual(calls[1]?.args, ["/user", "/fo", "csv", "/nh"]);
  assert.deepEqual(calls[2]?.args, ["/Create", "/XML", stagedXml, "/TN", "nectar", "/F"]);
  assert.deepEqual(calls[3]?.args, ["/Run", "/TN", "nectar"]);
});

test("install on win32 embeds the resolved SID into the written schtasks XML's UserId elements", async () => {
  const fs = fakeFs();
  const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  const runner: CommandRunner = {
    async run(command): Promise<CommandResult> {
      if (command.endsWith("whoami.exe")) {
        return { ok: true, code: 0, stdout: `"CONTOSO\\op","${sid}"\r\n`, stderr: "" };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  };
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner,
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  const stagedXml = "C:/Users/op/.apiary/nectar/nectar-task.xml";
  const xml = fs.written.get(stagedXml) ?? "";
  assert.match(xml, new RegExp(`<LogonTrigger>[\\s\\S]*<UserId>${sid}</UserId>[\\s\\S]*</LogonTrigger>`));
  assert.match(xml, new RegExp(`<Principal id="Author">[\\s\\S]*<UserId>${sid}</UserId>`));
});

test("install on win32 falls back to USERDOMAIN\\USERNAME when whoami yields no valid SID", async () => {
  const fs = fakeFs();
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
      // whoami succeeds but returns something that is not a SID (e.g. a locale surprise).
      return { ok: true, code: 0, stdout: `"CONTOSO\\op","not-a-sid"\r\n`, stderr: "" };
    },
  };
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner,
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
    windowsUserIdEnv: { USERDOMAIN: "CONTOSO", USERNAME: "op" },
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  const xml = fs.written.get("C:/Users/op/.apiary/nectar/nectar-task.xml") ?? "";
  assert.match(xml, /<UserId>CONTOSO\\op<\/UserId>/);
});

test("install on win32 renders no UserId at all when whoami fails AND no USERDOMAIN\\USERNAME fallback is available", async () => {
  const fs = fakeFs();
  const runner: CommandRunner = {
    async run(command): Promise<CommandResult> {
      // Only the whoami.exe shell-out fails; every other schtasks command succeeds,
      // so the install as a whole still reports ok:true (a failed SID resolution
      // never blocks registration - the pre-fix, non-hardened-machine shape).
      if (command.endsWith("whoami.exe")) return { ok: false, code: 1, stdout: "", stderr: "boom" };
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  };
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner,
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
    windowsUserIdEnv: {},
  });
  const result = await svc.install();
  assert.equal(result.ok, true, "a failed whoami shell-out never fails the install (non-hardened machines keep working)");
  const xml = fs.written.get("C:/Users/op/.apiary/nectar/nectar-task.xml") ?? "";
  assert.doesNotMatch(xml, /<UserId>/);
});

test("install on win32 wraps the Exec action behind conhost.exe --headless (no console window)", async () => {
  const fs = fakeFs();
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner: okRunner(),
    environment: linuxEnv({
      platform: "win32",
      home: "C:/Users/op",
      execPath: "C:/Program Files/nectar/nectar.js",
    }),
    windowsUserIdEnv: {},
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  const xml = fs.written.get("C:/Users/op/.apiary/nectar/nectar-task.xml") ?? "";
  assert.match(xml, /<Command>[^<]*conhost\.exe<\/Command>/);
  // The Arguments text is XML-escaped, so a literal quote reads as &quot;.
  const argumentsLine = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/)?.[1] ?? "";
  assert.match(argumentsLine, /^--headless &quot;/, "the wrapped real command follows --headless");
  assert.match(argumentsLine, /nectar\.js/, "the exec path still appears inside the wrapped Arguments");
  assert.match(argumentsLine, /daemon$/, "the run subcommand is still the final token");
});

test("uninstall on win32 deletes the task and removes the staged XML", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({ platform: "win32", home: "C:/Users/op" }),
  });
  const result = await svc.uninstall();
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0]?.args, ["/Delete", "/TN", "nectar", "/F"]);
  assert.deepEqual(fs.removed, ["C:/Users/op/.apiary/nectar/nectar-task.xml"]);
});

test("c-AC-5 win32 system-scope install pins APIARY_HOME into the sc binPath when provided", async () => {
  const fs = fakeFs();
  const calls: { command: string; args: readonly string[] }[] = [];
  const svc = createServiceModule({
    execPath: "C:/Program Files/nectar/nectar.js",
    fs,
    runner: okRunner(calls),
    environment: linuxEnv({
      platform: "win32",
      home: "C:/Users/op",
      privileged: true,
      preferSystemScope: true,
      apiaryHome: "C:/Pinned/Home",
    }),
  });
  const result = await svc.install();
  assert.equal(result.ok, true);
  const create = calls.find((call) => call.command === "sc" && call.args[0] === "create");
  assert.ok(create, "sc create command was issued");
  assert.ok(create?.args.some((arg) => arg.includes("APIARY_HOME=C:/Pinned/Home")));
});

test("serviceStatus classifies systemd is-active output and never throws on an unsupported platform", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner: CommandRunner = {
    async run(command, args): Promise<CommandResult> {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: "active\n", stderr: "" };
    },
  };
  const running = await serviceStatus({ execPath: "/usr/local/bin/nectar", runner, environment: linuxEnv() });
  assert.equal(running, "running");
  assert.equal(calls[0]?.command, "systemctl");

  const unknown = await serviceStatus({
    execPath: "/usr/local/bin/nectar",
    runner,
    environment: linuxEnv({ platform: "aix" as NodeJS.Platform }),
  });
  assert.equal(unknown, "unknown");
});

test("resolveWhoamiPath resolves under SystemRoot, never a bare 'whoami' (git-bash shadowing)", () => {
  assert.equal(resolveWhoamiPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\whoami.exe");
  assert.equal(resolveWhoamiPath({}), "C:\\Windows\\System32\\whoami.exe", "falls back to C:\\Windows when SystemRoot is unset");
});

test("parseWhoamiCsvSid extracts and validates the SID from the last CSV field", () => {
  assert.equal(
    parseWhoamiCsvSid('"CONTOSO\\op","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n'),
    "S-1-5-21-1111111111-2222222222-3333333333-1001",
  );
  // A leading blank line (some whoami builds emit one) is tolerated: the LAST
  // non-empty line is the one parsed.
  assert.equal(
    parseWhoamiCsvSid('\r\n"CONTOSO\\op","S-1-5-21-1-1"\r\n'),
    "S-1-5-21-1-1",
  );
});

test("parseWhoamiCsvSid rejects anything that does not match the SID shape", () => {
  assert.equal(parseWhoamiCsvSid(""), null);
  assert.equal(parseWhoamiCsvSid('"CONTOSO\\op","not-a-sid"'), null);
  assert.equal(parseWhoamiCsvSid('"CONTOSO\\op",""'), null);
  assert.equal(parseWhoamiCsvSid("garbage output with no commas at all"), null);
});

test("fallbackWindowsUserId builds DOMAIN\\USER, and only when both are present", () => {
  assert.equal(fallbackWindowsUserId({ USERDOMAIN: "CONTOSO", USERNAME: "op" }), "CONTOSO\\op");
  assert.equal(fallbackWindowsUserId({ USERDOMAIN: "CONTOSO" }), null, "USERNAME missing");
  assert.equal(fallbackWindowsUserId({ USERNAME: "op" }), null, "USERDOMAIN missing");
  assert.equal(fallbackWindowsUserId({ USERDOMAIN: "  ", USERNAME: "op" }), null, "blank USERDOMAIN is treated as absent");
  assert.equal(fallbackWindowsUserId({}), null);
});

test("resolveWindowsUserId prefers the whoami SID over the domain\\user fallback when both are available", async () => {
  const sid = "S-1-5-21-9-9-9-9";
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner: CommandRunner = {
    async run(command, args): Promise<CommandResult> {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: `"CONTOSO\\op","${sid}"`, stderr: "" };
    },
  };
  const userId = await resolveWindowsUserId(runner, { USERDOMAIN: "CONTOSO", USERNAME: "op" });
  assert.equal(userId, sid);
  assert.deepEqual(calls[0]?.args, WHOAMI_ARGS);
  assert.match(calls[0]?.command ?? "", /whoami\.exe$/);
});

test("resolveWindowsUserId falls back to domain\\user when whoami's own execFile call fails to spawn", async () => {
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
      return { ok: false, code: null, stdout: "", stderr: "", detail: "ENOENT" };
    },
  };
  const userId = await resolveWindowsUserId(runner, { USERDOMAIN: "CONTOSO", USERNAME: "op" });
  assert.equal(userId, "CONTOSO\\op");
});

test("resolveWindowsUserId returns undefined when neither the SID nor the fallback resolves", async () => {
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
      return { ok: true, code: 0, stdout: "not a sid at all", stderr: "" };
    },
  };
  const userId = await resolveWindowsUserId(runner, {});
  assert.equal(userId, undefined);
});
