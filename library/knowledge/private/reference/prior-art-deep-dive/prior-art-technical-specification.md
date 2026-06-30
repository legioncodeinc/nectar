# Prior Art — Technical Specification

> Category: Reference | Version: 1.0 | Date: June 2026 | Status: Draft

The verbatim comparison matrices that ground every prior-art claim about Hivenectar: the five-pillar matrix, the borrow-credit table, the divergence table, the five-point novelty composition as a checklist, and the cited source list.

**Related:**
- [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md)
- [`prior-art-introduction-and-theory.md`](prior-art-introduction-and-theory.md)
- [`prior-art-user-stories.md`](prior-art-user-stories.md)
- [`prior-art-ecosystem-story-arc.md`](prior-art-ecosystem-story-arc.md)
- [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md)
- [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## How to use this doc

This document is the verbatim reference. The narrative framing lives in [`prior-art-introduction-and-theory.md`](prior-art-introduction-and-theory.md); the pillar-by-pillar design-choice trace lives in [`prior-art-ecosystem-story-arc.md`](prior-art-ecosystem-story-arc.md); the closing accounting and gap analysis live in [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md). When a reviewer or evaluator challenges a prior-art claim, this is the doc to cite, because every cell in every table below is sourced verbatim from [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md) (itself researched via Exa in June 2026).

The five pillars used throughout are: **stable identity**, **LLM description**, **semantic store**, **watcher-driven** maintenance, and **daemon-minted** identity allocation. These are the five columns against which Hivenectar and its twelve surveyed predecessors are compared.

---

## The pillar matrix

The matrix maps Hivenectar and twelve prior systems across the five pillars. The reading rule: Hivenectar's pillars are each individually present in some prior system, but no single prior system combines all five. The closest single predecessor is Smith (covers the LLM description and the committed-cache intent partially, lacks minted identity, Deep Lake storage, and recall integration) and CodeRAG (covers LLM description and a watcher, lacks stable identity, uses LanceDB storage, no per-file description granularity).

| System | Stable identity | LLM description | Semantic store | Watcher-driven | Daemon-minted |
|---|---|---|---|---|---|
| **Hivenectar** | ULID nectar | per-file title+desc+concepts | Deep Lake | `node:fs.watch` + debounce | yes (Deep Lake row) |
| Aura | identity anchor + content hash | no (structural only) | shadow branch | git-hooked | no (content-derived) |
| Orbit | id + identity_key + object_hash | no (structural only) | SQLite sidecar + objects | rebuild-triggered | partially (location-derived) |
| Cartog | content_hash + subtree_hash (Merkle) | no (structural only) | on-disk graph | watcher (`--debounce`) | no (content-derived) |
| Grove | `{filePath}::{qualifiedName}@{contentSHA}` | no (structural only) | SQLite (`.grove/grove.db`) | delta-by-content-hash | no (content-derived) |
| Mimir | `SymbolId` (Roslyn-style) | no (structural only) | snapshot + WAL | bind-triggered | yes (librarian-allocated) |
| Smith | stable method id (sha256-derived) | per-file description (`.meta`) | markdown + sidecar | manual (`/smith-index`) | no (content-derived) |
| synrepo | blake3 `file_...` NodeId | no (concept nodes are human-authored) | `.synrepo/` index | compile-triggered | no (root-discriminated) |
| CodeRAG | none (LanceDB row id) | per-chunk NL enrichment | LanceDB | incremental reindex | no |
| Codebase Cortex | none (FAISS row id) | per-chunk embedding | FAISS + `.cortex/` | watcher | no |
| Context+ | none | per-symbol embedding | `.mcp_data/` cache | realtime tracker | no |
| NeuralMind | none | per-node learned weights | synapse graph | learned | no |

---

## The borrow-credit table

Hivenectar is a synthesis. The table below states verbatim what Hivenectar uses from each predecessor, so that credit is explicit and the "what we borrow" claims in any doc or PR are auditable against this single reference. Presenting any single pillar as original is dishonest; the originality is in the composition and in the integration with Honeycomb's existing memory substrate.

| Borrowed from | What Hivenectar uses |
|---|---|
| **Aura** | Identity anchor vs. content hash split; the two-table identity+version model; the "neither alone is enough" framing |
| **Mimir** | Minted identity as a first-class operation; append-only identity history; explicit non-reuse of IDs |
| **Smith** | Lazy description with staleness tracking; committed description cache for team inheritance; batch-with-approval economics |
| **Grove / Cartog** | Delta indexing by content hash; `(path, mtime, size)` fast-path; watcher debounce patterns |
| **Orbit** | Separation of stable identity from content hash from object hash |
| **codeindex** | Two-phase structural-then-AI pipeline; local-LLM privacy property |
| **Context+** | Obsidian-style concept-tag interlinking |
| **Honeycomb CodeGraph** | Discovery (`git ls-files`), atomic write patterns, content-addressed caching, daemon-as-only-storage-client |

---

## The divergence table

The table below is the closing reference matrix from the crosswalk, restated verbatim. It compares prior-art consensus against Hivenectar's choice across nine dimensions: identity derivation, identity granularity, description granularity, description producer, store, source mutation, recall integration, team share, and watcher. This is the table to point an evaluator at when the question is "what does Hivenectar do differently from every surveyed system."

| Dimension | Prior-art consensus | Hivenectar |
|---|---|---|
| Identity derivation | Content-derived (hash) or name-derived | Daemon-minted ULID, never derived |
| Identity granularity | Symbol (Aura, Mimir) or file (Orbit, synrepo) | File in v1, symbol in v2 possibility |
| Description granularity | Per-symbol AST chunk (CodeRAG family) or per-file (Smith, codeindex) | Per-file, deliberately coarser than AST-chunk tools |
| Description producer | Per-chunk embedding model (CodeRAG family) or LLM (Smith) | LLM (Gemini 2.5 Flash) for title+description, separate embedding model for the vector |
| Store | SQLite (Grove, Orbit sidecar), LanceDB (CodeRAG family), FAISS (Cortex), on-disk objects (synrepo) | Deep Lake (Honeycomb substrate) |
| Source mutation | Smith mutates `CLAUDE.md`; others do not | Never mutates source; projection is a separate committed file |
| Recall integration | Standalone semantic search server | Guarded arm in existing hybrid recall (sessions + memory + memories + source_graph_versions) |
| Team share | Smith commits `.meta`; others re-index per clone | Committed `nectars.json` projection + Deep Lake cloud sync |
| Watcher | Cartog, Cortex, Context+ have watchers; others are manual | `node:fs.watch` + debounce, mirroring Honeycomb's file-watcher pattern |

---

## The five-point novelty composition as a checklist

After surveying the field, the specific composition that no prior system delivers decomposes into five points. The checklist below restates each point and names the prior system that covers it partially, so that the novelty claim is auditable point by point rather than asserted wholesale. Each pillar alone has precedent; the five-way composition does not.

- [ ] **1. Daemon-minted identity** (not content-derived, not source-embedded, not path-keyed). Partially present in Mimir at symbol granularity and in Aura at function granularity. **Not present at file granularity with a pure minted ULID** in any surveyed system.
- [ ] **2. LLM-minted per-file description** (not per-symbol AST chunk). Partially present in Smith and codeindex. **Neither has stable identity, and neither persists to a shared multi-tenant store.**
- [ ] **3. Deep Lake as the durable store** (not SQLite, not LanceDB, not FAISS, not a sidecar). **Unique to Hivenectar** among surveyed tools; no prior art uses Deep Lake because Deep Lake is the shared substrate Hivenectar composes with Honeycomb over (per ADR-0002, Hivenectar is an independent daemon, not a Honeycomb subsystem, but it shares Honeycomb's Deep Lake datasets at the data layer).
- [ ] **4. Integration into an existing hybrid recall pipeline** that already serves session, memory, and skill recall. **No prior system** composes code-file recall with conversation-trace recall and distilled-fact recall in a single fused query.
- [ ] **5. Portable projection as a committed lockfile** for fresh-clone identity inheritance. Smith commits descriptions, but in source-mutating `.meta` sidecars; **Hivenectar commits a regenerable projection that never touches source.**

The closest single predecessor is Smith, which covers points 2 and 5 partially but lacks points 1, 3, and 4 entirely. No surveyed system covers more than two of the five points, and no surveyed system covers the Deep Lake store (point 3) or the hybrid-recall integration (point 4) at all.

---

## Sources

Researched via Exa web search, June 2026. All URLs are the source-of-record pages cited in [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md).

- Aura — Function-Level Identity: https://docs.auravcs.com/function-level-identity/
- Aura — Content-Addressed Logic: https://docs.auravcs.com/content-addressed-logic/
- Orbit — Knowledge Graph Overview: https://orbit-cli.com/architecture/design/knowledge-graph/1_overview/
- Cartog — Incremental indexing with a Merkle tree: https://www.julienrollin.com/en/posts/cartog-incremental-merkle-tree/
- Mimir — Symbol Identity Semantics: https://github.com/buildepshit/Mimir/blob/main/docs/concepts/symbol-identity-semantics.md
- Grove — README: https://github.com/provasign/grove/blob/main/README.md
- Smith — Manifest System: https://github.com/attckdigital/smith/blob/main/docs/manifest-system.md
- synrepo — ARCHITECTURE.md: https://github.com/whit3rabbit/synrepo/blob/main/docs/ARCHITECTURE.md
- knowing — Content-Addressing as Computation Primitive: https://github.com/blackwell-systems/knowing/blob/main/docs/research/content-addressing-as-computation-primitive.md
- Probe — Indexing Overview: https://github.com/probelabs/probe/blob/main/docs/indexing-overview.md
- CodeRAG: https://github.com/maciek-O-digiaidev/CodeRAG
- Codebase Cortex: https://github.com/sarupurisailalith/codebase-cortex
- Context+: https://github.com/knzcx/contextplus
- NeuralMind: https://dfrostar.github.io/neuralmind/
- codeindex: https://github.com/dreamlx/codeindex
- codebase-index: https://github.com/LevelPanic/codebase-index
- cba: https://github.com/davidgeorgehope/cba
- opencode-codebase-index: https://github.com/ekakit/opencode-codebase-index
- code-atlas: https://github.com/SerPeter/code-atlas
- codebase-indexer: https://github.com/faktenforum/codebase-indexer
