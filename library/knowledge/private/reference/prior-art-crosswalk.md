# Prior Art Crosswalk

> Category: Reference | Version: 1.0 | Date: June 2026 | Status: Draft

A survey of existing systems that overlap with Hivenectar's design space — persistent file identity, LLM-minted code description, semantic codebase search — and an honest accounting of where Hivenectar matches prior art, where it diverges, and where the specific three-way composition is genuinely novel. Researched via Exa in June 2026.

**Related:**
- [`../overview.md`](../overview.md)
- [`../ai/identity-and-reassociation.md`](../ai/identity-and-reassociation.md)
- [`../data/source-graph-schema.md`](../data/source-graph-schema.md)
- [`../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## How to read this doc

Hivenectar is not the first system to give files stable identity, nor the first to describe code with an LLM, nor the first to index a codebase semantically. Each of those three pillars has well-trodden prior art. What is genuinely novel about Hivenectar is the **specific composition**: minted identity (not content-derived, not source-embedded) + LLM-minted per-file description (not AST chunking) + Deep Lake as the durable store (not SQLite, not LanceDB, not a sidecar) + integration into an existing hybrid recall pipeline that already serves session and skill memory.

This doc maps each prior system to the pillars it covers, notes what Hivenectar borrows (credit where due), and identifies the gap each system leaves that Hivenectar fills. The goal is to avoid both reinventing wheels and overclaiming novelty.

---

## The pillar matrix

| System | Stable identity | LLM description | Semantic store | Watcher-driven | Daemon-minted |
|---|---|---|---|---|---|
| **Hivenectar** | ULID nectar | per-file title+desc+concepts | Deep Lake | chokidar | yes (Deep Lake row) |
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

Read the matrix as: Hivenectar's pillars are each individually present in some prior system, but **no single prior system combines all five**. The closest are Smith (LLM description + committed cache, but no minted identity, no watcher, sidecar storage) and CodeRAG (LLM description + watcher, but no stable identity, LanceDB storage, no per-file description granularity).

---

## Identity systems (the "stable identity" pillar)

### Aura — identity anchor + content hash

Aura (https://docs.auravcs.com/function-level-identity/, Naridon Inc.) is the clearest intellectual predecessor to Hivenectar's identity model. Aura separates a function's **identity anchor** (a persistent "this is the same function" thread) from its **content hash** (what the body currently is). The identity anchor survives renames, moves, and edits; the content hash changes per edit and is linked to the anchor as a version.

> "Aura combines body hash (for rename-proofing and dedup) with a persistent identity anchor (for history continuity across edits). Neither alone is enough." — Aura docs

This is exactly Hivenectar's nectar + content_hash split, lifted from function granularity to file granularity. Hivenectar borrows the two-table model (identity vs. version chain) directly from Aura's design. Where Hivenectar diverges:

- **Aura is function-granular; Hivenectar is file-granular in v1.** Aura's identity anchor is per-function; Hivenectar's nectar is per-file. Symbol-level nectars are a Hivenectar v2 possibility.
- **Aura's anchor is content-derived at minting; Hivenectar's nectar is a pure minted ULID.** Aura derives the initial anchor from the function's structural signature; Hivenectar mints a random ULID. The difference matters for cross-instance dedup (two independent Aura instances mint the same anchor for the same function; two Hivenectar instances mint different ULIDs and rely on Deep Lake tenancy to scope them). Hivenectar's choice trades global dedup for simplicity and collision-freedom.
- **Aura is a VCS (shadow branch, rewind, proof); Hivenectar is a memory layer.** Aura's identity model serves behavior-proof and function-level rewind. Hivenectar's serves semantic recall. Same identity pattern, different application.

### Orbit — three-key identity

Orbit (https://orbit-cli.com/architecture/design/knowledge-graph/1_overview/) uses three independent keys per node:

| Key | Role | Stability |
|---|---|---|
| `id` | Primary reference within a snapshot | Stable across rebuilds of the same repo state |
| `identity_key` | Cross-build lineage (rename tracking) | Stable across rebuilds |
| `object_hash` | Content hash of the serialized node | Changes whenever any field changes |

Hivenectar's `(nectar, content_hash)` pair maps to Orbit's `(identity_key, object_hash)`. The lesson Hivenectar takes from Orbit is the value of separating "who is this" from "what is this right now" — a lesson reinforced across nearly every identity system surveyed.

Where Hivenectar diverges: Orbit stores its graph in `graph_index.sqlite` (a mutable secondary index sidecar) plus content-addressed objects. Hivenectar stores everything in Deep Lake, no sidecar. This is a Deep Lake constraint (FR-8) and a Honeycomb convention, not a philosophical objection to SQLite.

### Mimir — Roslyn-style SymbolId

Mimir (https://github.com/buildepshit/Mimir) implements a Roslyn-inspired symbol identity model where every entity has a stable `SymbolId` that is explicit, not heuristic. Renames produce alias edges rather than rewriting identity; the symbol table is append-only per a set of architectural boundaries.

> "Identity is explicit, not heuristic. Mimir refuses both [name-based and hash-based identity]." — Mimir concept doc

Hivenectar's nectar is in the same spirit: explicit, immutable once allocated, never reused. The lesson taken from Mimir is that identity allocation should be a first-class operation (the daemon "mints"), not a derivation. Where Hivenectar diverges: Mimir is symbol-granular and compiler-coupled (Roslyn-style); Hivenectar is file-granular and LLM-coupled.

### Grove, Cartog, synrepo — content-hash-derived identity

Grove (`{filePath}::{qualifiedName}@{contentSHA}`), Cartog (Merkle tree of content hashes), and synrepo (blake3 `file_...` NodeId) all derive identity from content. They cover the "delta indexing by content hash" pattern thoroughly: hash the file, skip unchanged files, detect renames by following the hash.

Hivenectar uses content hash as the *secondary* attribute (the version key) but explicitly rejects it as the identity key, because content hash changes per edit and therefore cannot provide stable identity across edits without a separate anchor. This is the same insight Aura documents and that Hivenectar's `ADR-0001` records as the rejected alternative.

The delta-indexing pattern (skip unchanged files) is something Hivenectar reuses: the `(path, mtime, size)` fast-path in re-association step 1 is Grove/Cartog's delta indexing applied to the re-association ladder.

---

## Description systems (the "LLM description" pillar)

### Smith — Hash vs Described-Against-Hash

Smith (https://github.com/attckdigital/smith) is the closest prior art for Hivenectar's description model. Smith maintains per-file `.meta` files with a `Hash:` (recomputed on every save) and a `Described-Against-Hash:` (updated only by description-generating paths). When `Hash != Described-Against-Hash`, the navigator surfaces staleness and `--describe` re-describes only the stale files.

> "Committing that layer means a teammate who clones the repo inherits the descriptions instead of re-paying the describe cost." — Smith manifest docs

This is precisely Hivenectar's lazy enrichment model. Hivenectar's `describe_status = 'pending'` column is Smith's `Hash != Described-Against-Hash` flag; Hivenectar's portable projection is Smith's committed `.meta` layer. The lessons Hivenectar takes from Smith:

1. **Commit the descriptions.** The team-share story depends on it.
2. **Incremental re-description.** Only stale files pay the LLM cost.
3. **Operator-approval batching.** Smith batches N=10 files per LLM call with per-batch approval; Hivenectar batches 30–50 with cost-cap flags but no per-batch approval (the cost is low enough to not warrant friction).

Where Hivenectar diverges:

- **Smith has no stable identity.** Its `.meta` files are keyed by path; a file move loses the description. Hivenectar's nectar survives moves.
- **Smith embeds descriptions in `.meta` sidecars.** Hivenectar stores descriptions in Deep Lake and projects to a single `nectars.json` lockfile, enforcing the projection-not-sidecar invariant.
- **Smith is source-mutating.** It writes description layers into `constitution.md` and `CLAUDE.md`. Hivenectar never mutates source.

### CodeRAG, Codebase Cortex, Context+, cba — AST-chunk enrichment

A large family of tools (CodeRAG, Codebase Cortex, Context+, cba, codebase-index, codebase-indexer, code-atlas, opencode-codebase-index) parse code with tree-sitter into AST chunks (functions, classes, methods), embed each chunk, and expose semantic search. This is the dominant pattern in 2026 MCP-server code-search tools.

Hivenectar diverges from this entire family on granularity:

- **AST-chunk tools describe symbols.** Hivenectar describes files.
- **AST-chunk tools produce many embeddings per file** (one per function). Hivenectar produces one embedding per file (over title+description).
- **AST-chunk tools couple semantic search to AST extraction.** Hivenectar decouples them — the structural CodeGraph (already shipped in Honeycomb) does AST extraction; Hivenectar does semantic description.

The tradeoff is deliberate. AST-chunk granularity gives finer recall (a specific function within a file) at the cost of high row counts (10–100× more embeddings) and coupling to tree-sitter's parse quality. File granularity gives coarser recall but works on any text file (config, markdown, `.env`), has 10–100× lower row counts, and composes with the existing CodeGraph rather than duplicating it.

Hivenectar's bet is that file-level "what is this file for" recall is the 80%-useful case, and symbol-level recall is already handled by the structural CodeGraph's `find/` and `query/` surfaces. A future Hivenectar v2 could add symbol-level descriptions if file-level proves insufficient, but the v1 design is deliberately file-granular.

### Context+ — Obsidian-style linking

Context+ (https://github.com/knzcx/contextplus) explicitly markets "Obsidian-style linking" via wikilink hub graphs that map features to code files. Hivenectar's `concepts` column and the planned Obsidian-style interlink view are in the same spirit. Context+ uses spectral clustering to group semantically-related files; Hivenectar relies on hybrid recall + concept-tag intersection for the same effect.

### NeuralMind — learned synapse graph

NeuralMind (https://dfrostar.github.io/neuralmind/) learns Hebbian associations between co-active code nodes and persists them as a synapse graph that agents inherit. This is the "team memory" pattern — committing a learned signal so teammates inherit intuition.

Hivenectar does not learn co-activation; it produces explicit LLM-minted descriptions and relies on the hybrid recall pipeline's RRF fusion to surface related files. NeuralMind's learned-graph approach is interesting but adds a degree of opacity (the synapse weights are not human-reviewable); Hivenectar's descriptions are reviewable in the projection, which fits the "memory must be inspectable" principle from the main Honeycomb overview.

### codeindex — two-phase AI enrichment

codeindex (https://github.com/dreamlx/codeindex) uses a two-phase pipeline: structural README generation via tree-sitter, then optional AI one-line module descriptions. The two-phase pattern (structural first, AI enrichment second, AI opt-in) is the same shape as Honeycomb's CodeGraph + Hivenectar split. codeindex's "AI descriptions use your local agent CLI, so no code leaves your network" principle is the same privacy property Hivenectar gets from routing through the local daemon + Portkey gateway.

---

## What is genuinely novel about Hivenectar

After surveying the field, the specific composition that no prior system delivers is:

1. **Daemon-minted identity** (not content-derived, not source-embedded, not path-keyed) — present in Mimir at symbol granularity, in Aura at function granularity, but not at file granularity with a pure minted ULID.
2. **LLM-minted per-file description** (not per-symbol AST chunk) — present in Smith and codeindex, but neither has stable identity, and neither persists to a shared multi-tenant store.
3. **Deep Lake as the durable store** (not SQLite, not LanceDB, not FAISS, not a sidecar) — unique to Hivenectar because it is a Honeycomb subsystem; no prior art uses Deep Lake because Deep Lake is Honeycomb's substrate.
4. **Integration into an existing hybrid recall pipeline** that already serves session, memory, and skill recall — no prior system composes code-file recall with conversation-trace recall and distilled-fact recall in a single fused query.
5. **Portable projection as a committed lockfile** for fresh-clone identity inheritance — Smith commits descriptions, but in source-mutating `.meta` sidecars; Hivenectar commits a regenerable projection that never touches source.

Each pillar alone has precedent. The five-way composition does not. The closest single system is Smith, which covers pillars 2 and 5 partially but lacks pillars 1, 3, and 4 entirely.

The honest claim is not "Hivenectar invented codebase semantic search" — it did not. The honest claim is "Hivenectar is the first system to combine daemon-minted file identity, LLM file description, Deep Lake persistence, and union-recall with conversation memory, in a single daemon that already serves a multi-harness AI coding memory system." That is a narrower and more defensible novelty than "first codebase semantic search."

---

## What Hivenectar borrows (credit)

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

Hivenectar is a synthesis. It would be dishonest to present any single pillar as original. The originality is in the composition, and in the integration with Honeycomb's existing memory substrate.

---

## What Hivenectar does differently from every surveyed system

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

---

## Sources

Researched via Exa web search, June 2026.

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
