# PRD-004a: doctor daemon registry — config schema + per-daemon supervisor instances + isolated incident state

> **Codebase:** the `doctor` repo. This is an out-of-band sub-PRD; it lands in the doctor codebase, not nectar.

## Overview

doctor today holds a single daemon's supervision parameters in `DoctorConfig` (`doctor/src/config.ts:28-54`) — one `healthUrl`, one `startupGraceMs`, one `restartGiveUpThreshold`, one `restartCooldownMs`, one `daemonPidPath` — and its composition root (`doctor/src/compose/index.ts:190-534`) builds exactly one supervisor over those values. This sub-PRD generalizes that single-daemon config into a **named registry of supervised daemons** read from a static JSON file on boot, and spawns **one independent supervisor instance per registry entry**. Each instance carries its own isolated incident log and remediation state, so a nectar restart never touches honeycomb's incident record.

The registry is the contract every workload daemon registers into (PRD-003 for nectar; hive registers itself in 004d). doctor gains the registry; it does NOT gain a runtime HTTP registration API (locked decision). A new daemon registers by its installer appending one entry to the registry file.

## Goals

- doctor reads the supervised-daemon list from a static registry file on boot; the existing single-daemon fields (`doctor/src/config.ts:37-53`) become per-entry values in that registry.
- The composition root generalizes from one `createSupervisor` call (`doctor/src/compose/index.ts:320-331`) to N — one per registry entry, each constructed with that entry's `healthUrl`/`pidPath`/`probeIntervalMs`/`startupGraceMs`/`restartGiveUpThreshold`/`restartCooldownMs`.
- Each supervisor instance owns an isolated `state.json` shard and incident stream, so per-daemon failure state never cross-contaminates.
- The watchdog-war guards (`doctor/src/remediation.ts:124-160`) apply per-entry: a restart's cooldown + lock-held-and-healthy checks read the entry's own `pidPath`, never a shared path.

## Non-Goals

