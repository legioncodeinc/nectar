# PRD-009a: Decision record + per-harness recall-call-site mapping + tenancy-scope invariant

> Parent: [`prd-009-harness-exposure-via-recall-index.md`](./prd-009-harness-exposure-via-recall-index.md)

## Overview

This is the sole sub-PRD of a documentation-only PRD. It carries three artifacts and ships no code:

1. **The decision record** — why Hivenectar ships no harness hooks of its own, and why extending honeycomb's shared recall (PRD-013) is the correct and sufficient path to agent-facing exposure.
2. **The per-harness recall-call-site mapping** — for each of the three priority harnesses (Claude Code, Codex, Cursor), the connector, the hook-config/handler seam, and the single `recallMemories` call site that already serves it — proving one integration point propagates to all of them.
3. **The tenancy-scope invariant** — the one real integration concern: hivenectar's `source_graph_versions` rows must be readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope, or recall integration silently breaks. PRD-001c owns the contract; this PRD cites it.

Every claim below is grounded in a cited honeycomb file:line. The recall engine, the connectors, the hook bundles, and the loopback route all already exist in the honeycomb repo; nothing here is built, nothing here changes them.

---

## The decision record

### Decision

Hivenectar does NOT ship its own harness hooks, harness connectors, hook-config files, or per-harness shim. It composes with honeycomb's recall by writing `source_graph_versions` rows that PRD-013's recall arm reads. Exposure to every armed harness is a consequence of that data-layer composition, not a process-layer integration.

### Status

Decided. Recorded as decision #1 at the foot of [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md): "Hivenectar extends Honeycomb's recall (PRD-013), not its own harness hooks. PRD-009 collapses from a 4-sub-PRD implementation effort to a single documentation sub-PRD (009a). PRD-013 is the sole agent-facing integration point." This collapses the original four-sub-PRD implementation plan (one sub-PRD per harness) into this single documentation sub-PRD.

### Rationale (grounded in the code)

Recall is a single shared engine, not a per-harness surface. The entry point is `recallMemories` ([`honeycomb/src/daemon/runtime/memories/recall.ts:2064`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)), which assembles its hits from a ranked `arms` array:

```ts
const arms: RankedArm[] = [
    ...(semanticRun?.arms ?? []),
    rowsToRankedArm(memoriesRows),
    rowsToRankedArm(memoryRows),
    rowsToRankedArm(sessionsRows),
];
```

([`honeycomb/src/daemon/runtime/memories/recall.ts:2113-2118`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)) — the single insertion point PRD-013 extends with a `rowsToRankedArm(sourceGraphRows)` entry.

Every armed harness reaches this same function through the same path. Each harness's hook bundle is a thin loopback client: it POSTs captured events to honeycomb's session-protected `/api/hooks` route ([`honeycomb/src/daemon/runtime/server.ts:77`](../../../../honeycomb/src/daemon/runtime/server.ts) `{ path: "/api/hooks", protect: true, session: true }`), and that route's handler invokes `recallMemories` ([`honeycomb/src/daemon/runtime/memories/api.ts:537`](../../../../honeycomb/src/daemon/runtime/memories/api.ts)). The hook bundles themselves carry "no DeepLake; the only outbound path is the daemon client over loopback" ([`honeycomb/harnesses/claude-code/src/index.ts:12,20`](../../../../honeycomb/harnesses/claude-code/src/index.ts)).

The consequence is structural: a new arm added to `recallMemories` surfaces in **every** harness honeycomb is armed against, because no harness holds its own recall path. Building a hivenectar-side connector or hook for each harness would duplicate a path that already exists and would have to be maintained in lockstep with honeycomb's recall engine. Extending recall once is strictly less work and strictly less surface.

### Alternatives rejected

