# PRD-009a: Decision record + per-harness recall-call-site mapping + tenancy-scope invariant

> Parent: [`prd-009-harness-exposure-via-recall-index.md`](./prd-009-harness-exposure-via-recall-index.md)

## Overview

This is the sole sub-PRD of a documentation-only PRD. It carries three artifacts and ships no code:

1. **The decision record** — why Nectar ships no harness hooks of its own, and why extending honeycomb's shared recall (PRD-013) is the correct and sufficient path to agent-facing exposure.
2. **The per-harness recall-call-site mapping** — for each of the three priority harnesses (Claude Code, Codex, Cursor), the connector, the hook-config/handler seam, and the single `recallMemories` call site that already serves it — proving one integration point propagates to all of them.
3. **The tenancy-scope invariant** — the one real integration concern: nectar's `hive_graph_versions` rows must be readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope, or recall integration silently breaks. PRD-001c owns the contract; this PRD cites it.

Every claim below is grounded in a cited honeycomb file:line. The recall engine, the connectors, the hook bundles, and the loopback route all already exist in the honeycomb repo; nothing here is built, nothing here changes them.

---

## The decision record

### Decision

Nectar does NOT ship its own harness hooks, harness connectors, hook-config files, or per-harness shim. It composes with honeycomb's recall by writing `hive_graph_versions` rows that PRD-013's recall arm reads. Exposure to every armed harness is a consequence of that data-layer composition, not a process-layer integration.

### Status

Decided. Recorded as decision #1 at the foot of [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md): "Nectar extends Honeycomb's recall (PRD-013), not its own harness hooks. PRD-009 collapses from a 4-sub-PRD implementation effort to a single documentation sub-PRD (009a). PRD-013 is the sole agent-facing integration point." This collapses the original four-sub-PRD implementation plan (one sub-PRD per harness) into this single documentation sub-PRD.

### Rationale (grounded in the code)

Recall is a single shared engine, not a per-harness surface. The entry point is `recallMemories` (`honeycomb/src/daemon/runtime/memories/recall.ts:2172`), which assembles its hits from a ranked `arms` array:

```ts
const arms: RankedArm[] = [
    ...(semanticRun?.arms ?? []),
    rowsToRankedArm(memoriesRows),
    rowsToRankedArm(memoryRows),
    rowsToRankedArm(sessionsRows),
];
```

(`honeycomb/src/daemon/runtime/memories/recall.ts:2225-2233`) — the single insertion point PRD-013 extends with a `rowsToRankedArm(hiveGraphRows)` entry.

Every armed harness reaches this same function through one production call site. `recallMemories` is invoked in exactly one place in production: the `POST /api/memories/recall` handler (`honeycomb/src/daemon/runtime/memories/api.ts:537`), mounted under the session-protected `/api/memories` route group (`honeycomb/src/daemon/runtime/server.ts:72` `{ path: "/api/memories", protect: true, session: true }`; `MEMORIES_GROUP`, `honeycomb/src/daemon/runtime/memories/api.ts:85`). Every agent-facing recall consumer funnels through it: the MCP tools `memory_search` and `hivemind_search` route to `POST /api/memories/recall` (`honeycomb/mcp/src/handlers.ts:176,270`; `honeycomb/mcp/src/tools.ts:97`), and the CLI `recall` verb POSTs the same path (`honeycomb/src/commands/storage-handlers.ts:38,175`). The harness hook bundles are thin loopback clients too, but they POST captured events to the SEPARATE `/api/hooks` route group (`honeycomb/src/daemon/runtime/server.ts:74` `{ path: "/api/hooks", protect: true, session: true }`), whose `/capture`, `/context`, and `/session-end` handlers (`honeycomb/src/daemon/runtime/capture/capture-handler.ts:210`, `honeycomb/src/daemon/runtime/capture/attach.ts:172-173`) never invoke `recallMemories`; session-start memory injection is the separate `GET /api/memories/prime` digest (`honeycomb/src/daemon/runtime/memories/prime.ts:151`), which also does not call `recallMemories`. The hook bundles carry "no DeepLake; the only outbound path is the daemon client over loopback" (`honeycomb/harnesses/claude-code/src/index.ts:12,20`).

