# PRD-003a: `/health` endpoint + PID/lock file

> Parent: [`prd-003-hivenectar-supervision-index.md`](./prd-003-hivenectar-supervision-index.md)

## Overview

hivenectar's two supervision prerequisites live here: a **`/health` endpoint** that answers the coarse status hivedoctor's probe classifies on, and a **single-instance PID/lock file** at the path hivedoctor's restart rung reads to respect hivenectar's own liveness. Both are modeled directly on honeycomb's existing `/health` route and `acquireSingleInstanceLock` pattern, scoped to hivenectar's port (3854) and distinct filenames.

This sub-PRD implements the process-surface contract PRD-001b already locked — it does not redefine port 3854, the `~/.honeycomb/hivenectar.*` filenames, or the coarse health bit. It specifies the hivenectar-side wiring that makes those values real and probeable.

## Goals

- hivenectar mounts an unprotected `/health` route that returns a **purpose-built** body: the top-level `ok`/`degraded` status bit (what hivedoctor classifies on) plus hivenectar-native subsystem fields (brooding progress, enricher queue depth + last file, projection last-write, cost telemetry, embeddings provider, portkey state). **Not** a parity copy of honeycomb's `/health` — hivenectar answers different operational questions. Full body shape is owned by [PRD-001b](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md) § "/health endpoint contract"; this PRD wires the route + the HTTP-status gating.
- `/health` returns `200` when healthy and `503` when degraded (so a client distinguishes daemon-down from a down sub-dependency, exactly as honeycomb gates at `server.ts:318-341`).
- hivenectar acquires a single-instance lock before binding the socket, writes `~/.honeycomb/hivenectar.pid` + `~/.honeycomb/hivenectar.lock`, throws on a live second start, and reclaims a stale lock.
- The PID file is operator-facing convenience (a single `ls ~/.honeycomb/*.pid` enumerates every live daemon); the lock file is what the guard checks.

## Non-Goals

- hivenectar's composition root, bootstrap sequence, and the graceful shutdown that *removes* the PID/lock — **PRD-002**. This PRD states the requirement (a clean restart leaves no `hivenectar.lock`) but does not implement the signal handlers.
- The `/health` **body shape** (which subsystem fields, the JSON structure) — owned by [PRD-001b](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md). This PRD specifies the route + HTTP-status gating + the top-level status bit hivedoctor consumes; it does not re-enumerate the subsystem fields.
- Parity with honeycomb's mode-gated `reasons` block — explicitly rejected (decision #20 revised). hivenectar carries its own hivenectar-native fields instead.
- hivedoctor's probe implementation (the `node:http` GET over a short timeout) — hivedoctor owns that; this PRD specifies only the contract hivenectar satisfies.
- The OS service unit that *starts* hivenectar — **003b**.

---

## `/health` endpoint contract

hivenectar exposes an unprotected `/health` route, mirroring honeycomb's `/health` route group (`server.ts:71-96` registers `{ path: "/health", protect: false, session: false }` at `:72`, and the handler gates the HTTP status on the coarse pipeline bit at `server.ts:318-341`).

| Property | Value | Citation / status |
|---|---|---|
| Path | `/health` | mirrors [`honeycomb/src/daemon/runtime/server.ts:72`](../../../../honeycomb/src/daemon/runtime/server.ts) |
| Protection | unprotected (no auth, no session) | mirrors `server.ts:72` `{ path: "/health", protect: false, session: false }` |
| Coarse status | `"ok" \| "degraded"` | honeycomb's `PipelineStatus` adds `"unconfigured"` ([`health.ts:42`](../../../../honeycomb/src/daemon/runtime/health.ts)); hivenectar reports `ok`/`degraded` — see default below |
| HTTP gate | `200` when ok, `503` when degraded | mirrors [`server.ts:318-341`](../../../../honeycomb/src/daemon/runtime/server.ts) (status = pipeline degraded ? 503 : 200) |
| hivedoctor probe URL | `http://127.0.0.1:3854/health` | port 3854 confirmed in [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md); modeled on [`hivedoctor/src/config.ts:75`](../../../../hivedoctor/src/config.ts) default `http://127.0.0.1:3850/health` |
| **Body shape** | **purpose-built** (not honeycomb parity) | owned by [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md) § "/health endpoint contract" — the top-level `status` is what hivedoctor classifies on; the brooding/enricher/projection/cost/embeddings/portkey fields are operator-facing detail |

