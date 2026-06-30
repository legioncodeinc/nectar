# PRD-004b: hivedoctor status page + CLI — multi-daemon reporting

> **Codebase:** `honeycomb` repo → `hivedoctor/` package. This is an out-of-band sub-PRD; it lands in the hivedoctor codebase, not hivenectar.

## Overview

Once 004a spawns N supervisor instances over isolated state shards, hivedoctor's two operator-facing reporting surfaces must report all N daemons, not just one. Today the loopback status page (`hivedoctor/src/status-page/server.ts`) serves a single coarse `health` + a single `escalation` (`server.ts:40-48`, `197-206`), and the CLI `status` command (`hivedoctor/src/cli/dispatch.ts:58-87`) probes one daemon and prints one health line. This sub-PRD generalizes both to iterate the registry: the status page renders a per-daemon table, and the CLI prints one block per registered daemon.

These surfaces remain hivedoctor's own read-only supervision views. They are distinct from thehive's unified workload dashboard (004c): hivedoctor's page is "what is the supervisor doing to each daemon"; thehive's is "what is each workload showing me."

## Goals

- The loopback status page (`/` HTML and `/status.json`) reports every registered daemon's coarse health + per-daemon escalation, not a single daemon's.
- The CLI `status` command prints one health block per registry entry.
- The CLI `logs` command accepts a daemon filter so an operator tails a single daemon's incident stream (the per-daemon `.ndjson` shards from 004a).
- Reporting is read-only and crash-safe: a daemon whose probe wedges never blocks the page or the CLI (same defensive posture as `server.ts:262-275` and `dispatch.ts:295-301`).

## Non-Goals

- No thehive dashboard work here. thehive's portal is 004c.
- No new CLI commands beyond extending `status`/`diagnose`/`logs` to iterate the registry. The command surface (`hivedoctor/src/cli/command-table.ts`) is unchanged.
- No live registry mutation from the CLI. The CLI reads the registry; it does not edit it (004d owns registry edits).
- No remote/network exposure. The status page stays bound to `127.0.0.1` (`hivedoctor/src/status-page/server.ts:96`).

---

## User stories + acceptance criteria

### US-1 — Multi-daemon status page

**As** an operator, **when** I open hivedoctor's loopback status page, **I** see every registered daemon's health at once.

| ID | Criterion |
|---|---|
| b-AC-1 | Given a registry with three daemons, when an operator fetches `/status.json`, then the response contains a per-daemon array (one entry each) with `name`, `health`, and that daemon's latest escalation, not a single top-level `health`/`escalation`. |
| b-AC-2 | Given the registry, when `/status.json` is built, then each entry's `health` is read from that daemon's isolated state shard (004a's `state-<name>.json` `lastKnownHealth`), not a shared value. |
| b-AC-3 | Given the HTML page (`/`), when rendered, then it shows one row/badge per registered daemon with its health, mirroring the existing per-health badge styling in `hivedoctor/src/status-page/server.ts:144-184`. |

### US-2 — Multi-daemon CLI status

**As** an operator, **when** I run `hivedoctor status`, **I** get a block per registered daemon.

| ID | Criterion |
|---|---|
| b-AC-4 | Given a registry with three daemons, when `hivedoctor status` runs, then it prints one block per daemon, each with its own health label, version, last-heal, and opt-out line — the per-daemon analogue of the single block in `hivedoctor/src/cli/dispatch.ts:71-85`. |
| b-AC-5 | Given `hivedoctor status`, when a registered daemon is unreachable, then its block reports `unreachable` (mirroring `dispatch.ts:37-50`'s `healthLabel`) without crashing the command or aborting the other blocks. |

### US-3 — Per-daemon logs

**As** an operator, **when** a daemon is misbehaving, **I** tail just its incident stream.

| ID | Criterion |
|---|---|
| b-AC-6 | Given `hivedoctor logs --daemon hivenectar`, when run, then it tails only the hivenectar incident stream (004a's `incidents-hivenectar.ndjson`), not every daemon's. |
| b-AC-7 | Given `hivedoctor logs` with no `--daemon` flag, when run, then it tails every registered daemon's stream interleaved with a daemon-name prefix per line. |

---

## Implementation notes

### Status page: per-daemon state provider

Today `createStatusPageServer` takes a single `StatusPageStateProvider` with `health()` and `escalation()` (`hivedoctor/src/status-page/server.ts:50-56`), and the composition root wires it over one `stateStore`/`needsAttention` pair (`hivedoctor/src/compose/index.ts:378-389`). The generalization: the state provider iterates the registry. Concretely the root passes a provider whose `health()`/`escalation()` (or a new `entries()` method) reads each supervisor's isolated state shard from 004a and returns the per-daemon array b-AC-1 requires.

`StatusJson` (`server.ts:40-48`) gains a `daemons: readonly { name, health, escalation }[]` field. The existing top-level `health`/`escalation`/`suggestedCommands` (`server.ts:42-46`) are retained for backward compatibility — the top-level `health` becomes an aggregate (e.g. `ok` only if every daemon is `ok`; `degraded`/`unreachable` otherwise), and `suggestedCommands` (`server.ts:100-139`) is built across all daemons' escalations.

The HTML template (`server.ts:156-184`) renders a per-daemon badge row (b-AC-3), reusing the existing `.ok`/`.degraded`/`.unreachable` CSS classes (`server.ts:148-150`). No new dependencies; the read-only + loopback-only + bind-error-swallowed constraints (`server.ts:16-27`) all carry over unchanged.

### CLI status: iterate the registry

`runStatus` (`hivedoctor/src/cli/dispatch.ts:58-87`) currently calls `deps.probe()` once and prints one block. The registry-aware version iterates the entries: for each entry it probes that entry's `healthUrl` and reads that entry's state shard (004a), printing one block (b-AC-4). `healthLabel` (`dispatch.ts:37-50`) and the opt-out line (`dispatch.ts:79-85`) are reused per entry; opt-out is a process-global value (it gates the honeycomb auto-update engine, `compose/index.ts:333-375`), so it prints once at the bottom, not per daemon.

`CliContext.deps` (`hivedoctor/src/cli/context.ts`, consumed at `dispatch.ts:59`) gains a registry-aware probe/state surface — a list of `{ name, probe, readStatusState }` tuples rather than the single `deps.probe`/`deps.readStatusState`. The crash-safe wrapper in `dispatch` (`dispatch.ts:295-301`) already catches a handler throw and maps it to `EXIT_ERROR`; per-entry probing keeps each probe inside that guard so one wedged daemon never aborts the whole report (b-AC-5).

### CLI logs: daemon filter

`runLogs` (`hivedoctor/src/cli/dispatch.ts:207-218`) currently tails one incident log via `deps.tailIncidents(limit)`. With per-daemon incident streams (004a's `incidents-<name>.ndjson`), `tailIncidents` gains a `name` argument; `--daemon <name>` parses via the existing flag mechanism (`dispatch.ts:209` reads `parsed.flags["lines"]`) and selects one stream (b-AC-6). Without the flag it reads every registered stream and prefixes each line with the daemon name (b-AC-7).

## Related

- [`prd-004a-hivedoctor-registry-config-and-supervisor-instances.md`](./prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) — the isolated per-daemon state shards these surfaces read.
- [`prd-004-hivedoctor-registry-and-thehive-index.md`](./prd-004-hivedoctor-registry-and-thehive-index.md) — module scope.
