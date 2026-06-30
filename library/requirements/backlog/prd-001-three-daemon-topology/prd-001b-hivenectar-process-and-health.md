# PRD-001b: Hivenectar Process, Lock, Health, Deep Lake Client, and Tenancy

> Parent: [`prd-001-three-daemon-topology-index.md`](./prd-001-three-daemon-topology-index.md)

## Overview

This sub-PRD defines hivenectar's own **process surface** — everything the hivenectar daemon owns at the process boundary, as opposed to the shared data/infra layer. It is the contract PRD-002 (the daemon bootstrap) conforms to and PRD-003 (hivedoctor supervision) consumes. Specifically: hivenectar is a standalone OS process with its own HTTP bind, a single-instance PID/lock guard, a `/health` endpoint, its own Deep Lake client (not honeycomb's), and its own auth/scoping — all modeled on honeycomb's existing composition root and lifecycle, but instantiated separately so the two workload daemons never share in-process state.

The defining constraint, carried from ADR-0002, is that **independence is process-layer only**. hivenectar obtains its own Deep Lake client, auth context, scoping, and observability rather than inheriting the host's (this was ADR-0002's negative consequence #1 and is now the contract), while reading and writing the **same** Deep Lake tables under the **same** `org`/`workspace`/`project` tenancy honeycomb uses. The data layer is shared; the process surface is not.

## Goals

- Specify hivenectar's **HTTP bind** (host + port) and confirm it does not collide with the occupied ports (3850/3851/3852).
- Specify hivenectar's **single-instance PID/lock guard**, mirroring honeycomb's pattern, with distinct file names so the two daemons' locks never collide.
- Specify hivenectar's **`/health` endpoint contract**, modeled on honeycomb's `PipelineStatus` coarse bit, so hivedoctor can probe it the same way it probes honeycomb.
- Specify that hivenectar obtains its **own Deep Lake client** (org resolution, scoped queries, timeout, tracing, redaction) following honeycomb's client surface, and scopes every query by `org`/`workspace` (with `project_id` as a column filter inside the workspace partition — PRD-005's locked tenancy model).
- Specify hivenectar's **graceful shutdown** behavior so a restart (by hivedoctor or an operator) never leaves a stale lock.

## Non-Goals

- The daemon's composition root and bootstrap sequence (config load → client init → auth → worker start → bind → signal handlers) — **PRD-002a**.
- The hiveantennae worker harness (watch → re-associate → mint/enrich) — **PRD-002b**.
- The CLI surface (`hivenectar daemon`, `brood`, etc.) — **PRD-002c**.
- The OS service unit + watchdog-war guards against the single-instance lock — **PRD-003b/003c**.
- The Deep Lake table schemas — **PRD-005**. This PRD states the tables are shared and the client is hivenectar's own; the DDL is PRD-005's.
- The embeddings client (how hivenectar reaches the embeddings daemon) — [`prd-001c`](./prd-001c-shared-infra-consumption.md).

---

## HTTP bind

hivenectar binds a loopback HTTP socket, mirroring honeycomb's loopback-only posture (the embeddings daemon binds `127.0.0.1` at [`honeycomb/embeddings/src/index.ts:67-68`](../../../../honeycomb/embeddings/src/index.ts) `EMBED_HOST = "127.0.0.1"`).

| Property | Value | Citation / status |
|---|---|---|
| Host | `127.0.0.1` (loopback) | mirrors [`honeycomb/embeddings/src/index.ts:67`](../../../../honeycomb/embeddings/src/index.ts) |
| Port | **3854** | **CONFIRMED** (next free after thehive=3853; 3850/3851/3852 occupied — see parent index) |

The port is distinct from every occupied port: 3850 (honeycomb, [`honeycomb/src/shared/constants.ts:14`](../../../../honeycomb/src/shared/constants.ts)), 3851 (embeddings, [`honeycomb/embeddings/src/index.ts:68`](../../../../honeycomb/embeddings/src/index.ts)), 3852 (hivedoctor status page, [`honeycomb/hivedoctor/src/status-page/server.ts:93`](../../../../honeycomb/hivedoctor/src/status-page/server.ts)). See the parent index's port contract table.

