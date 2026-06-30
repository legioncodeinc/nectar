# Prior Art — Conclusion and Deliverables

> Category: Reference | Version: 1.0 | Date: June 2026 | Status: Draft

The closing accounting of Hivenectar's relationship to prior art: the narrow defensibility claim restated verbatim, the closest-system gap analysis against Smith, and the closing "what Hivenectar does differently from every surveyed system" reference table. Forward pointers to the decision record and the overview.

**Related:**
- [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md)
- [`prior-art-introduction-and-theory.md`](prior-art-introduction-and-theory.md)
- [`prior-art-technical-specification.md`](prior-art-technical-specification.md)
- [`prior-art-ecosystem-story-arc.md`](prior-art-ecosystem-story-arc.md)
- [`prior-art-user-stories.md`](prior-art-user-stories.md)
- [`../../overview.md`](../../overview.md)
- [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## The deliverable of the prior-art corpus

The prior-art corpus — the [crosswalk](../prior-art-crosswalk.md) and the five deep-dive documents of which this is the last — exists to deliver a single honest accounting: where Hivenectar matches prior art, where it diverges, and where the specific composition is genuinely novel. The accounting has three parts, each documented in a sibling doc and summarized here.

The **matching** is recorded in the [borrow-credit table](prior-art-technical-specification.md): eight predecessors contribute something Hivenectar uses, and every contribution is named explicitly so credit is never implicit. The **divergence** is recorded in the [ecosystem story-arc](prior-art-ecosystem-story-arc.md), which traces each of the five pillars from its predecessor to the Hivenectar choice and names the composition constraint that forces the divergence. The **composition** is recorded in the [five-point novelty checklist](prior-art-technical-specification.md), which marks each point with the prior system that covers it partially.

This conclusion assembles the three parts into the narrow defensibility claim, runs the closest-system gap analysis against Smith, and closes with the "what Hivenectar does differently" table that serves as the standing reference for evaluators. It then points forward to the decision record and the overview for readers who want the implementation rather than the survey.

---

## The narrow defensibility claim, restated verbatim

After surveying the field, the honest claim is not "Hivenectar invented codebase semantic search" — it did not. The honest claim, restated verbatim from [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md), is:

> Hivenectar is the first system to combine daemon-minted file identity, LLM file description, Deep Lake persistence, and union-recall with conversation memory, in a single daemon that already serves a multi-harness AI coding memory system.

That is a narrower and more defensible novelty than "first codebase semantic search." The claim is constructed to be auditable: each of the four conjoined properties (daemon-minted file identity, LLM file description, Deep Lake persistence, union-recall with conversation memory) is checked against the pillar matrix, and no surveyed predecessor satisfies more than two of the five novelty points. The claim is also constructed to be falsifiable in a useful way: a challenger who produces a system satisfying all four properties invalidates the claim, at which point the claim is narrowed further or retired. The [user-stories doc](prior-art-user-stories.md) codifies the evaluator workflow (US-PA-020 through US-PA-025) that keeps the claim current as new tools surface.

The claim deliberately does not assert originality on any single pillar. Stable identity is Aura's and Mimir's. LLM description is Smith's and codeindex's. Delta indexing is Grove's and Cartog's. Semantic search over embeddings is the CodeRAG family's. Deep Lake persistence and union-recall integration are the consequences of Hivenectar being a Honeycomb subsystem. Originality is asserted only on the composition.

---

## Closest-system gap analysis — Smith

Smith is the closest single predecessor, and the gap analysis against Smith is the most useful repeatability exercise in the corpus. Smith covers novelty points 2 (LLM-minted per-file description) and 5 (portable projection as a committed lockfile for team inheritance) partially. The partial coverage and the gaps are itemized below.

**What Smith covers partially.**

- **Lazy description with staleness tracking.** Smith's `Hash:` / `Described-Against-Hash:` divergence flag maps directly to Hivenectar's `describe_status = 'pending'` column. The lazy-enrichment model is Smith's.
- **Committed description cache for team inheritance.** Smith commits `.meta` files so a teammate who clones inherits descriptions. Hivenectar commits `.honeycomb/nectars.json` for the same reason.

**Where Smith leaves the gap that Hivenectar fills.**

| Gap | Smith | Hivenectar |
|---|---|---|
| Stable identity | None — `.meta` files are path-keyed; a file move loses the description | Daemon-minted ULID nectar survives moves, renames, edits, and copy-paste |
| Description storage | `.meta` sidecars embedded alongside source | Deep Lake table; projection is a single regenerable lockfile, not per-file sidecars |
| Source mutation | Mutates `constitution.md` and `CLAUDE.md` | Never mutates source; the AGPL header is untouched |
| Store substrate | Markdown plus sidecar | Deep Lake (Honeycomb substrate; FR-8 compliant) |
| Recall integration | Navigator surface; standalone | `UNION ALL` arm in existing hybrid recall (sessions + memory + memories + source_graph_versions) |
| Watcher | Manual (`/smith-index`) | chokidar watcher in the daemon, continuous |
| Approval economics | Per-batch approval (N=10) | Batched 30–50 with cost-cap flags, no per-batch approval |

Smith covers two of the five novelty points partially and lacks the other three entirely (daemon-minted identity, Deep Lake persistence, union-recall integration). The honest summary is: Hivenectar's description model is Smith's model with the identity, storage, mutation, and recall dimensions rewritten to fit Honeycomb's constraints. The gap analysis is the artifact that prevents the description pillar from being overclaimed as original.

This same gap-analysis procedure generalizes to any newly-surfaced description-producing tool: classify the tool against the five novelty points and the divergence-table dimensions, then write a one-paragraph closest-system comparison. The procedure is codified as US-PA-021 in the [user-stories doc](prior-art-user-stories.md).

---

## What Hivenectar does differently from every surveyed system

The table below is the closing reference, restated verbatim from [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md). It compares prior-art consensus against Hivenectar's choice across the nine dimensions that distinguish the composition. An evaluator comparing Hivenectar to any new tool should classify the new tool on each of these nine dimensions and update the table if the new tool changes the consensus on any row.

| Dimension | Prior-art consensus | Hivenectar |
|---|---|---|
| Identity derivation | Content-derived (hash) or name-derived | Daemon-minted ULID, never derived |
| Identity granularity | Symbol (Aura, Mimir) or file (Orbit, synrepo) | File in v1, symbol in v2 possibility |
| Description granularity | Per-symbol AST chunk (CodeRAG family) or per-file (Smith, codeindex) | Per-file, deliberately coarser than AST-chunk tools |
| Description producer | Per-chunk embedding model (CodeRAG family) or LLM (Smith) | LLM (Gemini 2.5 Flash) for title+description, separate embedding model for the vector |
| Store | SQLite (Grove, Orbit sidecar), LanceDB (CodeRAG family), FAISS (Cortex), on-disk objects (synrepo) | Deep Lake (Honeycomb substrate) |
| Source mutation | Smith mutates `CLAUDE.md`; others do not | Never mutates source; projection is a separate committed file |
| Recall integration | Standalone semantic search server | UNION ALL arm in existing hybrid recall (sessions + memory + memories + source_graph_versions) |
| Team share | Smith commits `.meta`; others re-index per clone | Committed `nectars.json` projection + Deep Lake cloud sync |
| Watcher | Cartog, Cortex, Context+ have watchers; others are manual | chokidar watcher in the daemon, same as CodeGraph build triggers |

The standing instruction for any doc, RFC, or external communication that touches Hivenectar's originality is: cite this table, cite the [borrow-credit table](prior-art-technical-specification.md), and make the narrow claim. Never make the broad claim.

---

## Forward pointers

Readers who have finished the prior-art corpus and want the implementation rather than the survey should proceed in two directions.

**For the identity decision and its rejected alternatives**, read [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md). The ADR records the four candidate identity models (source-embedded serial, content hash, daemon-minted ULID, SQLite sidecar), the decision drivers, the rejection reasons, and the acknowledged costs of the chosen option. It is the authoritative source for "why minted ULID and not the alternatives" and should be read before any re-litigation of the identity model.

**For the system-level picture**, read [`../../overview.md`](../../overview.md). The overview covers the three design pillars (stable identity, lazy LLM description, Deep Lake persistence with a portable projection), the hiveantennae worker's four operating modes, the two-table data model in summary, and how recall uses the source-graph tables. It is the entry point for the rest of the Hivenectar knowledge base and carries the reading guide that routes implementers to the brooding pipeline, the enricher, the re-association ladder, the schema, and the recall integration.

The prior-art corpus is complete at five documents. The [introduction and theory](prior-art-introduction-and-theory.md) establishes the thesis; the [technical specification](prior-art-technical-specification.md) provides the verbatim matrices; the [user stories](prior-art-user-stories.md) codify the engineering and operator workflows; the [ecosystem story-arc](prior-art-ecosystem-story-arc.md) traces the design choices; this conclusion delivers the accounting and the forward pointers. Together they are the artifact that defends Hivenectar against both reinventing wheels and overclaiming novelty.
