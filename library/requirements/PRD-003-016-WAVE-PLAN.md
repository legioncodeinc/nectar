# PRD-003 to PRD-016 Wave Plan (Hivenectar Implementation)

> Category: Requirements | Version: 1.0 | Date: July 2026 | Status: Draft

The ordered, gated execution plan that turns the `[PRD-003-016-DEPENDENCY-MAP.md](./PRD-003-016-DEPENDENCY-MAP.md)` into waves. Each wave groups PRDs that can run in parallel once its entry gate is satisfied; a wave gate is the set of verifiable exit criteria that must pass before the next wave starts. The authoritative brief is `[MASTER-PRD-INDEX.md](./MASTER-PRD-INDEX.md)`; status ground truth is `[reports/2026-07-01-prd-001-004-corpus-conformance-qa.md](./reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)` and `[EXECUTION_LEDGER.md](../ledger/EXECUTION_LEDGER.md)`.

---

## 1. Purpose and wave-gate methodology

**Purpose.** Sequence the 16-PRD Hivenectar program (across three repositories) so that at any moment a driver knows which PRDs may start, which are gated, what each wave's exit criteria are, and which model and watchdog policy applies. This plan is grounded in the dependency map; it does not re-derive edges.

**Wave-gate method.**

1. **Topological sort into waves.** PRDs are grouped so that every dependency of a PRD lands in an earlier wave. Within a wave, items are mutually independent and run in parallel.
2. **Entry gate.** A wave starts only when every dependency it consumes is verified complete (the prior wave's exit gate passed).
3. **Exit gate.** A wave completes only when every PRD in it has its acceptance criteria verified. Exit criteria are tied to the authored ACs (cited by PRD in the dependency map).
4. **Parallel vs sequential.** Items in the same wave run in parallel. Items with an intra-wave co-dependency (for example the search engine and its endpoint) are called out as sequential-within-wave.
5. **Watchdog.** Each wave spawns watchdog timers on its parallel tasks. A stalled task is terminated and its work redistributed across agents until the wave's exit gate passes (per the repo plan-construction protocol).
6. **Model routing.** Each task class names a spawnable model per the heuristic in `[.cursor/model-comparison-matrix.md](../../../.cursor/model-comparison-matrix.md)`, with a one-line justification.

**Scan-time reframing (important).** The commissioning brief planned Wave 0 as "author PRDs 005-016 from scratch." At scan time all of 005-016 are already authored under `backlog/` with complete acceptance criteria (see dependency map Section 7, D-1). Wave 0's authoring task is therefore reframed to "verify authoring completeness and QA each of 005-016 to the PRD-001-004 PASS standard" (they are QA-pending, not unwritten). The gate is unchanged in spirit: nothing in 005-016 enters implementation until it is QA-passed.

**Cross-repo caveat.** This plan is written from the `hivenectar` repo. Several PRDs land out-of-band: 004a/004b in the `hivedoctor` repo; 004c/004d/015 in the `honeycomb` repo (the new `thehive` package); 005 and 013 in the `honeycomb` data/recall layer; 010/014 straddle (hivenectar consumes; honeycomb transport reuse). The `hivenectar` repo tracks these but cannot merge them; each requires the owning repo's agents and human coordination (Risk R-3).

---

## 2. The two orderings, reconciled

**Master index linear order** (bottom of `MASTER-PRD-INDEX.md`):

001 -> 004 -> (005 + 002 parallel) -> (003 + 006) -> (007 + 011 + 016) -> (010 + 014) -> (013 + 008) -> (009 deferred-after-013 + 012 + 015).

**Corrected topological order** (this plan):

001 -> Wave A (002 + 004a + 005) -> Wave B (003 + 004b + 004c + 006 + 010 + 011 + 014) -> Wave C (007 + 016 + 013 + 012 engine) -> Wave D (008 + 012 endpoint) -> Wave E (015 + 009).

**Reconciliation.** The one substantive change is that 010 (Portkey) and 014 (embeddings provider) move earlier, into Wave B, so they precede the pipeline PRDs 007 and 016 in Wave C. The master index lists 010/014 after 007/011/016, but PRD-007 delegates its model call to PRD-010 and its embed to PRD-014, and PRD-016 calls the model via PRD-010 and embeds via PRD-014; their acceptance criteria cannot be verified without 010/014 present (dependency map D-6). This is a topological refinement, offered in the same spirit as the master index's own six locked decisions refining the original spec, not a correction of prior authoring. Two other master-index sequencing calls are preserved: PRD-009 lands last, after PRD-013 (the master index defers it, and 009 verifies 013's arm); PRD-015 lands last, as the terminal dashboard consumer.

