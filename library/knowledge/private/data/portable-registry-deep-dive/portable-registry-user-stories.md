# Portable Registry: User Stories

> Category: Data | Version: 1.1 | Date: July 2026 | Status: Draft

Engineering and operator user stories for the portable registry projection, scoped to the personas that exercise it: the teammate on a fresh `git clone`, the daemon booting with a projection present, the reviewer reading the projection diff in a PR, the operator running `rebuild-projection`, and the contributor whose PR adds a newly-described file. Each story carries acceptance criteria tied to the contract in [`portable-registry-technical-specification.md`](portable-registry-technical-specification.md).

**Related:**
- [`../portable-registry.md`](../portable-registry.md)
- [`portable-registry-introduction-and-theory.md`](portable-registry-introduction-and-theory.md)
- [`portable-registry-technical-specification.md`](portable-registry-technical-specification.md)
- [`portable-registry-ecosystem-story-arc.md`](portable-registry-ecosystem-story-arc.md)
- [`portable-registry-conclusion-and-deliverables.md`](portable-registry-conclusion-and-deliverables.md)
- [`../hive-graph-schema.md`](../hive-graph-schema.md)
- [`../recall-integration.md`](../recall-integration.md)
- [`../../ai/identity-and-reassociation.md`](../../ai/identity-and-reassociation.md)
- [`../../ai/brooding-pipeline.md`](../../ai/brooding-pipeline.md)

---

## How to read these stories

These are engineering-scope user stories, not a PRD. They describe the behaviors the portable registry must exhibit from the perspective of each actor that interacts with it, with acceptance criteria precise enough to drive implementation and verification against the contract in [`portable-registry-technical-specification.md`](portable-registry-technical-specification.md). The personas:

- **The teammate** — a developer on a fresh `git clone` whose checkout inherits identity through the committed projection.
- **The daemon** — the hiveantennae process that loads, validates, and regenerates the projection at boot and at the end of brood/enrich cycles.
- **The reviewer** — a human reading the projection diff in a PR, sanity-checking newly-committed descriptions.
- **The operator** - a human running `nectar rebuild-projection` to repair a corrupt, lost, or stale projection.
- **The contributor** — a developer whose PR adds a new described file, producing one new projection entry.

Story IDs are `US-PR-NNN`, grouped by lifecycle phase and cross-cutting concern.

---

## Offline fresh-clone inheritance (zero LLM calls)

**US-PR-001** — As the teammate on a fresh `git clone`, when `.honeycomb/nectars.json` is committed and current, I inherit every nectar and description through content-hash matching without any LLM call.
**Acceptance criteria:** (a) The clone's local Deep Lake has no `hive_graph` rows before boot. (b) The daemon loads and validates the projection (version, project triple, ULID/hash syntax). (c) Each on-disk file's content hash is matched into the projection's `files` map. (d) A current projection yields zero LLM calls and zero fuzzy matches.

**US-PR-002** — As the teammate, after inheritance my clone serves semantic recall immediately, before any network or Deep Lake cloud sync.
**Acceptance criteria:** (a) Inherited nectars and descriptions are written to the local Deep Lake. (b) Recall is live after the boot-time inheritance pass completes. (c) No network access or auth is required for the inheritance path to succeed.

**US-PR-003** — As the teammate, files whose content hashes miss the projection fall through to the re-association ladder rather than failing.
**Acceptance criteria:** (a) A miss does not abort the boot. (b) Misses enter the re-association ladder documented in [`../../ai/identity-and-reassociation.md`](../../ai/identity-and-reassociation.md). (c) The ladder mints, carries, or surfaces for review as appropriate.

**US-PR-004** — As the teammate, an undescribed file in the projection preserves identity but does not surface in recall until described.
**Acceptance criteria:** (a) A nectar minted but never described appears with a minimal entry (`path`, `content_hash`, empty `title`/`description`). (b) Identity is inherited on clone. (c) Recall excludes the entry until a description is filled.

---

## Version and project validation on load

**US-PR-005** — As the daemon, when the projection's `version` is one I know how to read (≤ my schema version), I load it; when it is higher, I refuse and fall back to brooding.
**Acceptance criteria:** (a) The version check is `projection.version <= daemon.schema_version`. (b) A higher version is logged as a warning and ignored. (c) On refusal, the daemon falls back to full brooding.

