# PRD-008c: Build, Status, and Projection Endpoints

> Parent: [`prd-008-hivenectar-api-endpoints-index.md`](./prd-008-hivenectar-api-endpoints-index.md)

## Overview

This sub-PRD owns the three remaining `/api/source-graph` endpoints: the **build trigger** (`/build`, modeled on honeycomb's `/api/graph/build`), the **status surface** (`/status` — queue depth + `describe_status` counts + cost counter), and the **projection CRUD** (read + regenerate `.honeycomb/nectars.json`). All three attach to the group 008a scaffolds and share its `resolveScope` thunk; all three mirror `mountGraphApi`'s handler shape (resolve scope → delegate → failure-as-data) and reach storage solely through the injected storage client ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)).

Each endpoint maps a corpus-named CLI command ([`knowledge/private/overview.md`](../../../knowledge/private/overview.md)) onto an HTTP verb so the dashboard (PRD-015, hosted by thehive) can drive the same mechanics an operator drives from the CLI: `/build` mirrors `honeycomb hivenectar brood` (PRD-007), `/status` reads the queue the enricher polls (PRD-016), and the projection endpoints mirror `rebuild-projection` (PRD-011). The mechanics themselves are owned by those PRDs; this sub-PRD owns the HTTP handlers that invoke them.

## Goals

- Mount `POST /api/source-graph/build` as a trigger that invokes the brooding pipeline (PRD-007), modeled on honeycomb's `POST /api/graph/build` at [`honeycomb/src/daemon/runtime/codebase/api.ts:318-330`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).
- Mount `GET /api/source-graph/status` that returns queue depth (pending `source_graph_versions` rows), `describe_status` counts, and the cost counter — the same counters an operator reads.
- Mount the **projection CRUD** endpoints: read the current projection and trigger a regeneration, mirroring the `rebuild-projection` CLI (PRD-011).
- Resolve scope per-request on every endpoint (mirroring [`codebase/api.ts:309-310`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)) and reach storage solely through the injected storage client (FR-6 — [`server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- Surface every build/regenerate failure as a 500 data body (`{ error: "build_failed", reason }` / `{ error: "regenerate_failed", reason }`), never an unhandled throw, mirroring [`codebase/api.ts:324-329`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).

## Non-Goals

- The brooding pipeline mechanics (discovery, bucketing, batch/solo LLM calls, cost math) — **PRD-007**. `/build` invokes the pipeline.
- The enricher steady-state loop + meaningful-change heuristic — **PRD-016**. `/status` reads its queue.
- The projection format + atomic write + rebuild logic — **PRD-011**. The projection endpoints invoke `rebuild-projection`.
- The dashboard page that calls these endpoints — **PRD-015**.
- The search endpoint — **008b**.
- The route-group scaffolding — **008a**.

---

## The build endpoint

### POST /api/source-graph/build

**What it does:** Triggers a brood (the one-time full-codebase description pipeline, or a forced re-describe). Modeled on honeycomb's `POST /api/graph/build`, which runs the graph worker end-to-end and returns the result, surfacing a build error as a 500 data body ([`honeycomb/src/daemon/runtime/codebase/api.ts:318-330`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)).

```ts
group.post("/build", async (c) => {
  const scope = resolveScope(c);
  if (scope === null) return c.json(NO_ORG_BODY, 400); // codebase/api.ts:319-320
  try {
    const { force, limit, model } = await parseBuildRequest(c);
    const result = await options.runBrood({ scope, force, limit, model }); // PRD-007
    return c.json(result);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return c.json({ error: "build_failed", reason }, 500); // codebase/api.ts:324-329
  }
});
```

**Request:**

```json
{ "force": false, "limit": null, "model": null }
```

- `force` — re-describe every file, ignoring existing descriptions (mirrors `honeycomb hivenectar brood --force`, [`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)).
- `limit` — cost cap, files to describe (mirrors `brood --limit N`).
- `model` — model-swap re-describe (mirrors `brood --force --model <new>`; the mechanic owner is PRD-007 + PRD-010).

**Response `200 OK`:** the brood result (counts: described, skipped-binary, skipped-too-large, failed; the cost spent; the projection-regenerated flag). The exact field set is PRD-007's; this endpoint returns it unchanged.

**Errors:** `400` NO_ORG_BODY (no scope); `500` `{ error: "build_failed", reason }` (pipeline threw).

---

## The status endpoint

### GET /api/source-graph/status

