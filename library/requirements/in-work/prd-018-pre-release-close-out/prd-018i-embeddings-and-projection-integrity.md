# PRD-018i: Embeddings and projection integrity

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** One additive nullable column: `embed_model TEXT` on `hive_graph_versions`, added via the catalog heal path per the schema doc's additive rule (`hive-graph-schema.md:145-149`). This is the ONLY schema change in all of PRD-018.

---

## Overview

This epic closes four defects that silently corrupt or degrade the vector half of recall and the identity integrity of the portable projection: provider switches mixing incompatible embedding spaces (NEC-018), fresh clones stuck on BM25-only recall forever (NEC-019), a config typo that nulls every embedding with zero log lines (NEC-028), and duplicate-content files collapsing onto one nectar during projection inherit (NEC-037).

The mission is to "analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed." Leg 3 (recall) depends on two invariants this epic restores: stored embeddings must be comparable to query embeddings (same model, same dimension, observable when they are not), and every file the projection inherits must eventually carry both its own identity and its own embedding. Today all four defects fail with `degraded: false`: recall looks healthy while returning pseudo-random vector rankings, permanently lexical-only results, or descriptions attached to orphaned identities.

## Goals

- Every version row written with an embedding records which model produced it (`embed_model`), and the semantic arm never compares vectors across models undetected: mismatched rows are filtered or loudly warned about, and queued for re-embedding.
- Inherited projection rows are re-embedded on first boot when a provider is available, honoring the promise at `portable-registry.md:85`.
- Embedding dimension rejections are observable in production, and a wrong `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION` is caught at config resolution rather than silently nulling every vector.
- Duplicate-content files each keep their own nectar through projection inherit: no duplicate seq-0 rows, no orphaned identities.

## Non-Goals

- Enricher pending-selection mechanics, working-set hydration freshness, and the brood/enricher concurrency races. Those belong to PRD-018g (enricher correctness and concurrency). This epic only ensures inherited rows land in a state the existing pending selector can see.
- Semantic ranking direction (the `<#>` distance-vs-similarity question, NEC-005) and recall error honesty (NEC-024, NEC-025, NEC-027). Those belong to PRD-018h.
- Brooding durability, memory residency, and batch-parse robustness (NEC-003, NEC-012, NEC-013, NEC-014). Those belong to PRD-018e and PRD-018f.
- Documentation claims about clone recall in the public guides. PRD-018l owns the docs truth pass.

---

## NEC-018: Switching embedding providers mixes vector spaces undetected

**Issue restated.** Local nomic (`nomic-embed-text-v1.5`) and hosted OpenAI (`text-embedding-3-small` requested at 768 dims) both emit 768-dim vectors. Nothing records which model produced a stored embedding, so flipping `NECTAR_EMBEDDINGS_PROVIDER` leaves every stored vector in the old space while query vectors arrive from the new one. Cosine comparison across the two spaces is meaningless.

**Evidence** (recall review, H5):

- `src/embeddings/provider.ts:36-39` (operator-switchable `local`/`hosted` selector)
- `src/embeddings/hosted-portkey.ts:44-51` (`text-embedding-3-small` at 768 dims)
- `src/hive-graph/schema.ts:59` (`embedding FLOAT4[]` with no provenance column)
- `library/knowledge/private/data/hive-graph-schema.md:108` (`describe_model` records the description LLM only; nothing records the embedding model)
- Dim guard cannot distinguish the two spaces: `src/embeddings/guard.ts:54-70` checks length only

**Failure mode.** After a provider flip, the semantic arm returns pseudo-random rankings with `degraded: false`. There is no invalidation and no re-embed pass, so the corruption is undetectable and permanent until every row is re-described.

**Fix direction** (expanded from the recall review):

1. Add a nullable `embed_model TEXT` column to `hive_graph_versions` via the catalog heal path, per the schema doc's additive rule (`hive-graph-schema.md:145-149`): no DDL pre-step, heal-on-first-write, old rows read back as null. This is the single schema change in the whole PRD-018 close-out; every other sub-PRD is schema-neutral.
2. Stamp `embed_model` at write time wherever an embedding is persisted (brood embed stage, enricher write-back, any future re-embed path). Rows persisted with `embedding: null` carry `embed_model: null`.
3. At recall time, the semantic arm filters rows whose `embed_model` disagrees with the active provider's model (or, at minimum, the daemon logs a loud mismatch warning at boot when stored models disagree with the active provider).
4. Queue mismatched rows for re-embedding so the index converges back to a single space.

