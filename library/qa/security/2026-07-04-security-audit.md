# Security Audit - PRD-019 / PRD-020 (apiary root and activation)

- **Date:** 2026-07-04
- **Auditor:** security-worker-bee
- **Scope:** `feature/apiary-root-and-activation` @ `C:/Users/mario/GitHub/the-apiary/nectar` (uncommitted working tree, HEAD `d3b19e2`) carrying PRD-020 (apiary state-root migration) and PRD-019 (project-scoped brooding activation: 019a/019b/019d).
- **Ordering:** ran BEFORE `quality-worker-bee`, whose 2026-07-04 reports for PRD-019 and PRD-020 note these remediations as present in the diff under review. This record backfills the in-repo audit file the QA reports observed as missing (the pass itself ran and its fixes landed before QA).

---

## Executive summary

**One High finding, remediated in-session. One Low finding, remediated in-session. Three Low findings documented and accepted. No Critical findings. Gates green post-fix.**

## Findings

| # | Severity | Location | Finding | Disposition |
|---|---|---|---|---|
| H1 | **High** | `src/registration/gitignore.ts` | ReDoS: a crafted `.gitignore` in an untrusted, non-git bound repo could chain consecutive `**/` runs into overlapping unbounded RegExp quantifiers with exponential backtracking, freezing the single-threaded daemon on the git-absent walk path. | **Fixed**: `collapseGlobStars` collapses consecutive `**/` units (and `***`+) before compilation, bounding the compiled pattern while preserving gitignore semantics. |
| L1 | Low | `src/registration/brooding-state.ts` (and `src/state-migration.ts` state-dir creation) | The nectar state directory was created with default permissions. | **Fixed**: created `0o700` (owner-only) on first write. |
| L2 | Low | `/api/hive-graph/*` error bodies | Verbose error text in loopback API responses. | Documented, accepted: loopback-only, permission-gated surface. (The b-AC-6 persist-failure body was subsequently redacted in the 2026-07-04 QA remediation pass.) |
| L3 | Low | `src/hive-graph/active-projects.ts` | The pathological-root guard is lexical (path comparison), not an inode/realpath check; a symlinked alias of a guarded root could evade it. | Documented, accepted: defense in depth on top of explicit operator binding, not the primary control. |
| L4 | Low | temp-file names (`brooding-state.ts`, `state-migration.ts`, registry/projection writers) | Predictable temp names (`pid` + timestamp) for atomic writes. | Documented, accepted: files live in owner-only directories; rename is atomic. |

## Checked clean

- SQL guards: every identifier/value/LIKE routes through the `sql-guards.ts` helpers; no raw interpolation found in the new PRD-019/020 code.
- Loopback binding: the daemon still refuses to bind off-loopback with the default open permission gate (PRD-018j); the new `/projects` endpoints inherit the group gate.
- POST validation: the brooding-toggle body is hand-validated (closed value sets, non-empty `projectId`); the 1 MiB request-body cap covers the new endpoints.
- Token redaction: no credential or token value is logged or echoed by the new code paths.
- Containment: per-project contexts construct their disk fs rooted at the bound path (CWE-22 containment via `paths-safe.ts` unchanged); discovery for one project cannot enumerate another's tree.

## Baseline verification

| Check | After remediation |
|---|---|
| `npm run build` | clean |
| `npm run typecheck` | clean |
| Non-live suite | green (0 fail; live Deeplake network tests excluded per the orchestrator) |