The consequence is structural: a new arm added to `recallMemories` surfaces in **every** harness honeycomb is armed against, because no harness holds its own recall path. Building a nectar-side connector or hook for each harness would duplicate a path that already exists and would have to be maintained in lockstep with honeycomb's recall engine. Extending recall once is strictly less work and strictly less surface.

### Alternatives rejected

- **Ship per-harness hooks from nectar.** The original PRD-009 plan was four sub-PRDs, one per harness (Claude Code, Codex, Cursor, plus a shared shim). Research against the honeycomb code found recall is a shared engine all harnesses already call through one loopback route. Per-harness hooks would duplicate that path, couple nectar to each harness's hook-config format (Claude Code's plugin spec, Codex's `~/.codex/hooks.json`, Cursor's `~/.cursor/hooks.json`), and force a nectar-side change every time honeycomb's recall contract changed. Rejected.
- **A nectar-shipped recall engine.** nectar would re-implement `recallMemories` over its own rows and expose its own `/api/hooks`-equivalent. Rejected: it duplicates the fused-recall value (sessions + memories + hive-graph in one ranked result), forces every harness to register against a second daemon, and breaks ADR-0002's shared-data-layer invariant. Recall composition is data-layer; nectar writes rows, honeycomb fuses them.
- **In-process recall import across the process boundary.** nectar importing honeycomb's `recallMemories` directly. Rejected: ADR-0002 establishes the process boundary; patterns are mirrored, not imported, across it.

---

## Per-harness recall-call-site mapping

