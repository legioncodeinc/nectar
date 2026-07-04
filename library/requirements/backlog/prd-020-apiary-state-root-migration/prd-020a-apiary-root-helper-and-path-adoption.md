# PRD-020a: Apiary root helper and path adoption

> **Parent:** [PRD-020](./prd-020-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S-M

---

## Problem

Nectar's state paths are anchored on the legacy shared directory in FOUR independent places, and only one of them is override-aware:

1. `resolveConfig` builds `runtimeDir` as `overrides.runtimeDir ?? NECTAR_RUNTIME_DIR ?? join(homedir(), RUNTIME_DIR_NAME)` with `RUNTIME_DIR_NAME = ".honeycomb"` (`src/config.ts:15,110-114`); pid/lock derive from it (`src/config.ts:123-124`), and so do the pending-review stores (`src/daemon.ts:684`, `src/cli.ts:619`).
2. `nectarConfigPath` re-derives `join(homedir(), RUNTIME_DIR_NAME)` on its own (`src/config-file.ts:74-77`), honoring only a test-injected `dir` option.
3. `defaultTelemetryDbPath` re-derives it again (`src/telemetry/db.ts:40-43`).
4. `defaultStateDir` in the usage-telemetry chokepoint re-derives it a fourth time (`src/telemetry-usage/emit.ts:165-168`).

ADR-0005 requires every product to resolve ONE fleet root through one precedence chain (`APIARY_HOME` env > installer `--home=` flag / config > XDG on Linux > `<home>/.apiary`) and to own exactly one subdirectory beneath it. Four hand-rolled derivations cannot guarantee that.

## Solution

### The helper

Add `src/apiary-root.ts` (built-ins only: `node:os`, `node:path`, matching the zero-runtime-dependency rule):

- `resolveApiaryRoot(env = process.env): string` implements the ADR precedence chain:
  1. `APIARY_HOME` env var (trimmed, non-blank; blank/whitespace treated as unset, matching `envStr` in `src/config.ts:99-103`).
  2. The installer-pinned home. Nectar has no `--home=` flag of its own; the superproject installer realizes this leg by pinning `APIARY_HOME` into the rendered service unit environment (see 020c and superproject ADR-0002), so inside nectar it collapses into leg 1. DEFAULT - confirm before implementation that no separate nectar-side config key is wanted.
  3. Linux XDG: when `platform() === "linux"` and `XDG_STATE_HOME` is set and non-blank, `join($XDG_STATE_HOME, "apiary")`; when unset, fall through to leg 4. RESOLVED per fleet ADR-0003 "Resolved decisions" (mirrored locally as ADR-0005, confirmed 2026-07-04): XDG is honored only when explicitly set, there is no `~/.local/state/apiary` default, and the default location is `~/.apiary` on every platform. The ADR carries the canonical `resolveFleetRoot` chain that doctor / honeycomb / hive implement identically.
  4. `join(homedir(), ".apiary")`. Anchored on `os.homedir()`, NEVER `process.cwd()` (ADR-0005: the cwd footgun must be structurally impossible for state).
- `nectarStateDir(env = process.env): string` returns `join(resolveApiaryRoot(env), "nectar")`.
- `legacyRuntimeDir(): string` returns `join(homedir(), ".honeycomb")`, single-sourcing the legacy location for 020b's migration and fallback reads instead of scattering the old literal.

Because nectar imports nothing from the sibling repos (ADR-0002: mirror, never import), doctor / honeycomb / hive vendor the same helper semantics in their own migration PRDs. The helper's tests are the cross-repo contract; a drift between the four copies is a coordination bug (020c).

### Adoption

- `resolveConfig` (`src/config.ts:110-114`): the default `runtimeDir` becomes `nectarStateDir()`. The full precedence for nectar's own state dir is then: `overrides.runtimeDir` > `NECTAR_RUNTIME_DIR` (kept working as the product-level override, unchanged semantics) > `nectarStateDir()` (which itself resolves `APIARY_HOME` / XDG / `~/.apiary`). `RUNTIME_DIR_NAME` stops being the default's source; it is retained (renamed or re-documented as the LEGACY dir name) for 020b's migration and fallback reads.
- `nectarConfigPath` (`src/config-file.ts:74-77`): default `dir` becomes `nectarStateDir()`; the `options.dir` test seam is unchanged.
- `defaultTelemetryDbPath` (`src/telemetry/db.ts:40-43`): derives from `nectarStateDir()`; `telemetryDbPathForRuntimeDir` (`src/telemetry/db.ts:36-38`) is unchanged, so anything already flowing a resolved `runtimeDir` through it follows automatically.
- `defaultStateDir` (`src/telemetry-usage/emit.ts:165-168`): becomes `nectarStateDir()`; the `deps.dir` test seam is unchanged. The `install-id` read (`src/telemetry-usage/emit.ts:208-216`) is adjusted in concert with 020b's fallback rules: prefer `<fleet-root>/install-id`, fall back to the legacy `~/.honeycomb/install-id` (the file itself is installer-owned and never written by nectar).
- Everything already derived from `config.runtimeDir` (pid/lock at `src/config.ts:123-124`, pending-reviews at `src/daemon.ts:684` and `src/cli.ts:619`, the registry entry's `telemetryDbPath` at `src/doctor-registry.ts:134,145`) follows with no further change, which is the point of adopting the helper at the derivation root.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given no relevant env vars, when `resolveApiaryRoot()` runs on any platform, then it returns `join(homedir(), ".apiary")`, and `nectarStateDir()` returns `join(homedir(), ".apiary", "nectar")`; `process.cwd()` is never consulted. |
| a-AC-2 | Given `APIARY_HOME=/custom/root`, when any of the four adoption sites resolves its default path, then the path is under `/custom/root/nectar`; a blank or whitespace-only `APIARY_HOME` is treated as unset. |
| a-AC-3 | Given Linux with `XDG_STATE_HOME=/xdg/state` set, when `resolveApiaryRoot()` runs, then it returns `/xdg/state/apiary`; on Linux with `XDG_STATE_HOME` unset it returns `join(homedir(), ".apiary")` (per fleet ADR-0003 "Resolved decisions", mirrored as ADR-0005); on darwin/win32 the XDG leg is skipped entirely. |
| a-AC-4 | Given `NECTAR_RUNTIME_DIR=/tmp/n`, when `resolveConfig()` runs, then `runtimeDir`, `pidFilePath`, and `lockFilePath` resolve under `/tmp/n` exactly as before this PRD (`src/config.ts:110-127` behavior preserved), regardless of `APIARY_HOME`. |
| a-AC-5 | Given the default resolution, when `nectarConfigPath()`, `defaultTelemetryDbPath()`, and the usage-telemetry `defaultStateDir()` run, then all three return paths under `~/.apiary/nectar/`, and no production code path outside the migration/fallback module (020b) computes `join(homedir(), ".honeycomb")` any more. |
| a-AC-6 | Given the existing test seams (`resolveConfig` overrides, `NectarConfigOptions.dir`, `UsageEmitDeps.dir`, `telemetryDbPathForRuntimeDir`), when the current test suites run against the new defaults, then the seams behave identically (only defaults changed). |

## Implementation notes

- Keep the helper dependency-free and pure (env injected) so it is trivially testable and copy-verifiable against the sibling repos' vendored copies.
- `resolveConfig`'s doc comment (`src/config.ts:1-9`) and `RUNTIME_DIR_NAME`'s comment (`src/config.ts:14`) both describe the shared-dir convention; update them to describe the fleet root + legacy dir split so the code stops asserting the superseded design.
- The `.honeycomb` literals that must NOT change: `DEFAULT_PROJECTION_REL_PATH` (`src/projection/format.ts:13`), `GRAPH_IGNORE_FILE` (`src/registration/ignore.ts:46`), `ALWAYS_IGNORED_SEGMENTS` (`src/registration/ignore.ts:43`), and the doctor registry path (`src/doctor-registry.ts:110-112`, owned by 020c's coordination rules). List them in the change's test plan as explicit no-change assertions (module AC-8).

## Related

- [`prd-020b-one-time-migration-and-legacy-fallback`](./prd-020b-one-time-migration-and-legacy-fallback.md) - consumes `legacyRuntimeDir()` and the fallback rules.
- [`prd-020c-service-unit-and-doctor-registry-adoption`](./prd-020c-service-unit-and-doctor-registry-adoption.md) - the installer-pin leg of the precedence chain and the registry write-side.
- `src/config.ts`, `src/config-file.ts`, `src/telemetry/db.ts`, `src/telemetry-usage/emit.ts` - the four adoption sites.
- [`ADR-0005`](../../../knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md) - the precedence chain and the never-cwd rule.