---

## 3. Wave 0 (prerequisites): the design and QA gate

Wave 0 is the gate before any 005-016 implementation. It has four workstreams, all runnable in parallel.

**W0.1 - Finish the in-flight PRD-002 work.** An agent is actively working PRD-002 (brief). Per the ledger, PRD-002's documentation the-smoker run completed and shipped (all module ACs verified, double quality pass both PASS). Confirm the current in-flight scope is closed and reconcile its lifecycle location (it sits in `backlog/`, not `in-work/`; dependency map D-5). Do not touch PRD-002 files (read-only, another agent's active work).

**W0.2 - QA PRDs 005 to 016 to the PRD-001-004 standard.** Twelve independent quality passes (parallelizable), each authored by `quality-worker-bee` against the master index and the corpus, producing a per-PRD QA report in each PRD's `qa/` subfolder. This is the reframed authoring gate: the PRDs exist; they need the same medium-and-above PASS the first four modules earned. This is blocker B-1 in the dependency map.

**W0.3 - Close the open documentation defects.**

- Remediate W-1 (honeycomb code refs as non-resolving markdown links) in PRD-003, per the QA report Section 4 recipe (dependency map B-6).
- Confirm PRD-004d service-unit DEFAULT sign-off: `prd-004d-thehive-service-unit-and-registration.md` is authored and QA-passed (the earlier "absent" reading is retracted, verified against disk 2026-07-01, 8 ACs d-AC-1..d-AC-8). Its residual is that the thehive service-unit-name DEFAULT flags await sign-off (dependency map B-2, subsumed by B-7).
- Correct the stale PRD-013 -> PRD-009 cross-link slug (dependency map B-10), by the owning agent.

**W0.4 - Collect user sign-off on flags and gaps.**

- Sign off (or explicitly defer with authorization) every DEFAULT-confirm flag listed in dependency map B-7 (ports, PID/lock paths, `/health` shape, registry path and schema, unit names, startup grace, and the per-PRD defaults).
- Confirm the deliberate spec gaps stay unresolved by design: TLSH confidence threshold, `review-matches` sub-flag grammar, symbol/directory nectars, Portkey client-side cache toggle (dependency map B-8). These are surfaced as decisions, never filled without authorization.

**Wave 0 exit gate (all must pass):**

- [x] PRD-002 in-flight work closed; lifecycle location reconciled.
- [x] All twelve of PRD-005 to PRD-016 carry a QA report with a PASS at medium-and-above.
- [x] W-1 closed in PRD-003 (link-form honeycomb refs = 0).
- [x] PRD-004d confirmed authored + QA-passed; its DEFAULT service-unit-name flags signed off.
- [x] Every DEFAULT-confirm flag is signed off or its deferral is user-authorized.
- [x] Every deliberate spec gap is confirmed unresolved by design.

**Model routing (Wave 0):** QA passes on `claude-4.6-sonnet-medium-thinking` (balanced daily-driver, independent of any authoring bee), with a cross-model second pass on `gpt-5.5-medium` for high-risk PRDs (005, 006, 013) to avoid correlated blind spots, mirroring the PRD-002 double-pass pattern in the ledger. The W-1 doc conversion and any 004d authoring go to `claude-opus-4-8-thinking-high` (deep, nuanced multi-file doc work). **Watchdog:** the twelve QA passes run in parallel; a QA pass stalled beyond its timer is terminated and redistributed.

---

## 4. Implementation waves (A through E)

