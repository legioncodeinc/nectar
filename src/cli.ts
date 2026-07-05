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
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { assembleDaemon, type AssembledDaemon, type AssembleOptions } from "./daemon.js";
import { resolveConfig } from "./config.js";
import { mountHiveGraphApi } from "./api/hive-graph-api.js";
import { buildHiveGraphApiOptions } from "./api/daemon-api-wiring.js";
import {
  searchViaDaemon,
  projectsViaDaemon,
  setBroodingViaDaemon,
  DaemonUnreachableError,
  DaemonSearchError,
} from "./api/loopback-client.js";
import type { ProjectsView } from "./projects-control.js";
import type { HiveGraphSearchResult, HiveGraphHit } from "./hive-graph/search-types.js";
import { createServiceModule, serviceStatus, type ServiceModule } from "./service/index.js";
import { registerWithDoctor, deregisterFromDoctor } from "./doctor-registry.js";
import { isLockHeldByLiveDaemon, readPidFile } from "./lock.js";
import { nectarStateDir } from "./apiary-root.js";
import { classifyFleet, fleetSignalLine } from "./fleet-detection.js";
import { runDeviceFlowLogin, type LoginFlags, type LoginResult, type LoginSeams } from "./auth/device-flow.js";
import {
  runStartLifecycle,
  runStopLifecycle,
  runUninstallLifecycle,
  removeStateDir,
  type StateDirRemovalResult,
} from "./lifecycle.js";
import { emitInstalled, emitUninstalled, recordDaemonStart } from "./telemetry-usage/emit.js";
import type { Tenancy } from "./hive-graph/model.js";
import type { HiveGraphStore, AsyncHiveGraphStore } from "./hive-graph/store.js";
import { DeepLakeHiveGraphStore } from "./hive-graph/deeplake-store.js";
import { InMemoryHiveGraphStore } from "./hive-graph/memory-store.js";
import { loadDeepLakeCredentials, credentialsPath } from "./hive-graph/deeplake-credentials.js";
import { LiveActiveProjects } from "./hive-graph/live-active-projects.js";
import { broodPrereqsFromEnv, formatFirstRunGuidance } from "./brood-prereqs.js";
import { resolveNectarTunables } from "./config-file.js";
import { resolveProjectScope, type ProjectScopeSource } from "./hive-graph/project-scope.js";
import { createDiskRegistrationFs } from "./registration/disk-fs.js";
import { createSharedIgnore, type IgnorePredicate } from "./registration/ignore.js";
import { createProjectContext } from "./registration/project-context.js";
import type { WatcherState } from "./registration/fs-watch.js";
import type { RunningContext } from "./project-supervisor.js";
import type { ResolvedProject } from "./hive-graph/active-projects.js";
import {
  readActiveProjects,
  buildProjectsView,
  persistProjectBrooding,
  persistGlobalBrooding,
  type ProjectsControlOptions,
} from "./projects-control.js";
import { broodingStatePath } from "./registration/brooding-state.js";
import { mountProjectsApi } from "./api/projects-api.js";
import { StoreBridge } from "./registration/store-bridge.js";
import { runPrune } from "./registration/prune-cli.js";
import { runReviewMatches, type ReviewDecision } from "./registration/review-cli.js";
import {
  FilePendingReviewStore,
  type PendingReviewStore,
  type PendingReviewCandidate,
} from "./registration/review-store.js";
import { resolveStateReadPath } from "./state-migration.js";
import { rebuildProjectionAsync, ProjectionWriter } from "./projection/write.js";
import { resolvePortkeyConfig, type PortkeyEnabled } from "./portkey/config.js";
import { activeEmbedModelId, resolveEmbeddingsConfig, validateEmbedDimension } from "./embeddings/config.js";
import { resolveEmbedProvider, type EmbedProvider } from "./embeddings/provider.js";
import { stderrDimRejectionSink } from "./embeddings/guard.js";
import { DeepLakeEnricherStore } from "./enricher/store-adapter.js";
import { createPriorContentCache } from "./enricher/content-cache.js";
import type { ContentReader } from "./enricher/index.js";
import type { PipelineMetricsSink } from "./telemetry/index.js";
import {
  parseBroodArgs,
  planBrood,
  formatDryRunReport,
  runBroodAsync,
  type BroodConfig,
  type BroodRunOptions,
  type AsyncBroodConfig,
  type AsyncBroodRuntimeDeps,
} from "./brooding/index.js";

