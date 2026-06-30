# Identity Model — Engineering User Stories

> Category: Architecture | Version: 1.0 | Date: June 2026 | Status: Draft

Engineering and operator user stories with acceptance criteria for Hivenectar's identity model, derived from ADR-0001's decision drivers. Scope is implementation and operations, not product behavior; these stories define what a correct implementation and a correct deployment must guarantee.

**Related:**
- [`../ADR-0001-minted-nectar-over-source-embedded-serial.md`](../ADR-0001-minted-nectar-over-source-embedded-serial.md)
- [`identity-model-technical-specification.md`](identity-model-technical-specification.md)
- [`identity-model-ecosystem-story-arc.md`](identity-model-ecosystem-story-arc.md)
- [`identity-model-conclusion-and-deliverables.md`](identity-model-conclusion-and-deliverables.md)
- [`../../ai/identity-and-reassociation.md`](../../ai/identity-and-reassociation.md)
- [`../../data/source-graph-schema.md`](../../data/source-graph-schema.md)
- [`../../data/portable-registry.md`](../../data/portable-registry.md)

---

## How to read these stories

These stories translate the decision drivers in [`ADR-0001`](../ADR-0001-minted-nectar-over-source-embedded-serial.md) into verifiable engineering and operational acceptance criteria. They are **not a product PRD**: there are no end-user-facing features, no UI flows, no marketing claims. Each story describes a guarantee the identity-model implementation must uphold, phrased from the perspective of the persona who depends on it.

The personas recur across the stories:

- **The contributor** — an engineer whose source files must not be mutated by the daemon.
- **The reviewer** — an engineer or architect evaluating whether the identity scheme is sound.
- **The implementer** — the engineer building the re-association ladder, the minter, or the projection.
- **The operator** — the engineer handling cold-catch-up, pruning, and daemon lifecycle.
- **The teammate** — an engineer inheriting identity on a fresh clone.

Stories are grouped by the decision driver they exercise. Acceptance criteria are lettered (a), (b), (c) and are intended to be individually testable.

---

## Stability across edits

**US-ID-001** — As a reviewer, I want a file's nectar to remain unchanged when its content is edited, so that the description and history chain follow the file rather than fragmenting per save.
**Acceptance criteria:** (a) After an edit, the `source_graph.nectar` value for the file is byte-identical to its pre-edit value. (b) A new row is appended to `source_graph_versions` with an incremented `seq` and the new `content_hash`. (c) The previous version row is retained unchanged. (d) No new nectar is minted.

**US-ID-002** — As a reviewer, I want identity stability to hold across many successive edits, so that a file edited a hundred times retains a single nectar and a hundred-row version chain.
**Acceptance criteria:** (a) One nectar exists for the file after 100 edits. (b) The version chain has 100 rows keyed by distinct content hashes. (c) `ORDER BY seq DESC LIMIT 1` returns the current state in a single query.

---

## Stability across moves and renames

**US-ID-003** — As an implementer, I want a `git mv` (path change, content unchanged) to preserve the nectar, so that history follows the file to its new path.
**Acceptance criteria:** (a) The moved file resolves to its existing nectar via re-association step 3 (exact content-hash match to a missing file). (b) A new version row is appended with the new path and the same content hash. (c) No new nectar is minted. (d) No enrich job is enqueued (content unchanged).

**US-ID-004** — As an implementer, I want an IDE refactor-rename that changes path and content simultaneously to preserve the nectar when possible, so that "move and edit" does not lose history.
**Acceptance criteria:** (a) The file resolves to its existing nectar via re-association step 4 (fuzzy TLSH match above confidence threshold). (b) The appended version row carries a `confidence` field reflecting the match score. (c) If confidence is below the high band, the candidate match is surfaced for human review rather than auto-claimed. (d) If no fuzzy match clears the threshold, a fresh nectar is minted (history is not fabricated).

**US-ID-005** — As an operator, I want live-watch move detection to reconstruct ordinary renames from `node:fs.watch` observations and exact content evidence, so that routine renames are exact and fast without adding a richer watcher dependency.
**Acceptance criteria:** (a) The watcher intake debounces `rename`/`change` observations into new/changed/missing path sets. (b) The daemon carries the nectar via step 3 when the new path's content hash matches a missing file's latest hash. (c) Step 4 is reached only for move-and-edit cases or incomplete event evidence.

---

## Copy-paste as provenance

**US-ID-006** — As a reviewer, I want copy-paste of file A to a new path B to produce a distinct identity for B with an explicit provenance link back to A, so that the fork relationship is captured and survives divergence.
**Acceptance criteria:** (a) B is minted a *fresh* nectar N2 distinct from A's nectar N1. (b) `source_graph.derived_from_nectar` for N2 equals N1. (c) `fork_content_hash` for N2 equals A's content hash at copy time. (d) The link survives B's first edit (the columns are write-once).