## Single-instance PID/lock guard

hivenectar reuses honeycomb's single-instance lock pattern: write `<name>.pid` + `<name>.lock` under the runtime dir; if a lock exists and its recorded PID is alive, refuse to double-bind; a stale lock (dead PID) is reclaimed so a crashed daemon never wedges the next start.

| Property | Value | Citation / status |
|---|---|---|
| Runtime dir | `~/.honeycomb` | [`honeycomb/src/daemon/runtime/auth/credentials-store.ts:71`](../../../../honeycomb/src/daemon/runtime/auth/credentials-store.ts) `LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb"`; resolved at [`honeycomb/src/daemon/runtime/assemble.ts:688-690`](../../../../honeycomb/src/daemon/runtime/assemble.ts) |
| PID file | `~/.honeycomb/hivenectar.pid` | **DEFAULT — confirm before implementation** |
| Lock file | `~/.honeycomb/hivenectar.lock` | **DEFAULT — confirm before implementation** |

The pattern to mirror is `acquireSingleInstanceLock` ([`honeycomb/src/daemon/runtime/assemble.ts:715-732`](../../../../honeycomb/src/daemon/runtime/assemble.ts)): `mkdirSync(runtimeDir, { recursive: true })`, read the existing PID via `readPidFile`, `isPidAlive` (signal-0 probe; `ESRCH` → stale, `EPERM` → alive-but-other-user), and on a live PID throw a `DaemonAlreadyRunningError` **before binding** so the port is never double-bound. hivenectar's filenames differ from honeycomb's (`daemon.pid`/`daemon.lock`, [`honeycomb/src/daemon/runtime/assemble.ts:184,186`](../../../../honeycomb/src/daemon/runtime/assemble.ts)) so the two daemons' locks coexist in the same `~/.honeycomb` dir — a single `ls ~/.honeycomb/*.pid` enumerates every live daemon, the same convenience honeycomb's PID file provides ([`honeycomb/src/daemon/runtime/assemble.ts:726-727`](../../../../honeycomb/src/daemon/runtime/assemble.ts) comment: "`cat ~/.honeycomb/daemon.pid`").

> **Why a distinct lock, not a shared one.** hivedoctor already reads `~/.honeycomb/daemon.pid` to respect honeycomb's lock during restart ([`honeycomb/hivedoctor/src/config.ts:53,155`](../../../../honeycomb/hivedoctor/src/config.ts) `daemonPidPath` default `~/.honeycomb/daemon.pid`). hivenectar's supervision entry (PRD-003c) points hivedoctor at `~/.honeycomb/hivenectar.pid` instead, so hivedoctor's restart rung respects the right daemon's lock. Two daemons cannot share one lock file — that would make the second one refuse to start.

## `/health` endpoint contract

hivenectar exposes a `/health` endpoint answering the same coarse `ok`/`degraded`/`unconfigured` bit honeycomb's dashboard, connectivity banner, and 503 gate consume ([`honeycomb/src/daemon/runtime/health.ts:42`](../../../../honeycomb/src/daemon/runtime/health.ts) `PipelineStatus = "ok" | "degraded" | "unconfigured"`). hivedoctor probes it identically to how it probes honeycomb — a `GET /health` over `node:http` with a short timeout ([`honeycomb/hivedoctor/src/health-probe.ts:4`](../../../../honeycomb/hivedoctor/src/health-probe.ts), probing `http://127.0.0.1:3850/health` today).

| Property | Value | Citation / status |
|---|---|---|
| Path | `/health` | mirrors [`honeycomb/src/daemon/runtime/server.ts:72`](../../../../honeycomb/src/daemon/runtime/server.ts) (the unprotected `/health` route group) |
| Protection | unprotected (no auth, no session) | mirrors [`honeycomb/src/daemon/runtime/server.ts:72`](../../../../honeycomb/src/daemon/runtime/server.ts) `{ path: "/health", protect: false, session: false }` |
| Body (coarse) | `{ status: "ok" | "degraded" | "unconfigured" }` | [`honeycomb/src/daemon/runtime/health.ts:42`](../../../../honeycomb/src/daemon/runtime/health.ts) |
| hivedoctor probe URL | `http://127.0.0.1:3854/health` | **DEFAULT** port 3854; modeled on [`honeycomb/hivedoctor/src/config.ts:75`](../../../../honeycomb/hivedoctor/src/config.ts) `healthUrl: "http://127.0.0.1:3850/health"` |

