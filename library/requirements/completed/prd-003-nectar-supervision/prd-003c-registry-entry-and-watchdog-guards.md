# PRD-003c: nectar's registry entry + watchdog-war guards

> Parent: [`prd-003-nectar-supervision-index.md`](./prd-003-nectar-supervision-index.md)
>
> **Split of responsibility.** doctor's registry schema, the per-daemon supervisor construction, and the isolated incident state are **PRD-004a** (out-of-band, doctor codebase). This sub-PRD is the **nectar side**: the one registry entry nectar's installer appends, and the confirmation that the watchdog-war guards in the restart rung read nectar's *own* PID file rather than honeycomb's shared default.

## Overview

nectar becomes a supervised daemon by appending **one entry** to doctor's daemon registry file (`~/.honeycomb/doctor.daemons.json`, the registry PRD-004a specifies). That entry carries nectar's `healthUrl`, `pidPath`, `probeIntervalMs`, `startupGraceMs`, and restart thresholds — the per-daemon values that `DoctorConfig` (`doctor/src/config.ts:28-54`) currently holds once for the single honeycomb daemon. At the next doctor boot, doctor reads the registry and spawns one supervisor instance for nectar alongside honeycomb and hive (PRD-004a's composition-root loop).

The load-bearing correctness property is the **watchdog-war guard**: when doctor's restart rung runs for nectar, its lock-held-and-healthy check (`doctor/src/remediation.ts:147-151`) reads nectar's `pidPath` (`~/.honeycomb/nectar.pid`), never honeycomb's `~/.honeycomb/daemon.pid` default. A restart that ignored nectar's own lock would either fight a healthy nectar or start a second one that immediately hits the single-instance lock and exits — the exact failure the guard prevents.

## Goals

- nectar's installer appends one entry to `~/.honeycomb/doctor.daemons.json` naming nectar with its `healthUrl` (port 3854) and `pidPath` (`~/.honeycomb/nectar.pid`).
- The entry's per-daemon fields resolve to the doctor defaults nectar inherits (probe interval 30s, startup grace 60s, give-up threshold 3, cooldown 5s) unless overridden.
- The restart rung's cooldown + lock-held-and-healthy guards read the entry's own `pidPath`, so a restart never double-binds against a healthy nectar or fights its own cooldown.
- Registration is a file edit at install time — no runtime HTTP registration API, no doctor restart, no live reload.

## Non-Goals

- The registry file schema, the per-daemon supervisor construction loop, and the isolated incident/state shards — **PRD-004a**. This PRD consumes the registry; it does not define its loader.
- doctor's status page / CLI multi-daemon reporting — **PRD-004b**.
- A runtime registration API or hot-reload — explicitly rejected (PRD-004a non-goal: registration is a file edit by an installer; doctor reads the registry once on boot).
- Restarting doctor to register nectar — installers do NOT restart doctor (PRD-004a non-goal); a freshly-registered daemon is supervised at doctor's next natural boot.
- The remediation ladder's rung 2 (reinstall) and escalation rung — doctor owns them; this PRD only consumes rung 1 (restart) against nectar's PID file.

---

## nectar's registry entry

nectar's installer appends one entry to the registry file PRD-004a specifies (`~/.honeycomb/doctor.daemons.json`). Each entry's fields are the per-daemon values that `DoctorConfig` (`doctor/src/config.ts:28-54`) currently holds once for honeycomb:

```json
{
  "name": "nectar",
  "healthUrl": "http://127.0.0.1:3854/health",
  "pidPath": "~/.honeycomb/nectar.pid",
  "probeIntervalMs": 30000,
  "startupGraceMs": 60000,
  "restartGiveUpThreshold": 3,
  "restartCooldownMs": 5000
}
```

| Field | nectar value | Resolves from (doctor default) | Citation |
|---|---|---|---|
| `name` | `"nectar"` | — (the registry key; PRD-004a accepts `"honeycomb"\|"hive"\|"nectar"`) | [`prd-004a`](../prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) schema |
| `healthUrl` | `http://127.0.0.1:3854/health` | `config.healthUrl` default `http://127.0.0.1:3850/health` | `doctor/src/config.ts:37,75` |
| `pidPath` | `~/.honeycomb/nectar.pid` | `config.daemonPidPath` default `~/.honeycomb/daemon.pid` | `doctor/src/config.ts:53,155` |
| `probeIntervalMs` | `30000` | `config.probeIntervalMs` default `30000` | `doctor/src/config.ts:31,72` |
| `startupGraceMs` | `60000` | `config.startupGraceMs` default `60000` | `doctor/src/config.ts:35,74` |
| `restartGiveUpThreshold` | `3` | `config.restartGiveUpThreshold` default `3` | `doctor/src/config.ts:45,79` |
| `restartCooldownMs` | `5000` | `config.restartCooldownMs` default `5000` | `doctor/src/config.ts:47,80` |

> **Port 3854, not 3853.** nectar's `healthUrl` uses port **3854** (confirmed in [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-nectar-process-and-health.md): the next free port after hive=3853; 3850/3851/3852/3853 occupied). A sibling registry sample elsewhere shows hive's 3853 against the nectar row — that is a typo; the binding value is 3854. `pidPath` carries `~` for readability; the registry loader expands `~` to `homedir()` exactly as `resolveConfig` already does (`doctor/src/config.ts:153-155`).

### Startup grace (DEFAULT — confirm before implementation)

**DEFAULT — confirm before implementation.** nectar's `startupGraceMs` = `60000` (60s), matching doctor's built-in default (`doctor/src/config.ts:74` `startupGraceMs: 60_000`). During the grace window after a boot or restart, the supervisor's `tick` treats a non-`ok` probe as "still booting" and does not enter the heal path (`doctor/src/supervisor.ts:297-301`: `graceRemainingMs > 0` → log `tick.booting` and return). nectar's cold-boot path (Deep Lake client init, auth/scoping, worker start before the socket bind — PRD-002) fits comfortably inside 60s; if a slower environment needs more, the entry's `startupGraceMs` is the override.

---

## Watchdog-war guards (rung 1, restart)

doctor's restart rung (`createRestartRung`, `doctor/src/remediation.ts:124-160`) runs two idempotency guards *before* kicking a restart, in this order (the guard order at `doctor/src/remediation.ts:125-131`):

1. **Cooldown** — if doctor restarted this daemon within `cooldownMs`, SKIP (do not fight its own restart-helper). `doctor/src/remediation.ts:139-143`.
2. **Lock-held-and-healthy** — if the PID file names a daemon AND `/health` answers, SKIP (a second daemon would just hit the single-instance lock and exit). `doctor/src/remediation.ts:147-151`.

Both guards are **dependency-injected** via `RestartRungDeps` (`doctor/src/remediation.ts:107-122`): `readDaemonPid` (`:111`), `isHealthy` (`:113`), `cooldownMs` (`:115`), `lastRestartAt`/`markRestarted` (`:119-121`). This is what makes them per-entry rather than shared — the composition root (PRD-004a) passes a `readDaemonPid` that reads **the entry's `pidPath`** and an entry-local `lastRestartAt`/`markRestarted` pair.

For nectar's entry, this means:

- `readDaemonPid` reads `~/.honeycomb/nectar.pid` — **not** the honeycomb `~/.honeycomb/daemon.pid` default from `doctor/src/config.ts:53`. This delivers [`prd-004a`](../prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) a-AC-7: the lock-held-and-healthy guard checks the right daemon's PID.
- `isHealthy` probes `http://127.0.0.1:3854/health` — nectar's own endpoint (003a), so the "answering" half of the check is against nectar, not honeycomb.
- `cooldownMs` = nectar's `restartCooldownMs` (5000), and the `lastRestartAt`/`markRestarted` pair is entry-local — a nectar restart's cooldown does not gate honeycomb's restart, and vice versa. This delivers a-AC-8.

> **Why this matters for nectar specifically.** nectar's single-instance lock (003a) means a second nectar process throws before binding port 3854. If doctor's restart rung ignored the lock-held-and-healthy guard — or read the wrong PID file — it would start a second nectar that immediately exits, increment nectar's consecutive-restart-failure count, and needlessly advance toward the give-up threshold. The guard reads nectar's *own* PID + `/health`, sees the daemon is actually fine (or recovering), and SKIPS with `detail: "lock-held-and-healthy"` (`doctor/src/remediation.ts:149-150`). A skip is deliberately NOT a failed restart — it does not push toward give-up (`doctor/src/supervisor.ts:236-240`).

---

## Registration mechanics

Registration is a **file edit at install time**, not a runtime call (PRD-004a's locked decision):

1. nectar's installer (the same installer that lays down the OS service unit in 003b) appends the entry above to `~/.honeycomb/doctor.daemons.json`.
2. If the registry file is absent, the installer creates it with the single nectar entry (PRD-004a a-AC-2: a missing file falls back to supervising honeycomb at its defaults — but the installer's create-with-nectar is the forward path; the fallback is doctor's safety net, not the registration path).
3. The installer does NOT restart doctor. nectar is supervised at doctor's next natural boot (typically OS start, since doctor has its own service unit). Until then, nectar is kept alive by its own OS service unit (003b) — restart-on-crash + start-on-boot — independent of doctor's supervision.

> **No two-phase hazard.** nectar's OS service unit (003b) and its registry entry (here) are both laid down by the same installer, so nectar is never in a state where the OS restarts it but doctor does not know about it (or vice versa) for longer than until doctor's next boot. Between install and doctor's next boot, nectar is alive and self-healing via its OS unit; once doctor boots, it picks up the registry entry and begins probing.

---

## User stories

### US-003c.1 — nectar's installer registers it in next doctor boot
**As an** operator, **when** I install nectar, **the** installer appends an entry to `~/.honeycomb/doctor.daemons.json`, **so that** doctor supervises nectar at its next boot without a manual step.

- Acceptance: the entry has `name: "nectar"`, `healthUrl: "http://127.0.0.1:3854/health"`, `pidPath: "~/.honeycomb/nectar.pid"` (per the table above).
- Acceptance: the installer does NOT restart doctor; the entry takes effect at doctor's next boot.

### US-003c.2 — The restart rung reads nectar's own PID file
**As** doctor's restart rung for nectar, **when** I run the lock-held-and-healthy guard, **I** read `~/.honeycomb/nectar.pid`, never `~/.honeycomb/daemon.pid`, **so that** I check the right daemon's liveness.

- Acceptance: the rung's `readDaemonPid` reads the entry's `pidPath` (delivers [`prd-004a`](../prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) a-AC-7).
- Acceptance: `isHealthy` probes `http://127.0.0.1:3854/health` (003a's endpoint).

### US-003c.3 — A healthy, locked nectar is not double-restarted
**As** doctor, **when** nectar's PID file names a live process and `/health` answers `ok`, **I** skip the restart, **so that** I do not start a second nectar that would hit the single-instance lock and exit.

- Acceptance: the lock-held-and-healthy guard returns `{ ok: false, skipped: true, detail: "lock-held-and-healthy" }` (mirrors `doctor/src/remediation.ts:147-151`).
- Acceptance: the skip does not increment nectar's consecutive-restart-failure count (mirrors `doctor/src/supervisor.ts:236-240`).

### US-003c.4 — nectar's cooldown is isolated from honeycomb's
**As** doctor, **when** I just restarted nectar, **a** second nectar restart inside its cooldown is skipped, **and** honeycomb's restart is unaffected.

- Acceptance: the cooldown guard skips a restart inside `restartCooldownMs` for the nectar entry only (mirrors `doctor/src/remediation.ts:139-143`).
- Acceptance: nectar's `lastRestartAt`/`markRestarted` is entry-local, so its cooldown does not gate any other entry (delivers [`prd-004a`](../prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) a-AC-8).

---

## Implementation notes

- Registry entry (the row nectar appends): schema + field-to-`DoctorConfig` mapping in [`prd-004a`](../prd-004-doctor-registry-and-hive/prd-004a-doctor-registry-config-and-supervisor-instances.md) "Registry file" section; per-daemon field defaults in `doctor/src/config.ts:28-84` (`healthUrl` `:37,75`; `daemonPidPath` `:53,155`; `probeIntervalMs` `:31,72`; `startupGraceMs` `:35,74`; `restartGiveUpThreshold` `:45,79`; `restartCooldownMs` `:47,80`).
- Watchdog-war guards (rung 1): `doctor/src/remediation.ts:107-160` — `RestartRungDeps` (`:107-122`), `createRestartRung` guard order (`:124-131`), cooldown guard (`:139-143`), lock-held-and-healthy guard (`:147-151`).
- Supervisor tick + skip handling: `doctor/src/supervisor.ts:236-320` — a skip does not increment the failure count (`:236-240`); the startup-grace window gates the heal path (`:297-301`).
- `~` expansion in pidPath: `doctor/src/config.ts:153-155` (`resolveConfig` homedir expansion the registry loader reuses).
- PID file the guard reads: `~/.honeycomb/nectar.pid` (written by 003a's `acquireSingleInstanceLock`, mirroring `honeycomb/src/daemon/runtime/assemble.ts:715-732`).

No open questions. The `startupGraceMs` = 60000 default is flagged above.