**US-ID-007** — As a reviewer, I want the copy-paste case to contrast cleanly with the source-embedded-serial failure, so that the system never produces duplicate-identity ambiguity.
**Acceptance criteria:** (a) No two rows in `source_graph` share a nectar for distinct logical files. (b) Two files with identical current content have distinct nectars (each resolved through its own minting or inheritance path). (c) The relationship between them, if any, is expressed via `derived_from_nectar`, never via a shared identity.

**US-ID-008** — As an implementer, I want coincidental content matches (two independent empty `.gitkeep` files) to be handled gracefully, so that a spurious provenance link is the worst outcome.
**Acceptance criteria:** (a) Both files get distinct nectars. (b) The later-minted one receives a `derived_from_nectar` pointer to the earlier. (c) The cost of a wrong link is confined to the interlink view and does not corrupt recall or history chains.

---

## No source mutation

**US-ID-009** — As a contributor, I want the daemon to never modify my source files, so that the AGPL license header on line 1 is untouched and my diffs are clean.
**Acceptance criteria:** (a) No file under the project tree (excluding `.honeycomb/`) is written, prepended, or rewritten by hiveantennae during brooding, live watch, or cold catch-up. (b) `git diff` after a full brood shows changes only under `.honeycomb/`. (c) The AGPL license header remains the first line of every source file.

**US-ID-010** — As a contributor, I want the first-run brooding pass to avoid the "mega-commit" problem, so that the initial indexing does not produce a commit touching thousands of source files.
**Acceptance criteria:** (a) Brooding writes to Deep Lake and the single `.honeycomb/nectars.json` projection. (b) The source tree is untouched. (c) The only committed artifact is the projection lockfile, which is reviewable line-by-line.

**US-ID-011** — As a reviewer, I want the no-source-mutation invariant to hold across all operating modes, so that there is no mode in which the daemon writes to source as an escape hatch.
**Acceptance criteria:** (a) Brooding, live watch, cold catch-up, and projection sync all preserve the invariant. (b) There is no configuration flag that enables source mutation. (c) The enricher writes only to Deep Lake; it never edits the described file.

---

## Universal applicability

**US-ID-012** — As an implementer, I want nectars to be minted for every file type regardless of comment syntax, so that JSON, `.env`, YAML, TOML, and lockfiles are all first-class identity citizens.
**Acceptance criteria:** (a) A JSON file with no comment syntax receives a nectar. (b) A `.env` file receives a nectar. (c) A YAML, TOML, or lockfile receives a nectar. (d) Identity coverage is uniform across file types; the description layer is the only thing that varies.

**US-ID-013** — As an implementer, I want binary files to receive nectars with description explicitly skipped, so that identity coverage is universal even when semantic description is impossible.
**Acceptance criteria:** (a) A binary file receives a nectar in `source_graph`. (b) Its version row carries `describe_status = 'skipped-binary'`. (c) The enricher does not attempt to describe it. (d) The file is discoverable by path and provenance but excluded from description-based recall.

**US-ID-014** — As a reviewer, I want universal applicability to contrast with the source-embedded-serial limitation, so that no file type is excluded from the identity layer for lack of a comment syntax.
**Acceptance criteria:** (a) No file type is silently dropped from identity coverage. (b) Coverage does not depend on the file having a parseable first line. (c) A half-indexed codebase (some files with nectars, some without) never occurs as a consequence of file type.

---

## Deep Lake as the only durable store (FR-8)

**US-ID-015** — As an operator, I want all durable identity state to live in Deep Lake with no parallel sidecar store, so that there is a single source of truth and no drift between stores.
**Acceptance criteria:** (a) `source_graph` and `source_graph_versions` are Deep Lake tables. (b) No SQLite database, JSONL log, or parallel store holds authoritative identity state. (c) A regenerable `(path → mtime → last_hash)` poll cache may exist but is deletable without loss and is not a source of truth.

**US-ID-016** — As a reviewer, I want `.honeycomb/nectars.json` to behave as a projection (regenerable lockfile), not a sidecar (parallel source of truth), so that FR-8 is satisfied.
**Acceptance criteria:** (a) Deep Lake writes happen before the projection is regenerated. (b) The projection is never the target of a write during normal operation. (c) `honeycomb hivenectar rebuild-projection` regenerates the file from a Deep Lake scan with no other inputs, byte-identical modulo `generated_at`. (d) A hand-edit to the projection is overwritten on the next regeneration.

---

## Fresh-clone portability

**US-ID-017** — As a teammate, I want a fresh `git clone` to inherit the project's nectars and descriptions without re-paying the brooding cost, so that my checkout is immediately useful offline.
**Acceptance criteria:** (a) The clone contains `.honeycomb/nectars.json`. (b) On daemon boot, the projection is validated (version, project triple, syntactic validity). (c) Each on-disk file's content hash is matched into the projection's content-hash index. (d) A current projection yields zero LLM calls and zero fuzzy matches on clone.