> **DEFAULT — confirm before implementation.** Whether hivenectar's `/health` carries the per-subsystem `reasons` block (storage/embeddings/schema/portkey, [`honeycomb/src/daemon/runtime/health.ts:70-79`](../../../../honeycomb/src/daemon/runtime/health.ts)) or only the coarse bit is left to PRD-002/003. The contract here is only the coarse bit hivedoctor classifies on; the `reasons` block is an additive, mode-gated extension and does not change hivedoctor's probe.

## Deep Lake client (hivenectar's own)

hivenectar instantiates its **own** Deep Lake client — it does not import or share honeycomb's in-process client. ADR-0002 negative consequence #1 names this as required configuration surface. The client surface hivenectar mirrors is the single Deep Lake entry point honeycomb uses: org resolution on every query, a forced `QueryScope`, a per-statement timeout, SQL tracing, result-union mapping, and token redaction ([`honeycomb/src/daemon/storage/client.ts:1-60`](../../../../honeycomb/src/daemon/storage/client.ts)).

The load-bearing scoping contract: `QueryScope` carries **only `org` + `workspace`** ([`honeycomb/src/daemon/storage/client.ts:41-46`](../../../../honeycomb/src/daemon/storage/client.ts)). There is no `query(sql)` overload that omits the scope — the API forces the caller to pass `org`, guaranteeing no tenant query goes out unscoped. `project_id` is **not** part of `QueryScope`; per PRD-005's locked tenancy model (decision #3), it is a **column-level soft `WHERE` filter within the workspace partition**, never a partition.

| Property | Value | Citation |
|---|---|---|
| Client ownership | hivenectar's own (not honeycomb's) | ADR-0002 negative consequence #1 |
| Scope shape | `{ org: string; workspace?: string }` | [`honeycomb/src/daemon/storage/client.ts:41-46`](../../../../honeycomb/src/daemon/storage/client.ts) |
| Per-statement timeout | bounded (abortable race) | [`honeycomb/src/daemon/storage/client.ts:19-21`](../../../../honeycomb/src/daemon/storage/client.ts) |
| Tracing | gated at call time | [`honeycomb/src/daemon/storage/client.ts:22-23`](../../../../honeycomb/src/daemon/storage/client.ts) |
| Redaction | org/token never echoed in full | [`honeycomb/src/daemon/storage/client.ts:24-25`](../../../../honeycomb/src/daemon/storage/client.ts) |

## Tenancy scope

hivenectar writes the `source_graph` and `source_graph_versions` rows under the **same** `org_id` / `workspace_id` / `project_id` tenancy honeycomb uses for its tenant-scoped tables (mirroring the `codebase` table, [`honeycomb/src/daemon/storage/catalog/product.ts`](../../../../honeycomb/src/daemon/storage/catalog/product.ts)). The scope is `org` + `workspace` at the storage layer; `project_id` filters rows inside the workspace partition. This is PRD-005's locked model, restated here only because it is the deploy-time invariant the shared-infra contract (PRD-001c) depends on.

## Graceful shutdown

hivenectar installs `SIGINT`/`SIGTERM` handlers that drain services, close the socket, and **remove the PID/lock files** so no stale lock survives a restart — mirroring honeycomb's `runAssembledDaemon` close path ([`honeycomb/src/daemon/index.ts:166-187`](../../../../honeycomb/src/daemon/index.ts) — the idempotent `close`, the `onSignal` handler, `process.once("SIGINT"/"SIGTERM", …)`). The handlers are registered once; a second signal is ignored (close is idempotent). This is the contract hivedoctor's restart rung relies on: a clean restart leaves no `hivenectar.lock` behind, so the next `acquireSingleInstanceLock` does not falsely report "already running."

---

## User stories