Each wave below assumes Wave 0 has passed for the PRDs it touches. "In-band" / "out-of-band" loci are from the dependency map Section 2 legend.

### Wave A - Foundation

**PRDs:** 002 (daemon, in-band), 004a (hivedoctor registry, OOB-hivedoctor), 005 (tables, honeycomb data layer).

**Parallel?** Yes, fully parallel. Each depends only on PRD-001, which is DONE. They land in three different repos, so they do not even share a merge surface.

**Entry gate:** PRD-001 verified (done); Wave 0 passed for 002/004/005.

**Exit gate (tied to ACs):**

- [x] 002: `hivenectar daemon` runs, binds `127.0.0.1:3854`, serves `/health`, acquires the single-instance lock before socket bind, and removes the PID/lock on shutdown (PRD-002 AC-M1..M7).
- [x] 004a: hivedoctor spawns one supervisor instance per registry entry with isolated incident state (PRD-004 AC-1, AC-2, AC-5).
- [x] 005: both tables self-create via `withHeal`, declare `scope: tenant`, and `project_id` is a soft column filter (PRD-005 ACs).

**Per-wave blockers:** none new; 002 is the XL long pole of this wave and its worker harness (002b) underpins Wave B.

**Model routing:** 002 and 005 on `composer-2.5` (IDE-bound agentic TypeScript in the daemon and the honeycomb catalog); the XL scope of 002 may escalate multi-file refactor slices to `claude-opus-4-8-thinking-high`. 004a on `gpt-5.3-codex-high` (the hivedoctor registry is config-schema plus supervisor-process wiring, CLI/DevOps-shaped). **Watchdog:** three parallel tasks; redistribute a stalled task (002 is the likeliest to stall given XL scope; split its four sub-PRDs across agents).

### Wave B - Supervision, providers, projection, intake

**PRDs:** 003 (supervision, in-band + registry touch), 004b (hivedoctor status/CLI, OOB-hivedoctor), 004c (thehive portal, OOB-thehive), 006 (file registration, in-band), 010 (Portkey, straddle), 011 (projection, in-band), 014 (embeddings switch, straddle).

**Parallel?** Mostly parallel. Each depends only on Wave A items. Two notes: 014 relates to 010's Portkey auth pattern (SOFT), so if 010 lands first the Cohere transport in 014b reuses it directly, but the two can proceed concurrently. 004c runtime-fetches PRD-008 endpoints (Wave D), so its aggregation `wire` is scaffolded here and bound to real endpoints in Wave D.

**Entry gate:** Wave A exit gate passed (002, 004a, 005 verified).

**Exit gate (tied to ACs):**

- [x] 003: hivedoctor probes `/health`, the installer appends hivenectar's registry entry, and the lock-held-and-healthy guard skips a redundant restart (PRD-003 AC-1..AC-5).
- [ ] 004b: `hivedoctor status` reports every registered daemon (PRD-004 AC-6).
- [ ] 004c: thehive serves the dashboard shell on boot without waiting for a workload daemon, and is upgradeable without restarting hivedoctor (PRD-004 AC-3, AC-4).
- [ ] 006: `node:fs.watch` intake debounces to one cycle; classification maps to new/changed/missing; the 5-step ladder is implemented with the deliberate gaps preserved (PRD-006 ACs).
- [ ] 010: brooding/enricher calls POST Portkey `/v1/chat/completions` with `buildPortkeyHeaders`; default model resolves to Gemini 2.5 Flash; `describe_model` is stamped (PRD-010 AC-1..AC-5).
- [ ] 011: projection writes atomically at the three triggers; validation-on-load ignores a mismatched projection; the fresh-clone path is zero-LLM (PRD-011 AC-1..AC-7).
- [ ] 014: local nomic default runs; Cohere-via-Portkey opt-in works; a non-768-dim vector is discarded; embeddings-off degrades to BM25 (PRD-014 AC-1..AC-4).

**Per-wave blockers:** none from 004d (it is authored + QA-passed); the thehive host chain (004c -> 004d -> 015) is unblocked at the file level, with only 004d's service-unit-name DEFAULT flags awaiting sign-off (B-2 / R-2, subsumed by B-7/R-7). 003b/003c reference 004d's service-unit pattern.

