# PRD Decisions and Defaults — for review

> Category: Requirements | Version: 1.1 | Date: July 2026 | Status: Active

The 16 Nectar PRDs are authored (65 files, originally under `library/requirements/backlog/prd-001` through `prd-016`; lifecycle locations have since moved per the program status in `MASTER-PRD-INDEX.md`) and have passed the quality-worker-bee line-by-line audit. A seventeenth PRD (PRD-017, service check-in + SQLite telemetry) was added 2026-07 and carries its own flagged defaults; see decision #27. This doc consolidates: (A) the decisions you've already locked, (B) the defaults flagged in-PRD for your confirmation, (C) the two corpus inconsistencies the QA pass surfaced (both resolved in the PRDs, both needing a matching corpus edit), and (D) the QA audit results.

---

## A. Decisions locked (already applied across all PRDs)

These are settled — recorded here for traceability, no action needed.

| # | Decision | Where applied |
|---|---|---|
| 1 | Three-daemon topology: doctor (minimal supervisor + registry) / hive (always-on portal, TS/Node+Hono, reuses honeycomb dashboard) / nectar + honeycomb (workloads) | PRD-001, 004, 015 |
| 2 | Recall: per-arm guarded query (NOT UNION ALL); correct corpus prose | PRD-013 |
| 3 | Tables: lazy withHeal; project_id as soft column filter (not a partition) | PRD-005 |
| 4 | Watcher: node:fs.watch (NOT chokidar); mirror Honeycomb | PRD-006 |
| 5 | Embeddings: build provider switch (local nomic default + Cohere-via-Portkey) | PRD-014 |
| 6 | Portkey semantic cache: server-side via portkey.config; NO client toggle | PRD-010c |
| 7 | Harness exposure: extend Honeycomb recall, NO own hooks | PRD-009 |
| 8 | Registry storage: static config file, edited by installers | PRD-004 |
| 9 | hive stack: TS/Node + Hono, reuse honeycomb dashboard code | PRD-004c |
| 10 | Execution: all PRDs then one quality pass | (done) |
| 11 | Granulars: propose defaults, flag for review | this doc §B |
| 12 | Ports: honeycomb=3850, embeddings=3851, doctor-status=3852, hive=3853, nectar=3854 | PRD-001b, 004, all |
| 13 | confidence column: durable, added to hive_graph_versions | PRD-005b, 006d |
| 14 | skipped-deleted: added to describe_status enum | PRD-005b, 016c |
| 15 | Default model id: `gemini-2.5-flash` (canonical id; confirm against Portkey registry before first brood). SIGNED OFF 2026-07-02, see #29 | PRD-010b |
| 16 | Cohere embed model: `embed-english-v3.0` (English-only; reconcile the 1024→768 dim mismatch per PRD-014b's dim contract). SUPERSEDED by #30 (embed-v4.0 at `output_dimension: 768`) | PRD-014b |
| 17 | Recall arm weight: `ARM_CLASS_WEIGHT` for hive_graph_versions = 1.0 (peer with distilled memory); operator-tunable via `nectar_rrf_multiplier`. **AMENDED + SCOPED 2026-07-02 (closes the QA W-1 gap):** the multiplier mechanism is now specified in PRD-013a: honeycomb reads `recall.nectar_rrf_multiplier` from `~/.honeycomb/nectar.json` once at boot, fail-soft to 1.0, clamped to [0, 10], applied per-SOURCE to the hive_graph_versions fusion contribution only, logged once at boot when non-default | PRD-013a |
| 18 | CodeGraph access: re-implement `git ls-files` discovery locally in nectar (no honeycomb module import, no HTTP service) — keeps nectar self-contained across the process boundary | PRD-001c, 002, 007 |
| 19 | Registry hot-add: next-boot supervision (no SIGHUP/reload, no file-watch) — a newly-registered daemon is supervised at doctor's next boot | PRD-004a/d |
| 20 | /health shape: **PURPOSE-BUILT for nectar** (REVISED — originally "full parity"; reversed after review). nectar's `/health` carries the coarse `ok`/`degraded` bit doctor classifies on (the non-negotiable minimum) PLUS nectar-native subsystem fields honeycomb's `/health` does not have: brooding status + progress (`active`, `filesDescribed`, `filesTotal`, `lastEventAt`), enricher queue + last file (`queueDepth`, `lastCycleAt`, `consecutiveFailures`, `lastFileDescribed`), projection last-write (`lastWriteAt`, `lastContentHash`), cost telemetry (`broodTotalTokens`, `broodTotalUsd`), provider state (`embeddings.provider`, `portkey.enabled`). Rejected: full honeycomb parity (would ship inert fields for nectar's nonexistent local/team/hybrid auth modes while omitting the signal an operator actually needs) AND coarse-only (too thin). Full body shape in PRD-001b. | PRD-001b, 003a |
| 21 | Tenancy enforcement: doctor-mediated assertion — doctor gains a Deep Lake scope-comparison capability and refuses to supervise a daemon whose org/workspace scope mismatches another registered daemon's. Centralizes the invariant in the supervisor (heavier lift than a bootstrap check, but architecturally cleaner). PRD-004 must document doctor's new scope-awareness | PRD-001c, 004, 009a |
| 22 | Batch size: DYNAMIC — pack files until estimated context (input tokens) approaches the batch budget, capped by the 100KB cumulative (`BATCH_TOTAL_SIZE`) + a max-files safety ceiling (the corpus's 30-50 band). Adapts to actual file sizes rather than counting files; preserves the cost math. Replaces the fixed-40 default | PRD-007b |
| 23 | OS service names: mirror honeycomb's convention — launchd `com.hivenectar.daemon`, systemd `nectar`, schtasks `HivenectarDaemon`. SUPERSEDED by #32 (fleet-wide short-name + reverse-DNS scheme) | PRD-003b |
| 24 | TLSH impl: native addon (NAPI) — fastest fuzzy-match computation; same install-time native-build risk honeycomb's tree-sitter already manages | PRD-006d |
| 25 | review-matches: interactive prompt by default (list → choose → confirm); NO flag grammar committed. Optional batch flags deferred to implementation | PRD-006d |
| 26 | hive is a distinct architectural component with its own ADR: ADR-0004 records the four binding decisions (always-on + boot-order, API-aggregation-not-Deep-Lake, dashboard ownership + honeycomb code reuse, independent update cadence) + a companion knowledge doc (`architecture/hive-portal-daemon.md`) holds the full design detail | ADR-0004, knowledge doc |
| 27 | PRD-017 added (2026-07, fleet realignment): nectar check-in + local telemetry via Node's built-in `node:sqlite`, sibling of honeycomb PRD-071, governed by doctor ADR-0001 (pull-only telemetry transport) + ADR-0002 (static registry + runtime SQLite status). Telemetry is operational, non-durable, non-sensitive, so it does not violate FR-8. Its own DEFAULT flags: counter identifiers (fresh in-process since-restart counters), heartbeat cadence, log retention bound, status-row placement (one DB, separate tables) | PRD-017 |
| 28 | `fingerprint TEXT` (nullable) column added to `hive_graph_versions`, immediately after `confidence` (user-authorized 2026-07-01): persists the step-4 TLSH fingerprint so cold-catch-up fuzzy matching survives a daemon restart. Applied to the corpus DDL, PRD-005b, and the shipped PRD-006 code | corpus, PRD-005b, PRD-006 |
| 29 | **SIGNED OFF 2026-07-02:** default description model id is `gemini-2.5-flash`, resolved client-side via the `activeModel` vault setting, overridable per-run with `brood --force --model <new>` | PRD-010b |
| 30 | **SIGNED OFF 2026-07-02 (supersedes #16):** the Cohere-via-Portkey embeddings opt-in targets **Cohere embed-v4.0 with `output_dimension: 768`** (Matryoshka-native), so the opt-in genuinely produces contract-valid 768-dim vectors. Model id and output dimension are config values, not hardcoded; recall's `embed.dim_rejected` guard stays as the backstop. `embed-english-v3.0` (1024-dim, non-Matryoshka) is rejected as the target. **AMENDMENT NEEDED (flagged 2026-07-02 PM, verified against Cohere docs): embed-v4.0's `output_dimension` accepts only [256, 512, 1024, 1536]; 768 is NOT a valid value, so the premise fails and the opt-in as configured would be inert (guard-discarded). The shipped transport is config-driven, so the fix is a one-line default change; awaiting user pick: (a) 1024 + client-side Matryoshka truncate/renormalize to 768, (b) a natively-768 hosted model via the same gateway (e.g. OpenAI text-embedding-3-small `dimensions: 768`), or (c) keep inert-until-operator-config. Local nomic default unaffected** | PRD-014b |
| 31 | **SIGNED OFF 2026-07-02:** projection path `.honeycomb/nectars.json` at the project root + 30s write debounce (carried from the enricher cycle cadence) | PRD-011 |
| 32 | **SIGNED OFF 2026-07-02 (supersedes #23 and the shipped per-repo names):** fleet-wide OS service naming uses the product short names `honeycomb` / `doctor` / `hive` / `nectar` AND reverse-DNS labels: launchd `com.legioncode.<name>`, systemd `<name>.service`, schtasks `<name>`. Replaces the shipped `ai.honeycomb.daemon` (honeycomb), `com.legioncode.hivedoctor`/`hivedoctor.service`/`HiveDoctor` (doctor), `hive`/`thehive.service`/`hive` (hive), and `com.hivenectar.daemon`/`hivenectar.service`/`HivenectarDaemon` (nectar). Migration: uninstall/reinstall is acceptable; each installer deregisters the old unit name when re-run. **IMPLEMENTED 2026-07-02 in all four repos:** new constants + a best-effort legacy deregister (old unit name + old unit file) at the start of every install/register (`nectar/src/service/`, `doctor/src/service/`, `hive/src/service/`, `honeycomb/src/cli/daemon-service.ts`), each with per-platform tests | PRD-003b, PRD-004d; honeycomb/doctor/hive/nectar service modules |
| 33 | **SIGNED OFF 2026-07-02 (PRD-017 retro flags, two amendments):** counter identifiers (the 5 shipped counters: filesRegistered, nectarsMinted, descriptionsGenerated, hiveGraphVersions, embeddingsComputed) and status-row placement (one DB, `service_status`/`service_metrics`/`service_logs` tables) are RETRO-CONFIRMED as shipped. Heartbeat cadence is AMENDED 10s -> **5s** (faster last-seen staleness detection against doctor's ~1s poll). Log retention is AMENDED from the 5,000-row cap to an **age bound (24h)** so quiet daemons keep less stale history. **IMPLEMENTED 2026-07-02:** `checkin.ts` `DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000`; `logs.ts` `DEFAULT_LOG_MAX_AGE_MS = 24h` with ts-cutoff rotation (replacing the row-cap delete), fail-soft against a non-parseable clock; tests updated. Consumers unaffected (doctor reads whatever rows exist) | PRD-017a/017c |
| 34 | **SIGNED OFF 2026-07-02 (Wave C DEFAULT adoption):** the documented per-PRD defaults are adopted as-is, all config-overridable: 007 discovery `git ls-files --cached --others --exclude-standard -z` (+ #22 dynamic packing); 016 poll 30s / intake debounce 500ms / Jaccard 0.85 / 5-cycle alert; 012 search result LIMIT 20; 013 arm weight 1.0 (with the #17 multiplier mechanism). Route group path `/api/hive-graph` and 015 route/label follow the same adopt-as-documented posture at their waves | PRD-007/012/013/016 (008/015 at their waves) |
| 35 | **SIGNED OFF 2026-07-02 (global product rename):** Hivenectar -> **nectar**, Hivedoctor -> **doctor**, The Hive/thehive -> **hive**, and source graph -> **hive graph** (source_graph -> hive_graph tables, source-graph -> hive-graph slugs/routes, SourceGraph -> HiveGraph identifiers; a third party holds the "Sourcegraph" mark). Applied as a fleet-wide sweep across all five repos (content + file/dir renames); the decision-#32 LEGACY unit-name literals, the Hivemind product name, and the Bee Army identifiers are explicitly excluded. Runtime contract renames ride along consistently: the doctor registry file is `~/.honeycomb/doctor.daemons.json`, registry entry names are the short names, telemetry DB filenames follow. Nothing published to npm carries the old names; beta users notified out of band | all repos |
| 36 | **SIGNED OFF 2026-07-02 (closes QA W-4, PRD-012):** the manual search CLI verb is **`nectar search <query>`** on nectar's own binary, consistent with every shipped verb (`install`, `daemon`, `rebuild-projection`, `prune`, `review-matches`); the `honeycomb hivenectar <verb>` corpus prose predates the standalone binary and is superseded by the rename (#35) | PRD-012b |
| 37 | **SIGNED OFF 2026-07-02 (decision #30 as amended, closes the 768-dim flag):** the hosted embeddings opt-in defaults to **OpenAI `text-embedding-3-small` with `dimensions: 768`** through the same Portkey gateway (natively 768-capable; zero client-side math). The selector value is renamed `cohere` -> **`hosted`** (model-agnostic); Cohere models stay reachable by config with the dim guard as backstop. Implemented in `src/embeddings/hosted-portkey.ts` | PRD-014b |
| 38 | **SIGNED OFF 2026-07-02 (ADR-0002 env decoupling, implemented):** nectar REQUIRES no honeycomb environment variable. nectar-owned primaries: `NECTAR_TELEMETRY` (opt-out), `NECTAR_POSTHOG_KEY/HOST` (release bake), `NECTAR_PROJECT_ID`/`NECTAR_PROJECT_ROOT`, `NECTAR_*` Portkey/embeddings config. DETECTED (honored when present, never required): `HONEYCOMB_TELEMETRY=0`, `HONEYCOMB_PROJECT_ID`, the honeycomb install-id, and the shared deeplake surfaces (`~/.deeplake/credentials.json`, `~/.deeplake/projects.json`). Per-project scoping mirrors honeycomb's resolver in nectar's own `src/hive-graph/project-scope.ts`: NECTAR_PROJECT_ID > detected HONEYCOMB_PROJECT_ID > projects.json longest-prefix binding > canonicalized git-remote signal (read from `.git/config`, no shell) > the workspace `__unsorted__` inbox | nectar |
| 39 | **SIGNED OFF 2026-07-02 (closes QA W-1, PRD-015):** the PRD-015b file graph hydrates from PRD-008c's EXISTING projection-read endpoint (`GET /api/hive-graph/projection`) and transforms the projection into the `GraphWire` shape client-side; no new nectar endpoint is added, and PRD-008's authored scope (search/build/status/projection) stays intact. Decision rule applied: the projection document (`src/projection/format.ts`, [`data/portable-registry.md`](../knowledge/private/data/portable-registry.md) § The file format) carries every field the graph needs: nodes from the `files` map (key = nectar ULID → node `id`; `files[id].path` → node `label`; kind derived client-side from the path), edges from the `derived` map (key = derived nectar → `from`; `from_nectar` → `to`), so the preferred zero-new-API-surface branch fired rather than authoring a nodes/edges endpoint into PRD-008c. The projection is complete (latest-per-nectar), so it carries no server-side `meta.truncated`; density is bounded solely by the client `capGraphForRender` cap (b-AC-8 respec). Applied across `prd-015b` (Goals, Non-Goals, b-AC-1/2/3/6/8, node/edge mapping table, Hydration, Density, Related), the `prd-015` index (Non-Goals, API changes), and `prd-015a` (wire seam) | PRD-015a/b, index; PRD-008c (consumed, unchanged) |

---

## B. Defaults flagged for your confirmation

Each is marked "DEFAULT — confirm before implementation" in its PRD. None blocks authoring; each should be confirmed before the implementing engineer treats it as fixed. Grouped by category.

### Ports + paths (confirmed via your decision #12, listed for completeness)
- hive: 3853, `~/.honeycomb/hive.pid`/`.lock` (PRD-001, 004)
- nectar: 3854, `~/.honeycomb/nectar.pid`/`.lock` (PRD-001b, 002, 003)
- doctor registry file: `~/.honeycomb/doctor.daemons.json` (PRD-004a)
- projection: `.honeycomb/nectars.json` at project root (PRD-011)
- nectar config: `~/.honeycomb/nectar.json` (PRD-002)

### Schema (PRD-005)
- WritePattern hive_graph: `update-or-insert`
- WritePattern hive_graph_versions: `append-only`
- CatalogScope: `tenant` for both
- Catalog group name: `hive-graph`

### Brooding (PRD-007)
- Discovery command: `git ls-files --cached --others --exclude-standard -z`
- Batch packing: **LOCKED by decision #22** — dynamic token-budget packing, capped by the 100 KB cumulative `BATCH_TOTAL_SIZE` + a max-files safety ceiling in the corpus's 30-50 band (supersedes the earlier fixed-40 default; PRD-007b reconciled 2026-07-02)

### Enricher (PRD-016) — values from corpus, confirm exact strings
- Enricher poll interval: 30s
- Watcher intake debounce: 500ms (mirrors `file-watcher.ts:177`; corpus left it unspecified)
- REDESCRIBE_THRESHOLD: 0.85 (Jaccard)
- Persistent-failure alert: 5 consecutive failed cycles
- Projection write debounce: 30s

### File protocol (PRD-006)
- debounceMs: 500 (mirrors honeycomb)
- TLSH impl: native addon OR WASM (flag both, no commitment)
- Prune grace: 30 days
- review-matches sub-flag syntax: interactive prompt by default; flag grammar unspecified

### Portkey + models (PRD-010, 014)
- Default model id: `gemini-2.5-flash`: **SIGNED OFF 2026-07-02 (decision #29)**; verify the literal string against Portkey's registry at implementation as a mechanical check, not a decision
- Portkey chat endpoint: `https://api.portkey.ai/v1/chat/completions`
- Cohere embed model: **SIGNED OFF 2026-07-02 as embed-v4.0 with `output_dimension: 768` (decision #30, supersedes the `embed-english-v3.0` default)**; model id + output dim are config values
- Cohere endpoint via Portkey: `/v1/embeddings`: **confirm gateway advertises this path** (mechanical check at implementation)

### Recall arm (PRD-013)
- ARM_CLASS_WEIGHT for hive_graph_versions: 1.0 (same as distilled memory)
- Per-arm LIMIT: matches existing arms' default

### Supervision (PRD-003)
- /health response shape: `{ status, uptimeMs, checks: {...} }`
- OS service unit names: **SIGNED OFF 2026-07-02 as the fleet-wide scheme (decision #32)**: launchd `com.legioncode.nectar`, systemd `nectar.service`, schtasks `nectar` (supersedes the shipped `com.hivenectar.daemon`/`hivenectar.service`/`HivenectarDaemon`; migration via uninstall/reinstall)
- startupGraceMs: 60000

### Topology (PRD-001)
- ADR-0003 slug: `three-daemon-topology`
- Tenancy-scope invariant enforcement mechanism: PRD-002/003 operations decision
- CodeGraph consumption mechanism (import/HTTP/re-implement discovery): PRD-002/007 decision
- /health reasons-block granularity: PRD-002/003 decision (coarse bit is the contract)

### Search (PRD-012)
- `nectar search <query>` command; result LIMIT 20

### Dashboard (PRD-015)
- Route `/hive-graph`; page label "Hive Graph"

---

## C. Corpus inconsistencies the QA pass surfaced (PRDs resolved; corpus needs matching edit)

The QA audit caught two places where the Nectar knowledge corpus (`library/knowledge/private/`) disagrees with itself. The PRDs have been written to the resolved state; the corpus docs need a matching edit to stay consistent.

1. **`confidence` column.** `ai/identity-and-reassociation.md` says fuzzy-match rows "carry a confidence field," but `data/hive-graph-schema.md`'s DDL never declared it. **Resolved in PRDs:** `confidence REAL` (nullable) added to PRD-005b's DDL + ColumnDef. **Corpus action needed:** add the same column to `data/hive-graph-schema.md`'s `hive_graph_versions` DDL + column table. **STATUS: APPLIED.** The corpus DDL and column table now carry `confidence REAL` (nullable). The later `fingerprint TEXT` column (decision #28) rode the same corpus edit path.

2. **`skipped-deleted` enum value.** The enricher failure-modes table (in `ai/enricher-and-llm-model.md`) uses `describe_status = 'skipped-deleted'`, but `data/hive-graph-schema.md`'s enum only lists 5 values. **Resolved in PRDs:** `skipped-deleted` added to PRD-005b's enum. **Corpus action needed:** add `skipped-deleted` to the enum in `data/hive-graph-schema.md`'s describe_status column description. **STATUS: APPLIED.** The corpus `describe_status` description now lists all six values including `skipped-deleted`.

3. **(Bonus, from earlier in this session)** The corpus says "chokidar" in many places; the code uses `node:fs.watch`. PRDs use `fs.watch` per decision #4. **Corpus action needed:** correct "chokidar" → "fs.watch" across the corpus. **STATUS: no-op.** On applying this edit, a corpus-wide grep found **zero** chokidar references — every watcher reference in the corpus already correctly says `node:fs.watch`. The QA finding that flagged "the corpus says chokidar" was itself a false positive (the auditor likely conflated the corpus with the original spec sketch). No edit needed; the corpus and PRDs already agree on `fs.watch`.

---

## D. QA audit results

Two quality-worker-bee audits (armed with hivenectar-stinger) covered all 16 PRDs line-by-line. **4 blocking findings, all fixed:**

| # | Finding | Fix |
|---|---|---|
| 1 | PRD-004c fabricated a port conflict (claimed doctor status page binds 3853; actually 3852) | Removed the fabricated conflict; hive=3853 is genuinely free |
| 2 | PRD-005b vs PRD-006d: `confidence` column claimed but not in DDL | Added `confidence REAL` to PRD-005b (your decision) |
| 3 | Broken cross-PRD slugs (wrong folder names) in PRD-002/007/009/015/016 | Swept all 11 files to correct slugs |
| 4 | PRD-016/007: `2000ms` debounce invented (corpus says "configurable window"; code says 500ms) | Corrected to 500ms with proper code citation |

**No hallucinations in the high-risk numeric surfaces:** brooding cost math ($3.05/$0.65/$2.40/318/2.15M), model comparison table ($3.05/$7.00/$11.50/$3.00), projection JSON format, and the 3 enforcement rules all verified verbatim against their corpus sources. **Zero open questions or TODOs** in any PRD (flagged defaults only, per your "nothing deferred" rule). **Final verdict: 16/16 PRDs PASS** after the 4 fixes.

---

## What's next (updated 2026-07-02)

1. **Confirm the §B defaults.** PARTIALLY DONE 2026-07-02 (decisions #29-#33): model id (`gemini-2.5-flash`), the Cohere dim reconciliation (embed-v4.0 at 768), projection path + debounce, PRD-017's four flags (two amended: heartbeat 5s, log retention 24h age bound), and the fleet-wide service naming scheme (short names + reverse-DNS, all four repos). STILL OPEN: the remaining per-PRD defaults for unimplemented PRDs (007 discovery command + batch cap, 016 cadences/threshold/alert count, 012 search LIMIT + CLI name, 013 arm weight + LIMIT, 015 route/label/icon, 008 route group path), to be signed off before each enters implementation.
2. ~~**Apply the §C corpus edits**~~ DONE. Items 1 and 2 are applied to the corpus (§C status notes); item 3 was a no-op false positive.
3. ~~**Move PRDs to in-work/**~~ IN MOTION. PRD-001 through 006 are in `completed/`; 010/011/014 are in `in-work/`; the rest remain in `backlog/`. Lifecycle-equals-location now holds.
4. **QA PRD-017** to the 001-004 standard before its implementation begins (it is the only authored PRD with an empty `qa/` folder besides 009 and 015, which are QA-pending like the rest of the backlog).

Nothing in the PRDs is deferred; every decision is either locked, flagged as a default for your confirmation, or surfaced as a corpus edit (now applied). Ready for your review.