### US-001b.1 — hivenectar binds a free port and serves /health
**As** hivedoctor, **when** I probe `GET http://127.0.0.1:3854/health`, **I** receive a coarse `ok`/`degraded`/`unconfigured` status, **so that** I can supervise hivenectar exactly as I supervise honeycomb.

- Acceptance: hivenectar binds `127.0.0.1:3854` (DEFAULT) and does not collide with 3850/3851/3852.
- Acceptance: `/health` is unprotected and returns the coarse `PipelineStatus` bit.

### US-001b.2 — A second hivenectar start refuses to double-bind
**As an** operator, **when** I start a second hivenectar while one is running, **the** second start throws before binding the port, **so that** the port is never double-bound.

- Acceptance: a live `~/.honeycomb/hivenectar.lock` PID causes the second start to throw a `DaemonAlreadyRunningError`-equivalent before the socket bind (mirroring [`honeycomb/src/daemon/runtime/assemble.ts:720-723`](../../../../honeycomb/src/daemon/runtime/assemble.ts)).
- Acceptance: a stale lock (dead PID) is reclaimed, so a crashed daemon does not wedge the next start.

### US-001b.3 — hivenectar reads/writes Deep Lake through its own scoped client
**As a** maintainer, **when** hivenectar writes a `source_graph_versions` row, **it** does so through its own Deep Lake client carrying `org` + `workspace` scope, **so that** honeycomb's recall engine can read the row under the same tenancy.

- Acceptance: hivenectar instantiates its own Deep Lake client (not honeycomb's in-process client).
- Acceptance: every query carries `QueryScope` (`org` + `workspace`); `project_id` is a column filter, not a partition.

### US-001b.4 — A restart leaves no stale lock
**As** hivedoctor, **when** I restart hivenectar, **the** graceful shutdown removes `~/.honeycomb/hivenectar.lock`, **so that** the next start is not falsely blocked.

- Acceptance: `SIGINT`/`SIGTERM` drain services, close the socket, and remove the PID/lock files (mirroring [`honeycomb/src/daemon/index.ts:166-187`](../../../../honeycomb/src/daemon/index.ts)).
- Acceptance: close is idempotent; a second signal is ignored.

---

## Implementation notes

- HTTP bind pattern (loopback + lifecycle): [`honeycomb/src/daemon/index.ts:117-187`](../../../../honeycomb/src/daemon/index.ts) (`runDaemon`, `runAssembledDaemon`, `startDaemonListener`, signal handlers).
- Single-instance lock: [`honeycomb/src/daemon/runtime/assemble.ts:184,186,692-732`](../../../../honeycomb/src/daemon/runtime/assemble.ts) (`LOCK_FILE_NAME`, `PID_FILE_NAME`, `isPidAlive`, `acquireSingleInstanceLock`, `readPidFile`).
- `/health` coarse bit + route group: [`honeycomb/src/daemon/runtime/health.ts:42`](../../../../honeycomb/src/daemon/runtime/health.ts) (`PipelineStatus`); [`honeycomb/src/daemon/runtime/server.ts:72`](../../../../honeycomb/src/daemon/runtime/server.ts) (unprotected `/health` route).
- hivedoctor's probe target + read of the daemon PID: [`honeycomb/hivedoctor/src/config.ts:36-38,53,75,155`](../../../../honeycomb/hivedoctor/src/config.ts); [`honeycomb/hivedoctor/src/health-probe.ts:4`](../../../../honeycomb/hivedoctor/src/health-probe.ts).
- Deep Lake client surface: [`honeycomb/src/daemon/storage/client.ts:1-60`](../../../../honeycomb/src/daemon/storage/client.ts) (org resolution, forced scope, timeout, tracing, redaction).
- Runtime dir resolution: [`honeycomb/src/daemon/runtime/auth/credentials-store.ts:71`](../../../../honeycomb/src/daemon/runtime/auth/credentials-store.ts) (`.honeycomb`); [`honeycomb/src/daemon/runtime/assemble.ts:688-690`](../../../../honeycomb/src/daemon/runtime/assemble.ts).

No open questions. The port (3854), PID/lock filenames, and the `reasons`-block scope are flagged defaults above.