**Model routing:** 003b/004b/004c service-and-supervision wiring and 003's OS service units on `gpt-5.3-codex-high` (launchd/systemd/schtasks, installers, CLI). 006 (the hardest algorithm) and 014 (the provider strategy switch) on `claude-opus-4-8-thinking-high` (deep reasoning; 006's ladder + move reconstruction and 014's dim-contract guard are subtle). 010 and 011 on `composer-2.5` (transport reuse + atomic-write are tractable IDE coding). 004c's React dashboard shell on `composer-2.5`. **Watchdog:** seven parallel tasks; 006 is the likeliest to stall (algorithmic depth), split its four sub-PRDs.

### Wave C - Pipeline and recall integration

**PRDs:** 007 (brooding, in-band), 016 (enricher, in-band), 013 (recall arm, honeycomb recall), 012a (search engine, in-band).

**Parallel?** Yes, with data-presence coupling. 007 and 016 both populate `source_graph_versions`; 013's fail-soft ACs pass on an empty table, but its real-hit value needs data from 007/016; 012a's engine is verifiable against brooded rows. Sequence 007 to first-populated-rows before validating 013's end-to-end hits.

**Entry gate:** Wave B exit gate passed (010, 011, 014, 006, 005/002 from A all verified).

**Exit gate (tied to ACs):**

- [ ] 007: fixed discover -> pre-check -> bucket -> describe -> embed -> persist -> regenerate-projection order; four buckets and thresholds verbatim; cost math verbatim; `--dry-run` makes no LLM call; resumable via `describe_status` (PRD-007 ACs).
- [ ] 016: 30s poll selects latest pending per nectar; 500ms intake debounce; Jaccard >= 0.85 inherits; failure -> `failed` -> retry-solo; 5-cycle persistent alert (PRD-016 AC-1..AC-7).
- [ ] 013: `source_graph_versions` is a `RecallSource` member; the guarded arm mirrors `buildMemoriesArmSql` with the latest-per-nectar subquery and `describe_status='described'` filter; the semantic arm scores `embedding`; per-arm fail-soft holds (PRD-013 ACs).
- [ ] 012a: `searchSourceGraph` runs guarded lexical + `<#>` vector over the latest-per-nectar view; missing table degrades to `{ degraded: true }` (PRD-012 engine ACs).

**Per-wave blockers:** 013's real-hit validation depends on 007/016 having populated rows; keep 013's fail-soft ACs (empty-table) separable from its end-to-end ACs so the arm code can merge before the corpus is fully brooded.

**Model routing:** 013 (extends the shared `honeycomb/src/daemon/runtime/memories/recall.ts`, a load-bearing multi-file change) and 007 (the pipeline with verbatim cost/threshold fidelity) on `claude-opus-4-8-thinking-high`. 016 and 012a on `composer-2.5` (loop + query engine are tractable IDE coding), escalating the meaningful-change heuristic slice of 016 to `claude-opus-4-8-thinking-high` if the Jaccard-inheritance logic proves subtle. **Watchdog:** four parallel tasks; 007 and 013 are the deepest, split their sub-PRDs.

### Wave D - API surface

**PRDs:** 008 (008a/008b/008c, in-band), 012b (the search endpoint, in-band, co-developed with 008b).

**Parallel?** 008a (scaffolding) first, then 008b/008c in parallel. 012b and 008b are co-dependent: 012b specifies the `/api/source-graph/search` endpoint that 008b mounts, delegating to 012a's engine. Treat 008b + 012b as one sequential-within-wave unit.

**Entry gate:** Wave C exit gate passed (007 for the build endpoint, 012a for the search handler, 005/002 for storage and mount).

**Exit gate (tied to ACs):**

