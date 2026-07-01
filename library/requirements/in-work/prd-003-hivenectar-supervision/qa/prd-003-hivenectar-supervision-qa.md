# QA Report: PRD-003 Hivenectar Supervision (PRD-vs-Corpus Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-003 (index + 003a/b/c) against the Hivenectar knowledge corpus, armed with quality-stinger + hivenectar-stinger. Verified the `/health` + PID/lock contract, the OS service unit, and the registry entry + watchdog-war guards against ADR-0002/0003, `overview.md`, and the cited hivedoctor/honeycomb code.

**Related:**
- [`prd-003-hivenectar-supervision-index.md`](../prd-003-hivenectar-supervision-index.md)
- [`../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md`](../../../../knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-003 (the hivenectar side of the supervision contract) **PASSES** to the medium-and-above standard with no content refine required. The `/health` coarse bit, the single-instance PID/lock, the launchd/systemd/schtasks service units, the OS-service names (decision #23), and the registry entry (3854, `~/.honeycomb/hivenectar.pid`, decision #19 next-boot supervision) all trace to the corpus, the locked decisions, and the hivedoctor code. It correctly defers the registry schema to PRD-004a and the shutdown mechanism to PRD-002. The systemic honeycomb-link finding (W-1) applies here too.

## 2. Scorecard

| Axis | Status | Note |
|---|---|---|
| Completeness | PASS | 003a (health + PID/lock) + 003b (service unit) + 003c (registry entry + guards) cover the four supervision surfaces named in the index. |
| Correctness | PASS | Port 3854, `hivenectar.pid`/`.lock`, service names (`com.hivenectar.daemon`/`hivenectar`/`HivenectarDaemon`), startupGrace 60s, watchdog-war guards match code + decisions #19/#20/#23. |
| Alignment | PASS | Consumes PRD-004a registry; conforms to ADR-0002/0003; per-entry isolated incident state and pidPath guard match `remediation.ts`/`supervisor.ts`. |
| Gaps | PASS | `/health` `checks`-map shape, service unit names, and startupGraceMs flagged DEFAULT; no invented values. |
| Detrimental Patterns | WARNING | honeycomb code refs as markdown links (W-1). |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

**W-1 (systemic, deferred):** honeycomb code references as non-resolving markdown links (e.g. `prd-003b-os-service-unit.md` links `../../../../honeycomb/hivedoctor/src/service/templates.ts` repeatedly; `prd-003c` links `../../../../honeycomb/hivedoctor/src/config.ts`). Same finding and disposition as the consolidated report.

## 5. Suggestions (consider improving)

- **S-1 (structural, resolved in refine):** PRD-003 was missing its `qa/` subfolder. Created.
- **S-2:** `prd-003a-health-endpoint-and-pid-lock.md:43-62` presents a `checks`-map `/health` example and flags it DEFAULT, while PRD-001b (decision #20) locks a richer purpose-built body (brooding/enricher/projection/cost/embeddings/portkey fields). 003a correctly defers the body shape to PRD-001b, but the illustrative `checks` example could be read as a competing shape. Consider replacing the 003a example with a pointer to PRD-001b's locked body to remove any appearance of two shapes. Low severity (003a explicitly says PRD-001b owns the body).
- **S-3:** `prd-003c-registry-entry-and-watchdog-guards.md:56` carries a defensive note warning that "a sibling registry sample elsewhere shows thehive's 3853 against the hivenectar row - that is a typo; the binding value is 3854." The current PRD-004a registry sample correctly uses 3854 for the hivenectar row, so the note guards against a typo that no longer exists. Harmless (it correctly asserts 3854 is binding) but could be trimmed. Low severity.

## 6. Plan Item (AC) Traceability

| Module AC (index) | Corpus / code source | Verdict |
|---|---|---|
| AC-1 `GET /health` returns 200 ok / 503 degraded coarse bit | 003a; PRD-001b; `server.ts:318-341`, `health.ts:42` | PASS |
| AC-2 writes `hivenectar.pid`/`.lock`; second start throws before bind | 003a; `assemble.ts:715-732` | PASS |
| AC-3 OS service unit starts on boot, restarts on crash | 003b; `hivedoctor/src/service/templates.ts`, `service/index.ts:129-234` | PASS |
| AC-4 installer appends one registry entry (`healthUrl` 3854, `pidPath` hivenectar.pid) | 003c; PRD-004a schema; `hivedoctor/src/config.ts` | PASS |
| AC-5 lock-held-and-healthy guard skips restart (no second hivenectar) | 003c; `remediation.ts:147-151`, `supervisor.ts:236-240` | PASS |

Decisions honored: #19 (next-boot supervision, no hot reload), #20 (purpose-built `/health` deferred to PRD-001b), #23 (OS service names). Defaults flagged: `/health` `checks` shape, service unit names, startupGraceMs.

## 7. Files Audited / Changed

- `prd-003-hivenectar-supervision-index.md` - audited, corpus-consistent. (audited)
- `prd-003a-health-endpoint-and-pid-lock.md` - audited (see S-2). (audited)
- `prd-003b-os-service-unit.md` - audited, corpus-consistent (carries W-1). (audited)
- `prd-003c-registry-entry-and-watchdog-guards.md` - audited (see S-3). (audited)
- `qa/` - created (was missing). (added)

**Verdict (as-audited): PASS** (medium-and-above), with one systemic Warning (W-1) documented and deferred.

## Remediation addendum (2026-07-01, the-smoker Wave B) — post-remediation verdict: PASS (clean at medium+)

- **W-1 resolved.** The open systemic Warning (honeycomb/hivedoctor code refs as non-resolving markdown links) was remediated by library-worker-bee: 105 cross-repo code citations across `prd-003a` (39), `prd-003b` (38), and `prd-003c` (28) were converted from markdown links to canonical backtick file-path spans (the index carried 0 cross-repo code links). Of these, 60 were short-form spans promoted to the full repo-rooted `honeycomb/...` / `hivedoctor/...` path (line ranges preserved) and 45 were full-form unwraps. Verified: grep for `](.../honeycomb` or `](.../hivedoctor` code-link tokens in the PRD-003 folder returns zero (internal `../prd-004-...` folder links and `~/.honeycomb/...` runtime-path prose correctly untouched); `git diff --check` clean; the change is prose-neutral (no line ranges, numbers, DEFAULT flags, or open-question gaps altered; no new em/en dashes). W-1 is now closed across PRD-001/002/003.
- **Sub-medium (carried forward):** S-2 (003a illustrative `/health` `checks` example vs PRD-001b's locked body) and S-3 (stale defensive 3853/3854 note) remain low-severity suggestions, not blocking.
