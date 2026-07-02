# PRD-001c: Shared Infrastructure Consumption — Portkey, Embeddings, CodeGraph, and Recall Seams

> Parent: [`prd-001-three-daemon-topology-index.md`](./prd-001-three-daemon-topology-index.md)

## Overview

This sub-PRD defines the **shared-infra consumption contract**: how nectar reaches the four pieces of shared infrastructure — the **Portkey gateway**, the **embeddings daemon**, **CodeGraph**, and the **recall engine** — through its **own** clients over the network, never in-process. It is the answer to ADR-0002's framing that independence changes *how* nectar reaches shared infra (its own client, its own auth) but not *whether* it uses it. nectar consumes the same Portkey endpoint, the same embeddings daemon, the same CodeGraph service, and writes into the same recall-readable tables as honeycomb — but each seam is crossed over HTTP from nectar's own process.

The load-bearing invariant this PRD establishes is the **deploy-time tenancy invariant**: nectar's rows must be readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope. ADR-0002 names this as a negative consequence — a misconfiguration (nectar pointing at a different Deep Lake org) silently breaks recall integration. This PRD states the invariant; PRD-005 owns the tenancy model and PRD-013 owns the recall arm that reads the rows.

## Goals

- Name each of the four shared-infra seams and state that nectar reaches each through its **own** client over the network (no in-process import of honeycomb's runtime).
- Specify the **Portkey** consumption seam: same gateway URL, same `x-portkey-api-key` + `x-portkey-config` header pair, reached from nectar's own inference transport.
- Specify the **embeddings** consumption seam: same nomic-embed-text-v1.5 daemon at the same loopback URL, same 768-dim contract, reached from nectar's own embed client.
- Specify the **CodeGraph** consumption seam: nectar reuses the same discovery/build patterns, not the in-process module.
- Specify the **recall** seam: nectar does NOT ship its own recall engine; it composes by writing `hive_graph_versions` rows that honeycomb's shared recall engine reads (PRD-013 adds the arm).
- State the **deploy-time tenancy invariant** that keeps the composition working.

## Non-Goals

- The Portkey transport implementation + model selection + semantic-cache documentation — **PRD-010**.
- The embeddings provider switch (local nomic vs Cohere-via-Portkey) — **PRD-014**.
- The recall arm that reads `hive_graph_versions` — **PRD-013**.
- The harness-exposure documentation (no nectar-shipped hooks) — **PRD-009**.
- The Deep Lake table schemas + tenancy model — **PRD-005**. This PRD consumes the tenancy as an invariant; it does not define it.
- nectar's Deep Lake client itself — [`prd-001b`](./prd-001b-nectar-process-and-health.md). This PRD covers the *other* shared infra (Portkey, embeddings, CodeGraph, recall), not Deep Lake.

---

## The four seams

Each seam is crossed over the network from nectar's own process. None is imported from honeycomb's in-process runtime.

### Seam 1 — Portkey gateway (LLM routing + guardrails + semantic cache)

nectar routes every LLM call (brooding descriptions, enricher steady-state) through the Portkey gateway, reusing the same transport contract honeycomb uses. The Portkey endpoint is `https://api.portkey.ai/v1` (`honeycomb/src/daemon/runtime/inference/transport-portkey.ts:74` `PORTKEY_BASE_URL`), with chat completions at `${PORTKEY_BASE_URL}/chat/completions` (`honeycomb/src/daemon/runtime/inference/transport-portkey.ts:77`). Auth is the fixed header pair: `x-portkey-api-key` (the Portkey key) + `x-portkey-config` (the config / virtual-key id) (`honeycomb/src/daemon/runtime/inference/transport-portkey.ts:83,86`), assembled by `buildPortkeyHeaders(apiKey, configId)` (`honeycomb/src/daemon/runtime/inference/transport-portkey.ts:95`).

nectar reaches Portkey from its **own** inference transport — it does not import honeycomb's `createPortkeyTransport`. The transport shape is reused (same URL, same headers, same body mapping via `toPortkeyBody`), but instantiated in nectar's process with nectar's own resolved key/config from its own vault read. Per decision #6, semantic caching and guardrails are **Portkey-server-side**, configured in the Portkey dashboard via the config id — nectar only accounts for upstream cached tokens; it does not enable caching client-side.

| Property | Value | Citation |
|---|---|---|
| Gateway base URL | `https://api.portkey.ai/v1` | `honeycomb/src/daemon/runtime/inference/transport-portkey.ts:74` |
| Chat completions URL | `${PORTKEY_BASE_URL}/chat/completions` | `honeycomb/src/daemon/runtime/inference/transport-portkey.ts:77` |
| Auth headers | `x-portkey-api-key` + `x-portkey-config` | `honeycomb/src/daemon/runtime/inference/transport-portkey.ts:83,86,95` |
| Client ownership | nectar's own transport (not honeycomb's in-process one) | ADR-0002 negative consequence #1 |

