<!--
Path on disk (per AGENTS.md "Filename / folder conventions"):
  library/issues/backlog/issue-024-non-gitignore-exclude-for-committed-dirs/ird-issue-024-non-gitignore-exclude-for-committed-dirs.md
Lifecycle moves:
  backlog/ -> in-work/ -> completed/   (entire issue-024-... folder moves)
IRD number = GitHub issue number (#24). Single-scope: this IRD covers only issue #24.
-->

# IRD-024: Document and surface a non-gitignore exclude for committed dirs (graph-ignore.json today, .nectarignore alias?)

> **Status:** Backlog
> **GitHub issue:** [legioncodeinc/nectar#24](https://github.com/legioncodeinc/nectar/issues/24) (OPEN, filed 2026-07-04)
> **Severity:** P2 (capability exists and works; the gap is documentation and discoverability, but on large repos the cost of not finding it is a full walk over vendored code every brood)
> **Scope:** Documentation, discoverability, and dry-run surfacing of the existing non-gitignore exclude. Independent of the performance investigation in [IRD-022](../issue-022-health-starved-by-synchronous-indexing/ird-issue-022-health-starved-by-synchronous-indexing.md) / [IRD-023](../issue-023-post-index-cpu-busy-loop/ird-issue-023-post-index-cpu-busy-loop.md).

---

## Problem

Operators need to exclude directories from indexing that cannot be gitignored because they are committed (vendored code, checked-in build outputs). The capability already exists (`.honeycomb/graph-ignore.json`), but no user-facing documentation names it, so operators fall back to gitignore surgery that cannot cover committed paths, and there is no way to see which excludes are active before paying for a full walk.

## Field report

Environment: nectar 0.1.3 on Windows, honeycomb 0.2.3 fleet, ~85k-file repository (the same deployment whose memory/CPU timeline is recorded in IRD-022/IRD-023: ~868 MB peak during the walk, ~670 MB post-walk, sustained CPU climb afterwards).

- The operator had to gitignore-exclude `.claude/worktrees` and `node_modules` to tame indexing.
- Committed vendored code (`vendor/`, 9,262 files) cannot be gitignored, so it is walked and described on every brood.
- Ask as filed: provide a non-gitignore exclude (`.nectarignore` or config) for committed dirs.

## What already exists (code-grounded, and not discoverable)

`.honeycomb/graph-ignore.json` at the repo root is exactly this: a per-repo JSON prefix list (`["vendor/"]` or `{ "ignore": ["vendor/"] }`) honored in UNION with gitignore semantics by the shared ignore contract (`src/registration/ignore.ts:43-127`). It is applied on the git discovery path AND the walk AND (since PRD-019d) every CLI discovery path. The reporter's exact case is a one-line file, no gitignore change needed.

## Gaps to close

1. **Documentation.** No user-facing doc names `graph-ignore.json` as the committed-dirs exclude. The README and first-run guidance should, with the `vendor/` example.
2. **Discoverability/naming.** Consider a `.nectarignore` file (gitignore syntax) as a friendlier alias feeding the same shared-ignore predicate, or at minimum surface the ignore sources and their effect in `nectar brood --dry-run` output ("N files excluded by graph-ignore.json").
3. **Pre-brood visibility.** The dry-run report should make it obvious BEFORE a brood which excludes are active and how many files each source excludes, so an operator on a large repo can iterate without paying for a full walk.

## Proposed remediation direction (proposed, not decided)

- Author the user-facing documentation (README plus first-run guidance) naming `.honeycomb/graph-ignore.json` as the committed-dirs exclude, with the `vendor/` one-liner example.
- Decide on and, if accepted, implement the `.nectarignore` gitignore-syntax alias feeding the same predicate (union semantics preserved; no second ignore engine).
- Extend `nectar brood --dry-run` to report active ignore sources and per-source exclusion counts.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a fresh reader of the README (or first-run output), when they need to exclude a committed directory, then the documentation names `.honeycomb/graph-ignore.json`, shows the `vendor/` example, and states the union-with-gitignore semantics. |
| AC-2 | Given a repo with an active `graph-ignore.json` (and `.nectarignore` if the alias ships), when `nectar brood --dry-run` runs, then the output lists each active ignore source and the count of files it excludes, without performing a full brood. |
| AC-3 | Given the `.nectarignore` alias is accepted and shipped, when both it and `graph-ignore.json` are present, then both feed the single shared-ignore predicate in union with gitignore semantics, and existing `graph-ignore.json` behavior is unchanged. |
| AC-4 | Given the reporter's scenario (committed `vendor/` tree), when the documented one-line exclude is added and a brood runs, then no file under `vendor/` is walked, prepared, or described, on the git discovery path, the walk fallback, and every CLI discovery site. |

## Related

- [IRD-022: /health starved during indexing](../issue-022-health-starved-by-synchronous-indexing/ird-issue-022-health-starved-by-synchronous-indexing.md) and [IRD-023: post-index CPU busy-loop](../issue-023-post-index-cpu-busy-loop/ird-issue-023-post-index-cpu-busy-loop.md) - the performance investigation from the same field report; this IRD is independent but shrinks the workload those fixes must bound.
- [`prd-019-project-scoped-brooding-activation`](../../../requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md) - PRD-019d hardened the ignore contract so `graph-ignore.json` applies on every CLI discovery path.
- `src/registration/ignore.ts:43-127` - the shared ignore contract implementing `graph-ignore.json` with union semantics.
