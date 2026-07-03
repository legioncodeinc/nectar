# Re-association: User Stories

> Category: AI | Version: 1.1 | Date: July 2026 | Status: Draft

Engineering and operator user stories for the re-association ladder, scoped to the personas that exercise it: the daemon performing cold catch-up at boot, the `node:fs.watch` intake in live mode, the reviewer adjudicating low-confidence TLSH matches, the operator running prune, and the teammate whose copy-paste becomes a provenance edge. Each story carries acceptance criteria tied to the contract in [`reassociation-technical-specification.md`](reassociation-technical-specification.md).

**Related:**
- [`../identity-and-reassociation.md`](../identity-and-reassociation.md)
- [`reassociation-introduction-and-theory.md`](reassociation-introduction-and-theory.md)
- [`reassociation-technical-specification.md`](reassociation-technical-specification.md)
- [`reassociation-ecosystem-story-arc.md`](reassociation-ecosystem-story-arc.md)
- [`reassociation-conclusion-and-deliverables.md`](reassociation-conclusion-and-deliverables.md)
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md)

---

## How to read these stories

These are engineering-scope user stories, not a PRD. They describe the behaviors the re-association ladder must exhibit from the perspective of each actor that interacts with it, with acceptance criteria precise enough to drive implementation and verification against the contract in [`reassociation-technical-specification.md`](reassociation-technical-specification.md). The personas:

- **The daemon** — the hiveantennae process performing cold catch-up at boot or re-associating on watcher events.
- **The `node:fs.watch` intake** — the live-mode event source that reports path observations and triggers debounced re-association work.
- **The reviewer** — a human adjudicating low-confidence TLSH matches surfaced by the review surface.
- **The operator** - a human running `nectar prune --confirm`.
- **The teammate** — a developer whose copy-paste, edit, or fresh clone exercises the ladder.

Story IDs are `US-RA-NNN`, grouped by ladder step and cross-cutting concern.

---

## Step 1 — `(path, mtime, size)` exact match

**US-RA-001** — As the daemon performing cold catch-up, when I observe a file whose path, mtime, and size all match the latest version row of some nectar, I skip re-hashing and re-association for that file.
**Acceptance criteria:** (a) The predicate is `disk.path == row.path AND disk.mtime == row.mtime_observed AND disk.size_bytes == row.size_bytes` against the latest version row. (b) No Deep Lake write occurs on a step-1 hit. (c) No file content is read or hashed. (d) The check is scoped by `org_id`, `workspace_id`, `project_id`.

**US-RA-002** — As the daemon, I treat mtime as a cache key only, never as an identity authority.
**Acceptance criteria:** (a) Any file that fails the step-1 predicate is content-hashed before a step-2-through-5 decision is made. (b) A file whose mtime was mutated by `touch`, `rsync`, or `git checkout` without a content change still resolves correctly through step 1 (size matches) or step 3 (content hash matches). (c) mtime alone is never sufficient to claim, carry, or move a nectar.

**US-RA-003** — As the `node:fs.watch` intake in live mode, I rarely invoke step 1 because I only schedule paths with observed changes.
**Acceptance criteria:** (a) Live watch does not re-run step 1 against files the watcher has not emitted events for. (b) Step 1 dominates cold-catch-up boot frequency, not live-watch frequency, per the distribution table in [`reassociation-technical-specification.md`](reassociation-technical-specification.md).

---

## Step 2 — path match, content changed

**US-RA-004** — As the daemon, when a file's path matches a known nectar but its content hash differs from the latest version, I append a new version row without changing the nectar.
**Acceptance criteria:** (a) A new `hive_graph_versions` row is appended with `seq = prev_seq + 1`, the new `content_hash`, and `title/description/embedding = NULL`, `describe_status = 'pending'`. (b) The previous version row is retained unchanged. (c) `hive_graph.last_update_date` is updated. (d) A lazy enrich job is enqueued for the new version.

**US-RA-005** — As the `node:fs.watch` intake in live mode, step 2 is my dominant path because normal edits keep the path stable and change only the content.
**Acceptance criteria:** (a) A save event on a tracked path produces a step-2 resolution. (b) The configured watcher intake debounce collapses rapid-fire saves on the same path into a single step-2 append. (c) Intermediate saves within an enricher cycle are never described — only `MAX(seq) per nectar WHERE describe_status = 'pending'` enters the enricher queue.

**US-RA-006** — As the daemon, I do not re-describe a file whose edit is cosmetic (whitespace, reformatting).
**Acceptance criteria:** (a) The enricher applies the "meaningful change" heuristic (Jaccard token similarity ≥ `REDESCRIBE_THRESHOLD`, default 0.85) before re-describing. (b) A cosmetic change inherits the previous version's `title`, `description`, `concepts`, and `embedding`, with `describe_model = inherited-from:<prev_content_hash>`.