**US-PR-006** — As the daemon, when the projection's project triple does not match the current context, I ignore it rather than loading mismatched identity.
**Acceptance criteria:** (a) `project.org_id`, `project.workspace_id`, `project.project_id` must all match the current context. (b) A mismatch (the repo was templated from another project, or the file was committed by mistake) is logged and ignored. (c) The daemon falls back to brooding.

**US-PR-007** — As the daemon, I never partially load a projection that fails any validation check.
**Acceptance criteria:** (a) Validation is atomic across all checks (version, project, ULID syntax, sha256 syntax). (b) Any single failure causes the entire projection to be ignored with a warning. (c) No rows from a failed projection are written to Deep Lake.

---

## ULID and sha256 syntactic validation

**US-PR-008** — As the daemon, I validate that every nectar key in the `files` map is a syntactically valid ULID before inheriting it.
**Acceptance criteria:** (a) Each key is a 26-character Crockford base32, uppercase, timestamp-sortable ULID. (b) A malformed key fails validation for the whole projection. (c) No malformed nectar is inherited or written to Deep Lake.

**US-PR-009** — As the daemon, I validate that every `content_hash` in the projection is a syntactically valid sha256 before using it as a match key.
**Acceptance criteria:** (a) Each `content_hash` conforms to the expected sha256 format. (b) A malformed hash fails validation for the whole projection. (c) No match is attempted against an invalid hash.

**US-PR-010** — As the daemon, validation failure of the projection is recoverable: the clone broods from scratch rather than being stuck.
**Acceptance criteria:** (a) A projection ignored for any validation reason triggers a full brood. (b) The brood mints fresh nectars and writes fresh descriptions. (c) After brooding, a new valid projection is regenerated.

---

## The projection-not-sidecar invariant (three enforcement rules)

**US-PR-011** — As the daemon, I write to Deep Lake first and regenerate the projection only afterward; the projection is never the target of a write.
**Acceptance criteria:** (a) Every nectar mint, version append, and description write goes to Deep Lake before the projection is regenerated. (b) The projection is always derived, never authoritative. (c) No code path writes to the projection as a source of truth.

**US-PR-012** — As the daemon, I treat the projection as read-only except for the regeneration write; a hand-edit is overwritten on the next regeneration.
**Acceptance criteria:** (a) No external tool or human edit to `.honeycomb/nectars.json` is respected as state. (b) The next regeneration overwrites any hand-edit. (c) The file is read-only from the system's perspective except for the regeneration write.

**US-PR-013** — As the operator, I can regenerate a byte-identical projection (modulo `generated_at`) from Deep Lake alone, with no other inputs.
**Acceptance criteria:** (a) `nectar rebuild-projection` scans `hive_graph_versions` and produces the projection. (b) The output is byte-identical to a prior regeneration except for `generated_at`. (c) No input other than Deep Lake is required. (d) If the rebuild could not reproduce the file, the projection would be carrying state Deep Lake does not have - a sidecar, which is disallowed.

---

## Atomic write (temp + rename)

**US-PR-014** — As the daemon, I write the projection atomically so a crashed regeneration leaves the old projection, not a partial one.
**Acceptance criteria:** (a) Regeneration writes to a temporary file. (b) On success, the temp file is renamed onto `.honeycomb/nectars.json`. (c) A crash during the write leaves the previous projection intact. (d) No partial or truncated projection is ever observable on disk.

**US-PR-015** — As the daemon, the atomic write reuses the same temp-file-plus-rename pattern the CodeGraph uses for snapshot writes.
**Acceptance criteria:** (a) The write pattern is consistent with the CodeGraph snapshot write path. (b) The rename is the commit point. (c) Readers either see the old file or the new file, never an intermediate state.

---

## Debounced writes

**US-PR-016** — As the daemon, I debounce projection writes so a rapid-fire edit session produces one write at the end, not one per save.
**Acceptance criteria:** (a) Projection writes are debounced with the same cadence as enricher calls (see [`../../ai/enricher-and-llm-model.md`](../../ai/enricher-and-llm-model.md)). (b) A rapid edit session yields one projection write at the end of the enricher cycle (default 30 seconds). (c) In practice the file changes only when descriptions actually change — far less often than the cycle bound.

