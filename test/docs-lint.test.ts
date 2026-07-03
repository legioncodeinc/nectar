/**
 * Docs-lint suite (PRD-018l NEC-004 / NEC-040, plus PRD-018k AC-018k.4/.5).
 *
 * A lint-style test that reads the shipped documentation and asserts on its
 * content, so dead commands, stale cost figures, and the `honeycomb nectar`
 * prefix cannot silently reappear. It scans the knowledge corpus
 * (`library/knowledge/**`), `README.md`, and `AGENTS.md` - deliberately NOT
 * `library/requirements/**`, `library/notes/**`, or `library/ledger/**`, which
 * legitimately quote the OLD commands as the very evidence being fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NECTAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(NECTAR_ROOT, rel), "utf8");
}

function walkMd(relDir: string): string[] {
  const out: string[] = [];
  const abs = join(NECTAR_ROOT, relDir);
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkMd(childRel));
    else if (entry.name.endsWith(".md")) out.push(childRel);
  }
  return out;
}

/** Extract the bodies of fenced ``` code blocks from a markdown string. */
function fencedBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```[a-zA-Z0-9]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) blocks.push(m[1] ?? "");
  return blocks;
}

const GETTING_STARTED = "library/knowledge/public/guides/getting-started-with-nectar.md";
const KEEPING_ACCURATE = "library/knowledge/public/guides/keeping-descriptions-accurate.md";
const WHAT_IS = "library/knowledge/public/overview/what-is-nectar.md";
const BROODING = "library/knowledge/private/ai/brooding-pipeline.md";
const PRIVATE_OVERVIEW = "library/knowledge/private/overview.md";
const PORTABLE_REGISTRY = "library/knowledge/private/data/portable-registry.md";

// ── AC-018l.1: the honeycomb nectar / honeycomb recall prefix sweep ────────────

test("AC-018l.1 no `honeycomb nectar` command examples remain in the knowledge corpus, and README has no honeycomb recall", () => {
  for (const rel of walkMd("library/knowledge")) {
    assert.ok(!read(rel).includes("honeycomb nectar"), `${rel} still contains a 'honeycomb nectar' command`);
  }
  const readme = read("README.md");
  assert.ok(!readme.includes("honeycomb nectar"), "README has no 'honeycomb nectar' command");
  assert.ok(!readme.includes("honeycomb recall"), "README no longer demos 'honeycomb recall'");
});

// ── AC-018l.2: every fenced `nectar` command in the public guides is real ──────

test("AC-018l.2 every fenced `nectar` command in the public guides exists in the CLI USAGE surface", () => {
  const cli = read("src/cli.ts");
  for (const rel of walkMd("library/knowledge/public")) {
    for (const block of fencedBlocks(read(rel))) {
      for (const line of block.split("\n")) {
        const m = line.trim().match(/^nectar\s+([a-z][a-z-]*)/);
        if (m === null) continue;
        const verb = m[1];
        assert.ok(cli.includes(`nectar ${verb}`), `guide command 'nectar ${verb}' (${rel}) is not in the CLI surface (src/cli.ts)`);
      }
    }
  }
});

// ── AC-018l.2 (executable layer): documented commands actually run ─────────────
//
// The static check above proves a verb is named in the CLI source; this layer
// EXECUTES every fenced public-guide command against the shipped dist/cli.js
// under an isolated HOME + temp project fixture and proves:
//   - read-only local commands (--help, brood --dry-run) exit 0 on their happy
//     path, with a fake credentials fixture standing in for the operator's
//     ~/.deeplake/credentials.json (dry-run makes no network call);
//   - credentialed/mutating commands (brood, brood --force, review-matches,
//     prune, search, rebuild-projection) DISPATCH to their real mechanics: the
//     CLI must never answer 'unknown command'. Their exit-0 happy paths need a
//     live daemon/store and are proven by the verb tests in test/cli.test.ts,
//     so here a recognized, documented refusal (nonzero exit with guidance) is
//     the accepted outcome under the isolated fixture.
//   - `nectar daemon` is excluded: long-running by design; its happy path is
//     proven by test/daemon.test.ts and test/daemon-watch-integration.test.ts.
//   - `nectar install`/`uninstall` are excluded: they mutate OS service state;
//     proven by test/service-index.test.ts / test/service-argv.test.ts.

const EXEC_EXCLUDED_VERBS = new Set(["daemon", "install", "uninstall"]);

function collectGuideCommands(): { rel: string; command: string }[] {
  const out: { rel: string; command: string }[] = [];
  for (const rel of walkMd("library/knowledge/public")) {
    for (const block of fencedBlocks(read(rel))) {
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (/^nectar\s+[a-z][a-z-]*/.test(trimmed)) out.push({ rel, command: trimmed });
      }
    }
  }
  return out;
}

test("AC-018l.2 (executable) every fenced public-guide command dispatches; local happy paths exit 0", () => {
  const cliJs = join(NECTAR_ROOT, "dist", "cli.js");
  const home = mkdtempSync(join(tmpdir(), "nectar-docs-lint-home-"));
  const project = mkdtempSync(join(tmpdir(), "nectar-docs-lint-proj-"));
  try {
    // Fake credentials fixture: dry-run resolves tenancy from it but performs
    // no network call and no writes (throwaway in-memory store).
    mkdirSync(join(home, ".deeplake"), { recursive: true });
    writeFileSync(
      join(home, ".deeplake", "credentials.json"),
      JSON.stringify({
        apiUrl: "http://127.0.0.1:9",
        token: "docs-lint-fake-token",
        orgId: "docs-lint-org",
        workspaceId: "docs-lint-ws",
      }),
    );
    // Minimal project fixture: a git repo with one tracked file so discovery's
    // git path yields a deterministic, non-degraded result.
    execFileSync("git", ["init", "-q"], { cwd: project });
    writeFileSync(join(project, "hello.ts"), "export const hello = 1;\n");
    execFileSync("git", ["add", "hello.ts"], { cwd: project });

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NECTAR_TELEMETRY: "0",
      NECTAR_PROJECT_ROOT: project,
      NECTAR_PROJECT_ID: "docs-lint-project",
    };
    const runCli = (args: string[]) =>
      spawnSync(process.execPath, ["--experimental-sqlite", cliJs, ...args], {
        env,
        cwd: project,
        encoding: "utf8",
        timeout: 60_000,
      });

    // Happy-path exit-0 layer.
    const help = runCli(["--help"]);
    assert.equal(help.status, 0, `nectar --help exits 0 (stderr: ${help.stderr})`);
    const dryRun = runCli(["brood", "--dry-run"]);
    assert.equal(dryRun.status, 0, `nectar brood --dry-run exits 0 (stderr: ${dryRun.stderr})`);
    assert.ok(/source/i.test(dryRun.stdout), "dry-run report names the discovery source (AC-018c.11)");

    // Dispatch layer: every documented command must be recognized.
    for (const { rel, command } of collectGuideCommands()) {
      const args = command.split(/\s+/).slice(1);
      const verb = args[0] ?? "";
      if (EXEC_EXCLUDED_VERBS.has(verb)) continue;
      const res = runCli(args.map((a) => a.replace(/^"|"$/g, "")));
      const combined = `${res.stdout}\n${res.stderr}`;
      assert.ok(
        !/unknown command/i.test(combined),
        `documented command '${command}' (${rel}) is not recognized by the CLI: ${combined.slice(0, 300)}`,
      );
      assert.equal(res.error, undefined, `documented command '${command}' (${rel}) failed to spawn/timed out`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// ── AC-018l.3: nectar search documented; agent-recall/auto-freshness softened ──

test("AC-018l.3 nectar search is documented and the inverted present-tense claims are gone", () => {
  assert.ok(read(GETTING_STARTED).includes("nectar search"), "getting-started documents nectar search");
  assert.ok(read("README.md").includes("nectar search"), "README documents nectar search");
  assert.ok(
    !read(GETTING_STARTED).includes("keeps descriptions current automatically"),
    "the auto-freshness overclaim is gone from getting-started",
  );
  assert.ok(
    !read(WHAT_IS).includes("works behind the scenes, through your AI coding assistant"),
    "the inverted 'works through your AI coding assistant' claim is gone from what-is-nectar",
  );
});

// ── AC-018l.4: review-matches framing + copy-carry claim ───────────────────────

test("AC-018l.4 review-matches is framed as identity-match review, and the copy-carry claim is removed", () => {
  const c = read(KEEPING_ACCURATE);
  assert.ok(!c.includes("carry over the original's description"), "the copy-carries-description claim is removed");
  assert.ok(c.includes("identity"), "review-matches is described in identity terms");
  assert.ok(
    c.includes("does not repair descriptions") || c.includes("not for repairing descriptions"),
    "review-matches is explicitly not a description-repair tool",
  );
});

// ── AC-018l.5: one cost figure across overview.md, brooding-pipeline.md, README ─

test("AC-018l.5 the $3.05 first-scan cost is consistent and 'under $2' is gone", () => {
  const overview = read(PRIVATE_OVERVIEW);
  assert.ok(!/under \$2/i.test(overview), "overview.md no longer says 'under $2'");
  assert.ok(overview.includes("$3.05"), "overview.md carries the $3.05 figure");
  assert.ok(read(BROODING).includes("$3.05"), "brooding-pipeline.md carries the $3.05 figure");
  const readme = read("README.md");
  assert.ok(readme.includes("$3.05"), "README carries the $3.05 figure");
  assert.ok(!/under \$2/i.test(readme), "README does not say 'under $2'");
});

// ── AC-018l.6: AGENTS.md status block + layout tree ────────────────────────────

test("AC-018l.6 AGENTS.md names the shipped PRD range and lists the real src/ module dirs", () => {
  const c = read("AGENTS.md");
  assert.ok(c.includes("PRD-017"), "AGENTS.md names the shipped PRD-017");
  for (const dir of [
    "api/",
    "brooding/",
    "embeddings/",
    "enricher/",
    "hive-graph/",
    "portkey/",
    "projection/",
    "registration/",
    "service/",
    "telemetry/",
  ]) {
    assert.ok(c.includes(dir), `AGENTS.md layout tree lists ${dir}`);
  }
});

// ── AC-018l.7: README CLI/status accuracy ──────────────────────────────────────

test("AC-018l.7 README lists the working verbs, drops the not-ready list, and has no 'UNION ALL arm'", () => {
  const c = read("README.md");
  assert.ok(c.includes("nectar search"), "README lists search as working");
  assert.ok(c.includes("rebuild-projection"), "README lists rebuild-projection");
  assert.ok(c.includes("brood --dry-run"), "README lists brood --dry-run");
  assert.ok(!c.includes("are not ready"), "the 'verbs that are not ready' list is gone");
  assert.ok(!c.includes("UNION ALL arm"), "the 'UNION ALL arm' phrasing is gone (locked decision #2)");
});

// ── AC-018k.4: brood prerequisites documented ──────────────────────────────────

test("AC-018k.4 README and getting-started document the brood prerequisites", () => {
  for (const rel of ["README.md", GETTING_STARTED]) {
    const c = read(rel);
    assert.ok(c.includes("NECTAR_PORTKEY_ENABLED"), `${rel} names NECTAR_PORTKEY_ENABLED`);
    assert.ok(c.includes(".deeplake/credentials.json"), `${rel} names the ~/.deeplake/credentials.json prerequisite`);
  }
});

// ── AC-018k.5: brooding-pipeline auto-trigger reconciled with prerequisites ─────

test("AC-018k.5 brooding-pipeline.md reconciles the auto-trigger claim with the prerequisites", () => {
  const c = read(BROODING);
  assert.ok(c.includes("triggers automatically"), "the auto-trigger claim is present");
  assert.ok(c.includes("NECTAR_PORTKEY_ENABLED"), "the auto-trigger claim now states the Portkey prerequisite");
  assert.ok(c.includes(".deeplake/credentials.json"), "the auto-trigger claim now states the credentials prerequisite");
});

// ── AC-018l.21: no sha256- prefixed hash examples in portable-registry.md ───────

test("AC-018l.21 portable-registry.md has no sha256- prefixed hash examples", () => {
  assert.ok(!read(PORTABLE_REGISTRY).includes("sha256-"), "no sha256- prefixed hash examples remain in portable-registry.md");
});
