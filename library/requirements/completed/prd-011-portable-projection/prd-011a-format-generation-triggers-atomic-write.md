# PRD-011a: Projection format, generation triggers, and atomic write

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None (a committed file, not a table)

---

## Overview

`.honeycomb/nectars.json` is the committed projection of the Deep Lake `hive_graph` state. This sub-PRD owns its JSON format (carried verbatim from `data/portable-registry.md`), the three generation triggers that produce it, and the atomic write that makes a crashed regeneration leave the prior file rather than a partial one. The format is the contract every consumer (validation-on-load, fresh-clone inheritance, `rebuild-projection`) reads; the triggers are the schedule; the atomic write is the durability guarantee.

---

## Goals

- The projection file conforms to the verbatim JSON format from `data/portable-registry.md` § The file format — top-level `version`, `generated_at`, `generator`, `project`, `files`, `derived`.
- The projection is generated at exactly three triggers: end of brooding, end of an enricher cycle that wrote new descriptions, and explicit `rebuild-projection`.
- Every generation writes the file **atomically** (serialize to a unique temp file in the same directory, then `rename`), mirroring the CodeGraph `writeSnapshotAtomic` pattern, so a crash leaves either the prior or the new file, never a partial.
- The `derived` map is keyed by the derived nectar and stays separate from `files` so the file map stays flat for content-hash lookups.

## Non-Goals

- Validation-on-load semantics (PRD-011b).
- The fresh-clone inheritance path (PRD-011b).
- The `rebuild-projection` CLI flags and the three enforcement rules (PRD-011c).
- Carrying embeddings or the full version chain (deliberate omissions — `data/portable-registry.md` § What it deliberately omits).

---

## The projection format (carried verbatim)