const USAGE = `nectar - semantic memory layer over a source tree

Usage:
  nectar daemon                 Start the hiveantennae daemon in the foreground (127.0.0.1:3854, /health)
  nectar login [--org=<id>] [--workspace=<id>]
                                Sign in via the Deeplake device flow and write ~/.deeplake/credentials.json (PRD-003a)
  nectar install                Register the OS service unit + the doctor registry entry, and (solo, no
                                credentials) auto-open the sign-in popup (PRD-003)
  nectar start                  Start the daemon (via the OS service when registered, direct spawn otherwise) (PRD-003b)
  nectar stop                   Stop the daemon (OS service and/or a direct SIGTERM) (PRD-003b)
  nectar uninstall              Remove the OS service unit + the doctor registry entry + nectar's state dir (PRD-003b)
  nectar status                 Report the OS service unit's running state (alias: service-status) (PRD-003b)
  nectar service-status         Alias of 'nectar status' (PRD-003b)
  nectar brood [flags]          Full-codebase brood (PRD-007). --dry-run previews cost locally;
                                a mutating brood runs against the durable Deep Lake store (needs
                                Portkey configured). Flags: --force, --limit N, --dry-run, --model <id>
  nectar search <query> [flags] Manual hive-graph search (PRD-012). Thin loopback client of the
                                daemon search endpoint (POST /api/hive-graph/search). Requires a
                                running 'nectar daemon'. Flags: --limit N, --json
  nectar projects [--json]      List the active projects + brooding state (PRD-019). Thin loopback
                                client of GET /api/hive-graph/projects. Requires a running daemon.
  nectar brooding <on|off> [--project <id>|--all] [--global-pause|--global-resume]
                                Turn brooding on/off per project or globally (PRD-019). Thin loopback
                                client of POST /api/hive-graph/projects/brooding. Requires a running daemon.
  nectar prune [--confirm]      Prune long-missing nectars from the durable store (PRD-006d)
  nectar review-matches         Review low-confidence step-4 matches against the durable store (PRD-006d)
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

/** Build the OS service module the lifecycle verbs front (PRD-003b). */
function lifecycleServiceModule(): ServiceModule {
  return createServiceModule({ execPath: resolveServiceExecPath(), preferSystemScope: preferSystemScope() });
}

/** True when a live nectar daemon currently holds the lock (PRD-003b). */
function isDaemonRunning(): boolean {
  return isLockHeldByLiveDaemon(resolveConfig().lockFilePath);
}

/** The pid recorded in the pid file, or null (PRD-003b). */
function readDaemonPid(): number | null {
  return readPidFile(resolveConfig().pidFilePath);
}

/** Send a signal to a pid without throwing; returns true when delivered (PRD-003b). */
function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Directly spawn `nectar daemon` detached (the fallback when no OS unit is registered, PRD-003b b-AC-1). */
function spawnDaemonDetached(): number | null {
  try {
    const script = process.argv[1] ?? resolveServiceExecPath();
    const child = spawn(process.execPath, ["--experimental-sqlite", script, "daemon"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/** Remove nectar's resolved state dir under the fleet root, guarded (b-AC-4 / AC-8). */
function removeNectarStateDir(): StateDirRemovalResult {
  return removeStateDir(nectarStateDir(), {
    isAbsolute: (p) => isAbsolute(p),
    exists: (p) => existsSync(p),
    isSymlink: (p) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
    rm: (p) => rmSync(p, { recursive: true, force: true }),
  });
}

/** True when valid Deep Lake credentials currently resolve (a present-but-malformed file reads as absent). */
function credentialsPresent(): boolean {
  try {
    loadDeepLakeCredentials();
    return true;
  } catch {
    return false;
  }
}

/** Parse `--org`/`--workspace` (both `--flag value` and `--flag=value`) for `nectar login` (PRD-003a a-AC-5). */
export function parseLoginFlags(args: readonly string[]): { flags: LoginFlags; errors: readonly string[] } {
  const errors: string[] = [];
  let org: string | undefined;
  let workspace: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--org") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) errors.push("--org requires a value");
      else {
        org = v;
        i++;
      }
    } else if (arg.startsWith("--org=")) {
      org = arg.slice("--org=".length);
    } else if (arg === "--workspace") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) errors.push("--workspace requires a value");
      else {
        workspace = v;
        i++;
      }
    } else if (arg.startsWith("--workspace=")) {
      workspace = arg.slice("--workspace=".length);
    } else {
      errors.push(`unknown flag '${arg}'`);
    }
  }
  const flags: LoginFlags = {
    ...(org !== undefined ? { org } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
  };
  return { flags, errors };
}

/**
 * Run the device-flow login against the real seams (stdout output, a TTY-backed
 * question when interactive). Shared by `nectar login` and the `nectar install`
 * solo auto-popup. Closes the readline interface it opened. Never throws (the
 * flow returns a `LoginResult`).
 */
async function performLogin(flags: LoginFlags): Promise<LoginResult> {
  const isTTY = process.stdin.isTTY === true;
  const rl = isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const seams: LoginSeams = {
    out: (line: string) => process.stdout.write(`${line}\n`),
    isTTY,
    ...(rl !== undefined ? { question: (prompt: string) => rl.question(prompt) } : {}),
  };
  try {
    return await runDeviceFlowLogin(flags, seams);
  } finally {
    rl?.close();
  }
}

/** `nectar login` (PRD-003a a-AC-5): the device-flow sign-in verb, in both solo and fleet mode. */
async function runLogin(args: readonly string[]): Promise<number> {
  const { flags, errors } = parseLoginFlags(args);
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(`nectar login: ${err}\n`);
    return 2;
  }
  const result = await performLogin(flags);
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`${result.message}\n`);
  return 1;
}

/** `nectar start` (PRD-003b b-AC-1): front the OS unit, direct-spawn otherwise. */
async function runStart(): Promise<number> {
  return runStartLifecycle({
    service: lifecycleServiceModule(),
    isDaemonRunning,
    readPid: readDaemonPid,
    spawnDaemon: spawnDaemonDetached,
    io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
  });
}

/** `nectar stop` (PRD-003b b-AC-1): stop the OS unit and/or SIGTERM the running pid. */
async function runStop(): Promise<number> {
  return runStopLifecycle({
    service: lifecycleServiceModule(),
    isDaemonRunning,
    readPid: readDaemonPid,
    sendSignal,
    io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
  });
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

  // PRD-003a a-AC-3: the solo first-install auto-popup. Evaluate fleet detection
  // + credentials LIVE from the install verb (never from daemon boot): with hive
  // detected, defer to hive and open nothing; with credentials already present,
  // open nothing; solo with no credentials, auto-open the device-flow sign-in.
  // Best-effort - a sign-in that fails/times out never fails the install (the
  // daemon sits degraded and `nectar login` can finish it later).
  await maybeAutoLoginOnInstall();

  // Usage telemetry: fired only on full success, after the user-facing output.
  // emitInstalled never throws and is bounded, so it cannot alter the exit code.
  if (serviceResult.ok) {
    await emitInstalled();
  }

  return serviceResult.ok ? 0 : 1;
}

/**
 * The `nectar install` auto-popup decision (PRD-003a a-AC-3), factored out as a
 * pure function so the "open only when solo AND no credentials" rule is
 * unit-testable without the install verb's side effects.
 *   - fleet detected           -> `"defer-to-hive"` (never a popup).
 *   - solo + credentials exist  -> `"already-signed-in"` (no popup).
 *   - solo + no credentials     -> `"open-sign-in"` (auto-popup).
 */
export type InstallLoginAction = "defer-to-hive" | "already-signed-in" | "open-sign-in";
export function decideInstallLoginAction(fleetMode: "solo" | "fleet", hasCredentials: boolean): InstallLoginAction {
  if (fleetMode === "fleet") return "defer-to-hive";
  if (hasCredentials) return "already-signed-in";
  return "open-sign-in";
}

/**
 * The `nectar install` solo auto-popup decision (PRD-003a a-AC-3). Classifies
 * the machine solo-vs-fleet, logs which signals fired (a-AC-6), and only opens
 * the device-flow sign-in when solo AND no credentials exist. Fully best-effort:
 * any failure here is reported but never propagated so it cannot fail the install.
 */
async function maybeAutoLoginOnInstall(): Promise<void> {
  try {
    const classification = await classifyFleet();
    process.stdout.write(`nectar install: ${fleetSignalLine(classification)}\n`);
    const action = decideInstallLoginAction(classification.mode, credentialsPresent());
    if (action === "defer-to-hive") {
      process.stdout.write(
        "nectar install: hive detected; deferring sign-in to hive (no browser popup). " +
          "nectar reports degraded until hive-side login writes ~/.deeplake/credentials.json, then goes healthy without a restart.\n",
      );
      return;
    }
    if (action === "already-signed-in") {
      process.stdout.write("nectar install: credentials already present; no sign-in needed.\n");
      return;
    }
    process.stdout.write("nectar install: no hive detected and no credentials; starting sign-in...\n");
    const result = await performLogin({});
    process.stdout.write(`${result.message}\n`);
    if (!result.ok) {
      process.stdout.write("nectar install: sign-in did not complete; run 'nectar login' to finish it later.\n");
    }
  } catch (err) {
    process.stdout.write(
      `nectar install: could not evaluate sign-in (${err instanceof Error ? err.message : String(err)}); ` +
        "run 'nectar login' to sign in.\n",
    );
  }
}

/**
 * `nectar uninstall` (PRD-003b b-AC-2/3/4/6): the three-part contract - stop the
 * daemon, remove the OS service unit (current + legacy), delete nectar's doctor
 * registry entry, and remove nectar's state dir - each best-effort with a
 * per-step report. A not-installed machine exits 0 "nothing to remove".
 */
async function runUninstall(): Promise<number> {
  const code = await runUninstallLifecycle({
    service: lifecycleServiceModule(),
    isDaemonRunning,
    readPid: readDaemonPid,
    sendSignal,
    deregisterFromDoctor: () => deregisterFromDoctor(),
    removeStateDir: removeNectarStateDir,
    io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
  });
  // Usage telemetry (NEC-042 item 4 / AC-018l.11): fire only on a clean uninstall.
  // emitUninstalled never throws and is bounded, so it cannot alter the exit code.
  if (code === 0) await emitUninstalled();
  return code;
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

/**
 * PRD-019d: build the ONE shared ignore predicate (segments UNION graph-ignore
 * UNION gitignore semantics, with the git-absent `.gitignore` parser fallback)
 * for a CLI command's resolved root, so every CLI discovery path excludes
 * exactly the set the daemon watch path does - including on a non-git root.
 */
function sharedIgnoreFor(root: string): IgnorePredicate {
  return createSharedIgnore(root).isIgnored;
}

/** Read a running project's watcher liveness off the daemon's `/health` active-projects slice (PRD-019b view). */
function daemonWatcherState(daemon: AssembledDaemon, projectId: string): WatcherState {
  const entry = daemon.health.snapshot().activeProjects.projects.find((p) => p.projectId === projectId);
  return (entry?.watcher ?? "stopped") as WatcherState;
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
      readonly credentials: ReturnType<typeof loadDeepLakeCredentials>;
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
  return { ok: true, tenancy, projectRoot, store, scopeSource: scope.source, credentials };
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
  const isIgnored = sharedIgnoreFor(ctx.projectRoot);
  const config: BroodConfig = {
    store: new InMemoryHiveGraphStore(),
    tenancy: ctx.tenancy,
    root: ctx.projectRoot,
    isIgnored,
    fs: createDiskRegistrationFs(ctx.projectRoot, isIgnored),
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
      // PRD-018c AC-018c.11: report the discovery source and, when git errored
      // (not simply absent), the degradation reason.
      source: plan.source,
      ...(plan.degraded !== undefined ? { degraded: plan.degraded } : {}),
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
async function runBroodCommand(broodArgs: readonly string[]): Promise<number> {
  const invocation = classifyBroodInvocation(broodArgs);
  switch (invocation.kind) {
    case "errors":
      for (const err of invocation.errors) process.stderr.write(`nectar brood: ${err}\n`);
      return 2;
    case "dry-run":
      return runBroodDryRun();
    case "run":
      return runBroodMutating(invocation.options);
    default: {
      const unreachable: never = invocation;
      return unreachable;
    }
  }
}

// ── PRD-018b: the durable, testable verb runners (brood/prune/review-matches) ──
// These take an already-resolved store + io so they are unit-testable against an
// injected store (AC-018b.8), while the process wrappers below resolve the real
// Deep Lake context, bridge the sync/async gap, and flush.

/** Deps for {@link runBroodMutatingVerb}: the durable async store + the brood seams. */
export interface BroodMutatingVerbDeps {
  readonly config: AsyncBroodConfig;
  readonly deps: AsyncBroodRuntimeDeps;
  readonly options?: BroodRunOptions;
  out(line: string): void;
}

/**
 * Run a mutating brood against the durable async store (AC-018b.8): `runBroodAsync`
 * discovers, mints, describes, and persists to Deep Lake directly (it consumes the
 * async store, so no sync/async bridge is needed here). Returns 0 on success.
 */
export async function runBroodMutatingVerb(d: BroodMutatingVerbDeps): Promise<number> {
  const result = await runBroodAsync(d.config, d.deps, d.options ?? {});
  d.out(
    `nectar brood: discovered ${result.discoveredCount} file(s); ` +
      `${result.describedCount} described, ${result.failedCount} failed` +
      `${result.projectionPath !== null ? `; projection ${result.projectionPath}` : ""}.`,
  );
  return 0;
}

/** Deps for {@link runPruneVerb}: any sync store (the bridge in prod, an in-memory store in tests). */
export interface PruneVerbDeps {
  readonly store: HiveGraphStore;
  readonly tenancy: Tenancy;
  existsOnDisk(relPath: string): boolean;
  readonly confirm: boolean;
  out(line: string): void;
  now?(): string;
}

/** Run `prune` (preview or `--confirm` delete) against the injected store (AC-018b.8). Returns 0. */
export function runPruneVerb(deps: PruneVerbDeps): number {
  runPrune({
    store: deps.store,
    tenancy: deps.tenancy,
    existsOnDisk: (p) => deps.existsOnDisk(p),
    now: deps.now ?? (() => new Date().toISOString()),
    confirm: deps.confirm,
    out: deps.out,
  });
  return 0;
}

/** Deps for {@link runReviewMatchesVerb}: any sync store + the pending-review queue + a decider. */
export interface ReviewMatchesVerbDeps {
  readonly store: HiveGraphStore;
  readonly tenancy: Tenancy;
  readonly pendingReviews: PendingReviewStore;
  decide(candidate: PendingReviewCandidate, preview: string): Promise<ReviewDecision> | ReviewDecision;
  out(line: string): void;
  now?(): string;
}

/** Run `review-matches` against the injected store (AC-018b.8). Returns 0. */
export async function runReviewMatchesVerb(deps: ReviewMatchesVerbDeps): Promise<number> {
  await runReviewMatches({
    store: deps.store,
    tenancy: deps.tenancy,
    pendingReviews: deps.pendingReviews,
    decide: deps.decide,
    out: deps.out,
    now: deps.now ?? (() => new Date().toISOString()),
  });
  return 0;
}

/**
 * The interactive review decider's IO seam (CodeRabbit PR-18 finding #6):
 * factored out of {@link interactiveReviewDecider} so a test can drive it with
 * a fake `question`/`write` pair instead of real stdin/stdout, and so the
 * decider is self-contained (it prints its own context rather than relying on
 * a caller having already done so earlier in the same loop iteration).
 */
export interface InteractiveReviewIo {
  /** True for a real TTY; a non-TTY input defaults every candidate to `skip`. */
  readonly isTTY: boolean;
  /** Ask the accept/reject/skip question and resolve with the raw answer. */
  question(prompt: string): Promise<string>;
  /** Write one line of context (the preview) before asking. */
  write(line: string): void;
  /** Release any resources the IO holds (e.g. a readline interface on stdin). */
  close(): void;
}

/** The real stdin/stdout-backed {@link InteractiveReviewIo}. */
function realInteractiveReviewIo(): InteractiveReviewIo {
  const isTTY = process.stdin.isTTY === true;
  if (!isTTY) {
    return { isTTY, question: async () => "", write: () => {}, close: () => {} };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    isTTY,
    question: (prompt) => rl.question(prompt),
    write: (line) => process.stdout.write(`${line}\n`),
    close: () => rl.close(),
  };
}

/**
 * A stdin-driven per-candidate decider for the interactive `review-matches`
 * prompt. On a non-TTY stdin (a script, CI) it defaults every candidate to
 * `skip` (the safe, non-destructive choice) rather than blocking on input; a
 * real TTY gets the preview printed, then an accept/reject/skip prompt.
 * Returns a `close` so the caller releases stdin (otherwise the readline
 * interface would keep the process alive).
 *
 * CodeRabbit PR-18 finding #6: the prior implementation's `decide` ignored its
 * `candidate`/`preview` parameters entirely, so on its own it asked
 * accept/reject/skip with zero printed context. `runReviewMatches`
 * (`review-cli.ts`) happens to print the same preview via `out()` immediately
 * before calling `decide` today, but `decide` should not depend on that
 * caller-side ordering to be usable - it prints the preview itself now.
 */
export function interactiveReviewDecider(
  io: InteractiveReviewIo = realInteractiveReviewIo(),
): {
  decide: (candidate: PendingReviewCandidate, preview: string) => Promise<ReviewDecision>;
  close: () => void;
} {
  if (!io.isTTY) {
    return { decide: async () => "skip", close: io.close };
  }
  return {
    decide: async (_candidate, preview) => {
      io.write(preview);
      const answer = (await io.question("  [a]ccept / [r]eject / [s]kip? ")).trim().toLowerCase();
      if (answer === "a" || answer === "accept") return "accept";
      if (answer === "r" || answer === "reject") return "reject";
      return "skip";
    },
    close: io.close,
  };
}

/**
 * Resolve the embed provider + its active embed model id for the CLI's
 * mutating brood deps, the same way the daemon wiring does
 * (`api/daemon-api-wiring.ts`'s `activeEmbedModel`) - CodeRabbit PR-18 finding
 * #7. Exported so the resolution itself (independent of the live Deep Lake
 * context `runBroodMutating` also needs) is unit-testable without network
 * credentials: without threading `embedModelId` through, CLI-brooded rows
 * stamped `embed_model = null` and were never requeued on a provider switch
 * (AC-018i.3).
 */
export function resolveCliBroodEmbedDeps(): { embedProvider: EmbedProvider; embedModelId: string | null } {
  const embeddingsConfig = resolveEmbeddingsConfig({});
  return {
    embedProvider: resolveEmbedProvider(embeddingsConfig),
    embedModelId: activeEmbedModelId(embeddingsConfig),
  };
}

/**
 * `nectar brood` (mutating, PRD-018b AC-018b.8): resolve the Deep Lake context,
 * require a Portkey describe transport (an LLM-less brood cannot describe), and
 * run the real `runBroodAsync` against the durable store. Exits 1 (a real error,
 * not a wiring stub) when credentials or Portkey are absent.
 */
async function runBroodMutating(options: BroodRunOptions): Promise<number> {
  const ctx = resolveProjectionContext();
  if (!ctx.ok) {
    process.stderr.write(
      `nectar brood: ${ctx.message}.\n` +
        "org_id/workspace_id come from ~/.deeplake/credentials.json; the project id resolves via " +
        "NECTAR_PROJECT_ID > detected HONEYCOMB_PROJECT_ID > ~/.deeplake/projects.json binding > git remote signal > __unsorted__.\n",
    );
    return 1;
  }
  const portkey = resolvePortkeyConfig();
  if (!portkey.enabled) {
    process.stderr.write(
      "nectar brood: a mutating brood needs a describe transport. Configure Portkey " +
        "(PORTKEY_API_KEY + PORTKEY_CONFIG) and retry, or use 'nectar brood --dry-run' for a local cost preview.\n",
    );
    return 1;
  }
  const { embedProvider, embedModelId } = resolveCliBroodEmbedDeps();
  const isIgnored = sharedIgnoreFor(ctx.projectRoot);
  return runBroodMutatingVerb({
    config: {
      store: ctx.store,
      tenancy: ctx.tenancy,
      root: ctx.projectRoot,
      isIgnored,
      fs: createDiskRegistrationFs(ctx.projectRoot, isIgnored),
    },
    deps: { portkey, embedProvider, embedModelId },
    options,
    out: (line) => process.stdout.write(`${line}\n`),
  });
}

/**
 * Build a {@link StoreBridge} over the resolved durable store, hydrate it, run
 * `body` against the SYNC bridge (so the tested `runPrune`/`runReviewMatches`
 * mechanics run unchanged), then flush the durable writes. Returns the body's
 * exit code, or 1 with a printed notice when no Deep Lake context resolves.
 */
async function withDurableBridge(
  purpose: string,
  body: (bridge: StoreBridge, ctx: ResolvedContext) => Promise<number>,
): Promise<number> {
  const ctx = resolveProjectionContext();
  if (!ctx.ok) {
    process.stderr.write(
      `nectar ${purpose}: ${ctx.message}.\n` +
        "org_id/workspace_id come from ~/.deeplake/credentials.json; the project id resolves via " +
        "NECTAR_PROJECT_ID > detected HONEYCOMB_PROJECT_ID > ~/.deeplake/projects.json binding > git remote signal > __unsorted__.\n",
    );
    return 1;
  }
  const bridge = new StoreBridge({
    durable: ctx.store,
    onFlushError: (err, op) =>
      process.stderr.write(
        `nectar ${purpose}: durable ${op} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
      ),
  });
  await bridge.hydrate(ctx.tenancy);
  const code = await body(bridge, ctx);
  await bridge.whenFlushed();
  if (bridge.durableFlushFailures > 0) {
    process.stderr.write(
      `nectar ${purpose}: ${bridge.durableFlushFailures} durable write(s) failed to flush; ` +
        "the local result above is applied but Deep Lake may be behind. Re-run once connectivity is restored.\n",
    );
    return 1;
  }
  return code;
}

