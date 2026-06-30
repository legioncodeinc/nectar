# AGENTS.md — Hivenectar

Guidance for ZCode agents working in this repository. Read this before editing.

## What this repository is

Hivenectar is a **design and specification repository**. It documents — but does
not yet implement — a semantic memory layer that gives every file in a project a
stable identity (a "nectar": a daemon-minted ULID) and an LLM-minted title +
description, then serves both back through hybrid semantic/lexical recall so an
agent can answer "where is the login logic" rather than only "find symbol X".

- **As of this writing the repo holds design docs only — no source code, build,
  typecheck, lint, or test step yet.** The documents here are the *specification*
  for an implementation that does not exist in this repo yet. When you arrive and
  find code, `package.json` scripts, a `Makefile`, or CI workflows, treat this
  paragraph as stale and update it: the design docs become the source of truth
  the implementation must conform to, not the other way around.
- The documents frequently reference **"the main Honeycomb corpus"** and rules
  like **FR-8** ("durable state goes in Deep Lake, not sidecars") and the AGPL
  license-header convention. These come from the sibling **Honeycomb daemon**
  repository, whose patterns Hivenectar is designed to reuse (daemon lifecycle,
  Deep Lake client, auth, observability, hybrid recall, the CodeGraph worker).
  Cite them as design context for the coming implementation.
- The library schema itself is defined externally in
  `legion-shared/standards/library-schema-v2.md` (another sibling repo) and is
  scaffolded by `pnpm standardize-library --repository <name>`, which is **not**
  runnable here yet.

## Repository layout

```
library/                         the only meaningful tree (schema v2)
  knowledge/
    public/                      end-user / customer-facing docs
    private/                     internal engineering docs (ADRs, standards, domain)
      overview.md                START HERE — what Hivenectar is and the reading guide
      architecture/              ADRs (ADR-0001 is the load-bearing identity decision)
      ai/                        brooding, enricher, identity & re-association
      data/                      source-graph schema, portable registry, recall integration
      reference/                 prior-art crosswalk
      standards/                 documentation-framework.md — the canonical doc standard
  requirements/                  planned product work: PRDs (backlog/in-work/completed)
  issues/                        reactive bug/incident work: IRDs (backlog/in-work/completed)
  notes/                         HUMAN-ONLY scratch space — agents do not write here
nectar.png, nectar.psd           brand asset (note: library/README says brand assets
                                 normally live in legion-shared/brands/)
```

The single most important file is
`library/knowledge/private/overview.md` — it defines the three design pillars
and contains a reading guide. Read it first.

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
4. **Two Deep Lake tables, not one.** `source_graph` (identity, keyed by ULID)
   + append-only `source_graph_versions` (content + description, keyed by
   `(nectar, content_hash)`). Never collapse them; the split is what makes
   identity stable across edits.
5. **Structural (CodeGraph) and semantic (Hivenectar) layers are independent
   and complementary.** Both ship. Do not frame Hivenectar as replacing the
   CodeGraph or as an LSP.

## SQLite / SQL guard note

When the SQL schema in `data/source-graph-schema.md` or the recall arm in
`data/recall-integration.md` is touched, recall that the implementation lives
in the Honeycomb daemon and must use that repo's SQL string-guarding helpers
(`sqlStr`, `sqlLike`, `sqlIdent`) and `withHeal` for additive schema changes —
never hand-roll an `ALTER` against these tables.
