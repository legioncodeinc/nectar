# Brooding Conclusion and Deliverables

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

The deliverable brooding produces, the explicit non-goals that bound what it does, the cost-predictability summary, and forward pointers to the sibling documents that own steady-state description, identity minting, the projection brooding bootstraps, and the schema for the rows it writes.

**Related:**
- [`brooding-introduction-and-theory.md`](brooding-introduction-and-theory.md)
- [`brooding-technical-specification.md`](brooding-technical-specification.md)
- [`brooding-user-stories.md`](brooding-user-stories.md)
- [`brooding-ecosystem-story-arc.md`](brooding-ecosystem-story-arc.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`../identity-and-reassociation.md`](../identity-and-reassociation.md)
- [`../../data/portable-registry.md`](../../data/portable-registry.md)
- [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md)

---

## The deliverable

The brooding deliverable is a single, one-time-per-project outcome: a full-codebase scan that mints a stable identity for every file and produces a first description for most, then bootstraps the portable projection that makes the result inheritable by every subsequent clone.

Concretely, a completed brood leaves the project in this state:

- **Every discovered file has a nectar.** Binary and oversized files get a nectar with a terminal skip state (`skipped-binary`, `skipped-too-large`); text files get a nectar plus a description where the LLM succeeded. Identity is universal; description is best-effort.
- **Most text files have a description.** Small files were described in batches of 30–50; large files were described solo with a richer prompt. Failed descriptions are marked `failed` and retried by the enricher.
- **Every described file has a 768-dim embedding** over `title + ' ' + description`, unless the selected embedding provider is unavailable (in which case the embedding is NULL and recall falls back to BM25).
- **The initial `.honeycomb/nectars.json` projection exists**, regenerated from Deep Lake at the end of the brood and ready to commit.
- **The daemon has transitioned to live watch**, with the enricher owning steady-state description maintenance.

That state is the deliverable. Everything else in this deep dive — the batching, the resumability, the cost math — exists to make that deliverable affordable, durable, and payable once.

---

## What brooding does not do

The non-goals are restated here because they are a frequent source of confusion, and one of them corrects a common misconception.

- **It does not run on every daemon boot.** Brooding runs once per project — the first time, or on explicit invocation, or when the projection is missing and identity cannot be re-derived. After the first brood, the daemon is in live watch with cold catch-up handling restarts.
- **It does not block daemon readiness.** Per the daemon-readiness rule that governs the rest of Honeycomb, brooding runs in the background after the daemon is accepting requests. Recall queries during a brood see whatever has been described so far; undescribed files are simply absent from semantic results until the brood reaches them.
- **It does describe files the structural CodeGraph already covers — and that is correct.** The two layers are independent. The CodeGraph extracts symbols (structural); Nectar describes files (semantic). Both ship. A source file is present in both `hive_graph_versions` (semantic) and the CodeGraph's `codebase` table (structural). Brooding does not skip files the CodeGraph covers; recall fuses both layers.

---

## Cost predictability

Brooding cost is dominated by LLM input tokens, scales linearly with file count, and holds its batch/solo ratio across repo sizes. The representative figures:

| Repo size | Approximate brood cost |
|---|---|
| 200-file microservice | ~$0.30 |
| 2000-file repository | ~$3.05 |
| 10000-file monorepo | ~$15 |

The 2000-file breakdown (input ~$0.65, output ~$2.40, embeddings $0 via local daemon) and the full per-bucket table are in [`brooding-technical-specification.md`](brooding-technical-specification.md). The cost is a one-time charge per project: a committed projection lets subsequent clones inherit identity without any LLM call, so the team pays once and every clone after that pays nothing.

---

## Where to read next

The brooding deep dive is complete in itself, but brooding is the bootstrap event for a larger system. The forward pointers below are the documents that own what brooding hands off to.

### Steady-state description: the enricher

Brooding describes every file once. The enricher owns everything after: re-describing a file when its content meaningfully changes, describing files minted but skipped during brooding, and describing genuinely new files the watcher detects. The enricher is the steady-state maintenance loop; brooding is the one-time bootstrap.

Read [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md) for the model rationale (why Gemini 2.5 Flash specifically, and the comparison against Haiku, GPT-4.1, and GPT-4o-mini), the debouncing and rate-limiting behavior, the meaningful-change heuristic that avoids re-describing cosmetic edits, and the failure-mode table.

### Identity minting: the nectar

Brooding mints a ULID nectar for every file it discovers. The nectar survives edits, renames, moves, and copy-paste by design, and the re-association ladder re-associates it to a file on disk after offline changes.

Read [`../identity-and-reassociation.md`](../identity-and-reassociation.md) for the minting logic (why ULID, why minted rather than derived), the full five-step re-association ladder (exact path/mtime/size, then path-match-content-changed, then exact-hash-to-missing, then fuzzy TLSH, then mint-new), and the copy-paste-as-provenance-edge model.

### The projection brooding bootstraps

Brooding is the only mode that writes the initial `.honeycomb/nectars.json`. That file is the portable projection that lets a fresh clone inherit identity without re-brooding.

Read [`../../data/portable-registry.md`](../../data/portable-registry.md) for the projection format, what it contains and deliberately omits (no embeddings, no full version chain), the fresh-clone boot path, the generation and regeneration contract, the commit discipline, and the three-rule invariant that keeps the file a projection rather than a sidecar.

### The rows brooding writes

Every nectar mint and every description write during brooding appends rows to `hive_graph` (identity + provenance) and `hive_graph_versions` (content + description chain).

Read [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md) for the full DDL of both tables, the column-by-column rationale, the indexing strategy, the tenancy model (org → workspace → project, cross-agent by nature), and the lazy schema-heal contract.

---

## The deep dive, in one sentence each

- [`brooding-introduction-and-theory.md`](brooding-introduction-and-theory.md) — *Why* brooding is a distinct mode, why long context is load-bearing, and how the projection converts a one-time scan into a zero-cost inheritance.
- [`brooding-technical-specification.md`](brooding-technical-specification.md) — *The contract*: the pipeline diagram, the four bucket criteria, the prompts, the cost-math table, the resumability state machine, the CLI surface.
- [`brooding-user-stories.md`](brooding-user-stories.md) — *The behaviors*: 25 engineering and operator stories with acceptance criteria, scoped to the brooder's implementation surface.
- [`brooding-ecosystem-story-arc.md`](brooding-ecosystem-story-arc.md) — *The composition*: a traced first brood from trigger through handoff, and the inverse arc of a fresh clone that skips brooding via the committed projection.
- [`brooding-conclusion-and-deliverables.md`](brooding-conclusion-and-deliverables.md) — *This document*: the deliverable, the non-goals, the cost summary, and the forward pointers.
