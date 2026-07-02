# Nectar Glossary

> Category: Overview | Version: 1.0 | Date: June 2026 | Status: Draft

Plain-language definitions of the words you will see when reading about Nectar — each with a short note on why it matters to you.

**Related:**
- [`what-is-nectar.md`](what-is-nectar.md)
- [`how-nectar-helps-your-agent.md`](how-nectar-helps-your-agent.md)
- [`../README.md`](../README.md)

---

## How to use this glossary

These are the customer-facing terms — the words that describe *what Nectar does for you*, not the engineering underneath. Each entry has a one-sentence definition and a one-sentence "why it matters" note. If a word is not here, it is an internal engineering term you do not need to know to use the product.

---

## Memory layer

**What it is:** The overall thing Nectar provides — a stored understanding of what every file in your project is for, kept up to date as your code changes.

**Why it matters to you:** It is the reason your AI coding assistant gets noticeably better at finding the right files. Without it, the assistant searches by name; with it, the assistant searches by meaning.

---

## Nectar

**What it is:** A file's identity record — the small, stable tag Nectar assigns to a single file so it can keep track of that file forever, even if the file is renamed, moved, or edited.

**Why it matters to you:** It is how Nectar remembers a file across all the chaos of normal development. Because each file has a stable identity, its history and description never get lost when you reorganize your project.

---

## Description

**What it is:** A short, plain-language note that says what a file actually does — for example, "refreshes login tokens on each authenticated request."

**Why it matters to you:** This is the heart of how Nectar helps your agent. When you ask a question by meaning ("where do we handle logins?"), the agent searches these descriptions instead of file names, so it finds files that do the work even when their names give nothing away.

---

## Concepts (tags)

**What it is:** Short labels that link related files together across folders — like tagging a file with "authentication" or "email" so files that share a purpose can be found together.

**Why it matters to you:** They let your agent pull together everything tied to a topic in one go, even when those files live in completely different parts of your project and would never be grouped by name alone.

---

## Fresh-clone inheritance

**What it is:** When a teammate downloads (clones) your project, they automatically receive the same file understanding Nectar already built — no setup, no waiting, no cost.

**Why it matters to you:** One person builds up the understanding once, and the whole team gets it instantly. A new teammate can ask the agent "where do we handle logins?" on their first day and get the same complete answer you get.

---

## Team-share

**What it is:** Nectar's understanding belongs to the whole team working in a project, not to any one person's computer — everyone working in the same project sees the same file descriptions.

**Why it matters to you:** You never have to "teach" the same thing twice. Whatever understanding exists for the project is shared, so every teammate's AI assistant is equally informed.

---

## Brooding

**What it is:** Nectar's first read-through of your project, where it reads every file and writes the initial descriptions. It happens once, usually when you first turn Nectar on.

**Why it matters to you:** It is the one-time setup cost. After brooding finishes, the understanding is in place and only needs light updates as files change — you are not paying for a full re-read every time.

---

## Semantic search

**What it is:** Searching by *what something means* rather than by the exact words or file names it contains — matching the intent of your question to the purpose of each file.

**Why it matters to you:** It is the difference between your agent finding `login.ts` (because the name matches) and finding `session-refresh.ts` (because what it *does* matches). Semantic search is what makes the second find possible.

---

## A word about words you will *not* see here

You may come across terms like "embeddings," "vectors," or other engineering jargon in deeper documentation. You do not need any of them to use Nectar. They describe *how the memory layer works under the hood*; this glossary describes *what it does for you*. If a concept is not in this list, it is internal detail, not something you need to act on.

---

## Where to go next

- [`what-is-nectar.md`](what-is-nectar.md) — start here if you are new.
- [`how-nectar-helps-your-agent.md`](how-nectar-helps-your-agent.md) — see the value in a real before-and-after example.