> The transport *implementation*, model selection, and the semantic-cache story are **PRD-010**. This PRD states only the seam: same gateway, same headers, own client.

### Seam 2 — Embeddings daemon (nomic-embed-text-v1.5)

nectar embeds descriptions through the **same** embeddings daemon honeycomb uses — the nomic-embed-text-v1.5 daemon pinned at loopback `127.0.0.1:3851` (`honeycomb/embeddings/src/index.ts:67-68` `EMBED_HOST`, `EMBED_PORT = 3851`). The embeddings dimension is fixed at 768 (`honeycomb/embeddings/src/index.ts:43` `EMBED_DIMS = 768`), matching the `FLOAT4[]` columns the schema holds. The client reaches the daemon at `http://127.0.0.1:3851` (default, overridable via `HONEYCOMB_EMBED_URL`), POSTing to `<url>/embed` with `{ text }` and expecting `{ vector: number[] }` (`honeycomb/src/daemon/runtime/services/embed-client.ts:52-54`).

nectar reaches the embeddings daemon from its **own** embed client — a POST over HTTP, not an in-process call. The 768-dim contract is binding: a provider that returns a different dimension is discarded by recall's `embed.dim_rejected` guard (decision #5). nectar does not host the embeddings daemon; it is shared infrastructure that a single instance serves to whichever daemon embeds.

| Property | Value | Citation |
|---|---|---|
| Daemon host/port | `127.0.0.1:3851` | `honeycomb/embeddings/src/index.ts:67-68` |
| Dimension | 768 | `honeycomb/embeddings/src/index.ts:43` `EMBED_DIMS` |
| Client protocol | `POST <url>/embed { text }` → `{ vector: number[] }` | `honeycomb/src/daemon/runtime/services/embed-client.ts:52-54` |
| Client ownership | nectar's own embed client (HTTP, not in-process) | ADR-0002 |

> The embeddings *provider switch* (local nomic default vs Cohere-via-Portkey opt-in) is **PRD-014**. This PRD states only the seam: same daemon, same 768-dim, own client.

### Seam 3 — CodeGraph (file discovery + build)

nectar reuses honeycomb's **CodeGraph patterns** for file discovery and the build→extract→persist shape, but does not import the in-process module — per decision #4's principle that patterns are mirrored, not imported, across the process boundary. Specifically, brooding's discovery reuses the `git ls-files` discovery and the `runGraphBuild` discover→extract→persist template (`honeycomb/src/daemon/runtime/codebase/api.ts:234-261` `buildAggregateSnapshot`). nectar calls its own CodeGraph client (or in-process equivalent scoped to nectar's job) to obtain the file set it describes; it does not call into honeycomb's daemon over the 3850 RPC for file discovery.

> **DEFAULT — confirm before implementation.** Whether nectar (a) imports the CodeGraph library as a package into its own process, (b) calls a CodeGraph service over HTTP, or (c) re-implements the minimal `git ls-files` discovery itself is a PRD-002/PRD-007 decision. The contract here is only: same discovery source (the working tree via `git ls-files`), mirrored pattern, not honeycomb's in-process module.

### Seam 4 — Recall (composition, not a shipped engine)

nectar does **not** ship its own recall engine. Per decision #1 and PRD-009's recorded decision, nectar composes with honeycomb's recall by **writing `hive_graph_versions` rows** that honeycomb's shared recall engine reads. PRD-013 adds the `hive_graph_versions` arm to the existing per-arm guarded-query recall (`honeycomb/src/daemon/runtime/memories/recall.ts`) — the single integration point that surfaces nectar's descriptions alongside session/memory/memories hits in every harness honeycomb is armed against.

The composition is a **data-layer** integration, not a process-layer one: nectar writes rows under the shared tenancy; honeycomb's recall engine reads them under the same scope. nectar never issues a recall query itself for the agent-facing surface (manual hive-graph search, PRD-012, is a separate scoped tool, not the fused recall). This is the recall-integration pillar ADR-0002 preserves.

