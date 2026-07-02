#!/usr/bin/env node
/**
 * The nectar CLI.
 *
 * `nectar daemon` is the runnable process (PRD-002c): it invokes the
 * composition root, acquires the single-instance lock before binding
 * 127.0.0.1:3854, serves `/health`, and installs SIGINT/SIGTERM handlers.
 *
 * The operational verbs exit non-zero with a clear notice rather than a silent
 * stub, in these shapes:
 *   - `brood` (PRD-007d): `--dry-run` runs a real local cost preview; a mutating
 *     brood dispatches daemon-side (PRD-008 build endpoint, a later wave).
 *   - `search` (PRD-012b): a thin loopback client of the daemon search endpoint
 *     (PRD-008b, a later wave); left unwired rather than importing the engine.
 *   - `prune` / `review-matches`: mechanics implemented and tested here
 *     (`runPrune` / `runReviewMatches`), but not yet wired to a durable,
 *     sync-capable hive-graph store (the NOT_WIRED map). They refuse to run
 *     against a throwaway empty store so a destructive verb never silently
 *     no-ops; the wiring lands with the daemon's registration-pipeline integration.
 *
 * `rebuild-projection` (and `project --rebuild-projection`) is wired REAL
 * (PRD-011c): it scans the durable Deep Lake store for the latest described
 * version per nectar scoped to the project and writes `.honeycomb/nectars.json`
 * atomically. It resolves org/workspace from the shared `~/.deeplake`
 * credentials the Deep Lake store already consumes and the project id + project
 * root from `NECTAR_PROJECT_ID` / `NECTAR_PROJECT_ROOT` (see USAGE).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assembleDaemon, type BootProjectionLoad } from "./daemon.js";
import { resolveConfig } from "./config.js";
import { createServiceModule, serviceStatus } from "./service/index.js";
import { registerWithDoctor } from "./doctor-registry.js";
import { emitInstalled, emitUninstalled, recordDaemonStart } from "./telemetry-usage/emit.js";
import type { Tenancy } from "./hive-graph/model.js";
import { DeepLakeHiveGraphStore } from "./hive-graph/deeplake-store.js";
import { InMemoryHiveGraphStore } from "./hive-graph/memory-store.js";
import { loadDeepLakeCredentials } from "./hive-graph/deeplake-credentials.js";
import { resolveProjectScope, type ProjectScopeSource } from "./hive-graph/project-scope.js";
import { createDiskRegistrationFs } from "./registration/disk-fs.js";
import { rebuildProjectionAsync, projectionFinalPath } from "./projection/write.js";
import { DEFAULT_PROJECTION_REL_PATH } from "./projection/format.js";
import type { InheritRow } from "./projection/inherit.js";
import {
  parseBroodArgs,
  planBrood,
  formatDryRunReport,
  discoverFiles,
  prepareFiles,
  type BroodConfig,
  type BroodRunOptions,
} from "./brooding/index.js";

const USAGE = `nectar - semantic memory layer over a source tree

Usage:
  nectar daemon                 Start the hiveantennae daemon (127.0.0.1:3854, /health)
  nectar install                Register the OS service unit + the doctor registry entry (PRD-003)
  nectar uninstall              Deregister the OS service unit (PRD-003b)
  nectar service-status         Report the OS service unit's running state (PRD-003b)
  nectar brood [flags]          Full-codebase brood (PRD-007). --dry-run previews cost locally;
                                a real brood executes daemon-side (PRD-008 build endpoint, Wave D).
                                Flags: --force, --limit N, --dry-run, --model <id>
  nectar search <query> [flags] Manual hive-graph search (PRD-012). Thin loopback client of the
                                daemon search endpoint (PRD-008b, Wave D). Flags: --limit N, --json
  nectar prune [--confirm]      Prune long-missing nectars     (logic implemented; durable wiring pending daemon integration)
  nectar review-matches         Review low-confidence matches  (logic implemented; durable wiring pending daemon integration)
  nectar rebuild-projection     Regenerate .honeycomb/nectars.json from Deep Lake (PRD-011)
  nectar project --rebuild-projection   Project-scoped regeneration of .honeycomb/nectars.json (PRD-011)
  nectar --help                 Show this help

rebuild-projection reads org_id/workspace_id from ~/.deeplake/credentials.json (the
shared file the Deep Lake store already uses). The project id resolves through the
per-project scope ladder (mirrors honeycomb's resolver, never requires honeycomb):
NECTAR_PROJECT_ID > detected HONEYCOMB_PROJECT_ID > ~/.deeplake/projects.json folder
binding (longest prefix) > git remote signal > the workspace __unsorted__ inbox.
The project root comes from NECTAR_PROJECT_ROOT (defaults to the current working
directory).
`;

/** The exec path the OS service unit will run (mirrors doctor's own CLI resolution). */
function resolveServiceExecPath(): string {
  return process.argv[1] ?? "nectar";
}

