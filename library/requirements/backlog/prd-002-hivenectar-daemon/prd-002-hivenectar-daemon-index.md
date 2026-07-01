# PRD-002: Hivenectar Daemon

> **Status:** Backlog
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None (the daemon owns no Deep Lake table; PRD-005 owns `source_graph` + `source_graph_versions`. This PRD produces the runnable process that writes those tables.)

---

## Overview

PRD-002 is the daemon itself — the largest PRD. It produces the runnable **`hivenectar daemon`** process: a standalone OS workload daemon that owns the semantic-memory pipeline (watch → re-associate → mint/enrich → embed → projection-sync), its own HTTP bind, its own single-instance PID/lock, its own Deep Lake client under the same `org`/`workspace`/`project` tenancy honeycomb uses, and the CLI surface an operator drives. It is modeled on honeycomb's composition root (`assembleDaemon`) but scoped to Hivenectar's job surface rather than session capture.

The defining constraint, carried from [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) and the [PRD-001](../prd-001-three-daemon-topology/prd-001-three-daemon-topology-index.md) topology, is that **independence is process-layer only**. The daemon obtains its own Deep Lake client, auth context, scoping, worker harness, and lifecycle, reusing honeycomb's *patterns* (the composition root, the lease-based worker harness, the adaptive poll loop) but not importing honeycomb's runtime modules — per decision #4 in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md), the patterns are mirrored, not imported, across the process boundary. The data layer is shared: this daemon writes `source_graph` / `source_graph_versions` rows that honeycomb's recall engine reads (the recall arm is PRD-013).

This PRD owns four sub-features: the **bootstrap + composition root** (config load → Deep Lake client → auth/scoping → worker start → socket bind → signal handlers + single-instance lock), the **hiveantennae worker** (the steady-state watch → re-associate → mint/enrich loop built on the `stage-worker.ts` lease harness + the `poll-loop.ts` adaptive loop), the **CLI surface** (`hivenectar daemon`, `brood` + flags, `prune`, `review-matches`, `rebuild-projection`), and the **single-instance lock + graceful shutdown** (PID/lock + drain + SIGINT/SIGTERM). The daemon's API *route scaffolding* (its own `/api/source-graph/*` endpoints) is owned by [PRD-008](../prd-008-hivenectar-api-endpoints/prd-008-hivenectar-api-endpoints-index.md); this PRD produces the runnable process and mounts the `/health` route PRD-003 probes.

---

## Goals

- Produce the runnable **`hivenectar daemon`** process — a standalone OS workload daemon that mirrors honeycomb's `assembleDaemon` composition root, scoped to the semantic-memory pipeline.
- Define the **bootstrap sequence** in a fixed order with a Honeycomb code citation for every step: config load → Deep Lake client → auth/scoping → worker start → socket bind → signal handlers, with the single-instance lock acquired **before** the socket bind.
- Specify the **hiveantennae worker** as a steady-state loop built on honeycomb's lease-based worker harness (`stage-worker.ts`) + the adaptive poll loop (`poll-loop.ts`), driving the four operating modes (brooding / live watch / cold catch-up / projection sync).
- Document the **CLI surface** that invokes the brooding/enricher/projection mechanics — every command the corpus names (`daemon`, `brood` + `--force`/`--limit`/`--dry-run`/`--model`, `prune --confirm`, `review-matches`, `rebuild-projection`, `project --rebuild-projection`).
- Specify the **single-instance PID/lock guard** and the **graceful shutdown** path (drain services → close socket → remove PID/lock) so a restart by hivedoctor or an operator never leaves a stale lock and never double-binds the port.

## Non-Goals

- The Deep Lake table schemas (`source_graph`, `source_graph_versions`) — **PRD-005**. This daemon *writes* those tables; PRD-005 owns the DDL.
- The brooding pipeline mechanics (discovery, bucketing, batch/solo LLM calls, cost math) — **PRD-007**. This PRD documents the `brood` CLI surface that invokes them.
- The file-registration protocol (the `node:fs.watch` intake + the 5-step re-association ladder) — **PRD-006**. This PRD's worker *drives* re-association; PRD-006 owns the ladder algorithm.
- The enricher steady-state loop + meaningful-change heuristic — **PRD-016**. This PRD's worker hosts the loop; PRD-016 owns the queue poll + Jaccard heuristic.
- The portable projection (`.honeycomb/nectars.json`) format + regeneration triggers — **PRD-011**. This PRD documents the `rebuild-projection` CLI that triggers regen.
- The Portkey transport + model selection + semantic-cache story — **PRD-010**.
- The embeddings provider switch (nomic vs Cohere-via-Portkey) — **PRD-014**.
- The daemon's API route scaffolding (`/api/source-graph/*`) — **PRD-008**. This PRD produces the runnable process; PRD-008 mounts the route groups.
- hivedoctor supervision of this daemon + the OS service unit + watchdog-war guards — **PRD-003**.
- thehive's portal + hivedoctor's registry — **PRD-004**.