---

## The deploy-time tenancy invariant

The composition above works only if nectar's rows are readable by honeycomb's recall engine under the same scope. This is the **deploy-time invariant** ADR-0002 negative consequence #2 names:

> Both daemons point at the same Deep Lake datasets with compatible tenancy. A misconfiguration (nectar pointing at a different Deep Lake org than honeycomb) silently breaks recall integration. This was impossible under colocation; it is now a deploy-time invariant to enforce.

Concretely, nectar's Deep Lake client (PRD-001b) and honeycomb's Deep Lake client must resolve to the **same `org`** and operate in the **same `workspace`**, with `project_id` as the shared column filter. nectar's installer/bootstrap must verify the resolved org matches honeycomb's at first run; a mismatch is a configuration error, not a runtime failure to swallow silently.

> **[2026-07-02: aligned to decision #21]** The enforcement mechanism is locked (decision #21, [`PRD-DECISIONS-AND-DEFAULTS.md`](../../PRD-DECISIONS-AND-DEFAULTS.md)): a **doctor-mediated assertion** whereby doctor gains a Deep Lake scope-comparison capability and refuses to supervise a daemon whose org/workspace scope mismatches another registered daemon's (application sites: PRD-001c, 004, 009a; PRD-004 documents doctor's new scope-awareness). The contract here is only: the invariant exists, and a violation silently breaks recall; it must be enforced, not assumed.

---

## User stories

### US-001c.1 — nectar routes LLM calls through Portkey from its own client
**As** nectar, **when** I generate a description, **I** POST to the Portkey chat-completions URL with the `x-portkey-api-key` + `x-portkey-config` headers from my own transport, **so that** I route through the same gateway honeycomb uses without importing its process.

- Acceptance: nectar's inference transport targets `https://api.portkey.ai/v1/chat/completions` with the fixed header pair.
- Acceptance: nectar does not import honeycomb's `createPortkeyTransport` in-process.

### US-001c.2 — nectar embeds through the shared embeddings daemon
**As** nectar, **when** I embed a description, **I** POST to `http://127.0.0.1:3851/embed` and receive a 768-dim vector, **so that** the embedding matches the schema's `FLOAT4[]` columns.

- Acceptance: nectar's embed client targets the shared daemon at 3851 and honors the 768-dim contract.

### US-001c.3 — nectar composes with recall by writing rows, not shipping an engine
**As** an agent, **when** I run a fused recall query through honeycomb, **I** see nectar's `hive_graph_versions` hits alongside session/memory hits, **so that** one query returns both semantic-file and conversation-trace results.

- Acceptance: nectar writes `hive_graph_versions` rows under the shared `org`/`workspace`/`project` tenancy.
- Acceptance: honeycomb's recall engine (with PRD-013's arm) reads those rows; nectar ships no recall engine of its own.

### US-001c.4 — A tenancy mismatch is caught, not silently swallowed
**As an** operator, **when** nectar's resolved org differs from honeycomb's, **the** bootstrap surfaces the mismatch, **so that** recall integration is not silently broken.

- Acceptance: nectar verifies its resolved Deep Lake org matches honeycomb's at deploy/bootstrap time (mechanism is a PRD-002/003 default).

---

## Implementation notes

- Portkey gateway: `honeycomb/src/daemon/runtime/inference/transport-portkey.ts:74,77,83,86,95` (`PORTKEY_BASE_URL`, chat URL, header names, `buildPortkeyHeaders`).
- Embeddings daemon + dim: `honeycomb/embeddings/src/index.ts:43,67-68` (`EMBED_DIMS = 768`, `EMBED_HOST`, `EMBED_PORT = 3851`).
- Embeddings client protocol: `honeycomb/src/daemon/runtime/services/embed-client.ts:52-54,66` (default URL `http://127.0.0.1:3851`, `POST /embed`, 768-dim).
- CodeGraph discovery/build pattern: `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` (`buildAggregateSnapshot` discover→extract→persist; `runGraphBuild`).
- Recall engine (the shared substrate PRD-013 extends): `honeycomb/src/daemon/runtime/memories/recall.ts`.
- Recall composition spec: [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md).
- Decisions #5 (embeddings provider switch) and #6 (Portkey semantic cache server-side): [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md).

No open questions. The CodeGraph consumption mechanism and the tenancy-verification mechanism are flagged defaults above.
