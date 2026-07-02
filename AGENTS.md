# AGENTS.md — Nectar

Guidance for ZCode agents working in this repository. Read this before editing.

## What this repository is

Nectar is a **functional, evolving TypeScript/Node codebase** (not a
spec-only repository). It implements a semantic memory layer that gives every
file in a project a stable identity (a "nectar": a daemon-minted ULID) and an
LLM-minted title + description, then serves both back through hybrid
semantic/lexical recall so an agent can answer "where is the login logic"
rather than only "find symbol X".

- **The repo holds real, buildable, testable source code.** The daemon lives
  under `src/`, builds with `npm run build` (tsc to `dist/`), typechecks with
  `npm run typecheck`, and tests with `npm test` (Node's built-in test runner).
  The runnable entry point is `nectar daemon` (CLI at `src/cli.ts`), which
  boots the daemon on `127.0.0.1:3854` with a `/health` endpoint, a
  single-instance PID/lock guard under `~/.honeycomb`, an adaptive worker loop,
  and graceful shutdown. Implementation proceeds PRD by PRD (see
  `library/requirements/`); the `library/` docs are the design contract the code
  conforms to, and both evolve together.
- **The current implementation status is PRD-002 (the daemon).** The process,
  lifecycle, lock, `/health`, worker harness, and CLI shell are implemented. The
  Deep Lake data layer (PRD-005), file-registration/re-association (PRD-006),
  brooding (PRD-007), Portkey/model routing (PRD-010), the portable projection
  (PRD-011), recall integration (PRD-013), embeddings provider switch (PRD-014),
  and the enricher steady-state loop (PRD-016) are the next tranches; CLI verbs
  that invoke not-yet-built mechanics exit with a clear "owned by PRD-NNN" notice
  rather than a silent stub.
- **Zero runtime dependencies by design.** The daemon uses only Node built-ins
  (`node:http`, `node:fs`, `node:net`, `node:os`), mirroring the sibling
  **doctor** repo's minimal-footprint ethos. `typescript` and `@types/node`
  are the only devDependencies. When a later PRD needs the shared Deep Lake
  client, Portkey transport, or embeddings daemon, Nectar reaches them over
  the network through its own clients (never by importing the honeycomb runtime
  in-process, per ADR-0002).
- The documents frequently reference **"the main Honeycomb corpus"** and rules
  like **FR-8** ("durable state goes in Deep Lake, not sidecars") and the AGPL
  license-header convention. These come from the sibling **Honeycomb daemon**
  repository, whose patterns Nectar reuses (daemon lifecycle, Deep Lake
  client, auth, observability, hybrid recall, the CodeGraph worker) by mirroring,
  not importing, across the process boundary.

## Repository layout

```
src/                             the daemon implementation (TypeScript, ESM)
  index.ts                       public exports (assembleDaemon, config, lock, health, worker)
  cli.ts                         CLI entry: `nectar daemon` (bin target)
  daemon.ts                      composition root: assembleDaemon() -> start/shutdown/pipelineStatus
  server.ts                      node:http /health server (127.0.0.1:3854)
  lock.ts                        single-instance PID/lock guard (acquire/release/isPidAlive)
  worker.ts                      hiveantennae worker harness (runOnce/start/stop)
  poll-loop.ts                   adaptive poll loop (injected timer seam, backoff)
  health.ts                      PipelineStatus + purpose-built /health body
  config.ts                      runtime config resolution (env -> defaults)
  errors.ts                      DaemonAlreadyRunningError
test/                            Node built-in test runner suites (*.test.ts)
package.json                     scripts: build (tsc), typecheck, test, start
tsconfig.json                    NodeNext ESM, strict, outDir dist/
library/                         the design + requirements tree (schema v2)
  knowledge/
    public/                      end-user / customer-facing docs
    private/                     internal engineering docs (ADRs, standards, domain)
      overview.md                what Nectar is and the reading guide
      architecture/              ADRs (ADR-0001 identity, ADR-0002/0003/0004 topology)
      ai/                        brooding, enricher, identity & re-association
      data/                      hive-graph schema, portable registry, recall integration
      reference/                 prior-art crosswalk
      standards/                 documentation-framework.md — the canonical doc standard
  requirements/                  product work: PRDs (backlog/in-work/completed) + ledger
  issues/                        reactive bug/incident work: IRDs
  notes/                         HUMAN-ONLY scratch space — agents do not write here
nectar.png, nectar.psd           brand asset
```

Build and verify: `npm install` then `npm run build` (tsc to `dist/`),
`npm run typecheck`, `npm test` (Node's built-in runner). Run the daemon with
`npm start` or `node dist/cli.js daemon`.

The design contract lives under `library/`. Start at
`library/knowledge/private/overview.md` (the three design pillars) and
`library/requirements/` (the PRDs the code implements). Code and docs evolve
together: the docs are the spec the implementation conforms to.

## Editing rules (documentation conventions)

The canonical standard is
`library/knowledge/private/standards/documentation-framework.md`. **Every
document must conform to it.** Key rules an agent will otherwise miss:

- **Universal header.** Every knowledge doc starts with a `# Title`, then a
  blockquote line:
  `> Category: <Type> | Version: <X.Y> | Date: <Month YYYY> | Status: <Active | Draft | Archived | Canonical>`
  followed by a one-sentence summary and a `**Related:**` link list. Version
  starts at `1.0`; bump minor for additions, major for reorganizations.
- **Status values:** `Active`, `Draft`, `Archived`, plus `Canonical` for
  standards docs only. Most docs in this repo are currently `Draft`.
- **Cross-link with relative paths** (`[title](../relative/path.md)`), never
  duplicated prose. Link to code in other repos as `` `src/path/to/file.ts:42` ``
  with a file-path backtick span.
- **Diagrams use Mermaid** (`flowchart TD` or `sequenceDiagram`). No explicit
  colors (breaks dark mode), no `click` events, no spaces in node IDs.
- **No time-sensitive language** ("currently", "recently", "as of"). Use
  explicit dates.
- **One topic per document**; split if a doc exceeds ~500 lines.
- **Ground every claim.** Quote source with file path + line range; never
  paraphrase signatures. (When the source lives in the sibling Honeycomb repo,
  cite the path as it appears there.)

### Filename / folder conventions

- Feature PRD: `library/requirements/features/feature-<###>-<title>/prd-feature-<###>-<title>.md`
  with a sibling `reports/` folder. `<###>` is 3-digit zero-padded, repo-local
  sequential (take `max + 1` across open + `completed/`).
- Issue IRD: `library/issues/<lifecycle>/issue-<###>-<title>/ird-issue-<###>-<title>.md`.
  **IRD numbers match the GitHub issue number** — a GitHub issue must exist
  first; never invent one. IRDs are single-scope (one issue per IRD, no sub-IRDs).
- Move the entire folder (plan + `reports/`) to `completed/` when the work ships
  or the issue closes. Never edit lifecycle state in frontmatter alone.
- Knowledge docs: `<domain>/<kebab-slug>.md` (no numeric prefix).

## Load-bearing design decisions (do not contradict)

Before changing anything in `architecture/`, `ai/`, or `data/`, read the
relevant docs — these decisions are deliberate and were chosen over documented
alternatives:

1. **Identity is a daemon-minted ULID, never embedded in source.** This is
   **ADR-0001** and is the least reversible decision in the design. The
   rejected alternatives — source-embedded serial (collides with the AGPL
   header, breaks on copy-paste, no comment syntax for JSON/.env/binaries) and
   content-hash-as-identity (churns per edit) — are documented there. Do not
   re-litigate without reading the ADR and `reference/prior-art-crosswalk.md`.
2. **Deep Lake is the only durable store (FR-8).** No SQLite sidecars, no
   JSONL logs. `.honeycomb/nectars.json` is a *regenerable projection*
   (like a lockfile), not a sidecar — it is derived from Deep Lake and must
   remain regenerable byte-for-byte (modulo timestamps).
3. **Gemini 2.5 Flash via Portkey is the canonical description model.** Long
   context (1M tokens) is the load-bearing property that enables batching
   30–50 small files per call. The model is configurable, not hardcoded, but
   the choice is defended in `ai/enricher-and-llm-model.md`.
4. **Two Deep Lake tables, not one.** `hive_graph` (identity, keyed by ULID)
   + append-only `hive_graph_versions` (content + description, keyed by
   `(nectar, content_hash)`). Never collapse them; the split is what makes
   identity stable across edits.
5. **Structural (CodeGraph) and semantic (Nectar) layers are independent
   and complementary.** Both ship. Do not frame Nectar as replacing the
   CodeGraph or as an LSP.

## SQLite / SQL guard note

When the SQL schema in `data/hive-graph-schema.md` or the recall arm in
`data/recall-integration.md` is touched, recall that the implementation lives
in the Honeycomb daemon and must use that repo's SQL string-guarding helpers
(`sqlStr`, `sqlLike`) and `withHeal` for additive schema changes —
never hand-roll an `ALTER` against these tables.