- **Ship per-harness hooks from hivenectar.** The original PRD-009 plan was four sub-PRDs, one per harness (Claude Code, Codex, Cursor, plus a shared shim). Research against the honeycomb code found recall is a shared engine all harnesses already call through one loopback route. Per-harness hooks would duplicate that path, couple hivenectar to each harness's hook-config format (Claude Code's plugin spec, Codex's `~/.codex/hooks.json`, Cursor's `~/.cursor/hooks.json`), and force a hivenectar-side change every time honeycomb's recall contract changed. Rejected.
- **A hivenectar-shipped recall engine.** hivenectar would re-implement `recallMemories` over its own rows and expose its own `/api/hooks`-equivalent. Rejected: it duplicates the fused-recall value (sessions + memories + source-graph in one ranked result), forces every harness to register against a second daemon, and breaks ADR-0002's shared-data-layer invariant. Recall composition is data-layer; hivenectar writes rows, honeycomb fuses them.
- **In-process recall import across the process boundary.** hivenectar importing honeycomb's `recallMemories` directly. Rejected: ADR-0002 establishes the process boundary; patterns are mirrored, not imported, across it.

---

## Per-harness recall-call-site mapping

The three priority harnesses named in the PRD-009 entry ([`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)) are Claude Code, Codex, and Cursor. For each, the table below cites (a) the connector that arms honeycomb against the harness, (b) the hook-config/handler seam that wires the harness's events into honeycomb's loopback, and (c) the single `recallMemories` call site that serves it. All three share column (c).

| Harness | (a) Connector (arms honeycomb against the harness) | (b) Hook-config / handler seam | (c) Shared recall call site |
|---|---|---|---|
| **Claude Code** | [`ClaudeConnector.install()`](../../../../honeycomb/src/connectors/claude-code.ts) at [`:137-165`](../../../../honeycomb/src/connectors/claude-code.ts) — registers honeycomb as a Claude Code marketplace plugin (`marketplace add` → `update` → `install` → `enable`); fail-softs to a `settings.json` fallback + manual-register notice when the `claude` runner is absent. | [`honeycomb/harnesses/claude-code/hooks/hooks.json`](../../../../honeycomb/harnesses/claude-code/hooks/hooks.json) — declares the SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStop/SessionEnd hooks, each invoking `node "${CLAUDE_PLUGIN_ROOT}/bundle/index.js"` (the loopback client). | `recallMemories` ([`recall.ts:2064`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)), reached via `/api/hooks` ([`server.ts:77`](../../../../honeycomb/src/daemon/runtime/server.ts)) → handler at [`api.ts:537`](../../../../honeycomb/src/daemon/runtime/memories/api.ts) |
| **Codex** | [`CodexConnector`](../../../../honeycomb/src/connectors/codex.ts) at [`:48-99`](../../../../honeycomb/src/connectors/codex.ts) — `harness = "codex"`; SEAM 1 loads user-level hooks from `~/.codex/hooks.json` (`configPath()`, `:66-68`), SEAM 2 mounts the compiled handler set from `harnesses/codex/bundle/` (`hookHandlers()`, `:71-82`), SEAM 4 maps native event names (`eventNameMap()`, `:91-93`). | Codex hook-config at `~/.codex/hooks.json` ([`codex.ts:66-68`](../../../../honeycomb/src/connectors/codex.ts)); handlers compiled into `harnesses/codex/bundle/` ([`codex.ts:71-82`](../../../../honeycomb/src/connectors/codex.ts)) — the loopback clients. | same — `recallMemories` ([`recall.ts:2064`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)) via `/api/hooks` ([`server.ts:77`](../../../../honeycomb/src/daemon/runtime/server.ts)) → [`api.ts:537`](../../../../honeycomb/src/daemon/runtime/memories/api.ts) |
| **Cursor** | [`CursorConnector`](../../../../honeycomb/src/connectors/cursor.ts) at [`:83-136`](../../../../honeycomb/src/connectors/cursor.ts) — `harness = "cursor"`; SEAM 1 hook-config at `~/.cursor/hooks.json` (`configPath()`, `:101-103`), SEAM 2 handler set from `harnesses/cursor/bundle/` (`hookHandlers()`, `:106-120`), SEAM 3 skill-links into `~/.cursor/skills/` (`skillLinkTargets()`, `:123-126`). | Cursor hook-config at `~/.cursor/hooks.json` ([`cursor.ts:101-103`](../../../../honeycomb/src/connectors/cursor.ts)); handlers compiled into `harnesses/cursor/bundle/` ([`cursor.ts:106-120`](../../../../honeycomb/src/connectors/cursor.ts)) — the loopback clients. | same — `recallMemories` ([`recall.ts:2064`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)) via `/api/hooks` ([`server.ts:77`](../../../../honeycomb/src/daemon/runtime/server.ts)) → [`api.ts:537`](../../../../honeycomb/src/daemon/runtime/memories/api.ts) |

### What the mapping proves

Because column (c) is identical across all three rows, adding a `source_graph_versions` arm to `recallMemories`'s `arms` array ([`recall.ts:2113-2118`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts)) propagates the new hits to Claude Code, Codex, and Cursor in the same edit, with no connector change, no hook-config change, and no bundle change in any harness. The three connectors ([`claude-code.ts:137-165`](../../../../honeycomb/src/connectors/claude-code.ts), [`codex.ts:48-99`](../../../../honeycomb/src/connectors/codex.ts), [`cursor.ts:83-136`](../../../../honeycomb/src/connectors/cursor.ts)) and their hook configs ([`hooks.json`](../../../../honeycomb/harnesses/claude-code/hooks/hooks.json), `~/.codex/hooks.json`, `~/.cursor/hooks.json`) are already armed; this PRD confirms that state and adds nothing to them.

The honeycomb repo ships other armed harnesses (hermes, openclaw, pi under `honeycomb/harnesses/`). They follow the same connector/loopback pattern and therefore inherit the propagation identically; they are out of the PRD-009 priority set named in the master index but the propagation claim holds for them by the same mechanism.

---

## The tenancy-scope invariant

Propagation is free, but it is conditional on one deploy-time fact: hivenectar's `source_graph_versions` rows must be readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope honeycomb uses. This is the **deploy-time tenancy invariant** PRD-001c owns and states:

> Both daemons point at the same Deep Lake datasets with compatible tenancy. A misconfiguration (hivenectar pointing at a different Deep Lake org than honeycomb) silently breaks recall integration. ([`prd-001c`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md), "The deploy-time tenancy invariant")

Concretely: hivenectar's Deep Lake client and honeycomb's Deep Lake client must resolve to the **same `org`** and operate in the **same `workspace`**, with `project_id` as the shared column filter ([`prd-001c`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md), Seam 4 + the invariant block; tenancy model owned by [`prd-005`](../prd-005-source-graph-catalog-tables/prd-005-source-graph-catalog-tables-index.md)). PRD-013's arm scopes its query with the same `projectConjunctFor(request)` predicate the other lexical arms AND in ([`recall.ts:2089`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts), threaded into every arm at `:2096-2101`), so a row from a mismatched org/workspace never enters the fusion simply because the storage client never returns it.

### Why this is the one real integration concern

The recall arm, the connector plumbing, and the loopback route all already exist. The only thing that can make the propagation claim false is a deploy-time scope mismatch: if hivenectar writes rows under org A and honeycomb's recall reads under org B, the arm runs, the query is well-formed, and it simply returns zero rows — silently. There is no error, no log, no degraded flag; the agent just stops seeing Source Graph hits. This is the silent-failure mode ADR-0002 negative-consequence #2 names ([`knowledge/private/architecture/ADR-0002`](../../../knowledge/private/architecture/ADR-0002-hivenectar-independent-daemon-supervised-by-hivedoctor.md)).

### Owner + enforcement

The invariant's **contract** is owned by [`prd-001c`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) (Seam 4 + the invariant block), which also flags the **enforcement mechanism** as a default for PRD-002/PRD-003 to confirm (a bootstrap-time org-equality check, a shared config file, or a hivedoctor-mediated assertion). This PRD does not restate that default or re-flag it; it cites the owner and records that a violation silently breaks the propagation this PRD documents.

---

## User stories + acceptance criteria

### US-009a.1 — A new recall arm surfaces in every armed harness, no per-harness work
**As** an agent running in Claude Code, Codex, or Cursor, **when** PRD-013 adds the `source_graph_versions` arm to `recallMemories`, **then** my fused recall results include Source Graph hits, **because** my harness reaches recall through the shared `/api/hooks` loopback that every harness uses.

- Acceptance: the PRD maps each of the three priority harnesses to the same `recallMemories` call site (`recall.ts:2064`) via the same `/api/hooks` route (`server.ts:77` → `api.ts:537`), with a connector + hook-config citation for each.
- Acceptance: the PRD cites the exact `arms`-array insertion point (`recall.ts:2113-2118`) and states that no connector, hook-config, or bundle change is required in any harness.

### US-009a.2 — The "no hivenectar hooks" decision is recorded and rationale-grounded
**As** a maintainer, **when** I read this PRD, **I** see a decision record stating Hivenectar ships no hooks and explaining why, **so that** no future pass re-attempts the per-harness implementation.

- Acceptance: the decision record cites that recall is a shared engine (`recall.ts:2064`) reached by every armed harness through one loopback route (`server.ts:77`), and names the rejected alternatives (per-harness hooks, a hivenectar recall engine, in-process import).

### US-009a.3 — The tenancy mismatch is named as the silent-failure mode
**As an** operator, **when** I deploy hivenectar, **I** am warned that a scope mismatch silently breaks recall, **so that** I enforce the tenancy invariant rather than assuming it.

- Acceptance: the PRD states the invariant (same `org`/`workspace`, `project_id` as shared filter), cites [`prd-001c`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) as the contract owner, and names the silent-failure mode (zero rows, no error, no `degraded` flag).

---

## Implementation notes

This sub-PRD ships no code. The implementation notes below are pointers to the code the decision rests on, for the verifier.

- Recall entry point: [`honeycomb/src/daemon/runtime/memories/recall.ts:2064`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts) (`recallMemories`).
- Arms-array insertion point (the single integration point PRD-013 extends): [`recall.ts:2113-2118`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).
- Per-arm lexical builders PRD-013 mirrors (`buildMemoriesArmSql`/`buildMemoryArmSql`/`buildSessionsArmSql`): [`recall.ts:319-383`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts).
- The `projectClause` conjunct every arm ANDs in (the `project_id` scope filter): [`recall.ts:2089`](../../../../honeycomb/src/daemon/runtime/memories/recall.ts), threaded into `runArm` at `:2096-2101`.
- `/api/hooks` route (session-protected, the loopback every harness POSTs to): [`honeycomb/src/daemon/runtime/server.ts:77`](../../../../honeycomb/src/daemon/runtime/server.ts).
- The handler that invokes `recallMemories`: [`honeycomb/src/daemon/runtime/memories/api.ts:537`](../../../../honeycomb/src/daemon/runtime/memories/api.ts).
- Claude Code connector + hook config: [`src/connectors/claude-code.ts:137-165`](../../../../honeycomb/src/connectors/claude-code.ts), [`harnesses/claude-code/hooks/hooks.json`](../../../../honeycomb/harnesses/claude-code/hooks/hooks.json).
- Codex connector: [`src/connectors/codex.ts:48-99`](../../../../honeycomb/src/connectors/codex.ts).
- Cursor connector: [`src/connectors/cursor.ts:83-136`](../../../../honeycomb/src/connectors/cursor.ts).
- Tenancy invariant (contract owner): [`prd-001c`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md).
- Recall-arm implementation owner: [`prd-013`](../prd-013-recall-arm-source-graph/prd-013-recall-arm-source-graph-index.md).

No open questions. The tenancy-verification mechanism is a flagged default owned by PRD-001c; this sub-PRD cites it and does not re-flag it.

## Related

- [`prd-009-harness-exposure-via-recall-index.md`](./prd-009-harness-exposure-via-recall-index.md) — module scope (this is its sole sub-PRD).
- [`prd-013-recall-arm-source-graph`](../prd-013-recall-arm-source-graph/prd-013-recall-arm-source-graph-index.md) — owns the recall arm this PRD's propagation claim depends on.
- [`prd-001c-shared-infra-consumption`](../prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) — owns the deploy-time tenancy invariant this PRD cites.
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-009 entry and recorded decision #1.
