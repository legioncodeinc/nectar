# PRD-013a: Lexical Arm — `buildHiveGraphVersionsArmSql` + `RecallSource` + `ARM_CLASS_WEIGHT` + Insertion

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M

## Overview

The lexical arm is the resilient floor of the hive-graph recall. It runs a guarded `ILIKE` match over the file's `title` / `description` / `concepts`, scoped to the latest described version per nectar, and projects the four columns (`source` / `id` / `text` / `created_at`) that `rowsToRankedArm` (`recall.ts:488-497`) reads into a ranked entry. It is the first half of the hybrid arm — the half that runs even when embeddings are off (PRD-013c).

This sub-PRD owns four coupled edits that make the arm a first-class participant in the fused recall: (1) a new `buildHiveGraphVersionsArmSql` builder mirroring `buildMemoriesArmSql` (`recall.ts:319-337`); (2) the `"hive_graph_versions"` entry in the `RecallSource` union (`recall.ts:169`) plus the matching branch in `readSource` (`recall.ts:385-389`); (3) the weight wired through `ARM_CLASS_WEIGHT` + `kindOfSource` (`recall.ts:158-166`) so the RRF fusion scores the arm as a clean distilled hit; and (4) the `runArm` call + `rowsToRankedArm` entry in the `Promise.all` + `arms` array (`recall.ts:2096-2118`). The SQL shape carries verbatim from [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm"; the per-arm-not-UNION-ALL rationale is `honeycomb/src/daemon/runtime/memories/recall.ts:24-35`.

## Goals

- Author `buildHiveGraphVersionsArmSql` with the same guard discipline as the three existing builders: identifiers via `sqlIdent`, the search term via `sqlLike`, the per-arm `LIMIT` via the bare-numeric interpolation (`recall.ts:319-337`).
- Carry the latest-per-nectar `MAX(seq)` subquery, the `describe_status = 'described'` filter, and the `project_id` conjunct from [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm".
- Add `"hive_graph_versions"` to the `RecallSource` union and to `readSource` so the arm's rows are not mis-defaulted to `"sessions"`.
- Score the arm at the distilled `memory` class weight so RRF treats a file-description hit on equal footing with a distilled fact, never as a noisy raw dump.

## Non-Goals

- The semantic arm over `embedding` — PRD-013b.
- The graceful-fallback behavior — PRD-013c.
- The `hive_graph_versions` table — PRD-005b.
- Changing `RRF_K` (`recall.ts:141`) or any existing arm's weight — this PRD adds one arm, it does not retune the fusion.

## Why per-arm, not `UNION ALL`

Carried verbatim from the locked decision ([`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) decision #2) and the code's own rationale block (`recall.ts:24-35`): each arm is its own guarded `storage.query`, not one `UNION ALL`. On a fresh workspace partition the store's heal-on-insert creates `memories`, but nothing has created `memory` / `sessions` / `hive_graph_versions` yet — so they do not exist. A single `UNION ALL` fails as a whole (`query_error`: relation does not exist), which used to fail-soft the *whole* recall to empty and silently wipe the real `memories` hit (the live dogfood bug). Running each arm separately makes a missing/failing sibling arm degrade to "empty for that arm" — exactly the per-arm tolerance the collector uses (`recall.ts:826-842`).

The consequence for the 4th arm is free: a workspace where Nectar brooding has not yet run has no `hive_graph_versions` table, and the new arm returns `[]` for that arm only. The other three arms still answer. A `UNION ALL` append is therefore rejected — it would regress the deliberate graceful-degradation design.

## The `RecallSource` union and `readSource`

The arm's rows carry a `source` cell that `rowsToRankedArm` (`recall.ts:488-497`) coerces back into the union via `readSource`. Both must recognize the new source or the rows are mis-tagged.

`RecallSource` is the union of the table/arm tags (`recall.ts:169`):

```ts
export type RecallSource = "memories" | "memory" | "sessions";
```

It gains `"hive_graph_versions"`:

```ts
export type RecallSource = "memories" | "memory" | "sessions" | "hive_graph_versions";
```

`readSource` (`recall.ts:385-389`) currently recognizes only the first three and defaults the rest to `"sessions"`. That default is the failure mode to avoid: a hive-graph row whose `source` cell is not recognized is re-tagged as a `sessions` hit, corrupting its provenance, its dedup key, and its weight. The branch is added:

```ts
function readSource(value: unknown): RecallSource {
	const s = String(value ?? "");
	return s === "memories"
		? "memories"
		: s === "memory"
			? "memory"
			: s === "hive_graph_versions"
				? "hive_graph_versions"
				: "sessions";
}
```

## `ARM_CLASS_WEIGHT` and `kindOfSource`

RRF is rank-based, not score-based, so the four arms contribute per-row on equal footing regardless of their raw score distributions — a Nectar hit at rank 1 contributes the same RRF weight as a sessions hit at rank 1 ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "Fusion with the other arms"). The per-arm *class* weight (`recall.ts:158-166`) is what keeps a noisy raw `sessions` dump beneath a clean distilled fact.

The weight is keyed by `RecallKind` (`"memory" | "session"`, `recall.ts:180`), not directly by `RecallSource`. `kindOfSource` (`recall.ts:164-166`) maps a source to its class — everything that is not `sessions` is the distilled `memory` class today:

```ts
export function kindOfSource(source: RecallSource): RecallKind {
	return source === "sessions" ? "session" : "memory";
}
```

`hive_graph_versions` is a clean, LLM-minted description — the same shape as the distilled `memory`/`memories` arms, not the noisy captured-turn `sessions` dump. It therefore falls through `kindOfSource` to the `"memory"` class with **no change to `kindOfSource` required** (the existing fallback already returns `"memory"` for any non-`sessions` source). The arm inherits the distilled class weight `1.0`:

```ts
export const ARM_CLASS_WEIGHT: Readonly<Record<RecallKind, number>> = {
	memory: 1.0,
	session: 0.4,
};
```

A rank-1 Nectar hit scores `1.0 / (60 + 1) = 0.016393` — identical to a rank-1 distilled `memories` hit and ~2.5× a rank-1 raw `sessions` hit (`0.4 / 61 = 0.006557`). RRF then dedups cross-arm near-dups by `source+id` (`recall.ts:403-457`) — a file hit by both the lexical and the semantic hive-graph arm fuses its contributions.

### Weight `1.0` *(SIGNED OFF 2026-07-02, decision #34)* and the `nectar_rrf_multiplier` mechanism *(SCOPED 2026-07-02, decision #17 as amended)*

`1.0` (the distilled `memory` class weight) is the signed-off default. It matches the corpus default ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "Weighting and the Nectar multiplier" — "a multiplier of 1.0 (equal weighting) as the default"). Rationale: a file-description hit is exactly as actionable as a session-trace hit — they answer different aspects of the same question, so neither should dominate.

Decision #17 additionally promises an operator-tunable multiplier, and the 2026-07-02 QA pass found no such mechanism exists in honeycomb's recall path; per the same-day user decision it is SCOPED HERE rather than deferred. The mechanism (implemented in honeycomb alongside the arm, since `ARM_CLASS_WEIGHT` is a per-`kind` constant and this multiplier is per-SOURCE):

- **Config surface:** `~/.honeycomb/nectar.json`, key `recall.nectar_rrf_multiplier` (a number). Missing file, malformed JSON, a non-numeric value, or a missing key all resolve FAIL-SOFT to `1.0` (never a throw on the recall hot path).
- **Read cadence:** once per daemon boot (with the other config reads); a change takes effect on the next daemon restart, mirroring the registry hot-add posture (decision #19). No file-watch, no per-request read.
- **Application point:** the RRF fusion contribution for a `hive_graph_versions` hit becomes `ARM_CLASS_WEIGHT[kindOfSource(source)] * nectarRrfMultiplier / (RRF_K + rank)`; every other source keeps its contribution unchanged (multiplier fixed at `1`). The multiplier is clamped to `[0, 10]` (a negative or absurd value clamps rather than inverts or explodes the fusion).
- **Observability:** the resolved multiplier is logged once at boot when it differs from `1.0`, so a surprising recall mix is diagnosable from the log line alone.

## The lexical arm SQL

Carried from [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm", translated to the builder convention of `buildMemoriesArmSql` (`recall.ts:319-337`). Every identifier routes through `sqlIdent`, the search term through `sqlLike`, the per-arm `LIMIT` through the bare-numeric interpolation (`recall.ts:319-318`).

The three load-bearing predicates, carried verbatim from the corpus SQL:

1. **Latest-per-nectar.** An `INNER JOIN` on a `MAX(seq)` subquery grouped by `nectar` collapses a file's version chain to its one current row. Without it, a file edited 50 times dominates recall with 50 near-duplicate rows; with it, recall sees only the most recent described state ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm").
2. **`describe_status = 'described'`.** Excludes `pending`, `failed`, `skipped-too-large`, `skipped-binary` rows. A file never described (brooding not yet reached it, or skipped as binary/too-large) does not appear in semantic recall — it may still appear in the structural CodeGraph `find/` results, keyed by symbol name ([`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "What recall does not do with Nectar").
3. **`project_id` scoping.** The shared `buildProjectScopeConjunct` (`recall/scope-clause.ts:355-401`, threaded in via `projectConjunctFor` at `recall.ts:819-824`) ANDs the project segment into the same statement, so a project-B file is filtered server-side and never enters the fusion — matching the defense-in-depth every existing arm carries.

```ts
export function buildHiveGraphVersionsArmSql(
	term: string,
	perArmLimit: number,
	projectClause = "",
): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const versionsTbl = sqlIdent("hive_graph_versions");
	const nectarCol = sqlIdent("nectar");
	const seqCol = sqlIdent("seq");
	const titleCol = sqlIdent("title");
	const descriptionCol = sqlIdent("description");
	const conceptsCol = sqlIdent("concepts");
	const describeStatusCol = sqlIdent("describe_status");
	const describedAtCol = sqlIdent("described_at");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	// PRD-013a: the latest described version per nectar. The MAX(seq) subquery
	// (grouped by nectar) collapses the append-only version chain to the one
	// current row; the describe_status filter excludes pending/failed/skipped rows;
	// the projectClause is the buildProjectScopeConjunct project_id segment ANDed
	// in so a cross-project file never enters the fusion (49b-AC-2).
	return (
		`SELECT 'hive_graph_versions' AS source, v.${nectarCol} AS id, (v.${titleCol} || v.${descriptionCol})::text AS text, v.${describedAtCol}::text AS created_at ` +
		`FROM "${versionsTbl}" v ` +
		`INNER JOIN (SELECT ${nectarCol}, MAX(${seqCol}) AS max_seq FROM "${versionsTbl}" WHERE ${describeStatusCol} = 'described'${projectClause} GROUP BY ${nectarCol}) latest ` +
		`ON v.${nectarCol} = latest.${nectarCol} AND v.${seqCol} = latest.max_seq ` +
		`WHERE (v.${titleCol}::text ILIKE ${pattern} OR v.${descriptionCol}::text ILIKE ${pattern} OR v.${conceptsCol}::text ILIKE ${pattern}) ` +
		`LIMIT ${perArm}`
	);
}
```

### Column mapping — verified against PRD-005b

Every column above exists in the `hive_graph_versions` DDL (carried verbatim into [PRD-005b](../../completed/prd-005-hive-graph-catalog-tables/prd-005b-hive-graph-versions-table.md)): `nectar`, `seq`, `path`, `title`, `description`, `concepts` (JSON-encoded string array, `'[]'`), `describe_status` (`'pending'`/`'described'`/`'failed'`/`'skipped-too-large'`/`'skipped-binary'`), `described_at`. The `concepts` ILIKE over the JSON string surfaces a concept-tag match (e.g. a `["auth","jwt"]` concepts cell matches the term `jwt`), matching the corpus's `v.concepts ILIKE :concept_pattern`.

### Projection — the four columns `rowsToRankedArm` reads

`rowsToRankedArm` (`recall.ts:488-497`) reads exactly `source`, `id`, `text`, `created_at` from each row. The builder projects them:

- **`source`** — the `'hive_graph_versions'` literal, recognized by `readSource` (above).
- **`id`** — `v.nectar`. The fusion dedup key is `source+id` (`recall.ts:484-486`); the nectar is the stable file identity, so a file surfaced by both the lexical and the semantic arm fuses its contributions. (Note: `idColumnFor` at `recall.ts:1073-1075` maps non-`sessions`/non-`memory` sources to `"id"` — correct for this arm.)
- **`text`** — `title || description`, the matched body the surface renders. The `::text` cast mirrors every existing arm.
- **`created_at`** — `v.described_at`, aliased to the uniform timestamp the recency dampener reads (PRD-047d, mirroring how `memories.created_at` / `sessions.creation_date` alias to `created_at`). `described_at` is the timestamp of the enricher run that minted the description — the closest semantic match to "when this recall-relevant content was produced."

### Per-arm `LIMIT` *(DEFAULT — confirm before implementation)*

The arm's per-arm `LIMIT` matches the existing arms' bound: the clamped caller `limit` (`resolveRecallLimit` at `recall.ts:303-308`, default `DEFAULT_RECALL_LIMIT = 20`, ceiling `MAX_RECALL_LIMIT = 200`). Every existing arm is bounded by the overall `limit` (`recall.ts:2096-2101`) precisely so no single arm starves the fusion; the 4th arm matches that bound — it receives the same `limit` the other arms receive, applied after the merge (`recall.ts:2119`). This is flagged as a default pending implementation confirmation; the alternative (a smaller per-arm cap on the hive-graph arm to keep file descriptions from crowding out memory/session hits) is a fusion-tuning decision deferred to the eval harness, not introduced here.

## Insertion — the `Promise.all` and `arms` array

The arm is inserted at the two exact points the existing three arms occupy (`recall.ts:2096-2118`). The `Promise.all` runs all arms concurrently; the `arms` array assembles the ranked lists the RRF fusion consumes.

```ts
const [semanticRun, memoriesRows, memoryRows, sessionsRows, hiveGraphRows] = await Promise.all([
	keywordOnly ? Promise.resolve(null) : runSemanticArms(request, deps, limit),
	runArm(buildMemoriesArmSql(term, limit, projectClause), request, deps),
	runArm(buildMemoryArmSql(term, limit, projectClause), request, deps),
	runArm(buildSessionsArmSql(term, limit, projectClause), request, deps),
	runArm(buildHiveGraphVersionsArmSql(term, limit, projectClause), request, deps),
]);
```

and the assembly:

```ts
const arms: RankedArm[] = [
	...(semanticRun?.arms ?? []),
	rowsToRankedArm(memoriesRows),
	rowsToRankedArm(memoryRows),
	rowsToRankedArm(sessionsRows),
	rowsToRankedArm(hiveGraphRows),
];
```

The `runArm` wrapper (`recall.ts:826-842`) is the fail-soft contract: a non-`ok` result (a missing `hive_graph_versions` table on a fresh partition, any `query_error`, a timeout) yields `[]` for this arm rather than a recall-wide failure. The bounded recall pool (`resolveRecallPool`, `recall.ts:117-121`) caps the additional in-flight DeepLake query against the shared ceiling.

## Acceptance Criteria

- [ ] `"hive_graph_versions"` is a member of the `RecallSource` union (`recall.ts:169`); `readSource` (`recall.ts:385-389`) returns `"hive_graph_versions"` for that source cell (it does NOT default it to `"sessions"`).
- [ ] `buildHiveGraphVersionsArmSql` mirrors `buildMemoriesArmSql` (`recall.ts:319-337`): identifiers via `sqlIdent`, the term via `sqlLike`, the `LIMIT` via the bare-numeric interpolation; it projects `source`/`id`/`text`/`created_at`.
- [ ] The lexical arm carries the `MAX(seq)` latest-per-nectar subquery, the `describe_status = 'described'` filter, and the `project_id` conjunct from `buildProjectScopeConjunct` — matching the SQL shape in [`recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm".
- [ ] Every column in the builder exists in the PRD-005b DDL (`nectar`, `seq`, `title`, `description`, `concepts`, `describe_status`, `described_at`); no column is invented.
- [ ] `kindOfSource("hive_graph_versions")` returns `"memory"` (the distilled class) with no change to `kindOfSource`; the RRF contribution is `ARM_CLASS_WEIGHT["memory"] / (RRF_K + rank)` = `1.0 / (60 + rank)` at the default multiplier.
- [ ] The `nectar_rrf_multiplier` mechanism (decision #17 as amended, scoped 2026-07-02): honeycomb reads `recall.nectar_rrf_multiplier` from `~/.honeycomb/nectar.json` once at boot, fail-soft to `1.0` (missing file/key, malformed JSON, non-numeric), clamped to `[0, 10]`; the fusion multiplies ONLY the `hive_graph_versions` contribution by it; a non-default value is logged once at boot.
- [ ] The arm runs in the `Promise.all` (`recall.ts:2096-2101`) and is appended to the `arms` array (`recall.ts:2113-2118`); `fuseHits` (`recall.ts:403-457`) dedups its hits by `source+id` and fuses them with the other three.
- [ ] Given the `hive_graph_versions` table is absent, `runArm` returns `[]` for this arm only; the other arms still answer (the per-arm fail-soft, `recall.ts:826-842`).

## Related

- [PRD-013](./prd-013-recall-arm-hive-graph-index.md) — the module index.
- [PRD-013b](./prd-013b-semantic-arm-over-embedding.md) — the semantic arm over `embedding` that pairs with this lexical arm.
- [PRD-013c](./prd-013c-graceful-bm25-fallback.md) — the graceful fallback when embeddings are off.
- [PRD-005b](../../completed/prd-005-hive-graph-catalog-tables/prd-005b-hive-graph-versions-table.md) — the `hive_graph_versions` DDL the builder reads.
- [PRD-005c](../../completed/prd-005-hive-graph-catalog-tables/prd-005c-tenancy-and-project-id-filter.md) — the `project_id` soft-filter contract.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) § "The added guarded arm", § "Fusion with the other arms", § "Weighting and the Nectar multiplier".
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) decision #2 — per-arm, not `UNION ALL`.
- `honeycomb/src/daemon/runtime/memories/recall.ts:24-35` — the per-arm rationale.
- `honeycomb/src/daemon/runtime/memories/recall.ts:129, 131, 141, 158-169, 180, 303-308, 385-389` — limits (`DEFAULT_RECALL_LIMIT`/`MAX_RECALL_LIMIT`), `RRF_K`, `ARM_CLASS_WEIGHT`, `kindOfSource`, `RecallSource`, `RecallKind`, `resolveRecallLimit`, `readSource`.
- `honeycomb/src/daemon/runtime/memories/recall.ts:319-337, 484-497, 819-842, 1073-1075` — `buildMemoriesArmSql` (mirror), `fusionKey`/`rowsToRankedArm`, `projectConjunctFor`/`runArm`, `idColumnFor`.
- `honeycomb/src/daemon/runtime/memories/recall.ts:2064-2119` — the `Promise.all` + `arms` insertion points.
- `honeycomb/src/daemon/runtime/recall/scope-clause.ts:355-401` — `buildProjectScopeConjunct`.
