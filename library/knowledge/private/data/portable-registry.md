# Portable Registry (nectars.json)

> Category: Data | Version: 1.2 | Date: July 2026 | Status: Draft

The committed, reviewable, regenerable projection of the Deep Lake `hive_graph` table that gives a fresh `git clone` its identity map before the daemon ever runs: what it contains, what it deliberately omits, how it differs from a sidecar, how it is generated and validated, and how it interacts with team sharing.

**Related:**
- [`../overview.md`](../overview.md)
- [`hive-graph-schema.md`](hive-graph-schema.md)
- [`recall-integration.md`](recall-integration.md)
- [`../ai/identity-and-reassociation.md`](../ai/identity-and-reassociation.md)
- [`../ai/brooding-pipeline.md`](../ai/brooding-pipeline.md)
- [`../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## What the portable registry is for

Deep Lake is the source of truth for Nectar, but Deep Lake is not in the git repo. A fresh `git clone` has the source files and no nectars — until either (a) the daemon boots and pulls the workspace's rows from Deep Lake cloud sync, or (b) the daemon boots and broods from scratch, re-paying the LLM cost. Option (a) requires network and auth; option (b) wastes money and time.

The portable registry is a third option. `.honeycomb/nectars.json` is a single committed file at the project root that carries enough of the Deep Lake state to re-derive identity on a fresh clone *without* network, auth, or LLM calls. It is the bridge between "the source of truth is in the cloud" and "a clone should work offline immediately."

The registry is a **projection**, not a sidecar. The distinction matters and is enforced:

- A **sidecar** is a parallel source of truth that the system reads from and writes to during normal operation. Sidecars drift, get out of sync, and become liabilities. FR-8 in the main Honeycomb PRD substrate explicitly forbids them.
- A **projection** is a denormalized, regenerable view of the source of truth. It is written from the source of truth on a defined schedule, never edited directly, and can be deleted and regenerated without loss. A lockfile (`package-lock.json`, `Cargo.lock`) is a projection; an `.env` is a sidecar.

`.honeycomb/nectars.json` is generated from Deep Lake at the end of every brood and every enricher cycle that produced new descriptions. It is committed for portability. It is never the system of record.

---

## The file format

```json
{
  "version": 1,
  "generated_at": "2026-06-30T12:00:00Z",
  "generator": "honeycomb-nectar@0.1.13",
  "project": {
    "org_id": "legion",
    "workspace_id": "engineering",
    "project_id": "honeycomb"
  },
  "files": {
    "01J2X4F6K8ME7N9P1Q3R5T7V9WX": {
      "content_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "path": "src/auth/login.ts",
      "title": "User login route handler",
      "description": "Validates credentials against the user store, starts a session, and issues a JWT refresh token. Entry point for the /login API.",
      "concepts": ["auth", "login", "session", "jwt"],
      "describe_model": "gemini-2.5-flash",
      "described_at": "2026-06-29T14:30:00Z"
    },
    "01J2X4F6K8ME7N9P1Q3R5T7V9WY": {
      "content_hash": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "path": "src/middleware/session-refresh.ts",
      "title": "JWT session refresh middleware",
      "description": "Refreshes JWT claims on each authenticated request. Part of the login session lifecycle.",
      "concepts": ["auth", "session", "jwt", "middleware"],
      "describe_model": "gemini-2.5-flash",
      "described_at": "2026-06-29T14:30:05Z"
    }
  },
  "derived": {
    "01J2X4F6K8ME7N9P1Q3R5T7V9WY": {
      "from_nectar": "01J2X4F6K8ME7N9P1Q3R5T7V9WX",
      "fork_content_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    }
  }
}
```

### What it contains

- **`version`** — schema version of the projection format. Bumped on incompatible changes; old daemon versions refuse to load a higher version and fall back to full brooding.
- **`generated_at`** — when the projection was last regenerated. Lets a clone detect staleness ("this projection is 3 weeks old; the daemon should verify against Deep Lake when it gets network").
- **`generator`** — the daemon version that produced the file. Auditable.
- **`project`** — the tenancy triple. A clone in a different project context refuses to load a mismatched projection.
- **`files`** — the main payload. Keyed by nectar (ULID). Each entry carries the latest described version's content hash, path, title, description, concepts, and provenance metadata. This is exactly the data recall needs.
- **`derived`** — the copy-paste provenance map. Keyed by the derived nectar, pointing at the source nectar and fork content hash. Separated from `files` so the file map stays flat for content-hash lookups.

### What it deliberately omits

- **The full version chain.** Only the latest described version per nectar is included. Historical versions stay in Deep Lake. Including them would bloat the file and serve no recall purpose.
- **Embeddings.** The 768-dim vectors are not in the projection. They are regenerable from `title + description` via the configured embedding provider, and including them would make the file megabytes instead of kilobytes. A fresh clone recomputes embeddings on first daemon boot when a provider is available (or skips them when embeddings are unavailable).
- **Undescribed files.** A nectar minted but never described (brooding was interrupted, or the file was skipped as binary) appears with a minimal entry (`path`, `content_hash`, but empty `title`/`description`) so identity is preserved, but recall will not surface it until described.
- **Internal IDs.** No Deep Lake row IDs, no internal indices. The projection is portable across Deep Lake instances.

---

## How it is used on a fresh clone

When hiveantennae boots and finds `.honeycomb/nectars.json` present, the boot path is:

```mermaid
flowchart TD
    boot["daemon boot on fresh clone"] --> load["load nectars.json"]
    load --> validate{"version + project match?'}
    validate -->|no| fallback["ignore projection, full brood"]
    validate -->|yes| index["build content_hash -> nectar index"]
    index --> scan["scan disk, hash each file"]
    scan --> match{"content_hash in index?"}
    match -->|yes| inherit["inherit nectar + description, write to Deep Lake"]
    match -->|no| ladder["run re-association ladder, possibly mint new nectar"]
    inherit --> ready["recall is live immediately"]
    ladder --> ready
```

A fresh clone with a current projection typically achieves **zero LLM calls and zero fuzzy matches**: every file's content hash matches the projection, every nectar is inherited, every description is carried over. The daemon writes the inherited rows to Deep Lake (the local Deep Lake instance, which is the substrate for this clone's recall) and is immediately ready to serve semantic queries. The brooding cost was paid by whoever first brooded the project; the clone pays nothing.

When the projection is stale (files on disk have content hashes not in the projection), those files enter the re-association ladder (`../ai/identity-and-reassociation.md`). The projection's content-hash index is the "known nectars" map that step 3 of the ladder consults; a content-hash match against a projection entry inherits that nectar directly without needing Deep Lake cloud sync.

---

## Generation and regeneration

The projection is regenerated by the daemon at three points:

1. **End of brooding.** A full brood produces a complete projection.
2. **End of an enricher cycle that wrote new descriptions.** An incremental update — the projection is rewritten with the newly-described versions substituted in.
3. **Explicitly, via `nectar rebuild-projection`.** A full regeneration from Deep Lake, used when the projection is corrupt, lost, or suspected stale.

Regeneration is a single scan of `hive_graph_versions` (latest described version per nectar, scoped to the project), denormalized into the projection format, written atomically (temp file + rename, same pattern the CodeGraph uses for snapshot writes). The write is atomic so a crashed regeneration leaves the old projection, not a partial one.

### Validation on load

When the daemon loads a projection, it validates:

- `version` is one it knows how to read (≤ its own schema version).
- `project.org_id`, `project.workspace_id`, `project.project_id` match the current context. A mismatch means the projection is from a different project (the repo was templated from another project, or the file was committed by mistake) and is ignored.
- Every nectar key is a syntactically valid ULID.
- Every `content_hash` is a syntactically valid sha256.

A projection that fails validation is ignored with a warning, and the daemon falls back to full brooding. The projection is never partially loaded.

---

## The commit discipline

`.honeycomb/nectars.json` should be committed to the repo, like `package-lock.json`. This is what makes it a team asset: every teammate's clone inherits it.

The churn cost is manageable. The projection changes when:

- A new file is added and described (one entry added).
- A file's description is updated (one entry's fields change).
- A file is deleted (one entry removed — though the daemon may keep it for a grace period in case of branch switches).

A typical PR might add or modify a handful of projection entries. The diff is reviewable: a reviewer can see "this PR added `src/auth/login.ts` with the description 'User login route handler'" and sanity-check that the description is reasonable. This is a real benefit — the descriptions become a reviewable artifact, not an opaque database blob.

To avoid projection churn dominating PR diffs, the daemon debounces projection writes the same way it debounces enricher calls (see `../ai/enricher-and-llm-model.md`). A rapid-fire edit session produces one projection write at the end, not one per save. The committed file therefore changes at most once per enricher cycle (default 30 seconds), and in practice far less often — only when descriptions actually change.

### The `.gitignore` question

Some teams may prefer not to commit the projection (concerns about diff noise, or a preference for each clone to brood independently). Nectar supports this: if `.honeycomb/nectars.json` is gitignored, the daemon still writes it locally (for the clone's own use) but it is not shared. The tradeoff is that every clone broods from scratch, paying the LLM cost each time. The recommendation is to commit it, but the system works either way.

---

## How it differs from a sidecar (the rule)

The line between "projection" and "sidecar" is enforcement, not format. The same JSON file is a projection if the system treats it as regenerable, and a sidecar if the system reads from it as a source of truth. Nectar enforces the projection invariant through three rules:

1. **Deep Lake writes happen first.** Every nectar mint, version append, and description write goes to Deep Lake before the projection is regenerated. The projection is never the target of a write; it is always derived.
2. **The projection is never edited by hand or by external tools.** A hand-edit to `.honeycomb/nectars.json` is overwritten on the next regeneration. The file is read-only from the system's perspective except for the regeneration write.
3. **The projection is regenerable from Deep Lake alone.** `nectar rebuild-projection` produces a byte-identical file (modulo `generated_at`) from a Deep Lake scan, with no other inputs. If it did not, the projection would be carrying state Deep Lake does not have, which would make it a sidecar.

These rules are what keep `.honeycomb/nectars.json` on the right side of FR-8. The file exists for portability and reviewability; it does not exist because Deep Lake is insufficient.

---

## What the portable registry explicitly does not do

- **It does not carry embeddings.** Regenerated locally on boot from `title + description`.
- **It does not carry the version chain.** Only the latest described version per nectar.
- **It does not carry tenancy for every row.** The project triple is at the top level; individual entries do not repeat it.
- **It does not sync bidirectionally with Deep Lake.** Sync is one-directional: Deep Lake → projection. The reverse (projection → Deep Lake) happens only on a fresh clone, as an inheritance write, and only for nectars the local Deep Lake does not already have.
- **It does not replace Deep Lake cloud sync.** A team that commits the projection gets offline-fresh-clone support; a team that also uses Deep Lake cloud sync gets live description updates as teammates describe new files. The two are complementary, not alternative.
