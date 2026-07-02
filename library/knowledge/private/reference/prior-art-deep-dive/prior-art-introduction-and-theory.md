# Prior Art — Introduction and Theory of Honest Novelty

> Category: Reference | Version: 1.0 | Date: June 2026 | Status: Draft

A conceptual essay for contributors and evaluators on how Nectar thinks about its own originality: why the project refuses to claim it invented any single capability, and why the defensible claim is about composition rather than invention.

**Related:**
- [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md)
- [`prior-art-technical-specification.md`](prior-art-technical-specification.md)
- [`prior-art-ecosystem-story-arc.md`](prior-art-ecosystem-story-arc.md)
- [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md)
- [`../../overview.md`](../../overview.md)
- [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## Why this essay exists

Nectar is not the first system to give files stable identity, nor the first to describe code with an LLM, nor the first to index a codebase semantically. Each of those three capabilities has well-trodden prior art, surveyed in [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md). This essay exists because the temptation to either ignore prior art (reinventing wheels) or to dismiss it (overclaiming novelty) is the recurring failure mode of design-doc writing in the code-intelligence space.

The theory section that follows states the thesis plainly, traces each of Nectar's three intellectual lineages to the predecessor that established the pattern, and frames the narrow novelty claim the project is willing to defend. A contributor who reads only one prior-art document should read this one; an evaluator comparing Nectar to a new tool should start here and then consult the [technical specification](prior-art-technical-specification.md) for the verbatim comparison matrices.

---

## The thesis: originality is in the composition

The central claim of Nectar's prior-art stance is narrow on purpose. Each pillar — stable identity, LLM description, semantic store, watcher-driven maintenance, daemon-minted allocation — is individually present in some predecessor system. No single predecessor combines all five at file granularity, with Deep Lake persistence, integrated into an existing hybrid recall pipeline that already serves session and skill memory.

Originality, then, is not claimed on any single pillar. It is claimed on the **specific composition** and on the integration with the existing Honeycomb memory substrate. This framing serves two engineering purposes. First, it keeps the contribution honest: a reviewer who finds that a new tool "already did identity" cannot invalidate the Nectar claim, because Nectar never claimed identity alone as its contribution. Second, it scopes future work: a contributor proposing a feature should first check whether the feature duplicates a predecessor's behavior, and only propose divergence where the predecessor's choice conflicts with Nectar's composition constraints (file granularity, no source mutation, Deep Lake only).

The defensible novelty statement, restated verbatim from the crosswalk, is documented in [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md) and is deliberately the narrowest statement the project will make.

---

## Avoiding the two failure modes

Design-doc writing in the code-intelligence space fails in two opposite directions. Both are worth naming so contributors can recognize them.

The first failure mode is **reinventing wheels**. A contributor unfamiliar with Aura, Mimir, or Smith proposes a "new" identity or description model that turns out to reproduce a predecessor, often with worse tradeoffs because the predecessor's hard-won insights were rediscovered from scratch. Nectar's prior-art survey exists precisely to make this failure mode cheap to avoid: read the crosswalk, find the lineage your idea belongs to, and check whether your divergence is justified.

The second failure mode is **overclaiming novelty**. A marketing-facing or RFC-facing claim that "Nectar invented codebase semantic search" is trivially falsifiable — the CodeRAG family, Codebase Cortex, and Context+ all index codebases semantically, and Smith describes code with an LLM. Such a claim, once made and refuted, damages the credibility of the narrower and actually-true claim. The project's discipline is to never make the broad claim and always make the narrow one.

The two failure modes are mirror images. Reinventing wheels wastes engineering effort on the inside of the project. Overclaiming novelty damages the project's reputation on the outside. The prior-art corpus is the artifact that defends against both.

---

## The three intellectual lineages

Nectar's design descends from three distinguishable lineages in the code-intelligence literature. Each lineage contributes one pillar and is associated with a specific predecessor whose framing Nectar adopts, adapts, or explicitly rejects. Tracing these lineages is the most useful way to understand why Nectar's choices are what they are.

### The identity lineage — Aura and Mimir

The identity pillar — a stable identifier that survives edits, renames, and moves, decoupled from the content it currently refers to — descends from two predecessors that Nectar treats as canonical.

**Aura** (Naridon Inc.) establishes the "identity anchor versus content hash" split. Aura separates a function's persistent identity anchor (the "this is the same function" thread) from its content hash (what the body currently is). The anchor survives renames and edits; the content hash changes per edit and links to the anchor as a version. Aura's documentation frames the insight as "neither alone is enough" — content hash alone churns per edit, identity anchor alone cannot detect that two diverged files share an origin. Nectar's two-table model (`hive_graph` for identity, `hive_graph_versions` for the content+description chain, documented in [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md)) is this split lifted from function granularity to file granularity.

**Mimir** establishes the philosophical position that identity allocation should be explicit, not heuristic. Mimir's `SymbolId` is allocated by a "librarian," never derived from a name or hash, and never reused after the entity it identified is gone. Renames produce alias edges rather than rewriting identity. Nectar's choice to mint a pure random ULID rather than derive it from any file property is Mimir's principle applied at file granularity: the daemon "mints," identity is a first-class operation, and the resulting identifier is stable precisely because nothing about the file is baked into it.

The deliberate divergence in the identity lineage is granularity (Aura and Mimir are symbol- or function-granular; Nectar is file-granular in v1) and derivation (Aura derives the initial anchor from a structural signature; Nectar mints a pure ULID). The full identity decision, including the rejected alternatives, is recorded in [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md).

### The description lineage — Smith and codeindex

The description pillar — an LLM-minted natural-language title and description attached to a file, maintained lazily and committed for team inheritance — descends from predecessors that describe code with an LLM rather than with embeddings alone.

**Smith** is the closest prior art for the description model. Smith maintains per-file `.meta` files with a `Hash:` (recomputed on every save) and a `Described-Against-Hash:` (updated only by description-generating paths). When the two diver, the description is stale and `--describe` re-describes only the stale files. This is precisely Nectar's lazy enrichment model: the `describe_status = 'pending'` column is Smith's "hash differs from described-against-hash" flag, and the committed `.honeycomb/nectars.json` projection is Smith's committed description layer. Smith also teaches the team-share story — committing the descriptions means a teammate who clones the repo inherits them instead of re-paying the describe cost.

**codeindex** establishes the two-phase pipeline shape: structural README generation via tree-sitter first, then optional AI one-line module descriptions second, with the AI step opt-in. This is the same shape as Honeycomb's existing CodeGraph (structural) plus Nectar (AI enrichment) split. codeindex also articulates the local-LLM privacy property — descriptions use the local agent CLI so no code leaves the network — which Nectar inherits by routing through the local daemon and the Portkey gateway.

The deliberate divergence in the description lineage is storage and source mutation. Smith embeds descriptions in `.meta` sidecars and mutates source (`CLAUDE.md`, `constitution.md`); Nectar never mutates source and stores descriptions in Deep Lake, projecting to a single regenerable lockfile rather than per-file sidecars. The description-granularity divergence from the AST-chunk family (CodeRAG, Codebase Cortex, Context+) is discussed below.

### The delta-indexing lineage — Grove and Cartog

The delta-indexing pillar — skip unchanged files, detect renames by following content hashes, debounce watcher events — descends from the content-addressed indexing family.

**Grove** keys entries as `{filePath}::{qualifiedName}@{contentSHA}` and uses content hash to drive delta indexing. **Cartog** builds a Merkle tree of content hashes so that an unchanged subtree is skipped wholesale and a changed subtree is re-indexed incrementally with a `--debounce` watcher. Both demonstrate the core delta-indexing pattern: hash the file, skip unchanged files, follow the hash through renames.

Nectar uses content hash as the **secondary** attribute — the version key in `hive_graph_versions`, the copy-event detector, and the delta-indexing fast path — but explicitly rejects content hash as the identity key, because content hash changes per edit and therefore cannot provide stable identity without a separate anchor. This is the same insight Aura documents and that ADR-0001 records as the rejected alternative. The `(path, mtime, size)` fast path in the re-association ladder's step 1 is Grove and Cartog's delta indexing applied to the re-association problem rather than to the initial index build.

The deliberate divergence in the delta-indexing lineage is the demotion of content hash from identity to version. Nectar borrows the delta-indexing mechanics and rejects the identity model they imply.

---

## The granularity bet and the AST-chunk family

A separate lineage decision worth naming explicitly is the choice of file granularity over symbol granularity for description. A large family of 2026 MCP-server code-search tools — CodeRAG, Codebase Cortex, Context+, cba, codebase-index, codebase-indexer, code-atlas, opencode-codebase-index — parse code with tree-sitter into AST chunks (functions, classes, methods), embed each chunk, and expose semantic search over the resulting fine-grained rows.

Nectar diverges from this entire family on granularity: AST-chunk tools describe symbols and produce many embeddings per file; Nectar describes files and produces one embedding per file. The tradeoff is deliberate. AST-chunk granularity gives finer recall (a specific function within a file) at the cost of high row counts (ten to one hundred times more embeddings) and coupling to tree-sitter's parse quality. File granularity gives coarser recall but works on any text file (config, markdown, `.env`), has ten to one hundred times lower row counts, and composes with the existing structural CodeGraph rather than duplicating it.

The bet is that file-level "what is this file for" recall is the eighty-percent-useful case, and that symbol-level recall is already handled by the structural CodeGraph's `find/` and `query/` surfaces. A future Nectar v2 could add symbol-level descriptions if file-level proves insufficient, but the v1 design is deliberately file-granular. This is a divergence, not a reinvention — the AST-chunk family's approach is acknowledged and consciously not adopted for v1.

---

## How to use this essay

A contributor proposing a feature should read this essay, then the [technical specification](prior-art-technical-specification.md) to locate the feature's lineage, then check the [user-stories doc](prior-art-user-stories.md) for the auditing workflows that govern "does this duplicate prior art" questions. An evaluator comparing Nectar to a new tool should read this essay for the framing, then the [ecosystem story-arc](prior-art-ecosystem-story-arc.md) for the pillar-by-pillar divergence trace, then the [conclusion](prior-art-conclusion-and-deliverables.md) for the gap-analysis and closing reference table.

The standing instruction is: never make the broad novelty claim, always make the narrow one, and cite the crosswalk when challenged on either.
