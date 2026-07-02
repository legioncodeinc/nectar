# ADR-0002, Process topology: Nectar as an independent workload daemon, not a worker inside Honeycomb

> **Status:** Accepted · **Date:** 2026-06-30
> **Supersedes:** none (refines, does not supersede, the colocation assumption stated in the overview and ADR-0001's context) · **Superseded by:** none
> **Owners:** nectar, daemon, platform
> **Expanded by:** `ADR-0003-three-daemon-topology-and-hive-portal.md`
> **Related:** Nectar overview, `ADR-0001-minted-nectar-over-source-embedded-serial.md`, `ADR-0003-three-daemon-topology-and-hive-portal.md`, `data/hive-graph-schema.md`, `data/recall-integration.md`

## Context

The original Nectar design (recorded across `overview.md`, the identity/data/AI deep-dives, and the prior-art crosswalk) assumed hiveantennae was a **background worker inside the Honeycomb daemon** (port 3850). That assumption appears in load-bearing prose throughout the corpus:

- `overview.md`: *"a background service inside the Honeycomb daemon … It is not a separate process (it shares the daemon's Deep Lake client, auth, scoping, and observability)."*
- The overview deep-dives restate it as a contract (US-OV-023 asserts hiveantennae "shares the daemon's Deep Lake client, auth, scoping, and observability, so that it is not a separate process").
- The prior-art novelty claim leans on the framing *"Nectar is a Honeycomb subsystem."*

The colocation assumption was reasonable when Nectar was conceived as an internal capability of the Honeycomb memory system. Three forces have since made it the wrong topology.

### Decision drivers

- **Independent deployability and release cadence.** Nectar's description pipeline (brooding, enrichment, embeddings, the model-choice decision in `ai/enricher-and-llm-model.md`) evolves on its own cadence, driven by LLM-provider economics and the re-association algorithm. Coupling its release to the Honeycomb daemon's release forces synchronization that serves neither component. An independent daemon ships on its own schedule.
- **Clean process boundary.** A worker inside a host daemon inherits the host's failure domain, resource limits, and signal handling. A `SIGKILL` or OOM in the description pipeline should not take down Honeycomb's session-capture and recall serving path, and a Honeycomb restart should not interrupt a brooding pass mid-batch. Process isolation gives each its own failure domain.
- **Standalone operability.** Nectar is a coherent capability on its own — give a source tree stable file identity and semantic descriptions, full stop. Forcing an operator to run the entire Honeycomb daemon to obtain it conflates two products. An independent daemon can run with or without the rest of Honeycomb present.

> **A note on what this ADR does NOT record.** There is a commercial driver behind this decision as well (Nectar's value as a standalone product). Per the authoring decision, this ADR frames the driver in technical terms only. The commercial context is real and was part of the decision; it is deliberately not expanded here to keep the ADR a pure-architecture record. A reader who finds the technical drivers above insufficient should know the omission is intentional, not an oversight.

## Considered options

### Option A, Worker inside the Honeycomb daemon (STATUS QUO, REJECTED)

The original design. hiveantennae runs as a background worker inside the Honeycomb daemon process, sharing its Deep Lake client, auth context, scoping, observability, and lifecycle.

**Why it is rejected.** It fails all three decision drivers. Release coupling, shared failure domain, and no standalone operability. The colocation was an artifact of Nectar's origin as an internal capability, not a load-bearing architectural constraint — nothing about the identity model (ADR-0001), the schema (`data/hive-graph-schema.md`), or the recall arm (`data/recall-integration.md`) requires same-process execution.

### Option B, Independent workload daemon supervised by doctor (CHOSEN, EXPANDED BY ADR-0003)

hiveantennae becomes its own OS process — the **Nectar daemon** — supervised by **doctor**. ADR-0003 expands this from a single-supervisor relationship into the registered-daemon topology: doctor owns the minimal daemon registry and supervision loop, hive owns the always-on portal, and Nectar is one workload daemon in that supervised set. doctor handles process lifecycle (start, restart on crash, health checks, graceful shutdown), while Nectar owns its own Deep Lake client, auth context, scoping, and observability within that supervised lifecycle.

Critically, **independence is at the process layer only.** The data and infrastructure layer is unchanged:

- Nectar reads and writes the **same Deep Lake tables** (`hive_graph`, `hive_graph_versions`), scoped by the same `org_id`/`workspace_id`/`project_id` tenancy. It does not get its own private store.
- The **guarded hive-graph recall arm** (`data/recall-integration.md`) still composes with Honeycomb's `sessions`/`memory`/`memories` arms. That composition is a *data-layer* integration over shared Deep Lake tables, not a *process-layer* one. An independent daemon writing to the same tables preserves it.
- The **Portkey gateway**, **embedding provider stack** (local nomic by default, hosted providers through Portkey when configured), and **CodeGraph** remain shared infrastructure Nectar consumes. Independence changes how Nectar *reaches* them (its own client, its own auth) but not *whether* it uses them.

This is the "independent process, same data/infra layer" framing: maximal architectural independence at the process boundary, minimal disruption to the data contracts the rest of the corpus documents.

### Option C, Full independence including a separate data store (REJECTED)

Nectar owns its own Deep Lake datasets, fully separate from Honeycomb's `sessions`/`memory`/`memories`. The recall union becomes a cross-daemon federated query.

**Why it is rejected.** It weakens the recall-integration pillar for no gain. The value of the fourth recall arm (`data/recall-integration.md`) is precisely that one fused recall result returns both structural/CodeGraph hits AND Nectar's semantic hits AND conversation-trace hits. Splitting the store forces federation, adds latency and failure modes, and breaks the shared-fusion property the prior-art novelty claim (`reference/prior-art-crosswalk.md`) depends on. Option B preserves the integration; Option C discards it.

## Decision

Adopt **Option B**: hiveantennae runs as the **Nectar daemon**, an independent OS process supervised by **doctor**, with its own Deep Lake client, auth context, scoping, and observability. ADR-0003 adds the surrounding topology: Nectar is registered in doctor's daemon registry, surfaced through hive's always-on portal, and kept separate from Honeycomb as a workload daemon. The data and infrastructure layer is unchanged — same Deep Lake tables, same guarded recall integration, same Portkey/embedding/CodeGraph consumption. Independence is at the process boundary only.

The `honeycomb daemon` references in the corpus that assumed colocation (running `honeycomb daemon` to obtain Nectar) are superseded by `nectar daemon` (supervised by doctor). The corpus sweep records the change at each affected site.

## Consequences

**Positive.**

- Independent release cadence. Nectar ships on its own schedule, decoupled from Honeycomb's.
- Process-isolated failure domains. A brooding/enricher crash no longer risks Honeycomb's serving path; a Honeycomb restart no longer interrupts a brood.
- Standalone operability. Nectar runs with or without the rest of Honeycomb, while still composing with it via shared Deep Lake tables when both are present.
- The data contracts (ADR-0001's identity model, the two-table schema, the recall arm, the projection) are **unchanged**. The vast majority of the corpus remains valid as-is; only process-topology prose needs the sweep.

**Negative.**

- Nectar must obtain its own Deep Lake client, auth context, scoping, and observability rather than inheriting the host's. This is real configuration surface (a doctor-supervised daemon has its own bootstrap) and must be documented in an operations runbook (out of scope for this ADR).
- The shared-substrate assumption now requires that both daemons point at the same Deep Lake datasets with compatible tenancy. A misconfiguration (Nectar pointing at a different Deep Lake org than Honeycomb) silently breaks recall integration. This was impossible under colocation; it is now a deploy-time invariant to enforce.
- Process coordination that was free under colocation (e.g. a single daemon-health signal) now crosses a process boundary and requires a doctor registry entry plus health check.

**Reversibility.** Largely reversible — hiveantennae could be re-absorbed into the Honeycomb daemon if process isolation proves costly. The data layer is unaffected either way, so no migration is required to reverse. The cost of reversal is the operational unification (re-coupling release cadence, shared failure domain), not a data migration.

## Relationship to ADR-0001

This ADR **does not supersede ADR-0001**. The identity-model decision (daemon-minted ULID, the two-table split, the re-association ladder) is independent of process topology and remains fully in force. ADR-0001's references to "the main Honeycomb PRD substrate" (FR-8, the license-header rule) describe constraints on the *implementation* that still apply — Nectar-the-independent-daemon still puts durable state in Deep Lake and still does not mutate source. Where ADR-0001's *context* prose implied colocation (e.g. "Honeycomb's constraints"), the constraint is the constraint; only the host that enforces it changes.

## Relationship to ADR-0003

ADR-0003 **expands this ADR without reversing it**. This ADR answers whether Nectar is inside Honeycomb (no). ADR-0003 answers where the portal and supervision registry live: doctor supervises registered daemons, hive hosts the always-on dashboard, and Honeycomb/Nectar are workload daemons in that supervised set. References in this ADR to doctor supervision should be read through ADR-0003's registry-and-portal topology.

## Alternatives considered and rejected, in one sentence each

- **Option A (status quo, worker inside Honeycomb):** rejected for release coupling, shared failure domain, and no standalone operability.
- **Option C (full independence, separate store):** rejected because it weakens the recall-integration pillar (forces federation, breaks the single-hybrid-query property) for no gain.

## References

- `overview.md` — the colocation assumption this ADR refines (sweep target).
- `ADR-0001-minted-nectar-over-source-embedded-serial.md` — the identity-model decision, unaffected by this topology change.
- `ADR-0003-three-daemon-topology-and-hive-portal.md` — the topology expansion that introduces hive and the doctor registry.
- `data/hive-graph-schema.md` — the two-table schema; unchanged (data layer).
- `data/recall-integration.md` — the guarded recall arm; the composition is preserved because it is a data-layer integration, not a process-layer one.
- `reference/prior-art-crosswalk.md` — the novelty claim's *"Honeycomb subsystem"* framing, restated under this ADR as *"independent daemon composing with Honeycomb via shared Deep Lake substrate."*
