# Hivenectar

![Status: Design](https://img.shields.io/badge/status-design-draft-orange)
![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)

> *A nectar is the minted identity record for a single file: small, stable, and the raw material from which richer understanding is produced.*

Hivenectar is a **semantic memory layer over a source tree**. It gives every file in a project a stable identity and a human-and-machine-readable description, then serves both back through the same hybrid search an agent already uses to recall conversations — so an agent can ask *"give me everything associated with logins"* and receive files scattered across directories that are not named `login-*`.

This repository is the **design and specification home** for Hivenectar. The documents here describe what Hivenectar is, why it is built the way it is, and the exact contract the implementation must meet. They are written README-first: the spec came before the code, and the code that lands later must conform to these pages rather than the other way around.

---

## The problem, in one paragraph

The structural CodeGraph already in Honeycomb answers *"who calls this function"*, *"what is the blast radius of changing this symbol"*, and *"walk me through this subsystem."* It does this by extracting AST facts — `function`, `class`, `calls`, `extends`, `imports` — with tree-sitter. It never consults an LLM, and that is deliberate: the graph is fast, deterministic, and reproducible byte-for-byte from the same source. But the CodeGraph cannot answer *"where is the login logic."* It can find a symbol named `login` or `authenticate`, but it has no concept of what those symbols *mean*, and no way to surface a file like `src/middleware/session-refresh.ts` (which implements a critical piece of login behavior) unless the agent already knows to look for it by name. **Structural identity is about *how code is wired*. Semantic identity is about *what code is for*.** Hivenectar provides the second without compromising the first.

---

## The three design pillars

### 1. Stable identity via a daemon-minted nectar, never embedded in source

Every file gets a **nectar**: a 26-character ULID minted once by the `hiveantennae` worker and persisted in Deep Lake. The nectar never lives inside the file. It survives edits (because it is not derived from content), renames and moves (because re-association follows the file on disk, not a comment marker), and copy-paste (because the copy gets a fresh nectar with a `derived_from` pointer back to the original).

The rejected alternative — embedding a serial number in a first-line comment of every source file — fails for four concrete reasons documented in [ADR-0001](library/knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md): it collides with the AGPL license header that owns line 1 of every file, it makes line 1 the most conflict-prone line in the repo under multi-author edits, it cannot represent files without a comment syntax (JSON, `.env`, lockfiles, binaries), and it converts copy-paste from a recoverable event into an ambiguous one (two files claiming the same serial). The short version: *identity is a daemon concept, not a file property.* A file on disk has no stable identity of its own — its path changes, its content changes, its inode changes. The only thing that persists is the fact that an observer once decided this is the same logical file it saw before. That decision is the nectar.

### 2. Lazy LLM description through a cheap long-context model

Files are described **on demand, not eagerly.** A nectar can exist for hours or days with a null description; the enricher fills it the first time recall might surface it, or on a debounced watch trigger after a meaningful edit. The model is **Gemini 2.5 Flash** routed through the existing Portkey gateway: ~$0.30 per million input tokens for the ≤200K tier and a true 1M-token context window, which lets the brooder batch 30–50 small files per call instead of one-per-call.

Long context is the load-bearing property here, not raw cheapness. A model with a 200K window (Haiku, Sonnet) can describe one large file or a few small ones per call; a model with a 1M window can describe an entire directory of small files in a single round-trip, collapsing the per-file cost by an order of magnitude. This is why Hivenectar specifies Gemini 2.5 Flash *specifically*, not "the cheapest available model." The full brooding pass on a 2000-file repository lands under $3, paid once; every subsequent clone of the same repo pays $0 if its projection is committed.

### 3. Durable state in Deep Lake, with a portable projection

All nectar records, version chains, descriptions, and embeddings live in **Deep Lake** — the same substrate as `sessions`, `memory`, `memories`, and the CodeGraph's `codebase` table. There is no SQLite sidecar, no JSONL log, no parallel store. Deep Lake is the source of truth, enforced by the same **FR-8** rule that governs the rest of Honeycomb: durable state goes in Deep Lake, not in sidecars.

A single committed, reviewable file — `.honeycomb/nectars.json` at the project root — is a **portable projection** of the Deep Lake table: a lockfile, not a sidecar. It is regenerated from Deep Lake on every successful brood or enrich. A fresh `git clone` re-derives identity by matching on-disk content hashes into this file before falling back to the full re-association ladder, so a new checkout inherits descriptions without re-paying the brooding cost.

---

## Why the identity decision is the spine of everything

The identity model is the most consequential and least reversible decision in the design: it determines the database schema, the re-association algorithm, the watcher contract, the fresh-clone story, and the team-share path. Get it wrong and you either corrupt history chains (a mis-association) or lose history entirely (an identity that churns). Three candidate models were weighed, each with real prior art, and each fails in a specific, concrete way under Honeycomb's constraints.

**Candidate A — source-embedded serial in a first-line comment** is the model the original sketch proposed. It has intuitive appeal: the identity is literally in the artifact, visible to humans, no database required to resolve "is this the same file." But it collides with the AGPL header that owns line 1, turns every file's first line into a tool-owned contention point, fails for JSON/`.env`/binaries that have no comment syntax, and — the killer — makes copy-paste *worse*: if file A carries `// nectar:N1` and a developer copy-pastes A to B, then B also carries N1, and the indexer now sees two files claiming the same serial. Source-embedded serials convert "git sometimes loses history on copy-paste" into "our own system has guaranteed duplicate-identity ambiguity."

**Candidate B — content hash as identity** is the model the largest family of code-indexing tools uses (Grove, Cartog, synrepo, the CodeRAG family). Content hash is globally unique without coordination and delta indexing falls out for free. But content hash *changes on every edit.* A file saved twice has two different identities, which means identity is not actually stable — it is path-as-identity moved one layer down (where "path" is now "content"). This fails the primary decision driver outright.

**Candidate C — daemon-minted ULID, never in the file (CHOSEN)** is what Hivenectar adopts. A 26-character ULID, minted once, persisted in Deep Lake as the primary key, re-associated to the file on disk by a ladder of exact-match (path/mtime/size, then content hash) and fuzzy-match (TLSH) heuristics. It wins on every driver: stable across edits (not content-derived), stable across moves and renames (re-association follows disk, not a marker), recovers copy-paste as a *first-class provenance edge* (`derived_from_nectar`), never mutates source, applies universally to every file type, satisfies FR-8, and inherits across clones via the committed projection. The cost is real engineering — the re-association ladder, specifically the fuzzy TLSH step, has a confidence-scored review surface — but that cost is paid because every alternative has worse problems. The full decision, alternatives, and reversibility analysis are recorded in [ADR-0001](library/knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md). **Read it before arguing about serials-in-source.**

---

## The data model, in one paragraph

Two tables. `source_graph` is one row per logical file, keyed by nectar (ULID primary key), carrying creation time, optional provenance (`derived_from_nectar`, `fork_content_hash`), and a `kind` discriminator reserved for future directory support. `source_graph_versions` is append-only, one row per observed state of a file, keyed by `(nectar, content_hash)`: it carries the current path, extension, size, mtime, and the LLM-minted `title`, `description`, `embedding`, and `concepts` (filled lazily, nullable until the enricher runs). *"Current state of file X"* is the latest version row for its nectar. *"History of file X"* is all its version rows. The split mirrors how git works internally — a commit object (stable identity anchor) points at a tree, which points at blobs (content-addressed versions) — and mirrors how Aura separates "identity anchor" from "content hash." A single table cannot cleanly represent both: collapsing them forces an overwrite on every edit (losing history) or an append on every edit (losing the stable-identity key under a pile of versions). The full column-by-column DDL and rationale live in the [source-graph schema](library/knowledge/private/data/source-graph-schema.md).

---

## The hiveantennae worker

`hiveantennae` is a background worker inside the Honeycomb daemon, parallel to the existing codebase-graph worker. It is not a separate process — it shares the daemon's Deep Lake client, auth, scoping, and observability — and it is not a phase of the graph worker: the graph worker is build-triggered and on-demand, while hiveantennae is watch-driven and continuous. The worker has four operating modes:

| Mode | Trigger | What it does |
|---|---|---|
| **Brooding** | First run, or fresh checkout with no `nectars.json` | Full scan, batched description, initial projection write |
| **Live watch** | chokidar event during normal editing | Re-associate, append version, enqueue lazy enrich |
| **Cold catch-up** | Daemon boot after offline changes | Walk disk, run re-association ladder, batch-enrich drift |
| **Projection sync** | End of brood/enrich/catch-up | Regenerate `.honeycomb/nectars.json` from Deep Lake |

### The re-association ladder

The hardest problem in Hivenectar is cold catch-up: the daemon boots after the laptop was closed, the user moved and edited a dozen files offline, and now disk does not match Deep Lake. The daemon must look at each file on disk and decide *which existing nectar (if any) it is*, or mint a new one. This is the re-association ladder, evaluated top-down per file — first match wins.

1. **`(path, mtime, size)` exact match.** The fast path. If a file at a known path has the same mtime and size as the last observation, treat it as unchanged without reading or hashing content. This is the same optimization rsync uses and covers the vast majority of files on a typical boot.
2. **Path match, content changed.** The path exists under some nectar, but the content hash differs. A normal edit: append a new version row, enqueue lazy enrich. The nectar is unchanged; the history chain is append-only.
3. **Exact content-hash match to a missing file.** The move detector. A new path whose content hash exactly matches a missing file's *latest* version hash → the file was moved or renamed without modification. Carry the nectar, record the new path, no enrich needed. Cryptographically high-confidence.
4. **Fuzzy content match (TLSH) to a missing file.** The hard case: the file was moved *and* edited offline. Compute a TLSH fingerprint, compare against missing files' fingerprints, score the distance. Matches above a confidence threshold carry the nectar and flag confidence; **matches below the threshold are surfaced for human review, never auto-claimed**, because a mis-association is worse than a new nectar — it corrupts the history chain.
5. **Nothing matches.** Mint a fresh nectar.

During live operation, the chokidar watcher sees moves in real time (a `delete` on path A immediately followed by an `add` on path B with identical content), so step 3 handles it directly and step 4 is rarely reached. Step 4 exists for the case where the daemon was not running when the move-and-edit happened. A nectar, once minted, is **never deleted** by the ladder and **never reused**: orphaned nectars (the file was genuinely deleted) remain in Deep Lake as history, pruned only by an explicit, conservative, human-triggered `prune --confirm` after a 30-day grace period. This append-only-ish behavior is what makes the history chain trustworthy. The full algorithm is in [identity-and-reassociation.md](library/knowledge/private/ai/identity-and-reassociation.md).

### Copy-paste as a first-class provenance edge

Copy-paste is the case that source-embedded serials handle worst and that minted identity handles best. File A exists with nectar N1 and current content hash H1. The user copies A to a new path B. The watcher fires an `add` event for B; B has no nectar; B's content is H1 (identical to A's). The daemon mints B a **fresh nectar N2** and sets `derived_from_nectar = N1` and `fork_content_hash = H1`. B is its own identity, and it is permanently linked to A. When B is later edited and diverges from A, the link survives — the Obsidian-style interlink view can render "B was forked from A at `<time>`" indefinitely. This is the inverse of what content-hash-only identity produces: with pure content hashing, A and B were indistinguishable at copy time, and the moment B was edited, all trace of the A→B relationship was lost. The full pipeline is in [brooding-pipeline.md](library/knowledge/private/ai/brooding-pipeline.md); the steady-state enricher loop is in [enricher-and-llm-model.md](library/knowledge/private/ai/enricher-and-llm-model.md).

