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

const USAGE = `hivenectar - semantic memory layer over a source tree

Usage:
  hivenectar daemon                 Start the hiveantennae daemon (127.0.0.1:3854, /health)
  hivenectar brood [flags]          Full-codebase brood            (owned by PRD-007)
  hivenectar prune --confirm        Prune long-missing nectars     (owned by PRD-006)
  hivenectar review-matches         Review low-confidence matches  (owned by PRD-006)
  hivenectar rebuild-projection     Regenerate .honeycomb/nectars.json (owned by PRD-011)
  hivenectar --help                 Show this help
`;

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
