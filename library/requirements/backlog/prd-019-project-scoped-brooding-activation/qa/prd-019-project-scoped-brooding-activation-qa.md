# QA Report: PRD-019 Project-scoped brooding and activation control

**Plan document:** `library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md` (plus sub-PRDs 019a / 019b / 019d; 019c is implemented in the hive repo and audited there, its nectar-side contract is checked below)
**Grounding:** the index's "Resolved decisions (confirmed 2026-07-04)" table and `library/knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md`
**Audit date:** 2026-07-04
**Base branch:** `feature/apiary-root-and-activation` (HEAD `d3b19e2`; all implementation changes uncommitted in the working tree)
**Auditor:** quality-worker-bee

Ordering note: `security-worker-bee` ran before this audit per the orchestrator. Its remediations are present in the diff under review: the ReDoS fix in the gitignore parser (`collapseGlobStars`, `src/registration/gitignore.ts:59-61`) and the owner-only `0o700` brooding-state directory mode (`src/registration/brooding-state.ts:173-176`). No 2026-07-04 security report file exists under nectar `library/qa/security/` (the audit appears to be recorded at the superproject level); noted as an observation, not an ordering violation.

## Summary

Pass with warnings. The daemon is genuinely dormant by default and multi-root: with zero bound projects it constructs no context, broods nothing, and `/health` reports `activeProjects: 0` with reason `no-active-projects`; the cwd fallback is gone from every daemon path (the remaining `process.cwd()` uses are CLI-verb-only and the unwired legacy `assembleDaemon` seam). All four in-repo AC groups (index AC-1..7, a-AC-1..7, b-AC-1..7, d-AC-1..7) trace to implementation, and the gates are green (build, typecheck, 706 non-live tests, 703 pass / 0 fail / 3 platform-conditional skips). Five Warnings, none an AC violation: the known primary-project-at-boot scoping of live enrichment and the hive-graph API (assessed independently below; the orchestrator's "no AC violated" read holds), a missing b-AC-4-named test, no `**`/ReDoS regression tests behind the security fix, the b-AC-6 "redacted error" returning raw filesystem error text, and dead `resolveBootProjection` code left by the multi-root rewire.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | Every 019a/b/d AC implemented; index ACs composed and traced; 019c's nectar-side contract matches hive's consumer |
| Correctness   | ✅ | Dormant-by-default, multi-root reconcile, pathological-root guard, ON defaults, and gitignore semantics (incl. negation/nested/anchored under the ReDoS fix) all verified |
| Alignment     | ⚠️ | Live enrichment + hive-graph API scoped to the primary project at boot (documented follow-up); no AC violated, but the index Goal names the enrich leg |
| Gaps          | ⚠️ | b-AC-4 and the `**`/ReDoS matcher behavior lack named tests; b-AC-7 tested at the parse/render layer only |
| Detrimental   | ⚠️ | Dead `resolveBootProjection` in `src/cli.ts` (the PRD-011b boot pre-warm is no longer wired); raw error text in the b-AC-6 500 body |

## Gate outputs

- `npm run build` (tsc): pass.
- `npm run typecheck` (tsc --noEmit): pass.
- Non-live suite (`node --experimental-sqlite --test` over 62 files, excluding `hive-graph-search-live.test.ts`, `hive-graph-deeplake.test.ts`, `deeplake-transport.test.ts` per the orchestrator): 706 tests, 703 pass, 0 fail, 3 skipped (two POSIX-only permission tests skipped on win32, one symlink-permission skip).

## Contract verification highlights

- **No cwd fallback anywhere in the daemon.** `runDaemon` (`src/cli.ts:1084-1177`) never consults `process.cwd()` or `NECTAR_PROJECT_ROOT`; scope comes only from the bound active set. The legacy `projectRoot = options.projectRoot ?? process.cwd()` seam remains in `assembleDaemon` (`src/daemon.ts:545`) but is inert in the shipped daemon: without `registrationStore` / `asyncBroodStore` / `broodStore` wired, neither `triggerAutoBrood` (`src/daemon.ts:657-661`) nor the single-root registration pipeline (`src/daemon.ts:725-727`) can touch that root. Proven end-to-end by `test/daemon-active-projects.test.ts` (factory throws if ever invoked with zero active projects).
- **Multi-root reconcile.** `ProjectSupervisor.reconcile` serializes cycles, starts/stops/restarts-on-path-change per project (`src/project-supervisor.ts:85-123`), driven on the poll cadence plus on demand from the toggle API (`src/active-projects-runtime.ts:43-51`, `src/api/projects-api.ts:123-128`).
- **Pathological-root guard list.** `$HOME`, filesystem/drive roots, and `%WINDIR%\System32` are refused with `/health` reason `pathological-root` (`src/hive-graph/active-projects.ts:65-92,131-134`), matching the index's resolved-decision list exactly.
- **Brooding state at `~/.apiary/nectar/projects.json` with ON defaults.** `broodingStatePath` derives from `nectarStateDir` (`src/registration/brooding-state.ts:65-72`); `DEFAULT_PROJECT_BROODING = "on"`, `DEFAULT_GLOBAL_BROODING = "on"` (`:35-38`) per the resolved decisions; fail-soft loader, forward-compatible unknown-key warnings, atomic 0o700 first-write (`:99-180`).
- **Registry window write target** (shared surface with PRD-020): `defaultDoctorRegistryPath` writes `<fleet-root>/registry.json` when the fleet root exists, else the legacy file, never both (`src/doctor-registry.ts:111-116`), per the ADR contract the index cites.
- **Gitignore parser semantics under the ReDoS fix.** `collapseGlobStars` collapses `**/` runs and `***`+ before compilation (`src/registration/gitignore.ts:59-61`); negation (`!`), nested `.gitignore` precedence, anchored patterns, dir-only patterns, and `.git/info/exclude` all pass their named tests (`test/gitignore.test.ts`), so the fix did not regress the specified semantics. The collapse preserves gitignore meaning by inspection (consecutive `**/` units are idempotent), but no test exercises a `**` pattern at all; see Warnings.
- **019c nectar-side contract match.** Hive's consumer (`hive/src/dashboard/web/wire.ts:943-981,2459-2486`) expects `GET /api/hive-graph/projects` returning `{ globalBrooding: "on"|"paused", projects: [{ projectId, name, path, brooding, watcher, counts }] }` and `POST /api/hive-graph/projects/brooding` with `{ projectId, brooding }` or `{ global }`, acking the same view. Nectar's `ProjectsView` (`src/projects-control.ts:29-47`) and `mountProjectsApi` (`src/api/projects-api.ts:94-131`) match field-for-field, including the honest `counts: null`.

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Live enrichment and the hive-graph API are scoped to the primary active project at boot**, `src/cli.ts:1146-1177,1216-1240`

  `primary` is computed once in `runDaemon`; the enricher loop and `mountHiveGraphApi` (search/build/status) are wired only when a primary active project exists at boot and stay bound to it. Consequences: (1) a daemon booted dormant that later gains a bound project runs brood + watch for it (the per-context path, including describe when Portkey is configured) but watch-appended pending version rows are not enriched until a restart, and the search/build endpoints stay unmounted until a restart; (2) with two active projects, only the first is enriched live. Independent assessment against the ACs: index AC-2 requires "begins brooding + watching it", which the context start path satisfies (`src/registration/project-context.ts:129-169`); a-AC-3/a-AC-4 speak of brood + watch contexts, which are per-project; b-AC-4's resume path runs brood + resync per context. No AC text is violated, confirming the orchestrator's read. It does drift from the index Goal "the daemon runs its watch + brood + enrich legs against the set of bound, brooding-enabled project directories" (index line 49), and the code marks it as a documented follow-up (`src/cli.ts:1146-1148`). Track the follow-up explicitly (ledger or a PRD) so the gap does not silently persist.

- [ ] **b-AC-4 has no named test (OFF then ON resume with cold-catch-up resync)**, `test/projects-api.test.ts`, `test/project-supervisor.test.ts`

  The resume behavior is implemented (`createProjectContext.start()` runs auto-brood, hydrates, starts the watcher, and calls `service.requestResync()`, `src/registration/project-context.ts:129-169`; the supervisor restarts a newly-active project) and its pieces are covered by the a-AC-3/a-AC-7 context test and the a-AC-5 supervisor test, but no test drives the specific b-AC-4 sequence (project paused via the API, set back to `on`, reconcile resumes watch + brood + resync). The repo convention names each test after the AC it proves; b-AC-4 is the one AC in the four groups without a named test.

- [ ] **No `**` semantics or ReDoS regression tests for the gitignore parser**, `src/registration/gitignore.ts:46-92`, `test/gitignore.test.ts`

  PRD-019d names `**` as a supported construct, and the security remediation (`collapseGlobStars`) specifically rewrote how `**` runs compile, yet `test/gitignore.test.ts` contains no pattern with `**` and no guard proving a crafted `.gitignore` (for example a long `**/**/**/...` chain against a deep path) completes quickly. The fix is correct by inspection, but the exact code path the security audit changed is the one path with zero test coverage. Add a `**` semantics case (for example `a/**/b` and `**/dist`) and a time-bounded pathological-pattern regression.

- [ ] **b-AC-6's "redacted error" returns raw error text**, `src/api/projects-api.ts:117-121`

  On a persist failure the 500 body is `{ error: "persist_failed", reason: errorReason(err) }`, where `reason` is the raw `Error.message` from the filesystem (for example `EACCES: permission denied, open 'C:\Users\...\projects.json...'`), which leaks local paths to the caller. The endpoint is loopback-only and gated, so exposure is low, but b-AC-6 says "returns a redacted error". Return a stable machine code (the `error` field already is one) and drop or genericize `reason` for the persist branch.

  ```ts
  } catch (err: unknown) {
    return ctx.json({ error: "persist_failed", reason: errorReason(err) }, 500);
  }
  ```

- [ ] **Dead `resolveBootProjection` and the unwired PRD-011b boot pre-warm**, `src/cli.ts:962-998`

  The multi-root rewire stopped passing `bootProjection` into `assembleDaemon`, leaving `resolveBootProjection` defined but never called. Functionally the projection inherit still happens per project through the brood pipeline's disk load (`resolveProjection`, `src/brooding/pipeline.ts:183-188`), so no data path is lost when a brood runs; but the boot pre-warm that inherited hash-matched files WITHOUT brooding no longer runs in the shipped daemon, and the dead function will confuse the next reader. Either delete it or re-wire the pre-warm per active project.

## Suggestions (consider improving)

- [ ] **CLI usage text still describes the cwd default without scoping it to CLI verbs**, `src/cli.ts:132-133`

  "The project root comes from NECTAR_PROJECT_ROOT (defaults to the current working directory)" is now true only for the CLI verbs (`brood`, `prune`, `search` context, etc.), not the daemon. A one-line clarification ("the daemon's scope comes from bound projects; see `nectar projects`") would prevent operators from expecting `NECTAR_PROJECT_ROOT` to steer the daemon, which `runDaemon` no longer reads (the 019a implementation note had suggested keeping it as a documented power-user override; only the `options.projectRoot` test seam was kept).

- [ ] **`nectar brooding on|off --all` issues one POST per project**, `src/cli.ts:938-946`

  Sequential per-project toggles are fine at dashboard scale, but each POST triggers a full reconcile. A batch body (or persisting all flags then reconciling once) would avoid N reconciles for N projects.

## Plan Item Traceability

Test names cite the AC they prove; all listed tests pass in the gate run above.

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-1 | Empty/absent bindings: daemon broods nothing, watches nothing, `/health` reports zero with machine-readable reason, never a cwd brood | ✅ | `src/hive-graph/active-projects.ts:114-145`, `src/health.ts:131-136`, `src/cli.ts:1084-1177` | `test/daemon-active-projects.test.ts` "index AC-1 / a-AC-1 / a-AC-2"; `test/active-projects.test.ts` "index AC-1 / a-AC-1" |
| AC-2 | A dashboard bind activates the directory; nectar broods + watches it under its resolved tenancy id | ✅ | `src/projects-control.ts:65-83`, `src/registration/project-context.ts:86-169` | "index AC-2 / a-AC-3" test + daemon reconcile test; live enrichment scoping noted in Warnings (no AC text violated) |
| AC-3 | Two or more projects brood + watch independently; nothing outside the bound set discovered | ✅ | `src/project-supervisor.ts:90-123`, per-context fs rooted at the bound path (`src/registration/project-context.ts:90-92`) | "index AC-3 / a-AC-4" + supervisor tests; containment by per-root disk fs construction |
| AC-4 | Brooding OFF stops watch + brood, mints nothing new, leaves binding + Deeplake data untouched; ON resumes | ✅ | `src/api/projects-api.ts:106-130`, `src/project-supervisor.ts:96-107`, `src/registration/project-context.ts:170-188` | b-AC-3 test (persist-then-reconcile) + supervisor stop tests; `stop()` only stops/drains, touches no data; resume test gap tracked as the b-AC-4 Warning |
| AC-5 | Global pause overrides per-project state; `/health` reflects it; clearing restores | ✅ | `src/registration/brooding-state.ts:183-187`, `src/hive-graph/active-projects.ts:138-144,158` | b-AC-5 API test + "a global pause makes nothing active" resolution test |
| AC-6 | Non-git (or git-erroring) roots honor `.gitignore`; every CLI discovery path uses the shared predicate | ✅ | `src/registration/gitignore.ts`, `src/registration/ignore.ts:252-315`, `src/cli.ts:216-224,344-348,586-591,647,975-984,1044` | d-AC-1..7 named tests |
| AC-7 | Bind/unbind while running starts/stops within one reconcile cycle, no restart | ✅ | `src/active-projects-runtime.ts:43-51,60-65` | "a-AC-5 / index AC-7" daemon test |
| a-AC-1 | No bindings: no RegistrationService, no triggerAutoBrood, `/health` `activeProjects: 0` reason `no-active-projects` | ✅ | `src/daemon.ts:567-580,943-953`, `src/health.ts:131-136` | named tests (resolution + daemon) |
| a-AC-2 | cwd `$HOME`/`/`/`System32` with no bindings: nothing under cwd discovered or brooded | ✅ | `src/cli.ts:1084-1177` (no cwd consult), `src/daemon.ts:657-661` (no-op without stores) | daemon test's throwing factory proves no context is ever constructed |
| a-AC-3 | One bound project: exactly one context rooted at the bound path, scoped to `resolveProjectScope`'s id | ✅ | `src/cli.ts:1116-1131` (tenancy from creds + binding projectId), `src/registration/project-context.ts:86-98` | named tests (resolution + context) |
| a-AC-4 | Two projects: independent contexts, no cross-enumeration | ✅ | `src/project-supervisor.ts:90-123` | named tests |
| a-AC-5 | Bind/unbind mid-run: start/stop next reconcile, no restart | ✅ | `src/project-supervisor.ts:85-123` | named tests (supervisor + daemon) |
| a-AC-6 | Guarded roots refused, `/health` lists `refused: pathological-root` | ✅ | `src/hive-graph/active-projects.ts:65-92,131-134,168` | named tests (resolution + daemon) |
| a-AC-7 | Teardown stops watcher and drains bridge writes before release | ✅ | `src/registration/project-context.ts:170-188`, `src/active-projects-runtime.ts:74-81` | named tests (context + supervisor stopAll) |
| b-AC-1 | Missing file/dir reads as defaults (global on, project on); first write creates the dir | ✅ | `src/registration/brooding-state.ts:99-102,170-180` | named test |
| b-AC-2 | Malformed/non-object file warns and defaults, never throws | ✅ | `src/registration/brooding-state.ts:104-120` | named test |
| b-AC-3 | POST off persists, immediate reconcile stops watch + brood, data untouched | ✅ | `src/api/projects-api.ts:106-130`, `src/projects-control.ts:110-119` | named test (persist-before-reconcile ordering asserted) |
| b-AC-4 | Set back to on: reconcile resumes watch + brood with cold-catch-up resync | ⚠️ | `src/registration/project-context.ts:129-169` (`requestResync` on start) | Implemented; no b-AC-4-named test (Warning) |
| b-AC-5 | Global paused: nothing broods; `GET /projects` + `/health` report `global-paused`; on restores | ✅ | `src/registration/brooding-state.ts:183-187`, `src/hive-graph/active-projects.ts:158` | named test |
| b-AC-6 | Write failure: redacted error, prior state intact, no reconcile against a half-written file | ⚠️ | `src/api/projects-api.ts:115-122`, atomic write at `src/registration/brooding-state.ts:170-180` | Ordering + state preservation proven by the named test; `reason` carries raw error text (Warning) |
| b-AC-7 | CLI produces the same persisted + reconciled effect as the API; `nectar projects` reflects it | ⚠️ | `src/cli.ts:833-968`, thin client of the same endpoints (`src/api/loopback-client.ts:107-182`) | Satisfied by construction (same POST body, same handler); tests cover arg parsing + rendering only, no live-daemon round-trip |
| c-AC-1..7 | Hive dashboard empty state, toggle, wire methods, unreachable posture, escaping | 🟦 | hive repo (`hive/src/dashboard/web/wire.ts`, `pages/hive-graph.tsx`) | Audited separately in the hive repo; nectar-side contract verified to match field-for-field (see Contract verification highlights) |
| d-AC-1 | Non-git root: `dist/` + `*.log` excluded, `src/x.ts` included (walk fallback) | ✅ | `src/registration/gitignore.ts:182-189`, `src/registration/ignore.ts:302-311` | named tests (pure core + real temp-dir walk) |
| d-AC-2 | Nested `.gitignore` scoped to its own subtree | ✅ | `src/registration/gitignore.ts:222-265` | named test |
| d-AC-3 | Negation re-includes; other matches stay excluded | ✅ | `src/registration/gitignore.ts:98-130,168-174` | named test |
| d-AC-4 | Git present: `ls-files` snapshot authoritative, parser never consulted | ✅ | `src/registration/ignore.ts:302-311` | named test (fallback call counter asserted zero) |
| d-AC-5 | Git present-but-erroring stays loud, parser does not mask | ✅ | `src/registration/ignore.ts:303-309` (`lastError` branch) | named test |
| d-AC-6 | Every CLI discovery site passes the shared predicate | ✅ | `src/cli.ts:216-224,344-348,586-591,647,975-984,1044` | named test (non-git `discoverFiles` walk) + inspection of all five sites |
| d-AC-7 | `createDiskRegistrationFs` default is `createDefaultIgnore(root)`, not ignore-nothing | ✅ | `src/registration/disk-fs.ts:46-53` | named test |
| NG (index) | Shared `~/.deeplake/projects.json` schema unchanged; nectar reads, never writes it | ✅ | `src/projects-control.ts:70-73` (read via `loadProjectsCache` only) | No write path to the shared file exists in the diff |
| NG (index) | Service unit templates stay root-agnostic (no `NECTAR_PROJECT_ROOT` pin) | ✅ | `src/service/templates.ts` | Units carry only the optional `APIARY_HOME` state pin (PRD-020c), no project root |

## Files Changed

Implementation files relevant to PRD-019 (the same working tree also carries PRD-020; see that report):

- `src/active-projects-runtime.ts` (A), the reconcile driver tying resolution to the supervisor and `/health` on the poll cadence
- `src/api/loopback-client.ts` (M), `projectsViaDaemon` / `setBroodingViaDaemon` loopback clients for the CLI
- `src/api/projects-api.ts` (A), `GET /projects` + `POST /projects/brooding` on the hive-graph group with hand-validated bodies
- `src/cli.ts` (M), multi-root `runDaemon` wiring (dormant-by-default, per-project contexts, primary-scoped enricher/API), `nectar projects` + `nectar brooding` verbs, shared ignore predicate on every CLI discovery site
- `src/daemon.ts` (M), the `activeProjects` seam, `reconcileActiveProjects()`, boot publish + reconcile loop arm, teardown drain
- `src/health.ts` (M), the `activeProjects` slice (count, reason, per-project brooding + watcher, refused list)
- `src/hive-graph/active-projects.ts` (A), pure active-set resolution, the pathological-root guard, the `/health` slice builder
- `src/index.ts` (M), export surface additions
- `src/project-supervisor.ts` (A), the serialized `Map<projectId, RunningContext>` reconciler
- `src/projects-control.ts` (A), shared read-view + persist helpers used by both the API and the CLI
- `src/registration/brooding-state.ts` (A), the `~/.apiary/nectar/projects.json` fail-soft store with ON defaults and atomic 0o700 writes
- `src/registration/disk-fs.ts` (M), default predicate becomes `createDefaultIgnore(root)` (d-AC-7)
- `src/registration/gitignore.ts` (A), the dependency-free gitignore matcher (with the `collapseGlobStars` ReDoS guard) + disk loader
- `src/registration/ignore.ts` (M), the git-genuinely-absent parser fallback behind `eligible === null` (loud-error path preserved)
- `src/registration/project-context.ts` (A), the per-project brood + watch `RunningContext` with its own brood guard
- `test/active-projects.test.ts` (A), resolution + guard + health-slice tests (index AC-1/2/3, a-AC-1/3/4/6)
- `test/brooding-state.test.ts` (A), b-AC-1/2/6 + effective-state tests
- `test/daemon-active-projects.test.ts` (A), end-to-end daemon dormancy/reconcile/refusal tests (index AC-1/7, a-AC-1/2/5/6)
- `test/gitignore.test.ts` (A), d-AC-1..7 named tests
- `test/project-context.test.ts` (A), a-AC-3/a-AC-7 context lifecycle test
- `test/project-supervisor.test.ts` (A), a-AC-3/4/5/7 + serialization + path-change restart tests
- `test/projects-api.test.ts` (A), b-AC-3/5/6 + validation tests
- `test/projects-cli.test.ts` (A), b-AC-7 arg parsing + table rendering tests