**US-ID-018** — As a teammate, I want inheritance to require no network access or Deep Lake auth, so that the clone works on a plane, behind a firewall, or before login.
**Acceptance criteria:** (a) The inheritance path reads only local files and writes only to the local Deep Lake instance. (b) No outbound network call is required for identity inheritance. (c) Recall is live immediately after inheritance, before any cloud sync.

**US-ID-019** — As an implementer, I want a stale projection (files on disk with content hashes absent from the projection) to fall through to the re-association ladder, so that inheritance degrades gracefully rather than failing.
**Acceptance criteria:** (a) Files whose content hash is not in the projection enter the ladder. (b) The projection's content-hash index serves as the step-3 "known nectars" map. (c) Genuinely new files (no ladder match) are minted fresh nectars.

**US-ID-020** — As an operator, I want a missing or corrupt projection to be recoverable, so that identity is never permanently lost.
**Acceptance criteria:** (a) Deleting `.honeycomb/nectars.json` does not delete Deep Lake state. (b) `honeycomb hivenectar rebuild-projection` regenerates the file from Deep Lake. (c) A projection that fails validation is ignored with a warning, and the daemon falls back to full brooding.

---

## Cold catch-up and operator concerns

**US-ID-021** — As an operator, I want cold catch-up (daemon boots after offline move-and-edit) to reconcile disk against Deep Lake conservatively, so that history chains are not corrupted by a mis-association.
**Acceptance criteria:** (a) Cold catch-up runs the re-association ladder per file. (b) Step 4 fuzzy matches below the confidence threshold are surfaced for human review, not auto-claimed. (c) A mis-association is treated as worse than a new nectar. (d) Low-confidence candidates appear in the dashboard or `honeycomb hivenectar review-matches`.

**US-ID-022** — As an operator, I want nectar deletion to be an explicit, conservative, human-triggered operation, so that orphaned nectars (deleted files) are retained as history rather than silently purged.
**Acceptance criteria:** (a) The re-association ladder never deletes a nectar; step 5 mints new rather than reusing orphans. (b) `honeycomb hivenectar prune --confirm` removes nectars whose latest path has been missing beyond a grace period (default 30 days). (c) Pruning is never automatic.

**US-ID-023** — As an operator, I want the daemon to tolerate TLSH scale concerns on monorepo cold boots, so that cold catch-up does not become pathologically slow.
**Acceptance criteria:** (a) The fuzzy comparison uses size-bucketing to limit candidate sets. (b) The O(N×M) worst case is bounded by bucketing in v1. (c) A future minhash-LSH pre-filter is a documented extension point, not a v1 requirement.

---

## Identity across the daemon lifecycle and upgrades

**US-ID-024** — As an implementer, I want minted nectars to survive daemon upgrades unchanged, so that an upgrade never re-broods the codebase or invalidates existing associations.
**Acceptance criteria:** (a) The nectar is never re-derived or recomputed after minting. (b) If minting logic changes in a future release, old nectars keep their values; new nectars use the new logic. (c) An upgrade does not trigger a full re-brood.

**US-ID-025** — As a reviewer, I want the identity model's irreversibility to be understood and documented, so that the decision is not casually revisited.
**Acceptance criteria:** (a) The schema is migratable to a different identity scheme at the data-model level. (b) The operation is irreversible once nectars are minted and descriptions written (re-brooding under a different model is expensive). (c) The reversibility analysis is recorded in [`ADR-0001`](../ADR-0001-minted-nectar-over-source-embedded-serial.md) and [`identity-model-conclusion-and-deliverables.md`](identity-model-conclusion-and-deliverables.md).

---

## Story-to-driver traceability

The stories above map directly to the ADR's decision drivers. An implementation satisfies the identity model when every story's acceptance criteria pass.

| Decision driver | Stories |
|---|---|
| Stability across edits | US-ID-001, US-ID-002 |
| Stability across moves/renames | US-ID-003, US-ID-004, US-ID-005 |
| Copy-paste as provenance | US-ID-006, US-ID-007, US-ID-008 |
| No source mutation | US-ID-009, US-ID-010, US-ID-011 |
| Universal applicability | US-ID-012, US-ID-013, US-ID-014 |
| Deep Lake only (FR-8) | US-ID-015, US-ID-016 |
| Fresh-clone portability | US-ID-017, US-ID-018, US-ID-019, US-ID-020 |
| Cold catch-up / operator | US-ID-021, US-ID-022, US-ID-023 |
| Lifecycle / upgrades | US-ID-024, US-ID-025 |

These stories are the engineering scope of the identity model. Product-facing behavior (what an agent sees in recall, how the interlink view renders) is documented in the recall and frontend domain docs, not here.
