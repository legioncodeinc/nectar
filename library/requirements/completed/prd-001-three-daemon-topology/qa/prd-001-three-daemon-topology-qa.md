# QA Report: PRD-001 Three-Daemon Topology (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.1 | Date: July 2026 | Status: Active

Conformance audit of PRD-001 (index + 001a/b/c) against the Nectar knowledge corpus. This is a PRD-vs-corpus audit (there is no implementation code yet), armed with quality-stinger + hivenectar-stinger. Auditor verified every module acceptance criterion and load-bearing description against its cited corpus source. This revision re-verifies the module after the `/the-smoker` Wave 1 remediation of W-1 (below).

**Related:**
- [`prd-001-three-daemon-topology-index.md`](../prd-001-three-daemon-topology-index.md)
- [`../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md`](../../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-001 is a strong, deeply corpus- and code-grounded module. It **PASSES** to the medium-and-above standard with zero open Warnings. Every module AC (AC-M1..M6) traces to `overview.md`, ADR-0002, ADR-0003, and ADR-0004; the port/path contract, `/health` shape, and tenancy model are consistent with the corpus and the locked decisions. The prior open medium finding, W-1 (honeycomb/doctor code references written as non-resolving markdown links), was remediated in the `/the-smoker` Wave 1 run: all 75 link tokens across PRD-001's four files were converted to canonical backtick spans, independently re-verified here, with no regression to any factual claim, DEFAULT flag, deliberate spec gap, or AC. A follow-up correction (W-2) then fixed a stale code-path prefix surfaced by cross-repo review: `doctor` is its own repository (`legioncodeinc/doctor`), so the `honeycomb/doctor/...` code citations were corrected to `doctor/...` (17 refs in PRD-001), while the legitimate `~/.honeycomb/doctor.daemons.json` runtime paths were preserved.

## 2. Scorecard

| Axis | Status | Note |
|---|---|---|
| Completeness | PASS | Index + 001a (roles/ADR) + 001b (process/health) + 001c (shared infra) cover the module scope; every module AC is addressed by a sub-PRD. |
| Correctness | PASS | Topology roles, ports (3850-3854), `/health` decision-#20 body, 768-dim, tenancy scope all match corpus + code. `hivenoctor` typos fixed in refine. |
| Alignment | PASS | Conforms to ADR-0002 (independence), ADR-0003 (three-daemon topology), ADR-0004 (hive role); consistent with MASTER-PRD-INDEX decision #1. |
| Gaps | PASS | Deliberate spec gaps preserved; defaults flagged "DEFAULT - confirm before implementation" (hive/nectar PID/lock paths; port assignments carry a CONFIRMED note, not DEFAULT). |
| Detrimental Patterns | PASS | Cross-repo honeycomb/doctor code refs are now canonical backtick spans (documentation-framework 6), not markdown links. W-1 resolved; see Resolved section below. |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

None open.

### Resolved

**W-1 (resolved): honeycomb/doctor code references were non-resolving markdown links, not backtick spans.**
- Prior finding: e.g. `prd-001a-three-daemon-topology-adr-and-roles.md:65` (pre-fix) cited a markdown link whose visible text was the backtick span `honeycomb/doctor/src/supervisor.ts:144-343` and whose parenthesized target was the relative path `../../../../honeycomb/doctor/src/supervisor.ts`. From the standalone `nectar` repo that target resolved to `nectar/honeycomb/...`, which does not exist (honeycomb is a sibling repo).
- Standard: Documentation Framework 6 ("Link to code with file paths ... `` `src/routes/users.ts:42-80` ``") and `AGENTS.md` ("Link to code in other repos as a file-path backtick span") both require backtick spans for code, not markdown links.
- Fix: `/the-smoker` Wave 1 (`hivenectar-worker-bee`) converted all 75 honeycomb/doctor markdown-link tokens across the four PRD-001 files (index 7, 001a 12, 001b 36, 001c 20) to canonical backtick spans. Full-form link text (already the full path) was kept verbatim as the span; short-form text (e.g. a bare `:77` or `:52-54` line suffix) had the full target path promoted into the span so the citation reads correctly standalone.
- Independent verification (this audit): `grep -rhoE '\]\(\.\./\.\./\.\./\.\./(honeycomb|doctor)[^)]*\)' *.md | wc -l` in the PRD-001 folder returns `0`. Spot-checked conversions in the index (port/PID tables), 001a (doctor supervisor + hive dashboard-reuse prose), and 001c (Portkey/embeddings/CodeGraph/recall seams, including every short-form promotion) all read correctly with the full path present in the span. `git diff --stat` shows exactly 56 lines changed per side across the four files (no line added or removed), and `git diff --check` is clean. No internal doc link (`./prd-001*`, `../prd-005*`, `../../MASTER-PRD-INDEX.md`, `../../../knowledge/...`) was altered or broken; every internal link target was independently confirmed to resolve on disk. No factual claim, port number, DEFAULT flag, or AC wording changed, only the link-vs-span citation form.
- Scope: PRD-001 index + 001a + 001b + 001c, all now conformant. The same W-1 pattern remains open in PRD-002 and PRD-003 per the consolidated report; that remediation is out of scope for this PRD-001-only re-verification.

**W-2 (resolved): stale `honeycomb/doctor/...` code-path prefix.**
- Finding: `doctor` was extracted from the honeycomb repo into its own top-level repository (`legioncodeinc/doctor`); its code now lives at `doctor/src/...` (verified: `doctor/src/supervisor.ts`, `config.ts`, `remediation.ts`, `service/*`, `status-page/*` exist standalone; there is no `honeycomb/doctor/` folder). PRD-001 still cited it with the stale `honeycomb/doctor/...` prefix (17 refs), and the smoker W-1 conversion had faithfully preserved that stale path text. This was invisible to the earlier audits because they verified against the corpus (same stale prefix) and the honeycomb/doctor code is absent from the standalone nectar repo, so path resolution never flagged it; it surfaced only under whole-superproject review.
- Fix (`hivenectar-worker-bee`): corrected `honeycomb/doctor/...` to `doctor/...` across PRD-001's files, preserving `honeycomb/src/...` (honeycomb's own paths, correct) and the legitimate `~/.honeycomb/doctor.daemons.json` / `~/.honeycomb/doctor/state-<name>.json` runtime paths. hive-in-honeycomb-repo design wording was left untouched.
- Independent verification (this audit): 0 stale `honeycomb/doctor/src` refs remain in PRD-001's source files; runtime paths intact; no `~/.doctor` corruption; internal doc links resolve; `git diff --check` clean. The pre-fix example on the "Prior finding" line above is retained verbatim as a historical citation.