- [ ] 008a: the `/api/source-graph` route group mounts with `protect: true` and inherits permission middleware; an unfilled path returns the root 501 scaffold (PRD-008 AC-1, AC-3).
- [ ] 008b + 012b: `/api/source-graph/search` delegates to 012a's engine and returns the CLI-identical shape (PRD-008 AC-4; PRD-012 endpoint AC).
- [ ] 008c: `/build` triggers a brood, `/status` reports queue depth + `describe_status` counts + cost, projection read/regenerate resolve scope per-request through the injected client (PRD-008 AC-5).

**Per-wave blockers:** 004c's aggregation `wire` binds to these endpoints now; if 004c was not scaffolded in Wave B, thehive cannot aggregate.

**Model routing:** 008 on `composer-2.5` (Hono route-group mounting mirrors an existing honeycomb pattern; IDE-bound). Cross-check the permission-inheritance behavior with `gpt-5.5-medium` (broad generalist) given its security surface. **Watchdog:** 008a is the gating slice; if it stalls, the whole wave stalls, so prioritize and, if needed, single-thread 008a before parallelizing 008b/008c.

### Wave E - Dashboard and harness-exposure documentation

**PRDs:** 015 (dashboard page, OOB-thehive, terminal consumer), 009 (harness-exposure documentation, DOC).

**Parallel?** Yes, but for different reasons. 015 is the terminal consumer (needs 004c host + 008 endpoints + 012 search). 009 is documentation deferred to after 013 (Wave C) by the master index; it can be drafted any time after 013 lands but is sequenced last so its "the arm exists and propagates" claims are truthful.

**Entry gate:** Wave D exit gate passed (008 verified); 004c host ready (Wave B) with 004d resolved; 013 verified (Wave C, for 009).

**Exit gate (tied to ACs):**

- [ ] 015: `/source-graph` is a new route added by one `RouteEntry`; the page hydrates via `wire` + `usePoll`; the file graph renders nectars + `derived_from_nectar` edges; the search box calls PRD-012's endpoint; status/queue/cost widgets read PRD-008; hivenectar-down degrades gracefully; the page is not a third graph on `/graph` (PRD-015 AC-1..AC-7).
- [ ] 009: the decision record, the per-harness recall-call-site mapping (Claude Code, Codex, Cursor), and the deploy-time tenancy invariant are documented; it ships no code and invents no value for a deliberate gap (PRD-009 AC-1..AC-5).

**Per-wave blockers:** none from 004d (it is authored + QA-passed, so the boot-on-start thehive host chain is unblocked at the file level). 015's boot-on-start posture (PRD-004 AC-3) depends on 004d's service-unit-name DEFAULT flags being signed off (B-2 / R-2, subsumed by B-7/R-7).

**Model routing:** 015 on `composer-2.5` (React dashboard page mirroring `GraphPage`, IDE-bound). 009 on `claude-4.6-sonnet-medium-thinking` (documentation with citation verification; no code). **Watchdog:** two tasks; 015 is the long pole, 009 is XS.

---

## 5. Critical path

The terminal long pole is **PRD-015** (the dashboard page), the deepest node in the graph. A representative longest hard-dependency chain to it is:

**PRD-001 -> PRD-005 -> PRD-014 -> PRD-007 -> PRD-008 -> PRD-015** (six stages).

This chain funnels through two chokepoints:

- **PRD-007 (brooding)** is the widest gating cluster: it needs 005, 002, 006, 010, 011, and 014 all present before it can run. Any slip in that cluster slips 007, and 007 gates 008 (the `/build` and `/status` endpoints) which gates 015.
- **PRD-008 (API)** is the second chokepoint: it needs both 007 (build/status) and 012 (search) before 015 can hydrate its search box and widgets.

Two chains run in parallel and must converge at 015:

- **thehive host chain:** PRD-001 -> PRD-004a -> PRD-004c -> PRD-004d -> PRD-015. Every PRD on this chain is authored (004d is authored + QA-passed); the only residual is 004d's service-unit-name DEFAULT sign-off (Risk R-2, subsumed by R-7).
- **search chain:** PRD-001 -> PRD-005 -> PRD-014 -> PRD-012 -> PRD-008 -> PRD-015.

