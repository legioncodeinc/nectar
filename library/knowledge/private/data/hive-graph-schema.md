# Hive Graph Schema

> Category: Data | Version: 1.2 | Date: July 2026 | Status: Active

The canonical Deep Lake table catalog for Nectar: two tables (`hive_graph` for logical identity, `hive_graph_versions` for the append-only content+description chain), the column-by-column rationale, indexing strategy, tenancy model, and the lazy-schema-heal contract.

**Related:**
- [`../overview.md`](../overview.md)
- [`../ai/identity-and-reassociation.md`](../ai/identity-and-reassociation.md)
- [`../ai/enricher-and-llm-model.md`](../ai/enricher-and-llm-model.md)
- [`portable-registry.md`](portable-registry.md)
- [`recall-integration.md`](recall-integration.md)
- [`../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## Why two tables

A single table cannot cleanly represent the two things Nectar must track. A file's *identity* is stable — it survives edits, renames, and moves. A file's *content and description* change constantly — every save produces new bytes, and the description eventually drifts to match. Collapsing both into one row forces an overwrite on every edit (losing history) or an append on every edit (losing the stable-identity key under a pile of versions).

The split mirrors how git works internally: a commit object (stable identity anchor) points at a tree, which points at blobs (content-addressed versions). It also mirrors how Aura separates "identity anchor" from "content hash" (see `../reference/prior-art-crosswalk.md`), and how Mimir keeps a stable `SymbolId` distinct from its append-only rename history. The pattern is well-trodden because it is correct.

- **`hive_graph`** — one row per logical file. Keyed by nectar (ULID). Identity + provenance only. No content, no description.
- **`hive_graph_versions`** — append-only. Keyed by `(nectar, content_hash)`. One row per observed state. Carries the path, the metadata, and the lazily-filled description.

"Current state of file X" = the latest version row for X's nectar. "Full history of file X" = all version rows for X's nectar. Both are cheap queries.

---

## The `hive_graph` table (identity + provenance)

```sql
CREATE TABLE IF NOT EXISTS "hive_graph" (
  nectar              TEXT NOT NULL DEFAULT '',
  kind                TEXT NOT NULL DEFAULT 'file',
  created_at          TEXT NOT NULL DEFAULT '',
  derived_from_nectar TEXT NOT NULL DEFAULT '',
  fork_content_hash   TEXT NOT NULL DEFAULT '',
  org_id              TEXT NOT NULL DEFAULT '',
  workspace_id        TEXT NOT NULL DEFAULT '',
  project_id          TEXT NOT NULL DEFAULT '',
  last_update_date    TEXT NOT NULL DEFAULT ''
) USING deeplake;
```

| Column | Type | Purpose |
|---|---|---|
| `nectar` | TEXT | **Primary key.** 26-char ULID minted once by hiveantennae. Never changes. Never derived from content. Sortable by creation time. |
| `kind` | TEXT | Discriminator: `'file'` in v1. Reserved for `'directory'` if folder-level nectars are added later (see YAGNI note at the bottom). |
| `created_at` | TEXT | ISO 8601 timestamp of nectar minting. Equals the ULID's embedded timestamp but stored explicitly for portability into `nectars.json` (ULIDs are not self-describing to humans). |
| `derived_from_nectar` | TEXT | Copy-paste provenance. Empty for an originally-minted file. Set to the source nectar when a new path appears whose content matches an existing file's current content (the copy event). Survives forever, even after both files diverge. |
| `fork_content_hash` | TEXT | The content hash at the fork point. Lets the enricher render "this file was copied from X when X looked like Y" — useful for the Obsidian-style interlink view. |
| `org_id` | TEXT | Tenancy. Explicit because identity is cross-cutting (mirrors the `codebase` table's tenancy columns). |
| `workspace_id` | TEXT | Tenancy. Same rationale. |
| `project_id` | TEXT | Project isolation within a workspace. Soft column filter, not a Deep Lake partition or provisioning boundary. |
| `last_update_date` | TEXT | Denormalized "last observed change" timestamp. Updated whenever a new version row is appended. Lets the projection sync and the dashboard render "recently touched" without scanning the versions table. |

The `nectar` column is the only column that is truly immutable. `derived_from_nectar` and `fork_content_hash` are write-once (set at minting, never updated). Everything else is mutable but rarely changes after the row's first write.

---

## The `hive_graph_versions` table (content + description chain)

```sql
CREATE TABLE IF NOT EXISTS "hive_graph_versions" (
  nectar          TEXT NOT NULL DEFAULT '',
  content_hash    TEXT NOT NULL DEFAULT '',
  seq             BIGINT NOT NULL DEFAULT 0,
  path            TEXT NOT NULL DEFAULT '',
  filename        TEXT NOT NULL DEFAULT '',
  ext             TEXT NOT NULL DEFAULT '',
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  mtime_observed  TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  concepts        TEXT NOT NULL DEFAULT '[]',
  embedding       FLOAT4[],
  confidence      REAL,
  fingerprint     TEXT,
  described_at    TEXT NOT NULL DEFAULT '',
  describe_model  TEXT NOT NULL DEFAULT '',
  describe_status TEXT NOT NULL DEFAULT 'pending',
  observed_at     TEXT NOT NULL DEFAULT '',
  org_id          TEXT NOT NULL DEFAULT '',
  workspace_id    TEXT NOT NULL DEFAULT '',
  project_id      TEXT NOT NULL DEFAULT '',
  last_update_date TEXT NOT NULL DEFAULT ''
) USING deeplake;
```

| Column | Type | Purpose |
|---|---|---|
| `nectar` | TEXT | FK → `hive_graph.nectar`. Composite key part 1. |
| `content_hash` | TEXT | sha256 of file content at observation. Composite key part 2. **Changes per edit** — that is the point. |
| `seq` | BIGINT | Monotonic per-nectar version counter (0, 1, 2, …). Lets "latest version" be `ORDER BY seq DESC LIMIT 1` without parsing timestamps or relying on `content_hash` ordering. |
| `path` | TEXT | Repo-relative path with forward slashes, at observation time. **Mutable across version rows for the same nectar** — this is how moves are recorded. A nectar's `seq=0` row might say `src/a.ts` and its `seq=3` row might say `src/auth/a.ts`; the chain captures the rename. |
| `filename` | TEXT | Bare filename (`a.ts`). Denormalized from path for fast filename-only searches without path parsing. |
| `ext` | TEXT | Lowercased extension without dot (`ts`, `tsx`, `md`, `json`). Routed to the right CodeGraph extractor and to the brooding batcher (see brooding doc). |
| `size_bytes` | BIGINT | File size. Used to skip empty files and to bucket large files for solo-description. |
| `mtime_observed` | TEXT | File mtime at observation. Not authoritative (mtime is mutable), but useful as a fast-path cache key: if `(path, mtime, size)` all match the last observation, skip re-hashing. |
| `title` | TEXT | LLM-minted, ≤80 chars. Nullable until enriched. Empty string while pending, filled by the enricher. |
| `description` | TEXT | LLM-minted, 1–3 sentences. Nullable until enriched. Same lifecycle as `title`. |
| `concepts` | TEXT | JSON-encoded string array (`'["auth","session","jwt"]'`). LLM-minted concept tags for the Obsidian-style interlink layer. |
| `embedding` | FLOAT4[] | 768-dim vector over `title + ' ' + description`. **Same dimensionality as `sessions.message_embedding` and `memory.summary_embedding`** so the same hybrid recall pipeline queries all three. Nullable until enriched. |
| `confidence` | REAL | Set only on rows appended by re-association ladder step 4 (TLSH fuzzy match); the value is `1 − normalizedTLSHDistance`. NULL for all other rows. Supports the audit query "show me all auto-carried matches below a given confidence." |
| `fingerprint` | TEXT | TLSH-family locality-sensitive fingerprint of the content, computed on every content-bearing version row. Re-association ladder step 4 matches a moved-and-edited file against the fingerprints of missing files; persisting it here (rather than only in memory) is what lets cold-catch-up fuzzy matching survive a daemon restart. Nullable: rows written before this column existed leave it NULL and self-heal on next observation. |
| `described_at` | TEXT | Timestamp of the enricher run that filled `title`/`description`. Empty while pending. |
| `describe_model` | TEXT | Model identifier that produced the description (e.g. `gemini-2.5-flash` via `portkey`). Auditable, and lets a model swap trigger re-description selectively. |
| `describe_status` | TEXT | One of `pending`, `described`, `failed`, `skipped-too-large`, `skipped-binary`, `skipped-deleted`. Lets recall filter out undescribed rows and lets the enricher resume after failures. `skipped-deleted` marks a row whose file vanished while pending — distinct from `failed` (retryable LLM failure) so the enricher doesn't keep retrying a file that's gone. |
| `observed_at` | TEXT | Timestamp the version row was appended (distinct from `mtime_observed`, which is the file's own clock). |
| `org_id`, `workspace_id`, `project_id` | TEXT | Tenancy, denormalized from `hive_graph` so the versions table is queryable in isolation for recall. |
| `last_update_date` | TEXT | Standard Honeycomb UPDATE-coalescing workaround column. |

The composite key `(nectar, content_hash)` has a useful invariant: the same content under the same nectar is a no-op (idempotent re-observation after a no-change save). The same content under a *different* nectar is the copy-paste signal that sets `derived_from_nectar` on the newer nectar.

---

## Sequence allocation and latest-version resolution

"Latest version of a nectar" means the row with the highest `seq`, and `seq` must therefore be unique per nectar for that phrase to resolve unambiguously. Deeplake offers no transactions and no enforced unique constraint, so `seq` uniqueness is a property the daemon maintains in code, not one the backend guarantees. Two mechanisms in `DeepLakeHiveGraphStore` together keep it monotonic and collision-free.

The first is **per-nectar append serialization**: every seq-allocating append for a nectar is chained through one promise, so the allocate-and-append pair is atomic within the store instance and two callers sharing the store cannot both read the same `MAX(seq)` and both write `seq+1` (`src/hive-graph/deeplake-store.ts:272-281`).

The second is a **lag-immune in-process high-water mark**, added after a live incident. Renaming a watched file while its describe append was still in flight produced a duplicate `(nectar, seq)` pair: the enricher's durable describe append and the registration bridge's carry flush allocated seqs from independent views of the store (a backend `SELECT MAX(seq)` under read-after-write lag versus a private in-memory mirror), and Deeplake's read lag meant a just-appended row was invisible to the very next `SELECT seq`. The store now records the highest seq this process has written per nectar and allocates `max(inProcessHighWater, backendMax) + 1`, so the read is no longer trusted to reflect an append that already happened here (`src/hive-graph/deeplake-store.ts:282-298`, `src/hive-graph/deeplake-store.ts:459-478`). Every durable append funnels the written seq back into the high-water mark (`src/hive-graph/deeplake-store.ts:399-414`).

Both components now route every version append through one shared allocator, `appendVersionAtNextSeq`, the single seq authority the live daemon wires into the enricher commit and the registration bridge flush (`src/hive-graph/store.ts:159-170`). The bridge re-allocates the seq at flush time rather than trusting the seq its synchronous mirror computed, then reconciles the allocated value back into the mirror so later synchronous reads agree with what persisted (`src/registration/store-bridge.ts:190-215`).

### Healing an existing duplicate

The allocator prevents new duplicates; an idempotent repair heals any that already exist. Because the table is append-only (no in-place `UPDATE`, no unique constraint), the least-invasive correct repair for two rows tied at a nectar's `MAX(seq)` is to append a corrected copy of the winner one seq above the tie, making it the sole latest while the stale tied rows stay in history. The winner is the row with the newest `observed_at` (the most recently observed path or content, which is the renamed path after the incident), and its fields are copied verbatim so a pending carry stays pending and the enricher describes the newest path. The heal is idempotent: once the max seq is unique, a later pass finds nothing tied and does nothing (`src/registration/ladder.ts:551-591`). It runs from the crash-repair sweep and self-heals a live pre-fix duplicate on the next resync.

---

## Indexing strategy

Deep Lake indexing is additive and configured through the catalog helpers, not hand-rolled `CREATE INDEX`. The indexes Nectar relies on:

| Index | Table | Columns | Why |
|---|---|---|---|
| `deeplake_index` (BM25) | `hive_graph_versions` | `title`, `description` | Lexical recall over descriptions. Same operator Deep Lake applies to `memory.summary`. |
| Vector (`<#>` cosine) | `hive_graph_versions` | `embedding` | Semantic recall over descriptions. Falls back silently to BM25 if embeddings are off — same as the rest of Honeycomb, no quality cliff. |
| `deeplake_hybrid_record` | `hive_graph_versions` | BM25 + vector | The fused path recall prefers; documented in the main corpus's `ai/hybrid-sql-vector-rationale.md`. |
| Scope filter | `hive_graph_versions` | `org_id`, `workspace_id`, `project_id` | Every recall query scopes by tenancy before applying BM25/vector. |

The `path` and `filename` columns are covered by the standard ILIKE fallback (the same `sqlLike`-guarded lexical path that recall uses when vector indexes are absent or embeddings are off). No dedicated path index is needed in v1; the row counts (one per file version, not one per symbol) are small enough that ILIKE is adequate.

---

## Tenancy and isolation

Decision update from `library/requirements/MASTER-PRD-INDEX.md:13`: `project_id` is a soft column-level filter within Honeycomb's org/workspace Deep Lake scope. Nectar does not create per-project tables, per-project partitions, or a provisioning event when a project appears; catalog registration plus `withHeal` handles table creation and additive schema convergence on first write.

`hive_graph` and `hive_graph_versions` carry explicit `org_id`, `workspace_id`, and `project_id` columns. This mirrors the `codebase` table (the CodeGraph's cloud-sync target) and diverges from `sessions`/`memory`, which lean on partition isolation plus `agent_id`/`visibility`. The reason is that file identity is **cross-agent by nature** — every agent and every harness working in the same project should see the same file descriptions, so there is no `agent_id` column and no `visibility` column. Isolation is org→workspace at the Deep Lake scope plus a required `project_id` predicate for project-level filtering.

A team sharing a workspace (the normal Honeycomb collaboration model) therefore shares a single Nectar graph per project by filtering on `project_id`. A new teammate's `git clone` + `nectar daemon` boot (registered with doctor per ADR-0003) pulls the cloud-synced `hive_graph_versions` rows for the workspace and re-derives the local projection from them, the same way the CodeGraph's `pullSnapshot` works.

---

## Lazy schema healing

Decision update from `library/requirements/MASTER-PRD-INDEX.md:13`: there is no explicit DDL pre-step and no per-project provisioning flow. The Nectar catalog entries are registered with the daemon's catalog group, and `withHeal` creates or heals tables when the first write needs them.

Nectar tables participate in the same additive schema-heal pass as the rest of Honeycomb (documented in the main corpus's `data/deeplake-storage.md`). When hiveantennae writes through the catalog and finds a table missing, or finds an existing table missing a column added in a newer version (say `concepts` was added after initial deploy), `withHeal` creates or heals the table and backfills defaults. Existing rows get `'[]'` for `concepts`; the enricher picks them up on the next lazy pass.

Never hand-roll an `ALTER` against these tables. Define the `ColumnDef` array once in the daemon's schema module, add it to the catalog group, and let the heal pass converge. This is the same rule that governs every other Honeycomb table.

---

## The projection contract

`hive_graph_versions` is the source of truth. `.honeycomb/nectars.json` (documented in `portable-registry.md`) is a **regenerable projection** - a denormalized, content-hash-keyed map of `{ content_hash: { nectar, title, description, concepts } }` for the *latest* version of each nectar in the project. If `nectars.json` is deleted, lost, or corrupted, `nectar project --rebuild-projection` regenerates it from Deep Lake in a single scan. The projection is committed for portability across fresh clones, never because Deep Lake is insufficient.

---

## v1 non-goals (YAGNI)

The schema deliberately omits three things that the original design sketch mentioned, all deferred until measured need:

- **Directory nectars.** Folders are derivable from the union of file paths. A directory-level description can be synthesized on demand from its files' descriptions. The `kind` column reserves the namespace (`'directory'`) so this can be added later without a schema change, but v1 does not mint directory nectars. If synthesis reads weak in practice, add `kind='directory'` rows whose `content_hash` is `sha256(sorted_child_nectars)`.
- **Symbol-level nectars.** Symbol identity is the CodeGraph's job (and, optionally, an LSP layer's job). Nectar is file-granular in v1. Symbol-level semantic description would multiply row counts by 10–100× and duplicate what the CodeGraph already extracts structurally.
- **Edit-coalesced versioning.** Every save appends a version row. There is no debouncing at the schema level — debouncing happens at the watcher intake (see `ai/brooding-pipeline.md`), so the database sees one row per *meaningfully distinct* content state, not one per keystroke-save.
