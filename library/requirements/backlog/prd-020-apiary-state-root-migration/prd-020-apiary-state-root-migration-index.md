<!--
Schema v2 paths on disk:
  Index (this file):
    library/requirements/backlog/prd-020-apiary-state-root-migration/prd-020-apiary-state-root-migration-index.md
  Sub-feature PRDs alongside the index:
    library/requirements/backlog/prd-020-apiary-state-root-migration/prd-020a-apiary-root-helper-and-path-adoption.md
    library/requirements/backlog/prd-020-apiary-state-root-migration/prd-020b-one-time-migration-and-legacy-fallback.md
    library/requirements/backlog/prd-020-apiary-state-root-migration/prd-020c-service-unit-and-doctor-registry-adoption.md
  QA report (authored by quality-worker-bee):
    library/requirements/backlog/prd-020-apiary-state-root-migration/qa/prd-020-apiary-state-root-migration-qa.md
  Lifecycle moves:
    backlog/ -> in-work/ -> completed/   (entire prd-020-apiary-state-root-migration/ folder moves)
-->

# PRD-020: Migrate nectar runtime state to the `~/.apiary/nectar/` fleet root

> **Status:** Backlog
> **Priority:** P1 (fleet-wide directory-ownership decision; unblocks PRD-019's state file landing in its final home)
> **Effort:** M (4-8h)
> **Schema changes:** None in Deeplake. On-disk relocation only: nectar's runtime state moves from the legacy shared `~/.honeycomb` directory to nectar's own subdirectory `~/.apiary/nectar/` under the neutral fleet root, per fleet ADR-0003 (mirrored locally as nectar ADR-0005). Adds one nectar-owned migration marker file under the new state dir.

---

## Overview

Every piece of nectar's per-product runtime state today lives directly in the legacy shared `~/.honeycomb` directory, via `RUNTIME_DIR_NAME = ".honeycomb"` (`src/config.ts:15`) resolved from `homedir()` in `resolveConfig` (`src/config.ts:110-114`), whose own code comment calls it "shared with honeycomb + doctor" (PRD-002d). Concretely:

- the pid + lock files `nectar.pid` / `nectar.lock` (`src/config.ts:123-124`);
- the per-install config file `nectar.json` (`src/config-file.ts:74-77`);
- the pending-review queue `pending-reviews.json` (`src/daemon.ts:684`, `src/cli.ts:619`);
- the doctor-facing telemetry SQLite `telemetry/nectar.sqlite` (`src/telemetry/db.ts:36-43`);
- the usage-telemetry ledger `nectar-usage-telemetry.json` (`src/telemetry-usage/emit.ts:71,165-168`);
- the launchd log directory, HARDCODED as `<home>/.honeycomb/nectar` (`src/service/templates.ts:32-34`, consumed at `src/service/templates.ts:88` and `src/service/index.ts:228`).

Fleet ADR-0003 (superproject `library/knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md`, mirrored in this repo as [`ADR-0005`](../../../knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md)) names this arrangement path dependence, not design: the fleet's shared coordination surface and every product's private state live under one workload's brand. The decision, confirmed 2026-07-04, is one brand-neutral home-anchored fleet root `~/.apiary/` with a per-product subdirectory each product owns exclusively. Nectar's is `~/.apiary/nectar/`.

This PRD is nectar's slice of that four-repo change: introduce the fleet-root helper with the ADR's precedence chain, move every nectar-owned state file listed above into `~/.apiary/nectar/`, run a one-time idempotent migration on first boot after upgrade with legacy-fallback reads during the window, and carry the new paths into the doctor registry entry nectar writes. The fleet-shared coordination surface (registry, device id, install id) is doctor's and the installer's to relocate, NOT nectar's; nectar only adjusts what it reads and where it writes its own entry (see Non-Goals).

**This index covers the module scope.** Sub-PRD 020a introduces the root helper and adopts it at every nectar path-derivation site. 020b owns the one-time migration, the legacy fallback reads, and mid-migration crash safety. 020c owns the service-unit log directory, the doctor registry entry refresh, and the cross-repo coordination window.

---

## Goals

- **One nectar-owned state directory.** All nectar-owned runtime state (pid, lock, `nectar.json`, `pending-reviews.json`, `telemetry/nectar.sqlite`, the usage-telemetry ledger, launchd logs) lives under `~/.apiary/nectar/`, and nothing nectar owns is created in `~/.honeycomb` on a fresh install.
- **The ADR's precedence chain, exactly.** The fleet root resolves through one helper implementing the canonical `resolveFleetRoot` chain in ADR-0005 "Resolved decisions" (confirmed 2026-07-04): `APIARY_HOME` env (the installer's `--home=` pin is delivered as `APIARY_HOME`; see 020a) > `$XDG_STATE_HOME/apiary` on Linux only when `$XDG_STATE_HOME` is explicitly set > `<homedir()>/.apiary`. There is no `~/.local/state` default. The root is anchored on `os.homedir()`, never `process.cwd()` (ADR-0005 "The root is home-anchored, selectable, and never cwd").
- **`NECTAR_RUNTIME_DIR` keeps working.** The existing product-level override (`src/config.ts:113`) still wins over the derived `<fleet-root>/nectar` for nectar's own state dir, so tests and operators who point nectar at an ephemeral dir are unaffected.
- **Safe one-time migration.** On first boot after upgrade, if `~/.apiary/nectar/` state is absent but the legacy `~/.honeycomb` equivalent exists, migrate it. The migration is idempotent and additive: it never deletes a legacy file it did not successfully migrate, readers fall back to the legacy location while the new path is absent, and a mid-migration crash never loses pid/lock single-instance continuity.
- **Doctor sees the new paths.** The registry entry nectar writes (`healthUrl`, `pidPath`, `telemetryDbPath`; `src/doctor-registry.ts:134-146`) carries the post-migration paths, including for already-installed daemons that upgrade without re-running the installer.