/**
 * `nectar prune [--confirm]` (PRD-018b AC-018b.8): the real `runPrune` mechanic
 * against the durable store through the sync/async bridge.
 */
async function runPruneCommand(args: readonly string[]): Promise<number> {
  const confirm = args.includes("--confirm");
  return withDurableBridge("prune", async (bridge, ctx) => {
    const fs = createDiskRegistrationFs(ctx.projectRoot, sharedIgnoreFor(ctx.projectRoot));
    return runPruneVerb({
      store: bridge,
      tenancy: ctx.tenancy,
      existsOnDisk: (p) => fs.existsOnDisk(p),
      confirm,
      out: (line) => process.stdout.write(`${line}\n`),
    });
  });
}

/**
 * `nectar review-matches` (PRD-018b AC-018b.8): the real `runReviewMatches`
 * mechanic against the durable store through the sync/async bridge, reading the
 * same file-backed pending-review queue the daemon writes.
 */
async function runReviewMatchesCommand(): Promise<number> {
  const config = resolveConfig();
  const hasRuntimeDirOverride = (process.env["NECTAR_RUNTIME_DIR"] ?? "").trim() !== "";
  const reviewsPath = hasRuntimeDirOverride
    ? join(config.runtimeDir, "pending-reviews.json")
    : resolveStateReadPath("pending-reviews.json", { runtimeDir: config.runtimeDir });
  const reviews = new FilePendingReviewStore(reviewsPath);
  const decider = interactiveReviewDecider();
  try {
    return await withDurableBridge("review-matches", (bridge, ctx) =>
      runReviewMatchesVerb({
        store: bridge,
        tenancy: ctx.tenancy,
        pendingReviews: reviews,
        decide: decider.decide,
        out: (line) => process.stdout.write(`${line}\n`),
      }),
    );
  } finally {
    decider.close();
  }
}


