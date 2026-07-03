# What is Nectar?

> Category: Overview | Version: 1.2 | Date: July 2026 | Status: Active

A 60-second introduction for anyone new to Nectar — what it is, the problem it solves, how it works in plain terms, and what it is not.

**Related:**
- [`how-nectar-helps-your-agent.md`](how-nectar-helps-your-agent.md)
- [`nectar-glossary.md`](nectar-glossary.md)
- [`../README.md`](../README.md)

---

## The one-sentence answer

Nectar is a memory layer that helps your AI coding assistant understand your codebase by meaning, not just by file names.

If you ask your agent "where do we handle logins?" it should hand you the right files — even if none of them are named `login.ts`. That is the job Nectar does.

---

## The problem it solves

Modern AI coding tools are good at reading code, but they struggle with one basic task: *finding* the right code to read.

When you ask your agent a question, it usually starts by searching for files whose names or contents match your words. Ask "where do we handle logins?" and the agent hunts for files called `login.ts`, `auth.ts`, or `authenticate.js`. That works when files are named clearly. It breaks down fast in real codebases, where the login logic often lives in a file called `session-refresh.ts` buried three folders deep — a file no search would ever guess.

The result is the same dead end every time: the agent reads the wrong files, gives you a confident-sounding answer about the wrong thing, and you end up doing the search yourself.

Nectar exists to close that gap. It gives every file a short plain-language description of what that file actually does, so your agent can match on *meaning* instead of matching on *names*.

---

## How it works, in one paragraph

Nectar quietly reads each file in your project and writes down what it does in plain language — something like "refreshes login tokens on each authenticated request." It stores that description alongside the file and remembers it from then on. When your agent later searches for "anything about logins," it searches those descriptions, not just the file names. Because the descriptions are written once and kept up to date, the agent finds the right files even when they are poorly named, hidden in an odd folder, or recently moved. You do nothing differently — you just ask your agent the same questions and get noticeably better answers.

A good analogy: Nectar is like the index at the back of a book, but one that has actually read every chapter. A normal index lists words that appear on the page. Nectar lists *what each chapter is about*, so you can look up a topic and land on the right page even when the chapter title never uses the word you searched for.

---

## What Nectar is

- **A memory layer for your codebase.** It remembers what each file is for, in plain language, and keeps that memory current as files change.
- **A helper for your AI coding assistant.** It sits alongside your existing tools and gives your agent better, more relevant files to work with.
- **Team-ready.** Once one person has built up the understanding, the rest of the team gets it for free when they download the project.

---

## What Nectar is NOT

It helps to know the boundaries.

- **It is a memory layer, not a full-text code search engine.** You *can* query it yourself with the `nectar search` command (and the daemon's HTTP endpoint), and the same recall also surfaces automatically through your AI coding assistant via Honeycomb's shared memory, with no search box at all.
- **It is not a replacement for your editor or your AI agent.** It does not write code, and it does not replace the assistant you already use. It makes the assistant you already use smarter about your project.
- **It is not a way to read every line of your code.** Nectar reads enough of each file to describe it accurately. It does not memorize your source code line by line.

---

## What you actually notice

After Nectar has learned your codebase, the change is quiet but real:

- **More relevant file suggestions.** Your agent points you at the file that actually does the work, not just the file that happens to share a name with your question.
- **Fewer dead ends.** The agent stops confidently explaining the wrong file and then having to start over.
- **Less time spent hunting.** You ask the question once, and the answer points at the right place.

The best way to feel the difference is to ask your agent a meaning-shaped question — "where do we handle user authentication?" or "what handles sending emails?" — and notice that the right files come back, regardless of what they are called.

---

## Where to go next

- [`how-nectar-helps-your-agent.md`](how-nectar-helps-your-agent.md) — a before-and-after walkthrough of one real question.
- [`nectar-glossary.md`](nectar-glossary.md) — plain-language definitions of the words you will see.