hivedoctor probes this endpoint identically to how it probes honeycomb today — a `GET /health` over `node:http` with a short timeout — and classifies on the coarse status. The supervisor's `tick` reads the probe result and routes `ok` vs anything-else into the heal path ([`hivedoctor/src/supervisor.ts:261-320`](../../../../hivedoctor/src/supervisor.ts)). The body's subsystem fields are for thehive dashboard and CLI triage; hivedoctor ignores them.

### Response shape (DEFAULT — confirm before implementation)

**DEFAULT — confirm before implementation.** The `/health` response shape mirrors honeycomb's body, with a `checks` map in place of honeycomb's mode-gated `reasons` block:

```json
{
  "status": "ok",
  "uptimeMs": 123456,
  "checks": {
    "storage": "reachable",
    "embeddings": "on"
  }
}
```

- `status`: the coarse bit — `"ok"` or `"degraded"` (hivedoctor classifies on this alone).
- `uptimeMs`: milliseconds since the daemon's socket bound (mirrors honeycomb's `uptimeMs: Date.now() - startedAt` at [`server.ts:334`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- `checks`: a per-subsystem coarse map naming which sub-dependency is down (mirrors honeycomb's `reasons` block, [`health.ts:70-79`](../../../../honeycomb/src/daemon/runtime/health.ts)). hivenectar's checks are its own dependencies — Deep Lake storage reachability and the embeddings seam — read from already-cached daemon state (no synchronous probe in `/health`, per honeycomb's D-4 principle at [`health.ts:20-30`](../../../../honeycomb/src/daemon/runtime/health.ts)).

> **Why a `checks` map and not honeycomb's `reasons` block verbatim.** honeycomb's `reasons` names storage/embeddings/schema/portkey because those are honeycomb's dependencies. hivenectar's sub-dependencies differ (no Portkey in `/health`; the embeddings seam and Deep Lake storage are the load-bearing ones for the source-graph job). The *principle* is identical — name which subsystem is down, never leak a secret — and every value is a fixed string literal so a check can never carry a credential (the same redaction posture [`health.ts:14-19`](../../../../honeycomb/src/daemon/runtime/health.ts) enforces). Whether hivenectar adopts honeycomb's exact `HealthReasons` shape or its own `checks` map is the default to confirm.

---

## Single-instance PID/lock guard

hivenectar reuses honeycomb's single-instance lock pattern: write `<name>.pid` + `<name>.lock` under the runtime dir before binding the socket; if a lock exists and its recorded PID is alive, refuse to double-bind; a stale lock (dead PID) is reclaimed.

| Property | Value | Citation / status |
|---|---|---|
| Runtime dir | `~/.honeycomb` | [`honeycomb/src/daemon/runtime/auth/credentials-store.ts:71`](../../../../honeycomb/src/daemon/runtime/auth/credentials-store.ts) `LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb"`; resolved at [`assemble.ts:688-690`](../../../../honeycomb/src/daemon/runtime/assemble.ts) |
| PID file | `~/.honeycomb/hivenectar.pid` | confirmed in [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md) |
| Lock file | `~/.honeycomb/hivenectar.lock` | confirmed in [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md) |
| Guard | throw before bind on live PID; reclaim stale | mirrors [`assemble.ts:715-732`](../../../../honeycomb/src/daemon/runtime/assemble.ts) |

The pattern to mirror is `acquireSingleInstanceLock` ([`honeycomb/src/daemon/runtime/assemble.ts:715-732`](../../../../honeycomb/src/daemon/runtime/assemble.ts)):

- `mkdirSync(runtimeDir, { recursive: true })`.
- read the existing PID via `readPidFile` ([`assemble.ts:734-745`](../../../../honeycomb/src/daemon/runtime/assemble.ts)) — absent/unreadable/garbage returns `null`.
- `isPidAlive(existingPid)` (signal-0 probe; `ESRCH` → stale, `EPERM` → alive-but-other-user) — a live PID throws `DaemonAlreadyRunningError` ([`assemble.ts:721-723`](../../../../honeycomb/src/daemon/runtime/assemble.ts)) **before the socket bind**, so the port is never double-bound.
- on a fresh or stale-reclaimed lock, stamp `process.pid` into both files ([`assemble.ts:725-730`](../../../../honeycomb/src/daemon/runtime/assemble.ts)): the lock is what the guard checks, the PID file is operator-facing convenience.

hivenectar's filenames (`hivenectar.pid`/`hivenectar.lock`) differ from honeycomb's (`daemon.pid`/`daemon.lock`, the constants at [`assemble.ts:184,186`](../../../../honeycomb/src/daemon/runtime/assemble.ts)) so the two daemons' locks coexist in the same `~/.honeycomb` dir. A single `ls ~/.honeycomb/*.pid` enumerates every live daemon — the same operator convenience honeycomb's PID file provides ([`assemble.ts:726-727`](../../../../honeycomb/src/daemon/runtime/assemble.ts) comment: "`cat ~/.honeycomb/daemon.pid`").

> **Why a distinct lock, not a shared one.** hivedoctor already reads `~/.honeycomb/daemon.pid` to respect honeycomb's lock during restart ([`hivedoctor/src/config.ts:53,155`](../../../../hivedoctor/src/config.ts) `daemonPidPath` default `~/.honeycomb/daemon.pid`). hivenectar's registry entry (003c) points hivedoctor at `~/.honeycomb/hivenectar.pid` instead, so hivedoctor's restart rung respects the right daemon's lock. Two daemons cannot share one lock file — that would make the second one refuse to start.

The graceful shutdown that *removes* the PID/lock is PRD-002's contract: `SIGINT`/`SIGTERM` drain services, close the socket, and remove both files (mirroring honeycomb's `runAssembledDaemon` close path at [`honeycomb/src/daemon/index.ts:166-187`](../../../../honeycomb/src/daemon/index.ts) — the idempotent `close`, `process.once("SIGINT"/"SIGTERM", …)`). This PRD's acceptance is that a clean restart leaves no `hivenectar.lock` behind, so the next `acquireSingleInstanceLock` does not falsely report "already running."

---

## User stories

### US-003a.1 — hivedoctor probes hivenectar's /health and classifies
**As** hivedoctor, **when** I probe `GET http://127.0.0.1:3854/health`, **I** receive a `200`/`503` with a coarse `status: "ok"|"degraded"` body, **so that** my supervisor's `tick` routes the result into the ok branch or the heal path exactly as it does for honeycomb.

- Acceptance: `/health` is unprotected and returns `200` + `status: "ok"` when healthy.
- Acceptance: when a sub-dependency is down, `/health` returns `503` + `status: "degraded"` (mirroring [`server.ts:318-341`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- Acceptance: hivedoctor's supervisor classifies the probe result without code change — the contract is the coarse `status` field (mirroring [`supervisor.ts:261-320`](../../../../hivedoctor/src/supervisor.ts)).

### US-003a.2 — A second hivenectar start refuses to double-bind
**As an** operator, **when** I start a second hivenectar while one is running, **the** second start throws before binding port 3854, **so that** the port is never double-bound.

- Acceptance: a live `~/.honeycomb/hivenectar.lock` PID causes the second start to throw a `DaemonAlreadyRunningError`-equivalent before the socket bind (mirroring [`assemble.ts:720-723`](../../../../honeycomb/src/daemon/runtime/assemble.ts)).
- Acceptance: a stale lock (dead PID) is reclaimed, so a crashed daemon does not wedge the next start.

### US-003a.3 — The PID file is operator-facing; the lock is the guard
**As an** operator, **when** I run `ls ~/.honeycomb/*.pid`, **I** see `daemon.pid` and `hivenectar.pid`, **so that** I can enumerate every live daemon from one directory.

- Acceptance: both the PID and lock files carry `process.pid` (mirroring [`assemble.ts:728-730`](../../../../honeycomb/src/daemon/runtime/assemble.ts)).
- Acceptance: the filenames are `hivenectar.pid`/`hivenectar.lock`, distinct from honeycomb's `daemon.pid`/`daemon.lock` ([`assemble.ts:184,186`](../../../../honeycomb/src/daemon/runtime/assemble.ts)).

### US-003a.4 — A restart leaves no stale lock
**As** hivedoctor, **when** I restart hivenectar, **the** graceful shutdown removes `~/.honeycomb/hivenectar.lock`, **so that** the next start is not falsely blocked.

- Acceptance: `SIGINT`/`SIGTERM` drain services, close the socket, and remove the PID/lock files (mirroring [`honeycomb/src/daemon/index.ts:166-187`](../../../../honeycomb/src/daemon/index.ts)) — this is PRD-002's contract; this PRD's acceptance is the observable outcome.
- Acceptance: close is idempotent; a second signal is ignored.

---

## Implementation notes

- `/health` route + HTTP gate: [`honeycomb/src/daemon/runtime/server.ts:71-96`](../../../../honeycomb/src/daemon/runtime/server.ts) (ROUTE_GROUPS, `/health` unprotected at `:72`); [`honeycomb/src/daemon/runtime/server.ts:318-341`](../../../../honeycomb/src/daemon/runtime/server.ts) (the handler: `status = pipeline === "degraded" ? 503 : 200`, `uptimeMs`, the additive reasons block).
- Health contract + builder: [`honeycomb/src/daemon/runtime/health.ts:42`](../../../../honeycomb/src/daemon/runtime/health.ts) (`PipelineStatus = "ok" | "degraded" | "unconfigured"`); [`health.ts:70-152`](../../../../honeycomb/src/daemon/runtime/health.ts) (`HealthReasons`, `buildHealthDetail`, `publicHealthDetail` mode-gating — the pattern hivenectar's `checks` map mirrors).
- Single-instance lock: [`honeycomb/src/daemon/runtime/assemble.ts:184,186`](../../../../honeycomb/src/daemon/runtime/assemble.ts) (`LOCK_FILE_NAME = "daemon.lock"`, `PID_FILE_NAME = "daemon.pid"`); [`assemble.ts:715-732`](../../../../honeycomb/src/daemon/runtime/assemble.ts) (`acquireSingleInstanceLock`); [`assemble.ts:734-745`](../../../../honeycomb/src/daemon/runtime/assemble.ts) (`readPidFile`); [`assemble.ts:747-756`](../../../../honeycomb/src/daemon/runtime/assemble.ts) (`releaseSingleInstanceLock`).
- Graceful shutdown (the contract this PRD's AC depends on): [`honeycomb/src/daemon/index.ts:166-187`](../../../../honeycomb/src/daemon/index.ts) (`close`, `onSignal`, `process.once("SIGINT"/"SIGTERM", …)`).
- hivedoctor probe + supervisor classification: [`hivedoctor/src/config.ts:36-38,53,75,155`](../../../../hivedoctor/src/config.ts); [`hivedoctor/src/supervisor.ts:261-320`](../../../../hivedoctor/src/supervisor.ts) (the `tick` that routes ok vs unhealthy).
- Runtime dir resolution: [`honeycomb/src/daemon/runtime/auth/credentials-store.ts:71`](../../../../honeycomb/src/daemon/runtime/auth/credentials-store.ts) (`.honeycomb`); [`honeycomb/src/daemon/runtime/assemble.ts:688-690`](../../../../honeycomb/src/daemon/runtime/assemble.ts).

No open questions. The `/health` response shape (the `checks` map vs honeycomb's `reasons` block, and whether `"unconfigured"` is a third state hivenectar reports) is a flagged default above.
