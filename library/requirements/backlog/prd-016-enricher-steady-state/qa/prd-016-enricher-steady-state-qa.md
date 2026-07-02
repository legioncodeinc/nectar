# QA Report: PRD-016 Enricher Steady-State Loop (PRD-vs-Corpus/Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-016 (index + 016a/016b/016c) against the Nectar knowledge corpus and the cited Honeycomb code, armed with quality-stinger + hivenectar-stinger. This is the Wave-0 spec-QA gate (blocker B-1): no implementation exists yet. Every acceptance criterion and load-bearing claim was traced to `ai/enricher-and-llm-model.md` (AUTHORITATIVE: the enricher contract, the two debounce layers, the meaningful-change heuristic, rate limiting, failure modes), `data/hive-graph-schema.md` (the `describe_status` enum and `hive_graph_versions` columns the enricher drives), the `PRD-003-016-DEPENDENCY-MAP.md` / `PRD-DECISIONS-AND-DEFAULTS.md` decision ledger, and the real files under `honeycomb/src/daemon/runtime/services/poll-loop.ts`, `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts`, and `honeycomb/src/daemon/runtime/services/file-watcher.ts`. Matches the bar and format of the PRD-005 and PRD-010 reports.

**Related:**
- [`../prd-016-enricher-steady-state-index.md`](../prd-016-enricher-steady-state-index.md)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md)
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md)
- [`../../PRD-003-016-DEPENDENCY-MAP.md`](../../PRD-003-016-DEPENDENCY-MAP.md)
- [`../../PRD-DECISIONS-AND-DEFAULTS.md`](../../PRD-DECISIONS-AND-DEFAULTS.md)

---

## 1. Summary

PRD-016 is one of the most heavily gated modules (six upstream HARD dependencies: 002, 005, 006, 010, 011, 014) and its spec substance is strong: all 31 module + sub-PRD acceptance criteria trace to a corpus section or a Honeycomb code citation, the three highest-risk numeric claims (30s poll, `REDESCRIBE_THRESHOLD` 0.85, 5-consecutive-failed-cycles alert) are verbatim corpus facts, the `inherited-from:<prev_content_hash>` `describe_model` convention is grounded exactly, the `failed` → retry-solo ladder and the failure-modes table are carried verbatim from `ai/enricher-and-llm-model.md`, the `skipped-deleted` enum value matches decision #14 and the corpus DDL description, and every cited Honeycomb symbol (`poll-loop.ts:1-227`/`:192-227`, `stage-worker.ts:171`/`:210-217`/`:236-260`) exists at the cited line range with **zero drift** — a clean result across three separately-cited spans. Documentation-framework conformance on the honeycomb-code-reference form is clean (zero link-form tokens; every honeycomb ref is already a backtick span).

