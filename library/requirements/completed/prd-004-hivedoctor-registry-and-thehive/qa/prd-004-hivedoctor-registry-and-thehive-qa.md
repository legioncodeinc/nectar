# QA Report: PRD-004 hivedoctor Registry + thehive Portal (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-004 (index + 004a/b/c/d) against the Hivenectar knowledge corpus, armed with quality-stinger + hivenectar-stinger. This is the out-of-band module (hivedoctor + thehive live in the honeycomb repo). Verified against ADR-0003, ADR-0004, `thehive-portal-daemon.md`, and the cited hivedoctor/honeycomb code.

**Related:**
- [`prd-004-hivedoctor-registry-and-thehive-index.md`](../prd-004-hivedoctor-registry-and-thehive-index.md)
- [`../../../knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md`](../../../../knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-004 **PASSES** to the medium-and-above standard after the refine pass. It carried the only genuinely broken internal links in the four modules (both in the index), which are now fixed, and it was missing citations to ADR-0004 and the corpus `thehive-portal-daemon.md` despite thehive being its central subject, which are now added. Notably, PRD-004's sub-PRDs already use the canonical backtick-span form for code references, so this module does NOT carry the systemic W-1 honeycomb-link finding. The registry schema, per-daemon supervisor isolation, thehive always-on/API-aggregation contract, and independent update cadence all match ADR-0003/0004 and the hivedoctor code.

## 2. Scorecard

| Axis | Status | Note |
|---|---|---|
| Completeness | PASS | 004a (registry) + 004b (status/CLI) + 004c (thehive portal) + 004d (service unit + registration) cover the module; all six module ACs are addressed. |
| Correctness | PASS | Registry schema, per-daemon supervisor loop, isolated incident shards, thehive four boundaries (ADR-0004), ports (3853/3854), atomic registry write all match code + ADRs. |
| Alignment | PASS | Conforms to ADR-0003 (topology) and ADR-0004 (thehive role); decisions #8 (static registry file), #9 (TS/Node+Hono, reuse honeycomb dashboard), #19 (next-boot supervision). |
| Gaps | PASS | Registry file path/schema, thehive PID/lock, registration timing flagged DEFAULT; no invented values. |
| Detrimental Patterns | PASS | Sub-PRDs use backtick-span code refs (canonical); no honeycomb-link W-1 in this module. Two broken internal links in the index fixed in refine. |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

None open. Two internal-link defects were resolved in the refine pass (see S-1, S-2). They were broken cross-references (a corpus citation and a cross-PRD citation), medium severity before fixing.

## 5. Suggestions (consider improving)

- **S-1 (resolved in refine):** Index Related bullet linked the ADR-0002 corpus doc with `../../knowledge/...` (one `../` short); from `backlog/prd-004-.../` that resolved to `requirements/knowledge/...` (nonexistent). Corrected to `../../../knowledge/...`.
- **S-2 (resolved in refine):** Index Related linked PRD-003 as `../prd-003-hivedoctor-supervision-of-hivenectar/prd-003-hivedoctor-supervision-of-hivenectar-index.md`; the real folder is `prd-003-hivenectar-supervision/`. Corrected.
- **S-3 (resolved in refine):** Added ADR-0003, ADR-0004, and `thehive-portal-daemon.md` citations. The index Motivation bullet now cites all three ADRs; 004c now cites ADR-0004 (the four binding boundaries it implements) and the corpus `thehive-portal-daemon.md` design reference.
- **S-4 (structural, resolved in refine):** PRD-004 was missing its `qa/` subfolder. Created.
- **S-5 (corpus, out of scope):** ADR-0004's header deviates from the Documentation Framework universal header (middle-dot separators, status `Accepted` which is not in the framework status set). Corpus doc, outside this refine's edit scope; flag for knowledge-worker-bee.

## 6. Plan Item (AC) Traceability

| Module AC (index) | Corpus / code source | Verdict |
|---|---|---|
| AC-1 hivedoctor spawns one supervisor per registry entry | 004a; `compose/index.ts:190-534`, `supervisor.ts:144` | PASS |
| AC-2 per-daemon isolated incident/remediation state | 004a; `state-<name>.json`, `incidents-<name>.ndjson` | PASS |
| AC-3 thehive serves dashboard on boot without any workload healthy | 004c; ADR-0004 decision 1 (always-on) | PASS |
| AC-4 thehive updateable independently of hivedoctor | 004c/004d; ADR-0004 decision 4 | PASS |
| AC-5 installer appends one registry entry, no hivedoctor code touch/restart | 004d; decision #8, #19 | PASS |
| AC-6 `hivedoctor status` reports every registered daemon | 004b; `status-page/server.ts`, `cli/dispatch.ts` | PASS |

thehive's four binding boundaries (always-on+boot-order, API-aggregation-not-Deep-Lake, dashboard ownership+reuse, independent cadence) trace 1:1 to ADR-0004. Ports 3853 (thehive) / 3854 (hivenectar) consistent with ADR-0004 impl notes and PRD-001b.

## 7. Files Audited / Changed

- `prd-004-hivedoctor-registry-and-thehive-index.md` - fixed 2 broken internal links; added ADR-0003 + ADR-0004 citations. (changed)
- `prd-004a-hivedoctor-registry-config-and-supervisor-instances.md` - audited, corpus/code-consistent. (audited)
- `prd-004b-hivedoctor-status-and-cli.md` - audited, corpus/code-consistent. (audited)
- `prd-004c-thehive-portal-daemon.md` - added ADR-0004 + ADR-0003 + `thehive-portal-daemon.md` design references. (changed)
- `prd-004d-thehive-service-unit-and-registration.md` - audited, corpus/code-consistent. (audited)
- `qa/` - created (was missing). (added)

**Verdict: PASS** (medium-and-above). No open Warnings; all medium findings resolved in the refine pass.