## 5. Suggestions (consider improving)

- **S-1 (resolved in refine):** `hivenoctor` -> `doctor` typo fixed at 001a lines 101, 118, 137.
- **S-2 (resolved in refine):** 001a treated ADR-0003 as to-be-created with a proposed slug `three-daemon-topology`; the corpus now has `ADR-0003-three-daemon-topology-and-hive-portal.md`. Updated to reference the created file and resolve the slug DEFAULT; the prescribed status aligned to the framework's `Active`.
- **S-3 (resolved in refine):** Added ADR-0003 and ADR-0004 citations to the index Related section and 001a (hive role now traces to ADR-0004's four boundaries).
- **S-4 (corpus, out of scope):** ADR-0004's header uses `> **Status:** Accepted . **Date:** 2026-06-30` (middle-dot separators) and status `Accepted`, which diverges from the Documentation Framework universal header and its status set (Active/Draft/Archived/Canonical); ADR-0003 correctly uses `Active`. This is a corpus doc (knowledge/private), outside this refine's edit scope. Flag for the corpus owner (knowledge-worker-bee).

## 6. Plan Item (AC) Traceability

| Module AC (index) | Corpus / code source | Verdict |
|---|---|---|
| ADR-0003 exists, supersedes ADR-0002 two-daemon framing, preserves invariants | `ADR-0003-three-daemon-topology-and-hive-portal.md` (Active; "Relationship to ADR-0002") | PASS (slug corrected in refine) |
| Four roles each have a boundary statement, no overlap | `overview.md` (hiveantennae daemon), ADR-0003 "four operational boundaries" | PASS (001a role table) |
| No in-process state shared across the four roles | ADR-0003 "no shared in-process state"; 001a "non-integration points" | PASS |
| nectar process surface (port/PID/lock/health/client/tenancy) with code citation, ports+paths flagged DEFAULT | 001b; `honeycomb/embeddings/src/index.ts`, `.../storage/client.ts`, ADR-0004 (3853) | PASS |
| Shared-infra consumption contract names each seam + deploy-time tenancy invariant | 001c; `transport-portkey.ts`, `embed-client.ts`, ADR-0002 neg. consequence #2 | PASS |
| Port map consistent with real Honeycomb code (3850/3851/3852 occupied; 3853/3854 free) | `constants.ts:14`, `embeddings/src/index.ts:68`, `status-page/server.ts:93`; ADR-0004 confirms 3853 | PASS |
| AC-Q1: code references use backtick file-path spans, not markdown links (Documentation Framework 6) | 75 honeycomb/doctor markdown-link tokens across the 4 PRD-001 files, converted to backtick spans in `/the-smoker` Wave 1 | PASS (resolved; independently verified, grep = 0 remaining) |

Deliberate gaps preserved: no invented TLSH confidence threshold, no invented `review-matches` sub-flag grammar, no symbol/directory nectars claimed as shipped. Defaults flagged: ADR-0003 slug (resolved), config-file path, bind host, PID/lock paths (hive.pid/lock, nectar.pid/lock).

## 7. Files Audited / Changed

- `prd-001-three-daemon-topology-index.md` - AC-1 slug corrected; ADR-0003 + ADR-0004 added to Related; 7 honeycomb/doctor markdown links converted to backtick spans (`/the-smoker` Wave 1). (changed)
- `prd-001a-three-daemon-topology-adr-and-roles.md` - 3 `hivenoctor` typos fixed; ADR-0003 references updated to the created file; ADR-0004 linked; status aligned to `Active`; 12 honeycomb/doctor markdown links converted to backtick spans (`/the-smoker` Wave 1). (changed)
- `prd-001b-nectar-process-and-health.md` - corpus-consistent; 36 honeycomb/doctor markdown links converted to backtick spans (`/the-smoker` Wave 1); no factual change. (changed)
- `prd-001c-shared-infra-consumption.md` - corpus-consistent; 20 honeycomb/doctor markdown links converted to backtick spans (`/the-smoker` Wave 1); no factual change. (changed)

**Verdict: PASS** (medium-and-above), zero open Warnings. W-1 is resolved for PRD-001 (75/75 honeycomb/doctor markdown links converted to backtick spans, independently re-verified against the corpus with no regression); the docs-scoped `security-worker-bee` pass for this run reported clean.
