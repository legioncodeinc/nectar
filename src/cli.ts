#!/usr/bin/env node
/**
 * The hivenectar CLI.
 *
 * `hivenectar daemon` is the runnable process (PRD-002c): it invokes the
 * composition root, acquires the single-instance lock before binding
 * 127.0.0.1:3854, serves `/health`, and installs SIGINT/SIGTERM handlers.
 *
 * The operational verbs exit non-zero with a clear notice rather than a silent
 * stub, in two shapes:
 *   - `brood`: mechanics owned by a later PRD (007) and not yet implemented
 *     (the NOT_YET map).
 *   - `prune` / `review-matches`: mechanics implemented and tested here
 *     (`runPrune` / `runReviewMatches`), but not yet wired to a durable,
 *     sync-capable source-graph store (the NOT_WIRED map). They refuse to run
 *     against a throwaway empty store so a destructive verb never silently
 *     no-ops; the wiring lands with the daemon's registration-pipeline integration.
 *
 * `rebuild-projection` (and `project --rebuild-projection`) is wired REAL
 * (PRD-011c): it scans the durable Deep Lake store for the latest described
 * version per nectar scoped to the project and writes `.honeycomb/nectars.json`
 * atomically. It resolves org/workspace from the shared `~/.deeplake`
 * credentials the Deep Lake store already consumes and the project id + project
 * root from `HIVENECTAR_PROJECT_ID` / `HIVENECTAR_PROJECT_ROOT` (see USAGE).
 */
import { assembleDaemon } from "./daemon.js";
import { resolveConfig } from "./config.js";
import { createServiceModule, serviceStatus } from "./service/index.js";
import { registerWithHivedoctor } from "./hivedoctor-registry.js";
import { emitInstalled, emitUninstalled, recordDaemonStart } from "./telemetry-usage/emit.js";
import type { Tenancy } from "./source-graph/model.js";
import { DeepLakeSourceGraphStore } from "./source-graph/deeplake-store.js";
import { loadDeepLakeCredentials } from "./source-graph/deeplake-credentials.js";
import { rebuildProjectionAsync } from "./projection/write.js";

const USAGE = `hivenectar - semantic memory layer over a source tree

Usage:
  hivenectar daemon                 Start the hiveantennae daemon (127.0.0.1:3854, /health)
  hivenectar install                Register the OS service unit + the hivedoctor registry entry (PRD-003)
  hivenectar uninstall              Deregister the OS service unit (PRD-003b)
  hivenectar service-status         Report the OS service unit's running state (PRD-003b)
  hivenectar brood [flags]          Full-codebase brood            (owned by PRD-007)
  hivenectar prune [--confirm]      Prune long-missing nectars     (logic implemented; durable wiring pending daemon integration)
  hivenectar review-matches         Review low-confidence matches  (logic implemented; durable wiring pending daemon integration)
  hivenectar rebuild-projection     Regenerate .honeycomb/nectars.json from Deep Lake (PRD-011)
  hivenectar project --rebuild-projection   Project-scoped regeneration of .honeycomb/nectars.json (PRD-011)
  hivenectar --help                 Show this help

rebuild-projection reads org_id/workspace_id from ~/.deeplake/credentials.json (the
shared file the Deep Lake store already uses) and takes the project id from
HIVENECTAR_PROJECT_ID (required) and the project root from HIVENECTAR_PROJECT_ROOT
(defaults to the current working directory).
`;

/** The exec path the OS service unit will run (mirrors hivedoctor's own CLI resolution). */
function resolveServiceExecPath(): string {
  return process.argv[1] ?? "hivenectar";
}

/** Opt into a system-scoped unit via env (mirrors hivedoctor's HIVEDOCTOR_SERVICE_SYSTEM). */
function preferSystemScope(): boolean {
  return (process.env["HIVENECTAR_SERVICE_SYSTEM"] ?? "") === "1";
}

/**
 * `hivenectar install` (PRD-003): lays down the OS service unit (003b) AND appends
 * hivenectar's entry to hivedoctor's registry (003c) - the same installer performs
 * both, per PRD-003c's "no two-phase hazard" note. Does not restart hivedoctor;
 * the registry entry takes effect at hivedoctor's next natural boot.
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
    const registration = registerWithHivedoctor({ config });
    const verb = registration.created ? "created" : registration.replaced ? "updated" : "appended to";
    process.stdout.write(
      `hivedoctor registry ${verb} at ${registration.registryPath} (healthUrl ${registration.entry.healthUrl}). ` +
        "hivedoctor will supervise hivenectar starting at its next boot.\n",
    );
  } catch (err) {
    process.stderr.write(
      `hivenectar install: could not update the hivedoctor registry: ${err instanceof Error ? err.message : String(err)}\n`,
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

/** `hivenectar uninstall` (PRD-003b): deregisters the OS service unit so it does not resurrect. */
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

