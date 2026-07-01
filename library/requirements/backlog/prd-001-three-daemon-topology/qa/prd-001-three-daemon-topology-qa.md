# QA Report: PRD-001 Three-Daemon Topology (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-001 (index + 001a/b/c) against the Hivenectar knowledge corpus. This is a PRD-vs-corpus audit (there is no implementation code yet), armed with quality-stinger + hivenectar-stinger. Auditor verified every module acceptance criterion and load-bearing description against its cited corpus source.

**Related:**
- [`prd-001-three-daemon-topology-index.md`](../prd-001-three-daemon-topology-index.md)
- [`../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md`](../../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-001 is a strong, deeply corpus- and code-grounded module. After the refine pass it **PASSES** to the medium-and-above standard. Every module AC traces to `overview.md`, ADR-0002, ADR-0003, and ADR-0004; the port/path contract, `/health` shape, and tenancy model are consistent with the corpus and the locked decisions. The one open medium finding (honeycomb code references written as non-resolving markdown links) is systemic across PRD-001/002/003 and is documented here for a scoped follow-up rather than swept in a refine-not-rewrite pass.

## 2. Scorecard

| Axis | Status | Note |
|---|---|---|
| Completeness | PASS | Index + 001a (roles/ADR) + 001b (process/health) + 001c (shared infra) cover the module scope; every module AC is addressed by a sub-PRD. |
| Correctness | PASS | Topology roles, ports (3850-3854), `/health` decision-#20 body, 768-dim, tenancy scope all match corpus + code. `hivenoctor` typos fixed in refine. |
| Alignment | PASS | Conforms to ADR-0002 (independence), ADR-0003 (three-daemon topology), ADR-0004 (thehive role); consistent with MASTER-PRD-INDEX decision #1. |
| Gaps | PASS | Deliberate spec gaps preserved (TLSH threshold not pinned in 001a); defaults flagged "DEFAULT - confirm before implementation." |
| Detrimental Patterns | WARNING | Cross-repo honeycomb code refs are markdown links, not backtick spans (documentation-framework 6). Systemic; see W-1. |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

**W-1 (systemic, deferred): honeycomb code references are non-resolving markdown links, not backtick spans.**
- Evidence: e.g. `prd-001a-three-daemon-topology-adr-and-roles.md:65` cites a markdown link whose visible text is the backtick span `honeycomb/hivedoctor/src/supervisor.ts:144-343` and whose parenthesized target is the relative path `../../../../honeycomb/hivedoctor/src/supervisor.ts`. From the standalone `hivenectar` repo that target resolves to `hivenectar/honeycomb/...`, which does not exist (honeycomb is a sibling repo).
- Standard: Documentation Framework 6 ("Link to code with file paths ... `` `src/routes/users.ts:42-80` ``") and `AGENTS.md` ("Link to code in other repos as a file-path backtick span") both require backtick spans for code, not markdown links. The corpus (`knowledge/private`, 0 link-form) and PRD-005 already use the backtick-span form.
- Scope: PRD-001 index + 001a + 001b + 001c all use the link form.
- Disposition: **Documented, not swept in this pass.** The correct remediation is nuanced (roughly half the link texts are short-form, e.g. `` `recall.ts:24-35` ``, whose full path lives only in the link target and must be promoted into the span), which is rewrite-scale across ~649 instances in PRD-001/002/003. The user selected "refine in place, not rewrite." Recommended follow-up: a scoped library-worker-bee sweep that unwraps each honeycomb markdown link, keeping only the backtick-span text and dropping the parenthesized honeycomb target, and promoting the full target path into the span for short-form texts. Full recipe in the consolidated report.

## 5. Suggestions (consider improving)

- **S-1 (resolved in refine):** `hivenoctor` -> `hivedoctor` typo fixed at 001a lines 101, 118, 137.
- **S-2 (resolved in refine):** 001a treated ADR-0003 as to-be-created with a proposed slug `three-daemon-topology`; the corpus now has `ADR-0003-three-daemon-topology-and-thehive-portal.md`. Updated to reference the created file and resolve the slug DEFAULT; the prescribed status aligned to the framework's `Active`.
- **S-3 (resolved in refine):** Added ADR-0003 and ADR-0004 citations to the index Related section and 001a (thehive role now traces to ADR-0004's four boundaries).
- **S-4 (corpus, out of scope):** ADR-0004's header uses `> **Status:** Accepted . **Date:** 2026-06-30` (middle-dot separators) and status `Accepted`, which diverges from the Documentation Framework universal header and its status set (Active/Draft/Archived/Canonical); ADR-0003 correctly uses `Active`. This is a corpus doc (knowledge/private), outside this refine's edit scope. Flag for the corpus owner (knowledge-worker-bee).

## 6. Plan Item (AC) Traceability

| Module AC (index) | Corpus / code source | Verdict |
|---|---|---|
| ADR-0003 exists, supersedes ADR-0002 two-daemon framing, preserves invariants | `ADR-0003-three-daemon-topology-and-thehive-portal.md` (Active; "Relationship to ADR-0002") | PASS (slug corrected in refine) |
| Four roles each have a boundary statement, no overlap | `overview.md` (hiveantennae daemon), ADR-0003 "four operational boundaries" | PASS (001a role table) |
| No in-process state shared across the four roles | ADR-0003 "no shared in-process state"; 001a "non-integration points" | PASS |
| hivenectar process surface (port/PID/lock/health/client/tenancy) with code citation, ports+paths flagged DEFAULT | 001b; `honeycomb/embeddings/src/index.ts`, `.../storage/client.ts`, ADR-0004 (3853) | PASS |
| Shared-infra consumption contract names each seam + deploy-time tenancy invariant | 001c; `transport-portkey.ts`, `embed-client.ts`, ADR-0002 neg. consequence #2 | PASS |
| Port map consistent with real Honeycomb code (3850/3851/3852 occupied; 3853/3854 free) | `constants.ts:14`, `embeddings/src/index.ts:68`, `status-page/server.ts:93`; ADR-0004 confirms 3853 | PASS |

Deliberate gaps preserved: TLSH confidence threshold (001a config note leaves it unpinned). Defaults flagged: ADR-0003 slug (now resolved), config-file path, bind host, PID/lock paths.

## 7. Files Audited / Changed

- `prd-001-three-daemon-topology-index.md` - AC-1 slug corrected; ADR-0003 + ADR-0004 added to Related. (changed)
- `prd-001a-three-daemon-topology-adr-and-roles.md` - 3 `hivenoctor` typos fixed; ADR-0003 references updated to the created file; ADR-0004 linked; status aligned to `Active`. (changed)
- `prd-001b-hivenectar-process-and-health.md` - audited, no change (corpus-consistent; carries the honeycomb-link W-1). (audited)
- `prd-001c-shared-infra-consumption.md` - audited, no change (corpus-consistent; carries W-1). (audited)

**Verdict: PASS** (medium-and-above), with one systemic Warning (W-1) documented and deferred by the refine-not-rewrite scope.
