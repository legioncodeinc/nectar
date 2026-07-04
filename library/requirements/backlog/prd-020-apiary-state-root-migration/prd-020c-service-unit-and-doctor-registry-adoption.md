# PRD-020c: Service unit and doctor registry adoption

> **Parent:** [PRD-020](./prd-020-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S-M

---

## Problem

Two surfaces outside the path-derivation core still bake in the legacy layout, and the fleet's other products need a defined coordination window:

1. The launchd log directory is a hardcoded string, `` `${home}/.honeycomb/nectar` `` (`launchdLogDir`, `src/service/templates.ts:32-34`), rendered into the plist (`src/service/templates.ts:88`) and created by the installer (`src/service/index.ts:228`). It does not follow `resolveConfig` at all.
2. Nectar's doctor registry entry carries absolute `pidPath` and `telemetryDbPath` values derived from the runtime dir at install time (`buildNectarRegistryEntry`, `src/doctor-registry.ts:134-146`). After 020a/020b, an install that migrates in place (upgrade, no re-install) leaves doctor probing the STALE legacy paths, so doctor would report nectar dead while it runs fine.

## Solution

### Launchd log directory

- Replace the hardcoded literal so `launchdLogDir` derives from the resolved nectar state dir: `~/.apiary/nectar/logs`. DEFAULT - confirm before implementation: the `logs` subdirectory name (the legacy layout used a bare `<home>/.honeycomb/nectar` dir holding only logs; now that `~/.apiary/nectar/` holds ALL state, a `logs/` subdir keeps stdout/stderr from mixing with state files).
- `src/service/index.ts:228` keeps creating exactly the directory the plist references (the single-sourcing rationale documented at `src/service/templates.ts:25-31` is preserved; only the value changes).
- Because the plist bakes an absolute path at install time, `ServicePlan` (or its construction) must carry the RESOLVED state dir, honoring `APIARY_HOME` / `NECTAR_RUNTIME_DIR` at install time the same way the daemon honors them at runtime. A unit installed under a custom root logs under that root.
- Old units installed before this PRD keep logging to the legacy dir until `nectar install` is re-run; the migration (020b) does not rewrite installed service units. Re-install refreshes the unit (the existing idempotent install path).

### Installer environment pinning

- The precedence chain's installer leg (020a leg 2) is realized by the superproject installer pinning `APIARY_HOME` into the rendered unit environment when the operator chose a non-default root, and ALWAYS for the Windows LocalSystem opt-in: per ADR-0005, the `sc.exe` Windows Service backend (enterprise opt-in via `preferSystemScope`, never the userland default; `src/service/platform.ts:15-16`) runs under an account whose `homedir()` is `System32\config\systemprofile`, so the installer captures the installing user's home and pins the resolved root into the service environment. The default per-user Scheduled Task / LaunchAgent / systemd-user paths resolve correctly at runtime with no pin.
- Nectar-side scope here is only: the unit templates must be able to carry an environment variable (launchd `EnvironmentVariables`, systemd `Environment=`, schtasks/sc equivalent) when the plan requests it. The install.sh / install.ps1 changes are superproject ADR-0002 scope, not this repo's.

### Doctor registry entry refresh

- Fresh installs need no change: `buildNectarRegistryEntry` already derives `pidPath` from the resolved config and `telemetryDbPath` from `pidPath`'s directory (`src/doctor-registry.ts:134-146`), so once 020a lands, install-time entries carry `~/.apiary/nectar/` paths automatically.
- Upgrades-in-place: as the FINAL step of the 020b migration (after files moved, before the marker is treated as complete), the daemon performs a one-time idempotent entry refresh reusing the existing `registerWithDoctor` mechanic (`src/doctor-registry.ts:257-271`), which replaces nectar's own entry keyed by `name: "nectar"` and preserves every other daemon's entry. DEFAULT - confirm before implementation: this is the first time the daemon (not the installer) writes the registry; PRD-003c framed registration as an install-time file edit. The alternative (wait for the next `nectar install`) leaves doctor probing stale paths indefinitely on auto-updated installs.
- The registry FILE target follows the fleet ADR's registry compatibility window contract (RESOLVED 2026-07-04, ADR-0005 "Resolved decisions"): nectar writes its entry to `~/.apiary/registry.json` when the fleet root directory exists, otherwise to the legacy `~/.honeycomb/doctor.daemons.json` (`defaultDoctorRegistryPath`, `src/doctor-registry.ts:110-112`); never both. Doctor's reader merges the two locations during the window (new wins per daemon `name`, legacy-only entries merge additively), so a nectar entry landing in either file stays supervised. The known concurrent-install race (`src/doctor-registry.ts:27-30`, NEC-032) is unchanged in scope.

### Cross-repo coordination window

doctor, honeycomb, and hive run their own parallel migration PRDs. The contract nectar relies on during the window:

- doctor's registry READER tolerates entries whose `pidPath` / `telemetryDbPath` point at either layout (they are opaque absolute paths to doctor; no doctor change should be required, but doctor's PRD must assert it).
- When doctor relocates the registry file, doctor's migration moves the WHOLE file including nectar's entry; nectar then updates `defaultDoctorRegistryPath` in a follow-up (tracked as an open question below, not implemented speculatively).
- The shared `install-id` and `device.json` move with the installer's / doctor's migration; nectar's read-fallback (020a/020b) tolerates both locations in the interim.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given a macOS install with default resolution, when the plist is rendered, then its stdout/stderr paths are under `~/.apiary/nectar/logs`, `service/index.ts` creates that exact directory, and no `.honeycomb` literal remains in `src/service/templates.ts`. |
| c-AC-2 | Given `APIARY_HOME=/custom/root` at install time, when the unit is rendered, then the launchd log dir is under `/custom/root/nectar/logs`, and (when the plan pins the env) the unit carries `APIARY_HOME=/custom/root` so the daemon resolves the same root at runtime. |
| c-AC-3 | Given a fresh `nectar install` after 020a, when the registry entry is written, then `pidPath` and `telemetryDbPath` point into `~/.apiary/nectar/`, the entry lands in `~/.apiary/registry.json` when the fleet root exists (else the legacy `~/.honeycomb/doctor.daemons.json`, per the ADR window contract), and every other daemon's entry is preserved unchanged (`registerWithDoctor` semantics, `src/doctor-registry.ts:252-271`). |
| c-AC-4 | Given an upgrade-in-place whose registry entry still holds legacy paths, when the 020b migration completes, then the refreshed entry carries the new paths, the refresh is idempotent across boots, and a PRESENT-but-malformed registry file fails loudly without being clobbered (`src/doctor-registry.ts:164-202` posture preserved). |
| c-AC-5 | Given the Windows LocalSystem opt-in plan (`sc` backend), when the unit is rendered with a pinned home, then the resolved root in the unit environment is the installing user's, never `System32\config\systemprofile` (ADR-0005 Windows edge). |
| c-AC-6 | Given doctor has not yet migrated, when nectar runs post-migration, then doctor's probe of the refreshed `healthUrl` / `pidPath` / `telemetryDbPath` succeeds end-to-end (manual or integration verification against a real doctor build during the window). |

