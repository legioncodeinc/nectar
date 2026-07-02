# PRD-004d: hive OS service unit + daemon registration

> **Codebase:** the `hive` repo (hive's own service unit, implemented by hive [`prd-001d`](../../../../../hive/library/requirements/in-work/prd-001-hive-portal-daemon/prd-001d-service-unit-and-registration.md)) + each daemon's installer (registry edits). This is an out-of-band sub-PRD; it lands in `hive` (and the installers), not nectar.

## Overview

This sub-PRD covers the two wiring concerns that make hive and any future workload daemon real OS-level citizens: (1) **hive's own OS service unit** — the launchd/systemd/schtasks definition that boots hive immediately on OS start and restarts it on crash, modeled on doctor's existing service-install path (`doctor/src/service/index.ts:129-234`); and (2) **how installers register a daemon** in doctor's registry file (004a) — the one-step file edit a hive or nectar installer performs at install time, with no doctor restart.

Together with 004c (hive's process + dashboard), this delivers the always-on property: hive boots on OS start via its service unit, registers itself in the registry so doctor supervises it, and is updateable independently because its service unit is separate from doctor's.

## Goals

- hive ships an OS service unit (launchd on macOS, systemd on Linux, schtasks on Windows) that starts hive on boot/login and restarts it on crash, mirroring doctor's service-install contract (`doctor/src/service/index.ts:143-192`).
- hive's service unit is installed/removed by hive's own installer (an analogue of doctor's `install-service`/`uninstall-service` CLI at `doctor/src/cli/dispatch.ts:195-204`), not by doctor.
- Registering a daemon in doctor's registry is a single JSON-file edit performed by that daemon's installer; it does not require touching doctor's code or restarting doctor.
- A registered daemon is supervised at doctor's next boot; the registry is append-only and idempotent (re-running an installer does not duplicate an entry).

## Non-Goals

- No runtime registration API. Registration is install-time file edit only (locked decision).
- No doctor restart on registration. A newly-registered daemon is picked up at doctor's next boot, not immediately (004a non-goal: no live reload).
- hive does NOT supervise other daemons. doctor is the only supervisor; hive is a supervised peer.
- No cross-platform service-manager abstraction beyond what doctor's `service/index.ts` already encodes. hive reuses the same plan/render/install pattern rather than reinventing it.
- This sub-PRD does NOT define the nectar service unit in detail — that is PRD-003b. It defines the *pattern* (model on doctor's service path) and the *registration step* every daemon's installer shares.

---

## User stories + acceptance criteria

### US-1 — hive boots on OS start

**As** an operator, **when** I install hive, **I** get a service unit that boots it on next login/boot.

| ID | Criterion |
|---|---|
| d-AC-1 | Given hive's installer runs `install-service`, when it resolves the platform (macOS/Linux/Windows via the same environment resolution as `doctor/src/service/index.ts:134-135`), then it writes the platform-appropriate unit file and registers it with the platform service manager. |
| d-AC-2 | Given hive's service unit is registered, when the device boots (or the user logs in), then hive starts automatically. |
| d-AC-3 | Given hive crashes, when the service manager observes the exit, then it restarts hive (the unit's restart policy mirrors doctor's "restart on crash and start on boot" message at `doctor/src/service/index.ts:190`). |

### US-2 — hive is installed/removed independently of doctor

**As** an operator, **when** I uninstall hive, **I** do not affect doctor's service.

| ID | Criterion |
|---|---|
| d-AC-4 | Given hive and doctor are separate service units, when hive's `uninstall-service` runs, then only hive's unit file is removed (mirroring the unit-file cleanup at `doctor/src/service/index.ts:208-218`); doctor's unit is untouched. |
| d-AC-5 | Given hive's `install-service`, when it renders the unit, then the unit execs hive's own entrypoint + exec path, never doctor's (the composition root's `self-update` boundary in `doctor/src/compose/index.ts:21-25` is the analogue: hive's service never installs or starts doctor). |

### US-3 — Installers register in the registry

**As** the hive installer (or the nectar installer), **when** I run, **I** append my daemon's entry to the registry file.

| ID | Criterion |
|---|---|
| d-AC-6 | Given the hive installer runs, when it finishes, then `~/.honeycomb/doctor.daemons.json` (004a) contains a hive entry with `name: "hive"`, `healthUrl`, `pidPath`, and the per-daemon intervals. |
| d-AC-7 | Given the registry already contains a hive entry, when the hive installer re-runs, then it updates that entry in place (idempotent) rather than appending a duplicate. |
| d-AC-8 | Given an installer registers a daemon, when registration completes, then doctor is NOT restarted and its code is NOT modified — the installer only edits the JSON file. |

---

## Implementation notes

### hive service unit (model on doctor's service path)

hive's `install-service`/`uninstall-service` reuses the structure of doctor's `createServiceModule` (`doctor/src/service/index.ts:129-234`):
- Resolve the platform + scope via the same environment/plan resolution (`service/index.ts:134-135, 138-140`).
- Write the unit file first (`service/index.ts:156-172`), then run the manager's install argv (`service/index.ts:174-185`).
- On uninstall, deregister via the manager then delete the unit file so it cannot resurrect on next boot (`service/index.ts:205-218`).

The difference is the exec path + label: hive's unit execs hive's entrypoint and is labeled `hive` (not `doctor`), so the two services are fully independent (d-AC-4/d-AC-5). The schtasks staged-XML pattern (`service/index.ts:160-163`) generalizes to a hive-staged path under `~/.honeycomb/hive/`.

The unit's restart policy delivers d-AC-3: launchd `KeepAlive`/systemd `Restart=always`/schtasks trigger-on-failure, matching the "restart on crash and start on boot" contract doctor's install message advertises (`service/index.ts:190`).

### Registration: installer edits the registry file

The registry file (`~/.honeycomb/doctor.daemons.json`, 004a) is the single registration target. Each daemon's installer performs a read-modify-write on it at install time:
1. Read the file (or treat absence as `{ "daemons": [] }`).
2. Find an entry whose `name` matches this daemon; if present, update it in place (d-AC-7 idempotency); if absent, append a new entry (d-AC-6).
3. Write the file atomically (temp + rename, so a partial write never leaves a corrupt registry doctor would fail to parse on boot).
4. Do NOT restart doctor and do NOT modify doctor's code (d-AC-8).

The hive installer writes the hive entry from 004c's defaults (`name: "hive"`, `healthUrl: http://127.0.0.1:<port>/health`, `pidPath: ~/.honeycomb/hive.pid`, `probeIntervalMs: 30000`, `startupGraceMs: 60000`, `restartGiveUpThreshold: 3`, `restartCooldownMs: 5000`). The nectar installer (PRD-003c) writes the nectar entry analogously. Because registration is just a JSON edit, no daemon needs to know doctor's internals or version — it only needs the registry schema (004a).

**Timing (DEFAULT — confirm before implementation):** a freshly-registered daemon is supervised at doctor's *next* boot, not immediately (004a reads the registry once on boot). Since both hive and doctor boot on OS start (their service units, d-AC-2), the practical upshot is the new daemon is supervised after the next device boot or doctor restart. An installer that wants immediate supervision without a full doctor restart would need a registry-reload signal; that is out of scope here (004a non-goal) and is flagged as a follow-up if operators require hot-add.

### Failure handling

A corrupt or unparseable registry file must not wedge doctor: 004a's fallback (a-AC-2, supervise honeycomb at defaults) handles absence; a malformed file resolves to the same fallback with a logged warning, mirroring the defensive-parse posture throughout `doctor/src/config.ts:86-128`. Installers write atomically (above) so the window for a partial file is negligible.

## Related

- [`prd-004c-hive-portal-daemon.md`](./prd-004c-hive-portal-daemon.md) — hive's process + `/health` + PID/lock this service unit boots.
- [`prd-004a-doctor-registry-config-and-supervisor-instances.md`](./prd-004a-doctor-registry-config-and-supervisor-instances.md) — the registry schema this registration writes + doctor's read-on-boot semantics.
- [`prd-004-doctor-registry-and-hive-index.md`](./prd-004-doctor-registry-and-hive-index.md) — module scope.
- **Sibling consumer:** PRD-003b/003c — nectar's own service unit + registry entry, which follows the same pattern this sub-PRD establishes.
