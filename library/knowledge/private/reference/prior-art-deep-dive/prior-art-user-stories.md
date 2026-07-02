# Prior Art — Engineering and Operator User Stories

> Category: Reference | Version: 1.0 | Date: June 2026 | Status: Draft

Engineering-scoped user stories that describe how contributors and operators work with the prior-art survey: justifying novelty honestly, auditing the borrow-credit claims, and deciding whether a proposed feature duplicates a predecessor. This is an engineering-operations reference, not a product PRD; it describes no user-facing feature work.

**Related:**
- [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md)
- [`prior-art-introduction-and-theory.md`](prior-art-introduction-and-theory.md)
- [`prior-art-technical-specification.md`](prior-art-technical-specification.md)
- [`prior-art-ecosystem-story-arc.md`](prior-art-ecosystem-story-arc.md)
- [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md)
- [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## How to read these stories

The five personas below are the people who actually use the prior-art corpus in their day-to-day work on Nectar. They are engineering and operations roles, not product personas — there is no "end user wanting better search" here, because the prior-art survey is an internal artifact. Each story is scoped to a concrete decision or audit the persona performs, and each carries acceptance criteria phrased as testable checks against the crosswalk and the [technical specification](prior-art-technical-specification.md).

The personas:

- **The Honest-Justification Engineer** — writes the novelty claim in an RFC, blog post, or response to a reviewer, and must justify Nectar's originality without overclaiming.
- **The Identity-Selection Architect** — selects or re-evaluates the identity model (and any future v2 granularity change) with full awareness of what Aura, Mimir, Orbit, Grove, Cartog, and synrepo already do.
- **The Feature-Proposing Contributor** — proposes a feature and must first check whether the feature duplicates a predecessor's behavior.
- **The Borrow-Claim Reviewer** — audits the "what we borrow" claims to ensure credit is accurate and no predecessor is mis-cited.
- **The Tool-Evaluation Evaluator** — compares Nectar to a newly-surfaced tool and must place the new tool in the pillar matrix.

The five pillars referenced throughout are stable identity, LLM description, semantic store, watcher-driven maintenance, and daemon-minted identity. The verbatim pillar matrix and borrow-credit table live in [`prior-art-technical-specification.md`](prior-art-technical-specification.md).

---

## Persona 1 — The Honest-Justification Engineer

**US-PA-001** — As the honest-justification engineer, I want to write the narrowest defensible novelty statement so that any reviewer challenge lands inside a claim I can actually defend. **Acceptance criteria:** (a) the statement cites the five-point novelty checklist in the [technical specification](prior-art-technical-specification.md); (b) the statement names the composition, not any single pillar, as the original contribution; (c) the statement does not contain the phrase "first codebase semantic search" or any broader claim.

**US-PA-002** — As the honest-justification engineer, I want to attribute the identity-anchor / content-hash split to Aura and the minted-not-derived principle to Mimir, so that the identity lineage is credited correctly. **Acceptance criteria:** (a) Aura is cited for the two-table identity+version model and the "neither alone is enough" framing; (b) Mimir is cited for minted identity as a first-class operation and explicit non-reuse of IDs; (c) no claim is made that Nectar invented the identity/ version split.

**US-PA-003** — As the honest-justification engineer, I want to attribute the lazy-description-with-staleness-tracking model to Smith, so that the description lineage is credited correctly. **Acceptance criteria:** (a) Smith is cited for the `Hash:` / `Described-Against-Hash:` pattern that maps to Nectar's `describe_status = 'pending'`; (b) Smith is cited for the committed-description-cache team-inheritance story; (c) the divergence (Smith mutates source via `.meta` sidecars; Nectar never mutates source) is stated explicitly.

**US-PA-004** — As the honest-justification engineer, I want to state that originality is in the composition, so that a reviewer who finds a predecessor covering one pillar cannot invalidate the claim. **Acceptance criteria:** (a) the framing matches the thesis in [`prior-art-introduction-and-theory.md`](prior-art-introduction-and-theory.md); (b) the statement acknowledges that the closest single predecessor (Smith) covers only two of the five novelty points partially and lacks three entirely.

**US-PA-005** — As the honest-justification engineer, I want to reject the broad "Nectar invented codebase semantic search" framing on the record, so the project never makes a falsifiable broad claim. **Acceptance criteria:** (a) the rejection cites the CodeRAG family, Codebase Cortex, and Context+ as prior semantic-indexing tools; (b) the narrow claim (the verbatim defensibility statement in [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md)) is offered in its place.

---

## Persona 2 — The Identity-Selection Architect

**US-PA-006** — As the identity-selection architect, I want to choose between content-derived and daemon-minted identity with the prior-art tradeoffs visible, so that the decision is grounded rather than intuited. **Acceptance criteria:** (a) the choice is recorded in [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md); (b) content-derived identity is credited to Grove, Cartog, and synrepo and rejected for churning per edit; (c) the Aura "neither alone is enough" insight is cited as the reason content hash becomes the version key, not the identity key.

**US-PA-007** — As the identity-selection architect, I want to justify file granularity over symbol granularity in v1 with awareness that Aura and Mimir are symbol-granular, so that the v1/v2 split is defensible. **Acceptance criteria:** (a) the divergence table's "Identity granularity" row is referenced; (b) symbol-level nectars are named as a v2 possibility, not a v1 omission; (c) the row-count cost (ten to one hundred times more embeddings at symbol granularity) and the duplication-of-CodeGraph argument are both stated.

**US-PA-008** — As the identity-selection architect, I want to decide whether a pure minted ULID is justified over Aura's structurally-derived anchor, so that the cross-instance-dedup tradeoff is conscious. **Acceptance criteria:** (a) the choice is documented as trading global dedup for simplicity and collision-freedom; (b) Deep Lake tenancy is named as the scoping mechanism that replaces cross-instance dedup; (c) Aura's structural-signature derivation is cited as the rejected alternative.

**US-PA-009** — As the identity-selection architect, I want to reuse the Grove/Cartog delta-indexing pattern in the re-association ladder rather than reinventing it, so that the `(path, mtime, size)` fast path is credited. **Acceptance criteria:** (a) the re-association ladder's step 1 is identified as Grove/Cartog's delta indexing applied to re-association; (b) the delta-indexing lineage is credited in the borrow-credit table; (c) no claim is made that Nectar invented content-hash delta indexing.

**US-PA-010** — As the identity-selection architect, I want to evaluate a newly-surfaced identity system (for example, a new VCS) against the identity pillar before adopting any idea from it, so that I do not silently regress to a content-derived model. **Acceptance criteria:** (a) the new system is placed in the pillar matrix's "Stable identity" column; (b) its identity derivation is classified as content-derived, name-derived, or minted; (c) any borrowed idea is added to the borrow-credit table with the source URL.

---

## Persona 3 — The Feature-Proposing Contributor

**US-PA-011** — As the feature-proposing contributor, I want a checklist that tells me whether my proposed feature duplicates a predecessor, so that I do not reinvent a wheel. **Acceptance criteria:** (a) the contributor locates the feature's lineage via the [technical specification](prior-art-technical-specification.md); (b) the contributor states which pillar the feature belongs to and which predecessor covers it; (c) the contributor states the deliberate divergence or withdraws the proposal.

**US-PA-012** — As the feature-proposing contributor proposing per-symbol AST-chunk embeddings, I want the prior-art check to surface the CodeRAG family before I build it, so that I either justify the divergence or descope. **Acceptance criteria:** (a) the proposal names CodeRAG, Codebase Cortex, Context+, cba, codebase-index, codebase-indexer, code-atlas, and opencode-codebase-index as the AST-chunk family; (b) the proposal states the row-count cost (ten to one hundred times more embeddings) and the parse-quality coupling; (c) the proposal states why file granularity in v1 is insufficient before proceeding.

**US-PA-013** — As the feature-proposing contributor proposing a source-embedded serial identity, I want the prior-art check to redirect me to ADR-0001, so that I do not re-litigate a rejected alternative. **Acceptance criteria:** (a) the proposal is blocked pending a read of [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md); (b) the crosswalk's note that no surveyed system uses source-embedded identity is cited; (c) the four ADR-0001 rejection reasons (AGPL-header collision, line-1 conflict, copy-paste ambiguity, comment-syntax non-universality) are acknowledged.

**US-PA-014** — As the feature-proposing contributor proposing a learned co-activation graph (in the NeuralMind style), I want the prior-art check to surface NeuralMind's opacity tradeoff, so that I justify the loss of inspectability. **Acceptance criteria:** (a) NeuralMind is cited for the learned-synapse-graph team-memory pattern; (b) the proposal addresses the "memory must be inspectable" principle and notes that Nectar's descriptions are reviewable in the projection while synapse weights are not; (c) the proposal states why explicit LLM-minted descriptions plus RRF fusion are insufficient.

**US-PA-015** — As the feature-proposing contributor proposing an Obsidian-style interlink view, I want the prior-art check to surface Context+, so that the concept-tag interlinking is credited rather than claimed as novel. **Acceptance criteria:** (a) Context+ is cited for Obsidian-style linking; (b) the divergence (Context+ uses spectral clustering; Nectar uses hybrid recall plus concept-tag intersection) is stated; (c) the `concepts` column and the planned interlink view are framed as in-the-spirit-of, not invented-by.

---

## Persona 4 — The Borrow-Claim Reviewer

**US-PA-016** — As the borrow-claim reviewer, I want to audit the borrow-credit table for accuracy, so that no predecessor is mis-cited or under-credited. **Acceptance criteria:** (a) every row in the borrow-credit table in the [technical specification](prior-art-technical-specification.md) is checked against its source URL in the crosswalk; (b) any predecessor whose contribution is overstated is corrected; (c) any predecessor whose contribution is missing is added.

**US-PA-017** — As the borrow-claim reviewer, I want to verify that the Aura borrow claim covers the two-table model and not just the framing, so that the structural debt is credited at the right depth. **Acceptance criteria:** (a) the Aura row credits the identity-anchor / content-hash split, the two-table identity+version model, and the "neither alone is enough" framing; (b) the `hive_graph` / `hive_graph_versions` split in [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md) is traceable to Aura's anchor/ version pattern; (c) the function-versus-file granularity divergence is noted.

**US-PA-018** — As the borrow-claim reviewer, I want to verify that the Honeycomb CodeGraph borrow claim is not double-counted as Nectar originality, so that the daemon-as-only-storage-client and discovery patterns are credited to the existing substrate. **Acceptance criteria:** (a) the Honeycomb CodeGraph row credits `git ls-files` discovery, atomic write patterns, content-addressed caching, and the daemon-as-only-storage-client rule; (b) none of those four properties is claimed as Nectar-original in any other doc; (c) the recall-integration novelty point is scoped to the composition, not to the storage-client pattern.

**US-PA-019** — As the borrow-claim reviewer, I want to confirm that the five-point novelty checklist correctly marks which prior system covers each point partially, so that the "no single system combines all five" claim is auditable. **Acceptance criteria:** (a) point 1 names Mimir (symbol) and Aura (function) as partial; (b) point 2 names Smith and codeindex as partial; (c) points 3, 4, and 5 are marked as either unique-to-Nectar or partially-covered-by-Smith-only with the gap stated.

---

## Persona 5 — The Tool-Evaluation Evaluator

**US-PA-020** — As the tool-evaluation evaluator comparing Nectar to a newly-surfaced tool, I want to place the new tool in the pillar matrix, so that the comparison is structural rather than vibes-based. **Acceptance criteria:** (a) the new tool gets a row in the pillar matrix with each of the five columns filled; (b) any column the new tool fills that no surveyed predecessor fills is flagged as a potential new novelty point; (c) the result is recorded in [`../prior-art-crosswalk.md`](../prior-art-crosswalk.md) if the tool is material.

**US-PA-021** — As the tool-evaluation evaluator, I want to run the Smith gap-analysis procedure against any new description-producing tool, so that the closest-system comparison is repeatable. **Acceptance criteria:** (a) the new tool is checked against the five novelty points; (b) the tool's storage, source-mutation behavior, and identity model are classified using the divergence table dimensions; (c) the output is a one-paragraph "closest-system gap analysis" in the form documented in [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md).

**US-PA-022** — As the tool-evaluation evaluator, I want to classify a new tool's description granularity (per-file versus per-symbol AST chunk) before judging it against Nectar, so that I do not compare a chunk tool to a file tool unfairly. **Acceptance criteria:** (a) the tool's granularity is recorded using the divergence table's "Description granularity" dimension; (b) if the tool is per-symbol AST chunk, the CodeRAG-family tradeoffs (row counts, parse-quality coupling) are noted; (c) the comparison states whether the tool composes with a structural graph or duplicates one.

**US-PA-023** — As the tool-evaluation evaluator, I want to determine whether a new tool mutates source, so that the "never mutates source" divergence is applied consistently. **Acceptance criteria:** (a) the tool's source-mutation behavior is classified using the divergence table's "Source mutation" dimension; (b) if the tool mutates source (Smith-style `.meta` or `CLAUDE.md`), the Nectar divergence (projection is a separate committed file, source untouched) is stated; (c) the AGPL-header constraint from ADR-0001 is cited where relevant.

**US-PA-024** — As the tool-evaluation evaluator, I want to check whether a new tool integrates into an existing hybrid recall pipeline or is a standalone server, so that novelty point 4 is evaluated correctly. **Acceptance criteria:** (a) the tool's recall integration is classified using the divergence table's "Recall integration" dimension; (b) if the tool is a standalone semantic-search server, it is noted that it lacks the union-recall composition with session and memory; (c) the evaluator confirms that no surveyed system composes code-file recall with conversation-trace and distilled-fact recall in a single fused query.

**US-PA-025** — As the tool-evaluation evaluator, I want the closing "what Nectar does differently from every surveyed system" table updated whenever a material new tool is evaluated, so that the reference stays current. **Acceptance criteria:** (a) the new tool's row is added to the divergence table if it changes the prior-art consensus on any dimension; (b) the five-point novelty checklist is re-checked and any newly-covered point is downgraded from "unique" to "partially present in <tool>"; (c) the change is reflected in [`prior-art-conclusion-and-deliverables.md`](prior-art-conclusion-and-deliverables.md) and dated.
