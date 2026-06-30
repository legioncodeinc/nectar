# User Stories: Operator and Engineering Scope

> Category: Overview | Version: 1.0 | Date: June 2026 | Status: Draft

A detailed set of operator and engineering user stories with acceptance criteria for Hivenectar — the engineering scope of the daemon worker, the identity model, the description pipeline, the two-layer recall complementarity, fresh-clone inheritance, and daemon integration. This is not a product feature list; it is the scope a daemon operator, an implementing engineer, and a reviewer verify against.

**Related:**
- [`../overview.md`](../overview.md)
- [`overview-introduction-and-theory.md`](overview-introduction-and-theory.md)
- [`overview-technical-specification.md`](overview-technical-specification.md)
- [`../ai/identity-and-reassociation.md`](../ai/identity-and-reassociation.md)
- [`../ai/brooding-pipeline.md`](../ai/brooding-pipeline.md)
- [`../data/portable-registry.md`](../data/portable-registry.md)
- [`../data/recall-integration.md`](../data/recall-integration.md)
- [`../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)
- [`../architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md`](../architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md)

---

## Personas

These stories are scoped to the people who *operate and build* Hivenectar, not end-product users. The five personas:

- **The daemon operator** — runs `hivenectar daemon` (registered with hivedoctor per ADR-0003), configures the model provider, watches cost and queue depth in thehive's dashboard.
- **The agent consuming recall at runtime** — an LLM agent (in any harness) issuing recall queries and acting on ranked results.
- **The teammate on a fresh `git clone`** — inherits identity and descriptions without re-paying the brooding cost.
- **The reviewer reading `nectars.json`** — sanity-checks the committed projection in a pull request diff.
- **The engineer implementing hiveantennae** — builds or extends the worker and must satisfy the daemon-colocation contract.

---

## Identity minting and survival

**US-OV-001** — As a daemon operator, I want every file in the project to receive a stable nectar the first time the daemon observes it, so that each file has an identity that does not depend on its path or content. **Acceptance criteria:** (a) the nectar is a 26-character ULID minted once by hiveantennae and stored as the `source_graph.nectar` primary key; (b) the nectar is never written into the file on disk; (c) the nectar is never recomputed or re-derived after minting.

**US-OV-002** — As a daemon operator, I want a file's nectar to survive a content edit, so that the file's description history follows it across saves rather than restarting per save. **Acceptance criteria:** (a) a content edit appends a `source_graph_versions` row keyed by the new content hash with an incremented `seq`; (b) the nectar on the `source_graph` row is unchanged; (c) prior version rows remain as append-only history.

**US-OV-003** — As a daemon operator, I want a file's nectar to survive a rename or move, so that `git mv` and IDE refactor-rename do not sever the description chain. **Acceptance criteria:** (a) during live watch, `node:fs.watch` observations are debounced and classified into new/changed/missing path sets; (b) an exact content-hash match to a missing file carries the nectar to the new path without fuzzy matching; (c) the carried nectar's new version row records the new path while the prior row's stale path is retained as history; (d) no enrich job is enqueued when content is unchanged.

**US-OV-004** — As a daemon operator, I want a file's nectar to survive a move-and-edit that happened while the daemon was offline, so that cold catch-up does not lose history. **Acceptance criteria:** (a) cold catch-up runs the re-association ladder including the TLSH fuzzy step; (b) a fuzzy match above the confidence threshold carries the nectar; (c) a fuzzy match below the threshold mints a fresh nectar and surfaces the candidate for human review rather than silently claiming it.

**US-OV-005** — As a daemon operator, I want copy-paste to produce a first-class provenance edge, so that a duplicated file is its own identity yet permanently linked to its source. **Acceptance criteria:** (a) a new path whose content matches an existing file's current content mints a fresh nectar; (b) the new nectar's `derived_from_nectar` points at the source and `fork_content_hash` records the source content at copy time; (c) the provenance link survives after both files diverge through later edits.

**US-OV-006** — As a daemon operator, I want nectars to be universally applicable across file types, so that JSON, `.env`, lockfiles, and binaries all get identity even if they cannot be described. **Acceptance criteria:** (a) binary files get nectars with `describe_status = 'skipped-binary'`; (b) comment-syntax-less files (JSON, `.env`) get nectars and descriptions like any text file; (c) no file type is excluded from identity minting.

---

## Lazy description

**US-OV-007** — As a daemon operator, I want file descriptions to be filled lazily, so that a nectar can exist with a null description for as long as nobody asks about it without breaking anything. **Acceptance criteria:** (a) a nectar minted but never described has `describe_status = 'pending'` and null title/description/embedding; (b) recall excludes pending rows from semantic results without erroring; (c) no part of the system treats a null description as a failure state.

**US-OV-008** — As a daemon operator, I want the enricher to debounce rapid edits, so that ten saves in ten seconds produce one description, not ten. **Acceptance criteria:** (a) the `node:fs.watch` intake debounces events per-path within a configurable window, mirroring Honeycomb's `fs.watch` + timer pattern; (b) the enricher loop selects only the latest pending version per nectar (`MAX(seq)`), so intermediate saves within a cycle are never described; (c) intermediate version rows remain in the chain as history.

**US-OV-009** — As a daemon operator, I want cosmetic changes (reformatting) to not trigger re-description, so that a Prettier run does not waste LLM calls or churn descriptions. **Acceptance criteria:** (a) a token-Jaccard similarity pre-check compares the new content to the previously-described content; (b) similarity above the threshold (default 0.85) inherits the prior title/description/concepts/embedding and marks `describe_model = 'inherited-from:<hash>'`; (c) no LLM call is made for inherited descriptions.

**US-OV-010** — As a daemon operator, I want the description model to be configurable and auditable, so that I can swap models without code changes and know which model produced each description. **Acceptance criteria:** (a) Gemini 2.5 Flash is the default in the provider router, swappable via the same configuration as every other LLM call; (b) every `source_graph_versions` row records its `describe_model`; (c) a model swap does not automatically re-describe existing rows — that requires an explicit `brood --force --model`.

---

## The three pillars in scope

**US-OV-011** — As a daemon operator, I want Deep Lake to be the only durable store, so that there is no sidecar to drift or lose. **Acceptance criteria:** (a) all nectar, version, and description state lives in Deep Lake tables; (b) no SQLite sidecar, JSONL log, or parallel store is written; (c) `.honeycomb/nectars.json` is regenerable from a Deep Lake scan alone (byte-identical modulo `generated_at`).

**US-OV-012** — As a daemon operator, I want a portable projection committed at the project root, so that the projection is a reviewable lockfile rather than an opaque database blob. **Acceptance criteria:** (a) the projection is regenerated at the end of every brood and every enricher cycle that wrote new descriptions; (b) the projection is never edited directly by hand or external tools — a hand-edit is overwritten on the next regeneration; (c) the projection write is atomic (temp file + rename) so a crash leaves the prior file intact.

**US-OV-013** — As a daemon operator, I want the description pipeline to use a long-context model that batches aggressively, so that brooding cost is dominated by true per-file work rather than per-call overhead. **Acceptance criteria:** (a) the brooder packs ~40 small files per LLM call within the model's context window; (b) a 2000-file repo broods for under ~$3; (c) the `--dry-run` flag reports the estimated call count and cost before any LLM call is made.

---

## Two-layer complementarity (structural vs semantic)

**US-OV-014** — As an agent consuming recall at runtime, I want both structural and semantic hits for a single query, so that I learn both which files to navigate and which files to look at in the first place. **Acceptance criteria:** (a) a query like "everything associated with logins" returns structural hits (symbols named `login*`) and semantic hits (files participating in login without being named for it, e.g. `session-refresh.ts`); (b) the two hit sets are not deduplicated against each other; (c) each hit carries the information its source layer provides (symbol names from the CodeGraph; title/description from Hivenectar).

**US-OV-015** — As an agent consuming recall at runtime, I want semantic recall to surface files the structural graph cannot name, so that I am not blind to files whose meaning is not reflected in their symbols. **Acceptance criteria:** (a) a file with no symbol matching the query appears in recall if its LLM description is topically relevant; (b) the recall arm filters to `describe_status = 'described'` and the latest version per nectar; (c) the result is fused with session/memory/skill hits by reciprocal rank fusion at equal default weight.

**US-OV-016** — As an agent consuming recall at runtime, I want the Hivenectar arm to fall back gracefully when embeddings are off, so that I still get lexical results over descriptions rather than an error. **Acceptance criteria:** (a) when the embedding column is null, only the BM25 arm over `title + description` runs; (b) no error is raised and no quality cliff occurs; (c) the fallback behavior matches the rest of Honeycomb's recall arms.

**US-OV-017** — As an engineer implementing hiveantennae, I want the worker to be independent of the CodeGraph worker, so that the two can run concurrently against the same file without coordination. **Acceptance criteria:** (a) hiveantennae writes only to `source_graph` and `source_graph_versions`; (b) the CodeGraph worker writes only to `codebase`; (c) neither worker blocks or coordinates with the other.

---

## Fresh-clone projection inheritance

**US-OV-018** — As a teammate on a fresh `git clone`, I want to inherit identity and descriptions from the committed projection, so that my checkout has working semantic recall without brooding. **Acceptance criteria:** (a) on boot, the daemon loads `.honeycomb/nectars.json` and builds a content-hash→nectar index; (b) each on-disk file whose content hash matches a projection entry inherits that nectar and description into local Deep Lake; (c) a clone with a current projection achieves zero LLM calls and zero fuzzy matches.

**US-OV-019** — As a teammate on a fresh `git clone`, I want a stale or mismatched projection to be ignored safely, so that a projection from a different project or a corrupt file does not corrupt my Deep Lake. **Acceptance criteria:** (a) the daemon validates the projection's version, project triple, ULID syntax, and sha256 syntax on load; (b) a validation failure logs a warning, ignores the projection entirely, and falls back to full brooding; (c) the projection is never partially loaded.

**US-OV-020** — As a teammate on a fresh `git clone`, I want files not present in the projection to enter the normal re-association ladder, so that genuinely new or locally-modified files still get identity. **Acceptance criteria:** (a) on-disk content hashes absent from the projection index enter the re-association ladder; (b) the ladder's step 3 consults the projection's content-hash map as the "known nectars" set; (c) genuinely new files mint fresh nectars and enqueue enrichment.

---

## Reviewer surface

**US-OV-021** — As a reviewer reading `nectars.json`, I want the projection diff in a pull request to be reviewable, so that I can sanity-check that newly-described files have reasonable descriptions. **Acceptance criteria:** (a) a typical PR adds or modifies a handful of projection entries, each carrying the file's title, description, and concepts; (b) the projection changes at most once per enricher cycle (debounced, default 30 seconds); (c) the projection omits embeddings and the full version chain so the diff stays kilobytes, not megabytes.

**US-OV-022** — As a reviewer reading `nectars.json`, I want the projection to make the projection-vs-sidecar distinction enforceable, so that I can confirm the file is regenerable rather than a hidden source of truth. **Acceptance criteria:** (a) Deep Lake writes happen before the projection is regenerated; (b) `honeycomb hivenectar rebuild-projection` regenerates the file from Deep Lake alone; (c) the projection carries no state that Deep Lake does not have.

---

## Daemon integration and operation

**US-OV-023** — As a daemon operator, I want the Hivenectar daemon (`hiveantennae`) to be an independent workload process registered with hivedoctor and surfaced through thehive, so that it has an isolated failure domain, independent release cadence, and an always-on portal surface (per ADR-0002 and ADR-0003). **Acceptance criteria:** (a) the daemon runs as its own OS process under hivedoctor supervision, restartable independently of Honeycomb; (b) hivedoctor has a registry entry for Hivenectar with health URL, PID path, and probe settings; (c) Hivenectar obtains its own Deep Lake client pointed at the same org/workspace datasets Honeycomb recall reads, with `project_id` applied as a column filter; (d) enricher cycles log files described, inherited, failed, tokens consumed, and estimated cost for thehive to surface through Hivenectar's API.

**US-OV-024** — As a daemon operator, I want brooding and enrichment to not block daemon readiness, so that recall serves queries while background work proceeds. **Acceptance criteria:** (a) the daemon accepts requests before brooding completes; (b) a recall query during a brood sees whatever has been described so far; (c) undescribed files are simply absent from semantic results until the brood reaches them.

**US-OV-025** — As a daemon operator, I want brooding to be resumable after a crash, so that an interrupted brood does not restart from zero or leave inconsistent state. **Acceptance criteria:** (a) every mint and description write is a committed Deep Lake write; (b) on restart, files with `describe_status != 'pending'` are skipped, pending files are re-enqueued, and un-minted files are discovered fresh; (c) there is no "brood in progress" lockfile — state is fully derivable from `describe_status`.

**US-OV-026** — As a daemon operator, I want explicit control commands, so that I can trigger, cap, or rebuild the worker's work on demand. **Acceptance criteria:** (a) `honeycomb hivenectar brood` respects existing descriptions, `--force` re-describes everything, `--limit N` caps the cost, and `--dry-run` estimates without LLM calls; (b) `rebuild-projection` regenerates the lockfile from Deep Lake; (c) `prune --confirm` removes nectars whose latest path has been missing past the grace period (default 30 days).

**US-OV-027** — As a daemon operator, I want the worker to never mutate source files, so that the AGPL license header and contributor workflow are untouched. **Acceptance criteria:** (a) no file on disk other than `.honeycomb/nectars.json` is written by hiveantennae; (b) the only on-disk artifact is the regenerable projection; (c) the identity layer requires no git hooks that prepend content to source files.

---

## Out of scope (explicitly not a story)

These are deliberately excluded from the engineering scope and must not be implemented as if they were stories. They are restated as exclusions, not backlog items: replacing the CodeGraph; building an LSP; eager description of every file on mint; symbol-granular nectars (v2 possibility); directory-granular nectars (v1 omits, `kind` reserves the namespace); bidirectional projection sync; a separate SQLite store. The rationale for each exclusion is in [`overview-technical-specification.md`](overview-technical-specification.md) and [`../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md).
