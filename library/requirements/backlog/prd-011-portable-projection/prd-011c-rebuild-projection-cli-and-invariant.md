# PRD-011c: `rebuild-projection` CLI and the projection-not-sidecar invariant

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S (1-3h)
> **Schema changes:** None

---

## Overview

`honeycomb hivenectar rebuild-projection` is trigger #3 — the operator-initiated full regeneration of `.honeycomb/nectars.json` from Deep Lake alone, used when the projection is corrupt, lost, or suspected stale. It is also the rule that proves the projection is a projection and not a sidecar: if a single scan of `source_graph_versions` reproduces the file byte-identically (modulo `generated_at`), the file carries no state Deep Lake lacks. This sub-PRD owns the two CLI commands (`rebuild-projection` and the project-scoped `project --rebuild-projection`) and the three enforcement rules that keep the file on the right side of FR-8's sidecar prohibition.

---

## Goals

- `honeycomb hivenectar rebuild-projection` regenerates the full projection from a single scan of `source_graph_versions` (latest described version per nectar, scoped to the project), denormalized into the projection format and written atomically.
- `honeycomb hivenectar project --rebuild-projection` provides the project-scoped variant of the same regeneration.
- The three projection-not-sidecar enforcement rules hold: (1) Deep Lake writes happen first; (2) the projection is never edited by hand or by external tools; (3) the projection is regenerable byte-identical (modulo `generated_at`) from Deep Lake alone.
- The rebuild produces output byte-identical to the source-of-truth projection modulo `generated_at` — the property that makes it a regenerable lockfile.

## Non-Goals

- The file format and atomic write mechanics (PRD-011a).
- The validation-on-load gate and fresh-clone path (PRD-011b).
- Selective or partial rebuild. `rebuild-projection` is a full regeneration from the `source_graph_versions` scan; there is no "rebuild only this file" flag.
- Forcing the projection to be committed. The `.gitignore` choice is a team policy decision (`data/portable-registry.md` § The `.gitignore` question).

---

## The CLI surface

From the spec'd CLI surface (`MASTER-PRD-INDEX.md`), PRD-011 owns two commands:

| Command | Purpose |
|---|---|
| `honeycomb hivenectar rebuild-projection` | Explicit full regeneration of `.honeycomb/nectars.json` from Deep Lake. Used when the projection is corrupt, lost, or suspected stale. |
| `honeycomb hivenectar project --rebuild-projection` | The project-scoped variant of the same regeneration. |

Both are trigger #3 (`data/portable-registry.md` § Generation and regeneration): "A full regeneration from Deep Lake, used when the projection is corrupt, lost, or suspected stale." They share the single regeneration routine — a single scan of `source_graph_versions` (latest described version per nectar, scoped to the project's `org_id`/`workspace_id`/`project_id`), denormalized into the projection format, and written atomically via the temp+rename pattern of PRD-011a.

---

## The three projection-not-sidecar enforcement rules

From `data/portable-registry.md` § How it differs from a sidecar (the rule), the line between "projection" and "sidecar" is enforcement, not format. The same JSON file is a projection if the system treats it as regenerable, and a sidecar if the system reads from it as a source of truth. Hivenectar enforces the projection invariant through three rules, carried verbatim:

1. **Deep Lake writes happen first.** Every nectar mint, version append, and description write goes to Deep Lake before the projection is regenerated. The projection is never the target of a write; it is always derived.
2. **The projection is never edited by hand or by external tools.** A hand-edit to `.honeycomb/nectars.json` is overwritten on the next regeneration. The file is read-only from the system's perspective except for the regeneration write.
3. **The projection is regenerable from Deep Lake alone.** `honeycomb hivenectar rebuild-projection` produces a byte-identical file (modulo `generated_at`) from a Deep Lake scan, with no other inputs. If it did not, the projection would be carrying state Deep Lake does not have, which would make it a sidecar.

These rules are what keep `.honeycomb/nectars.json` on the right side of FR-8. The file exists for portability and reviewability; it does not exist because Deep Lake is insufficient.

### How the CLI enforces rule #3

Rule #3 is the one with a mechanical enforcement: `rebuild-projection` is a pure Deep Lake scan with no other inputs, and it must produce byte-identical output (modulo `generated_at`) to the source-of-truth projection. The canonical-JSON serialization (PRD-011a) makes this testable — two regenerations of the same Deep Lake state produce identical bytes except in the `generated_at` field. If a rebuild ever diverged, that divergence would be evidence the projection is carrying sidecar state and the invariant is broken.

### The regenerable-from-source principle

This mirrors the principle the CodeGraph storage layer already documents (`honeycomb/src/daemon/storage/heal.ts`, per `MASTER-PRD-INDEX.md` PRD-011 "Conforms to"): a regenerable artifact points at the source of truth and can be deleted and rebuilt without loss. The projection is a lockfile; `rebuild-projection` is the `package-lock`-regeneration equivalent.

---

## User stories

### US-011c.1 — Rebuild a corrupt or lost projection