---

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [`prd-002a-hivenectar-bootstrap-and-composition-root`](./prd-002a-hivenectar-bootstrap-and-composition-root.md) | Bootstrap + composition root: config load → Deep Lake client → auth/scoping → worker start → socket bind → signal handlers; single-instance lock | Draft |
| [`prd-002b-hiveantennae-worker`](./prd-002b-hiveantennae-worker.md) | The steady-state worker: watch → re-associate → mint/enrich, built on `stage-worker.ts` + `poll-loop.ts` | Draft |
| [`prd-002c-hivenectar-cli-surface`](./prd-002c-hivenectar-cli-surface.md) | CLI surface: `hivenectar daemon`, `brood [--force|--limit|--dry-run|--model]`, `prune --confirm`, `review-matches`, `rebuild-projection` | Draft |
| [`prd-002d-single-instance-lock-and-shutdown`](./prd-002d-single-instance-lock-and-shutdown.md) | Single-instance PID/lock + graceful drain + SIGINT/SIGTERM | Draft |

---

## Acceptance Criteria

- [ ] `hivenectar daemon` is a runnable OS process that mirrors honeycomb's `assembleDaemon` composition root (`honeycomb/src/daemon/runtime/assemble.ts`) scoped to Hivenectar's job surface; the daemon boots without importing honeycomb's in-process runtime modules (decision #4).
- [ ] The bootstrap sequence runs in the fixed order: config load → Deep Lake client → auth/scoping → worker start → socket bind → signal handlers, with the **single-instance lock acquired before the socket bind** (mirroring `honeycomb/src/daemon/index.ts:150-164` `runAssembledDaemon` — `start()` then `startDaemonListener`, with bind-failure rollback).
- [ ] The daemon binds `127.0.0.1:3854` (DEFAULT host) and exposes an unprotected `/health` returning the coarse `ok`/`degraded`/`unconfigured` bit (`honeycomb/src/daemon/runtime/health.ts:42`), with no port collision against 3850/3851/3852/3853.
- [ ] The hiveantennae worker is a lease-based harness modeled on `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts` (`runOnce()` + `start()`/`stop()` + kind-filtered lease) driven by the adaptive poll loop in `honeycomb/src/daemon/runtime/services/poll-loop.ts`.
- [ ] Every CLI command the corpus names appears in 002c with its invocation, its owner-PRD reference for the mechanic it invokes, and a citation to the corpus doc that names it (`overview.md`, `brooding-pipeline.md`, `identity-and-reassociation.md`, `enricher-and-llm-model.md`).
- [ ] A second `hivenectar daemon` start throws a `DaemonAlreadyRunningError`-equivalent before the socket bind (mirroring `honeycomb/src/daemon/runtime/assemble.ts:715-723`), and a stale lock (dead PID) is reclaimed.
- [ ] `SIGINT`/`SIGTERM` drain services, close the socket, and remove `~/.honeycomb/hivenectar.pid` + `~/.honeycomb/hivenectar.lock` so no stale lock survives a restart (mirroring `honeycomb/src/daemon/index.ts:166-187`); close is idempotent and a second signal is ignored.

---

## Defaults registered in this PRD

Three values are defaults pending implementation confirmation. Each is flagged inline with **DEFAULT — confirm before implementation** at its sub-PRD:

| Default | Value | Where | Rationale |
|---|---|---|---|
| Config file path | `~/.honeycomb/hivenectar.json` | 002a, 002c | Mirrors honeycomb's config-file convention under the shared `~/.honeycomb` runtime dir (`honeycomb/src/daemon/runtime/auth/credentials-store.ts:71` `LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb"`). |
| Worker poll interval | 30s | 002b | Matches the enricher's default 30-second interval named in [`knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md). |
| Bind host | `127.0.0.1` (loopback) | 002a | Mirrors honeycomb's loopback-only posture (`honeycomb/embeddings/src/index.ts:67` `EMBED_HOST = "127.0.0.1"`); the daemon is reached by hivedoctor + thehive over loopback. |

The port (3854) and PID/lock filenames are inherited from the [PRD-001 port + path contract](../prd-001-three-daemon-topology/prd-001-three-daemon-topology-index.md) and are not re-registered here.

---

## Related

- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-002 brief + decisions #1 (topology), #4 (fs.watch, mirror-not-import), #6 (Portkey cache server-side).
- [`knowledge/private/overview.md`](../../../knowledge/private/overview.md) — the four operating modes (brooding / live watch / cold catch-up / projection sync) and the hiveantennae daemon.
- [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — the brooding pipeline + cost math.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — the re-association ladder + the `prune`/`review-matches` semantics.
- [`knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the enricher contract + the 30s poll interval + the meaningful-change heuristic.
- [`knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) — the independence decision (own client, own auth, shared data layer).
- [`prd-001-three-daemon-topology`](../prd-001-three-daemon-topology/prd-001-three-daemon-topology-index.md) — the port + path contract this PRD cites (3854, `~/.honeycomb/hivenectar.{pid,lock}`); the process surface in [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md).
- [`prd-005-source-graph-catalog-tables`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — owns the tables this daemon writes.
- `honeycomb/src/daemon/runtime/assemble.ts` — the composition-root pattern to mirror (`assembleDaemon`, `acquireSingleInstanceLock`).
- `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts` — the lease-based worker harness.
- `honeycomb/src/daemon/runtime/services/poll-loop.ts` — the adaptive poll loop.
- `honeycomb/src/daemon/index.ts` — the `runAssembledDaemon` lifecycle + signal-handler pattern.
