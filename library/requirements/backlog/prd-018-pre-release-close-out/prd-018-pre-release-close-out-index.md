# PRD-018: Nectar pre-release close-out

> **Status:** Backlog
> **Priority:** P0
> **Effort:** XL (12 sub-PRDs, multi-week program)
> **Schema changes:** One additive column: `embed_model` on `hive_graph_versions` (owned by [PRD-018i](./prd-018i-embeddings-and-projection-integrity.md))

---

## Overview

The mission under audit is: **"analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed."** The 2026-07-02 pre-release review (six reports in [`library/notes/`](../../../notes/2026-07-02-executive-summary.md)) audited the whole codebase against that mission and consolidated its findings into 42 issues, [NEC-001 through NEC-042](../../NECTAR-ISSUES.md).

The baseline at review time: typecheck clean, 451/452 tests pass (1 skipped). The suite is green but it fakes out exactly the layers where the findings live: wiring (the update-on-change pipeline is built and tested but never constructed by the daemon), concurrency (lock reclaim races, brood/enricher contention, review-store writers), and platform behavior (systemd exec, inotify errors, case-insensitive filesystems, real Deep Lake operator semantics). The verdict by mission leg: brooding works but loses paid LLM work on a mid-run kill; update-on-change is dead code at runtime; recall works but its semantic ranking direction is unverified against the real backend and may be inverted.

PRD-018 is the close-out program: land a fix for every NEC issue so that all three mission legs work end to end, verified by new tests that would have caught the findings. This index covers program scope, the issue-to-epic traceability, and the execution order. Each sub-PRD carries its own acceptance criteria, files-touched list, and test plan.

---

## Goals