/** Opt into a system-scoped unit via env (mirrors doctor's DOCTOR_SERVICE_SYSTEM). */
function preferSystemScope(): boolean {
  return (process.env["NECTAR_SERVICE_SYSTEM"] ?? "") === "1";
}

/**
 * `nectar install` (PRD-003): lays down the OS service unit (003b) AND appends
 * nectar's entry to doctor's registry (003c) - the same installer performs
 * both, per PRD-003c's "no two-phase hazard" note. Does not restart doctor;
 * the registry entry takes effect at doctor's next natural boot.
 */
async function runInstall(): Promise<number> {
  const config = resolveConfig();
  const serviceModule = createServiceModule({
    execPath: resolveServiceExecPath(),
    preferSystemScope: preferSystemScope(),
  });

  const serviceResult = await serviceModule.install();
  process.stdout.write(`${serviceResult.message}\n`);

  try {
    const registration = registerWithDoctor({ config });
    const verb = registration.created ? "created" : registration.replaced ? "updated" : "appended to";
    process.stdout.write(
      `doctor registry ${verb} at ${registration.registryPath} (healthUrl ${registration.entry.healthUrl}). ` +
        "doctor will supervise nectar starting at its next boot.\n",
    );
  } catch (err) {
    process.stderr.write(
      `nectar install: could not update the doctor registry: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // Usage telemetry: fired only on full success, after the user-facing output.
  // emitInstalled never throws and is bounded, so it cannot alter the exit code.
  if (serviceResult.ok) {
    await emitInstalled();
  }

  return serviceResult.ok ? 0 : 1;
}

/** `nectar uninstall` (PRD-003b): deregisters the OS service unit so it does not resurrect. */
async function runUninstall(): Promise<number> {
  // Usage telemetry: fire BEFORE teardown (fire-and-forget) so the event has a
  // chance to leave while the service unit is being removed. Awaited only
  // after teardown completes; emitUninstalled never throws, so the uninstall
  // outcome and exit code are unaffected either way.
  const telemetryDone = emitUninstalled();
  const serviceModule = createServiceModule({
    execPath: resolveServiceExecPath(),
    preferSystemScope: preferSystemScope(),
  });
  const result = await serviceModule.uninstall();
  process.stdout.write(`${result.message}\n`);
  await telemetryDone;
  return result.ok ? 0 : 1;
}

/** `nectar service-status` (PRD-003b): reports the OS service manager's coarse state. */
async function runServiceStatus(): Promise<number> {
  const status = await serviceStatus({
    execPath: resolveServiceExecPath(),
    preferSystemScope: preferSystemScope(),
  });
  process.stdout.write(`${status}\n`);
  return status === "unknown" ? 1 : 0;
}

/** Read an env var, treating unset OR blank/whitespace-only as absent (mirrors config.ts). */
function cliEnvStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

/**
 * Resolve the tenancy triple + project root for the projection CLI verbs. org
 * and workspace come from the SAME `~/.deeplake/credentials.json` the Deep Lake
 * store consumes (`deeplake-credentials.ts`); the project id resolves through
 * the per-project scope ladder (`hive-graph/project-scope.ts`, mirroring
 * honeycomb's resolver across the process boundary): NECTAR_PROJECT_ID, then
 * the detected HONEYCOMB_PROJECT_ID, then the `~/.deeplake/projects.json`
 * folder binding (longest prefix), then the git-remote signal, then the
 * workspace `__unsorted__` inbox; the project root defaults to the current
 * working directory. Returns a typed error string instead of throwing so the
 * caller can print a clear notice and exit non-zero.
 */
function resolveProjectionContext():
  | {
      readonly ok: true;
      readonly tenancy: Tenancy;
      readonly projectRoot: string;
      readonly store: DeepLakeHiveGraphStore;
      readonly scopeSource: ProjectScopeSource;
    }
  | { readonly ok: false; readonly message: string } {
  let credentials;
  try {
    credentials = loadDeepLakeCredentials();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const projectRoot = cliEnvStr("NECTAR_PROJECT_ROOT") ?? process.cwd();
  const scope = resolveProjectScope({
    cwd: projectRoot,
    expect: { org: credentials.orgId, workspace: credentials.workspaceId },
  });

  const tenancy: Tenancy = {
    orgId: credentials.orgId,
    workspaceId: credentials.workspaceId,
    projectId: scope.projectId,
  };
  const store = new DeepLakeHiveGraphStore({ credentials });
  return { ok: true, tenancy, projectRoot, store, scopeSource: scope.source };
}

/**
 * `nectar rebuild-projection` / `nectar project --rebuild-projection`
 * (PRD-011c, trigger #3): a full regeneration of `.honeycomb/nectars.json` from
 * a single Deep Lake scan (latest described version per nectar, scoped to the
 * project), written atomically. Both verbs share this one routine.
 */
async function runRebuildProjection(): Promise<number> {
  const ctx = resolveProjectionContext();
  if (!ctx.ok) {
    process.stderr.write(
      `nectar rebuild-projection: ${ctx.message}.\n` +
        "org_id/workspace_id come from ~/.deeplake/credentials.json; the project id resolves via " +
        "NECTAR_PROJECT_ID > detected HONEYCOMB_PROJECT_ID > ~/.deeplake/projects.json binding > git remote signal > __unsorted__.\n",
    );
    return 1;
  }

  const { doc, path } = await rebuildProjectionAsync(ctx.store, ctx.tenancy, { projectRoot: ctx.projectRoot });
  const fileCount = Object.keys(doc.files).length;
  process.stdout.write(
    `nectar rebuild-projection: regenerated ${path} (${fileCount} nectar${fileCount === 1 ? "" : "s"}, ` +
      `project ${ctx.tenancy.orgId}/${ctx.tenancy.workspaceId}/${ctx.tenancy.projectId}, scope via ${ctx.scopeSource}).\n`,
  );
  return 0;
}

/**
 * The dispatch decision for `nectar brood <args>` (PRD-007d), factored out as a
 * pure function so the arg parsing + routing is unit-testable without the CLI's
 * process-level side effects.
 *
 * - `errors`  — a malformed flag (e.g. `--limit abc`); the CLI prints and exits 2.
 * - `dry-run` — `--dry-run`: a read-only local cost preview (no LLM call, no writes).
 * - `run`     — a mutating brood; executes daemon-side (see {@link runBroodCommand}).
 */
export type BroodInvocation =
  | { readonly kind: "errors"; readonly errors: readonly string[] }
  | { readonly kind: "dry-run"; readonly options: BroodRunOptions }
  | { readonly kind: "run"; readonly options: BroodRunOptions };

export function classifyBroodInvocation(broodArgs: readonly string[]): BroodInvocation {
  const parsed = parseBroodArgs(broodArgs);
  if (parsed.errors.length > 0) return { kind: "errors", errors: parsed.errors };
  if (parsed.options.dryRun === true) return { kind: "dry-run", options: parsed.options };
  return { kind: "run", options: parsed.options };
}

/**
 * `nectar brood --dry-run` (PRD-007d): a real, read-only cost preview run
 * locally via `planBrood` (discover -> pre-check -> bucket -> estimate), which
 * makes NO LLM call and writes NOTHING. Runs against a throwaway in-memory store
 * because the preview is `brooding-pipeline.md`'s "recommended first step on a
 * new project" where the durable store is empty; the projection-inherited count
 * still reads the on-disk `.honeycomb/nectars.json` faithfully. A daemon-side
 * dry-run reflecting live store state lands with the PRD-008 build endpoint.
 */
function runBroodDryRun(): number {
  const ctx = resolveProjectionContext();
  if (!ctx.ok) {
    process.stderr.write(
      `nectar brood --dry-run: ${ctx.message}.\n` +
        "org_id/workspace_id come from ~/.deeplake/credentials.json; the project id resolves via " +
        "NECTAR_PROJECT_ID > detected HONEYCOMB_PROJECT_ID > ~/.deeplake/projects.json binding > git remote signal > __unsorted__.\n",
    );
    return 1;
  }
  const config: BroodConfig = {
    store: new InMemoryHiveGraphStore(),
    tenancy: ctx.tenancy,
    root: ctx.projectRoot,
    fs: createDiskRegistrationFs(ctx.projectRoot),
  };
  const plan = planBrood(config);
  process.stdout.write(
    `${formatDryRunReport({
      discoveredCount: plan.discoveredCount,
      inheritedCount: plan.inheritedCount,
      skipBinaryCount: plan.skipBinaryCount,
      skipTooLargeCount: plan.skipTooLargeCount,
      batchFileCount: plan.batchFileCount,
      soloFileCount: plan.soloFileCount,
      batchCalls: plan.batchCalls,
      soloCalls: plan.soloCalls,
      estimate: plan.estimate,
    })}\n`,
  );
  return 0;
}

/**
 * `nectar brood [flags]` (PRD-007d). `--dry-run` runs the local cost preview; a
 * mutating brood executes daemon-side (PRD-007d "the brood mechanic executes
 * daemon-side; the CLI dispatches to it") through the PRD-008
 * `POST /api/hive-graph/build` endpoint, which lands in a later wave. A CLI-side
 * durable brood is additionally blocked by the sync/async store split
 * (`runBrood` needs the synchronous `HiveGraphStore`; the durable substrate is
 * async — the deferral documented on `AsyncHiveGraphStore`), so it is not
 * simulated against a throwaway store.
 */
function runBroodCommand(broodArgs: readonly string[]): number {
  const invocation = classifyBroodInvocation(broodArgs);
  switch (invocation.kind) {
    case "errors":
      for (const err of invocation.errors) process.stderr.write(`nectar brood: ${err}\n`);
      return 2;
    case "dry-run":
      return runBroodDryRun();
    case "run":
      process.stderr.write(
        "nectar brood: a mutating brood executes daemon-side (PRD-007d). It dispatches to the " +
          "daemon's POST /api/hive-graph/build endpoint (PRD-008), which lands in a later wave. " +
          "Use 'nectar brood --dry-run' for a local cost preview today.\n",
      );
      return 2;
    default: {
      const unreachable: never = invocation;
      return unreachable;
    }
  }
}


/**
 * Verbs whose command logic is implemented and tested here (`runPrune` /
 * `runReviewMatches`, the review store, the tenancy guards), but which are not
 * yet wired to a durable, sync-capable hive-graph store. The live daemon does
 * not instantiate the registration pipeline (a documented PRD-006a non-goal),
 * and the durable `DeepLakeHiveGraphStore` is async while `HiveGraphStore`
 * is sync (a bridge deferred in `store.ts`). Running these against a throwaway
 * empty in-memory store would make `prune --confirm` silently delete nothing and
 * `review-matches` silently drop every candidate, so instead they announce this
 * state and exit non-zero, exactly like the NOT_YET verbs. The wiring lands with
 * the daemon's registration-pipeline integration.
 */
const NOT_WIRED: Record<string, string> = {
  prune:
    "PRD-006 (prune mechanics implemented + tested in runPrune; durable-store wiring lands with the daemon's registration-pipeline integration)",
  "review-matches":
    "PRD-006 (review-matches mechanics implemented + tested in runReviewMatches; durable-store wiring lands with the daemon's registration-pipeline integration)",
};

/**
 * Build the boot projection load seam for the live daemon (PRD-011b AC-6): if a
 * project context resolves, the daemon validates `.honeycomb/nectars.json` on
 * boot and inherits hash-matched files into the durable Deep Lake store. All
 * work is deferred to lazy providers so nothing scans disk or hits the network
 * until AFTER the daemon is accepting requests; fail-soft throughout (a missing
 * credentials file just skips the pre-warm). Returns undefined when no context
 * resolves, so `nectar daemon` still starts on a bare machine.
 */
function resolveBootProjection(): BootProjectionLoad | undefined {
  const ctx = resolveProjectionContext();
  if (!ctx.ok) return undefined;
  const { store, tenancy, projectRoot } = ctx;
  return {
    tenancy,
    filePath: projectionFinalPath(projectRoot, DEFAULT_PROJECTION_REL_PATH),
    diskHashes: () => {
      const discovery = discoverFiles({ root: projectRoot, fs: createDiskRegistrationFs(projectRoot) });
      const prepared = prepareFiles(createDiskRegistrationFs(projectRoot), discovery.files);
      return new Map(prepared.map((p) => [p.file.relPath, p.contentHash] as const));
    },
    existingNectars: async () => {
      const latest = await store.listLatestVersions(tenancy);
      return new Set(latest.map((lv) => lv.identity.nectar));
    },
    write: async (rows: readonly InheritRow[]) => {
      for (const row of rows) {
        if ((await store.getIdentity(row.identity.nectar)) === undefined) {
          await store.insertIdentity(row.identity);
        }
        await store.appendVersion(row.version);
      }
    },
  };
}

async function runDaemon(): Promise<void> {
  let bootProjection: BootProjectionLoad | undefined;
  try {
    bootProjection = resolveBootProjection();
  } catch {
    // fail-soft: a boot pre-warm is best-effort and never blocks the daemon start.
    bootProjection = undefined;
  }
  const daemon = assembleDaemon(bootProjection !== undefined ? { bootProjection } : {});
  daemon.installSignalHandlers();
  const port = await daemon.start();
  process.stdout.write(
    `nectar daemon listening on http://${daemon.config.host}:${port}/health\n`,
  );
  // Usage telemetry: first_run (once per machine) + updated (on a version
  // change) fire AFTER a successful bind. Fire-and-forget: recordDaemonStart
  // never throws and the daemon does not wait on it.
  void recordDaemonStart();
  // Keep the process alive; shutdown is driven by SIGINT/SIGTERM.
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "daemon") {
    await runDaemon();
    return 0;
  }

  if (command === "install") {
    return runInstall();
  }

  if (command === "uninstall") {
    return runUninstall();
  }

  if (command === "service-status") {
    return runServiceStatus();
  }

  if (command === "rebuild-projection") {
    return runRebuildProjection();
  }

  if (command === "brood") {
    return runBroodCommand(argv.slice(1));
  }

  if (command === "search") {
    // PRD-012b (AC-012b.3.1): `nectar search` is a THIN loopback client that
    // reaches the daemon's POST /api/hive-graph/search endpoint and never imports
    // the engine or any Deep Lake path directly. That endpoint is owned by
    // PRD-008b, which lands in a later wave, so the verb is intentionally left
    // unwired rather than violating the thin-client posture by embedding the
    // engine in the CLI process.
    process.stderr.write(
      "nectar search: not yet wired. Per PRD-012b it is a thin loopback client of the daemon's " +
        "POST /api/hive-graph/search endpoint (PRD-008b), which lands in a later wave. It deliberately " +
        "does not import the search engine directly (AC-012b.3.1).\n",
    );
    return 2;
  }

  // `project` currently exposes only its `--rebuild-projection` flag (PRD-011c);
  // the broader project verb surface lands with a later PRD.
  if (command === "project") {
    const flags = argv.slice(1);
    if (flags.includes("--rebuild-projection")) {
      return runRebuildProjection();
    }
    process.stderr.write(
      "nectar project: only 'project --rebuild-projection' is implemented (PRD-011c).\n" +
        "The broader project verb surface lands with a later PRD.\n",
    );
    return 2;
  }

  const notWired = NOT_WIRED[command];
  if (notWired !== undefined) {
    process.stderr.write(
      `nectar ${command}: not yet wired to the durable store. ${notWired}.\n` +
        "The command logic is implemented and tested; it runs against real data once the daemon instantiates the registration pipeline. " +
        "Refusing to run against an empty in-memory store so a destructive verb never silently no-ops.\n",
    );
    return 2;
  }

  process.stderr.write(`nectar: unknown command '${command}'\n\n${USAGE}`);
  return 1;
}

export { main };

/** True when this module is the process entry point (`node dist/cli.js ...`), not an import. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Only drive the CLI when executed directly. Importing this module (e.g. from a
// test that exercises `classifyBroodInvocation`) must not run `main`.
if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
      // code 0 for `daemon` keeps the event loop alive via the open socket.
    })
    .catch((err) => {
      process.stderr.write(`nectar: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
