# PRD-006b: Event → Ladder-Step Classification

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M

## Overview

This sub-PRD owns the **translation layer** between the uncorrelated `fs.watch` observation stream (006a) and the re-association ladder's input (006d). When the debounce window settles, the accumulated set of touched paths is classified into exactly three input classes — **new path**, **changed path**, **missing path** — which are the only inputs the ladder consumes. The classification is a pure function of (the settled path set, the on-disk stat, the known-nectars map from Deep Lake); it produces no nectar decisions of its own.

`fs.watch` does not correlate events, so a single user action (a rename, a move-and-edit, a copy) arrives as multiple independent observations that this classifier reconciles into the ladder's vocabulary. The defining move is the reconstruction of "missing": the classifier maintains the **missing-files set** — known nectars whose latest path no longer exists on disk — which step-3 and step-4 of the ladder (006d) consult to carry a nectar to a new location. This is the mechanism the corpus describes in [`identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) § "Live watch vs cold catch-up" and § "Step 3".

## Goals

- Define the three input classes the ladder consumes and the invariant that every settled path maps to exactly one.
- Specify the classification algorithm: stat the path on disk, look up the known-nectars map, and assign the class.
- Define the **missing-files set**: how it is built (the set diff between Deep Lake's known paths and disk's current paths), refreshed per cycle, and consumed by steps 3–4.
- Specify the dedup/coalescing rule: a path touched many times in one burst classifies once.
- Specify the editor "delete-then-recreate" handling (the path is missing mid-burst but present at settle).

## Non-Goals

- Deciding a nectar outcome per class — that is the ladder (006d) and the copy detector (006c).
- The `fs.watch` attach/debounce mechanics — 006a.
- The TLSH / exact-hash matching inside steps 3–4 — 006d.
- The missing-files **prune** lifecycle (how long a missing entry lives before the conservative prune removes it) — 006d.

## The three input classes

The ladder (006d) consumes exactly three classes. This sub-PRD defines how a settled path is assigned to one of them.

| Class | Definition | Disk state | Deep Lake state | Ladder steps that consume it |
|---|---|---|---|---|
| **new path** | A path on disk with no known nectar at that path. | file exists | no `source_graph` row whose latest-version path equals this path | step 3 (exact-hash-to-missing), step 4 (TLSH-fuzzy-to-missing), step 5 (mint), copy detector (006c) |
| **changed path** | A path on disk with a known nectar, whose content (mtime/size, then hash) differs from the latest version. | file exists | a `source_graph` row exists at this path | step 1 (exact path+mtime+size), step 2 (path match, content changed) |
| **missing path** | A known nectar whose latest-version path no longer exists on disk. | file absent | a `source_graph` row exists whose latest-version path is this path | feeds the **missing-files set** consulted by steps 3–4 |

A path is in exactly one class after a settle. The "known nectar at that path" lookup is scoped by the project tenancy filter (`org_id` + `workspace_id` + `project_id`, per PRD-005c) — re-association never crosses project boundaries (`identity-and-reassociation.md` § "What re-association explicitly does not do").

## The classification algorithm

After the debounce window settles (006a), the classifier runs over the accumulated pending-path set. For each path `p`:

```text
function classifyPath(p, diskStat, knownNectars):
    if diskStat is absent:                      # file not on disk
        return MISSING                           # → contributes to the missing-files set
    latestVersion = knownNectars.latestVersionByPath(p)
    if latestVersion is None:
        return NEW                               # → steps 3/4/5 + copy detector
    return CHANGED                               # → the ladder (step 1 short-circuits UNCHANGED without a read)
```

The **step-1 fast path** (mtime+size exact match, treated as unchanged) is resolved as the ladder's first rung, not inside the classifier. The corpus states step 1 is "the fast path ... the daemon treats it as unchanged without reading or hashing the content" (`identity-and-reassociation.md` § "Step 1"). In the shipped implementation (`src/registration/ladder.ts`), the ladder reads the latest version's `mtime_observed` + `size_bytes` and, on an exact match, returns a no-op before any `readContent`, so an `UNCHANGED` file short-circuits at the top of the ladder before any hashing. The classifier itself is deliberately narrow: it distinguishes only `NEW`, `CHANGED`, and `MISSING`, and a `CHANGED`-classified path whose mtime+size still match is resolved as the ladder's no-op. (The mtime/size pair is a cache key only, per `identity-and-reassociation.md` § "What re-association explicitly does not do": "mtime is mutable ... mtime+size is a fast-path cache key only; any path that is a candidate for steps 2-5 is content-hashed before a decision is made.")

### Dedup and coalescing

A path touched many times within one debounce burst (an editor that fires `change` on every keystroke-save) classifies **once**, at settle time, against the final on-disk state. The pending-path set is a `Set<string>` (one entry per path regardless of observation count), mirroring how `scheduleSyncCycle` collapses a burst into one cycle (006a). The classifier never sees intermediate states — it sees only the settled disk state, which is the basis for "re-association does not run during live edits; the watcher debounces, and re-association runs on the debounced state" (`identity-and-reassociation.md` § "What re-association explicitly does not do").

### Editor delete-then-recreate

Editors commonly rewrite a file by deleting it and recreating it (atomic save via temp+rename). Within a single burst this emits a `rename` (missing) then a `change`/`rename` (new) for the same path. The classifier runs **after** settle, against final disk state, so a path that is missing mid-burst but present at settle classifies as `NEW` or `CHANGED` (not `MISSING`) — the intermediate missing observation is absorbed by the debounce, exactly as the directory-level watch in `file-watcher.ts:320-331` is designed to handle ("a 'delete then recreate' write pattern … still fires the event even when the original inode is gone"). Only paths genuinely absent at settle contribute to the missing-files set.

