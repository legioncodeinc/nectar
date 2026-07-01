# PRD-003c: hivenectar's registry entry + watchdog-war guards

> Parent: [`prd-003-hivenectar-supervision-index.md`](./prd-003-hivenectar-supervision-index.md)
>
> **Split of responsibility.** hivedoctor's registry schema, the per-daemon supervisor construction, and the isolated incident state are **PRD-004a** (out-of-band, hivedoctor codebase). This sub-PRD is the **hivenectar side**: the one registry entry hivenectar's installer appends, and the confirmation that the watchdog-war guards in the restart rung read hivenectar's *own* PID file rather than honeycomb's shared default.

## Overview

hivenectar becomes a supervised daemon by appending **one entry** to hivedoctor's daemon registry file (`~/.honeycomb/hivedoctor.daemons.json`, the registry PRD-004a specifies). That entry carries hivenectar's `healthUrl`, `pidPath`, `probeIntervalMs`, `startupGraceMs`, and restart thresholds — the per-daemon values that `HiveDoctorConfig` ([`hivedoctor/src/config.ts:28-54`](../../../../hivedoctor/src/config.ts)) currently holds once for the single honeycomb daemon. At the next hivedoctor boot, hivedoctor reads the registry and spawns one supervisor instance for hivenectar alongside honeycomb and thehive (PRD-004a's composition-root loop).

The load-bearing correctness property is the **watchdog-war guard**: when hivedoctor's restart rung runs for hivenectar, its lock-held-and-healthy check ([`hivedoctor/src/remediation.ts:147-151`](../../../../hivedoctor/src/remediation.ts)) reads hivenectar's `pidPath` (`~/.honeycomb/hivenectar.pid`), never honeycomb's `~/.honeycomb/daemon.pid` default. A restart that ignored hivenectar's own lock would either fight a healthy hivenectar or start a second one that immediately hits the single-instance lock and exits — the exact failure the guard prevents.

## Goals

- hivenectar's installer appends one entry to `~/.honeycomb/hivedoctor.daemons.json` naming hivenectar with its `healthUrl` (port 3854) and `pidPath` (`~/.honeycomb/hivenectar.pid`).
- The entry's per-daemon fields resolve to the hivedoctor defaults hivenectar inherits (probe interval 30s, startup grace 60s, give-up threshold 3, cooldown 5s) unless overridden.
- The restart rung's cooldown + lock-held-and-healthy guards read the entry's own `pidPath`, so a restart never double-binds against a healthy hivenectar or fights its own cooldown.
- Registration is a file edit at install time — no runtime HTTP registration API, no hivedoctor restart, no live reload.

## Non-Goals

- The registry file schema, the per-daemon supervisor construction loop, and the isolated incident/state shards — **PRD-004a**. This PRD consumes the registry; it does not define its loader.
- hivedoctor's status page / CLI multi-daemon reporting — **PRD-004b**.
- A runtime registration API or hot-reload — explicitly rejected (PRD-004a non-goal: registration is a file edit by an installer; hivedoctor reads the registry once on boot).
- Restarting hivedoctor to register hivenectar — installers do NOT restart hivedoctor (PRD-004a non-goal); a freshly-registered daemon is supervised at hivedoctor's next natural boot.
- The remediation ladder's rung 2 (reinstall) and escalation rung — hivedoctor owns them; this PRD only consumes rung 1 (restart) against hivenectar's PID file.

---

## hivenectar's registry entry

hivenectar's installer appends one entry to the registry file PRD-004a specifies (`~/.honeycomb/hivedoctor.daemons.json`). Each entry's fields are the per-daemon values that `HiveDoctorConfig` ([`hivedoctor/src/config.ts:28-54`](../../../../hivedoctor/src/config.ts)) currently holds once for honeycomb:

```json
{
  "name": "hivenectar",
  "healthUrl": "http://127.0.0.1:3854/health",
  "pidPath": "~/.honeycomb/hivenectar.pid",
  "probeIntervalMs": 30000,
  "startupGraceMs": 60000,
  "restartGiveUpThreshold": 3,
  "restartCooldownMs": 5000
}
```

| Field | hivenectar value | Resolves from (hivedoctor default) | Citation |
|---|---|---|---|
| `name` | `"hivenectar"` | — (the registry key; PRD-004a accepts `"honeycomb"\|"thehive"\|"hivenectar"`) | [`prd-004a`](../prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) schema |
| `healthUrl` | `http://127.0.0.1:3854/health` | `config.healthUrl` default `http://127.0.0.1:3850/health` | [`hivedoctor/src/config.ts:37,75`](../../../../hivedoctor/src/config.ts) |
| `pidPath` | `~/.honeycomb/hivenectar.pid` | `config.daemonPidPath` default `~/.honeycomb/daemon.pid` | [`hivedoctor/src/config.ts:53,155`](../../../../hivedoctor/src/config.ts) |
| `probeIntervalMs` | `30000` | `config.probeIntervalMs` default `30000` | [`hivedoctor/src/config.ts:31,72`](../../../../hivedoctor/src/config.ts) |
| `startupGraceMs` | `60000` | `config.startupGraceMs` default `60000` | [`hivedoctor/src/config.ts:35,74`](../../../../hivedoctor/src/config.ts) |
| `restartGiveUpThreshold` | `3` | `config.restartGiveUpThreshold` default `3` | [`hivedoctor/src/config.ts:45,79`](../../../../hivedoctor/src/config.ts) |
| `restartCooldownMs` | `5000` | `config.restartCooldownMs` default `5000` | [`hivedoctor/src/config.ts:47,80`](../../../../hivedoctor/src/config.ts) |

> **Port 3854, not 3853.** hivenectar's `healthUrl` uses port **3854** (confirmed in [`prd-001b`](../prd-001-three-daemon-topology/prd-001b-hivenectar-process-and-health.md): the next free port after thehive=3853; 3850/3851/3852/3853 occupied). A sibling registry sample elsewhere shows thehive's 3853 against the hivenectar row — that is a typo; the binding value is 3854. `pidPath` carries `~` for readability; the registry loader expands `~` to `homedir()` exactly as `resolveConfig` already does ([`hivedoctor/src/config.ts:153-155`](../../../../hivedoctor/src/config.ts)).

### Startup grace (DEFAULT — confirm before implementation)

**DEFAULT — confirm before implementation.** hivenectar's `startupGraceMs` = `60000` (60s), matching hivedoctor's built-in default ([`config.ts:74`](../../../../hivedoctor/src/config.ts) `startupGraceMs: 60_000`). During the grace window after a boot or restart, the supervisor's `tick` treats a non-`ok` probe as "still booting" and does not enter the heal path ([`supervisor.ts:297-301`](../../../../hivedoctor/src/supervisor.ts): `graceRemainingMs > 0` → log `tick.booting` and return). hivenectar's cold-boot path (Deep Lake client init, auth/scoping, worker start before the socket bind — PRD-002) fits comfortably inside 60s; if a slower environment needs more, the entry's `startupGraceMs` is the override.

---

## Watchdog-war guards (rung 1, restart)

hivedoctor's restart rung (`createRestartRung`, [`hivedoctor/src/remediation.ts:124-160`](../../../../hivedoctor/src/remediation.ts)) runs two idempotency guards *before* kicking a restart, in this order (the guard order at [`remediation.ts:125-131`](../../../../hivedoctor/src/remediation.ts)):

1. **Cooldown** — if hivedoctor restarted this daemon within `cooldownMs`, SKIP (do not fight its own restart-helper). [`remediation.ts:139-143`](../../../../hivedoctor/src/remediation.ts).
2. **Lock-held-and-healthy** — if the PID file names a daemon AND `/health` answers, SKIP (a second daemon would just hit the single-instance lock and exit). [`remediation.ts:147-151`](../../../../hivedoctor/src/remediation.ts).

Both guards are **dependency-injected** via `RestartRungDeps` ([`remediation.ts:107-122`](../../../../hivedoctor/src/remediation.ts)): `readDaemonPid` (`:111`), `isHealthy` (`:113`), `cooldownMs` (`:115`), `lastRestartAt`/`markRestarted` (`:119-121`). This is what makes them per-entry rather than shared — the composition root (PRD-004a) passes a `readDaemonPid` that reads **the entry's `pidPath`** and an entry-local `lastRestartAt`/`markRestarted` pair.

For hivenectar's entry, this means:

- `readDaemonPid` reads `~/.honeycomb/hivenectar.pid` — **not** the honeycomb `~/.honeycomb/daemon.pid` default from [`config.ts:53`](../../../../hivedoctor/src/config.ts). This delivers [`prd-004a`](../prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) a-AC-7: the lock-held-and-healthy guard checks the right daemon's PID.
- `isHealthy` probes `http://127.0.0.1:3854/health` — hivenectar's own endpoint (003a), so the "answering" half of the check is against hivenectar, not honeycomb.
- `cooldownMs` = hivenectar's `restartCooldownMs` (5000), and the `lastRestartAt`/`markRestarted` pair is entry-local — a hivenectar restart's cooldown does not gate honeycomb's restart, and vice versa. This delivers a-AC-8.

> **Why this matters for hivenectar specifically.** hivenectar's single-instance lock (003a) means a second hivenectar process throws before binding port 3854. If hivedoctor's restart rung ignored the lock-held-and-healthy guard — or read the wrong PID file — it would start a second hivenectar that immediately exits, increment hivenectar's consecutive-restart-failure count, and needlessly advance toward the give-up threshold. The guard reads hivenectar's *own* PID + `/health`, sees the daemon is actually fine (or recovering), and SKIPS with `detail: "lock-held-and-healthy"` ([`remediation.ts:149-150`](../../../../hivedoctor/src/remediation.ts)). A skip is deliberately NOT a failed restart — it does not push toward give-up ([`supervisor.ts:236-240`](../../../../hivedoctor/src/supervisor.ts)).

---

## Registration mechanics

Registration is a **file edit at install time**, not a runtime call (PRD-004a's locked decision):

1. hivenectar's installer (the same installer that lays down the OS service unit in 003b) appends the entry above to `~/.honeycomb/hivedoctor.daemons.json`.
2. If the registry file is absent, the installer creates it with the single hivenectar entry (PRD-004a a-AC-2: a missing file falls back to supervising honeycomb at its defaults — but the installer's create-with-hivenectar is the forward path; the fallback is hivedoctor's safety net, not the registration path).
3. The installer does NOT restart hivedoctor. hivenectar is supervised at hivedoctor's next natural boot (typically OS start, since hivedoctor has its own service unit). Until then, hivenectar is kept alive by its own OS service unit (003b) — restart-on-crash + start-on-boot — independent of hivedoctor's supervision.

> **No two-phase hazard.** hivenectar's OS service unit (003b) and its registry entry (here) are both laid down by the same installer, so hivenectar is never in a state where the OS restarts it but hivedoctor does not know about it (or vice versa) for longer than until hivedoctor's next boot. Between install and hivedoctor's next boot, hivenectar is alive and self-healing via its OS unit; once hivedoctor boots, it picks up the registry entry and begins probing.

---

## User stories

### US-003c.1 — hivenectar's installer registers it in next hivedoctor boot
**As an** operator, **when** I install hivenectar, **the** installer appends an entry to `~/.honeycomb/hivedoctor.daemons.json`, **so that** hivedoctor supervises hivenectar at its next boot without a manual step.

- Acceptance: the entry has `name: "hivenectar"`, `healthUrl: "http://127.0.0.1:3854/health"`, `pidPath: "~/.honeycomb/hivenectar.pid"` (per the table above).
- Acceptance: the installer does NOT restart hivedoctor; the entry takes effect at hivedoctor's next boot.

### US-003c.2 — The restart rung reads hivenectar's own PID file
**As** hivedoctor's restart rung for hivenectar, **when** I run the lock-held-and-healthy guard, **I** read `~/.honeycomb/hivenectar.pid`, never `~/.honeycomb/daemon.pid`, **so that** I check the right daemon's liveness.

- Acceptance: the rung's `readDaemonPid` reads the entry's `pidPath` (delivers [`prd-004a`](../prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) a-AC-7).
- Acceptance: `isHealthy` probes `http://127.0.0.1:3854/health` (003a's endpoint).

### US-003c.3 — A healthy, locked hivenectar is not double-restarted
**As** hivedoctor, **when** hivenectar's PID file names a live process and `/health` answers `ok`, **I** skip the restart, **so that** I do not start a second hivenectar that would hit the single-instance lock and exit.

- Acceptance: the lock-held-and-healthy guard returns `{ ok: false, skipped: true, detail: "lock-held-and-healthy" }` (mirrors [`remediation.ts:147-151`](../../../../hivedoctor/src/remediation.ts)).
- Acceptance: the skip does not increment hivenectar's consecutive-restart-failure count (mirrors [`supervisor.ts:236-240`](../../../../hivedoctor/src/supervisor.ts)).

### US-003c.4 — hivenectar's cooldown is isolated from honeycomb's
**As** hivedoctor, **when** I just restarted hivenectar, **a** second hivenectar restart inside its cooldown is skipped, **and** honeycomb's restart is unaffected.

- Acceptance: the cooldown guard skips a restart inside `restartCooldownMs` for the hivenectar entry only (mirrors [`remediation.ts:139-143`](../../../../hivedoctor/src/remediation.ts)).
- Acceptance: hivenectar's `lastRestartAt`/`markRestarted` is entry-local, so its cooldown does not gate any other entry (delivers [`prd-004a`](../prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) a-AC-8).

---

## Implementation notes

- Registry entry (the row hivenectar appends): schema + field-to-`HiveDoctorConfig` mapping in [`prd-004a`](../prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) "Registry file" section; per-daemon field defaults in [`hivedoctor/src/config.ts:28-84`](../../../../hivedoctor/src/config.ts) (`healthUrl` `:37,75`; `daemonPidPath` `:53,155`; `probeIntervalMs` `:31,72`; `startupGraceMs` `:35,74`; `restartGiveUpThreshold` `:45,79`; `restartCooldownMs` `:47,80`).
- Watchdog-war guards (rung 1): [`hivedoctor/src/remediation.ts:107-160`](../../../../hivedoctor/src/remediation.ts) — `RestartRungDeps` (`:107-122`), `createRestartRung` guard order (`:124-131`), cooldown guard (`:139-143`), lock-held-and-healthy guard (`:147-151`).
- Supervisor tick + skip handling: [`hivedoctor/src/supervisor.ts:236-320`](../../../../hivedoctor/src/supervisor.ts) — a skip does not increment the failure count (`:236-240`); the startup-grace window gates the heal path (`:297-301`).
- `~` expansion in pidPath: [`hivedoctor/src/config.ts:153-155`](../../../../hivedoctor/src/config.ts) (`resolveConfig` homedir expansion the registry loader reuses).
- PID file the guard reads: `~/.honeycomb/hivenectar.pid` (written by 003a's `acquireSingleInstanceLock`, mirroring [`honeycomb/src/daemon/runtime/assemble.ts:715-732`](../../../../honeycomb/src/daemon/runtime/assemble.ts)).

No open questions. The `startupGraceMs` = 60000 default is flagged above.
