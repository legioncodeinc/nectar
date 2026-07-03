# PRD-018h: Recall ranking correctness and error honesty

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (1-2d)
> **Schema changes:** None

---

## Overview

Recall is mission leg 3: "recall it as needed." The 2026-07-02 recall review found the leg's SQL-injection floor genuinely solid but its ranking and error reporting untrustworthy. The semantic arm's score formula and `ORDER BY score DESC` contradict the spec's own definition of `<#>` as cosine distance ordered ascending; if the spec is right about the operator, the vector arm returns the least similar files first, and nothing catches it because every test fakes the storage layer (NEC-005, review finding H1; the executive summary rates this High and flags it as the leg-3 correctness question to settle before release). Around it, three error-honesty defects convert real failures into quietly wrong or thinner results: every storage error collapses to an empty arm while `degraded: false` is reported as long as one arm answered (NEC-024, finding M1); the lexical arm has no ORDER BY under its LIMIT, so the subset is backend-arbitrary and the RRF ranks fed by it carry no relevance signal (NEC-025, finding M2); and a single malformed `describe_status` row makes the store's row mapper throw, poisoning every whole-tenancy scan, which breaks projection rebuilds and empties the enricher (NEC-027, finding M4).

This sub-PRD settles the `<#>` contract with a real-backend probe, makes both arms deterministically and correctly ordered, and makes degradation reporting honest at the search boundary and per-row at the store boundary.

---

## Goals

- Pin down Deep Lake's actual `<#>` return contract with one integration probe and correct whichever side (code or spec) is wrong, with a regression test that exercises real operator semantics.
- Report per-arm outcomes honestly: a ran arm that errored yields `degraded: true` and a machine-readable reason, so "empty index" is distinguishable from "auth broken".
- Give the lexical arm a deterministic, relevance-meaningful ordering under LIMIT.
- Degrade per-row instead of per-scan when a stored `describe_status` value is unrecognized.

## Non-Goals

- Embedding provenance (`embed_model`), provider-switch vector-space mixing (NEC-018), the dim-rejection sink (NEC-028), and inherited-row re-embedding (NEC-019): PRD-018i owns embeddings and projection integrity.
- The enricher-side write visibility that determines which rows are recallable at all (NEC-017): [PRD-018g](./prd-018g-enricher-correctness-and-concurrency.md).
- API authentication and the `?project=` tenancy override (NEC-029): PRD-018j.
- The `ILIKE` `ESCAPE` clause and `limit: 0` boundary items, which the issue list batches under NEC-042: PRD-018l.

---

## NEC-005: Semantic ranking likely inverted

**Issue.** The vector arm orders `(1 + (embedding <#> vec))/2 DESC` while the corpus defines `<#>` as cosine distance ordered ascending. If the spec is right, semantic recall surfaces the least similar files first.

**Evidence** (recall review H1):

- `src/hive-graph/search.ts:121` (score formula), `search.ts:127` (`ORDER BY score DESC`) vs `library/knowledge/private/data/recall-integration-deep-dive/recall-integration-technical-specification.md:113` and `recall-integration.md:64`. The engine scores the semantic arm as:

```ts
const scoreSql = `((1 + (v.${embCol} <#> ${vecLit})) / 2)`;   // search.ts:121
...
`ORDER BY score DESC ` +                                       // search.ts:127
```

- The corpus is explicit that `<#>` is cosine distance ("The `<#>` operator is cosine distance over the 768-dim `embedding` column", deep-dive spec lines 113-117), and the spec's own reference query orders by `v.embedding <#> :query_vector` ascending (smallest distance first). Under that semantics, and equally under the pgvector convention where `<#>` is negative inner product, a larger `(1 + <#>)/2` means a worse match, so `ORDER BY score DESC` returns the least similar files first and the RRF fusion then rewards them. The formula `(1+x)/2` only produces a correct DESC ordering if Deep Lake's `<#>` returns raw cosine similarity in `[-1, 1]`, which contradicts both the spec text and the common operator convention.
- Nothing catches this: `test/hive-graph-search.test.ts` fakes the storage and returns pre-sorted rows (lines 115-126), so the ordering direction is never exercised against real operator semantics, and `parseScoredIds` (`search.ts:268-278`) clamps but never validates direction.

**Failure mode.** Semantic recall silently returns anti-relevant results; leg 3 of the mission gives confidently wrong answers with no error signal anywhere.

**Fix direction.** Pin down Deep Lake's actual `<#>` return contract with one integration probe: embed two known vectors at known angular distances from a query vector and assert which orders first. If it is distance, either `ORDER BY (v.embedding <#> vec) ASC` and score as `1 - distance/2`, or keep the score column but flip to `ASC`. If it is similarity, correct the spec text instead. Add a live-backend (or recorded-fixture) test asserting the near vector outranks the far one so the direction can never silently regress.

---

## NEC-024: Recall error swallowing

**Issue.** Every storage error inside an arm collapses to an empty result, the missing-table classifications are dead code, and `degraded: false` is reported when the semantic arm silently failed.

**Evidence** (recall review M1):

- `src/hive-graph/search.ts:235-250` (catch-all), `search.ts:377` (degraded calculation):

```ts
} catch (err: unknown) {
  if (err instanceof TransportError && isMissingTableError(err)) return [];
  if (err instanceof Error && /table does not exist|no such table/i.test(err.message)) return [];
  return [];   // <- makes the two classifications above dead code
}
```

- Every failure (expired token 401, timeout, 500, malformed SQL) becomes an empty arm. The missing-table classification is dead code; contrast `deeplake-store.ts:289-296`, whose `readTolerant` correctly rethrows non-missing-table errors.
- Combined with `degraded = !semanticRan || (hits.length === 0 && !storageReachable)` (`search.ts:377`): if the vector query fails but the lexical arm answers, the result is lexical-only with `degraded: false`, precisely the silent semantic-to-lexical fallback the flag exists to surface (the spec's sanctioned silent fallback is embeddings-off, `recall-integration.md:64`, not transport failure). If the lexical query fails but the semantic arm answers, half the recall surface vanishes with no signal at all. If credentials expire entirely, every search returns `{hits: [], degraded: true}`, indistinguishable from "no matches yet" for a `--json` consumer, and the CLI's degraded message (`cli.ts:416-419`) attributes it to semantic-only degradation.

**Failure mode.** Real recall failures (auth, network, backend) present as quietly thinner or emptier results; operators cannot distinguish an empty index from a broken deployment.

**Fix direction.** Keep fail-soft, but make it honest: return per-arm status from `runArmFailSoft` (ok / missing-table / error), set `degraded: true` whenever a ran arm errored, and add a distinct reason/sources field so consumers can tell "empty index" from "auth broken". Restore the missing-table classifications to meaning (missing table is the one case that legitimately maps to an empty arm without degradation) or delete them.

---

## NEC-025: Lexical arm has no ORDER BY under LIMIT

**Issue.** The lexical arm emits `WHERE ... ILIKE ... LIMIT n` with no ordering clause, so the returned subset is nondeterministic and the RRF ranks derived from it are meaningless.

**Evidence** (recall review M2):

- `src/hive-graph/search.ts:96-104` (no ORDER BY, `LIMIT ${perArm}`), vs `recall-integration.md:60` (`ORDER BY bm25_score DESC`) and `hive-graph-schema.md:124` (BM25 `deeplake_index` over title/description).
- Consequences: (a) when more than n rows match, the returned subset is backend-arbitrary and matches can flap between identical queries; (b) the row order fed to RRF (`fuseHits`, `search.ts:195-223`, where rank = array index) carries no relevance signal, so the lexical arm's contribution to fusion is effectively random among matched rows. The spec's arm is BM25-scored and ordered; the implementation is a substring filter.
- The corroboration behavior the test asserts ("corroborated hit outranks lexical-only", `test/hive-graph-search.test.ts:190`) only holds because the fake storage returns rows in a chosen order.

**Failure mode.** Identical queries return different result subsets; fusion ranks reward arbitrary rows; the corroboration property the suite asserts does not hold against a real backend.

**Fix direction.** Either adopt the BM25 path the schema doc names (`deeplake_index` / `deeplake_hybrid_record`) with `ORDER BY bm25_score DESC`, or add a deterministic proxy ordering (title-match > description-match > concepts-match, then `nectar` as the tiebreaker) so RRF ranks mean something and result sets are stable between identical queries.

---

## NEC-027: One bad `describe_status` row poisons whole-tenancy scans

**Issue.** The Deep Lake store's row mapper throws on an unrecognized `describe_status`, aborting the entire scan it runs inside; a single malformed row breaks every whole-tenancy read.

**Evidence** (recall review M4):

- `src/hive-graph/deeplake-store.ts:73-78` (`toDescribeStatus` throws), reached from `toVersionRow` (`deeplake-store.ts:125`) inside `reduceLatestVersion`/`reduceLatestDescribedVersion` and therefore `listLatestVersions`, `listLatestDescribedVersions`, `latestVersionByPath`, `latestVersionByHash`, `latestVersion`.
- A single row whose `describe_status` is NULL, empty, or an unrecognized value (a hand-written row, a partially healed legacy table, a future enum addition read by an old daemon) aborts the entire scan: projection rebuilds fail, enricher hydration fails (caught and logged at `cli.ts:666-669`, leaving the enricher permanently empty), and prune/review paths break, for every file in the tenancy, not just the bad row.
- The in-memory store has no such validation, so the two adapters diverge on exactly the dirty-data case the durable one will actually meet. The schema's own heal contract (`hive-graph-schema.md:147`) promises healed columns backfill defaults, but a default of `''` is not in `DESCRIBE_STATUSES` and would throw here.

**Failure mode.** One dirty row silently disables projection rebuilds, empties the enricher, and breaks tenancy-wide reads, with the root cause buried in a single logged hydrate failure.

**Fix direction.** Degrade per-row instead of per-scan in `toDescribeStatus`'s callers: map an unknown status to `"failed"` (or skip the row) with a logged warning, mirroring the fail-soft posture every adjacent module already takes. Keep the two store adapters behaviorally aligned on this case.

---

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| AC-018h.1 | Given a real (or recorded-fixture) Deep Lake backend with two stored vectors at known distances from a query vector, when the semantic arm executes, then the nearer vector's row outranks the farther one. |
| AC-018h.2 | Given the probe's determination of the `<#>` contract, when the fix lands, then the score formula and ORDER BY direction in `search.ts` agree with the measured contract, and whichever of code or spec was wrong is corrected (code fix, or spec text fix recorded in the corpus). |
| AC-018h.3 | Given a semantic-arm storage error (401, timeout, 500) while the lexical arm answers, when the search returns, then `degraded` is `true` and the per-arm status identifies the semantic arm's error. |
| AC-018h.4 | Given a missing table on one arm, when the search returns, then that arm is empty, the outcome is classified missing-table (not error), and results are otherwise served. |
| AC-018h.5 | Given both arms fail with storage errors, when the search returns, then the response distinguishes "backend unreachable/erroring" from "no matches" via the reason/sources field, and the CLI message reflects it rather than attributing it to semantic-only degradation. |
| AC-018h.6 | Given more lexical matches than the per-arm LIMIT, when the same query runs twice against the same data, then both runs return the same subset in the same order. |
| AC-018h.7 | Given lexical matches that differ in where the term matched, when the arm orders them, then the ordering is relevance-meaningful per the chosen scheme (BM25 score, or title-match > description-match > concepts-match, then nectar tiebreak). |
| AC-018h.8 | Given a tenancy containing one version row with an unrecognized `describe_status`, when `listLatestVersions` (or any whole-tenancy read) runs, then the scan completes, the bad row is mapped to `failed` or skipped with a logged warning, and all other rows are returned. |
| AC-018h.9 | Given the same dirty-row case, when enricher hydration and projection rebuild run, then both succeed for the rest of the tenancy (no permanently empty enricher, no failed rebuild). |

---

## Files touched

| File | Change kind | What changes |
|---|---|---|
| `src/hive-graph/search.ts` | modify | Semantic score formula / ORDER BY direction per the probed `<#>` contract (`:121`, `:127`); `runArmFailSoft` returns per-arm status (`:235-250`); honest `degraded` calculation plus reason/sources field (`:377`); lexical arm deterministic ordering (`:96-104`). |
| `src/hive-graph/deeplake-store.ts` | modify | Per-row degradation for unrecognized `describe_status` (`:73-78` and the mapper at `:125`), with a logged warning. |
| `src/hive-graph/memory-store.ts` | modify | Matching unknown-status handling so the adapters stay behaviorally aligned. |
| `src/api/hive-graph-api.ts` | modify | Search response surfaces the per-arm status / degradation reason field. |
| `src/cli.ts` | modify | `nectar search` degraded messaging distinguishes error classes (`:416-419` today attributes everything to semantic-only degradation). |
| `test/hive-graph-search.test.ts` | modify | Per-arm status, degraded-flag, and deterministic-ordering suites. |
| `test/hive-graph-deeplake.test.ts` | modify | Dirty `describe_status` row scan-survival coverage. |
| `test/hive-graph-search-live.test.ts` | create | Credential-gated (or recorded-fixture) integration probe asserting the `<#>` ordering direction against real operator semantics. |
| One corpus spec file (per probe outcome) | modify | If the probe shows `<#>` is similarity, correct `recall-integration.md` / the deep-dive spec text instead of the code (exactly one side changes). |

---

## Tests to add

The recall review's coverage-gap list explicitly names: no test exercises `<#>` ordering against real operator semantics (H1), and no test drives a transport 401/500 mid-search asserting the `degraded` flag (M1). Both are covered below.

| AC | Test file | Scenario |
|---|---|---|
| AC-018h.1, AC-018h.2 | `test/hive-graph-search-live.test.ts` | Seed two rows with known embeddings; query with a vector near one of them; assert the near row ranks first (live backend when credentials resolve, recorded fixture otherwise). |
| AC-018h.3 | `test/hive-graph-search.test.ts` | Fake storage where the vector query rejects with a 401-shaped TransportError and the lexical query answers; assert `degraded: true` and semantic-arm error status. |
| AC-018h.4 | `test/hive-graph-search.test.ts` | Missing-table error on one arm; assert empty arm, missing-table classification, results otherwise served. |
| AC-018h.5 | `test/hive-graph-search.test.ts`, `test/search-cli.test.ts` | Both arms error; assert the reason field distinguishes backend failure from no-matches, and the CLI prints the correct message class. |
| AC-018h.6 | `test/hive-graph-search.test.ts` | Assert the generated lexical SQL carries the deterministic ORDER BY; two identical runs over the same fake data return identical ordered subsets. |
| AC-018h.7 | `test/hive-graph-search.test.ts` | Rows matching in title vs description vs concepts order per the chosen scheme; re-assert the corroboration property (`:190` today) under real ordering rather than fake-storage order. |
| AC-018h.8 | `test/hive-graph-deeplake.test.ts` | Tenancy scan over rows including one with `describe_status: ''`; assert completion, warning, and the bad row mapped to `failed` or skipped. |
| AC-018h.9 | `test/enricher.test.ts`, `test/projection-ac.test.ts` | Hydration and projection rebuild over the dirty-row tenancy both succeed for all clean rows. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-005, NEC-024, NEC-025, NEC-027)
- [`../../../notes/2026-07-02-recall-review.md`](../../../notes/2026-07-02-recall-review.md) (findings H1, M1, M2, M4 and the coverage-gap list)
- [`../../../notes/2026-07-02-executive-summary.md`](../../../notes/2026-07-02-executive-summary.md) (mission leg 3 verdict and suggested-order item 3)
- [`../../../knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) (the `<#>` ascending reference query at `:64`, BM25 ordering at `:60`)
- [`../../../knowledge/private/data/recall-integration-deep-dive/recall-integration-technical-specification.md`](../../../knowledge/private/data/recall-integration-deep-dive/recall-integration-technical-specification.md) (the `<#>` cosine-distance definition at `:113`)
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) (BM25 index at `:124`, the heal-default contract at `:147`)
- [`./prd-018g-enricher-correctness-and-concurrency.md`](./prd-018g-enricher-correctness-and-concurrency.md) (adjacent: whether described rows are durably visible to this surface)
