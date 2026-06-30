---
ai_description: |
  This folder contains customer-facing / end-user documentation.
  Approved sub-folders: overview/, guides/, faqs/, and any domain
  folder explicitly designated public by the team.
  Do NOT file internal engineering docs, ADRs, pricing strategy, or
  security-sensitive material here.
  Write path: library/knowledge/public/<domain>/<kebab-slug>.md.
  All files here may eventually be surfaced in the public help center
  (Phase 2). Mark each doc with the standard knowledge-base header:
  Category / Version / Date / Status.
human_description: |
  Customer-facing documentation. Content here may be published externally.
  - overview/: what this product is, glossary, elevator pitch
  - guides/: how-to guides written for users, not developers
  - faqs/: frequently asked questions
  Only add content here that you are comfortable sharing publicly.
  Internal notes, pricing strategy, and architecture docs belong in
  knowledge/private/ instead.
---

# Knowledge — Public

Customer-facing documentation. Anything in this folder may eventually be published.

## Approved sub-folders

| Folder | Contents |
|---|---|
| `overview/` | What this product is, glossary, elevator pitch, high-level FAQs |
| `guides/` | Step-by-step user guides (written for customers, not developers) |
| `faqs/` | Frequently asked questions from customers |

## Current contents

### `overview/`
- [`what-is-hivenectar.md`](overview/what-is-hivenectar.md) — The 60-second pitch for a new user.
- [`how-hivenectar-helps-your-agent.md`](overview/how-hivenectar-helps-your-agent.md) — The value story as a before/after walkthrough.
- [`hivenectar-glossary.md`](overview/hivenectar-glossary.md) — Plain-language glossary of customer-facing concepts.

### `guides/`
- [`getting-started-with-hivenectar.md`](guides/getting-started-with-hivenectar.md) — The first-run journey, including the `--dry-run` cost-preview tip.
- [`sharing-understanding-with-your-team.md`](guides/sharing-understanding-with-your-team.md) — How committing the shared map gives teammates free inheritance on clone.
- [`keeping-descriptions-accurate.md`](guides/keeping-descriptions-accurate.md) — How descriptions stay current across edits, renames, moves, and copy-paste.

### `faqs/`
- [`hivenectar-basics-faq.md`](faqs/hivenectar-basics-faq.md) — Foundational questions a new user asks.
- [`hivenectar-privacy-and-cost-faq.md`](faqs/hivenectar-privacy-and-cost-faq.md) — Trust questions: does code leave the machine, what does it cost, does it work offline.
- [`hivenectar-comparison-faq.md`](faqs/hivenectar-comparison-faq.md) — How Hivenectar differs from code search, AI indexers, and IDE navigation.

## What does NOT belong here

- Internal architecture docs or ADRs
- Pricing strategy or competitive analysis
- Engineering standards
- Anything you would not want a customer to read
