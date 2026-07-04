# PRD-020b: One-time migration and legacy fallback

> **Parent:** [PRD-020](./prd-020-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

---

## Problem

Flipping the default state dir (020a) alone would strand every existing install: the daemon would boot with an empty `~/.apiary/nectar/`, losing its config tunables, its pending-review queue, its telemetry history (and with it doctor's check-in view), and its usage-telemetry dedupe ledger, while a still-running pre-upgrade daemon holds its pid/lock at the legacy path where the new binary no longer looks. ADR-0005 mandates a one-time, idempotent, additive migration with legacy-fallback reads until it completes.

## Solution

### What migrates (and what does not)

Migrating, from `~/.honeycomb/` to `~/.apiary/nectar/` (legacy source single-sourced via 020a's `legacyRuntimeDir()`):

| File | Legacy path | New path | Cited writer/reader |
|---|---|---|---|
| Per-install config | `~/.honeycomb/nectar.json` | `~/.apiary/nectar/nectar.json` | `src/config-file.ts:74-77` |
| Pending reviews | `~/.honeycomb/pending-reviews.json` | `~/.apiary/nectar/pending-reviews.json` | `src/daemon.ts:684`, `src/cli.ts:619` |
| Telemetry SQLite | `~/.honeycomb/telemetry/nectar.sqlite` | `~/.apiary/nectar/telemetry/nectar.sqlite` | `src/telemetry/db.ts:36-43` |
| Usage ledger | `~/.honeycomb/nectar-usage-telemetry.json` | `~/.apiary/nectar/nectar-usage-telemetry.json` | `src/telemetry-usage/emit.ts:71,188-206` |

NOT migrating:

- `nectar.pid` / `nectar.lock` (`src/config.ts:123-124`): ephemeral per-boot artifacts. DEFAULT - confirm before implementation: do not copy them; create fresh ones at the new path and extend the single-instance guard to also check the legacy pid for a live process during the window (see crash safety below).
- `~/.honeycomb/doctor.daemons.json`, `device.json`, `install-id`: fleet-shared, doctor's / the installer's migration scope (PRD-020 Non-Goals). Nectar's `install-id` READ gets a fallback (020a); nectar never moves the file.
- `<projectRoot>/.honeycomb/nectars.json` and `.honeycomb/graph-ignore.json`: committed per-repo files, not home-directory state (`src/projection/format.ts:13`, `src/registration/ignore.ts:46`).
- Anything in `~/.honeycomb` nectar does not own (honeycomb's `daemon.pid`/`daemon.lock`, doctor's workspace, etc.). The migration matches an explicit allow-list of nectar-owned filenames, never a directory sweep.

### Mechanics

A new `src/state-migration.ts` module (built-ins only), invoked once at daemon boot inside `assembleDaemon`'s start path, and defensively by CLI verbs that open state directly (`review-matches` at `src/cli.ts:617-619`, telemetry readers) in read-fallback form only (CLI verbs do not run the move; only the daemon does, to keep a single writer):

1. `mkdir -p` the new state dir (mode following the existing `saveLedger` posture, `src/telemetry-usage/emit.ts:202-206`).
2. For each allow-listed file: if the NEW path is absent and the LEGACY path exists, copy legacy -> new via temp-file-plus-rename in the new dir (the same atomic-write discipline as `src/projection/write.ts:56-73` and `writeRegistryAtomic`, `src/doctor-registry.ts:208-219`), then delete the legacy file ONLY after the rename succeeded. A failed copy leaves the legacy file untouched (additive; ADR-0005: never delete a legacy file that was not successfully migrated).
3. If the new path already exists, the legacy file is left alone and never overwritten (new wins; the file may be a fresher write from a post-migration boot).
4. Write the migration marker `~/.apiary/nectar/.migrated-from-honeycomb.json` (`{ schemaVersion: 1, migratedAt, files: [...] }`) after the pass completes. The marker is an audit record and fast-path skip; correctness never depends on it (per-file presence checks make the pass idempotent even if the marker is lost).
5. The whole pass is fail-soft at the file level (one unreadable file logs and skips; the daemon still boots) but each individual move is all-or-nothing.

### Legacy fallback reads

Until the fleet is confidently migrated, every reader prefers the new path and falls back to the legacy path when the new one is absent:

- `loadNectarFileConfig` (`src/config-file.ts:94-97`): if `<new>/nectar.json` is absent, read `<legacy>/nectar.json`.
- `FilePendingReviewStore` construction sites (`src/daemon.ts:684`, `src/cli.ts:619`): open the new path; when absent and the legacy file exists, the fallback applies (in practice the daemon's boot migration makes this moot for the daemon; the fallback covers CLI verbs run against a not-yet-migrated home).
- Telemetry DB open (`src/telemetry/db.ts`): same rule; doctor continuity is handled by 020c's registry refresh.
- Usage ledger + `install-id` (`src/telemetry-usage/emit.ts:188-216`): ledger follows the rule; `install-id` prefers `<fleet-root>/install-id` then `<legacy>/install-id`.

Writes NEVER target the legacy location after 020a lands. The fallback is read-only.

### Crash safety and pid/lock continuity

- **Boot ordering:** before acquiring its own lock at the new path, the daemon checks the LEGACY pid file; if it names a live process (`isPidAlive`, `src/lock.ts`), boot fails with the same already-running error as today. This closes the window where an old binary (pid at legacy path) and a new binary (pid at new path) would each see "no lock" and double-run.
- **Mid-migration crash:** because each file moves atomically (temp + rename, delete-after-success) and the pass is presence-check idempotent, a crash at any point leaves every file readable at exactly one of the two locations, and the next boot's pass completes the remainder. The marker is written last and is not load-bearing.
- **Concurrent CLI + daemon:** CLI verbs never move files (read-fallback only), so the daemon is the single migrating writer; the existing lock serializes daemons.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given a legacy home with all four allow-listed files and an absent `~/.apiary/nectar/`, when the daemon boots, then all four exist at the new paths with identical contents, the legacy copies are gone, and the marker file exists. |
| b-AC-2 | Given the same boot re-run (marker present, or marker deleted but files already at the new paths), when the daemon boots, then the migration performs no writes to the legacy dir and no overwrites of new-path files (idempotent). |
| b-AC-3 | Given a copy that fails mid-file (simulated IO error), when the pass completes, then the legacy file is untouched, the new-path temp artifact is not left as the final name, the daemon still boots, and the next boot retries that file. |
| b-AC-4 | Given a live pre-upgrade daemon holding the LEGACY pid/lock, when the new binary boots, then it refuses to start with the already-running error; given a stale legacy pid (dead process), boot proceeds and creates fresh pid/lock at the new path only. |
| b-AC-5 | Given a not-yet-migrated home, when a CLI verb (e.g. `review-matches`) or `loadNectarFileConfig` runs, then it reads the legacy file transparently (fallback), performs no migration moves, and a subsequent daemon boot still migrates normally. |
| b-AC-6 | Given files nectar does not own in `~/.honeycomb` (e.g. honeycomb's `daemon.pid`, doctor's `doctor.daemons.json`), when the migration runs, then they are byte-identical afterward (allow-list, never a sweep). |
| b-AC-7 | Given a partially-migrated home (some files moved, some not, marker absent), when the daemon boots, then the pass completes the remainder and every reader resolves each file from wherever it currently is (new preferred, legacy fallback). |

## Implementation notes

- The telemetry SQLite move must happen before the check-in writer opens the DB (`src/telemetry/checkin.ts` boot wiring), so ordering inside `assembleDaemon` is: resolve paths -> legacy-pid liveness check -> migrate -> acquire lock -> open stores. Do not move a SQLite file while any handle is open.
- Reuse one shared `copyThenRename` utility with `src/projection/write.ts:56-73` if extraction is clean; otherwise mirror it (jscpd-style duplication discipline does not apply here, but keep the pattern identical).
- Log each migrated file as a structured NDJSON line (matching `defaultWarn`, `src/config-file.ts:79-81`) so support can reconstruct what moved.
- The fallback-read seam should be one helper (`resolveStateFile(name): string` returning new-if-present-else-legacy) so 020a's "no stray `join(homedir(), '.honeycomb')`" assertion (a-AC-5) holds: only this module and 020a's `legacyRuntimeDir()` may reference the legacy dir.

## Related

- [`prd-020a-apiary-root-helper-and-path-adoption`](./prd-020a-apiary-root-helper-and-path-adoption.md) - supplies `nectarStateDir()` / `legacyRuntimeDir()`.
- [`prd-020c-service-unit-and-doctor-registry-adoption`](./prd-020c-service-unit-and-doctor-registry-adoption.md) - the registry entry refresh that runs as the migration's final step.
- `src/lock.ts` - the single-instance guard extended with the legacy-pid liveness check.
- `src/projection/write.ts:56-73`, `src/doctor-registry.ts:208-219` - the atomic-write discipline the move step mirrors.