**Verification item (nomic task prefixes).** nomic-embed-text-v1.5 is an asymmetric model requiring `search_document:` / `search_query:` task prefixes. Nectar sends raw text for both the enricher's document embeds (`src/enricher/cycle.ts:75-86`) and the recall query embed (`src/api/daemon-api-wiring.ts:110-113`) to the same `/embed` endpoint, delegating prefixing entirely to the external daemon. This epic must verify whether the daemon actually distinguishes the two calls; a uniform document prefix applied to queries measurably degrades retrieval. Record the outcome as a test or a documented finding.

---

## NEC-019: Fresh clones get permanently degraded recall (inherited rows never re-embed)

**Issue restated.** Projection inherit writes rows with `embedding: null` and `describeStatus: "described"`. The enricher's pending selector picks up only `pending` (and `failed`) rows, so inherited rows are never re-embedded. A fresh clone's semantic recall is BM25-only, forever.

**Evidence** (spec-drift review, drift matrix row 8; recall review):

- `src/projection/inherit.ts:85,90` (inherited rows written `embedding: null`, status `described`)
- `src/enricher/pending-query.ts:30-40` (selector is `WHERE describe_status IN ('pending', 'failed')`; `described` rows are invisible to it)
- Spec promise contradicted: `portable-registry.md:85` says inherited files' embeddings are "recomputed on first daemon boot when a provider is available"

**Failure mode.** The team-share story (clone the repo, inherit the projection, get working recall) silently ships half of itself: titles and descriptions inherit, but the vector arm never sees those files. `degraded` stays false because the lexical arm answers.

**Fix direction.** Write inherit rows in a state the enricher's pending selector sees, for example `embedding: null` plus a status the selector matches, so the existing 30s enricher cycle picks them up and embeds them once a provider is available. Two constraints:

1. The inherited `title`/`description`/`concepts` must be preserved. The goal is a re-embed, not a paid re-describe; the implementation should let the enricher (or a dedicated re-embed pass) compute the embedding over the inherited `title + ' ' + description` without a new LLM describe call.
2. Whatever state is chosen must be stamped with `embed_model` on completion (NEC-018 above), so a clone inheriting rows embedded by a different provider converges correctly too.

Coordination note: the mechanics of what the pending selector does with these rows (batching, failure handling, hydration freshness) stay in PRD-018g; this epic owns only the inherit-side write so the rows are visible at all.

---

## NEC-028: Embedding dim-rejection sink is never wired; a wrong output dimension silently nulls all embeddings

**Issue restated.** The dim guard's design promises rejections are "observable, not silently swallowed", but the default sink is a no-op and no production caller passes one. An operator who sets `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION=1536` (a natural choice for `text-embedding-3-small`) gets every hosted vector guard-discarded to `null`, every enriched row stored without an embedding, and semantic recall permanently lexical-only, with not one log line anywhere.

**Evidence** (recall review, M5):

- `src/api/daemon-api-wiring.ts:107` and the `src/cli.ts` daemon path both call `resolveEmbedProvider(config)` with no `onDimRejected` sink
- `src/embeddings/guard.ts:43-47` (`stderrDimRejectionSink` exists with zero production references; the observability promise is at `guard.ts:40-41`)
- `src/embeddings/config.ts:104-107` (`NECTAR_EMBEDDINGS_OUTPUT_DIMENSION` accepts any integer)

**Failure mode.** Misconfiguration is indistinguishable from healthy operation. The same silence applies if the gateway ignores the `dimensions` request parameter and returns the model's native 1536.

**Fix direction.**

1. Wire `stderrDimRejectionSink` (or the telemetry metrics sink) at both `resolveEmbedProvider` call sites (`src/api/daemon-api-wiring.ts:107` and the `src/cli.ts` daemon path).
2. Validate `outputDimension === EMBED_DIMS` at config resolution: warn loudly or refuse to start, since the schema contract makes any other value pointless.

---