The format from `data/portable-registry.md` § The file format, verbatim:

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
      "content_hash": "sha256-abc123...",
      "path": "src/auth/login.ts",
      "title": "User login route handler",
      "description": "Validates credentials against the user store, starts a session, and issues a JWT refresh token. Entry point for the /login API.",
      "concepts": ["auth", "login", "session", "jwt"],
      "describe_model": "gemini-2.5-flash",
      "described_at": "2026-06-29T14:30:00Z"
    },
    "01J2X4F6K8ME7N9P1Q3R5T7V9WY": {
      "content_hash": "sha256-def456...",
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
      "fork_content_hash": "sha256-abc123..."
    }
  }
}
```

### Field semantics

From `data/portable-registry.md` § What it contains / § What it deliberately omits:

| Field | Purpose |
|---|---|
| `version` | Schema version of the projection format. Bumped on incompatible changes; old daemon versions refuse to load a higher version and fall back to full brooding. |
| `generated_at` | When the projection was last regenerated. Lets a clone detect staleness ("this projection is 3 weeks old; the daemon should verify against Deep Lake when it gets network"). |
| `generator` | The daemon version that produced the file. Auditable. |
| `project` | The tenancy triple. A clone in a different project context refuses to load a mismatched projection. |
| `files` | The main payload, keyed by nectar (ULID). Each entry carries the latest described version's `content_hash`, `path`, `title`, `description`, `concepts`, and provenance metadata (`describe_model`, `described_at`). |
| `derived` | The copy-paste provenance map, keyed by the derived nectar, pointing at `from_nectar` + `fork_content_hash`. Separated from `files` so the file map stays flat for content-hash lookups. |

### Deliberate omissions

From `data/portable-registry.md` § What it deliberately omits — the projection does NOT carry:

- **The full version chain** — only the latest described version per nectar; history stays in Deep Lake.
- **Embeddings** — the 768-dim vectors; regenerated from `title + description` via the configured provider, leaving the file kilobytes not megabytes.
- **Internal IDs** — no Deep Lake row IDs, no internal indices; portable across Deep Lake instances.

A nectar minted but never described (brooding interrupted, or the file was skipped as binary) appears with a minimal entry (`path`, `content_hash`, but empty `title`/`description`) so identity is preserved but recall does not surface it until described.

---

## The three generation triggers

From `data/portable-registry.md` § Generation and regeneration, the projection is regenerated at exactly three points:

1. **End of brooding.** A full brood produces a complete projection. (Owned with PRD-007.)
2. **End of an enricher cycle that wrote new descriptions.** An incremental update — the projection is rewritten with the newly-described versions substituted in. (Owned with PRD-016.)
3. **Explicitly, via `honeycomb nectar rebuild-projection`.** A full regeneration from Deep Lake, used when the projection is corrupt, lost, or suspected stale. (PRD-011c.)

The projection is **never** the target of a normal-operation write; it is always derived from Deep Lake first (rule #1 of the projection-not-sidecar invariant, PRD-011c).

---

## The atomic write

Regeneration writes the projection atomically — temp file + `rename` in the same directory, the same pattern the CodeGraph uses for snapshot writes (`data/portable-registry.md` § Generation and regeneration: "written atomically (temp file + rename, same pattern the CodeGraph uses for snapshot writes)"). The write is atomic so a crashed regeneration leaves the old projection, not a partial one.

The pattern to mirror is `writeSnapshotAtomic` (`honeycomb/src/daemon/runtime/codebase/snapshot.ts:279-298`, the function the CodeGraph build calls at `src/daemon/runtime/codebase/api.ts:251`):

```text
1. mkdirSync(<dir>, { recursive: true })
2. tmpPath = join(<dir>, ".<fileName>.<pid>.<Date.now()>.tmp")   // unique suffix → concurrent writes never collide
3. writeFileSync(tmpPath, canonicalJSON(projection), "utf8")
4. renameSync(tmpPath, finalPath)                                 // atomic on the same filesystem
```

Three properties carry over verbatim from the CodeGraph pattern (`snapshot.ts:269-298`):

- **Unique temp suffix** — `<pid>` + `<Date.now()>` so concurrent regenerations never collide.
- **Same directory** — the temp file and the final file share a directory so `rename` is atomic on the same filesystem (a cross-filesystem rename is not atomic).
- **Crash leaves the prior file** — a crash mid-`writeFileSync` leaves the temp file (ignored/overwritten next run) and the prior final file intact; the `rename` either fully happens or does not.

The serialized bytes are canonicalized (stable key ordering) so two regenerations of the same Deep Lake state produce byte-identical output modulo `generated_at` — the property PRD-011c's byte-identical invariant depends on.

### Write debounce

Per `data/portable-registry.md` § The commit discipline, the daemon debounces projection writes the same way it debounces enricher calls, so a rapid-fire edit session produces one projection write at the end, not one per save. The committed file changes at most once per enricher cycle (default 30 seconds), and in practice far less often — only when descriptions actually change. (Debounce window is a flagged default, see below.)

---

## User stories

### US-011a.1 — Generate a complete projection after brooding

**As a** teammate, **I want to** a complete `.honeycomb/nectars.json` written after a full brood, **so that** the committed file carries the project's identity map for every clone.

**Acceptance criteria:**
- AC-011a.1.1 Given a full brood completes for the project, when the projection is generated, then `files` contains the latest described version per nectar scoped to the project's `org_id`/`workspace_id`/`project_id`.
- AC-011a.1.2 Given the brood-derived projection, then `version`, `generated_at`, `generator`, `project`, and `derived` are all populated per the verbatim format.

### US-011a.2 — Incrementally rewrite after an enricher cycle

**As a** developer editing files, **I want to** the projection rewritten at the end of an enricher cycle that wrote new descriptions, **so that** committed descriptions stay current without a full regeneration.

**Acceptance criteria:**
- AC-011a.2.1 Given an enricher cycle writes one or more new descriptions, then the projection is rewritten with the newly-described versions substituted in.
- AC-011a.2.2 Given an enricher cycle produces no new descriptions, then the projection is not rewritten.

### US-011a.3 — Never write a partial projection

**As a** teammate, **I want to** a crashed regeneration to leave the prior projection, **so that** a corrupted file never breaks the next clone's boot.

**Acceptance criteria:**
- AC-011a.3.1 Given a regeneration is interrupted after `writeFileSync` but before `rename`, then the prior final file remains intact and readable.
- AC-011a.3.2 Given the regeneration completes, then the temp file is renamed over the final path and no temp file remains.

---

## Implementation notes

- **Mirror `writeSnapshotAtomic`, do not import it.** The function lives in the Honeycomb daemon (`src/daemon/runtime/codebase/snapshot.ts:279-298`); nectar reuses the *pattern* (temp + rename, unique suffix, same directory) to avoid coupling across the process boundary ADR-0002 established. The projection's `writeProjectionAtomic` is nectar-local.
- **Canonical JSON for stable bytes.** The serialization canonicalizes key ordering so the byte-identical-modulo-`generated_at` invariant (PRD-011c rule #3) holds; the CodeGraph uses `canonicalJSON(snapshot)` (`snapshot.ts:294`) for the same reason.
- **Triggers compose, they don't race.** Triggers #1 and #2 are daemon-internal and serialized through the enricher/brood paths; trigger #3 (`rebuild-projection`) is operator-initiated. All three funnel through the single `writeProjectionAtomic`; the unique temp suffix makes them safe even if they overlap.
- **`describe_model` round-trips verbatim.** The enricher's `inherited-from:<prev_content_hash>` marker (PRD-016a, PRD-010b) is carried through the projection unchanged so a clone's inheritance preserves the provenance audit.

---

## Flagged defaults

- **[SIGNED OFF 2026-07-02, decision #31 in `PRD-DECISIONS-AND-DEFAULTS.md`:** projection path `.honeycomb/nectars.json` at the project root (`data/portable-registry.md` § The file format).]
- **[SIGNED OFF 2026-07-02, decision #31:** projection write debounce 30s (carried from the enricher cycle cadence, `data/portable-registry.md` § The commit discipline).]

---

## Related

- [`./prd-011-portable-projection-index.md`](./prd-011-portable-projection-index.md)
- [`./prd-011b-validation-on-load-fresh-clone-inheritance.md`](./prd-011b-validation-on-load-fresh-clone-inheritance.md) — validation + the fresh-clone zero-LLM path.
- [`./prd-011c-rebuild-projection-cli-and-invariant.md`](./prd-011c-rebuild-projection-cli-and-invariant.md) — `rebuild-projection` + the three enforcement rules.
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) — AUTHORITATIVE: the verbatim format, the three triggers, the atomic-write requirement.
- `honeycomb/src/daemon/runtime/codebase/snapshot.ts:279-298` — `writeSnapshotAtomic`, the atomic-write pattern to mirror.
- `honeycomb/src/daemon/runtime/codebase/api.ts:251` — the call site that invokes `writeSnapshotAtomic` in the CodeGraph build (MASTER-PRD-INDEX.md "Conforms to").