## The missing-files set

The missing-files set is the bridge between uncorrelated events and move reconstruction. It is defined in `identity-and-reassociation.md` § "Step 3": "the daemon keeps a map of 'files that used to exist but do not anymore' (the set diff between Deep Lake's known paths and disk's current paths)."

### Construction (per settle)

The set is rebuilt at the end of each settle as the set difference:

```text
missingFiles = { nectar N : N's latest-version path P exists in Deep Lake
                          AND P does not exist on disk at settle }
```

It is keyed by nectar and carries each missing nectar's **latest** version content hash and TLSH fingerprint (the evidence steps 3 and 4 match against). A nectar enters the set the first settle its path is absent; it stays in the set across settles until either (a) a new path's content matches it (step 3 or 4 carries the nectar and removes it from the set) or (b) the conservative prune (006d) removes the nectar record after the grace period.

### Consumption by the ladder

- **Step 3 (exact content-hash match to a missing file)** — for a `NEW` path whose `sha256` exactly equals a missing nectar's latest-version hash, the ladder carries the nectar to the new path (`identity-and-reassociation.md` § "Step 3"). The missing entry is resolved and leaves the set.
- **Step 4 (TLSH fuzzy match to a missing file)** — for a `NEW` path whose TLSH fingerprint is within the configurable distance of a missing nectar's fingerprint, the ladder scores the match and either carries the nectar (high confidence) or surfaces it for review (006d). The missing entry is resolved (or held pending review).

### Move reconstruction from uncorrelated events

This is the mechanism that makes `fs.watch`'s lack of move semantics cost nothing. A rename `old.ts → new.ts` arrives as two uncorrelated observations:

1. `rename` at `old.ts` → at settle, `old.ts` is absent → `old.ts`'s nectar enters the missing-files set.
2. an observation at `new.ts` → at settle, `new.ts` exists with no known nectar → `NEW`.

The ladder's step 3 compares `new.ts`'s content hash against the missing-files set, finds the exact match to `old.ts`'s nectar, and carries the nectar. No move object was ever needed — the missing-files set + the exact-hash comparison reconstruct it. This is the design `identity-and-reassociation.md` § "Live watch vs cold catch-up" describes: "the daemon debounces the path, refreshes the missing-files set, hashes the new path when needed, and lets step 3 carry the nectar when the new content matches a missing file's latest hash."

## The cold-catch-up extreme

The same classifier and the same missing-files set serve cold catch-up (daemon boots after offline changes). The only difference is the *seed* of the missing-files set: in live watch it is built incrementally per settle; in cold catch-up it is built once at boot as the full set diff between Deep Lake's known paths and disk's current paths. `identity-and-reassociation.md` § "Live watch vs cold catch-up" tabulates how the *distribution* of ladder steps differs between modes (step 1 dominant in cold catch-up, step 2 dominant in live watch), but the classification into the three classes — and the missing-files set — is identical. Brooding (PRD-007) is the degenerate cold-catch-up case where Deep Lake has no rows for the project and every path classifies `NEW` → step 5 (mint).

## Acceptance Criteria

- [ ] Every settled path classifies into exactly one of `NEW` / `CHANGED` / `MISSING`; the classifier is a pure function of (path, disk stat, known-nectars map). A `CHANGED` path whose mtime+size still match short-circuits as `UNCHANGED` at the ladder's step 1 (no content read).
- [ ] The step-1 fast path (mtime+size exact match, no-op) is resolved as the ladder's first rung (no content read), so an `UNCHANGED` path short-circuits before any hashing, matching `identity-and-reassociation.md` § "Step 1".
- [ ] The missing-files set is built as the set diff between Deep Lake's known latest-version paths and disk's current paths, keyed by nectar and carrying the latest content hash + TLSH fingerprint (`identity-and-reassociation.md` § "Step 3").
- [ ] A path touched many times in one burst classifies once, at settle, against final disk state (pending-path set is a `Set<string>`).
- [ ] An editor delete-then-recreate within one burst classifies as `NEW`/`CHANGED` at settle (intermediate missing observation absorbed by debounce).
- [ ] A rename arrives as two uncorrelated observations; the missing-files set + step 3 reconstruct the move with no move object (`identity-and-reassociation.md` § "Live watch vs cold catch-up").
- [ ] All lookups are scoped by `org_id` + `workspace_id` + `project_id` (PRD-005c); re-association never crosses project boundaries.
- [ ] Cold catch-up uses the same classifier and missing-files set, seeded once at boot; brooding is the degenerate all-`NEW` case.

## Related

- [PRD-006 index](./prd-006-file-registration-protocol-index.md) — module scope.
- [PRD-006a](./prd-006a-fswatch-intake-and-debounce.md) — the intake whose settled set this classifier consumes.
- [PRD-006c](./prd-006c-copy-event-detection.md) — the `NEW`-path copy detector.
- [PRD-006d](./prd-006d-reassociation-ladder.md) — the ladder that consumes the three classes + the missing-files set.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) — § "Step 1" (fast path), § "Step 3" (missing-files set), § "Live watch vs cold catch-up" (move reconstruction), § "What re-association explicitly does not do" (mtime cache key, project scope).
- `honeycomb/src/daemon/runtime/services/file-watcher.ts:320-331, 342-345` — directory-level watch rationale + null-filename handling (the editor delete-then-recreate contract).
