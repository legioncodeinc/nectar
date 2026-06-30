---
ai_description: |
  This folder contains internal engineering and business documentation.
  ADRs MUST live in architecture/ADR-<n>-<kebab-slug>.md.
  Engineering standards MUST live in standards/documentation-framework.md.
  Other domain folders (<domain>/) are repo-specific and may be created as
  needed (ai/, auth/, data/, frontend/, infrastructure/, integrations/,
  marketing/, operations/, personas/, reporting/, roadmap/, scanners/,
  security/, strategy/, etc.).
  Do NOT file customer-facing content here (that goes in knowledge/public/).
  Write path: library/knowledge/private/<domain>/<kebab-slug>.md.
human_description: |
  Internal engineering and business documentation.
  - architecture/: Architecture Decision Records (ADRs)
  - standards/: Documentation framework and coding standards
  - <domain>/: Any repo-specific knowledge domain (ai/, auth/, data/, etc.)
  Default landing zone for any doc that does not need to be customer-facing.
  When creating a new domain folder, add a README.md explaining what belongs.
---

# Knowledge — Private

Internal documentation for engineers, product, and AI agents.

## Required sub-folders (always present)

| Folder | Contents |
|---|---|
| `architecture/` | ADRs: `ADR-<n>-<kebab-slug>.md`. Locked decisions with context, alternatives, consequences. |
| `standards/` | `documentation-framework.md` and any repo-specific writing rules. |

## Optional domain folders

Create any of these as needed: `ai/`, `auth/`, `data/`, `frontend/`, `infrastructure/`, `integrations/`, `marketing/`, `operations/`, `personas/`, `reporting/`, `roadmap/`, `scanners/`, `security/`, `strategy/`, `reference/`, `<product>-ux-ui/`.

## What does NOT belong here

- Customer-facing content (put in `knowledge/public/`)
- PRDs or IRDs (put in `requirements/` or `issues/`)
- Brand assets (put in `legion-shared/brands/`)

## Domain map

This repo's domain folders and their contents (9 core documents, each expanded into a five-document deep-dive):

| Folder | Core documents | Deep-dive sub-folder |
|---|---|---|
| `overview/` | (root) `overview.md` | `overview/` — 5 expanded docs |
| `architecture/` | `ADR-0001-minted-nectar-over-source-embedded-serial.md` | `architecture/identity-model/` — 5 expanded docs |
| `ai/` | `identity-and-reassociation.md`, `brooding-pipeline.md`, `enricher-and-llm-model.md` | `ai/identity-deep-dive/`, `ai/brooding-deep-dive/`, `ai/enricher-deep-dive/` — 5 each |
| `data/` | `source-graph-schema.md`, `portable-registry.md`, `recall-integration.md` | `data/source-graph-deep-dive/`, `data/portable-registry-deep-dive/`, `data/recall-integration-deep-dive/` — 5 each |
| `reference/` | `prior-art-crosswalk.md` | `reference/prior-art-deep-dive/` — 5 expanded docs |
| `standards/` | `documentation-framework.md` | (canonical standard; not expanded) |

Each deep-dive folder contains: `*-user-stories.md` (engineering/operator scope), `*-technical-specification.md`, `*-introduction-and-theory.md`, `*-ecosystem-story-arc.md`, `*-conclusion-and-deliverables.md`. Customer-facing translations live in `../public/`.
