# PRD-018a: Daemon lock and lifecycle correctness

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

The single-instance lock is the daemon's central correctness mechanism, and it has one verified critical bug plus two classic lock races: a failed second `start()` deletes the running daemon's lock (reproduced live; a third start then succeeds alongside the first), stale-lock reclaim is non-atomic, and a reused PID wedges startup forever. Around the lock sit three lifecycle defects: shutdown can hang indefinitely behind one active HTTP request (and `POST /build` runs a minutes-long brood inside the request handler), shutdown does not actually drain in-flight work before `process.exit(0)`, and the systemd service template omits the node interpreter, producing an infinite 5-second crash loop on the most common Linux install. Finally, two independent restart authorities (the OS service unit and the doctor registry policy) contend on the same lock, which compounds the rollback bug: every losing restart attempt destroys the winner's lock.

Every other epic in PRD-018 runs daemons in tests and in production; none of them are safe while a failed start can kill a healthy daemon. This epic lands first. Source evidence: [`2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) findings C1, H1, H2, H3, H4, M1, M2.

---

## Goals

- Lock release is ownership-checked: a process only ever removes a lock it actually acquired.
- Stale-lock reclaim is atomic and immune to PID reuse: two racing reclaims produce exactly one winner, and a reused PID is recognized as stale rather than "already running".
- Shutdown completes in bounded time: active connections are force-closed after a grace period, `/build` no longer holds a request open for minutes, and in-flight worker and boot work are drained (with a bounded timeout) before the lock is released and the process exits.
- The systemd unit execs through `process.execPath` exactly as the launchd and Scheduled Task templates do, and its restart rate limiting is finite.
- Exactly one restart authority supervises the daemon, with the decision recorded in this PRD (ADR-worthy note below).

## Non-Goals

- Wiring the registration/watch pipeline into daemon start. That is [PRD-018b](./prd-018b-wire-update-on-change.md); this epic only makes the lifecycle those changes hook into correct.
- The `?project=` tenancy override and non-loopback binding gate. API security is [PRD-018j](./prd-018j-api-security-and-registry-hardening.md).
- Atomicity of the doctor registry file itself (torn writes, dropped keys). That is NEC-032, owned by [PRD-018j](./prd-018j-api-security-and-registry-hardening.md); this epic only decides the restart-policy semantics the registry entry carries.
- The brood/enricher concurrency guard (`broodInFlight` bypass by auto-brood). That is NEC-011, owned by [PRD-018g](./prd-018g-enricher-correctness-and-concurrency.md); this epic makes `/build` bounded but does not arbitrate who may brood.
- Launchd log directory creation, systemd `daemon-reload` on reinstall, and other low-severity service polish. Batched in [PRD-018l](./prd-018l-docs-truth-pass-and-cleanup.md) under NEC-042.

---

## NEC-002: Failed daemon start deletes the live daemon's lock (double daemon, verified)

**Issue.** A `start()` that fails for any reason, including failing precisely because another daemon is already running, rolls back through `shutdown()`, which unconditionally deletes the lock and pid files. The next start then succeeds alongside the live daemon.

**Evidence** (daemon-api review C1):

- `src/daemon.ts:563-569`: when `start()` fails for ANY reason, the catch calls `await shutdown()` as rollback.
- `src/daemon.ts:572-584`: `shutdown()` guards only on `closed` (initialized `false` at `daemon.ts:516`), then unconditionally calls `releaseSingleInstanceLock(lockPaths)`.
- `src/lock.ts:114-117`: `releaseSingleInstanceLock` is `rmSync(force)` on both files with no ownership check; it never verifies the lock still records this process's pid.
- Verified by live repro against `dist/`: after a second start threw `DaemonAlreadyRunningError`, the first daemon's lock file was gone and a third start succeeded on another port, giving two daemons.
- The existing test asserts the second start throws but never asserts the first daemon's lock survived (`test/daemon.test.ts:104-122`), which is why this went unnoticed.

**Failure mode.** Any accidental second `nectar daemon` (or a supervisor restart racing a manual run) silently deletes the live daemon's lock and pid: the next start yields two daemons, two enricher loops, duplicate LLM spend, and racing projection writes. Doctor supervises via `pidPath` (`doctor-registry.ts:114`); deleting `nectar.pid` breaks supervision of the healthy daemon. Under an always-restart OS unit, a losing unit retries every 5 seconds and deletes the winner's lock on every cycle.

**Fix direction.** Two complementary changes, both from the review's fix direction:

1. Make release ownership-checked: `releaseSingleInstanceLock` reads the lock file first and removes it only if it records `process.pid` (plus the identity token from NEC-020 once that lands).
2. Track a `lockAcquired` flag in `start()` so the rollback path releases only what this instance actually acquired; a start that failed inside `acquireSingleInstanceLock` never touches the lock files at all.

---

## NEC-020: Non-atomic stale reclaim and PID-reuse wedge

**Issue.** Stale-lock reclaim is rm-then-retry, so two racing restarts can both "win"; and lock liveness is judged by a bare recorded PID, so a reused PID reads as "already running" forever.

**Evidence** (daemon-api review H1 and H2):

- `src/lock.ts:73-103`: on `EEXIST` with a dead recorded PID, the code does `rmSync(lockFilePath)` then loops to retry `openSync(..., "wx")`. Two processes reacting to the same crash (doctor restart and the OS unit restart) can both read the same stale PID; A removes and re-creates the lock; B then removes A's fresh lock (the `rmSync` at `lock.ts:84` is unconditional) and creates its own. Both proceed to bind; the port loser's rollback then triggers NEC-002 and deletes the winner's lock.
- `src/lock.ts:66-108` treats "recorded PID is alive" (`isPidAlive`, `lock.ts:32-42`, including `EPERM` mapped to alive) as "a nectar daemon holds the lock". The lock file lives in `~/.honeycomb` and survives reboot; after a crash or reboot the stale PID can be reused by an arbitrary unrelated process, and `acquireSingleInstanceLock` throws `DaemonAlreadyRunningError` forever.
- `test/lock.test.ts:54` covers the dead-PID reclaim but nothing covers PID reuse or a concurrent reclaim race.

**Failure mode.** The reclaim race yields two bound daemons (or one daemon plus a lock-destroying crash loop via NEC-002). The PID-reuse wedge is an eternal 5-second crash-restart loop under the OS unit until an operator manually deletes `~/.honeycomb/nectar.lock`.

**Fix direction.** Pick one coherent design covering both findings; the review offers three, in rising order of platform leverage:

1. Atomic replace reclaim: write a temp lock with own identity, `rename` over the stale one only after re-reading that the stale content is unchanged, then re-read after creation to confirm ownership before proceeding.
2. Stronger identity than a bare pid: record pid plus process start time, or a random boot token also written to the pid file, so a reused PID no longer masquerades as a live daemon.
3. An OS-level advisory `flock` held on an open descriptor for the daemon's lifetime: releases automatically on process death and is immune to PID reuse; the file content then becomes purely informational.

Option 3 subsumes both races and is the preferred direction if its portability across macOS/Linux/Windows (via the Node APIs available without new runtime dependencies) checks out; otherwise combine options 1 and 2. Whatever is chosen, the ownership check from NEC-002 must key on the same identity.

---

## NEC-021: Shutdown hangs forever behind one active request; `/build` runs a brood in-request

**Issue.** `close()` never force-closes active connections, and `POST /build` runs a full brood synchronously inside the request handler, so a shutdown during a brood blocks until the supervisor SIGKILLs the process, leaving a stale lock.

**Evidence** (daemon-api review H3):

- `src/server.ts:132-138`: `close()` waits for `server.close()` and only calls `closeIdleConnections()`; an active request is never destroyed.
- `api/hive-graph-api.ts:181-206` awaits `runBrood` inside the handler, wired to `runBroodAsync` at `api/daemon-api-wiring.ts:152-169`; on a real repo this takes minutes.
- A SIGTERM during that window (`daemon.ts:591-600`) blocks at `await server.close()` (`daemon.ts:578-581`) forever; systemd's default 90s / launchd's grace then SIGKILLs the process. The lock file is never released (feeding the NEC-020 stale-lock path), telemetry never closes, and the drain-then-exit log never happens.

**Failure mode.** Every deploy or reboot that lands during a brood produces an unclean kill and a stale lock; combined with the PID-reuse wedge this can require manual lock deletion to recover.

**Fix direction.** Both halves of the review's direction:

1. After `server.close()` is initiated, force-close remaining connections after a short grace period: call `closeAllConnections()` (or destroy tracked sockets) once the grace elapses, so shutdown is bounded regardless of request activity.
2. Make `/build` asynchronous: respond `202 Accepted` with a poll handle and run the brood in the background (the status endpoint already exists as a natural polling surface), or at minimum bound the in-request work so no request outlives seconds. The `broodInFlight` guard semantics stay as they are; PRD-018g extends them to auto-brood.

---

## NEC-022: systemd template omits the node interpreter; infinite crash loop

**Issue.** The systemd unit execs the CLI entry script directly and relies on the shebang finding `node` on the systemd user manager's PATH; on nvm/fnm/volta installs it does not exist there, and the unit's restart policy has rate limiting disabled.

**Evidence** (daemon-api review H4):

- `src/service/templates.ts:103-122`: `ExecStart="{execPath}" daemon` execs the CLI entry (`process.argv[1]`, `cli.ts:94-96`) directly. The launchd and Scheduled Task templates correctly prefix `process.execPath` (`templates.ts:65,77` and `:136-137,173`).
- With `Restart=always` + `RestartSec=5` + `StartLimitIntervalSec=0` (`templates.ts:115-117`), a failing exec is an infinite 5-second crash loop with no rate limiting, silently burning CPU and journal space.
- `test/service-templates.test.ts` snapshots the current (broken) shape, so the suite actively defends the bug.

**Failure mode.** On the most common Linux node install, `nectar install` produces a service that never starts and retries forever.

**Fix direction.** Render `ExecStart=${quoteSystemdToken(process.execPath)} ${quoteSystemdToken(plan.execPath)} daemon`, exactly parallel to the other two platforms; replace the disabled rate limiting with a finite `StartLimitBurst` (and a non-zero `StartLimitIntervalSec`) so a genuinely broken unit stops retrying and surfaces a failed state instead.

---

## NEC-030: Two restart authorities contend on one lock

**Issue.** `nectar install` both installs an always-restart OS unit and writes a doctor registry entry carrying doctor-side restart policy. If both authorities act, the loser sits in a permanent restart loop against the lock, and via NEC-002 each losing attempt destroys the winner's lock.

**Evidence** (daemon-api review M1):

- `service/index.ts:189-255`: launchd `KeepAlive` / systemd `Restart=always` installed by `nectar install`.
- `doctor-registry.ts:72-75,101-121`: the registry entry carries `restartGiveUpThreshold` and `restartCooldownMs`, i.e. doctor-side restart policy.
- ADR-0003's diagram has doctor spawning workload daemons from the registry; ADR-0004 (section 1) says workload daemons are booted by the OS service manager. The two documents disagree about who restarts nectar.

**Failure mode.** Doctor spawns nectar while the OS unit also restarts it; the loser loops against the lock every cooldown period, and each attempt is a live NEC-002 trigger until that fix lands.

**Decision (ADR-worthy note).** This PRD decides: **the OS service unit is the single restart authority.** Doctor probes health and reports; it does not spawn or restart nectar when an OS unit is installed. Rationale: the OS unit is the boot-time authority anyway (it is what starts the daemon at login/boot), it survives doctor itself being down, and demoting doctor to observe-only is a data-only change (registry entry fields) rather than a service-template change on three platforms. The rejected alternative (doctor restarts, unit is `RunAtLoad`/`oneshot`-only) keeps restart logic in one codebase but makes liveness depend on doctor's own liveness and contradicts ADR-0004's boot story. Concretely: the registry entry written by `nectar install` must signal restarts-owned-by-OS-unit (whether by omitting restart policy fields, a explicit `restartPolicy: "external"` marker, or whatever vocabulary the doctor registry schema supports), and ADR-0003's diagram gets a follow-up correction in the [PRD-018l](./prd-018l-docs-truth-pass-and-cleanup.md) docs pass. Even after this decision, the loser's failure mode must be benign, which the NEC-002 ownership check guarantees.

---

## NEC-033: Shutdown does not drain in-flight work before `process.exit(0)`

**Issue.** `worker.stop()` only disarms the poll loop; an in-flight job continues, and the background boot tasks are never awaited, yet the signal handler exits the process as soon as `shutdown()` resolves.

**Evidence** (daemon-api review M2):

- `daemon.ts:572-589`: `worker.stop()` only disarms the poll loop; an in-flight job continues (`poll-loop.ts:82-90`, "an in-flight tick is allowed to finish").
- The background boot tasks (`bootSettled`: projection load/inherit writes, auto-brood) are never awaited even though `awaitBoot()` exists "for ... orderly shutdown" (`daemon.ts:324-330`).
- The signal handler `process.exit(0)`s as soon as `shutdown()` resolves (`daemon.ts:594-597`), killing an in-flight describe/store write or inherit write mid-flight. The documented "Drain worker -> close socket" contract (`daemon.ts:303`) is not met.

**Failure mode.** Store writes and projection writes are killed mid-flight on every shutdown that catches the worker busy. Brood resumability and the queue-lease reaper make this survivable, but it violates the daemon's own documented contract and multiplies the write-atomicity issues PRD-018d and PRD-018g address.

**Fix direction.** In `shutdown()`, expose and `await` the in-flight tick promise from `PollLoop`, and `await bootSettled`, both under a bounded timeout (a drain that exceeds the timeout logs and proceeds; shutdown must still be bounded per NEC-021). Only after the drain completes (or times out) is the lock released and the process allowed to exit.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-018a.1 | Given a running daemon holding the lock, when a second `start()` fails with `DaemonAlreadyRunningError`, then the first daemon's lock and pid files still exist and a third start attempt still throws `DaemonAlreadyRunningError`. |
| AC-018a.2 | Given a `start()` that acquired the lock and then failed (for example a bind error), when the rollback runs, then the lock and pid files this instance created are removed, and a subsequent start succeeds. |
| AC-018a.3 | Given a lock file recording a different live process's identity, when `releaseSingleInstanceLock` is called by a process that does not own it, then neither the lock nor the pid file is removed. |
| AC-018a.4 | Given a stale lock (recorded process dead) and two processes attempting reclaim concurrently, when both run `acquireSingleInstanceLock`, then exactly one acquires the lock, the other fails, and the winner's lock file is intact afterward. |
| AC-018a.5 | Given a lock file whose recorded PID is alive but belongs to a process that is not the daemon that wrote the lock (PID reuse; identity token or start time mismatch), when `acquireSingleInstanceLock` runs, then the stale lock is reclaimed and acquisition succeeds instead of throwing `DaemonAlreadyRunningError`. |
| AC-018a.6 | Given a shutdown initiated while one HTTP request is still active, when the configured grace period elapses, then remaining connections are force-closed and `shutdown()` resolves within a bounded time. |
| AC-018a.7 | Given `POST /api/hive-graph/build` on a project whose brood takes longer than the shutdown grace, when the request is accepted, then the HTTP response returns within seconds (202 with a pollable status) and the brood continues in the background; no request handler awaits a full brood. |
| AC-018a.8 | Given the rendered systemd unit template, then `ExecStart` begins with the quoted `process.execPath` followed by the quoted CLI entry path and `daemon` (matching the launchd and schtasks shape), and the unit declares a finite `StartLimitBurst` with a non-zero `StartLimitIntervalSec`. |
| AC-018a.9 | Given `nectar install` on a platform with an OS service unit, when the doctor registry entry is written, then the entry marks restarts as owned by the OS unit (doctor probe-only), per the restart-authority decision in this PRD. |
| AC-018a.10 | Given a shutdown initiated while a worker tick is in flight and `bootSettled` is unresolved, when `shutdown()` runs, then it awaits the in-flight tick and `bootSettled` under a bounded timeout before releasing the lock, and `process.exit(0)` happens only after `shutdown()` resolves. |
| AC-018a.11 | Given the drain timeout elapses with work still in flight, when `shutdown()` proceeds, then it logs the timed-out drain and still completes in bounded time (drain must not reintroduce the NEC-021 hang). |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/lock.ts` | modify | Ownership-checked release; atomic reclaim (or `flock`-based redesign); stronger lock identity (pid + start time or boot token) |
| `src/daemon.ts` | modify | `lockAcquired` flag in `start()` rollback; drain in-flight tick and `bootSettled` with bounded timeout in `shutdown()`; exit only after shutdown resolves |
| `src/server.ts` | modify | Force-close active connections after a grace period once `close()` is initiated |
| `src/api/hive-graph-api.ts` | modify | `/build` returns 202 with a pollable status instead of awaiting the brood in-request |
| `src/api/daemon-api-wiring.ts` | modify | Background brood execution behind the 202 contract |
| `src/poll-loop.ts` | modify | Expose the in-flight tick promise so `shutdown()` can await it |
| `src/service/templates.ts` | modify | systemd `ExecStart` prefixes `process.execPath`; finite `StartLimitBurst` / non-zero `StartLimitIntervalSec` |
| `src/service/index.ts` | modify | Install path carries the restart-authority marker into the registry entry (if plumbing is needed) |
| `src/doctor-registry.ts` | modify | Registry entry signals restarts-owned-by-OS-unit (probe-only doctor policy) |
| `test/lock.test.ts` | modify | Ownership, reclaim-race, and PID-reuse regression tests |
| `test/daemon.test.ts` | modify | Survivor-lock regression, rollback-releases-own-lock, drain-before-exit tests |
| `test/server.test.ts` (or the suite covering `server.ts`) | modify/create | Force-close-after-grace test |
| `test/api-router.test.ts` | modify | Async `/build` contract test |
| `test/service-templates.test.ts` | modify | Update the snapshot to the fixed systemd shape; assert `process.execPath` appears |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018a.1 | `test/daemon.test.ts` | After a failed second start, assert the survivor's lock and pid files still exist and a third start still throws (the review notes this exact gap in `test/daemon.test.ts:104-122`; would have caught NEC-002). |
| AC-018a.2 | `test/daemon.test.ts` | Start that fails post-acquire (injected bind failure) releases its own lock; next start succeeds. |
| AC-018a.3 | `test/lock.test.ts` | Release invoked against a lock owned by another live identity is a no-op. |
| AC-018a.4 | `test/lock.test.ts` | Two concurrent reclaims of one stale lock: exactly one winner; loser's failure does not remove the winner's lock (covers the unconditional `rmSync` at `lock.ts:84`). |
| AC-018a.5 | `test/lock.test.ts` | Lock recording a live-but-foreign PID (simulated identity mismatch) is reclaimed instead of wedging (`test/lock.test.ts:54` covers dead-PID only; this covers reuse). |
| AC-018a.6 | `test/server.test.ts` | SIGTERM/`close()` with one active in-flight request resolves within the grace bound and destroys the straggler connection. |
| AC-018a.7 | `test/api-router.test.ts` | `POST /build` responds 202 promptly while a slow injected brood is still running; status is pollable to completion. |
| AC-018a.8 | `test/service-templates.test.ts` | systemd template assertion: `ExecStart` contains `process.execPath` before the entry script; `StartLimitBurst` finite (the review calls out that even a template-level assertion would do). |
| AC-018a.9 | `test/doctor-registry.test.ts` (or the suite covering registry writes) | Install-written registry entry marks the OS unit as restart owner. |
| AC-018a.10, AC-018a.11 | `test/daemon.test.ts` | Shutdown with an in-flight worker tick and pending `bootSettled`: both awaited before lock release; a hung drain hits the timeout and shutdown still resolves. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md) : the PRD-018 program index.
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) : NEC-002, NEC-020, NEC-021, NEC-022, NEC-030, NEC-033.
- [`../../../notes/2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) : AUTHORITATIVE evidence: findings C1, H1, H2, H3, H4, M1, M2 and the test-coverage gap list.
- [`../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) : the supervision topology the restart-authority decision resolves (diagram correction follows in 018l).
- [`../../../knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md`](../../../knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) : section 1's OS-service-manager boot story this PRD's decision aligns with.
- [`./prd-018j-api-security-and-registry-hardening.md`](./prd-018j-api-security-and-registry-hardening.md) : atomic doctor-registry writes (NEC-032) that the AC-018a.9 registry change must not conflict with.
- [`./prd-018g-enricher-correctness-and-concurrency.md`](./prd-018g-enricher-correctness-and-concurrency.md) : the `broodInFlight` guard extension that builds on the async `/build` from this epic.