**What it does:** Returns the coarse pipeline status an operator and the dashboard read: queue depth (the count of `source_graph_versions` rows with `describe_status = 'pending'` the enricher polls), the `describe_status` breakdown (described / pending / failed / skipped), and the cumulative cost counter. The queue-depth query is the same "latest pending version per nectar" shape the enricher's pending-work query uses ([`knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) § Enricher queue debounce; [`prd-016a`](../prd-016-enricher-steady-state/prd-016a-queue-poll-debounce-meaningful-change.md)).

```ts
group.get("/status", async (c) => {
  const scope = resolveScope(c);
  if (scope === null) return c.json(NO_ORG_BODY, 400);
  try {
    const status = await options.readSourceGraphStatus(scope); // PRD-016 queue + counts + cost
    return c.json(status);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return c.json({ error: "status_failed", reason }, 500);
  }
});
```

**Response `200 OK`:**

```json
{
  "queueDepth": 12,
  "describeStatus": { "described": 1842, "pending": 12, "failed": 3, "skipped": 143 },
  "costSpentUsd": 2.71,
  "degraded": false
}
```

- `queueDepth` — pending rows awaiting the enricher (the latest-pending-per-nectar count).
- `describeStatus` — the `describe_status` column breakdown (the column lives on `source_graph_versions`, [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md)).
- `costSpentUsd` — the cumulative brooding/enricher cost counter.
- `degraded` — `true` when the status read could not reach the table (mirrors the per-arm fail-soft: a missing table degrades to an empty status, never a 500-on-boot — [`honeycomb/src/daemon/runtime/memories/recall.ts:24-35`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)).

This endpoint is **read-only** and cheap (aggregate counts, not a full scan), mirroring honeycomb's coarse `/health`/`/api/status` posture (no heavy query for a liveness/status read — [`honeycomb/src/daemon/runtime/server.ts:318-341`](../../../../honeycomb/src/daemon/runtime/server.ts)).

---

## The projection endpoints

### GET /api/source-graph/projection

**What it does:** Returns the current `.honeycomb/nectars.json` projection (the committed, regenerable lockfile PRD-011 owns). Read-only.

```ts
group.get("/projection", async (c) => {
  const scope = resolveScope(c);
  if (scope === null) return c.json(NO_ORG_BODY, 400);
  const projection = await options.readProjection(scope); // PRD-011
  return c.json(projection);
});
```

### POST /api/source-graph/projection/rebuild

**What it does:** Triggers an explicit regeneration of the projection from Deep Lake (the atomic temp + rename PRD-011 specifies), mirroring the `rebuild-projection` CLI ([`knowledge/private/overview.md`](../../../knowledge/private/overview.md); PRD-011). A build/regenerate error is surfaced as a 500 data body.

```ts
group.post("/projection/rebuild", async (c) => {
  const scope = resolveScope(c);
  if (scope === null) return c.json(NO_ORG_BODY, 400);
  try {
    const result = await options.rebuildProjection(scope); // PRD-011 atomic write
    return c.json(result);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return c.json({ error: "regenerate_failed", reason }, 500);
  }
});
```

**Response `200 OK`:** `{ regenerated: true, nectarsCount: <N>, generatedAt: "<iso>" }`.

The projection-not-sidecar invariant holds: these endpoints never write the projection by hand-editing; `rebuild` regenerates it from Deep Lake via PRD-011's atomic write ([`knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md)).

---

## User stories

### US-008c.1 — Trigger a brood from the dashboard

**As a** operator, **I want to** `POST /api/source-graph/build` from the dashboard, **so that** I trigger a brood without dropping to the CLI.

