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
> **Schema changes:** None — this is a documentation PRD; it ships no code and adds no Deep Lake table. The data layer (the `hive_graph_versions` arm) is owned by PRD-013; the connector/hook plumbing already exists in the honeycomb repo.
> **ClickUp:** *(delete line if not using ClickUp)*

---

## Overview

PRD-009 records a **decision**, not an implementation. The decision — locked in [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) and reinforced at the bottom of the index as recorded decision #1 — is that **Nectar does NOT ship its own harness hooks, connectors, or shim config.** It gains agent-facing exposure by extending honeycomb's shared recall engine: PRD-013 adds a `hive_graph_versions` arm to the existing per-arm guarded-query recall, and that one arm automatically surfaces Hive Graph hits in every harness honeycomb is already armed against — Claude Code, Codex, and Cursor included — with zero per-harness integration work.

This is correct against the honeycomb code. Recall is a single shared engine (`honeycomb/src/daemon/runtime/memories/recall.ts:2064` `recallMemories`), invoked at exactly one production call site: the `POST /api/memories/recall` handler (`honeycomb/src/daemon/runtime/memories/api.ts:537`), mounted under the session-protected `/api/memories` route group (`honeycomb/src/daemon/runtime/server.ts:72`; `MEMORIES_GROUP`, `api.ts:85`). Every agent-facing recall consumer funnels through that one call site: the MCP tools `memory_search` and `hivemind_search` (`honeycomb/mcp/src/handlers.ts:176,270`; `honeycomb/mcp/src/tools.ts:97`) and the CLI `recall` verb (`honeycomb/src/commands/storage-handlers.ts:38,175`) all POST to `/api/memories/recall`. Two adjacent paths are NOT recall: session-start memory injection is `GET /api/memories/prime` (`honeycomb/src/daemon/runtime/memories/prime.ts:151`), the 046c prime digest, which does not call `recallMemories`; and the `/api/hooks` route group (`honeycomb/src/daemon/runtime/server.ts:74`) carries only capture/context/session-end, none of which invoke recall. A new arm added to the `arms` array (`recall.ts:2113-2118`) propagates to all consumers in that one place.

This PRD therefore documents three things and ships none of them: (1) the **decision record** (why no nectar-side hooks); (2) the **per-harness recall-call-site mapping** showing that the same integration point already serves Claude Code, Codex, and Cursor; and (3) the one **real integration concern** — the deploy-time tenancy invariant that keeps nectar's `hive_graph_versions` rows readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope. **The dashboard is NOT in scope** for this PRD.

---

## Goals

- Record the decision that Nectar does NOT ship its own harness hooks, connectors, or hook-config — it composes with honeycomb's recall by writing rows PRD-013's arm reads.
- Map each of the three priority harnesses (Claude Code, Codex, Cursor) to the single recall call site that already serves it, citing the connector + hook-config + loopback path for each.
- Confirm the propagation invariant: a new arm added to `recallMemories`'s `arms` array (`recall.ts:2113-2118`) surfaces in every armed harness, because every agent-facing recall consumer (the MCP tools and the CLI) funnels through the single production `recallMemories` call site at `POST /api/memories/recall` (`api.ts:537`).
- State the deploy-time tenancy invariant (PRD-001c owns the contract; this PRD cites it) that makes the composition work, and name what silently breaks if it is violated.

## Non-Goals

- The recall arm itself (`buildHiveGraphVersionsArmSql`, the `RecallSource` entry, the `ARM_CLASS_WEIGHT` row, the `arms`-array insertion) — **PRD-013**. This PRD documents *that the extended recall propagates to all harnesses*; it does not specify the arm.
- The `hive_graph` / `hive_graph_versions` table schemas and the `org`/`workspace`/`project` tenancy model — **PRD-005**.
- The deploy-time tenancy invariant's enforcement mechanism: **PRD-001c** states the contract; decision #21 ([`PRD-DECISIONS-AND-DEFAULTS.md`](../../PRD-DECISIONS-AND-DEFAULTS.md)) locks the mechanism as a doctor-mediated assertion (doctor refuses to supervise a daemon whose org/workspace scope mismatches another registered daemon's), owned by doctor/PRD-004. This PRD cites it.
- The dashboard Hive Graph page — **PRD-015**. The dashboard is an operator-facing surface, not the agent-facing recall surface this PRD documents.
- Manual Hive Graph search (a focused operator tool scoped to the hive-graph table, distinct from the fused agent-facing recall) — **PRD-012**.
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
| AC-1 | The decision record states, in present tense, that Nectar ships no harness hooks/connectors/hook-config and gains exposure solely through PRD-013's recall arm, with the rationale grounded in a citation that recall is a shared engine reached by every armed harness. |
| AC-2 | The PRD maps each of the three priority harnesses (Claude Code, Codex, Cursor) to (a) its connector in the honeycomb repo with a file:line citation, (b) its hook-config/handler seam with a file:line citation, and (c) the single production `recallMemories` call site that serves it (the `POST /api/memories/recall` handler, `api.ts:537`, reached by the MCP tools and the CLI recall consumers), demonstrating that one integration point propagates to all three. |
| AC-3 | The PRD cites the exact insertion point (`recall.ts:2113-2118` `arms` array) PRD-013 extends, and states that because every agent-facing recall consumer funnels through the single production `recallMemories` call site at `POST /api/memories/recall` (`server.ts:72` → `api.ts:537`), a new arm surfaces in all of them with no per-harness change. |
| AC-4 | The PRD states the deploy-time tenancy invariant (both daemons resolve to the same `org`/`workspace`, `project_id` as the shared column filter) and cites PRD-001c as the owner, and names the failure mode (a tenancy mismatch silently breaks recall — hits never surface) it prevents. |
| AC-5 | The PRD ships no code and changes no Deep Lake table; it contains no TODO/OPEN QUESTION and no value invented for a deliberate spec gap. |

---

## Data model changes

None. This PRD adds no table and no column. The `hive_graph_versions` table and its `embedding` column are owned by PRD-005; the recall arm that reads them is owned by PRD-013.

---

## API changes

None. This PRD adds no endpoint. The session-protected `/api/memories/recall` endpoint (`honeycomb/src/daemon/runtime/server.ts:72` → `honeycomb/src/daemon/runtime/memories/api.ts:537`) already exists and already serves every agent-facing recall consumer (the MCP tools and the CLI); nectar's rows reach agents through it unchanged.

---

## Open questions

None. This is a documentation PRD recording a decided outcome. The tenancy-verification mechanism is not an open question here: decision #21 locks it as a doctor-mediated assertion (owned by doctor/PRD-004), while PRD-001c owns the invariant contract.

---

## Related

- [`library/requirements/MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-009 entry and recorded decision #1 ("Nectar extends Honeycomb's recall (PRD-013), not its own harness hooks").
- [`prd-013-recall-arm-hive-graph`](../../in-work/prd-013-recall-arm-hive-graph/prd-013-recall-arm-hive-graph-index.md) — owns the recall arm this PRD's propagation claim depends on.
- [`prd-001c-shared-infra-consumption`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) — owns the deploy-time tenancy invariant (Seam 4 + the invariant block) this PRD cites.
- [`prd-005-hive-graph-catalog-tables`](../../completed/prd-005-hive-graph-catalog-tables/prd-005-hive-graph-catalog-tables-index.md) — owns the `hive_graph_versions` table and the `org`/`workspace`/`project` tenancy model.
- [`knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) — the recall-integration spec the arm conforms to.
- [`knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md`](../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md) — names the shared-Deep-Lake-substrate + the tenancy-mismatch negative consequence this PRD's invariant prevents.
