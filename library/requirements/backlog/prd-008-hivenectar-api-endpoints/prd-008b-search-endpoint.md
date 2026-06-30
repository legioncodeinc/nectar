# PRD-008b: Search Endpoint

> Parent: [`prd-008-hivenectar-api-endpoints-index.md`](./prd-008-hivenectar-api-endpoints-index.md)

## Overview

This sub-PRD owns the **`/api/source-graph/search` HTTP handler** — a thin route that validates a query, resolves the tenant scope per-request, and delegates to PRD-012's search engine. It is deliberately thin: the BM25 lexical + vector semantic search over `source_graph_versions` (latest described version per nectar) is PRD-012's deliverable, and this endpoint exists only to expose that engine to the dashboard and any HTTP client. The endpoint mirrors `mountGraphApi`'s handler shape — resolve scope, delegate to the engine, surface failure as a data body ([`honeycomb/src/daemon/runtime/codebase/api.ts:318-330`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)).

The endpoint attaches to the `/api/source-graph` group 008a scaffolds, registering at the path **relative** to the group (`/search`), and inherits the group's permission middleware without re-wiring auth. It is a standalone search tool: it runs PRD-012's focused "search just the file descriptions" engine and does **not** fuse into the agent-facing recall (that fusion is PRD-013's guarded arm). The result shape it returns matches what the `hivenectar search` CLI (PRD-012b) emits, so the dashboard search box and the CLI are two clients of one engine.

## Goals

- Mount `POST /api/source-graph/search` (and/or `GET` with a query parameter) as a thin handler on the group 008a scaffolds, modeled on `mountGraphApi`'s attach shape ([`honeycomb/src/daemon/runtime/codebase/api.ts:304-347`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)).
- Resolve the tenant scope per-request and reject a request with no resolvable scope with the `NO_ORG_BODY` 400, mirroring [`codebase/api.ts:319-320`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).
- Delegate the search to PRD-012's engine (`searchSourceGraph`), passing the query, the resolved scope, and the caller-supplied limit, and return PRD-012's result shape unchanged.
- Surface search/engine failures as a 500 data body (`{ error: "search_failed", reason }`), never an unhandled throw, mirroring [`codebase/api.ts:324-329`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).
- Confirm the endpoint is a **standalone** search tool — it does not fuse into recall and does not depend on the recall arm (PRD-013).

## Non-Goals

- The search engine (BM25 + vector arm over `source_graph_versions`, latest-per-nectar subquery, `describe_status = 'described'` filter) — **PRD-012a**. This endpoint delegates to it.
- The CLI surface (`hivenectar search <query>`) — **PRD-012b**. This endpoint and the CLI share the engine; this sub-PRD owns the HTTP handler, PRD-012b owns the CLI command.
- The recall arm (fusing `source_graph_versions` into the fused recall the agents call) — **PRD-013**. This endpoint is not the recall arm.
- The route-group scaffolding / permission inheritance — **008a**. This handler attaches to the group 008a mounts.
- The query-vector embedding mechanics — **PRD-012a** (which uses the embed client at [`honeycomb/src/daemon/runtime/services/embed-client.ts`](../../../../honeycomb/src/daemon/runtime/services/embed-client.ts)).

---

## The handler

The handler attaches to the `/api/source-graph` group and registers at the path relative to the group (`/search`). It resolves scope per-request (mirroring [`honeycomb/src/daemon/runtime/codebase/api.ts:309-310`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)), delegates to PRD-012's engine, and surfaces failure as data.

```ts
// Inside mountSourceGraphApi(daemon, options) — group resolved by 008a.
group.post("/search", async (c) => {
  const scope = resolveScope(c);
  if (scope === null) return c.json(NO_ORG_BODY, 400); // mirrors codebase/api.ts:319-320
  try {
    const { query, limit } = await parseSearchRequest(c); // query string + optional limit
    const result = await options.searchSourceGraph(query, scope, limit); // PRD-012 engine
    return c.json(result);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return c.json({ error: "search_failed", reason }, 500); // mirrors codebase/api.ts:324-329
  }
});
```

The `options.searchSourceGraph` dependency is PRD-012's engine, injected at daemon construction (the same injection shape `mountGraphApi` uses for `options` — [`codebase/api.ts:304`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)). The endpoint never reaches storage directly; it calls the engine, which in turn reads `source_graph_versions` through the injected storage client ([`honeycomb/src/daemon/runtime/server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts) FR-6).

---

## Request and response

### Request

`POST /api/source-graph/search`

```json
{ "query": "everything associated with logins", "limit": 20 }
```

- `query` — the search string (required; an empty query returns an empty result with `degraded: true`, mirroring `recallMemories`' empty-query floor at [`honeycomb/src/daemon/runtime/memories/recall.ts:2070-2073`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)).
- `limit` — optional; PRD-012's default is 20 (the `DEFAULT_RECALL_LIMIT = 20` the shared engine clamps to at [`recall.ts:129, 303-308`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)).

A `GET /api/source-graph/search?q=<query>&limit=<n>` variant is an acceptable alternative (query-parameter form); the body form is the default for parity with the engine's request shape.

### Response `200 OK`

The result shape PRD-012's engine returns (this endpoint passes it through unchanged):

```json
{
  "hits": [
    { "source": "hivenectar", "id": "<nectar>", "path": "src/middleware/session-refresh.ts",
      "title": "...", "body": "...", "concepts": "[...]", "content_hash": "..." }
  ],
  "sources": ["hivenectar"],
  "degraded": false
}
```

The `source` is the PRD-012 engine's literal (the arm's `'hivenectar' AS source` projection, [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)); `degraded` is `true` when the vector arm did not run (embeddings off/unavailable — the engine's graceful BM25-only fallback, the same signal as [`recall.ts:2106`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)).

### Errors

- `400` `{ ...NO_ORG_BODY }` — no resolvable scope (mirrors [`codebase/api.ts:319-320`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)).
- `401` / `403` — missing/invalid token or denied (handled by the inherited permission middleware, not the handler — [`server.ts:255-258`](../../../../honeycomb/src/daemon/runtime/server.ts)).
- `500` `{ error: "search_failed", reason }` — the engine threw (mirrors [`codebase/api.ts:324-329`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts)); never an unhandled throw that crashes the request pipeline.

---

## Standalone, not fused

This endpoint is a **focused** "search just the file descriptions" tool. It runs PRD-012's engine over `source_graph_versions` (latest described version per nectar) and returns those hits only. It does **not** call `recallMemories` and does **not** fuse with the sessions/memory/memories arms — that is PRD-013's guarded arm, which adds `source_graph_versions` to the agent-facing fused recall ([`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md)). The two are distinct: PRD-012 is the operator's manual search tool; PRD-013 is the agent's recall integration.

---

## User stories

### US-008b.1 — Search the source graph from the dashboard

**As a** operator, **I want to** `POST /api/source-graph/search` with a natural-language query, **so that** I find files by what they do (not by symbol name) from the dashboard's search box.

**Acceptance criteria:**
- AC-008b.1.1 Given a valid query and resolvable scope, when I `POST /api/source-graph/search`, then the handler delegates to PRD-012's `searchSourceGraph` and returns its result shape unchanged.
- AC-008b.1.2 Given an empty query, then the handler returns `{ hits: [], sources: [], degraded: true }`, mirroring the empty-query floor at [`recall.ts:2070-2073`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).
- AC-008b.1.3 Given a `limit`, then it is passed through to the engine; absent, then the engine's default (20) applies, mirroring `resolveRecallLimit` at [`recall.ts:303-308`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).

### US-008b.2 — A request with no scope is rejected

**As a** operator, **I want to** a scopeless request rejected, **so that** a search never runs unscoped.

**Acceptance criteria:**
- AC-008b.2.1 Given a request with no resolvable scope, then the handler returns the `NO_ORG_BODY` 400 before reaching the engine, mirroring [`codebase/api.ts:319-320`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).

### US-008b.3 — An engine failure is data, not a crash

**As a** operator, **I want to** a search-engine failure surfaced as a data body, **so that** the request pipeline never crashes.

**Acceptance criteria:**
- AC-008b.3.1 Given the engine throws, then the handler returns `{ error: "search_failed", reason }` with status 500, mirroring [`codebase/api.ts:324-329`](../../../../honeycomb/src/daemon/runtime/codebase/api.ts).

---

## Implementation notes

- **Inject the engine, do not reach storage.** The handler takes `options.searchSourceGraph` (PRD-012's engine) and calls it; it never issues a storage query itself (the daemon is the only DeepLake client — [`server.ts:13-16`](../../../../honeycomb/src/daemon/runtime/server.ts) FR-6).
- **Limit flows through unchanged.** The endpoint does not clamp the limit itself; PRD-012's engine clamps via the same `resolveRecallLimit` shape the recall engine uses ([`recall.ts:303-308`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)). This keeps one clamp site.
- **Scope resolution is shared.** The `resolveScope` thunk (008a) is the same one 008c's endpoints use; the `NO_ORG_BODY` 400 is the same body.
- **GET vs POST.** The body form is the default; a `?q=` GET form is acceptable if the dashboard's search box prefers it. Either delegates identically.
- **Same result shape as the CLI.** The `hivenectar search <query>` CLI (PRD-012b) calls the same engine; the endpoint returns the same JSON, so the dashboard and the CLI render identically.

---

## Related

- [`./prd-008-hivenectar-api-endpoints-index.md`](./prd-008-hivenectar-api-endpoints-index.md)
- [`./prd-008a-route-group-scaffolding.md`](./prd-008a-route-group-scaffolding.md) — the group this handler attaches to.
- [`./prd-008c-build-status-projection-endpoints.md`](./prd-008c-build-status-projection-endpoints.md) — sibling handlers sharing the same `resolveScope`.
- [`../prd-012-manual-source-graph-search/prd-012-manual-source-graph-search-index.md`](../prd-012-manual-source-graph-search/prd-012-manual-source-graph-search-index.md) — owns the engine this endpoint delegates to.
- [`../prd-012-manual-source-graph-search/prd-012a-lexical-semantic-search-over-source-graph.md`](../prd-012-manual-source-graph-search/prd-012a-lexical-semantic-search-over-source-graph.md) — the engine.
- [`../prd-012-manual-source-graph-search/prd-012b-cli-and-endpoint.md`](../prd-012-manual-source-graph-search/prd-012b-cli-and-endpoint.md) — the CLI that shares the engine.
- [`../../../knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the search contract (the arm SQL shape the engine mirrors).
- `honeycomb/src/daemon/runtime/codebase/api.ts:304-347` — `mountGraphApi` (the handler shape to mirror).
- `honeycomb/src/daemon/runtime/memories/recall.ts:129, 303-308` — `DEFAULT_RECALL_LIMIT` + `resolveRecallLimit` (the limit clamp the engine shares).