- Close every issue NEC-001 through NEC-042 with a landed change, checked off in [`NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md).
- Make all three mission legs functional and demonstrated by integration-style tests: brood an entire codebase (durable under kill/resume), update it upon change with NodeFS (watcher wired, cold catch-up on start), and recall it as needed (similar-first ordering verified against real operator semantics).
- Close the specific test-coverage gaps the review reports call out, so the failure modes that slipped past the 451-test suite are pinned by regression tests.
- Bring the public docs into truth: every command the docs teach must run.

## Non-Goals

- **The Honeycomb-side recall arm.** The 4th guarded arm in Honeycomb's RRF fusion, the `nectar_rrf_multiplier` knob, and agent-mediated recall are PRD-013 scope and live outside this repo (spec-drift review, drift #7).
- **MCP or harness exposure.** No coding-agent harness sees Nectar data in this repo; that surface is explicitly deferred (README, spec-drift review Leg C).
- **Symbol and directory nectars.** A deliberate v2 spec gap; the `kind` column stays reserved.
- **Re-litigating the deliberate spec gaps.** TLSH confidence threshold values stay tunable (PRD-018d fixes the confidence mapping, not the band edges), and the `review-matches` accept/reject sub-flag grammar stays an implementation decision behind the injected-decider seam.

---

## Sub-features

| Sub-PRD | Scope | Severity mix | Status |
|---|---|---|---|
| [`prd-018a-daemon-lock-and-lifecycle`](./prd-018a-daemon-lock-and-lifecycle.md) | Lock release ownership, atomic stale reclaim and PID-reuse identity, shutdown force-close and drain, async `/build`, systemd interpreter, single restart authority | 1 Critical, 3 High, 2 Medium | Draft |
| [`prd-018b-wire-update-on-change`](./prd-018b-wire-update-on-change.md) | Construct RegistrationService + WatchIntake in the daemon, sync/async store bridge, resync-on-start, unstub the mutating CLI verbs (mission leg 2) | 1 Critical, 1 High | Draft |
| [`prd-018c-watcher-robustness-and-ignore-parity`](./prd-018c-watcher-robustness-and-ignore-parity.md) | One shared ignore predicate across brooding/watch/resync, directory-rename resync, watcher error recovery, case folding, mtime refresh, loud git-failure handling | 3 High, 3 Medium | Draft |
| [`prd-018d-reassociation-ladder-correctness`](./prd-018d-reassociation-ladder-correctness.md) | Size-aware TLSH confidence, atomic multi-write ladder actions, review-store concurrency and dedupe | 1 High, 1 Medium | Draft |
| [`prd-018e-brooding-durability-and-scale`](./prd-018e-brooding-durability-and-scale.md) | Per-batch persistence (resumability contract), streaming file reads, resume refresh for changed content | 1 Critical, 1 High, 1 Medium | Draft |
| [`prd-018f-brooding-batch-call-robustness`](./prd-018f-brooding-batch-call-robustness.md) | Batch-failure containment (no solo retry storm), batch `max_tokens` sizing, `finish_reason` handling, length-validated batch parse | 2 High | Draft |
| [`prd-018g-enricher-correctness-and-concurrency`](./prd-018g-enricher-correctness-and-concurrency.md) | Brood/enricher mutex and atomic `nextSeq`, batch index alignment, continuous hydration, durable write pattern, Jaccard gate wiring, projection trigger #2 | 4 High, 2 Medium | Draft |
| [`prd-018h-recall-ranking-and-error-honesty`](./prd-018h-recall-ranking-and-error-honesty.md) | `<#>` ordering probe and fix, lexical ORDER BY, honest `degraded` reporting, per-row status tolerance | 1 High, 3 Medium | Draft |
| [`prd-018i-embeddings-and-projection-integrity`](./prd-018i-embeddings-and-projection-integrity.md) | `embed_model` provenance column, inherited-row re-embedding, dim-rejection observability, duplicate-content inherit correctness | 2 High, 2 Medium | Draft |
| [`prd-018j-api-security-and-registry-hardening`](./prd-018j-api-security-and-registry-hardening.md) | `?project=` override gating and non-loopback refusal; atomic, key-preserving doctor-registry writes | 2 Medium | Draft |
| [`prd-018k-first-run-experience-and-config`](./prd-018k-first-run-experience-and-config.md) | Brood prerequisites surfaced (credentials + Portkey env), dormancy made loud, `~/.honeycomb/nectar.json` config loader | 1 High, 1 Medium | Draft |
| [`prd-018l-docs-truth-pass-and-cleanup`](./prd-018l-docs-truth-pass-and-cleanup.md) | Public docs truth pass, corpus contradiction sweep (cost, prefixes, staleness), the low-severity cleanup batch | 1 Critical, 1 Medium, 1 Low | Draft |

---

## NEC traceability

Every issue from [`NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md), one row each. Severity follows that file's section headings.

| Issue | Summary | Severity | Owning sub-PRD |
|---|---|---|---|
| NEC-001 | Update-on-change pipeline never constructed by daemon or CLI; mission leg 2 is dead code | Critical | [018b](./prd-018b-wire-update-on-change.md) |
| NEC-002 | Failed daemon start deletes the live daemon's lock; double daemon (verified by live repro) | Critical | [018a](./prd-018a-daemon-lock-and-lifecycle.md) |
| NEC-003 | Mid-run kill loses all paid LLM describe work; persistence only after the whole describe+embed stage | Critical | [018e](./prd-018e-brooding-durability-and-scale.md) |
| NEC-004 | Public docs teach commands that do not exist or refuse to run | Critical | [018l](./prd-018l-docs-truth-pass-and-cleanup.md) |
| NEC-005 | Semantic ranking likely inverted: `<#>` ordered DESC against a cosine-distance spec | High | [018h](./prd-018h-recall-ranking-and-error-honesty.md) |
| NEC-006 | No cold catch-up: nothing calls `requestResync()` on daemon start | High | [018b](./prd-018b-wire-update-on-change.md) |
| NEC-007 | Ignore rules drift between brooding (git-based) and watching (segment-based), in both directions | High | [018c](./prd-018c-watcher-robustness-and-ignore-parity.md) |
| NEC-008 | Directory renames dropped silently; all children keep stale paths | High | [018c](./prd-018c-watcher-robustness-and-ignore-parity.md) |
| NEC-009 | Watcher error kills the watcher permanently; no restart, no fallback, no health flag | High | [018c](./prd-018c-watcher-robustness-and-ignore-parity.md) |
| NEC-010 | TLSH fuzzy confidence mis-associates tiny files above the auto-carry band | High | [018d](./prd-018d-reassociation-ladder-correctness.md) |
| NEC-011 | Enricher races brooding on the same rows; non-atomic `nextSeq`; auto-brood bypasses the `/build` guard | High | [018g](./prd-018g-enricher-correctness-and-concurrency.md) |
| NEC-012 | Whole-tree memory residency during brooding; OOM risk on monorepos | High | [018e](./prd-018e-brooding-durability-and-scale.md) |
| NEC-013 | Whole-batch describe failure fans out into a solo retry storm; `max_tokens` default truncates full batches | High | [018f](./prd-018f-brooding-batch-call-robustness.md) |
| NEC-014 | Positional batch-parse fallback can attach the wrong description; spec'd length validation missing | High | [018f](./prd-018f-brooding-batch-call-robustness.md) |
| NEC-015 | Enricher batch index misalignment can attach descriptions to the wrong files | High | [018g](./prd-018g-enricher-correctness-and-concurrency.md) |
| NEC-016 | Enricher working set hydrated once at boot; post-boot rows wait for a restart | High | [018g](./prd-018g-enricher-correctness-and-concurrency.md) |
| NEC-017 | Enrichment write-back is a fire-and-forget in-place UPDATE the codebase documents as unreliable | High | [018g](./prd-018g-enricher-correctness-and-concurrency.md) |
| NEC-018 | Switching embedding providers silently mixes vector spaces; no `embed_model` provenance | High | [018i](./prd-018i-embeddings-and-projection-integrity.md) |
| NEC-019 | Fresh clones get permanently degraded recall; inherited rows never re-embed | High | [018i](./prd-018i-embeddings-and-projection-integrity.md) |
| NEC-020 | Non-atomic stale-lock reclaim; PID reuse wedges startup after a crash | High | [018a](./prd-018a-daemon-lock-and-lifecycle.md) |
| NEC-021 | Shutdown hangs forever behind one active request; `/build` runs a minutes-long brood in-request | High | [018a](./prd-018a-daemon-lock-and-lifecycle.md) |
| NEC-022 | systemd template omits the node interpreter; infinite 5s crash loop on nvm-installed Linux | High | [018a](./prd-018a-daemon-lock-and-lifecycle.md) |
| NEC-023 | Brooding dormant out of the box; credential and Portkey prerequisites undocumented | High | [018k](./prd-018k-first-run-experience-and-config.md) |
| NEC-024 | Recall swallows every storage error into empty rows; `degraded: false` on a failed semantic arm | Medium | [018h](./prd-018h-recall-ranking-and-error-honesty.md) |
| NEC-025 | Lexical arm has no ORDER BY under LIMIT; nondeterministic subset, meaningless RRF ranks | Medium | [018h](./prd-018h-recall-ranking-and-error-honesty.md) |
| NEC-026 | Jaccard cosmetic-change inheritance is dead code; every whitespace edit pays a full re-describe | Medium | [018g](./prd-018g-enricher-correctness-and-concurrency.md) |
| NEC-027 | One bad `describe_status` row poisons whole-tenancy scans | Medium | [018h](./prd-018h-recall-ranking-and-error-honesty.md) |
| NEC-028 | Embedding dim-rejection sink never wired; a wrong output dimension silently nulls all embeddings | Medium | [018i](./prd-018i-embeddings-and-projection-integrity.md) |
| NEC-029 | No API auth; unauthenticated `?project=` tenancy override on every endpoint including `/build` | Medium | [018j](./prd-018j-api-security-and-registry-hardening.md) |
| NEC-030 | Two restart authorities (OS unit + doctor) contend on one lock | Medium | [018a](./prd-018a-daemon-lock-and-lifecycle.md) |
| NEC-031 | Enricher-cycle projection regeneration spec'd but unwired; committed `nectars.json` goes stale | Medium | [018g](./prd-018g-enricher-correctness-and-concurrency.md) |
| NEC-032 | Doctor registry write non-atomic and drops unknown top-level keys | Medium | [018j](./prd-018j-api-security-and-registry-hardening.md) |
| NEC-033 | Shutdown does not drain the in-flight worker tick or `bootSettled` before `process.exit(0)` | Medium | [018a](./prd-018a-daemon-lock-and-lifecycle.md) |
| NEC-034 | Case-only renames on APFS/NTFS classify as copies; duplicate nectar minted, history stranded | Medium | [018c](./prd-018c-watcher-robustness-and-ignore-parity.md) |
| NEC-035 | Ladder step-2 no-op never refreshes stored mtime/size; step-1 fast path degrades permanently | Medium | [018c](./prd-018c-watcher-robustness-and-ignore-parity.md) |
| NEC-036 | Non-atomic multi-write ladder actions; lossy, unbounded review queue under daemon+CLI concurrency | Medium | [018d](./prd-018d-reassociation-ladder-correctness.md) |
| NEC-037 | Duplicate-content files collapse to one nectar on inherit; duplicate seq-0 rows, orphaned nectars | Medium | [018i](./prd-018i-embeddings-and-projection-integrity.md) |
| NEC-038 | Brood resume never refreshes changed files; resume keys on nectar existence, not content hash | Medium | [018e](./prd-018e-brooding-durability-and-scale.md) |
| NEC-039 | Any git error silently degrades discovery to a walk that ignores `.gitignore` | Medium | [018c](./prd-018c-watcher-robustness-and-ignore-parity.md) |
| NEC-040 | Corpus and README contradictions: cost figures, stale status blocks, incomplete ADR-0002 prefix sweep | Medium | [018l](./prd-018l-docs-truth-pass-and-cleanup.md) |
| NEC-041 | `~/.honeycomb/nectar.json` config file spec'd but unwired | Medium | [018k](./prd-018k-first-run-experience-and-config.md) |
| NEC-042 | Low-severity cleanup batch (JSON 400s, launchd log dir, daemon-reload, telemetry opt-out family, ILIKE ESCAPE, ULID monotonicity, `.lock` classification, lookup pushdown, debounce max-wait, symlink contract, backslash paths, `limit: 0`, credentials permissions, `sha256-` prefix doc) | Low | [018l](./prd-018l-docs-truth-pass-and-cleanup.md) |

---

## Execution order

Follows the suggested order in [`NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-002 first because it is small and catastrophic; then the missing mission leg; then ranking correctness; then durability, parity, freshness, docs, and the rest), mapped onto sub-PRD granularity:

1. **[018a](./prd-018a-daemon-lock-and-lifecycle.md)** : the lock rollback fix (NEC-002) is the smallest catastrophic item and every later epic runs daemons in tests; lifecycle correctness first.
2. **[018b](./prd-018b-wire-update-on-change.md)** : wire the missing mission leg (NEC-001/006). Everything watcher-adjacent (018c, 018d) depends on this landing first.
3. **[018h](./prd-018h-recall-ranking-and-error-honesty.md)** : settle the `<#>` ordering question (NEC-005) with one real-storage probe before any more recall work stacks on top of it.
4. **[018e](./prd-018e-brooding-durability-and-scale.md)** and **[018f](./prd-018f-brooding-batch-call-robustness.md)** : brooding durability and scale (NEC-003/012/013/014/038); these two can proceed in parallel.
5. **[018c](./prd-018c-watcher-robustness-and-ignore-parity.md)** : ignore parity (NEC-007) plus watcher robustness, now that the watcher actually runs.
6. **[018g](./prd-018g-enricher-correctness-and-concurrency.md)** and **[018i](./prd-018i-embeddings-and-projection-integrity.md)** : recall freshness (NEC-019/016) and the remaining enricher/embedding correctness work; parallelizable.
7. **[018d](./prd-018d-reassociation-ladder-correctness.md)** : ladder confidence and write atomicity, once the wired pipeline exercises it for real.
8. **[018j](./prd-018j-api-security-and-registry-hardening.md)** and **[018k](./prd-018k-first-run-experience-and-config.md)** : API/registry hardening and the first-run experience.
9. **[018l](./prd-018l-docs-truth-pass-and-cleanup.md)** : the docs truth pass (NEC-004/040) goes last so it documents the surface that actually shipped, plus the NEC-042 batch.

---

## Acceptance criteria (index level)

Each sub-PRD carries its own detailed criteria; these are the program-level gates.

| ID | Criterion |
|---|---|
| AC-1 | Every issue NEC-001 through NEC-042 is checked off in [`NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) with a landed change referenced by the closing commit or sub-PRD. |
| AC-2 | `npm run typecheck` is clean. |
| AC-3 | The full test suite (`npm test`) is green, including every new test specified by the sub-PRDs' "Tests to add" sections. |
| AC-4 | Mission leg 2 is demonstrated by at least one integration-style test: watch-edit-reassociate (a real daemon observes an on-disk edit and the ladder appends the new version row). |
| AC-5 | Mission leg 1 is demonstrated by at least one integration-style test: brood-kill-resume (a brood killed mid-describe resumes without re-paying for already-persisted descriptions). |
| AC-6 | Mission leg 3 is demonstrated by at least one integration-style test: search-orders-similar-first (a known-near vector outranks a known-far vector against real, or faithfully recorded, Deep Lake operator semantics). |
| AC-7 | Public docs (`library/knowledge/public/`) teach only commands that run: every command example in the guides exits 0 against the shipped binary. |

---

## Related

- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) : the consolidated issue list this program closes.
- [`../../../notes/2026-07-02-executive-summary.md`](../../../notes/2026-07-02-executive-summary.md) : review verdict by mission leg and the suggested order of attack.
- [`../../../notes/2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) : daemon lifecycle, lock, API, service, projection (backs 018a, 018j).
- [`../../../notes/2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) : watcher, ladder, ignore contract (backs 018b, 018c, 018d).
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) : brooding pipeline (backs 018e, 018f).
- [`../../../notes/2026-07-02-recall-review.md`](../../../notes/2026-07-02-recall-review.md) : search, embeddings, enricher (backs 018g, 018h, 018i).
- [`../../../notes/2026-07-02-spec-drift-review.md`](../../../notes/2026-07-02-spec-drift-review.md) : spec-vs-code drift matrix and public-docs promises (backs 018k, 018l).
- [`../../MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) : the PRD ledger this program extends.
- [`../../../knowledge/private/ai/identity-and-reassociation.md`](../../../knowledge/private/ai/identity-and-reassociation.md) : the ladder and watch contract 018b/018c/018d implement.
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) : the resumability contract 018e restores.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) : the enricher contract 018g conforms to.
- [`../../../knowledge/private/data/hive-graph-schema.md`](../../../knowledge/private/data/hive-graph-schema.md) : the two-table schema; heal-additive rule for 018i's `embed_model` column.
- [`../../../knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) : the `<#>` semantics 018h settles.
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) : the projection contract 018i and 018g (trigger #2) restore.
- [`../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md`](../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md) : the command-prefix sweep 018l completes.
- [`../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md`](../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) : the supervision topology 018a's restart-authority decision resolves.
