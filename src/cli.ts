#!/usr/bin/env node
/**
 * The hivenectar CLI.
 *
 * `hivenectar daemon` is the runnable process (PRD-002c): it invokes the
 * composition root, acquires the single-instance lock before binding
 * 127.0.0.1:3854, serves `/health`, and installs SIGINT/SIGTERM handlers. The
 * operational verbs (brood / prune / review-matches / rebuild-projection) are
 * owned by other PRDs (007 / 006 / 011); until their mechanics land, they exit
 * with a clear "owned by PRD-NNN, not yet implemented" notice and a non-zero
 * code rather than a silent stub.
 */
import { assembleDaemon } from "./daemon.js";
import { resolveConfig } from "./config.js";
import { createServiceModule, serviceStatus } from "./service/index.js";
import { registerWithHivedoctor } from "./hivedoctor-registry.js";

const USAGE = `hivenectar - semantic memory layer over a source tree

Usage:
  hivenectar daemon                 Start the hiveantennae daemon (127.0.0.1:3854, /health)
  hivenectar install                Register the OS service unit + the hivedoctor registry entry (PRD-003)
  hivenectar uninstall              Deregister the OS service unit (PRD-003b)
  hivenectar service-status         Report the OS service unit's running state (PRD-003b)
  hivenectar brood [flags]          Full-codebase brood            (owned by PRD-007)
  hivenectar prune --confirm        Prune long-missing nectars     (owned by PRD-006)
  hivenectar review-matches         Review low-confidence matches  (owned by PRD-006)
  hivenectar rebuild-projection     Regenerate .honeycomb/nectars.json (owned by PRD-011)
  hivenectar --help                 Show this help
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

  return serviceResult.ok ? 0 : 1;
}

/** `hivenectar uninstall` (PRD-003b): deregisters the OS service unit so it does not resurrect. */
async function runUninstall(): Promise<number> {
  const serviceModule = createServiceModule({
    execPath: resolveServiceExecPath(),
    preferSystemScope: preferSystemScope(),
  });
  const result = await serviceModule.uninstall();
  process.stdout.write(`${result.message}\n`);
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

/** Verbs whose mechanics are owned by not-yet-implemented PRDs. */
const NOT_YET: Record<string, string> = {
  brood: "PRD-007 (brooding pipeline)",
  prune: "PRD-006 (re-association + pruning)",
  "review-matches": "PRD-006 (TLSH review surface)",
  "rebuild-projection": "PRD-011 (portable projection)",
  project: "PRD-011 (project-scoped projection)",
};

async function runDaemon(): Promise<void> {
  const daemon = assembleDaemon();
  daemon.installSignalHandlers();
  const port = await daemon.start();
  process.stdout.write(
    `hivenectar daemon listening on http://${daemon.config.host}:${port}/health\n`,
  );
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
