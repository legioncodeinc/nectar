<!--
Schema v2 paths on disk:
  Index (this file):
    library/requirements/backlog/prd-009-harness-exposure-via-recall/prd-009-harness-exposure-via-recall-index.md
  Sub-feature PRD alongside the index:
    library/requirements/backlog/prd-009-harness-exposure-via-recall/prd-009a-decision-record-and-propagation-verification.md
  QA report (authored by quality-worker-bee):
    library/requirements/backlog/prd-009-harness-exposure-via-recall/qa/prd-009-harness-exposure-via-recall-qa.md
  Lifecycle moves:
    backlog/ -> in-work/ -> completed/   (entire prd-009-harness-exposure-via-recall/ folder moves)
-->

# PRD-009: Harness exposure via recall extension

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XS (< 1h)
> **Schema changes:** None — this is a documentation PRD; it ships no code and adds no Deep Lake table. The data layer (the `source_graph_versions` arm) is owned by PRD-013; the connector/hook plumbing already exists in the honeycomb repo.
> **ClickUp:** *(delete line if not using ClickUp)*

---

## Overview

PRD-009 records a **decision**, not an implementation. The decision — locked in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) and reinforced at the bottom of the index as recorded decision #1 — is that **Hivenectar does NOT ship its own harness hooks, connectors, or shim config.** It gains agent-facing exposure by extending honeycomb's shared recall engine: PRD-013 adds a `source_graph_versions` arm to the existing per-arm guarded-query recall, and that one arm automatically surfaces Source Graph hits in every harness honeycomb is already armed against — Claude Code, Codex, and Cursor included — with zero per-harness integration work.

This is correct against the honeycomb code. Recall is a single shared engine (`honeycomb/src/daemon/runtime/memories/recall.ts:2064-2119` `recallMemories`), reached by every armed harness through the same loopback path: each harness's hook bundle POSTs to honeycomb's session-protected `/api/hooks` route (`honeycomb/src/daemon/runtime/server.ts:77`), whose handler invokes `recallMemories` (`honeycomb/src/daemon/runtime/memories/api.ts:537`). A new arm added to the `arms` array (`recall.ts:2113-2118`) propagates to all of them in one place.

This PRD therefore documents three things and ships none of them: (1) the **decision record** (why no hivenectar-side hooks); (2) the **per-harness recall-call-site mapping** showing that the same integration point already serves Claude Code, Codex, and Cursor; and (3) the one **real integration concern** — the deploy-time tenancy invariant that keeps hivenectar's `source_graph_versions` rows readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope. **The dashboard is NOT in scope** for this PRD.

---

## Goals

- Record the decision that Hivenectar does NOT ship its own harness hooks, connectors, or hook-config — it composes with honeycomb's recall by writing rows PRD-013's arm reads.
- Map each of the three priority harnesses (Claude Code, Codex, Cursor) to the single recall call site that already serves it, citing the connector + hook-config + loopback path for each.
- Confirm the propagation invariant: a new arm added to `recallMemories`'s `arms` array (`recall.ts:2113-2118`) surfaces in every armed harness, because every harness reaches recall through the same `/api/hooks` → `recallMemories` path.
- State the deploy-time tenancy invariant (PRD-001c owns the contract; this PRD cites it) that makes the composition work, and name what silently breaks if it is violated.

## Non-Goals

- The recall arm itself (`buildSourceGraphVersionsArmSql`, the `RecallSource` entry, the `ARM_CLASS_WEIGHT` row, the `arms`-array insertion) — **PRD-013**. This PRD documents *that the extended recall propagates to all harnesses*; it does not specify the arm.
- The `source_graph` / `source_graph_versions` table schemas and the `org`/`workspace`/`project` tenancy model — **PRD-005**.
- The deploy-time tenancy invariant's enforcement mechanism (org-equality check at bootstrap, shared config) — **PRD-001c** states the contract and flags the mechanism as a default; this PRD cites it.
- The dashboard Source Graph page — **PRD-015**. The dashboard is an operator-facing surface, not the agent-facing recall surface this PRD documents.
- Manual Source Graph search (a focused operator tool scoped to the source-graph table, distinct from the fused agent-facing recall) — **PRD-012**.
- Any change to the existing harness connectors, hook bundles, or hook-config files in the honeycomb repo. They are already armed; this PRD confirms that and adds nothing.

---

## Sub-features

This is a **documentation-only PRD**. It has one sub-PRD that carries the decision record, the per-harness mapping, and the tenancy invariant. There is no implementation sub-PRD.

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-009a-decision-record-and-propagation-verification`](./prd-009a-decision-record-and-propagation-verification.md) | The "why no hooks" decision record + per-harness recall-call-site mapping (Claude Code, Codex, Cursor) + the deploy-time tenancy-scope invariant | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | The decision record states, in present tense, that Hivenectar ships no harness hooks/connectors/hook-config and gains exposure solely through PRD-013's recall arm, with the rationale grounded in a citation that recall is a shared engine reached by every armed harness. |
| AC-2 | The PRD maps each of the three priority harnesses (Claude Code, Codex, Cursor) to (a) its connector in the honeycomb repo with a file:line citation, (b) its hook-config/handler seam with a file:line citation, and (c) the single `recallMemories` call site that serves it, demonstrating that one integration point propagates to all three. |
| AC-3 | The PRD cites the exact insertion point (`recall.ts:2113-2118` `arms` array) PRD-013 extends, and states that because every harness reaches recall through `/api/hooks` (`server.ts:77`) → `recallMemories` (`api.ts:537`), a new arm surfaces in all of them with no per-harness change. |
| AC-4 | The PRD states the deploy-time tenancy invariant (both daemons resolve to the same `org`/`workspace`, `project_id` as the shared column filter) and cites PRD-001c as the owner, and names the failure mode (a tenancy mismatch silently breaks recall — hits never surface) it prevents. |
| AC-5 | The PRD ships no code and changes no Deep Lake table; it contains no TODO/OPEN QUESTION and no value invented for a deliberate spec gap. |

---

## Data model changes

None. This PRD adds no table and no column. The `source_graph_versions` table and its `embedding` column are owned by PRD-005; the recall arm that reads them is owned by PRD-013.

---

## API changes

None. This PRD adds no endpoint. The session-protected `/api/hooks` route (`honeycomb/src/daemon/runtime/server.ts:77`) already exists and already serves every armed harness; hivenectar's rows reach agents through it unchanged.

---

## Open questions

None. This is a documentation PRD recording a decided outcome. The tenancy-verification mechanism is a flagged default owned by PRD-001c, not an open question here.

---

## Related

- [`library/requirements/MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-009 entry and recorded decision #1 ("Hivenectar extends Honeycomb's recall (PRD-013), not its own harness hooks").
- [`prd-013-recall-arm-source-graph`](../prd-013-recall-arm-source-graph/prd-013-recall-arm-source-graph-index.md) — owns the recall arm this PRD's propagation claim depends on. *(PRD-013 is authored alongside this index; the folder is created by the PRD-013 authoring pass.)*
- [`prd-001c-shared-infra-consumption`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) — owns the deploy-time tenancy invariant (Seam 4 + the invariant block) this PRD cites.
- [`prd-005-source-graph-catalog-tables`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md) — owns the `source_graph_versions` table and the `org`/`workspace`/`project` tenancy model.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the recall-integration spec the arm conforms to.
- [`knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md) — names the shared-Deep-Lake-substrate + the tenancy-mismatch negative consequence this PRD's invariant prevents.