---

## Step 3 — exact content-hash match to a missing file (move detector)

**US-RA-007** — As the `node:fs.watch` intake in live mode, when a new path's content hash matches a missing file's latest content hash, I carry the nectar from the missing path to the new path via step 3.
**Acceptance criteria:** (a) The debounced intake refreshes the new/changed path set and the missing-files set. (b) The new path's content hash exactly matches the missing file's latest `content_hash`. (c) A new `hive_graph_versions` row is appended for the existing nectar with the new `path` and the same `content_hash` (composite key collision avoided by incremented `seq`). (d) No enrich job is enqueued — the content is unchanged.

**US-RA-008** — As the daemon performing cold catch-up, when an offline rename produces a new path whose content hash exactly matches a missing file's latest hash, I carry the nectar.
**Acceptance criteria:** (a) The daemon computes the set difference between Deep Lake's known paths and disk's current paths to build the missing-files map. (b) The new path's hash is compared against missing files' latest version hashes. (c) An exact sha256 match carries the nectar; the previous version row's stale path is retained as history.

**US-RA-009** — As the daemon, I do not enqueue an enrich job for a step-3 move because the content is unchanged.
**Acceptance criteria:** (a) No `describe_status = 'pending'` row is created by a pure move. (b) The carried nectar's existing description continues to apply at the new path. (c) Recall surfaces the file at its new path with its existing description.

**US-RA-010** — As the teammate, when I run `git mv src/a.ts src/auth/a.ts` while the daemon is online, the nectar follows the file without re-description.
**Acceptance criteria:** (a) The move resolves through step 3, not step 5. (b) The file's title and description are preserved across the rename. (c) The version chain records both the old and new path.

---

## Step 4 — fuzzy content match (TLSH) to a missing file

**US-RA-011** — As the daemon performing cold catch-up, when a file was moved *and* edited offline, I compute a TLSH fingerprint and match it against missing files' fingerprints.
**Acceptance criteria:** (a) The new path's content hash matches nothing (step 3 miss). (b) A TLSH fingerprint is computed for the new path. (c) `bestFuzzyMatch()` returns the single best candidate under `FUZZY_THRESHOLD`, breaking ties by surfacing for review rather than auto-claiming.

**US-RA-012** — As the daemon, when a fuzzy match falls in the high-confidence band, I carry the nectar automatically and record the confidence.
**Acceptance criteria:** (a) `confidence = 1 − normalizedTLSHDistance` falls above the configurable high band (default tuned during brooding — no concrete value is committed by the spec). (b) A new version row is appended for the carried nectar with the `confidence` field populated. (c) An enrich job is enqueued (the content changed). (d) No human review is required.

**US-RA-013** — As the daemon, when a fuzzy match falls in the review band, I do not auto-claim the nectar; I surface the candidate for review and provisionally mint.
**Acceptance criteria:** (a) `confidence` is between the low and high bounds. (b) The candidate is added to the `nectar review-matches` queue. (c) The file on disk is associated to a provisional fresh nectar so recall keeps working pending adjudication. (d) The nectar is not carried until the reviewer accepts.

**US-RA-014** — As the daemon, when a fuzzy match falls below the low-confidence band, I do not surface it; I fall through to step 5 and mint.
**Acceptance criteria:** (a) `confidence` falls at or below the low band (default tuned during brooding — no concrete value is committed by the spec). (b) No candidate is added to the review queue. (c) A fresh nectar is minted for the file. (d) No history corruption occurs — the would-be source nectar's chain is untouched.

**US-RA-015** — As the reviewer, I can list, accept, or reject pending low-confidence candidates via the review surface.
**Acceptance criteria:** (a) `nectar review-matches` lists candidates with their `confidence`, the on-disk path, and the candidate source nectar. (b) The reviewer can accept a candidate, which rewrites the provisional nectar's rows to point at the carried nectar and records the decision. (c) The reviewer can reject a candidate, which leaves the provisional mint in place and removes it from the queue. (d) Review decisions are auditable on the version row. (The exact accept/reject flag syntax is an implementation detail the source spec does not pin.)

**US-RA-016** — As the `node:fs.watch` intake in live mode, I rarely reach step 4 because ordinary moves resolve through step 3 exact-hash reconstruction.
**Acceptance criteria:** (a) Step 4 fires in live mode only for move-and-edit cases or incomplete event evidence. (b) The review surface is not populated by normal live operation. (c) Cold catch-up after offline move-and-edit is the primary source of review-band candidates.

---

## Step 5 — mint new nectar