## NEC-037: Duplicate-content files collapse to one nectar on projection inherit

**Issue restated.** The projection's content-hash index maps `content_hash -> (nectar, entry)` with last-writer-wins. Repos routinely contain byte-identical files (empty `__init__.py`, license copies, re-export stubs). On a fresh clone, every such path hash-matches the same single index entry, and inherit emits one row per path all carrying the same nectar at `seq: 0`.

**Evidence** (brooding review, M1):

- `src/projection/load.ts:271-279` (`buildContentHashIndex` is last-writer-wins per hash)
- `src/projection/inherit.ts:118-136` (the `existing` set is never updated inside the inherit loop, so every duplicate path receives the same nectar)
- `src/brooding/pipeline.ts:341-346` and `src/brooding/pipeline-async.ts:231-236` (the brood guards the identity insert but appends every version row)

**Failure mode.** One nectar ends up with N seq-0 rows at different paths (ambiguous `latestVersion` resolution), and the other originally-minted nectars for those duplicate files are orphaned: their identity and description history are silently lost on the clone.

**Fix direction** (expanded from the brooding review):

1. Index `content_hash -> nectar[]` instead of a single entry.
2. Consume one nectar per matched path, tracking assignments within the inherit loop so no nectar is handed out twice.
3. When duplicate paths outnumber the projection entries for that hash, mint fresh nectars for the extras rather than reusing a consumed one.

---

## Acceptance criteria