**As a** operator, **I want to** run `honeycomb hivenectar rebuild-projection`, **so that** I recover a correct `.honeycomb/nectars.json` when the committed one is corrupt, lost, or suspected stale.

**Acceptance criteria:**
- AC-011c.1.1 Given `honeycomb hivenectar rebuild-projection`, when it runs, then it scans `source_graph_versions` for the latest described version per nectar scoped to the project.
- AC-011c.1.2 Given the scan completes, then the projection is written atomically (temp + rename) over the existing `.honeycomb/nectars.json`.

### US-011c.2 — Rebuild scoped to a project

**As a** operator, **I want to** the project-scoped variant, **so that** I regenerate the projection for the project I am working in.

**Acceptance criteria:**
- AC-011c.2.1 Given `honeycomb hivenectar project --rebuild-projection`, then the regeneration runs scoped to the current project's `org_id`/`workspace_id`/`project_id`.

### US-011c.3 — Prove the projection is regenerable (rule #3)

**As a** reviewer, **I want to** `rebuild-projection` to reproduce the file byte-identically modulo `generated_at`, **so that** I can verify the projection carries no sidecar state.

**Acceptance criteria:**
- AC-011c.3.1 Given the same Deep Lake state, when `rebuild-projection` runs twice, then the two outputs are byte-identical except for the `generated_at` field.
- AC-011c.3.2 Given a rebuild that diverges from the source-of-truth projection beyond `generated_at`, then that divergence is treated as an invariant violation (the projection would be carrying sidecar state).

### US-011c.4 — Overwrite hand-edits (rule #2)

**As a** teammate, **I want to** a hand-edit to the projection to be overwritten on the next regeneration, **so that** the file cannot silently drift into a second source of truth.

**Acceptance criteria:**
- AC-011c.4.1 Given a hand-edit to `.honeycomb/nectars.json`, when the next generation trigger (brood end, enricher-cycle end, or `rebuild-projection`) fires, then the hand-edit is overwritten by the regenerated content.

---

## Implementation notes

- **Single regeneration routine, three callers.** Triggers #1 (brood end), #2 (enricher-cycle end), and #3 (`rebuild-projection`) all call the same `regenerateProjection(org, workspace, project)` → `writeProjectionAtomic(...)` pair. Trigger #3 is the only operator-initiated one; the routine is identical.
- **Scan is `source_graph_versions` latest-per-nectar.** The regeneration query selects the latest described version per nectar scoped to the project (mirrors the enricher's pending-work "latest pending version per nectar" shape from PRD-016a, but over `describe_status = 'described'`). The `derived` map is built from `source_graph.derived_from_nectar`/`fork_content_hash` (`data/source-graph-schema.md` § the `source_graph` table).
- **CLI flag surface is minimal.** `rebuild-projection` and `project --rebuild-projection` take no `--force`/`--limit`/`--dry-run` — those are `brood`-only flags (a known corpus hallucination applied them to the wrong command; `prd-010b` flags the same guard). Rebuild is unconditional and full.
- **Byte-identical depends on canonical JSON + stable scan order.** The serialization canonicalizes key order (PRD-011a) AND the scan must iterate nectars in a stable order (e.g., sorted by nectar) so two runs over the same state produce identical bytes. `generated_at` is the only intentional variance.
- **Rule #1 is enforced at the write seam, not the CLI.** "Deep Lake writes first" is a property of the mint/version/description write paths (PRD-005, PRD-006, PRD-016), not of `rebuild-projection`. The CLI depends on it; it does not re-check it.

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Projection path: `.honeycomb/nectars.json` at the project root (`data/portable-registry.md` § The file format).
- **[DEFAULT — confirm before implementation]** Projection write debounce: 30s, carried from the enricher cycle cadence (`data/portable-registry.md` § The commit discipline). Confirm the window before implementation. (Debounce applies to triggers #1/#2; `rebuild-projection` writes immediately on invocation.)

---

## Related

- [`./prd-011-portable-projection-index.md`](./prd-011-portable-projection-index.md)
- [`./prd-011a-format-generation-triggers-atomic-write.md`](./prd-011a-format-generation-triggers-atomic-write.md) — the atomic write + format this rebuilds.
- [`./prd-011b-validation-on-load-fresh-clone-inheritance.md`](./prd-011b-validation-on-load-fresh-clone-inheritance.md) — validation that consumes the rebuild's output.
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) — AUTHORITATIVE: the three enforcement rules (verbatim) + the regeneration triggers.
- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — the spec'd CLI surface (`rebuild-projection`, `project --rebuild-projection`) and DECISION #3 (`project_id` soft filter).
- `honeycomb/src/daemon/storage/heal.ts` — the regenerable-from-source principle the projection mirrors (MASTER-PRD-INDEX.md "Conforms to").
- [`../../backlog/prd-002-hivenectar-daemon/`](../../backlog/prd-002-hivenectar-daemon/) — PRD-002c owns the `hivenectar` CLI surface these commands extend.