**US-PR-017** — As the daemon, I do not regenerate the projection at the end of an enricher cycle that wrote no new descriptions.
**Acceptance criteria:** (a) The end-of-enrich-cycle regeneration fires only when new descriptions were written. (b) A cycle with no description changes produces no projection write. (c) The projection's `generated_at` is not bumped for a no-op cycle.

---

## The three generation points

**US-PR-018** — As the daemon, I regenerate the projection at the end of every brood, producing a complete projection.
**Acceptance criteria:** (a) End-of-brood regeneration runs after all brood nectars and descriptions are written to Deep Lake. (b) The output is a complete projection covering every described nectar. (c) The brood's projection bootstrap is what makes the brood durable and shareable (see [`../../ai/brooding-pipeline.md`](../../ai/brooding-pipeline.md)).

**US-PR-019** — As the daemon, I regenerate the projection at the end of an enricher cycle that wrote new descriptions, substituting the newly-described versions in.
**Acceptance criteria:** (a) End-of-enrich-cycle regeneration runs only after new descriptions are committed to Deep Lake. (b) The incremental update substitutes the newly-described latest versions into the projection. (c) Unchanged entries are retained.

**US-PR-020** - As the operator, I can trigger a full regeneration explicitly via `nectar rebuild-projection`.
**Acceptance criteria:** (a) The command performs a full regeneration from Deep Lake. (b) It is used when the projection is corrupt, lost, or suspected stale. (c) The output is byte-identical (modulo `generated_at`) to a daemon-generated projection.

---

## The commit discipline

**US-PR-021** — As the contributor whose PR adds a new described file, the projection gains exactly one entry for that file, and the diff is reviewable.
**Acceptance criteria:** (a) A new described file adds one entry to the `files` map keyed by its nectar. (b) The PR diff shows the nectar, path, title, and description. (c) A reviewer can sanity-check that the description is reasonable.

**US-PR-022** — As the reviewer reading the projection diff in a PR, I see descriptions as a reviewable artifact rather than an opaque database blob.
**Acceptance criteria:** (a) The diff is human-readable: nectar, path, title, description, concepts per entry. (b) A typical PR adds or modifies a handful of entries, not the whole file. (c) The descriptions are visible without querying Deep Lake.

**US-PR-023** — As the daemon, when a file's description is updated, exactly that entry's fields change in the projection.
**Acceptance criteria:** (a) A description update modifies one entry's `title`, `description`, `concepts`, `describe_model`, and `described_at`. (b) The entry's nectar key is unchanged. (c) Other entries are not touched.

**US-PR-024** — As the daemon, when a file is deleted, its entry may be retained for a grace period in case of branch switches.
**Acceptance criteria:** (a) A deleted file's entry is removed from the projection — though the daemon may keep it for a grace period. (b) The grace period absorbs branch switches so a checkout switch does not lose identity. (c) After the grace period, the entry is dropped.

---

## The gitignore alternative tradeoff

**US-PR-025** — As the operator, I can choose to gitignore `.honeycomb/nectars.json`; the daemon still writes it locally, but it is not shared and every clone broods from scratch.
**Acceptance criteria:** (a) If the file is gitignored, the daemon still writes it for the local clone's own use. (b) The file is not shared across clones. (c) The tradeoff is that every clone pays the brooding LLM cost independently. (d) The recommendation is to commit it, but the system works either way.

---

## What these stories do not cover

These stories describe the projection's behavior contract. The conceptual motivation for the projection-vs-sidecar distinction and the FR-8 angle is in [`portable-registry-introduction-and-theory.md`](portable-registry-introduction-and-theory.md). The file-format spec, generation points, validation-on-load contract, and atomic write pattern are in [`portable-registry-technical-specification.md`](portable-registry-technical-specification.md). The end-to-end fresh-clone journey is in [`portable-registry-ecosystem-story-arc.md`](portable-registry-ecosystem-story-arc.md). The four-rule hard contract and the commit-vs-gitignore tradeoff are restated in [`portable-registry-conclusion-and-deliverables.md`](portable-registry-conclusion-and-deliverables.md).
