# ADR-0001, Identity model: daemon-minted ULID nectar over source-embedded serial or content-hash-only

> **Status:** Accepted · **Date:** 2026-06-30
> **Supersedes:** none · **Superseded by:** none
> **Owners:** hivenectar, daemon, storage
> **Related:** Hivenectar overview, `data/source-graph-schema.md`, `ai/identity-and-reassociation.md`, `reference/prior-art-crosswalk.md`

## Context

Hivenectar gives every file in a project a stable identity that survives edits, renames, moves, and copy-paste, so that an LLM-minted title and description can follow the file around indefinitely instead of being lost the moment the file moves. The identity model is the most consequential and least reversible decision in the design: it determines the database schema, the re-association algorithm, the watcher contract, the fresh-clone story, and the team-share path. Getting it wrong means either corrupting history chains (a mis-association) or losing history entirely (an identity that churns).

Three candidate identity models were on the table. Each has real prior art (see `reference/prior-art-crosswalk.md`), and each fails in a specific, concrete way under Honeycomb's constraints.

### Candidate A: source-embedded serial in a first-line comment

Every source file gets a serial number embedded in a first-line comment (`// nectar:01J...` or `# nectar:01J...`). A git hook mints the serial on pre-commit for any new file. The serial lives in the file and travels with it through git operations.

This is the model the original Hivenectar sketch proposed. It has intuitive appeal: the identity is literally in the artifact, visible to humans, no separate database required to resolve "is this the same file."

### Candidate B: content hash as identity

Every file's identity is `sha256(content)`. Same content → same identity, globally, without coordination. This is the model the largest family of code-indexing tools uses (Grove, Cartog, synrepo, CodeRAG family; see prior-art crosswalk).

### Candidate C: daemon-minted ULID, never in the file (CHOSEN)

The hiveantennae worker mints a 26-character ULID once per logical file and stores it in Deep Lake as the primary key of `source_graph`. The ULID never lives in the file. Re-association to the file on disk is performed by a ladder of exact-match (path/mtime/size, then content hash) and fuzzy-match (TLSH) heuristics at daemon boot and on watcher events.

## Decision drivers

- **Stability across edits.** Identity must not change when content changes. This is the whole point of "stable identity" — if it churns per save, it is just path-as-identity moved one layer down.
- **Stability across moves and renames.** Identity must survive `git mv`, IDE refactor-rename, and OS-level move. Path-keyed identity fails this; content-derived identity survives it only if content is unchanged across the move.
- **Recovery from copy-paste.** Identity must make copy-paste a *first-class provenance edge* (B was forked from A), not a history-loss event (A and B are now indistinguishable) or an ambiguity (A and B both claim the same serial).
- **No source mutation.** Honeycomb's license header (`docs/license-header.txt`) owns line 1 of every source file per `AGENTS.md`. A tool that mutates source on a git hook is a hard sell to contributors and an invasive brood on first run.
- **Universal applicability.** Identity must cover JSON, `.env`, YAML, TOML, lockfiles, and (for skip purposes) binaries — not just source files with a comment syntax.
- **Deep Lake as the only durable store.** FR-8 in the main Honeycomb PRD substrate forbids JSON/JSONL sidecars and parallel stores. The identity table goes in Deep Lake.
- **Fresh-clone portability.** A new `git clone` should inherit identity without re-paying the brooding cost or requiring network access to Deep Lake.

## Considered options

### Option A, Source-embedded serial in first-line comment (REJECTED)

**The appeal.** The serial is in the artifact. Humans can see it. No database is required to answer "is this the same file." A fresh clone has the serials immediately, with zero bootstrapping.

**Why it is rejected.** Four concrete failures, any one of which is disqualifying.

1. **It collides with the AGPL license header on line 1.** `AGENTS.md` is explicit: *"every new source file gets the [AGPL] header in `docs/license-header.txt`."* That header occupies line 1. Where does the nectar go — before the license (legally wrong; the license should be the first thing a reader or license-scanner sees) or after (so it is no longer "the first line," breaking the contract the model depends on)? This is not a theoretical collision. It is a collision with a rule already in force in this specific repository today.

2. **Line 1 is the highest-conflict line in any file.** A tool that owns line 1 and mutates it on every file creation induces merge conflicts on the single line most likely to be touched by humans and tools alike. Anyone who has tried to keep a `// @formatter:off`, a shebang, or a `// @ts-nocheck` stable across a multi-author team knows this. Source-embedded serials turn every file's first line into a tool-owned contention point.