**Acceptance criteria:**
- AC-008c.1.1 Given a resolvable scope, when I `POST /api/source-graph/build`, then the handler invokes PRD-007's brood pipeline with the resolved scope + flags and returns its result.
- AC-008c.1.2 Given a pipeline failure, then the handler returns `{ error: "build_failed", reason }` with status 500, mirroring [`codebase/api.ts:324-329`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).
- AC-008c.1.3 Given `force: true`, then the pipeline re-describes every file, mirroring `brood --force` ([`knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)).

### US-008c.2 — Read pipeline status

**As a** operator, **I want to** `GET /api/source-graph/status`, **so that** I see queue depth, `describe_status` counts, and cost at a glance.

**Acceptance criteria:**
- AC-008c.2.1 Given a resolvable scope, when I `GET /api/source-graph/status`, then the handler returns `queueDepth` (latest-pending-per-nectar count), `describeStatus` (the column breakdown), and `costSpentUsd`.
- AC-008c.2.2 Given the table is missing on a fresh workspace, then the handler returns a degraded status (empty counts, `degraded: true`), never a 500 — mirroring the per-arm fail-soft at [`recall.ts:24-35`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).
- AC-008c.2.3 Given the status read, then it issues aggregate counts only (no full scan), mirroring the coarse `/health`/`/api/status` posture at [`server.ts:318-341`](../../../../honeycomb/src/daemon/runtime/server.ts).

### US-008c.3 — Read and regenerate the projection

**As a** operator, **I want to** read the projection and trigger a regeneration, **so that** I can inspect and refresh the committed lockfile.

**Acceptance criteria:**
- AC-008c.3.1 Given a resolvable scope, when I `GET /api/source-graph/projection`, then the handler returns the current `.honeycomb/nectars.json` projection via PRD-011's read.
- AC-008c.3.2 Given a resolvable scope, when I `POST /api/source-graph/projection/rebuild`, then the handler invokes PRD-011's atomic regen and returns `{ regenerated: true, nectarsCount, generatedAt }`.
- AC-008c.3.3 Given the rebuild, then the projection is regenerated from Deep Lake (never hand-edited), honoring the projection-not-sidecar invariant ([`knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md)).

---

## Implementation notes

- **Inject the mechanics, do not reach storage directly for behavior.** Each handler takes an injected function (`options.runBrood`, `options.readSourceGraphStatus`, `options.readProjection`, `options.rebuildProjection`) owned by the mechanic's PRD; only the status read issues a direct storage count query (through the injected storage client — FR-6, [`server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- **Shared `resolveScope`.** All four endpoints use the same `resolveScope` thunk 008a establishes and 008b shares; the `NO_ORG_BODY` 400 is uniform.
- **Build mirrors `/api/graph/build` exactly in shape.** Resolve scope → delegate → failure-as-data is the `runGraphBuild` pattern at [`codebase/api.ts:318-330`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts); hivenectar's variant swaps the graph worker for the brood pipeline.
- **Status is coarse + cheap.** The status endpoint issues aggregate counts, not a full table scan, mirroring honeycomb's `/health` posture (a cheap probe — [`server.ts:318-341`](../../../../honeycomb/src/daemon/runtime/server.ts)). The queue-depth count reuses the enricher's latest-pending-per-nectar semantics.
- **Projection endpoints are thin.** `readProjection`/`rebuildProjection` delegate entirely to PRD-011; this sub-PRD adds no projection logic of its own.
- **`describe_status` values.** The status breakdown enumerates the column's values (`described` / `pending` / `failed` / `skipped`), carried from [`knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md); no new values invented here.

---

## Related

- [`./prd-008-hivenectar-api-endpoints-index.md`](./prd-008-hivenectar-api-endpoints-index.md)
- [`./prd-008a-route-group-scaffolding.md`](./prd-008a-route-group-scaffolding.md) — the group + shared `resolveScope`.
- [`./prd-008b-search-endpoint.md`](./prd-008b-search-endpoint.md) — the sibling search handler.
- [`../prd-007-brooding-process/prd-007-brooding-process-index.md`](../prd-007-brooding-process/prd-007-brooding-process-index.md) — owns the brood pipeline `/build` invokes.
- [`../prd-011-portable-projection/prd-011-portable-projection-index.md`](../prd-011-portable-projection/prd-011-portable-projection-index.md) — owns the projection format + rebuild the projection endpoints invoke.
- [`../prd-016-enricher-steady-state/prd-016a-queue-poll-debounce-meaningful-change.md`](../prd-016-enricher-steady-state/prd-016a-queue-poll-debounce-meaningful-change.md) — the pending-work query whose shape the status `queueDepth` mirrors.
- [`../../../knowledge/private/overview.md`](../../../knowledge/private/overview.md) — the CLI commands these endpoints mirror onto HTTP.
- [`../../../knowledge/private/data/source-graph-schema.md`](../../../knowledge/private/data/source-graph-schema.md) — the `describe_status` column the status breakdown reads.
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) — the projection-not-sidecar invariant the projection endpoints honor.
- `honeycomb/src/daemon/runtime/codebase/api.ts:304-347` — `mountGraphApi` (the `/build` handler shape to mirror, esp. `:318-330`).
- `honeycomb/src/daemon/runtime/server.ts:13-16, 318-341` — FR-6 (storage through the client only) + the coarse status posture.
