# PRD-006c: Copy-Event Detection (`derived_from_nectar` minting)

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S

## Overview

This sub-PRD owns the **copy detector** — the special case of a `NEW` path (006b) whose content hash exactly matches an existing file's **current** content. The detector runs ahead of the ladder's step 5 (mint new) for every `NEW` path that survives steps 3 and 4 (i.e., its content does not match any *missing* file). When the match is to an existing file's *current* content, the daemon mints a **fresh nectar N2** for the new path and records provenance back to the source nectar N1 via `derived_from_nectar` + `fork_content_hash`. This is the case minted identity handles best and source-embedded serials handle worst: the copy is its own identity, permanently linked to its source.

The contract is carried verbatim from [`identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) § "Copy-paste as a first-class provenance edge", including the `classifyNewFile` logic and the resulting `source_graph` row shape. This sub-PRD specifies when the detector runs in the cycle, how it distinguishes a copy from a missing-file move, and the deliberate ambiguity it accepts (two independent files with identical content).

## Goals

- Specify that the copy detector runs on every `NEW` path that survives ladder steps 3 and 4, comparing the new path's hash against existing files' **current** content.
- Carry the `classifyNewFile` logic verbatim from `identity-and-reassociation.md`: hash match to an existing file's current content → `action: "copy"` with `sourceNectar`; else → `action: "mint"`.
- Pin the resulting `source_graph` row: fresh nectar N2, `derived_from_nectar = N1`, `fork_content_hash = H1` (the source's content at copy time).
- Specify the ordering against the missing-files set (step 3/4 vs copy detection) so a move is never mistaken for a copy.
- Document the accepted ambiguity (two independent identical files) and its low cost, carried from the corpus.

## Non-Goals

- The general `NEW`-path mint (step 5) — 006d. The copy detector is a specialization of step 5 that adds provenance; the bare mint is step 5.
- The ladder steps 1–4 — 006d. The detector runs only after steps 3 and 4 fail to match the new path.
- The `derived_from` edge's rendering in the dashboard interlink view — PRD-015.
- A future `derived_kind: 'coincidental'` vs `'fork'` classification — named as a possible future enrichment in the corpus; out of scope for v1.

## When the detector runs

The detector runs on a `NEW` path **after** the ladder's step 3 and step 4 have both failed to match it to a missing file. The ordering is load-bearing:

1. **Step 3 first** (exact content-hash match to a *missing* file) — if the new path's hash matches a missing nectar's latest hash, that is a **move**, not a copy; the ladder carries the nectar (006d). The missing-file match takes precedence because it is unambiguous and preserves the existing identity.
2. **Step 4 next** (TLSH fuzzy match to a *missing* file) — if the new path fuzzy-matches a missing nectar, that is a **move-and-edit**; the ladder carries the nectar (high confidence) or surfaces it for review (006d).
3. **Copy detector** — only if steps 3 and 4 both miss. The new path's hash is compared against **existing files' current content** (files that are present on disk and have known nectars). A match here is a copy: the source still exists (it is not missing), and a second file now has its content.

This ordering implements the corpus's distinction between a move (source gone → carry the nectar) and a copy (source present → mint a fresh nectar with provenance). A copy never carries the source's nectar — that would collapse two distinct logical files into one identity, which is exactly the failure mode the corpus warns against.

## The detection logic

Carried verbatim from `identity-and-reassociation.md` § "Copy-paste as a first-class provenance edge". The detector receives the new path, its content hash, and a map of known nectars keyed by their latest content hash:

```typescript
function classifyNewFile(
  newPath: string,
  newHash: string,
  knownNectars: Map<string, { nectar: string; latestHash: string }>, // by latest hash
): { action: "mint" | "copy"; sourceNectar?: string } {
  const existing = knownNectars.get(newHash);
  if (existing && existing.latestHash === newHash) {
    // The new path's content matches some existing file's *current* content.
    // A different file with the same current content = copy event.
    return { action: "copy", sourceNectar: existing.nectar };
  }
  return { action: "mint" };
}
```

The lookup is keyed by **latest (current) content hash**, not by historical version hashes. A match means "another file that exists right now has this exact content." The `knownNectars` map is built from `source_graph` + the latest `source_graph_versions` row per nectar (PRD-005), scoped by the project tenancy filter (`org_id` + `workspace_id` + `project_id`).

### The minted row

When `classifyNewFile` returns `action: "copy"`, the daemon mints a **fresh nectar N2** (ULID, per the minting contract) and writes the `source_graph` identity row with provenance. The row shape is carried verbatim from the corpus:

```
nectar: N2
kind: 'file'
created_at: <now>
derived_from_nectar: N1      # provenance back to A (the source)
fork_content_hash: H1        # A's content at the moment of copy
```

`derived_from_nectar` and `fork_content_hash` are columns on the `source_graph` table (defined in PRD-005a). The initial `source_graph_versions` row for N2 carries `content_hash = H1`, `path = <new path>`, and `describe_status = 'pending'` — the new file is enqueued for enrichment like any mint, but the description may be inherited from N1's current description via the meaningful-change heuristic (PRD-016) since the content is identical at copy time.

The result, per the corpus: "B is its own identity (N2), and yet it is permanently linked to A (N1) through `derived_from_nectar`. When B is later edited and its content diverges from A, the link survives."

## The accepted ambiguity

The detector has one ambiguity, accepted by design and documented in the corpus: two genuinely independent files that happen to have identical content (two empty `.gitkeep` files, two copies of a boilerplate license). The detector treats both as copy events and sets `derived_from_nectar` on whichever was minted second.

`identity-and-reassociation.md` § "Copy-paste as a first-class provenance edge" records why this is acceptable: "This is rarely wrong in practice (boilerplate duplication *is* a copy relationship, semantically), and when it is wrong the cost is low: a spurious `derived_from` link in an interlink view." The detector does NOT attempt to disambiguate. A possible future enrichment pass could classify these as `derived_kind: 'coincidental'` vs `derived_kind: 'fork'` if the distinction proves valuable — this is named as a future option in the corpus and is out of scope for v1 (a non-goal here).

## The copy is never a move

The copy detector and the ladder's missing-file steps (3, 4) are mutually exclusive by construction, because the detector runs only after steps 3 and 4 miss. A `cp a.ts b.ts` where `a.ts` is later deleted in the same burst is resolved by the *final* disk state at settle: if `a.ts` is absent at settle, `a.ts`'s nectar is in the missing-files set and `b.ts`'s hash matches it → step 3 carries the nectar (a move, not a copy). If `a.ts` is present at settle, `b.ts`'s hash matches an *existing* file's current content → the detector mints N2 with `derived_from_nectar`. The debounce settle (006a) guarantees the classifier sees the final state, so the move-vs-copy decision is unambiguous given the settled disk state.

## Acceptance Criteria

- [ ] The copy detector runs on every `NEW` path **after** ladder steps 3 and 4 fail to match it to a missing file (ordering is load-bearing: missing-file match takes precedence).
- [ ] The detection logic matches `classifyNewFile` in `identity-and-reassociation.md` § "Copy-paste as a first-class provenance edge" verbatim: hash match to an existing file's **current** content → `action: "copy"`; else → `action: "mint"`.
- [ ] On a copy, the daemon mints a **fresh nectar N2** (never carries the source's nectar) and writes `source_graph` with `derived_from_nectar = N1` + `fork_content_hash = H1` (the source's content at copy time).
- [ ] The `knownNectars` lookup is keyed by latest (current) content hash, scoped by `org_id` + `workspace_id` + `project_id` (PRD-005c); re-association never crosses project boundaries.
- [ ] The accepted ambiguity (two independent identical files both treated as copies) is documented; no disambiguation is attempted in v1; `derived_kind: 'coincidental'` vs `'fork'` is a named future enrichment, not shipped.
- [ ] A copy never carries the source's nectar (collapsing two logical files into one identity is the failure mode the corpus warns against).

## Related

- [PRD-006 index](./prd-006-file-registration-protocol-index.md) — module scope.
- [PRD-006b](./prd-006b-event-to-ladder-step-classification.md) — the `NEW`-path class the detector consumes.
- [PRD-006d](./prd-006d-reassociation-ladder.md) — steps 3 and 4 (which must miss before the detector runs) + step 5 (the bare mint the copy specializes).
- [PRD-005a](../prd-005-source-graph-catalog-tables/prd-005a-source-graph-table.md) — `source_graph` columns `derived_from_nectar` + `fork_content_hash`.
- [`knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) § "Copy-paste as a first-class provenance edge" — the authoritative `classifyNewFile` logic + row shape + accepted ambiguity (carried verbatim).
- [`knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../../knowledge/private/architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md) — the identity decision that makes copy provenance possible (and that source-embedded serials cannot produce).