3. **It does not solve copy-paste — it makes it worse.** This is the killer. If file A has `// nectar:N1` and a developer copy-pastes A to B, then B *also* has `N1`. Now the indexer sees two files claiming the same serial. Either it splits them (and B loses its connection to A's history — defeating the "preserve history through copy-paste" goal that motivated the model), or it keeps one record and identity is now ambiguous. Content-hash identity has the *opposite* property (identical files naturally share a hash; divergence is detectable). Source-embedded serials convert "git sometimes loses history on copy-paste" into "our own system has guaranteed duplicate-identity ambiguity."

4. **Comment syntax is not universal.** JSON has no comments. `.env` has no comments. Lockfiles and TOML have their own conventions. YAML comments do not survive all round-trips. Binary files have no first line to claim. Either source-embedded serials cover only some files (a half-indexed codebase is a liability, not an asset), or they require a sidecar-per-file scheme (which is the sidecar model, rejected separately below).

**Prior art.** No surveyed system uses source-embedded identity for exactly these reasons. Smith (the closest) embeds *descriptions* in source (`CLAUDE.md`, `constitution.md`) but keys identity by path, accepting that moves lose descriptions. Aura, Mimir, Orbit, Grove, Cartog, and synrepo all keep identity out of the source.

**The brooding-mega-commit problem.** First-pass minting prepends a line to thousands of files. On any existing codebase, brooding produces a single invasive commit that touches every file. Code reviewers will (correctly) reject it. Option C's brooding writes to Deep Lake and a single projection file; the source tree is untouched.

### Option B, Content hash as identity (REJECTED)

**The appeal.** Content hash is globally unique without coordination (two independent indexers produce the same hash for the same content). Delta indexing falls out for free (skip unchanged files). The pattern is extremely well-trodden (Git's object model, Grove, Cartog, synrepo).

**Why it is rejected.** Content hash changes on every edit. A file saved twice has two different identities, which means identity is not actually stable — it is path-as-identity moved one layer down (where "path" is now "content"). This fails the primary decision driver.

The Aura project documents this exact failure and the fix: *"Aura combines body hash (for rename-proofing and dedup) with a persistent identity anchor (for history continuity across edits). Neither alone is enough."* Content hash alone is the rejected half of Aura's model. Hivenectar's Option C is the other half (a persistent identity anchor) plus a content hash as the version key — the same synthesis Aura arrived at, at file granularity.

**What content hash is good for.** Content hash is not useless — it is the correct *secondary* attribute. It is the version key in `source_graph_versions`. It is the delta-indexing fast path. It is the copy-event detector (a new path with a content hash matching an existing file's current content is a copy). Option C uses content hash for all of these; Option B is rejected only as the *identity* key.

### Option C, Daemon-minted ULID, never in the file (CHOSEN)

**The model.** A 26-character ULID, minted once by the hiveantennae worker, persisted in Deep Lake as the primary key of `source_graph`. Never written into the file. Re-associated to the file on disk by the ladder documented in `ai/identity-and-reassociation.md`.

**Why it wins on every decision driver.**

- **Stability across edits.** The ULID is not derived from content, so it does not change when content changes. Edits append a version row keyed by the new content hash; the nectar is unchanged.
- **Stability across moves and renames.** The re-association ladder's step 3 (exact content-hash match to a missing file) carries the nectar across moves. Step 4 (fuzzy TLSH match) handles move-and-edit. The nectar follows the file because the daemon observes disk, not because a marker travels with the file.
- **Recovery from copy-paste as provenance.** When a new path's content hash matches an existing file's current content, the daemon mints a *fresh* ULID for the new path and sets `derived_from_nectar` pointing at the source. The copy is its own identity, permanently linked to its origin. This is the property Option A could not provide. With pure content hash (Option B), A and B were indistinguishable at copy time and the relationship was lost on B's first edit. With minted identity + `derived_from`, the relationship survives forever.
- **No source mutation.** hiveantennae never writes to source files. The only file it writes is `.honeycomb/nectars.json`, a regenerable projection, and even that is reviewable and committed. The AGPL license header is untouched.
- **Universal applicability.** The daemon observes every file on disk regardless of whether it has a comment syntax. Binary files get nectars with `describe_status = 'skipped-binary'`. JSON, `.env`, lockfiles all get nectars. The identity layer is universal; the description layer is best-effort.
- **Deep Lake as the only durable store.** The nectar table is a Deep Lake table. No SQLite sidecar, no JSONL log, no parallel store. FR-8 is satisfied.
- **Fresh-clone portability.** The committed `.honeycomb/nectars.json` projection carries the content-hash→nectar map. A fresh clone matches on-disk files into the projection before falling back to the re-association ladder. A current projection typically achieves zero LLM calls and zero fuzzy matches on clone.

**The costs of Option C (acknowledged).**

- **The re-association ladder is real engineering.** Steps 1–3 are exact and easy. Step 4 (TLSH fuzzy match) requires a TLSH implementation (native addon or WASM), size-bucketing for performance on large repos, and a confidence-scored review path for low-confidence matches. Option A and B do not need this. The cost is paid because the alternative (source-embedded identity) has worse problems.
- **Cold catch-up after offline changes is the hard case.** During live operation, the chokidar watcher carries move semantics and step 3 handles it. Cold catch-up (daemon was down while files were moved and edited) relies on steps 3 and 4. This is acceptable because cold catch-up is rare and the ladder is conservative (low-confidence matches are surfaced for review, not auto-claimed).
- **Identity does not survive a fresh clone without the projection.** Without `.honeycomb/nectars.json`, a fresh clone must brood from scratch, minting new nectars with no connection to the original. This is why the projection is committed by default.

### Option D, SQLite sidecar (REJECTED, separately)

The original sketch proposed "serialize them in an sqlite db (that would be fastest)." This is rejected as a separate option, independent of the identity-key choice, because it violates FR-8: *"Durable state goes in Deep Lake, not JSON/JSONL sidecars."* A parallel SQLite store for code identity will drift from Deep Lake, get out of sync with the daemon, and become a second source of truth that `npm run dup` cannot see.

A *cache* (the regenerable `(path → mtime → last_hash)` map the daemon keeps to avoid re-hashing on poll) is acceptable, because it is not a source of truth and can be deleted without loss. The nectar table itself is in Deep Lake. The projection lockfile is regenerable from Deep Lake. No sidecar.

## Decision

Adopt **Option C**: daemon-minted ULID nectar, persisted in Deep Lake, re-associated by the exact-then-fuzzy ladder, with a committed regenerable projection for fresh-clone inheritance. The full algorithm is documented in `ai/identity-and-reassociation.md`; the schema is in `data/source-graph-schema.md`; the projection is in `data/portable-registry.md`.

The nectar format is **ULID** (26-char, Crockford base32, uppercase, timestamp-sortable). The format decision is recorded separately from the identity-model decision because the format is reversible (a future migration could re-encode nectars) while the model is not (once source files are mutated or content hashes are baked in, unmutating is expensive).

## Consequences

**Positive.**

- Stable identity across edits, moves, renames, and copy-paste, with copy-paste captured as first-class provenance.
- No source mutation. The AGPL header and contributor workflow are untouched.
- Universal applicability across file types, including those without comment syntax.
- Deep Lake remains the only durable store. FR-8 is satisfied.
- Fresh clones inherit identity via the committed projection without LLM cost or network.
- Composition with the existing Honeycomb CodeGraph, recall pipeline, daemon lifecycle, auth, and observability — all reused.

**Negative.**

- The re-association ladder (specifically the TLSH fuzzy step) is real engineering and has a confidence-scored review surface.
- Cold catch-up after offline changes is the hard case and may surface low-confidence matches for human review.
- Identity does not survive a fresh clone without the committed projection (mitigated by committing the projection by default).
- The TLSH comparison is O(N × M) in the worst case and needs size-bucketing (or a future minhash LSH pre-filter) for monorepo-scale cold boots.

**Reversibility.** The decision is largely reversible at the data-model level (the schema could be migrated to a different identity scheme) but irreversible at the operational level (once nectars are minted and descriptions are written, re-brooding under a different identity model is expensive). This is the irreversibility that warrants an ADR.

## Alternatives considered and rejected, in one sentence each

- **Source-embedded serial (Option A):** rejected for AGPL-header collision, line-1 conflict, copy-paste ambiguity, and comment-syntax non-universality.
- **Content hash as identity (Option B):** rejected because it churns per edit and therefore is not actually stable — it is path-as-identity one layer down.
- **SQLite sidecar (Option D):** rejected for FR-8 violation; Deep Lake is the only durable store.
- **xattrs / NTFS alternate data streams:** rejected because tooling is miserable on Windows, git strips them, and cross-filesystem copy loses them.
- **Path-as-identity (the implicit default):** rejected because paths change on every rename and move, which is the failure mode stable identity exists to solve.
- **Symbol-granular identity (Aura/Mimir at function level):** deferred to v2. v1 is file-granular; symbol-level nectars would multiply row counts 10–100× and duplicate the structural CodeGraph.

## References

- `ai/identity-and-reassociation.md` — the full re-association ladder algorithm.
- `data/source-graph-schema.md` — the `source_graph` and `source_graph_versions` DDL.
- `data/portable-registry.md` — the committed projection that makes fresh-clone inheritance work.
- `reference/prior-art-crosswalk.md` — Aura, Mimir, Orbit, Grove, Cartog, Smith surveyed.
- Aura's "identity anchor + content hash" model (https://docs.auravcs.com/function-level-identity/) is the clearest intellectual predecessor for the two-table identity+version split.
- Mimir's "identity is explicit, not heuristic" principle (https://github.com/buildepshit/Mimir) is the philosophical basis for minted over derived identity.
- Main Honeycomb corpus `AGENTS.md` — FR-8, license-header rule, daemon-as-only-storage-client rule.
