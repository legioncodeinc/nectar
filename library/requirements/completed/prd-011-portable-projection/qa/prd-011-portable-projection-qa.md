# QA Report: PRD-011 Portable Projection Sync (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-011 (index + 011a/011b/011c) against the Hivenectar knowledge corpus and the cited Honeycomb code, armed with quality-stinger + hivenectar-stinger. This is primarily a PRD-vs-corpus/code pass: the projection is not yet implemented in-band (the `rebuild-projection` and `project` CLI verbs are clean "owned by PRD-011" stubs, `worker.ts` carries a `projection-sync` mode placeholder, and `health.ts` carries a `projection` block placeholder), so there is no projection read/write code to trace plan-to-code. Where in-band Hivenectar code that the projection will consume exists (`hivenectar/src/source-graph/`), it was scanned for conformance to the atomic-write and validation-on-load claims, and one cross-artifact representation mismatch was found (W-1). Matches the bar and format of the consolidated PRD-001-004 report and the PRD-005 report.

**Related:**
- [`../prd-011-portable-projection-index.md`](../prd-011-portable-projection-index.md)
- [`../../../../knowledge/private/data/portable-registry.md`](../../../../knowledge/private/data/portable-registry.md)
- [`../../../../knowledge/private/data/source-graph-schema.md`](../../../../knowledge/private/data/source-graph-schema.md)
- [`../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)
- [`../../../completed/prd-005-source-graph-catalog-tables/qa/prd-005-source-graph-catalog-tables-qa.md`](../../../completed/prd-005-source-graph-catalog-tables/qa/prd-005-source-graph-catalog-tables-qa.md)

---

## 1. Summary

PRD-011 is the portable-projection module and is the most corpus-faithful PRD audited to date on the documentation-framework axis: it carries the projection JSON format, the three generation triggers, the four-point validation-on-load contract, and the three projection-not-sidecar rules verbatim from `data/portable-registry.md`, and it cites all Honeycomb code with canonical backtick file-path spans (zero markdown-link-form code refs, so the systemic W-1/W-3 finding that dogged PRD-001/002/003/005 is absent here). Both cited Honeycomb symbols exist and are truthful: `writeSnapshotAtomic` is at `honeycomb/src/daemon/runtime/codebase/snapshot.ts:279-298` exactly (the PRD is actually more precise than `MASTER-PRD-INDEX.md:134`, which attributes the function to `api.ts`), and `canonicalJSON(snapshot)` is at `snapshot.ts:294` exactly. The module **PASSES with one warning** to the medium-and-above standard: **zero Critical findings** and **one medium Warning** (W-1) plus five sub-medium notes. W-1 is a cross-artifact representation mismatch: PRD-011b hardens the corpus's illustrative `sha256-abc123...` placeholder into a concrete validation rule ("`sha256-` prefix + 64 hex chars"), but the in-band content-hash producer (`hivenectar/src/source-graph/hash.ts:10-11`) emits bare lowercase 64-hex with no `sha256-` prefix, so a literal implementation of the PRD-011b sha256 gate would reject every content hash the system actually stores and break fresh-clone inheritance. The must-preserve items (the projection-not-sidecar invariant tied to FR-8, the two DEFAULT-confirm flags) are all correctly present and are not treated as over-specification.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-011 index | PASS | PASS | PASS | PASS | PASS; note N-3, N-4 | PASS |
| PRD-011a | PASS | PASS; note N-1, N-2 | PASS | PASS | PASS | PASS |
| PRD-011b | PASS | WARNING (W-1) | WARNING (W-1) | PASS | PASS | PASS-with-warnings |
| PRD-011c | PASS | PASS | PASS | PASS | PASS; note N-5 | PASS |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-1 (Correctness / Alignment, 011b): the sha256 validation rule contradicts the in-band content-hash representation

The corpus projection format shows content hashes with a `sha256-` prefix as an illustrative placeholder (`data/portable-registry.md:46`, `:55`, `:67`: `"content_hash": "sha256-abc123..."`), and the corpus schema doc describes the column only as "sha256 of file content at observation" with no prefix stated (`data/source-graph-schema.md:93`). PRD-011b promotes the illustrative placeholder into a concrete validation rule:

- `prd-011b-validation-on-load-fresh-clone-inheritance.md:39` (contract): "Every `content_hash` is a syntactically valid sha256."
- `prd-011b:118` (implementation note): "sha256 validation is syntactic. A `sha256-` prefix + 64 hex chars check ..."

The in-band content-hash producer emits **bare lowercase 64-hex with no prefix**:

```10:12:hivenectar/src/source-graph/hash.ts
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
```

and it is what populates `source_graph_versions.content_hash` (the exact table the projection denormalizes):

```91:91:hivenectar/src/registration/ladder.ts
  const hash = sha256Hex(content);
```

Because the projection's `content_hash` is denormalized from `source_graph_versions` (`prd-011-portable-projection-index.md:60`, `prd-011c:41`), the projection would carry bare hex, while the PRD-011b gate expects a `sha256-` prefix. An implementer who codes `prd-011b:118` literally would fail the sha256 check on every real projection, causing the whole projection to be "ignored with a warning" and the daemon to fall back to full brooding, which defeats AC-6, AC-011b.3.2, and AC-011b.4.2. Conversely, the content-hash index build (`prd-011b:119`, `content_hash -> nectar`) and the disk-scan lookup (`prd-011b:109`) must hash on-disk files with the same representation the projection carries; a prefix mismatch there yields zero inheritance matches and zero-cost boot silently degrades to a full brood.

Impact: medium. Nothing is at runtime risk today (no projection code exists), but this is a spec-consistency defect that will bite the PRD-011 implementer and silently break the zero-LLM fresh-clone path if not reconciled before build. The DDL, the format block, and the trigger/rule prose are all correct; only the exact byte-shape of `content_hash` is unreconciled across the corpus placeholder, PRD-011b, and the in-band hasher.

**Remediation (report-only; decide the representation, then align all three artifacts):** Pick one canonical `content_hash` byte-shape and make the corpus, PRD-011b, and the hasher agree. Option A (bare hex, matches current code): soften `prd-011b:118` to "a 64-lowercase-hex-char check (no prefix)," keep `prd-011b:39` as "syntactically valid sha256," and note in `prd-011a` that the corpus `sha256-...` in the format block is illustrative shorthand for a bare-hex value. Option B (prefixed): keep the `sha256-` prefix as normative and add an explicit normalization seam (the projection generator writes `sha256-<hex>`; the content-hash index and the disk-scan lookup normalize both sides), and raise a corpus/PRD-005 note that `source_graph_versions.content_hash` and `hash.ts` must carry or be normalized to the prefix. Because the representation crosses PRD-005/PRD-006 (hasher, versions table) and the corpus, coordinate the reconciliation with knowledge-worker-bee (corpus) and the PRD-005/006 owner rather than editing PRD-011 alone. Do not edit code or the corpus in this pass.

## 5. Suggestions (consider improving) and sub-medium notes

- **N-1 (Correctness, minor line drift, 011a):** `prd-011a:116` and `prd-011a:190` cite `honeycomb/src/daemon/runtime/codebase/api.ts:251` as "the call site that invokes `writeSnapshotAtomic`." The actual `writeSnapshotAtomic(...)` call is at `api.ts:253`; line `:251` is the start of the "// 3. Persist the LOCAL authoritative copy atomically (014b)" step comment that introduces the call. The citation matches `MASTER-PRD-INDEX.md:134` verbatim (which also says `:251`), so this is inherited, not introduced, and it resolves to the correct step and function. Sub-medium; if tightening, cite the persist step as `api.ts:251-253` or the call line as `api.ts:253`. The definition citation `snapshot.ts:279-298` is exact and correct.
- **N-2 (Detrimental Patterns, path-prefix inconsistency, 011a):** In the same sentence at `prd-011a:116`, the snapshot reference carries the repo prefix (`honeycomb/src/daemon/runtime/codebase/snapshot.ts:279-298`) but the api reference drops it (`src/daemon/runtime/codebase/api.ts:251`). The Related section at `:189-190` uses the `honeycomb/` prefix for both. Documentation-framework and `AGENTS.md` cite cross-repo code with the path as it appears in the sibling repo (the rest of the PRD and PRD-005 use the `honeycomb/` prefix). Sub-medium; add the `honeycomb/` prefix to the api span at `:116` for consistency.
- **N-3 (lifecycle metadata staleness, index + all sub-PRDs):** The folder lives in `in-work/`, but every file's frontmatter still reads `> **Status:** Backlog` (`prd-011-portable-projection-index.md:3`, `prd-011a:3`, `prd-011b:3`, `prd-011c:3`), and the index Sub-features table labels the three sub-PRDs `Draft` (`index:38-40`). That is a three-way inconsistency: folder location `in-work`, frontmatter `Backlog`, table `Draft`. `AGENTS.md` says lifecycle is expressed by folder location; the frontmatter and table should reflect the same stage. Sub-medium; when the in-work migration settles, align the frontmatter Status and the Sub-features table to the folder's lifecycle. Left unedited per audit scope.
- **N-4 (cross-PRD folder link at migration risk, 011c):** `prd-011c:124` links `[../../backlog/prd-002-hivenectar-daemon/](../../backlog/prd-002-hivenectar-daemon/)`. The prd-002 content files currently still live under `backlog/`, so the link resolves today, but prd-002 is mid-migration to `completed/` (its `qa/.gitkeep` has already moved to `completed/prd-002-hivenectar-daemon/qa/`). When the move completes, this link breaks (same class as R-2 in the consolidated report). Sub-medium; repoint to `../../completed/prd-002-hivenectar-daemon/` once the migration finishes. Do not act now: prd-002's move is another agent's active work.
- **N-5 (cross-PRD folder link at migration risk, 011b):** `prd-011b:138` links `[../../backlog/prd-006-file-registration-protocol/](../../backlog/prd-006-file-registration-protocol/)`. prd-006 currently exists in BOTH `backlog/` and `in-work/` (a mid-migration duplicate), so the backlog target resolves today, but once the backlog copy is removed this breaks. Since prd-006 is moving to `in-work/` (the same lifecycle stage as prd-011), the durable target is the sibling `../prd-006-file-registration-protocol/`. Sub-medium; repoint once prd-006's migration settles. Do not act now: prd-006's move is another agent's active work.

## 6. Documentation-framework conformance: honeycomb code-reference form

Every Honeycomb code reference in PRD-011 is a canonical backtick file-path span, not a markdown link. A scan of the PRD-011 folder for markdown-link-wrapped `honeycomb/` or `hivedoctor/` targets (`grep -rnE '\]\([^)]*honeycomb[^)]*\)'`) returns **zero matches**. PRD-011 does not carry the systemic W-1/W-3 non-resolving-code-link finding from the consolidated PRD-001-004 report or the PRD-005 report.

| File | Link-form honeycomb/hivedoctor tokens | Span-form honeycomb code refs (conformant) |
|---|---|---|
| `prd-011-portable-projection-index.md` | 0 | 0 (no honeycomb code cited) |
| `prd-011a-format-generation-triggers-atomic-write.md` | 0 | `snapshot.ts:279-298`, `snapshot.ts:269-298`, `snapshot.ts:294`, `api.ts:251` (`:116`, `:125`, `:170`, `:189`, `:190`) |
| `prd-011b-validation-on-load-fresh-clone-inheritance.md` | 0 | 0 (no honeycomb code cited) |
| `prd-011c-rebuild-projection-cli-and-invariant.md` | 0 | `honeycomb/src/daemon/storage/heal.ts` (`:61`, `:123`) |
| **Total** | **0** | conformant |

**Remediation recipe (not needed here; retained for future edits):** if a later edit introduces a markdown-link-wrapped honeycomb ref (`` [`honeycomb/...`](../../../../honeycomb/...) ``), drop the link wrapper and keep the backtick span; if the visible text is short-form, promote the target path into the span (normalizing the `../../../../honeycomb/` prefix to `honeycomb/`) and carry the line range from the original text; then re-run the grep above and confirm it stays at zero.

## 7. Plan Item (AC) Traceability

### PRD-011 index (7 module ACs)

| AC | Corpus / code source | Verdict |
|---|---|---|
| AC-1 brood completes then a complete projection is written atomically (temp + rename) at project root | `portable-registry.md:119`, `:123`; `snapshot.ts:279-298` | PASS |
| AC-2 enricher cycle wrote new descriptions then projection rewritten atomically with new versions substituted | `portable-registry.md:120`, `:123`, `:150` | PASS |
| AC-3 `rebuild-projection` regenerates from a single `source_graph_versions` scan (latest described per nectar, scoped) written atomically | `portable-registry.md:121`, `:123`; schema `:62-88` | PASS |
| AC-4 projection `version` exceeds daemon schema version then ignored with warning, full-brood fallback | `portable-registry.md:75`, `:129` | PASS |
| AC-5 `project` triple mismatch then ignored with warning, never partially loaded | `portable-registry.md:78`, `:130`, `:134` | PASS |
| AC-6 fresh clone with current projection: hash-match files inherit nectar + description, zero LLM, zero fuzzy, recall live | `portable-registry.md:100-109` | PASS (content-hash byte-shape caveat, see W-1) |
| AC-7 `rebuild-projection` output byte-identical modulo `generated_at` | `portable-registry.md:164`; `snapshot.ts:294` (canonical JSON) | PASS |

### PRD-011a format + triggers + atomic write (US ACs)

| AC | Source | Verdict |
|---|---|---|
| AC-011a.1.1 brood projection `files` = latest described per nectar, scoped to the tenancy triple | `portable-registry.md:79`, `:119`; schema `:109` | PASS |
| AC-011a.1.2 `version`/`generated_at`/`generator`/`project`/`derived` populated per verbatim format | `portable-registry.md:35-70`, `:75-80` | PASS (format block matches corpus character-for-character) |
| AC-011a.2.1 enricher cycle with new descriptions rewrites projection with new versions substituted | `portable-registry.md:120` | PASS |
| AC-011a.2.2 enricher cycle with no new descriptions does not rewrite | `portable-registry.md:150` ("only when descriptions actually change") | PASS |
| AC-011a.3.1 interrupted after `writeFileSync` before `rename` leaves prior file intact | `snapshot.ts:288-296` (comment `:289-290`) | PASS |
| AC-011a.3.2 completed regeneration renames temp over final, no temp remains | `snapshot.ts:293-296` | PASS |

### PRD-011b validation-on-load + fresh-clone inheritance (US ACs)

| AC | Source | Verdict |
|---|---|---|
| AC-011b.1.1 project-triple mismatch then ignored with warning | `portable-registry.md:130`, `:134` | PASS |
| AC-011b.1.2 mismatched projection then full-brood, no entries written to Deep Lake | `portable-registry.md:130`, `:175` | PASS |
| AC-011b.2.1 `version` exceeds schema version then ignored with warning | `portable-registry.md:75`, `:129` | PASS |
| AC-011b.2.2 future-version projection then full-brood fallback | `portable-registry.md:75`, `:134` | PASS |
| AC-011b.3.1 any nectar key not a syntactically valid ULID then ignored, never partial | `portable-registry.md:131`, `:134`; `ulid.ts:57-62` (`isValidNectar`) | PASS |
| AC-011b.3.2 any `content_hash` not a syntactically valid sha256 then ignored, never partial | `portable-registry.md:132`, `:134` | PASS on the gate concept; the exact sha256 byte-shape (`sha256-` prefix vs bare hex) is unreconciled with `hash.ts:10-11` (see W-1) |
| AC-011b.4.1 valid projection then `content_hash -> nectar` index built from `files` | `portable-registry.md:100` | PASS |
| AC-011b.4.2 disk file whose hash matches an index entry inherits nectar + description to local Deep Lake, zero LLM | `portable-registry.md:103`, `:109` | PASS (content-hash byte-shape caveat, see W-1) |
| AC-011b.4.3 all files match then zero LLM, zero fuzzy, recall live immediately | `portable-registry.md:109` | PASS |

### PRD-011c rebuild-projection CLI + projection-not-sidecar invariant (US ACs)

| AC | Source | Verdict |
|---|---|---|
| AC-011c.1.1 `rebuild-projection` scans `source_graph_versions` for latest described per nectar, scoped | `portable-registry.md:121`, `:123`; schema `:62-88` | PASS |
| AC-011c.1.2 scan completes then written atomically (temp + rename) over existing file | `portable-registry.md:123`; `snapshot.ts:279-298` | PASS |
| AC-011c.2.1 `project --rebuild-projection` runs scoped to current `org_id`/`workspace_id`/`project_id` | `MASTER-PRD-INDEX.md:202`; `portable-registry.md:123` | PASS |
| AC-011c.3.1 same Deep Lake state, two runs byte-identical except `generated_at` | `portable-registry.md:164`; `snapshot.ts:294` | PASS |
| AC-011c.3.2 divergence beyond `generated_at` treated as invariant violation | `portable-registry.md:164` (rule 3) | PASS |
| AC-011c.4.1 hand-edit overwritten on next regeneration trigger | `portable-registry.md:163` (rule 2) | PASS |

## 8. Deliberate items preserved (NOT flagged as gaps)

Confirmed present and intentional, not defects:

- **The projection-not-sidecar invariant is stated and load-bearing, not over-specification.** PRD-011c carries the three rules verbatim from `portable-registry.md:162-164` (Deep Lake writes first; never hand-edited; regenerable byte-identical modulo `generated_at`) at `prd-011c:49-51`, and ties them to FR-8 at `prd-011c:53` (and ADR-0002's process boundary at `prd-011a:169`). This is exactly the ADR-0002 / FR-8 must-preserve item; it is verified present and correct.
- **DEFAULT-confirm flags present in all four files.** Projection path `.honeycomb/nectars.json` at the project root and the 30s projection-write debounce each carry "[DEFAULT - confirm before implementation]" (`index:72-73`, `011a:178-179`, `011b:126-127`, `011c:111-112`). The 30s value traces to `portable-registry.md:150` ("at most once per enricher cycle (default 30 seconds)"). Confirmed, not flagged.
- **Deliberate omissions preserved.** No embeddings in the projection (regenerated from `title + description`, `portable-registry.md:85`, `:172`; `model.ts:100-101`), no full version chain (latest described per nectar only, `portable-registry.md:84`), no internal Deep Lake IDs (`portable-registry.md:87`), and minimal entries for minted-but-undescribed nectars (`portable-registry.md:86`; `prd-011a:96`). None treated as gaps.
- **Format block matches the corpus verbatim.** The JSON at `prd-011a:36-72` matches `portable-registry.md:35-70` character-for-character (version, `generated_at`, `generator`, `project` triple, two `files` entries, `derived` map). The `derived` entry keys (`from_nectar`, `fork_content_hash`) map correctly to `source_graph.derived_from_nectar` / `fork_content_hash` (schema `:51-52`; `model.ts:52-55`).

## 9. High-risk surfaces verified verbatim / against source

- Projection JSON format: `prd-011a:36-72` matches `portable-registry.md:35-70` verbatim.
- Three generation triggers: `prd-011a:104-106` matches `portable-registry.md:119-121`.
- Four-point validation-on-load contract: `prd-011b:36-39` matches `portable-registry.md:129-132`.
- Three projection-not-sidecar rules: `prd-011c:49-51` matches `portable-registry.md:162-164` verbatim.
- Atomic write pattern: `writeSnapshotAtomic` at `honeycomb/src/daemon/runtime/codebase/snapshot.ts:279-298` (exact); unique temp suffix `.${fileName}.${process.pid}.${Date.now()}.tmp` at `snapshot.ts:293`; `canonicalJSON(snapshot)` at `snapshot.ts:294` (exact). PRD-011a's mkdir/tmp/write/rename pseudocode (`:119-123`) mirrors `snapshot.ts:281`, `:293-296`.
- Call site: the `writeSnapshotAtomic(...)` invocation is at `honeycomb/src/daemon/runtime/codebase/api.ts:253` (the step-3 persist comment begins at `:251`); PRD cites `:251`, matching `MASTER-PRD-INDEX.md:134` (see N-1).
- Regenerable-from-source principle: `honeycomb/src/daemon/storage/heal.ts` exists and documents lazy additive self-heal (`heal.ts:1-22`); PRD-011c cites it as the analogous "regenerable artifact" principle (`prd-011c:61`, `:123`), matching `MASTER-PRD-INDEX.md:134`. The analogy is loose (heal = additive schema convergence, not delete-and-rebuild), acceptable as a "conforms to" pointer.
- 30s debounce: `portable-registry.md:150`.
- `source_graph_versions` scan contract (latest described per nectar, scoped): schema `:62-88`, tenancy `:109`; `describe_status = 'described'` is a real enum value (`model.ts:28-34`, schema `:107`).
- Internal cross-links resolve: `../../../requirements/MASTER-PRD-INDEX.md` (exists), `../../../knowledge/private/data/portable-registry.md`, `.../source-graph-schema.md`, `.../ai/identity-and-reassociation.md`, `.../ai/brooding-pipeline.md`, `.../ai/enricher-and-llm-model.md` (all exist). Two cross-PRD folder links resolve today but are at migration risk (N-4 prd-002, N-5 prd-006).

Both cited Honeycomb symbols exist. Only drift found: the `api.ts` call-site line (`:251` cited, call at `:253`), inherited verbatim from the MASTER index; recorded as sub-medium N-1.

## 10. In-band code scan (`hivenectar/src/source-graph/`)

No projection read/write logic exists yet (PRD-011 is unbuilt). The CLI verbs are clean owned-by stubs (`cli.ts:22`, `:31-32`: `rebuild-projection` and `project` map to "PRD-011"), `worker.ts:19` reserves a `projection-sync` mode, and `health.ts:29`, `:67` reserve a `projection` health block. These are conformant placeholders, not partial implementations. The consumable substrate that exists is PRD-005/PRD-006 code: `model.ts` (frozen row types, `EMBED_DIMS = 768`), `store.ts` (the `SourceGraphStore` seam with `listLatestVersions`/`latestVersionByHash` the projection generator and content-hash index will use), `ulid.ts` (`isValidNectar` shape check the ULID validation can reuse), and `hash.ts` (`sha256Hex`, the content-hash producer implicated in W-1). One conformance issue was found (W-1: `hash.ts` bare-hex vs PRD-011b `sha256-` prefix rule).

## 11. Files Audited

- `prd-011-portable-projection-index.md` - audited (notes N-3, N-4).
- `prd-011a-format-generation-triggers-atomic-write.md` - audited (notes N-1, N-2).
- `prd-011b-validation-on-load-fresh-clone-inheritance.md` - audited (carries W-1; note N-3).
- `prd-011c-rebuild-projection-cli-and-invariant.md` - audited (note N-5).

Cited sources cross-checked (not modified): `library/knowledge/private/data/portable-registry.md`, `library/knowledge/private/data/source-graph-schema.md`, `library/requirements/MASTER-PRD-INDEX.md`, `honeycomb/src/daemon/runtime/codebase/snapshot.ts`, `honeycomb/src/daemon/runtime/codebase/api.ts`, `honeycomb/src/daemon/storage/heal.ts`, and `hivenectar/src/source-graph/*` + `hivenectar/src/{cli,worker,health}.ts`.

No PRD content, corpus, or code was modified by this audit (report-only, per quality-stinger). Cross-PRD folder-link and lifecycle-metadata items that touch prd-002 and prd-006 mid-migration were left untouched per the work-boundary rule and flagged for the migrating owner.

**Overall verdict: PASS-with-warnings** (medium-and-above). Zero Critical findings. One medium Warning (W-1: the PRD-011b `sha256-` prefix validation rule contradicts the in-band bare-hex content-hash producer, a spec-consistency defect to reconcile with the corpus and PRD-005/006 owners before PRD-011 is built). Five sub-medium notes (api.ts call-line drift inherited from the MASTER index, an api-span missing `honeycomb/` prefix, three-way lifecycle-metadata inconsistency, and two migration-risk cross-PRD folder links). The spec substance (verbatim format, three triggers, four-point validation gate, three projection-not-sidecar rules, atomic-write pattern, byte-identical-modulo-`generated_at` invariant) passes cleanly, all cited Honeycomb code is truthful, and PRD-011 is fully conformant on the documentation-framework code-reference axis (zero link-form code refs).

## Remediation addendum (2026-07-01, the-smoker Wave B) — post-remediation verdict: PASS (clean at medium+)

- **W-1 resolved (in PRD-011, no corpus/code edit):** `prd-011b:118` softened from "A `sha256-` prefix + 64 hex chars check" to "A 64-lowercase-hex-char check with no prefix," explicitly aligned to the bare-hex producer `sha256Hex` at `hivenectar/src/source-graph/hash.ts:10-11` (which populates `source_graph_versions.content_hash`), and it now states the corpus `sha256-abc123...` format is an illustrative placeholder, not a normative prefix. This resolves the cross-artifact mismatch that would have broken zero-LLM fresh-clone inheritance, without touching the corpus, PRD-005/006, or code (the corpus placeholder and `hash.ts` were already consistent with bare hex; only PRD-011b over-hardened them). `prd-011b:39` ("syntactically valid sha256") kept as-is.
- **N-4 / N-5 resolved (broken by this run's lifecycle moves, now fixed):** `prd-011c:124` repointed from `../../backlog/prd-002-hivenectar-daemon/` to `../../completed/prd-002-hivenectar-daemon/` (prd-002 was moved to completed in Wave A); `prd-011b:138` repointed from `../../backlog/prd-006-file-registration-protocol/` to the sibling `../prd-006-file-registration-protocol/` (prd-006 is in in-work this wave).
- **Sub-medium (carried forward, not blocking):** N-1 (api.ts call-line `:251` vs `:253`, inherited verbatim from MASTER-PRD-INDEX), N-2 (api span missing `honeycomb/` prefix at `011a:116`), N-3 (frontmatter `Status: Backlog` vs `in-work/` folder — a repo-wide lifecycle-metadata pattern, deferred).