/**
 * The parsed `nectar search` invocation (PRD-012b). Factored out as a pure
 * function so the flag grammar is unit-testable without the CLI's process-level
 * side effects, mirroring {@link classifyBroodInvocation}.
 */
export type SearchInvocation =
  | { readonly kind: "errors"; readonly errors: readonly string[] }
  | { readonly kind: "run"; readonly query: string; readonly limit: number | undefined; readonly json: boolean };

/**
 * Parse `nectar search <query> [--limit N] [--json]`. The positional
 * (non-flag) tokens join into the query; `--limit N`/`--limit=N` sets the cap
 * (a non-positive-integer value is an error); `--json` emits raw JSON. A
 * missing query or an unknown flag is an error.
 */
export function parseSearchArgs(args: readonly string[]): SearchInvocation {
  const errors: string[] = [];
  const queryParts: string[] = [];
  let limit: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") {
      json = true;
    } else if (arg === "--limit") {
      const raw = args[i + 1];
      if (raw === undefined) {
        errors.push("--limit requires a value");
      } else {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1 || String(n) !== raw) errors.push(`--limit expects a positive integer, got '${raw}'`);
        else limit = n;
        i++;
      }
    } else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || String(n) !== raw) errors.push(`--limit expects a positive integer, got '${raw}'`);
      else limit = n;
    } else if (arg.startsWith("--")) {
      errors.push(`unknown flag '${arg}'`);
    } else {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(" ").trim();
  if (query === "") errors.push("a query is required: nectar search <query> [--limit N] [--json]");
  if (errors.length > 0) return { kind: "errors", errors };
  return { kind: "run", query, limit, json };
}

