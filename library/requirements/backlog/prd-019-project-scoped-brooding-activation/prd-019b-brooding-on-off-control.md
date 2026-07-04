# PRD-019b: Brooding on/off control

> **Parent:** [PRD-019](./prd-019-project-scoped-brooding-activation-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

---

## Problem

There is no operator control over whether nectar sources a given project. `autoBroodEnabled` exists (`src/daemon.ts:195`, `src/daemon.ts:597`) but it is a single boot-time daemon flag, not a per-project, runtime-toggleable, persisted control. The user asked to be able to turn brooding on and off; with 019a making the daemon multi-root, that switch must be per project (plus a global emergency pause).

## Solution

Add a nectar-owned brooding-state store and a small control surface over it.

### State file

`~/.nectar/projects.json` (nectar-owned; NOT the shared `~/.deeplake/projects.json`, per ADR-0002). `~/.nectar/` is a NEW nectar-owned directory created on first write, decoupled from the `~/.honeycomb` runtime dir (`RUNTIME_DIR_NAME`, `src/config.ts:15`) so nectar's state never depends on honeycomb being installed. Fail-soft loader/writer built on `node:fs` only (zero runtime dependencies, matching `src/config-file.ts`):

```jsonc
{
  "schemaVersion": 1,
  "globalBrooding": "on",          // "on" | "paused"
  "projects": {
    "<projectId>": { "brooding": "on" }   // "on" | "off"
  }
}
```

- A missing file, malformed JSON, or a non-object payload reads as defaults: `globalBrooding: "on"`, and each project's brooding defaults to the flagged default (PRD-019 index: **ON** when a project is first seen).
- Unknown keys warn and are skipped (forward compatibility), matching the `config-file.ts` posture.
- Writes are atomic (temp file + rename), matching the projection/registry write discipline elsewhere in the repo.

### Effective state

`effectiveBrooding(projectId) = globalBrooding == "paused" ? "global-paused" : (project.brooding ?? default) == "off" ? "paused" : "active"`.

The 019a reconcile loop treats only `"active"` projects as brood/watch targets.

### API (on nectar's own daemon, extends PRD-008's `/api/hive-graph/*`)

- `GET /api/hive-graph/projects` -> `{ globalBrooding, projects: [{ projectId, name, path, brooding, watcher, counts }] }`. The active set (from 019a) joined with the brooding state and the per-project `/health` slice. Read-only.
- `POST /api/hive-graph/projects/brooding` with a zod-validated body, one of:
  - `{ projectId, brooding: "on" | "off" }` - set a single project.
  - `{ global: "on" | "paused" }` - set the global switch.
  On success it persists to `~/.nectar/projects.json` and triggers an immediate 019a reconcile, then returns the new effective state. Fail-soft: a write failure returns a redacted error and leaves the prior state intact.

Both routes sit behind the same permission gate as the rest of `/api/hive-graph/*` (PRD-018j hardening) and are local-loopback only.

### CLI

- `nectar projects` - print the active set with each project's effective brooding state (the read side of `GET /projects`).
- `nectar brooding <on|off> [--project <id>|--all] [--global-pause|--global-resume]` - the write side. `--project` targets one; `--all` sets every currently-bound project; the global flags flip `globalBrooding`. Mirrors the API precedence.

### Interaction with the enricher (open question resolution)

Turning a project OFF stops new discovery and stops its watcher (019a). Already-pending version rows for that project are left to drain through the enricher (cheap, finite), NOT abandoned; no new rows are created while OFF. Confirm in review; this is the leaning recorded in the PRD-019 index open questions.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given no `~/.nectar/projects.json` (and no `~/.nectar/` dir), when the store loads, then `globalBrooding` is `on` and a newly-seen bound project's brooding defaults to `on`, with no crash on the missing file/dir; the first write creates `~/.nectar/`. |
| b-AC-2 | Given a malformed or non-object `~/.nectar/projects.json`, when the store loads, then it warns and falls back to defaults (never throws), matching `config-file.ts`. |
| b-AC-3 | Given an active project, when `POST /api/hive-graph/projects/brooding { projectId, brooding: "off" }` succeeds, then the file records `off`, an immediate reconcile stops that project's watch + brood, and no new nectars are minted for it; the binding and existing Deeplake rows are untouched. |
| b-AC-4 | Given a paused project, when it is set back to `on`, then a reconcile resumes its watch + brood and a cold-catch-up resync runs (019a start path). |
| b-AC-5 | Given `POST .../brooding { global: "paused" }`, when it succeeds, then no project broods regardless of per-project state and `GET /projects` + `/health` report `global-paused`; setting `{ global: "on" }` restores each project to its own state. |
| b-AC-6 | Given a write to `~/.nectar/projects.json` fails (e.g. disk error), when the toggle API is called, then it returns a redacted error, the in-memory + on-disk prior state is preserved, and the reconcile is not run against a half-written file. |
| b-AC-7 | Given the CLI `nectar brooding off --project <id>`, when it runs against a live daemon, then it produces the same persisted + reconciled effect as the API, and `nectar projects` reflects it. |

## Implementation notes

- Put the loader/writer in a new `src/brooding-state.ts` (or `src/registration/brooding-state.ts`), mirroring `config-file.ts` for the fail-soft + atomic-write patterns.
- The `GET /projects` handler composes: 019a active set + 019a per-project `/health` slice + this store's effective state. Keep it a pure read so the dashboard can poll it cheaply.
- Reuse the existing `autoBroodEnabled` as the boot-time master kill switch; `globalBrooding: "paused"` is the runtime-toggleable equivalent. Do not duplicate the concept - `effectiveBrooding` should AND them.

## Related

- `src/config-file.ts` - the fail-soft loader pattern to mirror.
- `src/daemon.ts:195,597` - the existing `autoBroodEnabled` flag to reconcile with the global switch.
- [`prd-019a-active-project-resolution-and-dormant-daemon`](./prd-019a-active-project-resolution-and-dormant-daemon.md) - the reconcile loop that consumes `effectiveBrooding`.
- [`prd-019c-hive-dashboard-project-activation`](./prd-019c-hive-dashboard-project-activation.md) - the dashboard consumer of these endpoints.