| ID | Acceptance criterion |
|---|---|
| AC-018i.1 | Given a daemon with an active embedding provider, when a version row is persisted with a non-null embedding, then `embed_model` on that row records the producing model id; rows persisted with `embedding: null` carry `embed_model: null`. |
| AC-018i.2 | Given a `hive_graph_versions` table created before this PRD (no `embed_model` column), when the first write after upgrade occurs, then the catalog heal path adds the column additively with no DDL pre-step, and pre-existing rows read back with `embed_model` null. |
| AC-018i.3 | Given stored rows whose `embed_model` disagrees with the active provider's model, when a semantic search runs, then those rows do not contribute cross-space cosine comparisons (they are filtered from the vector arm, or the daemon has emitted a loud boot-time mismatch warning per the chosen design), and the mismatched rows are queued for re-embedding. |
| AC-018i.4 | Given the local nomic provider, when document embeds (enricher path) and query embeds (recall path) are requested, then a test or recorded verification confirms whether the external embed daemon applies distinct `search_document:` / `search_query:` task prefixes to the two call shapes; the outcome is captured in the test suite or a knowledge-doc note. |
| AC-018i.5 | Given a fresh clone with a valid committed projection, when the daemon boots and inherit runs, then inherited rows are written in a state the enricher's pending selector (`pending-query.ts:30-40`) matches, with inherited `title`/`description`/`concepts` preserved. |
| AC-018i.6 | Given inherited rows awaiting re-embed and an available provider, when an enricher cycle completes, then those rows carry a 768-dim embedding stamped with the active `embed_model`, and no describe LLM call was made for rows whose inherited description was preserved. |
| AC-018i.7 | Given `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION` set to any value other than `EMBED_DIMS`, when config resolves, then the daemon warns loudly or refuses to start (per the chosen posture); it never proceeds silently. |
| AC-018i.8 | Given a provider that returns a wrong-dimension vector at runtime, when the guard discards it, then the rejection is emitted through a wired sink (stderr or telemetry metrics) at both `resolveEmbedProvider` call sites; a no-op sink is no longer the production default. |
| AC-018i.9 | Given a projection containing N entries that share one `content_hash` and a clone with N matching paths, when inherit runs, then each path consumes a distinct nectar from that hash's entry list, and no nectar receives two seq-0 rows. |
| AC-018i.10 | Given more duplicate-content paths on disk than projection entries for that hash, when inherit runs, then the surplus paths mint fresh nectars, and previously-minted nectars for the duplicates are not orphaned by reuse elsewhere in the same loop. |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/hive-graph/schema.ts` | modify | Add nullable `embed_model TEXT` to the `hive_graph_versions` column set (the table's only new column). |
| `src/hive-graph/deeplake-heal.ts` | modify | Heal path covers `embed_model` additively per `hive-graph-schema.md:145-149`. |
| `src/hive-graph/deeplake-store.ts` | modify | Stamp `embed_model` on version-row appends carrying embeddings; map the column on read. |
| `src/hive-graph/memory-store.ts` | modify | Parity with the durable store for `embed_model`. |
| `src/hive-graph/search.ts` | modify | Vector arm filters on `embed_model` match with the active provider (or feeds the boot warning path). |
| `src/embeddings/config.ts` | modify | Validate `outputDimension === EMBED_DIMS` at resolution; warn loudly or refuse. |
| `src/api/daemon-api-wiring.ts` | modify | Pass a real `onDimRejected` sink at the `resolveEmbedProvider` call site (`:107`); recall query embed provenance. |
| `src/cli.ts` | modify | Pass the sink at the daemon-path `resolveEmbedProvider` call site; wire the re-embed queueing for mismatched and inherited rows. |
| `src/projection/load.ts` | modify | `buildContentHashIndex` becomes `content_hash -> nectar[]` (`:271-279`). |
| `src/projection/inherit.ts` | modify | Per-path nectar assignment with in-loop tracking; inherited rows written in a re-embeddable state (`:85,90,118-136`). |
| `test/hive-graph-deeplake.test.ts` | modify | `embed_model` stamp, heal, and null-backfill coverage. |
| `test/hive-graph-search.test.ts` | modify | Mismatch filtering in the vector arm. |
| `test/embeddings-guard.test.ts` | modify | Config-resolution dimension validation; sink wiring assertions. |
| `test/embeddings-provider.test.ts` | modify | Provider-switch scenario against pre-existing embeddings. |
| `test/projection-ac.test.ts` | modify | Duplicate-content inherit; inherited-row re-embed state. |
| `test/enricher.test.ts` | modify | Inherited rows enter the enricher work set and re-embed without a describe call. |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018i.1 | `test/hive-graph-deeplake.test.ts` | Append a described row with an embedding; assert the stored row carries the active model id; append with `embedding: null` and assert `embed_model` null. |
| AC-018i.2 | `test/hive-graph-deeplake.test.ts` | Simulate a pre-upgrade table (no `embed_model`); first write heals the column; pre-existing rows read back null without a scan failure. |
| AC-018i.3 | `test/hive-graph-search.test.ts` | Seed rows stamped with model A, run a search under active model B; assert the vector arm excludes the model-A rows (or the mismatch warning fired) and the rows are queued for re-embed. |
| AC-018i.4 | `test/embeddings-provider.test.ts` | Capture the request bodies for a document embed and a query embed against a fake embed endpoint; assert the two call shapes are distinguishable (or record the finding that prefixing is delegated and verified). |
| AC-018i.5 | `test/projection-ac.test.ts` | Run inherit from a valid projection; assert inherited rows land in the selector-visible state with title/description/concepts intact. |
| AC-018i.6 | `test/enricher.test.ts` | Drive one enricher cycle over inherited rows with a fake provider; assert embeddings appear, `embed_model` is stamped, and the describe transport was not called for preserved descriptions. |
| AC-018i.7 | `test/embeddings-guard.test.ts` | Resolve config with `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION=1536`; assert the loud warning or refusal. |
| AC-018i.8 | `test/embeddings-guard.test.ts` | Provider returns a 1536-dim vector; assert the wired sink received the rejection at both call-site wirings. |
| AC-018i.9 | `test/projection-ac.test.ts` | Projection with three identical-content entries, clone with three matching paths; assert three distinct nectars consumed, no duplicate seq-0 rows. |
| AC-018i.10 | `test/projection-ac.test.ts` | Four duplicate paths against three projection entries; assert the fourth mints fresh and the first three carry their original identities. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-018, NEC-019, NEC-028, NEC-037)
- [`../../../notes/2026-07-02-recall-review.md`](../../../notes/2026-07-02-recall-review.md) (H5, M5)
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) (M1)
- [`../../../notes/2026-07-02-spec-drift-review.md`](../../../notes/2026-07-02-spec-drift-review.md) (drift matrix row 8)
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) (additive heal rule at :145-149; `describe_model` audit column at :108)
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) (re-embed-on-boot promise at :85)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) (embedding contract: 768-dim over `title + ' ' + description`)