/** Truncate a one-line preview of a description for the human table. */
function truncateCell(value: string, max = 72): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}\u2026`;
}

/** Render the engine result as a human-readable ranked table (default, non-`--json`). */
export function renderSearchTable(result: HiveGraphSearchResult): string {
  const lines: string[] = [];
  if (result.hits.length === 0) {
    lines.push("No matching files.");
  } else {
    lines.push(`${result.hits.length} result${result.hits.length === 1 ? "" : "s"}:`);
    result.hits.forEach((hit: HiveGraphHit, index: number) => {
      lines.push(`  ${index + 1}. ${hit.path}`);
      if (hit.title.trim() !== "") lines.push(`     ${truncateCell(hit.title)}`);
      if (hit.body.trim() !== "") lines.push(`     ${truncateCell(hit.body)}`);
    });
  }
  if (result.degraded) {
    lines.push("");
    if (result.reason === "backend-error") {
      lines.push("(degraded: one or more search backends failed; use --json for arm status)");
    } else {
      lines.push("(degraded: semantic search did not run; results are lexical-only)");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `nectar search <query> [--limit N] [--json]` (PRD-012b): a THIN loopback
 * client of the daemon's `POST /api/hive-graph/search` endpoint (PRD-008b). It
 * never imports the search engine or any Deep Lake path (AC-012b.3.1) — it only
 * reaches the running daemon over loopback. When the daemon is not running the
 * connection failure is reported clearly and the verb exits non-zero with NO
 * local fallback (AC-012b.3.2).
 */
async function runSearchCommand(args: readonly string[]): Promise<number> {
  const invocation = parseSearchArgs(args);
  if (invocation.kind === "errors") {
    for (const err of invocation.errors) process.stderr.write(`nectar search: ${err}\n`);
    return 2;
  }

  const config = resolveConfig();
  try {
    const result = await searchViaDaemon({
      host: config.host,
      port: config.port,
      query: invocation.query,
      limit: invocation.limit,
    });
    if (invocation.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(renderSearchTable(result));
    return 0;
  } catch (err: unknown) {
    if (err instanceof DaemonUnreachableError) {
      process.stderr.write(
        `nectar search: the nectar daemon is not reachable on ${config.host}:${config.port} (${err.message}).\n` +
          "Start it with 'nectar daemon'. Search reaches the running daemon over loopback and does not fall back to a local index.\n",
      );
      return 2;
    }
    if (err instanceof DaemonSearchError) {
      process.stderr.write(`nectar search: the daemon rejected the search: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`nectar search: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ── PRD-019b: `nectar projects` + `nectar brooding` ─────────────────────────

/** Render the projects view as a human-readable table (default, non-`--json`). */
export function renderProjectsTable(view: ProjectsView): string {
  const lines: string[] = [];
  lines.push(`global brooding: ${view.globalBrooding}`);
  if (view.projects.length === 0) {
    lines.push("No active projects. Add one by selecting a directory in the Hive dashboard.");
  } else {
    lines.push(`${view.projects.length} project${view.projects.length === 1 ? "" : "s"}:`);
    for (const p of view.projects) {
      const label = p.name.trim() !== "" ? `${p.name} (${p.projectId})` : p.projectId;
      lines.push(`  - ${label}`);
      lines.push(`      path: ${p.path}`);
      lines.push(`      brooding: ${p.brooding}   watcher: ${p.watcher}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** `nectar projects [--json]`: the read side of `GET /api/hive-graph/projects`. */