**US-RA-017** — As the daemon, when no step 1–4 match resolves a file, I mint a fresh ULID nectar.
**Acceptance criteria:** (a) `mintNectar()` returns a 26-char Crockford-base32 ULID. (b) A `hive_graph` row is written with the nectar as primary key, `created_at` set to the decoded ULID timestamp. (c) An initial `hive_graph_versions` row is appended. (d) An enrich job is enqueued.

**US-RA-018** — As the teammate whose genuinely new file appears, I get a fresh nectar with no `derived_from_nectar`.
**Acceptance criteria:** (a) The new file's content hash matches no existing file's current content (copy detection returns `action: 'mint'`). (b) `hive_graph.derived_from_nectar` is empty. (c) The nectar is an original mint.

---

## Copy-paste as provenance

**US-RA-019** — As the teammate who copy-pastes file A to a new path B, the daemon mints B a fresh nectar with `derived_from_nectar` pointing at A.
**Acceptance criteria:** (a) B's content hash matches A's current content hash. (b) `classifyNewFile()` returns `action: 'copy', sourceNectar: A.nectar`. (c) B gets a fresh ULID nectar N2. (d) `hive_graph` for N2 sets `derived_from_nectar = N1` and `fork_content_hash = H1` (A's content at copy time). (e) A's nectar N1 is unchanged.

**US-RA-020** — As the teammate, when I later edit B so its content diverges from A, the `derived_from_nectar` link survives.
**Acceptance criteria:** (a) B's edit appends a version row to N2's chain (step 2). (b) `derived_from_nectar` on N2 is write-once and is not cleared or updated by the edit. (c) The Obsidian-style interlink view continues to render "B was forked from A" indefinitely.

**US-RA-021** — As the daemon, when two genuinely independent files happen to have identical content, I treat the second-minted as a copy of the first.
**Acceptance criteria:** (a) The detection is content-hash based and cannot distinguish a true copy from a coincidental match. (b) The second-minted nectar carries `derived_from_nectar`. (c) The cost of a wrong call is a spurious link in an interlink view, not history corruption.

---

## The never-delete, never-reuse invariant

**US-RA-022** — As the daemon, I never delete a nectar as part of re-association, and I never reuse an orphaned nectar for a new file.
**Acceptance criteria:** (a) Step 5 always mints a fresh nectar; it never scans for orphaned nectars and reassigns them. (b) Orphaned nectars (file deleted, not moved) remain in Deep Lake as history. (c) A nectar, once minted, is immutable in its identity; the re-association ladder only appends version rows or carries the nectar to a new path.

**US-RA-023** — As the operator, deletion of nectar records is a separate, explicit, human-triggered operation with a grace period.
**Acceptance criteria:** (a) `nectar prune --confirm` is the only path that removes nectar records. (b) Only nectars whose *latest* version path has been missing longer than the grace period (default 30 days) are eligible. (c) `--confirm` is required; pruning never runs automatically. (d) A nectar with any version pointing at a live path is never pruned.

**US-RA-024** — As the operator, the grace period absorbs branch switches and unmerged feature work so I do not destroy history prematurely.
**Acceptance criteria:** (a) A file absent because it lives on an unmerged branch is not pruned within the grace window. (b) The default 30-day window covers a typical branch lifecycle. (c) The grace period is configurable.

---

## Cross-cutting: project scoping and projection

**US-RA-025** — As the daemon, I never cross project boundaries when re-associating.
**Acceptance criteria:** (a) Every ladder query is scoped by `project_id` (plus `org_id`, `workspace_id`). (b) Two projects in the same workspace that happen to share a file path do not share nectars. (c) A missing-files map is built per-project.

**US-RA-026** — As the teammate on a fresh clone, when the committed `nectars.json` projection is current, I inherit every nectar through content-hash matching and run zero fuzzy matches.
**Acceptance criteria:** (a) The daemon loads and validates the projection (version, project triple, ULID/hash syntax). (b) Each on-disk file's content hash is matched into the projection before the ladder runs. (c) A current projection produces zero LLM calls and zero fuzzy matches on clone. (d) Files whose hashes miss the projection fall through to the ladder.

---

## What these stories do not cover

These stories describe the ladder's behavior contract. The conceptual motivation for the conservatism (why a mis-association is worse than a new nectar) is in [`reassociation-introduction-and-theory.md`](reassociation-introduction-and-theory.md). The predicate-by-predicate specification is in [`reassociation-technical-specification.md`](reassociation-technical-specification.md). The end-to-end journey tying the steps together is in [`reassociation-ecosystem-story-arc.md`](reassociation-ecosystem-story-arc.md). The four-rule hard contract is restated in [`reassociation-conclusion-and-deliverables.md`](reassociation-conclusion-and-deliverables.md).
