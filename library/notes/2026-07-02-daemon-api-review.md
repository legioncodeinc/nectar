# Daemon lifecycle, lock, API, service & projection review — 2026-07-02

Scope: `src/daemon.ts`, `src/worker.ts`, `src/lock.ts`, `src/server.ts`, `src/cli.ts`,
`src/config.ts`, `src/health.ts`, `src/doctor-registry.ts`, `src/errors.ts`, `src/api/*`,
`src/projection/*`, `src/service/*`, `src/portkey/*`, `src/telemetry*/`, checked against
ADR-0002/0003/0004 and `library/knowledge/private/data/portable-registry.md`, plus the
relevant tests (`test/daemon.test.ts`, `test/lock.test.ts`, `test/api-router.test.ts`,
`test/health.test.ts`, `test/service-*.test.ts`, `test/projection-ac.test.ts`).

## Summary

The daemon plumbing is unusually disciplined for its stage: lock-before-bind ordering
(`daemon.ts:523-559`), atomic temp+rename projection writes (`projection/write.ts:56-73`),
a 1 MiB request-body cap with a real 413 (`api/router.ts:36`, `244-290`), permission
middleware mounted at the group prefix so unfilled endpoints still pass the gate
(`api/router.ts:209-219`), prototype-pollution and file-size guards on the untrusted
committed projection (`projection/load.ts:35-38,104-121`), secret-free Portkey error
mapping (`portkey/transport.ts:183-198`), and fail-soft, redacted telemetry
(`telemetry/logs.ts:43-58`). However, the single-instance lock — the daemon's central
correctness mechanism — has one **verified critical bug** (a *failed* second start deletes
the *running* daemon's lock and pid files; reproduced live: a third start then succeeds
alongside the first) plus two classic lock races (non-atomic stale reclaim, PID reuse).
Shutdown can hang forever behind one active HTTP request, and the "drain" contract is not
actually met before `process.exit(0)`. The systemd service template omits the node
interpreter, which crash-loops every 5 s forever on nvm-installed Linux boxes. The API has
no auth (documented) but also allows an unauthenticated `?project=` cross-project override
on search **and build**. Against the spec, the topology (independent daemon, `/health`,
lock+pid, doctor registry entry, hive-consumable `/api/hive-graph/*`) matches
ADR-0002/0003/0004; the portable-registry projection matches the documented format and
validation, but of the three spec'd regeneration triggers only #1 (end of brood) and #3
(explicit rebuild) are live — the enricher-cycle trigger (#2) has a seam that production
wiring never fills — and the live-watch (NodeFS) path from the mission statement is not
instantiated by the shipped daemon at all.

Findings below are ordered by severity. Line numbers verified against the working tree at
review time.

---

## Critical

### C1. A failed `start()` deletes another live daemon's lock and pid files → double daemon (verified)

- `src/daemon.ts:563-569` — when `start()` fails for ANY reason, the catch calls
  `await shutdown()` as "rollback".
- `src/daemon.ts:572-584` — `shutdown()` guards only on `closed` (initialized `false` at
  `daemon.ts:516`), then unconditionally calls `releaseSingleInstanceLock(lockPaths)`.
- `src/lock.ts:114-117` — `releaseSingleInstanceLock` is `rmSync(force)` on both files with
  **no ownership check** (it never verifies the lock still records *this* process's pid).

So when `acquireSingleInstanceLock` throws `DaemonAlreadyRunningError` (the exact
double-start case the lock exists for), the rollback deletes the **running** daemon's
`nectar.lock` and `nectar.pid`. Verified with a live repro against `dist/`:

```
lock exists after first start:          true
second start threw:                     DaemonAlreadyRunningError
lock exists after second failed start:  false     <-- live daemon's lock deleted
third start SUCCEEDED on port 38127     => two daemons running
```

Failure modes for a real user:
1. Any accidental second `nectar daemon` (or a supervisor restart racing a manual run)
   silently deletes the live daemon's lock/pid. The next start succeeds → **two daemons**,
   two enricher loops, duplicate LLM spend, racing projection writes.
2. Doctor supervises via `pidPath` (`doctor-registry.ts:114`); deleting `nectar.pid` out
   from under it breaks supervision of the healthy daemon.
3. Under the OS unit's restart-on-crash (launchd `KeepAlive`, systemd `Restart=always`),
   a losing unit retries every 5 s and deletes the winner's lock on **every** cycle.

The existing test (`test/daemon.test.ts:104-122`) asserts the second start throws but never
asserts the first daemon's lock survived — which is why this went unnoticed.

**Fix direction:** make release ownership-checked (read the lock, `rm` only if it records
`process.pid`), and/or track a `lockAcquired` flag in `start()` so the rollback path only
releases what this instance actually acquired. Add a regression test: after a failed second
start, first's lock file still exists and a third start still throws.

---

## High

### H1. Stale-lock reclaim is not atomic — two crashed-daemon restarts can both "win"

`src/lock.ts:73-103`: on `EEXIST` with a dead recorded PID, the code does
`rmSync(lockFilePath)` then loops to retry `openSync(..., "wx")`. Two processes (e.g.
doctor's supervisor restart and the OS unit restart, both reacting to the same crash) can
both read the same stale PID; A `rm`s and re-creates the lock; B then `rm`s **A's fresh
lock** (its `rmSync` at `lock.ts:84` is unconditional) and creates its own. Both proceed to
bind; with identical ports one loses at `EADDRINUSE` — but its rollback then triggers C1
and deletes the winner's lock. With distinct `NECTAR_PORT`s, both run.

**Fix direction:** reclaim via atomic replace (write a temp lock with own pid,
`rename` over the stale one only after re-reading that the stale pid is unchanged), or
verify ownership after creation (re-read the lock and confirm it contains own pid before
proceeding), or hold an OS-level `flock` on an open descriptor for the daemon's lifetime.

### H2. PID reuse permanently wedges startup after a crash

`src/lock.ts:66-108` treats "recorded PID is alive" (`isPidAlive`, `lock.ts:32-42`,
including `EPERM` → alive) as "a nectar daemon holds the lock". The lock file lives in
`~/.honeycomb` and survives reboot; after a crash or a reboot, the stale PID can be reused
by an arbitrary unrelated process, and `acquireSingleInstanceLock` then throws
`DaemonAlreadyRunningError` forever. Under the OS unit this is an eternal 5-second
crash-restart loop (see H4/M1) until an operator manually deletes
`~/.honeycomb/nectar.lock`. `test/lock.test.ts:54` covers the dead-PID reclaim but nothing
covers PID reuse.

**Fix direction:** store more identity than a bare pid (pid + process start time, or a
random boot token also written to the pid file), or verify the live process is plausibly a
nectar daemon before refusing, or move to an advisory `flock` held open (releases
automatically on process death, immune to PID reuse).

### H3. `shutdown()` can hang indefinitely behind one active request → SIGKILL, unclean exit

`src/server.ts:132-138` — `close()` waits for `server.close()` and only calls
`closeIdleConnections()`. An **active** request never gets destroyed. A
`POST /api/hive-graph/build` runs a full brood synchronously inside the request handler
(`api/hive-graph-api.ts:181-206` awaits `runBrood`; wired to `runBroodAsync` at
`api/daemon-api-wiring.ts:152-169`), which on a real repo takes minutes. A SIGTERM during
that window (`daemon.ts:591-600`) blocks at `await server.close()` (`daemon.ts:578-581`)
forever; systemd's default 90 s / launchd's grace then SIGKILLs the process — the lock file
is never released (stale lock, see H2), telemetry never closes, and the "drain then exit"
log never happens.

**Fix direction:** after `server.close()` is initiated, force `closeAllConnections()` (or
destroy tracked sockets) after a short grace period; and/or make `/build` асync
(202 + status polling) so no request outlives seconds.

### H4. systemd unit omits the node interpreter → crash loop on the most common Linux install

`src/service/templates.ts:103-122` — `ExecStart="{execPath}" daemon` execs the CLI
entry (`process.argv[1]`, `cli.ts:94-96`) **directly**, relying on the `#!/usr/bin/env node`
shebang and `node` being on the *systemd user manager's* PATH. The launchd and Scheduled
Task templates correctly prefix `process.execPath` (`templates.ts:65,77` and `:136-137,173`).
For node installed via nvm/fnm/volta (not in `/usr/bin`), the unit fails to exec — and with
`Restart=always` + `RestartSec=5` + `StartLimitIntervalSec=0` (`templates.ts:115-117`) that
is an **infinite 5-second crash loop** with no rate limiting, silently burning CPU/journal.
`test/service-templates.test.ts` snapshots the current (broken) shape.

**Fix direction:** render `ExecStart=${quoteSystemdToken(process.execPath)}
${quoteSystemdToken(plan.execPath)} daemon` exactly as the other two platforms do; consider
a finite `StartLimitBurst` instead of disabling rate limiting.

### H5. Mission gap: the shipped daemon never watches the filesystem ("update it upon change with NodeFS")

The NodeFS watch machinery exists and is tested (`registration/fs-watch.ts:121`,
`registration/service.ts:92-…`), but no production code path constructs
`RegistrationService`/`WatchIntake`: the only non-test references are re-exports
(`src/index.ts:127-128,163-164`). `cli.ts:466-477` documents that "the live daemon does not
instantiate the registration pipeline (a documented PRD-006a non-goal)". Net effect: after
the boot brood, file *changes* are not observed — the enricher only re-describes rows that
something else marks pending, and nothing does. The mission statement's middle third is
currently dormant in the shipped binary. This is an honest, documented deferral, but for a
public release the README/USAGE should say so explicitly, and the wiring should be the next
milestone.

---

## Medium

### M1. Two restart authorities supervise one daemon (OS unit + doctor) and contend on the lock

`nectar install` both (a) installs an always-restart OS unit (`service/index.ts:189-255`,
launchd `KeepAlive`/systemd `Restart=always`) and (b) writes a doctor registry entry
carrying doctor-side restart policy (`doctor-registry.ts:72-75,101-121` —
`restartGiveUpThreshold`, `restartCooldownMs`). ADR-0003's diagram has doctor *spawning*
workload daemons from the registry; ADR-0004 (§1) says workload daemons are booted by the
OS service manager. If both authorities act (doctor spawns nectar while the OS unit also
restarts it), the loser sits in a permanent restart loop against the lock — and via C1,
each losing attempt destroys the winner's lock/pid. Decide and document a single restart
owner (e.g. doctor probes health and defers restarts to the OS unit, or the unit is
`RunAtLoad`-only), and make the loser's failure mode benign (C1 fix).

### M2. Shutdown does not actually drain in-flight work before `process.exit(0)`

`daemon.ts:572-589` — `worker.stop()` only disarms the poll loop; an in-flight job
continues (`poll-loop.ts:82-90` "an in-flight tick is allowed to finish"), and the
background boot tasks (`bootSettled` — projection load/inherit writes, auto-brood) are
never awaited even though `awaitBoot()` exists "for … orderly shutdown"
(`daemon.ts:324-330`). The signal handler then `process.exit(0)`s as soon as `shutdown()`
resolves (`daemon.ts:594-597`), killing an in-flight describe/store write or inherit write
mid-flight. Brood resumability and the queue-lease reaper make this survivable, but the
documented "Drain worker -> close socket" contract (`daemon.ts:303`) is not met.
**Fix direction:** in `shutdown()`, `await` the in-flight tick (expose a promise from
`PollLoop`) and `await bootSettled` with a bounded timeout before releasing the lock.

### M3. No API auth + unauthenticated `?project=` override reaches other projects' data

The default gate is `allowAllPermission` (`api/router.ts:117-118`, `daemon.ts:379`), which
is a documented loopback posture — but `defaultScopeResolver`
(`api/hive-graph-api.ts:134-143`) additionally honors a per-request `?project=<id>`
override on **every** endpoint. Any local process can `GET /api/hive-graph/search?project=X`
to read another project's titles/descriptions in the same workspace, and
`POST /api/hive-graph/build?project=X` broods the *local* tree's files into project X's
tenancy in Deep Lake (`daemon-api-wiring.ts:152-161` uses `args.scope` as the brood
tenancy) — cross-project row pollution with billable LLM calls. Compounding:
`NECTAR_HOST` can rebind the daemon off loopback (`config.ts:72`) with no gate at all.
**Fix direction:** drop or allowlist-validate the `project` override (at minimum for
`/build`), and refuse to start with `allowAllPermission` when `host` is non-loopback.

### M4. Projection regeneration trigger #2 (enricher cycle) is spec'd but not wired

`portable-registry.md:117-121` specifies three regeneration triggers. Trigger #1 works
(async brood stage 7, `brooding/pipeline-async.ts:401-405`); trigger #3 works
(`cli.ts:226-244`, `api/daemon-api-wiring.ts:129-132`). Trigger #2 — "end of an enricher
cycle that wrote new descriptions" — has a seam (`enricher/cycle.ts:51,266` accepts a
`projectionWriter` and calls `scheduleWrite`) that **no production code fills**: the live
wiring at `cli.ts:618-629` passes `enricherCycle: { readContent, portkey, embedProvider }`
with no `projectionWriter`, and `ProjectionWriter` is never constructed outside tests. So
steady-state description updates never refresh `.honeycomb/nectars.json`; the committed
projection silently goes stale until the next full brood or a manual rebuild — undermining
the "clone inherits current descriptions" property the spec sells.
**Fix direction:** construct a `ProjectionWriter` in `runDaemon()` (debounced, per
`write.ts:88-151`) and pass it via `enricherCycle`, sourcing the doc from
`rebuildProjectionAsync` on flush.

### M5. Doctor registry write is non-atomic and drops unknown top-level fields

`doctor-registry.ts:221-222` — `writeFileSync` in place, no temp+rename (unlike the
projection writer). Doctor polls this file and is documented fail-loud on malformed
registries (module doc, `doctor-registry.ts:19-25`); a reader that hits the torn/empty
mid-write state can error out or drop supervision. Also, the rewrite serializes only
`{ daemons }` — any other top-level key an operator or another tool put in
`doctor.daemons.json` is silently discarded (`doctor-registry.ts:216-222`). Concurrent
installs of two products (nectar + hive) can also lose one entry via the
read-modify-write race.
**Fix direction:** temp+rename in the same directory; spread the parsed root object and
replace only `daemons`.

### M6. Shutdown during an in-flight `start()` can leave a bound socket with no lock

`daemon.ts:526-559` — the start promise re-checks nothing after `shutdown()` runs
concurrently: a `shutdown()` between lock acquisition and `server.listen()` releases the
lock and sets `startPromise = null`, but the in-flight start continues and binds the
socket, ending with a listening daemon that holds no lock (a second daemon can then start).
Narrow window (signal during boot), but the CLI installs signal handlers *before*
`start()` (`cli.ts:655-656`), so it is reachable.
**Fix direction:** after `await server.listen()` (and before it), bail out and unwind if
`closed === true`.

---

## Low

### L1. Malformed JSON body → 500 instead of 400, and a poisoned body cache

`api/router.ts:279-285` — `ctx.body()` throws `JSON.parse` errors inside the handler, so
the dispatcher's catch (`router.ts:221-226`) returns `500 handler_error` for what is a
client error (should be 400). Also `parsedOnce = true` is set *before* the parse
(`router.ts:281`), so after one throw, subsequent `body()` calls return `undefined`
silently rather than re-throwing.

### L2. launchd log directory never created

`templates.ts:89-92` points `StandardOutPath`/`StandardErrorPath` at
`~/.honeycomb/nectar/launchd.{out,err}.log`, but macOS install only mkdirps the
LaunchAgents dir (`service/index.ts:222-223`); `~/.honeycomb/nectar/` is only created on
the Windows path (`service/index.ts:219-221`). launchd won't create the parent dir, so
daemon stdout/stderr are silently lost. Mkdirp the log dir during install.

### L3. systemd reinstall never runs `daemon-reload`

`argv.ts:65-67` — install is only `systemctl --user enable --now nectar.service`. On a
re-install that *changed* the unit file, systemd may keep serving the cached unit until a
`daemon-reload`. Add `systemctl --user daemon-reload` before `enable --now`.

### L4. Usage telemetry is opt-out, and only the literal `"0"` opts out

`telemetry-usage/emit.ts:141-146` — the design is defensible (anonymous, closed
allow-list at `emit.ts:212-214`, hard-disabled without a baked key, honors
`DO_NOT_TRACK`), but for a public release: (a) document the default-on behavior and the
`NECTAR_TELEMETRY=0` switch in README/USAGE (currently only in source comments);
(b) `NECTAR_TELEMETRY=false`/`off` are silently ignored (only `"0"` counts) while
`DO_NOT_TRACK` accepts any non-`"0"` value — inconsistent; accept the falsy family.
Also `emitUninstalled` fires *before* the uninstall outcome is known (`cli.ts:148`), so a
failed uninstall still reports `nectar_uninstalled`.

### L5. Spec-doc drift: `sha256-` prefixed hashes in portable-registry.md

`portable-registry.md:47,55,66-67` shows `"content_hash": "sha256-abc123..."`, but the
implementation validates bare 64-char lowercase hex (`projection/format.ts:48-53`,
deliberately, per its module doc). A projection hand-built from the spec example fails
validation (`invalid_content_hash`). Fix the doc (the code's choice is the right one).

### L6. `envInt` accepts trailing garbage and out-of-range values

`config.ts:47-52` — `NECTAR_PORT=3854abc` parses as 3854; negative or >65535 ports pass
through to `listen()` and surface as an opaque bind error; `NECTAR_POLL_INTERVAL_MS=0`
becomes a 1 ms tight poll (`poll-loop.ts:57`). Consider strict integer parsing + range
checks with a clear startup error.

---

## Spec conformance notes (ADR-0002/0003/0004, portable-registry.md)

Confirmed matching:
- **Independent daemon, process boundary only** (ADR-0002): no honeycomb imports; own
  Deep Lake client (`hive-graph/deeplake-transport.ts`), own Portkey client, mirrored (not
  imported) SQL guards; distinct lock/pid names so both daemons coexist in `~/.honeycomb`
  (`config.ts:25-27`).
- **Registered-daemon topology** (ADR-0003): `/health` unprotected on loopback :3854
  (`config.ts:17-20`, `server.ts:67-71`), pid/lock files, doctor registry entry with
  `healthUrl`/`pidPath`/probe settings (`doctor-registry.ts:101-121`), and the four
  hive-consumable API surfaces (search/build/status/projection,
  `api/hive-graph-api.ts:162-255`) exactly as ADR-0003 "Implementation Notes" lists.
- **hive boundaries** (ADR-0004): nectar hosts no portal; data leaves only via `/api/*`.
- **Projection as projection, not sidecar** (portable-registry.md): Deep-Lake-writes-first
  holds on the brood path; atomic temp+rename write (`projection/write.ts:56-73`);
  validation gates (version ≤ schema, tenancy triple match, ULID keys, sha256 hashes,
  fail-closed whole-document rejection) implemented at `projection/load.ts:145-259`;
  additive-only inheritance with `existingNectars` guard (`projection/inherit.ts:104-139`,
  `cli.ts:506-518`).

Divergences: M4 (trigger #2 unwired), H5 (live watch unwired), L5 (doc hash format), M1
(ambiguity about who restarts workload daemons — ADR-0003 diagram vs ADR-0004 §1 prose).

## Test-coverage gaps worth closing (in priority order)

1. Lock: assert the survivor's lock still exists after a failed second start (would have
   caught C1); concurrent stale-reclaim race; PID-reuse behavior.
2. Shutdown: SIGTERM with an active in-flight request (H3) and with an in-flight worker
   job (M2).
3. API: `?project=` override reaching `/build` (M3); malformed-JSON body status code (L1).
4. Service: systemd ExecStart execs under a PATH without node (H4) — even a template-level
   assertion that `process.execPath` appears would do.