/** `hivenectar service-status` (PRD-003b): reports the OS service manager's coarse state. */
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
 * store consumes (`deeplake-credentials.ts`); the project id has no default
 * (there is no CLI-level project resolution yet, per the daemon PRDs) so it is
 * read from `HIVENECTAR_PROJECT_ID`; the project root defaults to the current
 * working directory. Returns a typed error string instead of throwing so the
 * caller can print a clear notice and exit non-zero.
 */
function resolveProjectionContext():
  | { readonly ok: true; readonly tenancy: Tenancy; readonly projectRoot: string; readonly store: DeepLakeSourceGraphStore }
  | { readonly ok: false; readonly message: string } {
  const projectId = cliEnvStr("HIVENECTAR_PROJECT_ID");
  if (projectId === undefined) {
    return { ok: false, message: "set HIVENECTAR_PROJECT_ID to the project id whose projection should be rebuilt" };
  }

  let credentials;
  try {
    credentials = loadDeepLakeCredentials();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const tenancy: Tenancy = {
    orgId: credentials.orgId,
    workspaceId: credentials.workspaceId,
    projectId,
  };
  const projectRoot = cliEnvStr("HIVENECTAR_PROJECT_ROOT") ?? process.cwd();
  const store = new DeepLakeSourceGraphStore({ credentials });
  return { ok: true, tenancy, projectRoot, store };
}

/**
 * `hivenectar rebuild-projection` / `hivenectar project --rebuild-projection`
 * (PRD-011c, trigger #3): a full regeneration of `.honeycomb/nectars.json` from
 * a single Deep Lake scan (latest described version per nectar, scoped to the
 * project), written atomically. Both verbs share this one routine.
 */
async function runRebuildProjection(): Promise<number> {
  const ctx = resolveProjectionContext();
  if (!ctx.ok) {
    process.stderr.write(
      `hivenectar rebuild-projection: ${ctx.message}.\n` +
        "org_id/workspace_id come from ~/.deeplake/credentials.json; set HIVENECTAR_PROJECT_ID (and optionally HIVENECTAR_PROJECT_ROOT).\n",
    );
    return 1;
  }

  const { doc, path } = await rebuildProjectionAsync(ctx.store, ctx.tenancy, { projectRoot: ctx.projectRoot });
  const fileCount = Object.keys(doc.files).length;
  process.stdout.write(
    `hivenectar rebuild-projection: regenerated ${path} (${fileCount} nectar${fileCount === 1 ? "" : "s"}, ` +
      `project ${ctx.tenancy.orgId}/${ctx.tenancy.workspaceId}/${ctx.tenancy.projectId}).\n`,
  );
  return 0;
}

/** Verbs whose mechanics are owned by not-yet-implemented PRDs. */
const NOT_YET: Record<string, string> = {
  brood: "PRD-007 (brooding pipeline)",
};

/**
 * Verbs whose command logic is implemented and tested here (`runPrune` /
 * `runReviewMatches`, the review store, the tenancy guards), but which are not
 * yet wired to a durable, sync-capable source-graph store. The live daemon does
 * not instantiate the registration pipeline (a documented PRD-006a non-goal),
 * and the durable `DeepLakeSourceGraphStore` is async while `SourceGraphStore`
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

async function runDaemon(): Promise<void> {
  const daemon = assembleDaemon();
  daemon.installSignalHandlers();
  const port = await daemon.start();
  process.stdout.write(
    `hivenectar daemon listening on http://${daemon.config.host}:${port}/health\n`,
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

  // `project` currently exposes only its `--rebuild-projection` flag (PRD-011c);
  // the broader project verb surface lands with a later PRD.
  if (command === "project") {
    const flags = argv.slice(1);
    if (flags.includes("--rebuild-projection")) {
      return runRebuildProjection();
    }
    process.stderr.write(
      "hivenectar project: only 'project --rebuild-projection' is implemented (PRD-011c).\n" +
        "The broader project verb surface lands with a later PRD.\n",
    );
    return 2;
  }

  const notWired = NOT_WIRED[command];
  if (notWired !== undefined) {
    process.stderr.write(
      `hivenectar ${command}: not yet wired to the durable store. ${notWired}.\n` +
        "The command logic is implemented and tested; it runs against real data once the daemon instantiates the registration pipeline. " +
        "Refusing to run against an empty in-memory store so a destructive verb never silently no-ops.\n",
    );
    return 2;
  }

  const owner = NOT_YET[command];
  if (owner !== undefined) {
    process.stderr.write(
      `hivenectar ${command}: not yet implemented. Its mechanics are owned by ${owner}.\n` +
        "The daemon itself ('hivenectar daemon') is implemented; this verb lands with its PRD.\n",
    );
    return 2;
  }

  process.stderr.write(`hivenectar: unknown command '${command}'\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
    // code 0 for `daemon` keeps the event loop alive via the open socket.
  })
  .catch((err) => {
    process.stderr.write(`hivenectar: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
