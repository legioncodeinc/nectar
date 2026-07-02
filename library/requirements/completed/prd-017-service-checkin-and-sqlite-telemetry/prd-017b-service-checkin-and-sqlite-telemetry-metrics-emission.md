# PRD-017b: Metrics Emission to Local SQLite

> **Parent:** [PRD-017](./prd-017-service-checkin-and-sqlite-telemetry-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None to Deep Lake. Adds a local SQLite metrics snapshot table.

---

## Goals

Expose nectar's non-sensitive operational metrics in its own local SQLite so doctor can poll them, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. Emit the nectar-pipeline counters since the last restart: files registered, nectars minted, descriptions generated, hive-graph versions written, and embeddings computed.

## Scope

- A `nectar_metrics` table in nectar's local SQLite (Node's built-in `node:sqlite`), holding a latest-wins snapshot of since-restart counters.
- The nectar metric set: files registered (PRD-006 intake), nectars minted (ULID identity), descriptions generated (the enricher and brooding loop, PRD-007 and PRD-016), hive-graph versions written (`hive_graph_versions`, PRD-005), and embeddings computed (PRD-014).
- Incrementing each counter on its existing pipeline path. The exact counter source is DEFAULT: add fresh in-process since-restart counters on the pipeline paths, confirm before implementation rather than assuming named symbols exist in code today.
- Resetting the since-restart counters on process start so a restart produces a clean baseline.
- Fail-soft writes that never block the nectar pipeline.

## Out of scope

- Check-in, registration, and heartbeat (PRD-017a).
- Log emission (PRD-017c).
- doctor's poll, merge, and relay (doctor PRD-001 and PRD-002).

---

## User stories and acceptance criteria

### US-017b.1 - doctor can poll live metrics

**As** doctor, **I want** nectar's metrics in local SQLite, **so that** I can read them on my interval without nectar pushing.

- AC-017b.1.1 Given nectar is doing pipeline work, when doctor reads `nectar_metrics`, then it sees current values for files registered, nectars minted, descriptions generated, hive-graph versions written, and embeddings computed since restart.
- AC-017b.1.2 Given the metrics table, when it is read, then values are a latest-wins snapshot, not an unbounded append log.

### US-017b.2 - Metrics reflect one definition per counter

**As** an implementer, **I want** each metric written from one place on its pipeline path, **so that** there is one definition of each counter with no double counting.

- AC-017b.2.1 Given the nectar pipeline stages, when the metrics snapshot is written, then each counter (files registered, nectars minted, descriptions generated, hive-graph versions, embeddings computed) is incremented once per unit of work, without double counting.

### US-017b.3 - Restart resets since-restart counters

**As** doctor, **I want** since-restart semantics to hold, **so that** a restart is observable as a counter reset.

- AC-017b.3.1 Given a nectar restart, when the metrics snapshot is next read, then the since-restart counters reflect the new process lifetime starting from zero.

### US-017b.4 - Metrics carry no sensitive data

- AC-017b.4.1 Given any metrics row, when written, then it contains no token, credential value, org secret, source-file content, LLM description body, or PII, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. The row holds counts only, never nectar contents or descriptions.

---

## Technical considerations

- The metrics store is latest-wins per counter, written on a short interval or on change, keeping the read cheap enough for doctor's roughly one-second poll.
- The counters are pure counts of pipeline events (a file registered, a nectar minted, a description generated, a version row written, an embedding computed), which are inherently non-sensitive; no nectar identity payload, source text, or description text enters the row.
- The write goes through Node's built-in `node:sqlite` in WAL mode so doctor's read-only open does not contend with nectar's writes (per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`).
- Fail-soft: a metrics write error is caught and dropped; it never surfaces into the pipeline.

## Files touched (anticipated)

- New `src/telemetry/metrics.ts` - the since-restart snapshot writer.
- Pipeline touchpoints (file registration, minting, enricher/brooding, versions, embeddings) - increment the counters on the existing paths. Exact wiring is DEFAULT, confirm before implementation.
- Tests under `test/telemetry/`.

## Test plan

- Unit: each counter increments once per unit of work without double counting (AC-017b.2.1).
- Unit: table is latest-wins, not append (AC-017b.1.2).
- Unit: restart resets since-restart counters (AC-017b.3.1).
- Unit: no sensitive fields present, counts only (AC-017b.4.1).
- Integration: a read-only reader observes live values while nectar writes (AC-017b.1.1).

## Open questions

- [ ] Flush cadence for the snapshot: on a timer, on counter change, or piggybacked on the heartbeat from PRD-017a?
- [ ] Which pipeline symbols (if any) already expose these counts, versus adding fresh in-process counters? DEFAULT: add fresh since-restart counters, confirm before implementation.
- [ ] Is "files registered" counted per file or per intake batch on nectar's registration path?

---

## Related

- Parent: [PRD-017](./prd-017-service-checkin-and-sqlite-telemetry-index.md)
- `../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - services write non-sensitive telemetry to local SQLite; doctor polls read-only.
- Sibling: [PRD-017a](./prd-017a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md), [PRD-017c](./prd-017c-service-checkin-and-sqlite-telemetry-log-emission.md).
- `../../../../../honeycomb/library/requirements/backlog/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md` - the honeycomb sibling whose metrics contract this mirrors.