The three priority harnesses named in the PRD-009 entry ([`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md)) are Claude Code, Codex, and Cursor. For each, the table below cites (a) the connector that arms honeycomb against the harness, (b) the hook-config/handler seam that wires the harness's events into honeycomb's loopback, and (c) the single `recallMemories` call site that serves it. All three share column (c).

| Harness | (a) Connector (arms honeycomb against the harness) | (b) Hook-config / handler seam | (c) Shared recall call site |
|---|---|---|---|
| **Claude Code** | `ClaudeCodeConnector.install()` at `:137-165` — registers honeycomb as a Claude Code marketplace plugin (`marketplace add` → `update` → `install` → `enable`); fail-softs to a `settings.json` fallback + manual-register notice when the `claude` runner is absent. | `honeycomb/harnesses/claude-code/hooks/hooks.json` — declares the SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStop/SessionEnd hooks, each invoking `node "${CLAUDE_PLUGIN_ROOT}/bundle/index.js"` (the loopback client). | `recallMemories` (`recall.ts:2172`), reached by the MCP tools + CLI recall consumers → `POST /api/memories/recall` (`server.ts:72` → `api.ts:537`) |
| **Codex** | `CodexConnector` at `:48-99` — `harness = "codex"`; SEAM 1 loads user-level hooks from `~/.codex/hooks.json` (`configPath()`, `:66-68`), SEAM 2 mounts the compiled handler set from `harnesses/codex/bundle/` (`hookHandlers()`, `:71-82`), SEAM 4 maps native event names (`eventNameMap()`, `:91-93`). | Codex hook-config at `~/.codex/hooks.json` (`codex.ts:66-68`); handlers compiled into `harnesses/codex/bundle/` (`codex.ts:71-82`) — the loopback clients. | same — `recallMemories` (`recall.ts:2172`) via the MCP tools + CLI → `POST /api/memories/recall` (`server.ts:72` → `api.ts:537`) |
| **Cursor** | `CursorConnector` at `:83-136` — `harness = "cursor"`; SEAM 1 hook-config at `~/.cursor/hooks.json` (`configPath()`, `:101-103`), SEAM 2 handler set from `harnesses/cursor/bundle/` (`hookHandlers()`, `:106-120`), SEAM 3 skill-links into `~/.cursor/skills/` (`skillLinkTargets()`, `:123-126`). | Cursor hook-config at `~/.cursor/hooks.json` (`cursor.ts:101-103`); handlers compiled into `harnesses/cursor/bundle/` (`cursor.ts:106-120`) — the loopback clients. | same — `recallMemories` (`recall.ts:2172`) via the MCP tools + CLI → `POST /api/memories/recall` (`server.ts:72` → `api.ts:537`) |

### What the mapping proves

Because column (c) is identical across all three rows, adding a `hive_graph_versions` arm to `recallMemories`'s `arms` array (`recall.ts:2225-2233`) propagates the new hits to Claude Code, Codex, and Cursor in the same edit, with no connector change, no hook-config change, and no bundle change in any harness. The three connectors (`claude-code.ts:137-165`, `codex.ts:48-99`, `cursor.ts:83-136`) and their hook configs (`hooks.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`) are already armed; this PRD confirms that state and adds nothing to them.

The honeycomb repo ships other armed harnesses (hermes, openclaw, pi under `honeycomb/harnesses/`). They follow the same connector/loopback pattern and therefore inherit the propagation identically; they are out of the PRD-009 priority set named in the master index but the propagation claim holds for them by the same mechanism.

---

## The tenancy-scope invariant

Propagation is free, but it is conditional on one deploy-time fact: nectar's `hive_graph_versions` rows must be readable by honeycomb's recall engine under the same `org`/`workspace`/`project` scope honeycomb uses. This is the **deploy-time tenancy invariant** PRD-001c owns and states:

> Both daemons point at the same Deep Lake datasets with compatible tenancy. A misconfiguration (nectar pointing at a different Deep Lake org than honeycomb) silently breaks recall integration. ([`prd-001c`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md), "The deploy-time tenancy invariant")

Concretely: nectar's Deep Lake client and honeycomb's Deep Lake client must resolve to the **same `org`** and operate in the **same `workspace`**, with `project_id` as the shared column filter ([`prd-001c`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md), Seam 4 + the invariant block; tenancy model owned by [`prd-005`](../../completed/prd-005-hive-graph-catalog-tables/prd-005-hive-graph-catalog-tables-index.md)). PRD-013's arm scopes its query with the same `projectConjunctFor(request)` predicate the other lexical arms AND in (`recall.ts:2089`, threaded into every arm at `:2096-2101`), so a row from a mismatched org/workspace never enters the fusion simply because the storage client never returns it.

### Why this is the one real integration concern

The recall arm, the connector plumbing, and the loopback route all already exist. The only thing that can make the propagation claim false is a deploy-time scope mismatch: if nectar writes rows under org A and honeycomb's recall reads under org B, the arm runs, the query is well-formed, and it simply returns zero rows — silently. There is no error, no log, no degraded flag; the agent just stops seeing Hive Graph hits. This is the silent-failure mode ADR-0002 negative-consequence #2 names ([`knowledge/private/architecture/ADR-0002`](../../../knowledge/private/architecture/ADR-0002-nectar-independent-daemon-supervised-by-doctor.md)).

### Owner + enforcement

The invariant's **contract** is owned by [`prd-001c`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) (Seam 4 + the invariant block). Its **enforcement mechanism** is locked by decision #21 ([`PRD-DECISIONS-AND-DEFAULTS.md`](../../PRD-DECISIONS-AND-DEFAULTS.md)): a **doctor-mediated assertion** whereby doctor gains a Deep Lake scope-comparison capability and refuses to supervise a daemon whose org/workspace scope mismatches another registered daemon's, centralizing the invariant in the supervisor. PRD-004 documents doctor's new scope-awareness, and #21 names PRD-001c, 004, and 009a as its application sites. This PRD cites the owner and records that a violation silently breaks the propagation this PRD documents.

---

## User stories + acceptance criteria

### US-009a.1 — A new recall arm surfaces in every armed harness, no per-harness work
**As** an agent running in Claude Code, Codex, or Cursor, **when** PRD-013 adds the `hive_graph_versions` arm to `recallMemories`, **then** my fused recall results include Hive Graph hits, **because** my recall queries funnel through the single shared `recallMemories` call site (`POST /api/memories/recall`) that every agent-facing consumer uses.

- Acceptance: the PRD maps each of the three priority harnesses to the same production `recallMemories` call site (`recall.ts:2172`), the `POST /api/memories/recall` handler (`server.ts:72` → `api.ts:537`) that the MCP tools and CLI recall consumers funnel through, with a connector + hook-config citation for each.
- Acceptance: the PRD cites the exact `arms`-array insertion point (`recall.ts:2225-2233`) and states that no connector, hook-config, or bundle change is required in any harness.

### US-009a.2 — The "no nectar hooks" decision is recorded and rationale-grounded
**As** a maintainer, **when** I read this PRD, **I** see a decision record stating Nectar ships no hooks and explaining why, **so that** no future pass re-attempts the per-harness implementation.

- Acceptance: the decision record cites that recall is a shared engine (`recall.ts:2172`) reached by every agent-facing consumer through one production call site (`POST /api/memories/recall`, `server.ts:72` → `api.ts:537`), and names the rejected alternatives (per-harness hooks, a nectar recall engine, in-process import).

### US-009a.3 — The tenancy mismatch is named as the silent-failure mode
**As an** operator, **when** I deploy nectar, **I** am warned that a scope mismatch silently breaks recall, **so that** I enforce the tenancy invariant rather than assuming it.

- Acceptance: the PRD states the invariant (same `org`/`workspace`, `project_id` as shared filter), cites [`prd-001c`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) as the contract owner, and names the silent-failure mode (zero rows, no error, no `degraded` flag).

---

## Implementation notes

This sub-PRD ships no code. The implementation notes below are pointers to the code the decision rests on, for the verifier.

- Recall entry point: `honeycomb/src/daemon/runtime/memories/recall.ts:2172` (`recallMemories`).
- Arms-array insertion point (the single integration point PRD-013 extends): `recall.ts:2225-2233`.
- Per-arm lexical builders PRD-013 mirrors (`buildMemoriesArmSql`/`buildMemoryArmSql`/`buildSessionsArmSql`): `recall.ts:319-383`.
- The `projectClause` conjunct every arm ANDs in (the `project_id` scope filter): `recall.ts:2089`, threaded into `runArm` at `:2096-2101`.
- The single production `recallMemories` call site (session-protected `POST /api/memories/recall`, reached by the MCP tools + CLI recall consumers): `honeycomb/src/daemon/runtime/memories/api.ts:537`, under the `/api/memories` route group `honeycomb/src/daemon/runtime/server.ts:72` (`MEMORIES_GROUP`, `honeycomb/src/daemon/runtime/memories/api.ts:85`).
- The MCP + CLI recall consumers that funnel through it: `honeycomb/mcp/src/handlers.ts:176,270`, `honeycomb/mcp/src/tools.ts:97`, `honeycomb/src/commands/storage-handlers.ts:38,175`.
- The `/api/hooks` route group (the capture/context/session-end loopback, NOT a recall path): `honeycomb/src/daemon/runtime/server.ts:74` (`capture-handler.ts:210`, `attach.ts:172-173`). Session-start memory injection is the separate `GET /api/memories/prime` digest: `honeycomb/src/daemon/runtime/memories/prime.ts:151`.
- Claude Code connector + hook config: `src/connectors/claude-code.ts:137-165`, `harnesses/claude-code/hooks/hooks.json`.
- Codex connector: `src/connectors/codex.ts:48-99`.
- Cursor connector: `src/connectors/cursor.ts:83-136`.
- Tenancy invariant (contract owner): [`prd-001c`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md).
- Recall-arm implementation owner: [`prd-013`](../../in-work/prd-013-recall-arm-hive-graph/prd-013-recall-arm-hive-graph-index.md).

No open questions. The tenancy-verification mechanism is locked by decision #21 as a doctor-mediated assertion (owned by doctor/PRD-004); PRD-001c owns the invariant contract. This sub-PRD cites them.

## Related

- [`prd-009-harness-exposure-via-recall-index.md`](./prd-009-harness-exposure-via-recall-index.md) — module scope (this is its sole sub-PRD).
- [`prd-013-recall-arm-hive-graph`](../../in-work/prd-013-recall-arm-hive-graph/prd-013-recall-arm-hive-graph-index.md) — owns the recall arm this PRD's propagation claim depends on.
- [`prd-001c-shared-infra-consumption`](../../completed/prd-001-three-daemon-topology/prd-001c-shared-infra-consumption.md) — owns the deploy-time tenancy invariant this PRD cites.
- [`MASTER-PRD-INDEX.md`](../../MASTER-PRD-INDEX.md) — the PRD-009 entry and recorded decision #1.