---

## How recall uses it

Hivenectar plugs into the existing hybrid recall pipeline (BM25 lexical + 768-dim vector, fused by reciprocal rank). The recall query adds a `UNION ALL` arm over `source_graph_versions` — filtered to the latest version per nectar where `describe_status = 'described'`, scoped by `org_id`/`workspace_id`/`project_id` — weighted to contribute alongside session, memory, and skill hits. An agent query like *"everything associated with logins"* now returns both structural hits (the CodeGraph's `find/authenticate`) and semantic hits (the `session-refresh.ts` middleware described as *"refreshes JWT claims on each authenticated request, part of the login session lifecycle"*).

The two layers are **independent and complementary.** A file can be in the CodeGraph without a nectar (it has structure but no description yet). A file can have a nectar without being in the CodeGraph (a config file, a markdown doc, a `.env.example` — anything with meaning but no AST). Recall unions over both: structural hits tell the agent *how to navigate*; semantic hits tell the agent *what to look at in the first place.* If embeddings are off (the optional dependency was not installed), the embedding is left NULL and recall silently falls back to BM25 over `title` and `description` — no error, no quality cliff, the same graceful degradation the rest of Honeycomb's recall already exhibits. The wiring is in [recall-integration.md](library/knowledge/private/data/recall-integration.md).

---

## The portable projection

Deep Lake is the source of truth, but Deep Lake is not in the git repo. A fresh `git clone` has the source files and no nectars — until either the daemon boots and pulls the workspace's rows from Deep Lake cloud sync (requires network and auth), or broods from scratch (re-pays the LLM cost). The portable registry is a third option: `.honeycomb/nectars.json` carries enough of the Deep Lake state to re-derive identity on a fresh clone *without* network, auth, or LLM calls.

The registry is a **projection, not a sidecar**, and the distinction is enforced:

- A **sidecar** is a parallel source of truth the system reads from and writes to during normal operation. Sidecars drift, get out of sync, and become liabilities. FR-8 forbids them.
- A **projection** is a denormalized, regenerable view of the source of truth, written from the source of truth on a defined schedule, never edited directly, deletable and regenerable without loss. A lockfile (`package-lock.json`, `Cargo.lock`) is a projection; an `.env` is a sidecar.

Three rules keep `.honeycomb/nectars.json` on the right side of that line. First, **Deep Lake writes happen first** — every mint, version append, and description write goes to Deep Lake before the projection is regenerated. Second, **the projection is never edited by hand or by external tools** — a hand-edit is overwritten on the next regeneration. Third, **the projection is regenerable from Deep Lake alone** — `honeycomb hivenectar rebuild-projection` produces a byte-identical file (modulo `generated_at`) from a single Deep Lake scan, with no other inputs. If it did not, the projection would be carrying state Deep Lake does not have, which would make it a sidecar. A fresh clone with a current projection typically achieves **zero LLM calls and zero fuzzy matches**: every file's content hash matches the projection, every nectar is inherited, every description is carried over. The mechanics are in [portable-registry.md](library/knowledge/private/data/portable-registry.md).

---

## Where Hivenectar sits in the field

Hivenectar is not the first system to give files stable identity, nor the first to describe code with an LLM, nor the first to index a codebase semantically. Each of the three pillars has well-trodden prior art, and the design docs are honest about what is borrowed.

| Pillar | Closest prior art | What Hivenectar borrows | Where it diverges |
|---|---|---|---|
| **Stable identity** | Aura (identity anchor + content hash), Mimir (Roslyn-style `SymbolId`) | Two-table identity+version split; minted identity as a first-class operation; explicit non-reuse of IDs | Aura and Mimir are symbol/function-granular and content-derived at minting; Hivenectar is file-granular with a pure minted ULID |
| **LLM description** | Smith (Hash vs. Described-Against-Hash), codeindex (two-phase AI) | Lazy description with staleness tracking; committed description cache for team inheritance; batch economics | Smith has no stable identity and mutates source via `.meta` sidecars; Hivenectar never mutates source and persists to Deep Lake |
| **Delta indexing** | Grove, Cartog, synrepo (content-hash trees) | `(path, mtime, size)` fast-path; delta skip of unchanged files | These tools *are* content-hash identity, which Hivenectar rejects as the identity key while keeping it as the version key |
| **Semantic store** | CodeRAG (LanceDB), Codebase Cortex (FAISS), Grove (SQLite) | Per-file semantic recall | AST-chunk tools produce 10–100× more embeddings and couple to tree-sitter parse quality; Hivenectar is file-granular and composes with the existing CodeGraph instead of duplicating it |

What is genuinely novel is not any single pillar but the **specific composition**: daemon-minted identity (not content-derived, not source-embedded) + LLM-minted per-file description (not AST chunking) + Deep Lake as the durable store (not SQLite, not LanceDB, not a sidecar) + integration into an existing hybrid recall pipeline that already serves session and skill memory + a portable projection as a committed lockfile for fresh-clone inheritance. No single prior system combines all five. The closest is Smith, which covers the description pillar and the committed-cache pillar partially but lacks minted identity, Deep Lake persistence, and union-recall integration entirely. The honest claim is narrower than "first codebase semantic search" — it is *"the first system to combine daemon-minted file identity, LLM file description, Deep Lake persistence, and union-recall with conversation memory, in a single daemon that already serves a multi-harness AI coding memory system."* The full survey, with sources, is in the [prior-art crosswalk](library/knowledge/private/reference/prior-art-crosswalk.md).

---

## What Hivenectar is *not*

- **Not a replacement for the CodeGraph.** The CodeGraph answers structural questions deterministically; Hivenectar answers semantic questions probabilistically. Both ship.
- **Not an LSP.** `hiveantennae` does not resolve types, run compilers, or produce compiler-accurate references. The structural CodeGraph and any future LSP layer own that.
- **Not eager.** A file can exist in Deep Lake with a null description for as long as nobody asks about it. Description is a cache, not a prerequisite.
- **Not a source mutation.** No file on disk is ever edited by `hiveantennae`. The only file it writes is the committed `.honeycomb/nectars.json` projection, and even that is regenerable.
- **Not a separate database.** Deep Lake is the store. The "SQLite would be faster" instinct is addressed and rejected in ADR-0001.

---

## Reading guide

The documents in [`library/knowledge/private/`](library/knowledge/private/) are the specification. Start with the [overview](library/knowledge/private/overview.md), then follow the reading order that matches what you are doing:

- **New to Hivenectar:** [overview](library/knowledge/private/overview.md) → [source-graph-schema](library/knowledge/private/data/source-graph-schema.md) → [identity-and-reassociation](library/knowledge/private/ai/identity-and-reassociation.md)
- **Understanding the identity decision:** [ADR-0001](library/knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md) *(read before arguing about serials-in-source)*
- **Implementing the worker:** [brooding-pipeline](library/knowledge/private/ai/brooding-pipeline.md), [enricher-and-llm-model](library/knowledge/private/ai/enricher-and-llm-model.md), [identity-and-reassociation](library/knowledge/private/ai/identity-and-reassociation.md)
- **Integrating with recall:** [recall-integration](library/knowledge/private/data/recall-integration.md)
- **The portable projection and fresh-clone story:** [portable-registry](library/knowledge/private/data/portable-registry.md)
- **How this compares to existing tools:** [prior-art-crosswalk](library/knowledge/private/reference/prior-art-crosswalk.md)
- **The documentation conventions every doc in this repo must follow:** [documentation-framework](library/knowledge/private/standards/documentation-framework.md)

---

## Status

This repository contains the design specification only. The implementation target is the Honeycomb daemon (a sibling repository); the documents here are written to be the contract that implementation conforms to, README-first. Until implementation lands, badges for CI, version, and downloads do not exist and would be misleading if added — they will appear when there is something to build, release, and download.

## Contributing

This is the specification surface. Edits to the design docs should preserve the universal header convention (`Category | Version | Date | Status`), relative-path cross-links, and Mermaid-only diagrams documented in the [documentation framework](library/knowledge/private/standards/documentation-framework.md). The load-bearing decisions recorded in ADR-0001 and the data/AI docs were chosen over documented alternatives — read the relevant doc before proposing a change that contradicts one.

## License

Hivenectar is licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](LICENSE.md)). Use it commercially or privately, free of charge; keep the copyright and license notices intact, and if you modify it, your changes ship under the same AGPL license with source available. The "Affero" clause is the point: run a modified version as a network service and you owe its source to the users who interact with it.

Copyright © 2026 Mario Aldayuz.
