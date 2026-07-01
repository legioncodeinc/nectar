# PRD-004d: thehive OS service unit + daemon registration

> **Codebase:** the `the-hive` repo (thehive's own service unit, implemented by the-hive [`prd-001d`](../../../../../the-hive/library/requirements/in-work/prd-001-thehive-portal-daemon/prd-001d-service-unit-and-registration.md)) + each daemon's installer (registry edits). This is an out-of-band sub-PRD; it lands in `the-hive` (and the installers), not hivenectar.

## Overview

This sub-PRD covers the two wiring concerns that make thehive and any future workload daemon real OS-level citizens: (1) **thehive's own OS service unit** — the launchd/systemd/schtasks definition that boots thehive immediately on OS start and restarts it on crash, modeled on hivedoctor's existing service-install path (`hivedoctor/src/service/index.ts:129-234`); and (2) **how installers register a daemon** in hivedoctor's registry file (004a) — the one-step file edit a thehive or hivenectar installer performs at install time, with no hivedoctor restart.

Together with 004c (thehive's process + dashboard), this delivers the always-on property: thehive boots on OS start via its service unit, registers itself in the registry so hivedoctor supervises it, and is updateable independently because its service unit is separate from hivedoctor's.

## Goals

- thehive ships an OS service unit (launchd on macOS, systemd on Linux, schtasks on Windows) that starts thehive on boot/login and restarts it on crash, mirroring hivedoctor's service-install contract (`hivedoctor/src/service/index.ts:143-192`).
- thehive's service unit is installed/removed by thehive's own installer (an analogue of hivedoctor's `install-service`/`uninstall-service` CLI at `hivedoctor/src/cli/dispatch.ts:195-204`), not by hivedoctor.
- Registering a daemon in hivedoctor's registry is a single JSON-file edit performed by that daemon's installer; it does not require touching hivedoctor's code or restarting hivedoctor.
- A registered daemon is supervised at hivedoctor's next boot; the registry is append-only and idempotent (re-running an installer does not duplicate an entry).

## Non-Goals

- No runtime registration API. Registration is install-time file edit only (locked decision).
- No hivedoctor restart on registration. A newly-registered daemon is picked up at hivedoctor's next boot, not immediately (004a non-goal: no live reload).
- thehive does NOT supervise other daemons. hivedoctor is the only supervisor; thehive is a supervised peer.
- No cross-platform service-manager abstraction beyond what hivedoctor's `service/index.ts` already encodes. thehive reuses the same plan/render/install pattern rather than reinventing it.
- This sub-PRD does NOT define the hivenectar service unit in detail — that is PRD-003b. It defines the *pattern* (model on hivedoctor's service path) and the *registration step* every daemon's installer shares.

---

## User stories + acceptance criteria

### US-1 — thehive boots on OS start

**As** an operator, **when** I install thehive, **I** get a service unit that boots it on next login/boot.

| ID | Criterion |
|---|---|
| d-AC-1 | Given thehive's installer runs `install-service`, when it resolves the platform (macOS/Linux/Windows via the same environment resolution as `hivedoctor/src/service/index.ts:134-135`), then it writes the platform-appropriate unit file and registers it with the platform service manager. |
| d-AC-2 | Given thehive's service unit is registered, when the device boots (or the user logs in), then thehive starts automatically. |
| d-AC-3 | Given thehive crashes, when the service manager observes the exit, then it restarts thehive (the unit's restart policy mirrors hivedoctor's "restart on crash and start on boot" message at `hivedoctor/src/service/index.ts:190`). |

### US-2 — thehive is installed/removed independently of hivedoctor

**As** an operator, **when** I uninstall thehive, **I** do not affect hivedoctor's service.

| ID | Criterion |
|---|---|
| d-AC-4 | Given thehive and hivedoctor are separate service units, when thehive's `uninstall-service` runs, then only thehive's unit file is removed (mirroring the unit-file cleanup at `hivedoctor/src/service/index.ts:208-218`); hivedoctor's unit is untouched. |
| d-AC-5 | Given thehive's `install-service`, when it renders the unit, then the unit execs thehive's own entrypoint + exec path, never hivedoctor's (the composition root's `self-update` boundary in `hivedoctor/src/compose/index.ts:21-25` is the analogue: thehive's service never installs or starts hivedoctor). |

### US-3 — Installers register in the registry

**As** the thehive installer (or the hivenectar installer), **when** I run, **I** append my daemon's entry to the registry file.

| ID | Criterion |
|---|---|
| d-AC-6 | Given the thehive installer runs, when it finishes, then `~/.honeycomb/hivedoctor.daemons.json` (004a) contains a thehive entry with `name: "thehive"`, `healthUrl`, `pidPath`, and the per-daemon intervals. |
| d-AC-7 | Given the registry already contains a thehive entry, when the thehive installer re-runs, then it updates that entry in place (idempotent) rather than appending a duplicate. |
| d-AC-8 | Given an installer registers a daemon, when registration completes, then hivedoctor is NOT restarted and its code is NOT modified — the installer only edits the JSON file. |

---

## Implementation notes

### thehive service unit (model on hivedoctor's service path)

thehive's `install-service`/`uninstall-service` reuses the structure of hivedoctor's `createServiceModule` (`hivedoctor/src/service/index.ts:129-234`):
- Resolve the platform + scope via the same environment/plan resolution (`service/index.ts:134-135, 138-140`).
- Write the unit file first (`service/index.ts:156-172`), then run the manager's install argv (`service/index.ts:174-185`).
- On uninstall, deregister via the manager then delete the unit file so it cannot resurrect on next boot (`service/index.ts:205-218`).

The difference is the exec path + label: thehive's unit execs thehive's entrypoint and is labeled `thehive` (not `hivedoctor`), so the two services are fully independent (d-AC-4/d-AC-5). The schtasks staged-XML pattern (`service/index.ts:160-163`) generalizes to a thehive-staged path under `~/.honeycomb/thehive/`.

The unit's restart policy delivers d-AC-3: launchd `KeepAlive`/systemd `Restart=always`/schtasks trigger-on-failure, matching the "restart on crash and start on boot" contract hivedoctor's install message advertises (`service/index.ts:190`).

### Registration: installer edits the registry file

The registry file (`~/.honeycomb/hivedoctor.daemons.json`, 004a) is the single registration target. Each daemon's installer performs a read-modify-write on it at install time:
1. Read the file (or treat absence as `{ "daemons": [] }`).
2. Find an entry whose `name` matches this daemon; if present, update it in place (d-AC-7 idempotency); if absent, append a new entry (d-AC-6).
3. Write the file atomically (temp + rename, so a partial write never leaves a corrupt registry hivedoctor would fail to parse on boot).
4. Do NOT restart hivedoctor and do NOT modify hivedoctor's code (d-AC-8).

The thehive installer writes the thehive entry from 004c's defaults (`name: "thehive"`, `healthUrl: http://127.0.0.1:<port>/health`, `pidPath: ~/.honeycomb/thehive.pid`, `probeIntervalMs: 30000`, `startupGraceMs: 60000`, `restartGiveUpThreshold: 3`, `restartCooldownMs: 5000`). The hivenectar installer (PRD-003c) writes the hivenectar entry analogously. Because registration is just a JSON edit, no daemon needs to know hivedoctor's internals or version — it only needs the registry schema (004a).

**Timing (DEFAULT — confirm before implementation):** a freshly-registered daemon is supervised at hivedoctor's *next* boot, not immediately (004a reads the registry once on boot). Since both thehive and hivedoctor boot on OS start (their service units, d-AC-2), the practical upshot is the new daemon is supervised after the next device boot or hivedoctor restart. An installer that wants immediate supervision without a full hivedoctor restart would need a registry-reload signal; that is out of scope here (004a non-goal) and is flagged as a follow-up if operators require hot-add.

### Failure handling

A corrupt or unparseable registry file must not wedge hivedoctor: 004a's fallback (a-AC-2, supervise honeycomb at defaults) handles absence; a malformed file resolves to the same fallback with a logged warning, mirroring the defensive-parse posture throughout `hivedoctor/src/config.ts:86-128`. Installers write atomically (above) so the window for a partial file is negligible.

## Related

- [`prd-004c-thehive-portal-daemon.md`](./prd-004c-thehive-portal-daemon.md) — thehive's process + `/health` + PID/lock this service unit boots.
- [`prd-004a-hivedoctor-registry-config-and-supervisor-instances.md`](./prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) — the registry schema this registration writes + hivedoctor's read-on-boot semantics.
- [`prd-004-hivedoctor-registry-and-thehive-index.md`](./prd-004-hivedoctor-registry-and-thehive-index.md) — module scope.
- **Sibling consumer:** PRD-003b/003c — hivenectar's own service unit + registry entry, which follows the same pattern this sub-PRD establishes.