## Non-Goals

- **Relocating the fleet-shared coordination surface.** `~/.honeycomb/doctor.daemons.json` -> `~/.apiary/registry.json`, `device.json`, and the `install-id` file are doctor's and the installer's migration scope (ADR-0005 layout table). Nectar keeps WRITING its registry entry into the file where doctor currently reads it, `~/.honeycomb/doctor.daemons.json` (`src/doctor-registry.ts:110-112`), until doctor's own migration PRD lands. Nectar's `install-id` READ (`src/telemetry-usage/emit.ts:208-216`) gains a new-location-first fallback but nectar never writes or moves that file.
- **Touching `~/.deeplake/`.** Credentials and the folder-binding `projects.json` are a Deeplake-family surface, explicitly unchanged by ADR-0005.
- **The per-repo committed projection.** `<projectRoot>/.honeycomb/nectars.json` (`DEFAULT_PROJECTION_REL_PATH`, `src/projection/format.ts:13`) is a shared family format committed into user repos (PRD-011), not home-directory runtime state. It does not move, and neither does the `.honeycomb` entry in `ALWAYS_IGNORED_SEGMENTS` (`src/registration/ignore.ts:43`) or the `GRAPH_IGNORE_FILE` convention `.honeycomb/graph-ignore.json` (`src/registration/ignore.ts:46`) that protect it.
- **Other products' migrations.** doctor, honeycomb, and hive run their own parallel migration PRDs in their own repos. This PRD only defines what nectar must tolerate during the coordination window (020c).
- **Removing the legacy fallback.** The fallback read stays until the fleet is confidently migrated (ADR-0005 Consequences); its removal is a follow-up with its own criterion (all supported install paths ship the migration).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-020a-apiary-root-helper-and-path-adoption`](./prd-020a-apiary-root-helper-and-path-adoption.md) | The `resolveApiaryRoot()` / `nectarStateDir()` helper implementing the ADR precedence chain; adopt it in `resolveConfig` and at every site that re-derives `join(homedir(), RUNTIME_DIR_NAME)` independently (`config-file.ts`, `telemetry/db.ts`, `telemetry-usage/emit.ts`); keep `NECTAR_RUNTIME_DIR` as the product-level override. | Draft |
| [`prd-020b-one-time-migration-and-legacy-fallback`](./prd-020b-one-time-migration-and-legacy-fallback.md) | The one-time, idempotent, additive first-boot migration of legacy `~/.honeycomb` state into `~/.apiary/nectar/`; legacy-fallback reads while the new path is absent; pid/lock single-instance continuity across the window and mid-migration crash safety. | Draft |
| [`prd-020c-service-unit-and-doctor-registry-adoption`](./prd-020c-service-unit-and-doctor-registry-adoption.md) | Move the hardcoded launchd log dir (`templates.ts:33`) under the new state dir; refresh nectar's doctor registry entry so `pidPath` / `telemetryDbPath` carry the new paths after migration; document the cross-repo coordination window with doctor / honeycomb / hive. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given a fresh install with no legacy `~/.honeycomb` nectar state, when the daemon boots and runs, then every nectar-owned artifact (pid, lock, `nectar.json` reads, `pending-reviews.json`, `telemetry/nectar.sqlite`, the usage ledger) is created under `~/.apiary/nectar/`, and nectar creates nothing of its own under `~/.honeycomb` (the doctor registry entry write to `~/.honeycomb/doctor.daemons.json` is the sole, deliberate exception until doctor migrates). |
| AC-2 | Given `APIARY_HOME` is set, when any nectar entry point resolves state paths, then the fleet root is `$APIARY_HOME` and nectar's state dir is `$APIARY_HOME/nectar`; given `NECTAR_RUNTIME_DIR` is also set, then it wins for nectar's own state dir exactly as today (`src/config.ts:110-114` precedence, extended). |
| AC-3 | Given an upgraded install whose legacy `~/.honeycomb` holds nectar state and whose `~/.apiary/nectar/` is absent, when the daemon first boots, then the migratable files (`nectar.json`, `pending-reviews.json`, `telemetry/nectar.sqlite`, the usage ledger) are migrated into `~/.apiary/nectar/`, a second boot performs no further migration work (idempotent), and no legacy file that failed to migrate is deleted. |
| AC-4 | Given a crash at any point during the migration, when the daemon boots again, then no state is lost (every file exists in at least one of the two locations), the single-instance guard still refuses a second daemon (it checks the legacy pid/lock while the window is open), and the migration completes on the retry. |
| AC-5 | Given a reader (config file, pending reviews, telemetry DB, usage ledger, install-id) finds the new path absent, when it falls back, then it reads the legacy `~/.honeycomb` equivalent, and post-migration writes land only in the new location. |
| AC-6 | Given a macOS service install, when the launchd unit is rendered and installed, then its log directory is under the resolved nectar state dir (no `<home>/.honeycomb/nectar` literal remains in `src/service/templates.ts`), and `service/index.ts` creates exactly that directory. |
| AC-7 | Given the migration has run (or a fresh install), when nectar's doctor registry entry is written or refreshed, then `pidPath` and `telemetryDbPath` point into `~/.apiary/nectar/`, while the registry FILE stays at `~/.honeycomb/doctor.daemons.json` until doctor's own migration lands. |
| AC-8 | Given the non-moving surfaces, when the full suite runs, then `~/.deeplake/` paths, `DEFAULT_PROJECTION_REL_PATH` (`.honeycomb/nectars.json`), `GRAPH_IGNORE_FILE`, and `ALWAYS_IGNORED_SEGMENTS` are byte-identical to before this PRD. |

---

## Data model changes

None in Deeplake (FR-8 untouched; no tables, no columns). On disk: nectar's runtime state relocates from `~/.honeycomb/*` to `~/.apiary/nectar/*`, and one nectar-owned migration marker file is added under the new state dir (name and shape owned by 020b) so the first-boot migration is provably one-time. PRD-019's brooding-state file `projects.json` (not yet implemented) is specified to land directly at `~/.apiary/nectar/projects.json`; see the reconciliation note in the PRD-019 index.

---

## API changes

None. No HTTP surface changes: `/health`, the `/api/hive-graph/*` routes, and the CLI verb set are untouched. The only externally visible contract change is the VALUES inside nectar's doctor registry entry (`pidPath`, `telemetryDbPath`), which doctor already treats as opaque absolute paths (`src/doctor-registry.ts:69-93`).

---

## Alternatives considered

- **Keep everything in `~/.honeycomb` (rejected).** The zero-cost option, rejected by ADR-0005: it entrenches the naming lie and blocks the per-product independence nectar ADR-0002 requires.
- **A nectar-only top-level `~/.nectar/` (rejected, and superseded where already recorded).** PRD-019 originally recorded `~/.nectar/projects.json` for the brooding state. ADR-0005 rejects per-product top-level dirs (they lose single-directory discovery and still need a shared home for the registry). PRD-019's references are updated to `~/.apiary/nectar/projects.json` as part of this PRD's documentation reconciliation.
- **Flip the default with no migration (rejected).** Changing `RUNTIME_DIR_NAME` alone would strand every existing install's pid continuity, telemetry history, pending reviews, and config; doctor would probe a stale `pidPath`. The one-time migration plus fallback window is the cost of not breaking upgrades.
- **Symlink `~/.honeycomb` to `~/.apiary/nectar` (rejected).** A junction/symlink is not reliably creatable without elevation on Windows, silently aliases OTHER products' state into nectar's dir (the legacy dir is shared), and hides rather than fixes the ownership split.

---

## Open questions

- **Linux default when `XDG_STATE_HOME` is unset.** RESOLVED per fleet ADR-0003 "Resolved decisions" (mirrored locally as ADR-0005, confirmed 2026-07-04): honor `$XDG_STATE_HOME/apiary` only when `XDG_STATE_HOME` is explicitly set; otherwise `~/.apiary` on Linux too, keeping one discoverable default across platforms. The ADR carries the canonical `resolveFleetRoot` chain; 020a implements it verbatim. (020a)
- **Whether pid/lock files migrate at all.** They are ephemeral per-boot artifacts; the leaning (020b) is to NOT copy them and instead have the single-instance guard check the legacy location for a live daemon during the window, creating fresh pid/lock at the new path. DEFAULT - confirm in 020b review.
- **Registry entry refresh mechanics for upgrades-in-place.** `registerWithDoctor` is an install-time file edit (PRD-003c). An upgraded daemon that migrates without re-running the installer leaves doctor holding stale `pidPath`/`telemetryDbPath`. The leaning (020c) is a one-time idempotent entry refresh as the final migration step, reusing the existing `registerWithDoctor` mechanic. DEFAULT - confirm before implementation.
- **`install-id` read order during the window.** Nectar reads the installer-minted `~/.honeycomb/install-id` today (`src/telemetry-usage/emit.ts:68,208-216`). Once the installer mints it at the fleet root, nectar should prefer `<fleet-root>/install-id` and fall back to the legacy path. DEFAULT - confirm the ordering with the installer's own migration timeline. (020a/020c)

---

## Related

- [`ADR-0005-fleet-directory-ownership-and-neutral-state-root`](../../../knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md) - the local mirror of fleet ADR-0003, the decision this PRD implements for nectar.
- Superproject `library/knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md` - the authoritative fleet-wide ADR (edit there, re-sync the mirror).
- [`ADR-0002-nectar-independent-daemon-supervised-by-doctor`](../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md) - the independence requirement `~/.apiary/nectar/` finally makes true on disk.
- [`prd-019-project-scoped-brooding-activation`](../prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md) - the forcing function; its brooding-state file location is revised by ADR-0003 to `~/.apiary/nectar/projects.json`.
- [`prd-002-nectar-daemon`](../../completed/prd-002-nectar-daemon/prd-002-nectar-daemon-index.md) - PRD-002d chose the shared `~/.honeycomb` runtime dir this PRD retires for nectar-owned state.
- [`prd-003-nectar-supervision`](../../completed/prd-003-nectar-supervision/prd-003-nectar-supervision-index.md) - PRD-003b/003c own the service unit templates and the doctor registry entry 020c touches.
- [`prd-017-service-checkin-and-sqlite-telemetry`](../../completed/prd-017-service-checkin-and-sqlite-telemetry/prd-017-service-checkin-and-sqlite-telemetry-index.md) - the telemetry SQLite whose path moves and whose registry pointer (`telemetryDbPath`) must follow.
- `src/config.ts:15,110-127` - `RUNTIME_DIR_NAME` and `resolveConfig`, the primary seam 020a rewires.
- `src/doctor-registry.ts` - the registry entry writer whose VALUES change and whose target FILE deliberately does not (yet).