## Implementation notes

- `renderUnit` and the plan builder are pure string construction from `ServicePlan` (`src/service/templates.ts:1-18`); thread the resolved state dir through the plan rather than importing `resolveConfig` inside the template module, keeping templates deterministic and snapshot-testable.
- The registry refresh must run AFTER the telemetry SQLite has moved (020b ordering), so `telemetryDbPath` never points at a path that does not exist yet.
- The write-target rule is exactly the ADR contract: new path when the fleet root exists, else legacy, never both. Doctor's merge rule (not a nectar-side dual write) is what keeps the two locations coherent during the window.

## Open questions

- ~~When doctor's migration relocates the registry, does nectar detect it or ship a coordinated follow-up?~~ RESOLVED per the fleet ADR's registry compatibility window contract (confirmed 2026-07-04): nectar detects it structurally; the write target is `~/.apiary/registry.json` whenever the fleet root directory exists, else the legacy path. No coordinated follow-up release is required.

## Related

- [`prd-020b-one-time-migration-and-legacy-fallback`](./prd-020b-one-time-migration-and-legacy-fallback.md) - the migration pass whose final step is the registry refresh.
- `src/service/templates.ts`, `src/service/index.ts`, `src/service/platform.ts` - the unit rendering + install surfaces.
- `src/doctor-registry.ts` - the entry builder, atomic writer, and fail-loud malformed-file posture this sub-PRD preserves.
- Superproject `library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md` - the installer that pins the resolved root into service units (out-of-repo scope).
- doctor `ADR-0002-service-registration-static-registry-plus-runtime-sqlite` (doctor repo) - the registry contract whose file location doctor's own PRD moves.
