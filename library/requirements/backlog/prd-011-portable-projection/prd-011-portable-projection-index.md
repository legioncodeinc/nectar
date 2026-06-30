# PRD-011: Portable projection (`.honeycomb/nectars.json`) sync

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None (writes/reads a committed projection file, not a Deep Lake table)

---

## Overview

`.honeycomb/nectars.json` is the committed, reviewable, regenerable projection of the Deep Lake `source_graph` table that gives a fresh `git clone` its identity map before the daemon ever runs. Deep Lake is the source of truth but it is not in the repo; the projection carries enough of that state to re-derive identity offline — without network, auth, or LLM calls. It is a **projection, not a sidecar**: written from the source of truth on a defined schedule, never edited directly, and deletable and regenerable without loss (a lockfile, like `package-lock.json`; not an `.env`). This PRD owns the file format, the three generation triggers with the atomic write, the validation-on-load contract and fresh-clone inheritance path, and the `rebuild-projection` CLI that enforces the three projection-not-sidecar rules. **This index covers the module scope.** Sub-feature PRDs cover format+generation+atomic-write, validation+inheritance, and the rebuild CLI + enforcement separately.

---

## Goals

- The projection is generated at the three defined triggers — end of brooding, end of an enricher cycle that wrote new descriptions, and explicit `honeycomb hivenectar rebuild-projection` — never as a read target during normal operation.
- Every generation writes the projection **atomically** (temp file + rename), mirroring the CodeGraph snapshot write, so a crashed regeneration leaves the prior file, not a partial one.
- On load, the daemon validates `version`, the `project` triple, every nectar key as a valid ULID, and every `content_hash` as a valid sha256; a projection that fails any check is ignored with a warning and never partially loaded.
- A fresh clone with a current projection achieves **zero LLM calls and zero fuzzy matches**: every file's content hash matches the projection, every nectar is inherited, and recall is live immediately.
- `honeycomb hivenectar rebuild-projection` and `honeycomb hivenectar project --rebuild-projection` regenerate a byte-identical file (modulo `generated_at`) from a Deep Lake scan alone, enforcing the regenerable-from-source invariant.

## Non-Goals

- Carrying embeddings in the projection. The 768-dim vectors are regenerated locally on boot from `title + description` (`data/portable-registry.md` § What it deliberately omits).
- Carrying the full version chain. Only the latest described version per nectar is included; history stays in Deep Lake.
- Bidirectional sync with Deep Lake. Sync is one-directional Deep Lake → projection; the reverse is a fresh-clone inheritance write only, and only for nectars the local Deep Lake does not already have.
- Replacing Deep Lake cloud sync. Committed projection and cloud sync are complementary, not alternatives.
- Requiring the projection to be committed. The system works with the projection gitignored (every clone broods from scratch); committing it is a recommendation, not a requirement (`data/portable-registry.md` § The `.gitignore` question).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-011a-format-generation-triggers-atomic-write`](./prd-011a-format-generation-triggers-atomic-write.md) | The projection JSON format (carried verbatim), the three generation triggers, and the atomic temp+rename write | Draft |
| [`prd-011b-validation-on-load-fresh-clone-inheritance`](./prd-011b-validation-on-load-fresh-clone-inheritance.md) | version/project/ULID/sha256 validation on load; the fresh-clone zero-LLM inheritance path | Draft |
| [`prd-011c-rebuild-projection-cli-and-invariant`](./prd-011c-rebuild-projection-cli-and-invariant.md) | `rebuild-projection` + `project --rebuild-projection`; the three projection-not-sidecar enforcement rules | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given brooding completes, then a complete `.honeycomb/nectars.json` is written atomically (temp + rename) at the project root. |
| AC-2 | Given an enricher cycle writes one or more new descriptions, then the projection is rewritten atomically with the newly-described versions substituted in. |
| AC-3 | Given the operator runs `honeycomb hivenectar rebuild-projection`, then the file is regenerated from a single `source_graph_versions` scan (latest described version per nectar, scoped to the project) and written atomically. |
| AC-4 | Given the daemon loads a projection whose `version` exceeds its own schema version, then the projection is ignored with a warning and the daemon falls back to full brooding. |
| AC-5 | Given the daemon loads a projection whose `project.org_id`/`workspace_id`/`project_id` does not match the current context, then the projection is ignored with a warning and never partially loaded. |
| AC-6 | Given a fresh clone with a current projection, when the daemon boots, then every file whose content hash matches the projection inherits its nectar and description with zero LLM calls and zero fuzzy matches, and recall is live immediately. |
| AC-7 | Given `honeycomb hivenectar rebuild-projection`, then the output is byte-identical to the source-of-truth projection modulo `generated_at`. |

---

## Data model changes

None. The projection is a committed file under the project root, not a Deep Lake table. It denormalizes the latest described version per nectar from the `source_graph` / `source_graph_versions` tables owned by PRD-005 (`data/source-graph-schema.md`).

---

## API changes

None. The projection is generated and loaded internally. The two CLI commands (`rebuild-projection`, `project --rebuild-projection`) extend the `hivenectar` CLI surface owned by PRD-002c (spec'd CLI surface, `MASTER-PRD-INDEX.md`).

---

## Flagged defaults

- **[DEFAULT — confirm before implementation]** Projection path: `.honeycomb/nectars.json` at the project root (`data/portable-registry.md` § The file format, § The commit discipline).
- **[DEFAULT — confirm before implementation]** Projection write debounce: 30s, carried from the enricher cycle cadence (`data/portable-registry.md` § The commit discipline — "at most once per enricher cycle (default 30 seconds)"). Confirm the debounce window before implementation.

---

## Related

- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — PRD-011 entry; DECISION #3 (`project_id` as soft column filter).
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) — AUTHORITATIVE: the projection format, the three generation triggers, the validation-on-load contract, the fresh-clone path, and the three projection-not-sidecar rules.
- [`../../../knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the `source_graph` / `source_graph_versions` tables the projection denormalizes.
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — brooding, the source of trigger #1.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the enricher cycle, the source of trigger #2 + the 30s debounce.
