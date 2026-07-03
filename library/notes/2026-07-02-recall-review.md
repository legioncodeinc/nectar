# Recall-Leg Review — hive-graph search, embeddings, enricher

> Date: 2026-07-02 | Scope: `src/hive-graph/*`, `src/embeddings/*`, `src/enricher/*` (plus the wiring in `src/api/daemon-api-wiring.ts` and `src/cli.ts` where it determines recall behavior) | Spec grounding: `library/knowledge/private/data/hive-graph-schema.md`, `recall-integration.md`, and their deep-dive technical specifications.

## Summary

The recall leg is well-layered (guarded SQL builders, injectable transports, fail-soft embed providers) and the SQL-injection floor is genuinely solid: every dynamic value in `search.ts`, `deeplake-store.ts`, `pending-query.ts`, and `sql-update.ts` routes through `sql-guards.ts`, and the guards themselves are correct for their stated model. The serious problems are elsewhere. The semantic arm's score formula and `ORDER BY score DESC` contradict the spec's own definition of `<#>` as cosine *distance*, which — if the spec is right about the operator — inverts the vector arm so it surfaces the *least* similar files first. The enricher has a batch/index misalignment that can attach an LLM description (and its embedding) to the wrong file when a file is deleted mid-batch. The live enricher's working set is hydrated exactly once at daemon boot and its durable write-back is fire-and-forget over an UPDATE pattern the codebase itself documents as unreliable on this backend, so "update it upon change" degrades silently in several ways. Finally, the search engine swallows *every* storage error into empty rows while reporting `degraded: false` as long as one arm answered, which converts real recall failures into quietly thinner results. Findings below are ordered by severity; all line numbers were verified against the working tree on 2026-07-02.

---

## High

### H1. Vector-arm ranking direction contradicts the spec's `<#>` semantics — semantic recall may be inverted

**Where:** `src/hive-graph/search.ts:121` (score formula), `search.ts:127` (`ORDER BY score DESC`) vs `library/knowledge/private/data/recall-integration-deep-dive/recall-integration-technical-specification.md:113` and `recall-integration.md:64`.

The engine scores the semantic arm as:

```ts
const scoreSql = `((1 + (v.${embCol} <#> ${vecLit})) / 2)`;   // search.ts:121
...
`ORDER BY score DESC ` +                                       // search.ts:127
```

The corpus is explicit that `<#>` is **cosine distance** ("The `<#>` operator is cosine distance over the 768-dim `embedding` column", deep-dive spec line 113–117), and the spec's own reference query orders by `v.embedding <#> :query_vector` **ascending** (smallest distance first). Under that semantics — and equally under the pgvector convention where `<#>` is negative inner product — a *larger* `(1 + <#>)/2` means a *worse* match, so `ORDER BY score DESC` returns the least similar files first, and the RRF fusion then rewards them. The formula `(1+x)/2` only produces a correct DESC ordering if Deep Lake's `<#>` returns raw cosine *similarity* in `[-1, 1]`, which contradicts both the spec text and the common operator convention.

**Failure mode:** semantic recall silently returns anti-relevant results. Nothing catches this: `test/hive-graph-search.test.ts` fakes the storage and returns pre-sorted rows (lines 115–126), so the ordering direction is never exercised against real operator semantics, and `parseScoredIds` (`search.ts:268-278`) clamps but never validates direction.

**Fix direction:** pin down Deep Lake's actual `<#>` return contract with one integration probe (two known vectors, assert which orders first). If it is distance, either `ORDER BY (v.embedding <#> vec) ASC` and score as `1 - distance/2`, or keep the score column but flip to `ASC`. Add a live-backend (or recorded-fixture) test asserting the near vector outranks the far one.

### H2. Enricher batch describe can attach descriptions to the wrong files (TOCTOU index misalignment)

**Where:** `src/enricher/cycle.ts:117-121` (first content read builds `files`) and `cycle.ts:138-146` (second content read drives `fileIdx` alignment).

`describeWorkBatch` reads each work item's content **twice**: once to build the `files` array sent to the LLM (117–121), and again after the LLM call to walk `batch.descriptions` with a manually-advanced `fileIdx` (138–146):

```ts
for (const item of items) {
  const content = deps.readContent.read(item.row.path);  // second read, cycle.ts:139
  if (content === null) continue;                        // skips WITHOUT consuming fileIdx
  const payload = batch.descriptions[fileIdx];
  fileIdx += 1;
  ...
```

`parseDescribeResponse` guarantees `descriptions.length === files.length` (`describe.ts:63`), so alignment depends entirely on the second read returning null for exactly the same items as the first. The LLM call between the two reads can take seconds to minutes. If a file is deleted (or becomes unreadable) in that window, its description is never consumed and **every subsequent item in the batch receives the previous file's description, title, concepts, and embedding**. The corrupted rows are then written as `describe_status = 'described'` and served by recall indefinitely — a poisoned index with no error anywhere.

**Fix direction:** read content exactly once per item; build `files` and a parallel `included: EnricherWorkItem[]` array in the same loop, then zip `included[i]` with `descriptions[i]`. The deleted-in-window case then falls out naturally (the file was described from the content that existed; the next observation supersedes it).

### H3. Live enricher working set is frozen at boot; post-boot pending/failed rows are never enriched until restart

**Where:** `src/enricher/store-adapter.ts:57-61` (`hydrate` is the only seeding path), `src/cli.ts:584-596` (hydrate seam wired to `listLatestVersions`), `src/cli.ts:665-670` (hydrate called exactly once, at daemon start).

`DeepLakeEnricherStore` reads all pending work from its in-memory mirror; the mirror is seeded solely by `hydrate(tenancy)`, and the daemon calls it once, in the background, after bind (`cli.ts:665`). Nothing re-seeds afterward: version rows appended to Deep Lake after boot (a `POST /api/hive-graph/build` brood that leaves `failed` rows, rows synced from a teammate per the team-share path in `recall-integration.md` §fresh-clone, or any future watcher wiring) are invisible to `listPendingWork` until the next daemon restart. Additionally, `cli.ts:584-586` hydrates from `listLatestVersions` (latest-per-nectar) even though the seam's own contract (`store-adapter.ts:33-36`) asks for "EVERY version row … full history"; the docblock at `cli.ts:552-560` acknowledges the cosmetic-inherit degradation but not the frozen-working-set consequence.

**Failure mode:** stale recall after change — files whose describe failed or arrived after boot sit at `pending`/`failed` forever (recall filters `describe_status = 'described'`, so they simply never appear), while `countPending` on the mirror under-reports the real queue.

**Fix direction:** re-hydrate periodically (e.g., every N enricher cycles, or a cheap `WHERE describe_status IN ('pending','failed')` poll straight against the durable store via `buildPendingWorkSql`, which already exists at `pending-query.ts:25-41` and is currently used by nothing in production), or push registration/brood appends into the mirror at write time.

### H4. Enrichment durability and visibility rest on a fire-and-forget in-place UPDATE the codebase itself documents as unreliable

**Where:** `src/enricher/store-adapter.ts:93-99` (fire-and-forget write-back), `src/enricher/sql-update.ts:11-30` (in-place `UPDATE "hive_graph_versions"`), contradicting `src/hive-graph/schema.ts:79-84` (`writePattern: "append-only"` for that table) and the caveat at `src/hive-graph/deeplake-store.ts:344-359` (honeycomb *retired* in-place UPDATE on this backend because point reads can return pre-update snapshots from stale segments).

Two compounding issues:

1. `updateVersion` updates the mirror synchronously, then fires the durable write with `void … .catch(onWriteBackError)` (`store-adapter.ts:96-98`). A failed write-back only prints one stderr line (`cli.ts:590-594`); the cycle still counts the file as described, the projection is rebuilt from the (in-memory) store, and the durable row stays `pending`. Recall queries Deep Lake directly (`daemon-api-wiring.ts:104`), so the file is **not recallable** even though the daemon believes enrichment succeeded — until a restart re-hydrates and re-describes it (paying the LLM cost again).
2. Even when the write-back succeeds, it is an in-place `UPDATE` on `hive_graph_versions` — the exact write shape `deeplake-store.ts:344-359` documents as not reliably visible under load on this backend, and a direct contradiction of the table's declared `append-only` write pattern in `schema.ts:82`. The recall arm's `describe_status = 'described'` filter reads whatever segment the backend serves; a stale segment keeps returning the pre-update `pending` row.

**Fix direction:** decide the write pattern once. Either adopt the version-bump append the honeycomb history points to (append a new row at `seq+1` carrying the description; the latest-described subquery already selects it naturally), or keep UPDATE but make the write-back awaited within the cycle with bounded retry, and only count `filesDescribed`/skip re-enrichment after the durable write is confirmed.

### H5. Switching embedding providers silently mixes incompatible vector spaces; nothing records which model produced a stored embedding

**Where:** `src/embeddings/provider.ts:36-39` (operator-switchable `local`/`hosted`), `src/embeddings/hosted-portkey.ts:44-51` (`text-embedding-3-small` at 768 dims), `src/hive-graph/schema.ts:59` (`embedding FLOAT4[]` with no provenance column), `library/knowledge/private/data/hive-graph-schema.md:108` (`describe_model` records the *description* LLM only).

Local nomic (`nomic-embed-text-v1.5`) and hosted OpenAI (`text-embedding-3-small`, `dimensions: 768`) both emit 768-dim vectors, so the dim guard (`guard.ts:54-70`) cannot distinguish them. When an operator flips `NECTAR_EMBEDDINGS_PROVIDER` from `local` to `hosted` (or back), every stored embedding remains from the old space while query vectors come from the new one — cosine similarity across the two spaces is meaningless, so the semantic arm returns pseudo-random rankings with `degraded: false`. There is no `embed_model` column, no invalidation, and no re-embed pass, so the corruption is undetectable and permanent until every row is re-described. (Related: nomic-embed-text-v1.5 is an asymmetric model requiring `search_document:`/`search_query:` task prefixes; nectar sends raw text for both the enricher's document embeds (`cycle.ts:75-86`) and the recall query embed (`daemon-api-wiring.ts:110-113`) to the same `/embed` endpoint, delegating prefixing entirely to the external daemon — worth verifying the daemon actually distinguishes the two, since a uniform document prefix on queries measurably degrades retrieval.)

**Fix direction:** add a nullable `embed_model` column via the catalog (heal-additive, per the schema doc's own rule at `hive-graph-schema.md:145-149`), stamp it at write, and have the semantic arm filter (or the daemon warn) when stored `embed_model` disagrees with the active provider; queue mismatched rows for re-embedding.

---

## Medium

### M1. `runArmFailSoft` swallows every storage error into empty rows, and a semantic-arm failure reports `degraded: false`

**Where:** `src/hive-graph/search.ts:235-250` (catch-all), `search.ts:377` (degraded calculation).

```ts
} catch (err: unknown) {
  if (err instanceof TransportError && isMissingTableError(err)) return [];
  if (err instanceof Error && /table does not exist|no such table/i.test(err.message)) return [];
  return [];   // <- makes the two classifications above dead code
}
```

Every failure — expired token (401), timeout, 500, malformed SQL — becomes an empty arm. The missing-table classification is dead code (contrast `deeplake-store.ts:289-296`, whose `readTolerant` correctly rethrows non-missing-table errors). Combined with `degraded = !semanticRan || (hits.length === 0 && !storageReachable)` (`search.ts:377`):

- If the **vector** query fails but the lexical arm answers, the result is lexical-only with `degraded: false` — precisely the "silent fallback from semantic to lexical" the `degraded` flag exists to surface (the spec's sanctioned silent fallback is embeddings-*off*, `recall-integration.md:64`, not transport failure).
- If the **lexical** query fails but the semantic arm answers, half the recall surface vanishes with no signal at all.
- If credentials expire entirely, every search returns `{hits: [], degraded: true}` — indistinguishable from "no matches yet" for a `--json` consumer, and the CLI's degraded message (`cli.ts:416-419`) attributes it to semantic-only degradation.

**Fix direction:** keep fail-soft, but make it honest: return per-arm status from `runArmFailSoft` (ok / missing-table / error), set `degraded: true` whenever a ran arm errored, and consider a distinct `sources`/reason field so operators can tell "empty index" from "auth broken". At minimum, delete the dead classifications or restore their meaning.

### M2. Lexical arm is unranked: no ORDER BY under LIMIT, so RRF fuses noise; spec expects BM25 ordering

**Where:** `src/hive-graph/search.ts:96-104` (no ORDER BY, `LIMIT ${perArm}`), vs `recall-integration.md:60` (`ORDER BY bm25_score DESC`) and `hive-graph-schema.md:124` (BM25 `deeplake_index` over title/description).

`buildHiveGraphLexicalArmSql` emits `WHERE … ILIKE … LIMIT n` with no ordering clause. Consequences: (a) when more than `n` rows match, the returned subset is backend-arbitrary — matches can flap between identical queries; (b) the row order fed to RRF (`fuseHits`, `search.ts:195-223`, where rank = array index) carries no relevance signal, so the lexical arm's contribution to fusion is effectively random among matched rows. The spec's arm is BM25-scored and ordered; the implementation is a substring filter. This also means the corroboration behavior the test asserts ("corroborated hit outranks lexical-only", `test/hive-graph-search.test.ts:190`) only holds because the fake storage returns rows in a chosen order.

**Fix direction:** either adopt the BM25 path the schema doc names (`deeplake_index` / `deeplake_hybrid_record`) with `ORDER BY bm25_score DESC`, or add a deterministic proxy ordering (e.g., title-match > description-match > concepts-match, then `nectar`) so RRF ranks mean something and result sets are stable.

### M3. Cosmetic-change inheritance (Jaccard gate) is dead code — every edit re-describes, and nothing can ever set `filesInherited`

**Where:** `src/enricher/meaningful-change.ts:33-37` (`classifyMeaningfulChange`), `src/enricher/jaccard.ts`, exported via `src/enricher/index.ts:24-26`, but invoked by **no runtime path** (verified: only definition, re-export, and `test/enricher.test.ts` reference them; `src/enricher/cycle.ts` never calls them). `filesInherited` (`observability.ts:9`) is checked by the loop (`loop.ts:38`) yet no code increments it.

PRD-016a's cosmetic/meaningful gate (threshold `DEFAULT_REDESCRIBE_THRESHOLD = 0.85`, `config.ts:15`) was built and unit-tested but never wired into the cycle: `runEnricherCycle` sends every pending row to the LLM regardless of similarity to the prior described version. The failure mode is the *inverse* of gate-blocks-legit-updates: whitespace reformats, comment tweaks, and license-header churn each pay a full describe + embed round-trip (cost, latency, and description churn in recall). `cli.ts:552-560` further documents that even if it were wired, `priorDescribedVersion` has no durable history after a cold boot, so the gate would silently never fire on the live path.

**Fix direction:** wire `classifyMeaningfulChange`/`applyCosmeticInheritance` into the cycle before batching (needs prior content, which suggests keying off the prior version's `content_hash` + a content cache, or comparing against the projection), or explicitly delete the module and the PRD claim before release so the shipped behavior matches the documented one.

### M4. One malformed `describe_status` value poisons every whole-tenancy read in the Deep Lake store

**Where:** `src/hive-graph/deeplake-store.ts:73-78` (`toDescribeStatus` throws), reached from `toVersionRow` (`deeplake-store.ts:125`) inside `reduceLatestVersion`/`reduceLatestDescribedVersion` and therefore `listLatestVersions`, `listLatestDescribedVersions`, `latestVersionByPath`, `latestVersionByHash`, `latestVersion`.

A single row whose `describe_status` is NULL, empty, or an unrecognized value (a hand-written row, a partially-healed legacy table, a future enum addition read by an old daemon) makes `toDescribeStatus` throw, which aborts the entire scan: projection rebuilds fail, enricher hydration fails (caught and logged at `cli.ts:666-669`, leaving the enricher permanently empty), and prune/review paths break — for every file in the tenancy, not just the bad row. The in-memory store has no such validation, so the two adapters diverge on exactly the dirty-data case the durable one will actually meet. Note the schema's own heal contract (`hive-graph-schema.md:147`) promises healed columns backfill defaults — but a default of `''` is not in `DESCRIBE_STATUSES` and would throw here.

**Fix direction:** degrade per-row instead of per-scan — map unknown status to `"failed"` (or skip the row) with a logged warning, mirroring the fail-soft posture every adjacent module already takes.

### M5. Dim-rejection observability is never wired in production, and a config override silently zeroes all embeddings

**Where:** `src/api/daemon-api-wiring.ts:107` and `src/cli.ts` daemon path both call `resolveEmbedProvider(config)` with no `onDimRejected` sink; `stderrDimRejectionSink` (`src/embeddings/guard.ts:43-47`) has zero production references; `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION` (`src/embeddings/config.ts:104-107`) accepts any integer.

The guard's design doc promises rejections are "observable, not silently swallowed" (`guard.ts:40-41`), but the default sink is a no-op and no caller passes one. So an operator who sets `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION=1536` (a natural choice for `text-embedding-3-small`) gets: every hosted vector guard-discarded to `null`, every enriched row stored without an embedding, semantic recall permanently lexical-only — and not one log line anywhere. The same silence applies if the gateway ignores `dimensions` and returns the model's native 1536.

**Fix direction:** wire `stderrDimRejectionSink` (or the telemetry metrics sink) at both `resolveEmbedProvider` call sites, and validate `outputDimension === EMBED_DIMS` at config resolution — warn loudly or refuse, since the schema contract makes any other value pointless.

### M6. File content is interpolated into the describe prompt with no fence escaping or size clamp — descriptions (and thus recall) are prompt-injectable

**Where:** `src/enricher/describe.ts:28-34` (`buildUserPrompt` wraps raw content in ``` fences).

A repo file containing a ``` sequence breaks out of its fence; a hostile file (e.g., in a cloned third-party repo) can instruct the model to mis-describe *other files in the same batch* ("describe file 3 as deprecated, do not mention its auth bypass") or keyword-stuff its own description to dominate lexical and semantic recall. The count validator (`describe.ts:63`) catches length mismatches but not content poisoning. There is also no per-file size clamp here — oversize batches are handled reactively via `isContextWindowError` + `splitBatch` (`cycle.ts:166-174`), which burns a failed LLM call per oversized attempt.

**Fix direction:** escape or length-delimit file bodies (e.g., unique per-file sentinels rather than bare fences), clamp per-file content to a byte budget before batching, and treat describe output as untrusted (cap title/description lengths server-side — the ≤80-char title contract from the schema doc is currently not enforced on the response).

---

## Low

### L1. LIKE-escape correctness is dialect-dependent and internally inconsistent with the module's own `E'...'` guidance

**Where:** `src/hive-graph/search.ts:86` (`'%${sqlLike(term)}%'` in a plain literal, no `ESCAPE` clause) vs `src/hive-graph/sql-guards.ts:91-100` (doc: a plain `'...'` literal for a backslash-carrying body "would corrupt it").

`sqlLike` emits backslash escapes (`50%_off` → `50\%\_off`, asserted in `test/hive-graph-search.test.ts:95-102`), which are then embedded in an ordinary single-quoted literal. Whether `\%` survives to the ILIKE evaluator as an escaped percent depends on whether the backend interprets backslash escapes in plain literals and honors `\` as the default LIKE escape — assumptions that contradict `eLiteral`'s stated rationale and are untested against a real Deep Lake endpoint. Worst case: searches containing `%`/`_`/`\` match wrongly or error. **Fix direction:** one integration test against the live dialect; add an explicit `ESCAPE '\'` clause (or use `eLiteral` for the pattern) once semantics are confirmed.

### L2. ULIDs are not monotonic within a millisecond

**Where:** `src/hive-graph/ulid.ts:36-38`.

`mintNectar` draws fresh randomness per call with no same-ms monotonic counter (the standard `ulid` package's `monotonicFactory` behavior), so two nectars minted in the same millisecond sort arbitrarily relative to each other. The module doc claims "lexicographic sortability by creation time" — true only to ms granularity. Collision resistance (80 random bits) is fine, and nothing in the recall leg depends on sub-ms ordering; flagged so the public docs don't over-claim. **Fix direction:** either add the monotonic-within-ms counter or soften the doc claim.

### L3. `latestVersionByPath` / `latestVersionByHash` fetch the entire tenancy per lookup

**Where:** `src/hive-graph/deeplake-store.ts:476-484` delegating to `listLatestVersions` (`:410-438`), which issues two full-table-scans-per-tenancy and reduces client-side.

Each by-path/by-hash probe is O(all identities + all version rows). Acceptable for today's unwired ladder (docblock at `:399-409` acknowledges it), but this is a per-file-event hot path the moment the registration ladder is bridged to the async store — worth a `WHERE path = …`/`WHERE content_hash = …` pushdown before that lands. **Fix direction:** predicate pushdown + keep the client-side MAX(seq) reduction.

### L4. `deleteNectar` tenancy-guard shape diverges between adapters

**Where:** `src/hive-graph/memory-store.ts:109-115` (refuses the whole delete when the *identity* is outside the tenancy) vs `src/hive-graph/deeplake-store.ts:499-508` (per-row tenancy predicate on both DELETEs).

If a nectar's version rows ever carry a different `project_id` than its identity row (denormalization drift), the in-memory store deletes nothing while the Deep Lake store deletes the matching version rows and leaves the identity — a partial delete the sync twin would never produce. Only reachable via data drift, hence Low. **Fix direction:** have the Deep Lake path probe the identity's tenancy first (one guarded SELECT) and no-op on mismatch, matching AC-20's in-memory semantics exactly.

### L5. `resolveRecallLimit(0)` silently becomes 20, and the API accepts `limit` floats

**Where:** `src/hive-graph/search.ts:44-50`, `src/api/hive-graph-api.ts:92-99`.

`limit: 0` (a plausible "just tell me if anything matches" probe) returns the default 20 rows rather than erroring or returning 0; `limit: 2.9` truncates to 2. Both are tested/intended (`test/hive-graph-search.test.ts:64-70`) but surprising at the HTTP boundary where the CLI validates strictly (`cli.ts:365-384`) and the API does not. **Fix direction:** reject non-positive/non-integer limits with a 400 at `parseSearchRequest`, keeping the engine clamp as backstop.

### L6. Credentials file is read with no permissions check

**Where:** `src/hive-graph/deeplake-credentials.ts:91-125`.

The loader validates shape and redacts well (`redactToken`, `:133-136`), but never checks the mode of `~/.deeplake/credentials.json`; a 0644 token file is consumed without warning. Nectar is not the file's writer, so this is advisory. **Fix direction:** warn on group/other-readable modes at load, mirroring ssh's posture.

---

## Spec-conformance notes (non-defect)

- The `nectar_rrf_multiplier` config knob (`recall-integration.md:103-116`) is unimplemented; `search.ts:194` explicitly scopes fusion to "no cross-table arm-class weighting". Fine for the standalone engine, but the public doc should stop promising the knob until it exists.
- The spec's `deeplake_hybrid_record` fused path (`hive-graph-schema.md:126`) is not used; the engine implements its own two-arm RRF. Intentional per PRD-012a ("mirrors honeycomb recall arm mechanics"), noted for doc alignment.
- `embedding IS NOT NULL` gating from the spec is implemented as `ARRAY_LENGTH(v.embedding, 1) > 0` (`search.ts:126`) — equivalent under SQL NULL semantics, and also correctly excludes empty arrays.
- Coverage gaps worth closing before release: no test exercises `<#>` ordering against real operator semantics (H1), enricher deletion *during* the describe call (H2), a transport 401/500 mid-search asserting the `degraded` flag (M1), or a provider switch against pre-existing embeddings (H5). Existing suites (`test/hive-graph-search.test.ts`, `test/hive-graph-deeplake.test.ts`, `test/enricher.test.ts`, `test/embeddings-*.test.ts`, `test/search-cli.test.ts`) are solid on the injection floor, fail-soft floors, limit clamping, dim guard, and retry bounds.