Separately, the **load-bearing agent-facing integration** is a shorter path: PRD-001 -> PRD-005 -> PRD-014 -> PRD-013 (-> PRD-009 documentation). This is not the 015 long pole. The commissioning brief proposed the critical path as 001 -> 005 -> 013/014 -> 008/012 -> 015; the correction is that PRD-013 feeds the agent recall path (and PRD-009), not the dashboard: the 015 long pole runs through 014 -> {007, 012} -> 008, with 013 on a parallel branch. Shortening the program end-to-end means protecting the 005 -> 014 root and the 007/008 funnel, and signing off 004d's service-unit DEFAULT flags early so the thehive host chain does not become the binding constraint at the very end.

---

## 6. Blockers and risks register

Severity: HIGH (blocks a wave gate or the program), MEDIUM (blocks a PRD or needs sign-off), LOW (hygiene). Owner-type is the role best placed to resolve it.


| ID   | Sev    | Risk / blocker                                                                                                                                                                                                                             | Affected                        | Owner type                 | Mitigation                                                                                                                                                           |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | HIGH   | PRDs 005-016 are authored but QA-pending; implementation cannot be verified to the 001-004 bar until each passes QA. This is the Wave 0 gate.                                                                                              | 005-016                         | quality-worker-bee         | Run twelve parallel QA passes in Wave 0; do not start Wave A implementation of a PRD whose QA has not passed.                                                        |
| R-2  | LOW    | PRD-004d (thehive OS service unit + registration) is authored and QA-passed (the earlier "absent" finding is retracted, verified against disk). Residual: its thehive service-unit-name DEFAULT flags await sign-off, subsumed by B-7/R-7. | 004d                            | user                       | Sign off the thehive service-unit-name DEFAULT flags (tracked under R-7).                                                                                            |
| R-3  | HIGH   | Out-of-band cross-repo work cannot fully complete inside `hivenectar`: 004a/004b (hivedoctor repo), 004c/004d/015 (honeycomb/thehive), 005/013 (honeycomb data/recall), 010/014 (straddle).                                                | 004a-d, 005, 013, 015, 010, 014 | human + owning-repo agents | Coordinate merges with the owning repos; the `hivenectar` repo tracks these PRDs but cannot land them. Sequence cross-repo waves against the owning repos' capacity. |
| R-4  | MEDIUM | PRD-009 is explicitly deferred to after PRD-013 by the master index, which conflicts with a "no deferrals unless authorized" mandate unless sequenced as the final integration document.                                                   | 009                             | driver + user              | Sequence 009 last (Wave E) as the closing integration doc; if "no deferrals" is strict, record explicit user authorization for the after-013 ordering.               |
| R-5  | MEDIUM | Ordering correction: 010/014 must land no later than 007/016. Following the master index linear order literally would leave 007/016 ACs unverifiable.                                                                                      | 007, 016, 010, 014              | driver                     | Adopt the corrected order (010/014 in Wave B, before the Wave C pipeline). Documented in Section 2.                                                                  |
| R-6  | MEDIUM | W-1 (honeycomb code refs as non-resolving markdown links) is open in PRD-003.                                                                                                                                                              | 003                             | library-worker-bee         | Convert the remaining PRD-003 link tokens to backtick spans in Wave 0 per the QA report Section 4 recipe.                                                            |
| R-7  | MEDIUM | All DEFAULT-confirm flags require user sign-off before implementation: ports 3853/3854, PID/lock paths, `/health` shape, registry path and schema, unit names, startup grace, and the per-PRD defaults (dependency map B-7).               | all                             | user                       | Collect sign-off per DEFAULT in Wave 0 before its PRD enters implementation. The flags are authored; only the values await confirmation.                             |
| R-8  | MEDIUM | Deliberate spec gaps must not be filled without explicit user authorization: TLSH confidence threshold, `review-matches` sub-flag grammar, symbol/directory nectars, Portkey client-side cache toggle.                                     | 006, 010; global                | user                       | Keep unresolved; surface as decisions only. Any PRD that fills one silently fails QA.                                                                                |
| R-9  | MEDIUM | The PRD-002 two-model double-QA was transiently blocked by a flapping platform billing error before a later retry succeeded (both PASS). The billing flakiness is a live process risk for any future double-QA (Wave 0's twelve passes).   | Wave 0 QA throughput            | driver / platform owner    | Build retry-with-backoff into the QA dispatch; keep a substitute single-model verification path (content-integrity proof) as the ledger did for PRD-002.             |
| R-10 | LOW    | Two corpus/PRD disagreements remain open corpus edits in PRD-005/PRD-006 territory (the `confidence` column, the `skipped-deleted` enum).                                                                                                  | 005, 006                        | knowledge-worker-bee       | Reconcile in a corpus edit before 005/006 implementation; out of scope for this plan.                                                                                |
| R-11 | LOW    | PRD-013 index cross-links PRD-009 with a stale folder slug; the link does not resolve.                                                                                                                                                     | 013                             | owning agent               | Correct to `prd-009-harness-exposure-via-recall` in Wave 0.                                                                                                          |
| R-12 | LOW    | PRD-002 is marked in-flight but sits in `backlog/`, not `in-work/`.                                                                                                                                                                        | 002                             | the-smoker / driver        | Move the folder to `in-work/` if actively implemented, per lifecycle-equals-location.                                                                                |


---

## 7. Definition of 100 percent complete

The program is complete only when all of the following hold, across all three repositories:

1. **Every PRD 001 to 016 is authored, QA-passed at medium-and-above, and implemented**, with every module acceptance criterion and every sub-PRD user story verified. PRDs 005 to 016 are authored at scan time but QA-pending; QA is a hard gate (R-1).
2. **The out-of-band PRDs are merged in their owning repos:** 004a/004b in `hivedoctor`; 004c/004d/015 in `honeycomb`/`thehive`; 005 and 013 in the `honeycomb` data/recall layer; 010/014 straddle placement resolved (R-3).
3. **No deferrals remain unless explicitly authorized.** The "no deferrals unless explicitly authorized" mandate means each of the following must be either resolved or carry a recorded user authorization to defer:
  - PRD-009's after-013 deferral (R-4).
  - The W-1 PRD-003 code-reference Warning (R-6).
  - PRD-004d's service-unit-name DEFAULT sign-off (R-2; the file itself is authored + QA-passed).
  - Every DEFAULT-confirm flag (R-7).
  - Every deliberate spec gap (R-8): resolving one requires explicit user authorization, and the default posture is to keep it open by design.
4. **The load-bearing integration works end-to-end:** a query like "where is the login logic" returns a Hivenectar file description fused with session/memory hits in every armed harness (PRD-013 + PRD-009), and the operator dashboard renders the Source Graph page with live search and status (PRD-015).
5. **The lifecycle-equals-location invariant holds:** completed PRD folders (index + sub-PRDs + `qa/`) are moved to `completed/`; in-progress PRDs live in `in-work/` (R-12).

### Wave-gate checklist template (copy per wave)

```text
## Wave <ID> gate: <name>
Entry gate:
- [ ] All upstream dependencies verified complete (list: <PRD ids>)
- [ ] Wave <ID-1> exit gate passed
Scope (parallel unless noted):
- [ ] <PRD id> - <title> - owner <agent/model> - watchdog timer <duration>
- [ ] <PRD id> - <title> - owner <agent/model> - watchdog timer <duration>
Exit gate (tie each to an AC id):
- [ ] <PRD id> AC-<n>: <verifiable criterion>
- [ ] <PRD id> AC-<n>: <verifiable criterion>
Blockers cleared:
- [ ] <blocker id> resolved or user-authorized to defer
Sign-off:
- [ ] security-worker-bee pass at medium-and-above on the wave delta
- [ ] quality-worker-bee pass at medium-and-above on the wave delta
- [ ] DEFAULT flags in scope signed off; deliberate gaps confirmed unresolved
```

---

*This plan is analysis and sequencing, not a PRD. It depends on* `[PRD-003-016-DEPENDENCY-MAP.md](./PRD-003-016-DEPENDENCY-MAP.md)` *for the edges it orders. Verified afterward by an independent quality-worker-bee pass against the master index and corpus.*