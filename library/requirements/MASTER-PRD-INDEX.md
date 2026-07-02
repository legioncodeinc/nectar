# Master PRD Index — Nectar Implementation

> Category: Requirements | Version: 1.1 | Date: July 2026 | Status: Active

The ordered list of PRDs required to take Nectar from spec to a shipped, supervised, doctor-watched daemon that composes with Honeycomb's recall, renders a Hive Graph page on the dashboard, and supports swappable embeddings + model providers. **This is an index for review, not a PRD itself.**

**Program status (updated 2026-07-02).** Status ground truth is `../ledger/EXECUTION_LEDGER.md` plus the per-PRD `qa/` reports; this block is the index-level summary. PRD-001 through PRD-006 are in `completed/` (001-005 spec-verified to the corpus-conformance bar; 003 and 006 additionally carry implemented, tested code, with 006 shipped on PR #9 including the persisted `fingerprint` column). PRD-010, 011, and 014 are in `in-work/` (spec QA-PASS, implementation in progress). PRD-007, 008, 009, 012, 013, 015, and 016 remain in `backlog/`, QA-pending. **PRD-017** (service check-in + SQLite telemetry, the fleet-realignment sibling of honeycomb's PRD-071) was added 2026-07 after this index's original sixteen; its entry is below and it is profiled in `PRD-003-016-DEPENDENCY-MAP.md` and sequenced in `PRD-003-016-WAVE-PLAN.md`. doctor's multi-daemon registry (004a) is implemented in the doctor repo; hive (004c) is implemented and QA'd in hive repo, refining ADR-0004 via hive ADR-0001 (copy-and-own) and ADR-0002 (server-side BFF proxy). Each entry has a title, an AI-legible description for the next-step PRD-authoring pass, the spec source(s) it derives from, and the Honeycomb code it must conform to.

**Read this first — six decisions locked after research against the actual Honeycomb code.** Each was a place where the Nectar spec diverged from reality, or an open fork; all six are now resolved. Every PRD below is written to these decisions, not to the original spec phrasing. The corpus (ADR-0002 + prose) must be updated to match before PRD authoring begins.

1. **Topology: introduce `hive` as a third daemon; doctor gains a minimal registry.** ✅ DECIDED. Research found doctor has no registration API today — it's a one-directional `/health`-probe watchdog (`honeycomb/doctor/src/supervisor.ts:144-343`) that supervises exactly one daemon (Honeycomb at :3850). Rather than reframe down to that minimal contract OR build a heavy registry into doctor, the chosen topology splits the always-on surface into **three roles**: (a) **doctor** — the minimal, rarely-updated supervisor; it gains a *minimal* daemon registry (the list of daemons to supervise, each with its own healthUrl/pidPath/probeInterval) but stays state-light and is updated only when a new daemon registers; (b) **hive** — a new always-on portal daemon, updateable independently of doctor, that boots immediately on OS start and serves the unified dashboard, fetching data from each registered daemon's API (so there's one source of always-on truth for the UI regardless of which workload daemon is healthy); (c) **nectar + honeycomb** — the workload daemons, both supervised by doctor and both surfaced in hive's portal. This realizes the user's "always-on dashboard that boots with the device" + "stable supervisor" + "updateable portal" split. *Alternatives rejected:* moving the portal into doctor (would force every dashboard update through the component we want to update rarely — kills the velocity/stability split); keeping doctor as-is with no registry (leaves no single always-on dashboard truth and no registration model).

2. **Recall: mirror the per-arm guarded-query pattern; correct the corpus's "UNION ALL" prose.** ✅ DECIDED. Recall is per-arm guarded queries (`honeycomb/src/daemon/runtime/memories/recall.ts:24-35`, `2064-2119`), deliberately, so a missing sibling table degrades to "empty for that arm" rather than failing the whole recall. The 4th arm mirrors the existing pattern (`buildHiveGraphVersionsArmSql` alongside `buildMemoriesArmSql`/`buildMemoryArmSql`/`buildSessionsArmSql` at `recall.ts:319-383`); the corpus's "UNION ALL arm" language gets corrected to "per-arm guarded query." *Alternative rejected:* refactoring to a true UNION ALL — would regress the deliberate graceful-degradation design (a missing `hive_graph` table on a fresh workspace would blank out session/memory hits too).

3. **Tables: lazy `withHeal`, `project_id` as soft column filter.** ✅ DECIDED. Tables self-create on first write via `withHeal` (`honeycomb/src/daemon/storage/catalog/projects.ts:33-50` — explicit "NO DDL pre-step"); `project_id` is a column-level soft `WHERE` filter within the workspace partition, never a partition (`client.ts:40-46` — scope is `org`+`workspace`). The user's "auto-create tables per org>workspace>project" is reframed as "register the catalog group; tables self-heal on first write; scope by `project_id` column." *Alternatives rejected:* explicit per-project provisioning (diverges from every other table's lazy-heal model); per-workspace partitioned tables (Honeycomb doesn't partition by project for any table today).

4. **Watcher: `node:fs.watch`, mirror Honeycomb.** ✅ DECIDED. The watcher is `node:fs.watch` + `setTimeout`/`clearTimeout` debounce (`honeycomb/src/daemon/runtime/services/file-watcher.ts:333-375`, default 500ms) — chokidar is explicitly NOT a dependency. nectar reuses the same pattern; the corpus's "chokidar" references get corrected to "fs.watch." The ladder's step-3/step-4 already reconstruct moves from uncorrelated `(eventType, filename)` events (that's what cold-catch-up is for), so no capability is lost. *Alternatives rejected:* adopting chokidar (new dependency, diverges from Honeycomb's deliberate choice, marginal benefit since the ladder handles uncorrelated events); importing Honeycomb's file-watcher module directly (couples across the process boundary ADR-0002 established).

5. **Embeddings: build the provider switch now (local nomic default + Cohere-via-Portkey opt-in).** ✅ DECIDED. There's no provider-swap abstraction today (nomic is hard-wired at `honeycomb/embeddings/src/index.ts:46-60`). PRD-014 builds an `EmbedProvider` strategy switch modeled on the Cohere-rerank-via-Portkey transport (`honeycomb/src/daemon/runtime/recall/rerank-portkey.ts`); both providers honor the 768-dim contract or recall's `embed.dim_rejected` guard discards the vector. *Alternatives rejected:* local-only for v1 (operators who want hosted embeddings have no path); default-to-Cohere (flips away from the zero-marginal-cost local option the corpus cost-math was designed around).

6. **Portkey semantic caching: document as Portkey-server-side, no client toggle.** ✅ DECIDED. Semantic caching is configured in the Portkey dashboard (server-side via the `portkey.config` / virtual-key id), not toggled in this codebase — the codebase only *accounts for* upstream cached tokens, it doesn't enable caching. PRD-010c documents this honestly: brooding/enricher calls route through Portkey; caching happens upstream. *Alternatives rejected:* a client vault key that selects a cache-enabled config id (implies the client does the caching); a client-side response cache (duplicates Portkey's server-side cache, adds invalidation surface, doesn't fit the 30-50-file batch shape).

---

## PRD sequence (recommended build order)

Each PRD lists: **Spec source** (Nectar corpus doc(s)), **Conforms to** (Honeycomb code), **Sub-PRDs** (breakdown).

---

### PRD-001 — Architectural planning: the three-daemon topology (doctor / hive / nectar) and composition contract

**Description for next step:** The foundational PRD that nails down, in technical terms, the **three-daemon topology** locked in decision #1. Defines four roles and their boundaries: (a) **doctor** — the minimal, rarely-updated supervisor that gains a *minimal* daemon registry (the list of daemons to supervise, each with its own healthUrl/pidPath/probeInterval); (b) **hive** — a new always-on portal daemon, updateable independently, that boots on OS start and serves the unified dashboard by fetching from each registered daemon's API (one source of always-on UI truth); (c) **nectar** — the workload daemon this project ships (own OS process, own `/health`, own PID/lock, own Deep Lake client under the same org/workspace/project scope); (d) **honeycomb** — the existing workload daemon, also supervised by doctor and surfaced in hive's portal. Defines the data-layer composition (shared Deep Lake datasets, `project_id` as soft column filter per decision #3), the shared infrastructure nectar consumes (Portkey, embeddings, CodeGraph, recall engine), and the explicit non-integration points (no shared in-process state across any of the four). This PRD is the contract every later PRD conforms to and triggers an ADR-0003 recording the three-daemon topology (superseding the two-daemon framing in ADR-0002).

**Spec source:** `ADR-0002` (the independence decision this expands), `overview.md`, the three design pillars.
**Conforms to:** `honeycomb/src/daemon/index.ts:108-217` (daemon entry/lifecycle), `honeycomb/src/daemon/runtime/assemble.ts:619-1089` (composition root), `honeycomb/doctor/src/supervisor.ts:144-343` (the supervision contract to generalize), `honeycomb/doctor/src/config.ts:28-84` (the single-daemon config to extend into a registry).
**Sub-PRDs:** 001a (the four-role topology + ADR-0003), 001b (nectar process + lock + `/health` + Deep Lake client + tenancy scope), 001c (shared-infra consumption contract: Portkey/embeddings/CodeGraph/recall seams). *hive and doctor-registry are owned by PRD-003/004/017 below.*

---

### PRD-002 — Create the Nectar daemon

**Description for next step:** The daemon itself. Modeled on the Honeycomb daemon's composition root (`assembleDaemon`) but scoped to Nectar's job surface: the hiveantennae worker (watch → re-associate → mint/enrich), the brooding/bootstrap path, the projection-sync writer, and the CLI surface. Defines the daemon's bootstrap sequence (config load → Deep Lake client init → auth/scoping → worker start → socket bind → signal handlers), the single-instance guard, and the route scaffolding for its own API endpoints (PRD-008). This is the largest PRD; it produces the runnable `nectar daemon` process.

**Spec source:** `overview.md` (four operating modes), `ai/brooding-pipeline.md`, `ai/identity-and-reassociation.md`, `ai/enricher-and-llm-model.md`.
**Conforms to:** `honeycomb/src/daemon/runtime/assemble.ts` (the composition-root pattern to mirror), `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts:1-60` (the lease-based worker harness), `honeycomb/src/daemon/runtime/services/poll-loop.ts:1-40` (the adaptive poll loop).
**Sub-PRDs:** 002a (bootstrap + composition root), 002b (hiveantennae worker: watch→re-associate→mint/enrich), 002c (CLI surface: `nectar daemon`, `brood`, `prune`, `review-matches`, `rebuild-projection`), 002d (single-instance lock + graceful shutdown).

---

### PRD-003 — doctor supervision of the Nectar daemon (and registration in the new registry)

**Description for next step:** How nectar becomes a supervised daemon. Per decision #1, doctor gains a minimal daemon registry (owned by PRD-004); this PRD is the nectar side of that contract: (a) nectar exposes a `/health` endpoint answering `ok`/`degraded` (modeled on `honeycomb/src/daemon/runtime/health.ts`), (b) nectar writes its own PID/lock file at a path doctor reads, (c) an OS service unit (launchd/systemd/schtasks) starts nectar on boot and restarts on crash, and (d) **nectar is registered in doctor's new daemon registry** (its healthUrl/pidPath/probeInterval entry) so doctor polls it alongside Honeycomb and hive. Engages the remediation ladder (restart → reinstall → escalate). The registry itself is PRD-004's deliverable; this PRD consumes it.

**Spec source:** `ADR-0002` (the supervision decision), `overview.md`, decision #1.
**Conforms to:** `honeycomb/doctor/src/supervisor.ts:144-343` (watch loop), `honeycomb/doctor/src/remediation.ts:124-160` (restart rung + watchdog-war guards), `honeycomb/doctor/src/service/index.ts:129-234` (OS service unit install), `honeycomb/doctor/src/config.ts:28-84` (the per-daemon config shape the registry generalizes).
**Sub-PRDs:** 003a (`/health` endpoint + PID/lock file), 003b (OS service unit definition + install), 003c (nectar's registry entry + the watchdog-war guards against its own single-instance lock).

---

### PRD-004 — Out-of-band PRD: doctor daemon registry + hive portal daemon (the artifacts we hand to the doctor/hive projects)

**Description for next step:** Per decision #1, this is now **two coupled out-of-band PRDs** authored for the doctor + hive codebases (not Nectar). **(A) doctor gains a minimal daemon registry:** the single-daemon config (`doctor/src/config.ts:28-84`) generalizes to a named list of supervised daemons (honeycomb, hive, nectar), each with its own healthUrl/pidPath/probeInterval/startupGrace/restart thresholds, each with isolated incident + remediation state (so a nectar restart doesn't pollute honeycomb's incident log). The composition root (`doctor/src/compose/index.ts:190-534`) spawns one supervisor instance per registered daemon. doctor stays state-light and is updated only when a new daemon registers — it does NOT gain portal logic. **(B) introduce `hive` — a new always-on portal daemon:** boots immediately on OS start (supervised by doctor like the others), updateable independently of doctor, serves the unified dashboard by fetching data from each registered daemon's API (honeycomb's, nectar's). hive becomes the single always-on UI truth — the dashboard is up the moment the device boots, regardless of which workload daemon is healthy. This is the "PRD out of band that we will give the doctor" item, expanded by the topology decision to cover hive too. Lives in Honeycomb's requirements tree, not Nectar's.

**Spec source:** `ADR-0002` (motivation), decision #1 (the three-daemon topology).
**Conforms to:** `honeycomb/doctor/src/compose/index.ts:190-534` (composition root — generalize to N supervisor instances), `honeycomb/doctor/src/config.ts:28-84` (single-daemon config → registry schema), `honeycomb/doctor/src/supervisor.ts:144-343` (the per-daemon supervisor to instantiate per registry entry), `honeycomb/src/daemon/runtime/server.ts` + `src/dashboard/web/registry.tsx` (the dashboard surface hive will host — see PRD-015 for the page that lands there).
**Sub-PRDs:** 004a (doctor multi-daemon registry: config schema + per-daemon supervisor instances + isolated incident state), 004b (doctor status page + CLI multi-daemon reporting), 004c (hive daemon: bootstrap, always-on dashboard serving, API-aggregation from registered daemons), 004d (hive OS service unit + supervision registration).

---

### PRD-005 — Hive Graph catalog tables and lazy schema healing

**Description for next step:** The data layer. Defines the `hive_graph` and `hive_graph_versions` tables as Honeycomb `CatalogTable` entries (ColumnDef arrays, write patterns, embedding columns, scope) added to the `CATALOG` aggregation, and confirms they self-create on first write via `withHeal` (decision #3 — no per-project DDL event). Resolves the tenancy model: `scope: tenant` with explicit `org_id`/`workspace_id`/`project_id` columns (mirroring the `codebase` table), where `project_id` is a soft column filter within the workspace partition. Carries the full DDL from the spec verbatim.

**Spec source:** `data/hive-graph-schema.md` (the authoritative DDL), `ADR-0001` (the two-table split), `ADR-0002` (data layer unchanged).
**Conforms to:** `honeycomb/src/daemon/storage/schema.ts:28-100` (ColumnDef + the NOT-NULL-must-have-DEFAULT rule), `honeycomb/src/daemon/storage/catalog/types.ts:60-128` (CatalogTable/WritePattern/CatalogScope), `honeycomb/src/daemon/storage/heal.ts:286-313` (withHeal lazy-create), `honeycomb/src/daemon/storage/catalog/product.ts:313-319` (the `codebase` tenant-scoped table to mirror), `honeycomb/src/daemon/storage/catalog/index.ts:45-59` (the CATALOG aggregation to append to).
**Sub-PRDs:** 005a (`hive_graph` ColumnDef + catalog entry), 005b (`hive_graph_versions` ColumnDef + catalog entry + embedding column), 005c (tenancy + `project_id` soft-filter verification).

---

### PRD-006 — File registration protocol (create / move / delete / copy-paste)

**Description for next step:** The file-event intake that drives re-association. Defines the watcher contract against the REAL `node:fs.watch` implementation (decision #4 — not chokidar), the debounce window, and how raw `(eventType, filename)` events are classified into the re-association ladder's input (new path / changed path / missing path). Critically, `fs.watch` does NOT give correlated move semantics — so the ladder's step-3 (exact-hash-to-missing-file) and step-4 (TLSH fuzzy) must reconstruct moves from the event stream + a missing-files set, the same way the existing file-watcher's `scheduleSyncCycle` debounces. Defines the copy-event detector (new path whose hash matches an existing file's current content → mint fresh nectar + `derived_from`).

**Spec source:** `ai/identity-and-reassociation.md` (the 5-step ladder, copy-as-provenance), `ai/brooding-pipeline.md` (discovery + intake debounce).
**Conforms to:** `honeycomb/src/daemon/runtime/services/file-watcher.ts:333-375` (the fs.watch + debounce pattern to mirror), `:177-183` (debounceMs default 500), `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` (runGraphBuild as the parallel "respond to file change" template).
**Sub-PRDs:** 006a (fs.watch intake + debounce), 006b (event → ladder-step classification), 006c (copy-event detection + `derived_from_nectar` minting), 006d (the 5-step re-association ladder implementation, including the TLSH fuzzy step + confidence-scored review surface).

---

### PRD-007 — Brooding process (first-run full-codebase description)

**Description for next step:** The one-time bootstrap: discover files (reuse the CodeGraph's `git ls-files` discovery), content-hash pre-check against the committed projection (fresh-clone shortcut), bucket by size/type (skip-binary/skip-too-large/batch/solo with the 4KB/100KB/256KB thresholds), batch LLM calls (30–50 files via Gemini 2.5 Flash), write rows, embed, regenerate `.honeycomb/nectars.json`. Includes resumability via `describe_status` (no lockfile) and the CLI flags (`brood`, `--force`, `--limit N`, `--dry-run`). Cost math (~$3.05/2000 files) is the budget contract. The model choice + Portkey routing is delegated to PRD-010.

**Spec source:** `ai/brooding-pipeline.md` (the authoritative pipeline + cost math).
**Conforms to:** `honeycomb/src/daemon/runtime/codebase/api.ts:234-261` (the buildAggregateSnapshot discover→extract→persist pattern to mirror), `honeycomb/src/daemon/storage/catalog/projects.ts:152-218` (lazy-create pattern), the projection-sync write (PRD-011).
**Sub-PRDs:** 007a (discovery + content-hash pre-check), 007b (bucketing + batch/solo LLM call shapes), 007c (resumability state machine via describe_status), 007d (CLI surface + `--dry-run` cost preview).

---

### PRD-008 — Daemon API endpoints (exposed to the dashboard + manual search)

**Description for next step:** The HTTP surface the daemon exposes, mounted as Hono route groups the same way Honeycomb scaffolds `ROUTE_GROUPS` (`server.ts:71-96`). Endpoints: `/api/hive-graph/search` (manual semantic + lexical search, PRD-012), `/api/hive-graph/build` (trigger a brood, modeled on `/api/graph/build`), `/api/hive-graph/status` (queue depth, describe_status counts, cost counter), and the projection CRUD. Defines permission middleware inheritance (these are session-protected daemon routes).

**Spec source:** `overview.md` (daemon API), the CLI surface (each command often maps to an endpoint), `data/recall-integration.md` (the search contract).
**Conforms to:** `honeycomb/src/daemon/runtime/server.ts:71-96, 202-312` (ROUTE_GROUPS scaffolding + permission middleware), `honeycomb/src/daemon/runtime/codebase/api.ts:304-347` (mountGraphApi — the handler-attachment pattern to mirror).
**Sub-PRDs:** 008a (route group scaffolding + permission middleware), 008b (search endpoint), 008c (build/status/projection endpoints).

---

### PRD-009 — Harness exposure via recall extension (Claude Code, Codex, Cursor) — DECIDED: extend Honeycomb's recall, no Nectar-shipped hooks

**Description for next step:** **Decision recorded: Nectar does NOT ship its own harness hooks.** It gains agent-facing exposure by extending Honeycomb's shared recall engine (PRD-013 adds the `hive_graph_versions` arm), which automatically surfaces Hive Graph hits in every harness Honeycomb is already armed against — Claude Code, Codex, and Cursor included — with zero per-harness integration work. This is correct against the code: recall is a shared engine (`honeycomb/src/daemon/runtime/memories/recall.ts`) that all six harnesses already call through their hook loopback; a new arm propagates to all of them. This PRD is therefore a **documentation PRD**, not an implementation PRD: it records the decision, maps each of the three priority harnesses to the recall call site that already serves it, and confirms no Nectar-side connector/shim/hook-config is needed. It also defines the one real integration concern — ensuring nectar's `hive_graph_versions` rows are readable by the recall engine's storage client under the same org/workspace/project scope Honeycomb uses (a deploy-time tenancy invariant, per ADR-0002 decision).

**Spec source:** `data/recall-integration.md` (recall arm), `overview.md` (agent-consumed recall), `ADR-0002` (shared Deep Lake substrate).
**Conforms to:** `honeycomb/src/daemon/runtime/memories/recall.ts:2064-2119` (the Promise.all + arms array PRD-013 extends — this is the single integration point that serves all harnesses), `honeycomb/harnesses/claude-code/hooks/hooks.json` + `src/connectors/claude-code.ts:137-165` (Claude Code — already armed, no change), `honeycomb/src/connectors/codex.ts:48-99` (Codex — already armed, no change), `honeycomb/src/connectors/cursor.ts:83-136` (Cursor — already armed, no change).
**Sub-PRDs:** 009a (decision record + per-harness recall-call-site mapping + the tenancy-scope invariant). *Implementation of the arm itself lives in PRD-013; this PRD owns only the "why no hooks" documentation and the cross-harness verification that the extended recall surfaces in each.*

---

### PRD-010 — Portkey gateway integration (model routing, guardrails, semantic cache)

**Description for next step:** All LLM calls route through Portkey per the user's requirement. Defines how nectar's brooding/enricher calls hit Portkey's `/v1/chat/completions` (reusing Honeycomb's `buildPortkeyHeaders` + `PORTKEY_BASE_URL`), the default model (Gemini 2.5 Flash), the model-selection surface (`brood --force --model <new>`), and the `describe_model` audit column. **Open question (decision #6):** Portkey semantic caching is a *server-side* `portkey.config` feature, not a client toggle in Honeycomb today — this PRD must document that semantic caching is enabled in the Portkey dashboard config (the virtual-key/config id passed via `portkey.config`), not in this codebase, and confirm the cache-key behavior for description batching. Guardrails are likewise Portkey-server-side via the config id.

**Spec source:** `ai/enricher-and-llm-model.md` (Gemini 2.5 Flash + Portkey + describe_model), `ai/brooding-pipeline.md` (batch call shape).
**Conforms to:** `honeycomb/src/daemon/runtime/inference/transport-portkey.ts` (the transport to reuse), `honeycomb/src/daemon/runtime/inference/model-client-factory.ts:310-453` (Portkey client selection + fallback), `honeycomb/src/daemon/runtime/vault/api.ts:53-58` (portkey.enabled / portkey.config / portkey.fallbackToProvider vault keys).
**Sub-PRDs:** 010a (Portkey transport reuse + headers), 010b (model selection + describe_model audit), 010c (semantic-cache + guardrails documentation — the Portkey-server-side story).

---

### PRD-011 — Portable projection (`.honeycomb/nectars.json`) sync

**Description for next step:** The committed, regenerable lockfile. Defines the three generation triggers (end-of-brood, end-of-enricher-cycle, explicit `rebuild-projection`), the atomic write (temp + rename), the validation-on-load contract (version, project triple, ULID validity, sha256 validity), and the fresh-clone inheritance path. Enforces the projection-not-sidecar invariant (the three rules: Deep Lake writes first, never hand-edited, regenerable byte-identical modulo `generated_at`).

**Spec source:** `data/portable-registry.md` (the authoritative format + rules), `data/hive-graph-schema.md` (the projection contract).
**Conforms to:** `honeycomb/src/daemon/runtime/codebase/api.ts:251` (writeSnapshotAtomic — the atomic-write pattern to mirror), `honeycomb/src/daemon/storage/heal.ts` (the regenerable-from-source principle).
**Sub-PRDs:** 011a (format + generation triggers + atomic write), 011b (validation-on-load + fresh-clone inheritance), 011c (`rebuild-projection` CLI + the projection-not-sidecar enforcement).

---

### PRD-012 — Manual Hive Graph search

**Description for next step:** The operator-facing search capability. A query surface (CLI + dashboard endpoint) that runs the lexical + semantic search over `hive_graph_versions` (latest described version per nectar) WITHOUT necessarily fusing into the full recall — a focused "search just the file descriptions" tool. Reuses the BM25/vector engine but scoped to the hive-graph table. Distinct from PRD-013 (which adds the hive-graph arm to the *agent-facing* fused recall).

**Spec source:** `data/recall-integration.md` (the arm SQL shape), `overview.md`.
**Conforms to:** `honeycomb/src/daemon/runtime/memories/recall.ts:319-383` (the arm-SQL builder pattern), `honeycomb/src/daemon/runtime/services/embed-client.ts` (the embed client for the query vector).
**Sub-PRDs:** 012a (lexical + semantic search over hive_graph_versions), 012b (CLI `nectar search` + the `/api/hive-graph/search` endpoint from PRD-008).

---

### PRD-013 — Recall arm: add `hive_graph_versions` to the fused recall

**Description for next step:** The integration that makes Nectar descriptions surface alongside session/memory/memories hits in agent queries. Per decision #2, this is **per-arm**, not UNION ALL: add `"hive_graph_versions"` to `RecallSource`, add a weight to `ARM_CLASS_WEIGHT`, write `buildHiveGraphVersionsArmSql` (latest-per-nectar subquery, `describe_status='described'` filter, `project_id` scoping), add the `runArm` call + `rowsToRankedArm` entry, and optionally a semantic arm over the `embedding` column. The fail-soft contract (missing sibling → empty for that arm) is free. This is the "recall integration" the corpus is built around.

**Spec source:** `data/recall-integration.md` (the authoritative integration spec).
**Conforms to:** `honeycomb/src/daemon/runtime/memories/recall.ts:158-166` (ARM_CLASS_WEIGHT + kindOfSource), `:169` (RecallSource union), `:319-383` (the three arm builders to mirror), `:868-888` (SEMANTIC_ARMS), `:2064-2119` (the Promise.all + arms array — the exact insertion points), `:403-457` (fuseHits / RRF).
**Sub-PRDs:** 013a (lexical arm: builder + weight + insertion), 013b (semantic arm over embedding column), 013c (graceful BM25-only fallback when embeddings off).

---

### PRD-014 — Embeddings provider switching (local nomic OR Cohere via Portkey)

**Description for next step:** The provider-config abstraction that does NOT exist today (decision #5). Defines a `EmbedProvider` strategy switch modeled on the Cohere-rerank-via-Portkey transport: (a) the existing local nomic daemon (default, `embeddings.enabled` opt-out), (b) a new Cohere-via-Portkey embeddings transport hitting a Portkey embeddings endpoint. Both must honor the 768-dim contract (`EMBED_DIMS`) or recall's `embed.dim_rejected` guard discards the vector. The config surface extends the vault `embeddings.enabled` boolean to a provider selector. Important: changing the dimension is a schema event (the FLOAT4[] columns are 768).

**Spec source:** `ai/enricher-and-llm-model.md` (the embeddings layer + BM25 fallback), `ADR-0001` (768-dim tied to schema).
**Conforms to:** `honeycomb/embeddings/src/index.ts:46-60` (the hard-wired nomic consts to abstract), `honeycomb/src/daemon/runtime/services/embed-client.ts:80-177` (EmbedClient interface + options resolution), `honeycomb/src/daemon/runtime/recall/rerank-portkey.ts` (the Cohere-via-Portkey transport to model the embeddings variant on), `honeycomb/src/daemon/runtime/vault/api.ts:66` (the embeddings.enabled vault key to extend).
**Sub-PRDs:** 014a (EmbedProvider strategy + config surface), 014b (Cohere-via-Portkey embeddings transport + 768-dim contract), 014c (provider-switch + BM25-only fallback verification).

---

### PRD-015 — Dashboard Hive Graph page (new page, hosted by hive)

**Description for next step:** The dashboard surface. Per decision #1, the unified dashboard now lives in **hive** (the always-on portal daemon, PRD-004c) rather than the honeycomb daemon — so this page lands in hive's dashboard, fetching from nectar's PRD-008 endpoints via hive's API-aggregation layer. Per the research, the dashboard already had a codebase-graph view that was **removed for being too dense** (`registry.tsx:207-210`); `/graph` now renders only the memory graph. This PRD therefore adds a **new page** (`/hive-graph`), NOT a 3rd graph on the existing `/graph` page, learning from the density failure. One `RouteEntry` + one component (`HiveGraphPage`) hydrating via `usePoll`/`wire`, fetching from the PRD-008 endpoints (through hive). Defines what renders: the file graph (nodes = nectars, edges = `derived_from` provenance), search box (PRD-012), and status/queue/cost widgets.

**Spec source:** `overview.md` (Obsidian-style interlink view mentioned), the user's "3rd graph or a new page so it doesn't overload that page," decision #1 (hive hosts the dashboard).
**Conforms to:** `honeycomb/src/dashboard/web/registry.tsx:10-19, 83-94, 196-218` (the route registry + PageProps + "how to add a page" contract — the pattern hive inherits), `honeycomb/src/dashboard/web/pages/graph.tsx:435-482` (the GraphPage data-fetch pattern to mirror), `honeycomb/library/knowledge/private/dashboard/adding-a-page.md` (the documented procedure).
**Sub-PRDs:** 015a (route registry entry + HiveGraphPage component in hive), 015b (file-graph visualization: nectars + derived_from edges), 015c (search box + status widgets wired to nectar's PRD-008 endpoints via hive's aggregation).

---

### PRD-016 — Enricher steady-state loop + meaningful-change heuristic

**Description for next step:** The steady-state description-maintenance loop (brooding is the one-time bootstrap; this is everything after). Polls the pending queue every 30s, debounces via the 500ms watcher intake, applies the meaningful-change heuristic (Jaccard ≥ 0.85 = cosmetic → inherit, `describe_model = inherited-from:<prev_hash>`), calls the model via Portkey (PRD-010), embeds (PRD-014), updates `describe_status`. Includes the failure → `failed` → retry-solo path and the persistent-failure alert (5 cycles).

**Spec source:** `ai/enricher-and-llm-model.md` (the authoritative enricher contract + heuristic).
**Conforms to:** `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts` (the worker harness), `honeycomb/src/daemon/runtime/services/poll-loop.ts` (the adaptive poll loop).
**Sub-PRDs:** 016a (queue poll + debounce + meaningful-change heuristic), 016b (model call via Portkey + describe_model audit), 016c (failure handling + persistent-failure alert).

---

### PRD-017 - Service check-in and SQLite telemetry emission (added 2026-07, fleet realignment)

**Description for next step:** Added after the original sixteen were authored, so it appears in no scan-time analysis prior to 2026-07-02. The fleet realignment makes doctor the single source of truth for fleet telemetry: services write non-sensitive telemetry to their own local SQLite, doctor polls read-only on roughly a one-second interval plus the `/health` probe and relays one SSE to hive, with no service-to-doctor push (doctor `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`); registration is a static installer registry plus a runtime SQLite status row (doctor `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`). This PRD is nectar's side of that contract, mirroring honeycomb's PRD-071: (a) extend the shipped registry writer (`src/doctor-registry.ts`, from the PRD-003/004 work) so nectar's entry also records the on-disk path to its runtime telemetry SQLite database; (b) write runtime check-in status (binding time, last-seen heartbeat, current health sourced from the same `PipelineStatus` signal `/health` reports, so probe and poll never disagree); (c) emit non-sensitive since-restart metrics (files registered, nectars minted, descriptions generated, hive-graph versions written, embeddings computed) and bounded, rotated, verbosity-leveled logs to local SQLite via Node's built-in `node:sqlite` (Node >=22.5, no external dependency, preserving the built-ins-only ethos). The write path is fail-soft: a telemetry failure never blocks daemon boot or the nectar pipeline. Telemetry is operational, non-durable, and non-sensitive, so it does not violate FR-8; it follows the local-queue precedent, not the Deep Lake durable-state rule. No Deep Lake schema change.

**Spec source:** doctor `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` + `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`, honeycomb `prd-071-service-checkin-and-sqlite-telemetry` (the sibling contract), `ADR-0003` (the topology that makes nectar a supervised workload daemon).
**Conforms to:** `src/doctor-registry.ts` (`registerWithDoctor()` / `buildNectarRegistryEntry()`, the writer to extend), `src/health.ts` + `src/server.ts` (the `PipelineStatus` / `/health` source), the PRD-006/007/016 pipeline paths (counter wiring is DEFAULT, confirm before implementation).
**Sub-PRDs:** 017a (registry DB-path extension + runtime check-in and heartbeat), 017b (metrics emission), 017c (log emission, bounded + rotated).

---

## Spec'd CLI surface (must all ship; allocated across PRDs above)

| Command | Owner PRD | Notes |
|---|---|---|
| `nectar daemon` | PRD-002 | the runnable process |
| `honeycomb nectar brood` | PRD-007 | full brood |
| `honeycomb nectar brood --force` | PRD-007 | re-describe all |
| `honeycomb nectar brood --force --model <new>` | PRD-007 + PRD-010 | model-swap re-describe |
| `honeycomb nectar brood --limit N` | PRD-007 | cost cap |
| `honeycomb nectar brood --dry-run` | PRD-007 | cost preview |
| `honeycomb nectar prune --confirm` | PRD-006 | conservative orphan pruning, 30-day grace |
| `honeycomb nectar review-matches` | PRD-006 | low-confidence TLSH review surface |
| `honeycomb nectar rebuild-projection` | PRD-011 | explicit projection regen |
| `honeycomb nectar project --rebuild-projection` | PRD-011 | project-scoped variant |
| `nectar search` (proposed) | PRD-012 | manual hive-graph search |

---

## Deliberate spec gaps preserved (do NOT invent values during PRD authoring)

Per the hivenectar-stinger principles, these remain unspecified on purpose — PRDs must surface them as decisions for the user, not fill them:

- **TLSH confidence thresholds** ("tuned during brooding", no number) — PRD-006 must leave the threshold configurable + empirically tuned, not pinned.
- **`review-matches` sub-flag syntax** — PRD-006 specifies the command; the accept/reject flag surface is an implementation decision.
- **Symbol-level / directory nectars** — out of scope for v1; no PRD.

---

## Dependencies (build order rationale)

PRD-001 (three-daemon topology + ADR-0003) → **PRD-004 (out-of-band: doctor registry + hive portal — lands early, it's the foundation everything supervises against)** → PRD-005 (tables) + PRD-002 (nectar daemon) in parallel → PRD-003 (nectar supervision, consumes the registry) + PRD-006 (file protocol) → PRD-007 (brooding) + PRD-011 (projection) + PRD-016 (enricher) → PRD-010 (Portkey) + PRD-014 (embeddings provider) → **PRD-013 (recall arm — the load-bearing integration)** + PRD-008 (API) → PRD-009 (harness exposure documentation — *deferred to after PRD-013*) + PRD-012 (manual search) + **PRD-015 (dashboard page, hosted by hive — depends on PRD-004c hive existing)**.

**Two decisions recorded this revision:**

1. **Nectar extends Honeycomb's recall (PRD-013), not its own harness hooks.** PRD-009 collapses from a 4-sub-PRD implementation effort to a single documentation sub-PRD (009a). PRD-013 is the sole agent-facing integration point.

2. **The topology expands to three daemons (decision #1): doctor (minimal supervisor + registry), hive (always-on portal), nectar + honeycomb (workloads).** This promotes PRD-004 to a foundational, early-building PRD (it now owns both the doctor registry AND the new hive daemon) and moves PRD-015's dashboard target from the honeycomb daemon to hive. PRD-001 triggers an **ADR-0003** recording the three-daemon topology, superseding the two-daemon framing in ADR-0002. The net effect: more foundational infra work (a whole new daemon + a registry), but it buys the single-always-on-dashboard-truth the user asked for and a clean stability/velocity split between supervisor and portal.

**One addition recorded 2026-07-02:**

3. **PRD-017 joins the program (fleet realignment).** Its entry gate is PRD-002 + PRD-003 (both complete), because it extends the shipped registration surface and reads the shipped health source. Its counter wiring touches the PRD-006/007/016 pipeline paths but is additive and fail-soft, so PRD-017 runs in parallel with the Wave C pipeline work rather than joining its gate; the 007/016 counter touchpoints land whenever those PRDs do. The poll/merge/SSE side belongs to doctor (its PRD-001/002) and the read surface to hive (its PRD-005), both out of band.

---

*This index is for review. Every PRD description is grounded in cited Honeycomb code; the six decisions at the top are already resolved in the corpus before PRD authoring begins.*