The module **PASSES with warnings** at the medium-and-above standard: **zero Critical findings**. **Five mechanical link/syntax defects** (a stray backtick and four lifecycle-stale cross-PRD links, including the specifically flagged PRD-006 reference) were found and **remediated in this pass** per the audit's remediation policy. **Two medium Warnings remain open** (not fixed, reported for developer/library-worker-bee judgment): (W-6) the 500ms watcher-intake-debounce DEFAULT is labeled "From corpus, confirm" in two places even though the corpus explicitly leaves the debounce window unspecified — the true origin is Honeycomb's `file-watcher.ts:177` (`debounceMs = 500`, also PRD-006's own flagged DEFAULT), not a corpus-stated number; and (W-7) PRD-016 never documents that a completed enricher cycle invokes PRD-011's projection-write trigger #2, despite the dependency map naming this the sole downstream dependency of PRD-016. A separate, out-of-folder inconsistency was also found and is reported for the doc owner's attention: `MASTER-PRD-INDEX.md:183` still states a stale "2000ms watcher intake," contradicting the authored PRD-016 files and the decisions ledger's own record that this was already "corrected to 500ms."

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-016 index | WARNING (W-7) | WARNING (W-6) | PASS | PASS | PASS (post-remediation) | PASS-with-warnings |
| PRD-016a | WARNING (W-7) | WARNING (W-6) | PASS | PASS | PASS (post-remediation; carried W-2/W-3/W-4/W-5) | PASS-with-warnings |
| PRD-016b | PASS | PASS | PASS | PASS | PASS (post-remediation; carried W-4) | PASS |
| PRD-016c | PASS | PASS | PASS | PASS | PASS (post-remediation; carried W-5); note N-1 | PASS |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-6 (Correctness, index + 016a): the 500ms watcher-intake-debounce DEFAULT is mislabeled "From corpus, confirm"

Both `prd-016-enricher-steady-state-index.md:75` and `prd-016a-queue-poll-debounce-meaningful-change.md:134` (post-remediation line numbers) end their 500ms flagged-default bullet with the boilerplate "From corpus, confirm" — the same tail used for the genuinely corpus-grounded 30s poll and 0.85 threshold bullets. But `ai/enricher-and-llm-model.md` § Watcher intake debounce never states a number:

> "The `node:fs.watch` intake debounces events per-path with a configurable window. ... This mirrors Honeycomb's existing `fs.watch` + `setTimeout` debounce pattern and avoids adding another watcher dependency."

The 500ms figure's true origin is Honeycomb's shipped code, `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (`debounceMs = 500`), which is also PRD-006's own carried-forward flagged DEFAULT (`debounceMs: 500 (mirrors honeycomb)` per `PRD-DECISIONS-AND-DEFAULTS.md` §B). The decisions ledger itself discloses this precisely: `PRD-DECISIONS-AND-DEFAULTS.md` §B states "Watcher intake debounce: 500ms (mirrors `file-watcher.ts:177`; corpus left it unspecified)" — i.e., the ledger's own phrasing correctly distinguishes "mirrors code" from "from corpus," but the PRD-016 bullets' generic trailing sentence does not carry that same distinction.

To be clear, this is not a hallucinated value: the number is correct (verified against `file-watcher.ts:177`, confirmed live in this audit), and the parenthetical on the same line already says "mirrored from Honeycomb's `fs.watch` + `setTimeout` pattern, DECISION #4" — so the honest disclosure exists mid-sentence. The defect is narrower: the closing "From corpus, confirm" implies the number itself is corpus-sourced, which is not the same claim as "the corpus describes a configurable window and Honeycomb's shipped code fixes it at 500ms."

**Impact:** An implementer skimming only the trailing confirm-tag (the common skim pattern for a "Flagged defaults" list) could conclude the corpus is the source of record for 500ms and skip verifying against the actual code constant. No runtime impact; correctness-of-grounding only.

**Recommendation (reported, not applied — a wording judgment call, not a mechanical fix):** Replace the trailing "From corpus, confirm" on this bullet only with something like "Mirrors `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (`debounceMs = 500`) and PRD-006's own flagged DEFAULT; the corpus states only that the window is configurable. Confirm before implementation." Leave the 30s/0.85/5-cycle bullets' "From corpus, confirm" tail unchanged (those ARE literal corpus numbers).

### W-7 (Completeness, index + all three sub-PRDs): the PRD-011 co-dependent trigger is never documented in PRD-016

`PRD-003-016-DEPENDENCY-MAP.md` §4 (PRD-016 profile) declares: "011 | HARD (co-dependent) | The end of an enricher cycle that wrote new descriptions is trigger #2 for the projection; the enricher invokes 011's writer" — and lists PRD-011 as the **only** downstream dependent of PRD-016 ("Downstream dependents: 011 (trigger #2 source; co-dependent)"). Yet across the index and all three sub-PRDs, PRD-011 is mentioned exactly twice, both in `prd-016b-model-call-and-describe-model-audit.md` (lines 56, 95), and both only in the narrow context of the `describe_model` marker "round-trip[ping] through the projection unchanged (PRD-011a)" — not as a description of the enricher invoking the projection writer at the end of a cycle.

By contrast, the index's Non-Goals section explicitly calls out every other touching PRD it excludes (PRD-007 brooding, PRD-010 Portkey transport, PRD-014 embeddings, PRD-006 re-association ladder, PRD-010b model swap) — PRD-011 is the one HARD/co-dependent relationship in the dependency map that has no matching Non-Goal, Related-section citation, or implementation note anywhere in the PRD-016 folder.

**Impact:** An implementer working strictly from PRD-016's text would have no signal that completing an enricher cycle must invoke PRD-011's atomic projection write (or that PRD-011 co-develops against this exact cycle-completion signal). The behavior itself is correctly owned and specified on PRD-011's side (AC-2: "an enricher cycle writes new descriptions -> projection rewritten atomically"), so this is a cross-reference gap, not a missing behavior.

**Recommendation (reported, not applied — a content addition, not a mechanical fix):** Add one Non-Goals bullet to the index (mirroring the existing five) along the lines of: "Regenerating the portable projection. PRD-011 owns the atomic-write trigger; the enricher's only obligation is that completing a cycle which wrote new descriptions is trigger #2 for PRD-011's writer." Consider a matching one-line Related-section entry pointing at `../../in-work/prd-011-portable-projection/`.

## 5. Suggestions (consider improving) and sub-medium notes

- **N-1 (informational, 016c):** `prd-016c-failure-handling-persistent-alert.md:36` preserves the corpus's mid-sentence capitalization ("until an operator **A**cknowledges") verbatim from `ai/enricher-and-llm-model.md` § Rate limiting, which itself carries the same capitalization. This is explicitly a verbatim carry, not a PRD-introduced typo, so it is not flagged as a defect here; the corpus source would need the same fix for consistency (out of scope for this audit — corpus is read-only per the remediation policy).
- **N-2 (out-of-folder, flagged for the doc owner, not fixed):** `MASTER-PRD-INDEX.md:183` (outside `prd-016-enricher-steady-state/`, so out of this audit's write scope) states: "debounces via the **2000ms** watcher intake" — contradicting the authored PRD-016 files' 500ms value. `PRD-DECISIONS-AND-DEFAULTS.md` §D item 4 records this exact discrepancy as already found and "Corrected to 500ms with proper code citation," but that correction reached only the PRD-016 files, not the master index's one-paragraph summary. Recommend `library-worker-bee` update `MASTER-PRD-INDEX.md:183`'s "2000ms" to "500ms" for consistency with the now-locked value.

## 6. Plan Item (AC) Traceability

### PRD-016 index (7 module ACs)

| AC | Corpus / code source | Verdict |
|---|---|---|
| AC-1: latest pending version per nectar, grouped by nectar, ordered by `MIN(observed_at)`, scoped to project | `ai/enricher-and-llm-model.md` § Enricher queue debounce (verbatim SQL block) | PASS |
| AC-2: multiple `(eventType, filename)` events within the 500ms window collapse to one signal | `ai/enricher-and-llm-model.md` § Watcher intake debounce (window described, not numbered — see W-6 for the number's true source) | PASS (behavior grounded; numeric-attribution precision flagged W-6) |
| AC-3: Jaccard ≥ 0.85 → cosmetic → inherit title/description/concepts/embedding, `describe_model = inherited-from:<prev_content_hash>`, no LLM call | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic (step 3, verbatim) | PASS |
| AC-4: Jaccard < 0.85 → meaningful → enters pending queue | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic (step 4) | PASS |
| AC-5: `describe_model` records the producing model id | `ai/enricher-and-llm-model.md` § Why Gemini 2.5 Flash specifically; `data/hive-graph-schema.md:108` (`describe_model` column doc) | PASS |
| AC-6: batch fails all Portkey retries → `describe_status = 'failed'`, retried solo next cycle | `ai/enricher-and-llm-model.md` § Rate limiting; § Failure modes and observability (verbatim table) | PASS |
| AC-7: 5 consecutive failed cycles (default) → dashboard alert, enrichment halts until ack | `ai/enricher-and-llm-model.md` § Rate limiting — "default: 5 consecutive cycles" (verbatim) | PASS |

### PRD-016a queue/poll/debounce/heuristic (8 ACs)

| AC | Source | Verdict |
|---|---|---|
| AC-016a.1.1: pending-work query selects `MAX(seq) per nectar WHERE describe_status='pending'`, scoped, ordered by `MIN(observed_at)` | `ai/enricher-and-llm-model.md` § Enricher queue debounce (SQL block matches character-for-character) | PASS |
| AC-016a.1.2: five edits within one cycle → only latest pending row selected; intermediates stay NULL forever | `ai/enricher-and-llm-model.md` § Enricher queue debounce ("their descriptions stay NULL forever, which is correct") | PASS |
| AC-016a.2.1: events on same path within 500ms window collapse to one changed-file signal | `ai/enricher-and-llm-model.md` § Watcher intake debounce (behavior); numeric value from `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (`debounceMs = 500`, verified live, zero drift) | PASS (see W-6 on attribution precision) |
| AC-016a.2.2: events on different paths debounce independently | `ai/enricher-and-llm-model.md` § Watcher intake debounce ("debounces events per-path") | PASS |
| AC-016a.3.1: Jaccard ≥ 0.85 → inherit title/description/concepts/embedding | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 3 | PASS |
| AC-016a.3.2: cosmetic inheritance → `describe_status='described'`, `describe_model=inherited-from:<prev_content_hash>`, no LLM call | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 3 | PASS |
| AC-016a.4.1: Jaccard < 0.85 → meaningful | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 4 | PASS |
| AC-016a.4.2: meaningful change → `describe_status='pending'` for next cycle | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 4 | PASS |

Code-citation spot-check: `honeycomb/src/daemon/runtime/services/poll-loop.ts:1-227` is the file's exact full length (227 lines, verified via `wc -l`); `buildWorkerPollLoop` at `:192-227` is exact (function starts line 192, file ends line 227). `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts:171` (`DEFAULT_POLL_INTERVAL_MS = 1_000`) is exact; `:210-217` is exact (the `this.loop = buildWorkerPollLoop({...})` constructor block). **Zero drift on all four cited spans.**

### PRD-016b model call + describe_model audit (6 ACs)

| AC | Source | Verdict |
|---|---|---|
| AC-016b.1.1: enricher calls model via Portkey `/v1/chat/completions` (PRD-010 transport) with version row content | `ai/enricher-and-llm-model.md` § What Nectar needs from the model; PRD-010a (transport owner, not re-specified here) | PASS |
| AC-016b.1.2: valid description object → `title`/`description`/`concepts` written, `describe_status='described'` | `data/hive-graph-schema.md:101-103` (column purposes) | PASS |
| AC-016b.2.1: LLM-produced description → `describe_model` records producing model id | `ai/enricher-and-llm-model.md` § Why Gemini 2.5 Flash specifically; `data/hive-graph-schema.md:108` | PASS |
| AC-016b.2.2: cosmetic inheritance → `describe_model = inherited-from:<prev_content_hash>` | `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 3 | PASS |
| AC-016b.3.1: description written + embeddings on → 768-dim embedding over `title + ' ' + description` via configured provider | `ai/enricher-and-llm-model.md` § Embeddings (verbatim: "computes a 768-dim embedding over `title + ' ' + description`") | PASS |
| AC-016b.3.2: embeddings off → embedding NULL, `describe_status='described'`, BM25 fallback, no error | `ai/enricher-and-llm-model.md` § Embeddings ("no error, no quality cliff, just lexical-only recall") | PASS |

### PRD-016c failure handling + persistent alert (10 ACs)

| AC | Source | Verdict |
|---|---|---|
| AC-016c.1.1: malformed JSON → retried once with stricter prompt | `ai/enricher-and-llm-model.md` § Failure modes and observability (verbatim table row 1) | PASS |
| AC-016c.1.2: retry still fails → each row marked `failed`, processed solo next cycle | `ai/enricher-and-llm-model.md` § Failure modes and observability (verbatim table row 1) | PASS |
| AC-016c.1.3: wrong-length response → same retry-then-solo path | `ai/enricher-and-llm-model.md` § Failure modes and observability (verbatim table row 2) | PASS |
| AC-016c.2.1: batch exceeds context window → split in half, retried | `ai/enricher-and-llm-model.md` § Failure modes and observability (verbatim table row 4) | PASS |
| AC-016c.3.1: file deleted while pending → `describe_status='skipped-deleted'` next cycle, no LLM call | `ai/enricher-and-llm-model.md` § Failure modes and observability (verbatim table row 6); `data/hive-graph-schema.md:109` (enum incl. `skipped-deleted`, decision #14) | PASS |
| AC-016c.4.1: 5 consecutive failed cycles (default) → dashboard alert | `ai/enricher-and-llm-model.md` § Rate limiting (verbatim "default: 5 consecutive cycles") | PASS |
| AC-016c.4.2: alert raised → enrichment halts until operator acknowledges | `ai/enricher-and-llm-model.md` § Rate limiting (verbatim, incl. the corpus's own capitalization of "Acknowledges," see N-1) | PASS |
| AC-016c.4.3: cycle succeeds before threshold → counter resets to zero | Corpus does not state this explicitly; reasonable implication of "consecutive," not a hallucinated number (no numeric claim made) | PASS (no grounding risk — behavioral inference, not a fabricated figure) |
| AC-016c.5.1: every cycle logs described/inherited/failed/tokens/cost | `ai/enricher-and-llm-model.md` § Failure modes and observability ("Every enricher cycle logs...") | PASS |
| AC-016c.5.2: dashboard surfaces rolling 24h cost counter + queue-depth gauge via PRD-008 status endpoint | `ai/enricher-and-llm-model.md` § Failure modes and observability; PRD-008 index (`/api/hive-graph/status`, SOFT dep, correctly Non-Goal'd) | PASS |

Code-citation spot-check: `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts:236-260` is exact — the cited span is precisely the `processLeased` method (kind-routing guard → `handler(job)` in a try → `queue.complete` on success → `queue.fail` in the catch), matching the claimed "route → run → complete/fail harness shape ... handler throws → `queue.fail`." **Zero drift.**

## 7. Deliberate items preserved (NOT flagged as gaps)

- **All four DEFAULT-confirm flags** (30s poll, 500ms debounce, 0.85 threshold, 5-cycle alert) are correctly marked `[DEFAULT — confirm before implementation]` in every file that states them (index, 016a, 016b, 016c as applicable), consistent with `PRD-DECISIONS-AND-DEFAULTS.md` §B's "Enricher (PRD-016) — values from corpus, confirm exact strings" list. None is silently hardcoded as settled.
- **Symbol/directory-level description remains a stated v1 non-goal.** Not re-litigated anywhere in PRD-016.
- **Automatic re-description on model swap is correctly excluded** as a Non-Goal (index, 016b), matching the corpus's "What the enricher explicitly does not do" and PRD-010b's `brood --force --model <new>` ownership.
- **No double-retry logic is invented.** 016c explicitly defers all transient-429/5xx backoff to Portkey/PRD-010 and scopes its own retry to the content-level malformed-JSON case only — matches `ai/enricher-and-llm-model.md` § Rate limiting exactly.
- **The `skipped-deleted` enum value** is used correctly and consistently (016c) and matches decision #14 (`PRD-DECISIONS-AND-DEFAULTS.md` §A) and the corpus DDL description (`data/hive-graph-schema.md:109`), which already lists all six `describe_status` values. No invented enum value.

## 8. High-risk surfaces verified verbatim / against source

- SQL pending-work query (016a) — character-for-character match to `ai/enricher-and-llm-model.md` § Enricher queue debounce.
- Failure-modes table (016c, 6 rows) — character-for-character match to `ai/enricher-and-llm-model.md` § Failure modes and observability.
- `REDESCRIBE_THRESHOLD` default 0.85, `inherited-from:<prev_content_hash>` marker format — exact match to `ai/enricher-and-llm-model.md` § The "meaningful change" heuristic step 3.
- Persistent-failure alert "5 consecutive cycles" — exact match to `ai/enricher-and-llm-model.md` § Rate limiting.
- `honeycomb/src/daemon/runtime/services/poll-loop.ts:1-227` (whole file, 227 lines) and `:192-227` (`buildWorkerPollLoop`) — exact, zero drift.
- `honeycomb/src/daemon/runtime/pipeline/stage-worker.ts:171` (`DEFAULT_POLL_INTERVAL_MS = 1_000`), `:210-217` (constructor wiring), `:236-260` (`processLeased`) — exact, zero drift across all three spans.
- `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (`debounceMs = 500`) — confirmed live as the true origin of the 500ms figure (see W-6; the PRD's own citations don't pin this exact line, but the value itself is correct).
- `data/hive-graph-schema.md`'s `describe_status` enum (six values incl. `skipped-deleted`) and `describe_model`/`embedding`/`confidence` column docs — consistent with every 016-family claim.

No fabricated values, no invented SQL-helper names, no invented enum values.

## 9. Dependency-map conformance

PRD-016's dependency profile per `PRD-003-016-DEPENDENCY-MAP.md` §4 is HARD-dependent on 002, 005, 006, 010, 011, 014, with 011 as a co-dependent (bidirectional trigger) downstream dependent. Verified against the authored text:

| Dependency | Grounded in PRD-016 text? | Where |
|---|---|---|
| 002 (daemon host) | Yes | Index Overview: "runs as a background loop inside the hiveantennae daemon" |
| 005 (`hive_graph_versions` rows) | Yes | Index Data model changes: "owned by PRD-005" |
| 006 (re-association ladder feeds the queue) | Yes | Index Non-Goals; 016a Non-Goals + Related (post-fix, now correctly pointed at `completed/`) |
| 010 (Portkey transport) | Yes | Index + 016b + 016c Non-Goals/Related (post-fix, now correctly pointed at `in-work/`) |
| 011 (co-dependent projection trigger) | **Gap** | Only two passing "(PRD-011a)" mentions in 016b; the trigger relationship itself is undocumented — see W-7 |
| 014 (embeddings provider) | Yes | Index + 016b Non-Goals/Related (post-fix, now correctly pointed at `in-work/`) |

## 10. Documentation-framework conformance

- **Backtick code refs:** clean. Every Honeycomb code reference across the index + all three sub-PRDs is already a canonical backtick file-path span; zero markdown-link-wrapped honeycomb references were found (the systemic W-1/W-3 defect from the PRD-001-004 and PRD-005 reports is absent here, consistent with PRD-010's clean result).
- **Resolving links:** all cross-links now resolve post-remediation (see §11). Verified: `MASTER-PRD-INDEX.md` links (3-level `../../../requirements/...`, correct depth), `knowledge/private/...` links (3-level, correct depth), sibling `./prd-016[abc]-...md` links (same-folder, always correct), and all six corrected cross-PRD links (§11).
- **No invented values for DEFAULT flags:** confirmed — all four flags trace to a corpus-stated number or (for the 500ms case) an honestly-disclosed code-mirror, never fabricated (see W-6 for the one precision nit).
- **`skipped-deleted` enum consistency with decision #14:** confirmed consistent (§7, §8).

## 11. Remediation log (this pass)

Five mechanical defects were found and fixed directly in the `prd-016-enricher-steady-state/` folder. No corpus, other-PRD, `src/`, or `test/` file was touched.

| # | File | Defect | Fix |
|---|---|---|---|
| 1 | `prd-016-enricher-steady-state-index.md:85` | Stray trailing backtick inside the `brooding-pipeline.md` link target, breaking resolution (`.../brooding-pipeline.md\`` is not a valid path) | Removed the stray backtick; link now resolves to `../../../knowledge/private/ai/brooding-pipeline.md` |
| 2 | `prd-016a-queue-poll-debounce-meaningful-change.md:148` | Lifecycle-stale link to `../../backlog/prd-006-file-registration-protocol/` — PRD-006 moved to `completed/` (Wave B, PR #9) after this link was authored | Retargeted to `../../completed/prd-006-file-registration-protocol/` (verified the folder exists at that path) |
| 3 | `prd-016b-model-call-and-describe-model-audit.md:113` | Lifecycle-stale link to `../prd-010-portkey-gateway/prd-010a-...md` — PRD-010 moved to `in-work/` after this link was authored | Retargeted to `../../in-work/prd-010-portkey-gateway/prd-010a-portkey-transport-reuse.md` |
| 4 | `prd-016b-model-call-and-describe-model-audit.md:114` | Same lifecycle-stale defect for `prd-010b-model-selection-and-describe-model.md` | Retargeted to `../../in-work/prd-010-portkey-gateway/prd-010b-model-selection-and-describe-model.md` |
| 5 | `prd-016b-model-call-and-describe-model-audit.md:115` | Doubly-broken link: wrong slug (`prd-014-embeddings-provider-switch` vs. the real `prd-014-embeddings-provider-switching`) AND lifecycle-stale (`backlog/` vs. the real `in-work/`) | Retargeted to `../../in-work/prd-014-embeddings-provider-switching/` |
| 6 | `prd-016c-failure-handling-persistent-alert.md:137` | Lifecycle-stale link to `../prd-010-portkey-gateway/` | Retargeted to `../../in-work/prd-010-portkey-gateway/` |

**Verification:** `grep -rn ']\(../prd-010-portkey-gateway\|](../prd-014-embeddings-provider-switch/\|](../../backlog/prd-006'` across the PRD-016 folder returns zero; all six corrected targets confirmed to exist on disk via directory listing. No PRD prose, ACs, DDL, or corpus citations were altered — only the six link-syntax defects above.

## 12. Files Audited

- `prd-016-enricher-steady-state-index.md` — audited, one mechanical defect fixed (#1); carries W-6, W-7.
- `prd-016a-queue-poll-debounce-meaningful-change.md` — audited, one mechanical defect fixed (#2); carries W-6, W-7.
- `prd-016b-model-call-and-describe-model-audit.md` — audited, three mechanical defects fixed (#3, #4, #5); carries W-7.
- `prd-016c-failure-handling-persistent-alert.md` — audited, one mechanical defect fixed (#6); carries W-7; note N-1.

No corpus file, sibling PRD folder, `src/`, or `test/` file was modified by this audit — only the six link/syntax defects inside `prd-016-enricher-steady-state/` listed in §11.

**Overall verdict: PASS-with-warnings** (medium-and-above). Zero Critical findings. Two open medium Warnings (W-6: 500ms DEFAULT attribution precision; W-7: undocumented PRD-011 co-dependent trigger), both reported with concrete remediation recipes for the developer/library-worker-bee to apply as a content judgment call, not auto-fixed here per the audit's remediation policy (mechanical link/syntax defects only). Five mechanical link/syntax defects were found and fixed in this same pass (§11). One out-of-folder inconsistency (`MASTER-PRD-INDEX.md:183`'s stale "2000ms") is flagged for the doc owner but is outside this audit's write scope. The spec substance — all 31 ACs, the verbatim SQL/table/threshold carries, the `describe_status`/`describe_model` contracts, and every Honeycomb code citation across three separately-verified spans — passes cleanly with zero drift.

---

## Orchestrator remediation addendum (2026-07-02, the-smoker run)

All three open items above were remediated in-place the same day by the run orchestrator:

- **W-6 CLOSED.** Both "From corpus, confirm" attributions of the 500ms watcher-intake DEFAULT (index Flagged defaults + `prd-016a` Flagged defaults) now state the honest provenance: the corpus specifies the mechanism but leaves the window unspecified; the 500ms figure mirrors Honeycomb's `honeycomb/src/daemon/runtime/services/file-watcher.ts:177` (DECISION #4), relabeled "Mirrored default, confirm."
- **W-7 CLOSED.** The index Goals now carry the PRD-011 co-dependent trigger: an enricher cycle that wrote new descriptions invokes PRD-011's projection rewrite (trigger #2, debounced), and a cycle that wrote nothing skips it; a Related link to `../../in-work/prd-011-portable-projection/` was added.
- **N-2 (out-of-folder ask) CLOSED.** `MASTER-PRD-INDEX.md:183`'s stale "2000ms watcher intake" corrected to 500ms, matching the authored PRD-016 files and the decisions ledger.

**Post-remediation verdict: PASS, clean at medium-and-above.**