async function runProjectsCommand(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const config = resolveConfig();
  try {
    const view = await projectsViaDaemon({ host: config.host, port: config.port });
    if (json) process.stdout.write(`${JSON.stringify(view)}\n`);
    else process.stdout.write(renderProjectsTable(view));
    return 0;
  } catch (err: unknown) {
    if (err instanceof DaemonUnreachableError) {
      process.stderr.write(
        `nectar projects: the nectar daemon is not reachable on ${config.host}:${config.port} (${err.message}).\n` +
          "Start it with 'nectar daemon'.\n",
      );
      return 2;
    }
    process.stderr.write(`nectar projects: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** The parsed `nectar brooding` invocation (PRD-019b). */
export type BroodingInvocation =
  | { readonly kind: "errors"; readonly errors: readonly string[] }
  | { readonly kind: "global"; readonly global: "on" | "paused" }
  | { readonly kind: "project"; readonly projectId: string; readonly brooding: "on" | "off" }
  | { readonly kind: "all"; readonly brooding: "on" | "off" };

/**
 * Parse `nectar brooding <on|off> [--project <id>|--all]` and the global flags
 * `--global-pause` / `--global-resume`. The global flags are standalone (no
 * on|off positional); the on|off form requires exactly one of `--project <id>`
 * or `--all`.
 */
export function parseBroodingArgs(args: readonly string[]): BroodingInvocation {
  const errors: string[] = [];
  let positional: string | undefined;
  let projectId: string | undefined;
  let all = false;
  let globalPause = false;
  let globalResume = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--all") {
      all = true;
    } else if (arg === "--global-pause") {
      globalPause = true;
    } else if (arg === "--global-resume") {
      globalResume = true;
    } else if (arg === "--project") {
      const raw = args[i + 1];
      if (raw === undefined || raw.startsWith("--")) errors.push("--project requires a value");
      else {
        projectId = raw;
        i++;
      }
    } else if (arg.startsWith("--project=")) {
      projectId = arg.slice("--project=".length);
    } else if (arg.startsWith("--")) {
      errors.push(`unknown flag '${arg}'`);
    } else if (positional === undefined) {
      positional = arg;
    } else {
      errors.push(`unexpected argument '${arg}'`);
    }
  }

  if (globalPause && globalResume) errors.push("use only one of --global-pause / --global-resume");
  const isGlobal = globalPause || globalResume;

  if (isGlobal) {
    if (positional !== undefined) errors.push("the global flags do not take an on|off argument");
    if (projectId !== undefined || all) errors.push("the global flags cannot combine with --project / --all");
    if (errors.length > 0) return { kind: "errors", errors };
    return { kind: "global", global: globalPause ? "paused" : "on" };
  }

  if (positional !== "on" && positional !== "off") {
    errors.push("expected 'on' or 'off': nectar brooding <on|off> [--project <id>|--all]");
  }
  if (projectId !== undefined && all) errors.push("use only one of --project / --all");
  if (projectId === undefined && !all) errors.push("specify --project <id> or --all");
  if (errors.length > 0) return { kind: "errors", errors };

  const brooding = positional as "on" | "off";
  if (all) return { kind: "all", brooding };
  return { kind: "project", projectId: projectId as string, brooding };
}

/** `nectar brooding ...`: the write side of `POST /api/hive-graph/projects/brooding`. */
async function runBroodingCommand(args: readonly string[]): Promise<number> {
  const invocation = parseBroodingArgs(args);
  if (invocation.kind === "errors") {
    for (const err of invocation.errors) process.stderr.write(`nectar brooding: ${err}\n`);
    return 2;
  }
  const config = resolveConfig();
  const target = { host: config.host, port: config.port };
  try {
    let view: ProjectsView;
    if (invocation.kind === "global") {
      view = await setBroodingViaDaemon(target, { global: invocation.global });
    } else if (invocation.kind === "project") {
      view = await setBroodingViaDaemon(target, { projectId: invocation.projectId, brooding: invocation.brooding });
    } else {
      // --all: set every currently-bound project to the requested state.
      const current = await projectsViaDaemon(target);
      view = current;
      for (const p of current.projects) {
        view = await setBroodingViaDaemon(target, { projectId: p.projectId, brooding: invocation.brooding });
      }
    }
    process.stdout.write(renderProjectsTable(view));
    return 0;
  } catch (err: unknown) {
    if (err instanceof DaemonUnreachableError) {
      process.stderr.write(
        `nectar brooding: the nectar daemon is not reachable on ${config.host}:${config.port} (${err.message}).\n` +
          "Start it with 'nectar daemon'.\n",
      );
      return 2;
    }
    process.stderr.write(`nectar brooding: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// The single-root `resolveBootProjection` boot pre-warm was removed with the
// PRD-019a multi-root rewire: the PRD-011b projection load + inherit now runs
// PER PROJECT inside `createProjectContext.start()` (`registration/project-context.ts`),
// so each activated root validates its own `.honeycomb/nectars.json`.

/** The resolved-and-ok shape of {@link resolveProjectionContext}. */
type ResolvedContext = Extract<ReturnType<typeof resolveProjectionContext>, { readonly ok: true }>;

/** A metrics sink that delegates to the daemon's CURRENT telemetry (fresh per start()), for the live build brood path. */
function daemonMetricsProxy(daemon: AssembledDaemon): PipelineMetricsSink {
  return {
    incrementFilesRegistered: () => daemon.telemetry().metrics.incrementFilesRegistered(),
    incrementNectarsMinted: () => daemon.telemetry().metrics.incrementNectarsMinted(),
    incrementDescriptionsGenerated: () => daemon.telemetry().metrics.incrementDescriptionsGenerated(),
    incrementHiveGraphVersions: () => daemon.telemetry().metrics.incrementHiveGraphVersions(),
    incrementEmbeddingsComputed: () => daemon.telemetry().metrics.incrementEmbeddingsComputed(),
  };
}

/** The live durable brood/enrich seams built when Deep Lake creds + Portkey both resolve. */
interface LiveDurableWiring {
  readonly portkey: PortkeyEnabled;
  readonly enricher: DeepLakeEnricherStore;
  readonly readContent: ContentReader;
}

/**
 * Build the durable enricher store (hydrated per-nectar-latest from the async
 * store, write-through UPDATEs over the daemon's transport) and a disk content
 * reader for the live enricher cycle. `AsyncHiveGraphStore` exposes only
 * latest-per-nectar reads, so hydration seeds the enricher's pending-selection
 * working set from `listLatestVersions`; per-nectar history (cosmetic-inherit's
 * `priorDescribedVersion`) is not carried across a cold boot, so that step
 * degrades to a fresh describe rather than an inherit (documented, honest).
 */
function buildLiveDurableWiring(
  ctx: ResolvedContext,
  portkey: PortkeyEnabled,
): LiveDurableWiring {
  const fs = createDiskRegistrationFs(ctx.projectRoot, sharedIgnoreFor(ctx.projectRoot));
  const readContent: ContentReader = {
    read: (path: string): string | null => {
      const stat = fs.statPath(path);
      if (stat === null) return null;
      try {
        return Buffer.from(stat.readContent()).toString("utf8");
      } catch {
        return null;
      }
    },
  };
  // PRD-018g / NEC-017: the durable write-back is a collision-safe VERSION-BUMP
  // APPEND (`appendVersionAtNextSeq`), not the retired fire-and-forget in-place
  // UPDATE. The cycle awaits it and only counts a file described on a confirmed
  // durable write.
  const enricher = new DeepLakeEnricherStore({
    loadVersions: async (tenancy) => (await ctx.store.listLatestVersions(tenancy)).map((lv) => lv.version),
    appendVersion: (row) => ctx.store.appendVersionAtNextSeq(row),
    onWriteBackError: (err: unknown) => {
      process.stderr.write(
        `nectar enricher: durable write-back failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    },
  });
  return { portkey, enricher, readContent };
}

async function runDaemon(): Promise<void> {
  const portkey = resolvePortkeyConfig();
  const embeddingsConfig = resolveEmbeddingsConfig({});
  // AC-018i.7: catch a wrong NECTAR_EMBEDDINGS_OUTPUT_DIMENSION at config
  // resolution and warn loudly rather than silently nulling every hosted vector.
  const dimCheck = validateEmbedDimension(embeddingsConfig);
  if (!dimCheck.ok) process.stderr.write(`nectar daemon: ${dimCheck.message ?? "invalid embedding output dimension"}\n`);
  // AC-018i.8: wire the dim-rejection sink at the daemon-path resolveEmbedProvider
  // call site (the API path wires it separately in daemon-api-wiring).
  const embedProvider: EmbedProvider = resolveEmbedProvider(embeddingsConfig, {
    onDimRejected: stderrDimRejectionSink,
  });
  const embedModel = activeEmbedModelId(embeddingsConfig);

  // PRD-019a: resolve the shared Deep Lake credentials WITHOUT pinning a single
  // project (the daemon is multi-root now). Creds absent -> the daemon boots,
  // serves /health, and stays dormant (no durable store to brood into).
  let loadedCredentials: ReturnType<typeof loadDeepLakeCredentials> | undefined;
  try {
    loadedCredentials = loadDeepLakeCredentials();
  } catch {
    loadedCredentials = undefined;
  }
  // Const snapshots so the deferred factory / view closures narrow correctly.
  const creds = loadedCredentials;
  const durableStore = creds !== undefined ? new DeepLakeHiveGraphStore({ credentials: creds }) : undefined;

  // PRD-018k / NEC-023: brood prerequisites so a dormant daemon surfaces WHY.
  const broodPrereqs = broodPrereqsFromEnv({ credentialsPresent: creds !== undefined, credentialsPath: credentialsPath() });
  const tunables = resolveNectarTunables();

  // PRD-019a: the active-project supervisor seam. `resolve` reads the shared
  // `~/.deeplake/projects.json` bindings + the nectar-owned brooding state; the
  // factory stands up one brood + watch context per active project, each rooted
  // at its own bound path and scoped to its own tenancy project id. Live brood
  // (describe) deps are attached only when Portkey is configured.
  //
  // W1-N remediation (live-reload of bindings/credentials without a restart):
  // the seam is wired UNCONDITIONALLY (not gated on a boot-time credentials
  // snapshot) and delegates to `LiveActiveProjects`, which re-resolves
  // `~/.deeplake/credentials.json` on EVERY reconcile tick. So a daemon that
  // booted BEFORE login, then had a project bound afterward, activates that
  // project on its next tick (or immediately, when the credentials watch fires a
  // reconcile the moment credentials appear) - no daemon restart. The tenancy
  // `expect` guard is derived fresh from the currently-resolved credentials, so
  // it is never frozen at boot. Absent creds -> an empty resolution (dormant).
  const liveControlOptions: Omit<ProjectsControlOptions, "expect"> = {};
  const liveActive = new LiveActiveProjects({
    loadCredentials: () => {
      try {
        return loadDeepLakeCredentials();
      } catch {
        return undefined;
      }
    },
    createStore: (credentials) => new DeepLakeHiveGraphStore({ credentials }),
    buildContext: ({ project, credentials, store }): RunningContext =>
      createProjectContext({
        project,
        tenancy: { orgId: credentials.orgId, workspaceId: credentials.workspaceId, projectId: project.projectId },
        store,
        ...(portkey.enabled
          ? { broodDeps: { portkey: portkey as PortkeyEnabled, embedProvider, embedModelId: embedModel } }
          : {}),
        log: (line) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`),
      }),
    controlOptions: liveControlOptions,
    // PRD-018k / NEC-023: gate the WHOLE brood/watch activation on the brood prerequisites, not
    // just the describe deps. Brooding is dormant out of the box: without Deep Lake creds AND
    // Portkey enabled, resolve() reports zero active projects, so the supervisor auto-broods
    // nothing (previously the structural brood — walk/mint/embed — still ran for any bound
    // project even with no inference configured, pegging CPU to no purpose).
    broodReady: () => broodPrereqs.ready,
    onError: (err) =>
      process.stderr.write(
        `nectar daemon: active-project resolve failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
      ),
  });
  const activeProjects = {
    resolve: () => liveActive.resolve(),
    factory: (project: ResolvedProject): RunningContext => liveActive.factory(project),
  };

  // The daemon-level enricher + hive-graph API stay scoped to the PRIMARY active
  // project resolved at boot (the common single-project case); per-project
  // enrichment for additional active projects is a documented follow-up. These
  // read the BOOT-time tenancy snapshot (creds at boot); the multi-root brood +
  // watch supervisor above is the credentials-live path that removes the dormancy
  // bug. Absent creds/Portkey/active set -> the enricher stays dormant (honest).
  const bootControlOptions: ProjectsControlOptions =
    creds !== undefined ? { expect: { org: creds.orgId, workspace: creds.workspaceId } } : {};
  const primary = durableStore !== undefined ? readActiveProjects(bootControlOptions).resolution.active[0] : undefined;
  const primaryTenancy: Tenancy | undefined =
    primary !== undefined && creds !== undefined
      ? { orgId: creds.orgId, workspaceId: creds.workspaceId, projectId: primary.projectId }
      : undefined;
  const live: LiveDurableWiring | undefined =
    durableStore !== undefined && creds !== undefined && primary !== undefined && primaryTenancy !== undefined && portkey.enabled
      ? buildLiveDurableWiring(
          { ok: true, tenancy: primaryTenancy, projectRoot: primary.path, store: durableStore, scopeSource: "binding", credentials: creds },
          portkey,
        )
      : undefined;

  const options: AssembleOptions = {
    broodPrereqs,
    // PRD-003a a-AC-1: boot 503 degraded when no credentials resolved, so the
    // pre-login fleet posture is honest; the watch below flips it healthy the
    // moment credentials appear (a-AC-2), no restart needed.
    //
    // W1-N remediation (live-reload without a daemon restart): the multi-root
    // brood + watch supervisor (the `activeProjects` seam below) now re-resolves
    // credentials + `projects.json` on EVERY reconcile tick via
    // `LiveActiveProjects`, so credentials appearing after boot (and any project
    // bound afterward) DO hot-attach - the daemon starts brooding/watching the
    // newly-active project on its next tick, or immediately when the credentials
    // watch fires `reconcileActiveProjects`. Remaining boot-snapshot scope: the
    // PRIMARY-project enricher loop + hive-graph API assembled below still read
    // the boot-time creds (a documented single-project follow-up), so those two
    // subsystems alone stay dormant until the next restart when creds arrive
    // late. The dormancy-until-restart bug (no brooding at all) is fixed.
    storageCredentialsPresent: creds !== undefined,
    credentialsWatch: {
      probe: () => {
        try {
          loadDeepLakeCredentials();
          return true;
        } catch {
          return false;
        }
      },
    },
    activeProjects,
    ...(live !== undefined && primaryTenancy !== undefined && primary !== undefined
      ? {
          tenancy: primaryTenancy,
          projectRoot: primary.path,
          enricherStore: live.enricher,
          enricherCycle: {
            readContent: live.readContent,
            portkey: live.portkey,
            embedProvider,
            ...(tunables.redescribeThreshold !== undefined
              ? { config: { redescribeThreshold: tunables.redescribeThreshold } }
              : {}),
            embedModel,
            refreshWorkingSet: () => live.enricher.refresh(primaryTenancy),
            priorContentCache: createPriorContentCache(),
            projectionWriter: new ProjectionWriter({ projectRoot: primary.path }),
            projectionDoc: () => live.enricher.buildProjectionDoc(primaryTenancy),
            onDescribeError: (err: unknown, paths: readonly string[]) => {
              process.stderr.write(
                `nectar enricher: describe batch failed (${paths.length} file(s), first: ${paths[0] ?? "?"}): ` +
                  `${err instanceof Error ? err.message : String(err)}\n`,
              );
            },
          },
        }
      : {}),
  };

  const daemon = assembleDaemon(options);

  // PRD-019b: the projects + brooding-control endpoints (consumed by Hive's
  // dashboard). Persisting a toggle triggers an immediate active-set reconcile.
  try {
    {
      mountProjectsApi(daemon, {
        view: () => {
          const { resolution, cache } = readActiveProjects(bootControlOptions);
          return buildProjectsView(resolution, cache, (id) => daemonWatcherState(daemon, id));
        },
        setProject: (projectId, brooding) => {
          persistProjectBrooding(projectId, brooding, bootControlOptions);
        },
        setGlobal: (global) => {
          persistGlobalBrooding(global, bootControlOptions);
        },
        reconcile: () => daemon.reconcileActiveProjects(),
        // b-AC-6: the HTTP body carries only this path + a stable reason; the
        // raw persist failure is logged server-side here.
        stateFilePath: broodingStatePath(),
        onPersistError: (err) =>
          process.stderr.write(
            `nectar daemon: brooding-state persist failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
      });
    }
  } catch {
    // fail-soft: a wiring failure never blocks the daemon from serving /health.
  }

  // PRD-008: the hive-graph search/build/status API, scoped to the PRIMARY active
  // project at boot (single-scope; the multi-scope dashboard surface is 019c).
  try {
    if (creds !== undefined && durableStore !== undefined && primary !== undefined && primaryTenancy !== undefined) {
      mountHiveGraphApi(
        daemon,
        buildHiveGraphApiOptions({
          credentials: creds,
          tenancy: primaryTenancy,
          projectRoot: primary.path,
          store: durableStore,
          costSpentUsd: () => daemon.health.snapshot().cost.broodTotalUsd,
          ...(tunables.recallMultiplier !== undefined ? { recallMultiplier: tunables.recallMultiplier } : {}),
          brood: { portkey, embedProvider, metrics: daemonMetricsProxy(daemon) },
          broodGuard: daemon.broodGuard,
        }),
      );
    }
  } catch {
    // fail-soft: a wiring failure never blocks the daemon from serving /health.
  }

  daemon.installSignalHandlers();
  const port = await daemon.start();
  process.stdout.write(
    `nectar daemon listening on http://${daemon.config.host}:${port}/health\n`,
  );

  // PRD-018k / NEC-023 (AC-018k.5, option B): a guided first-run experience.
  // When brooding is dormant AND this is an interactive terminal, print the
  // exact steps to configure the prerequisites. Never block or prompt; in a
  // non-interactive context (a service unit, CI) nothing is printed - the loud
  // startup log line already carried the machine-readable dormancy reason.
  if (!broodPrereqs.ready && process.stdout.isTTY === true) {
    process.stdout.write(formatFirstRunGuidance(broodPrereqs));
  }

  // Hydrate the durable enricher's working set from Deep Lake in the BACKGROUND
  // (never blocks readiness; fail-soft). The enricher loop sees an empty working
  // set until this settles, then picks up the seeded pending rows on its next cycle.
  if (live !== undefined && primaryTenancy !== undefined) {
    void live.enricher.hydrate(primaryTenancy).catch((err: unknown) => {
      process.stderr.write(
        `nectar daemon: enricher hydrate failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }

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

  if (command === "login") {
    return runLogin(argv.slice(1));
  }

  if (command === "install") {
    return runInstall();
  }

  if (command === "start") {
    return runStart();
  }

  if (command === "stop") {
    return runStop();
  }

  if (command === "uninstall") {
    return runUninstall();
  }

  // `status` is the bare verb; `service-status` is its alias (PRD-003b b-AC-5).
  if (command === "status" || command === "service-status") {
    return runServiceStatus();
  }

  if (command === "rebuild-projection") {
    return runRebuildProjection();
  }

  if (command === "brood") {
    return runBroodCommand(argv.slice(1));
  }

  if (command === "prune") {
    return runPruneCommand(argv.slice(1));
  }

  if (command === "review-matches") {
    return runReviewMatchesCommand();
  }

  if (command === "search") {
    return runSearchCommand(argv.slice(1));
  }

  if (command === "projects") {
    return runProjectsCommand(argv.slice(1));
  }

  if (command === "brooding") {
    return runBroodingCommand(argv.slice(1));
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