- No runtime HTTP registration API. Registration is a file edit by an installer at install time.
- No live registry reload / hot-add. doctor reads the registry once on boot; a new entry takes effect at the next doctor boot. (PRD-004d specifies that installers do NOT restart doctor to register, so a freshly-registered daemon is supervised at doctor's next natural boot — typically OS start.)
- No registry ownership of the auto-update engine. Auto-update (`doctor/src/compose/index.ts:333-375`) stays scoped to the honeycomb primary package; per-daemon update is each daemon's own concern.
- No change to doctor's process topology — doctor is still one OS process. The N supervisor instances are concurrent loops within it, not N processes.

---

## User stories + acceptance criteria

### US-1 — Boot from the registry

**As** doctor, **when** I boot, **I** read the registry file and **then** spawn one supervisor per listed daemon.

| ID | Criterion |
|---|---|
| a-AC-1 | Given a registry file at `~/.honeycomb/doctor.daemons.json` listing three daemons, when doctor boots, then it constructs three `createSupervisor` instances, one per entry. |
| a-AC-2 | Given the registry file is absent, when doctor boots, then it falls back to supervising the honeycomb primary daemon at its defaults (the registry is additive over the existing single-daemon behavior — a missing file must not wedge the watchdog). |
| a-AC-3 | Given a registry entry is missing an optional field (e.g. `probeIntervalMs`), when the entry is loaded, then the field resolves to the built-in default (mirroring the defensive-parse posture of `doctor/src/config.ts:86-128`), never a crash. |

### US-2 — Isolated per-daemon state

**As** an operator, **when** daemon A is restarted, **I** expect daemon B's incident log and failure count to be untouched.

| ID | Criterion |
|---|---|
| a-AC-4 | Given two registered daemons A and B, when A fails `/health` and is restarted by its supervisor, then B's `consecutiveRestartFailures`, `backoffRung`, `lastRestartAt`, and incident episodes are unchanged. |
| a-AC-5 | Given each registry entry, when its supervisor persists state, then the state is written to a per-daemon shard keyed by the entry `name` (e.g. `~/.honeycomb/doctor/state-<name>.json`), not a single shared `state.json`. |
| a-AC-6 | Given each registry entry, when its supervisor writes an incident episode, then the episode is appended to a per-daemon incident stream (e.g. `incidents-<name>.ndjson`), so `doctor logs` (004b) can be filtered per daemon. |

### US-3 — Per-entry watchdog-war guards

**As** the restart rung for daemon X, **when** I check the cooldown and lock, **I** read X's own `pidPath`, never a shared PID file.

| ID | Criterion |
|---|---|
| a-AC-7 | Given a registry entry with `pidPath: ~/.honeycomb/nectar.pid`, when its restart rung runs the lock-held-and-healthy guard (`doctor/src/remediation.ts:147-151`), then it reads exactly that path, not the honeycomb `~/.honeycomb/daemon.pid` default from `doctor/src/config.ts:53`. |
| a-AC-8 | Given a registry entry's `restartCooldownMs`, when a restart was performed for that entry, then a second restart for the same entry inside the cooldown is skipped (`doctor/src/remediation.ts:139-143`), and the cooldown does not gate any other entry's restart. |

---

## Implementation notes

### Registry file (DEFAULT — confirm before implementation)

**DEFAULT — confirm before implementation:** the registry file lives at `~/.honeycomb/doctor.daemons.json`. doctor reads it once on boot, alongside its existing `resolveConfig` (`doctor/src/config.ts:150-179`).

**Registry schema (DEFAULT — confirm before implementation):**

```json
{
  "daemons": [
    {
      "name": "honeycomb",
      "healthUrl": "http://127.0.0.1:3850/health",
      "pidPath": "~/.honeycomb/daemon.pid",
      "probeIntervalMs": 30000,
      "startupGraceMs": 60000,
      "restartGiveUpThreshold": 3,
      "restartCooldownMs": 5000
    },
    {
      "name": "hive",
      "healthUrl": "http://127.0.0.1:3853/health",
      "pidPath": "~/.honeycomb/hive.pid",
      "probeIntervalMs": 30000,
      "startupGraceMs": 60000,
      "restartGiveUpThreshold": 3,
      "restartCooldownMs": 5000
    },
    {
      "name": "nectar",
      "healthUrl": "http://127.0.0.1:3854/health",
      "pidPath": "~/.honeycomb/nectar.pid",
      "probeIntervalMs": 30000,
      "startupGraceMs": 60000,
      "restartGiveUpThreshold": 3,
      "restartCooldownMs": 5000
    }
  ]
}
```

Each entry's fields are the per-daemon values that `DoctorConfig` (`doctor/src/config.ts:28-54`) currently holds once for the single honeycomb daemon:
- `healthUrl` ← `config.healthUrl` (`:37`, default `http://127.0.0.1:3850/health` at `:75`).
- `pidPath` ← `config.daemonPidPath` (`:53`, default `~/.honeycomb/daemon.pid` at `:155`).
- `probeIntervalMs` ← `config.probeIntervalMs` (`:31`, default `30000` at `:72`).
- `startupGraceMs` ← `config.startupGraceMs` (`:35`, default `60000` at `:74`).
- `restartGiveUpThreshold` ← `config.restartGiveUpThreshold` (`:45`, default `3` at `:79`).
- `restartCooldownMs` ← `config.restartCooldownMs` (`:47`, default `5000` at `:80`).

The remaining `DoctorConfig` fields — `probeTimeoutMs` (`:33`), `statusPagePort` (`:39`), `backoffFloorMs`/`backoffCeilingMs` (`:41-43`), `installHealthIntervalMs` (`:49`), `workspaceDir` (`:51`) — stay process-global in `DoctorConfig`; they are doctor's own runtime knobs, not per-daemon supervision knobs. Only the six per-daemon fields above move into the registry.

**Portability note:** `name` accepts `"honeycomb" | "hive" | "nectar"` (the three known daemons). `pidPath` and `healthUrl` carry `~` for readability; the loader expands `~` to `homedir()` exactly as `resolveConfig` already does (`doctor/src/config.ts:153-155`).

### Per-entry supervisor construction

The composition root's single supervisor build (`doctor/src/compose/index.ts:320-331`) generalizes to a loop. Today it calls:

```ts
const supervisor = createSupervisor({
  probe, ladder, backoff, stateStore, incidents, logger, clock,
  probeIntervalMs: config.probeIntervalMs,
  startupGraceMs: config.startupGraceMs,
  onError,
});
```

For each registry entry, the root constructs a dedicated `probe` (over the entry's `healthUrl`, mirroring `compose/index.ts:214`), a dedicated ladder whose restart rung reads the entry's `pidPath` (`remediation.ts:107-122` `RestartRungDeps`), a dedicated `backoff`, a dedicated `stateStore` shard, and a dedicated `incidents` log — then calls `createSupervisor` (`doctor/src/supervisor.ts:144`) with the entry's intervals. `start()` arms every supervisor's loop; `stop()` disarms all of them, mirroring the existing `Promise.allSettled` join in `compose/index.ts:517-521`.

The supervisor itself (`doctor/src/supervisor.ts:144-343`) needs no change — it is already a per-instance factory: `createSupervisor(deps)` closes over its own `running`/`stopped`/`graceUntilMs`/`heal`/`tick` state (`supervisor.ts:145-159`). N calls already produce N independent loops. The work is in the composition root (one call → a loop of calls) and the registry loader (the new input).

### Isolated incident + remediation state

Today `createStateStore` and `createIncidentLog` are bound to the single `config.workspaceDir` (`doctor/src/compose/index.ts:202-204`). Per-entry isolation keys these on the entry `name`:
- `createStateStore({ workspaceDir, name })` writes `state-<name>.json` instead of `state.json`.
- `createIncidentLog({ workspaceDir, name })` appends to `incidents-<name>.ndjson`.

This is what delivers a-AC-4/a-AC-5/a-AC-6: each supervisor's `stateStore.read()`/`.write()` (`supervisor.ts:275, 285, 308`) and `incidents.open()`/`.write()` (`supervisor.ts:306, 309`) hit its own shard. The heal path's `consecutiveRestartFailures` increment (`supervisor.ts:254-258`) and the give-up decision (`supervisor.ts:186`) read/write only the entry's state.

The shared, process-level pieces — `installCrashNet` (`supervisor.ts:105-134`), the auto-update poll loop (`compose/index.ts:370-375`), and the loopback status page (004b) — stay singletons; the crash net still guards the whole process and the status page still aggregates every entry (004b).

### Per-entry watchdog-war guards

`createRestartRung`'s guards (`doctor/src/remediation.ts:124-160`) are already dependency-injected: `readDaemonPid` (`:111`), `isHealthy` (`:113`), `cooldownMs` (`:115`), `lastRestartAt`/`markRestarted` (`:119-121`) are all `RestartRungDeps`. Today the composition root passes `readDaemonPid: async () => null` (`compose/index.ts:240`). Per-entry, the root passes a `readDaemonPid` that reads the entry's `pidPath`, the entry's `restartCooldownMs` as `cooldownMs`, and an entry-local `lastRestartAt`/`markRestarted` pair (not the single `let lastRestartAt` at `compose/index.ts:237`). That delivers a-AC-7/a-AC-8 without changing `remediation.ts`.

## Related

- [`prd-004-doctor-registry-and-hive-index.md`](./prd-004-doctor-registry-and-hive-index.md) — module scope.
- [`prd-004b-doctor-status-and-cli.md`](./prd-004b-doctor-status-and-cli.md) — the reporting surfaces that read the N isolated state shards.
- [`prd-004d-hive-service-unit-and-registration.md`](./prd-004d-hive-service-unit-and-registration.md) — how installers append entries to this registry.
