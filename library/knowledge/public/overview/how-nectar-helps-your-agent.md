# How Nectar Helps Your Agent

> Category: Overview | Version: 1.0 | Date: June 2026 | Status: Draft

A before-and-after walkthrough of a single real question — what changes for you and your AI coding assistant when Nectar is turned on.

**Related:**
- [`what-is-nectar.md`](what-is-nectar.md)
- [`nectar-glossary.md`](nectar-glossary.md)
- [`../README.md`](../README.md)

---

## The setup

You are working on a project with your AI coding assistant. You did not write most of this code. The folders are not organized the way you would organize them. File names are sometimes clear (`login.ts`) and sometimes not (`session-refresh.ts`, `jwt-helpers.js`).

You want to understand how logins work. So you ask your agent a normal, everyday question:

> *"Where do we handle user authentication?"*

This is the moment where Nectar matters. Here is what happens without it, and what happens with it.

---

## Before Nectar: the agent guesses by name

Without Nectar, your agent searches for files the way a person might scan a folder — by looking for names and words that match your question.

Here is what it finds:

- `src/auth/login.ts` — because the name contains "login."
- `src/api/routes/login.ts` — same reason.

Those are good starting points. But the agent misses the file that actually does most of the work:

- `src/middleware/session-refresh.ts` — this file refreshes your login token on every authenticated request. It is a core part of how logins stay working. But nothing in its name says "login" or "auth," so the search never finds it.

The agent gives you a confident answer built on the two files it found. You read them, think you understand logins, and later discover there was a whole layer you never saw. You hit a bug in the token refresh, have no idea where it comes from, and end up searching the codebase yourself.

This is the dead end Nectar is built to prevent. It is not that your agent is lazy or broken — it simply has no way to know what a file *does* unless the file's name happens to give it away.

---

## After Nectar: the agent knows what each file is for

With Nectar, every file in the project already carries a short plain-language description of what it does. The agent searches those descriptions, not just the file names.

So when you ask the same question — *"Where do we handle user authentication?"* — the agent now finds:

- `src/auth/login.ts` — "checks the username and password and starts a new login session."
- `src/middleware/session-refresh.ts` — "refreshes login tokens on each authenticated request; part of the login session lifecycle."
- `src/lib/jwt.ts` — "creates and checks login tokens; used by login and session-refresh."
- `src/api/routes/logout.ts` — "ends a login session and clears the refresh token."

Notice what happened: the agent found the files that *participate in* logins, not just the files *named for* logins. The critical `session-refresh.ts` file — invisible to a name search — came back because its description matches the meaning of your question.

The difference is not a nicer list. The difference is that you now actually understand how logins work, because the agent handed you the whole system instead of just the obviously-named part of it.

---

## The before-and-after at a glance

| | Without Nectar | With Nectar |
|---|---|---|
| How the agent searches | By file name and exact words | By what each file actually does |
| What it finds | Files whose names match your question | Files whose *purpose* matches your question |
| Files it misses | Anything not obviously named (like `session-refresh.ts`) | Almost nothing relevant |
| Your experience | Partial answers, dead ends, manual hunting | Complete answers on the first try |

---

## Why the descriptions survive everyday chaos

Codebases do not stand still. You rename files, move them between folders, copy them to start a new feature, and edit them constantly. A memory layer that forgets everything every time a file moves would be useless.

Nectar is built so that its understanding survives all of this:

- **If you rename a file**, Nectar still knows what it does. The description follows the file, not the name.
- **If you move a file to a new folder**, the description comes along. Reorganizing your project does not wipe the slate clean.
- **If you copy a file to start something new**, the copy keeps a link to the original — so Nectar understands the new file is related, without confusing it for the old one.
- **If you edit a file**, Nectar notices the change and updates the description when it matters.

In plain terms: **the system remembers what each file is for, even if you completely reorganize your folders.** You never lose the built-up understanding, and you never have to teach it again.

---

## What this means for you, day to day

The value is not in any single search. It is in the accumulation:

- **You trust your agent more.** When it points you somewhere, that somewhere is usually right.
- **You onboard faster.** On a project you have never seen, meaning-based answers get you oriented in minutes instead of hours.
- **You stop fighting your file structure.** Whether the codebase is tidy or a mess, the agent can still find what matters.
- **Your whole team benefits.** Once one person's project has the descriptions, everyone who downloads it gets the same understanding — no setup required.

---

## The takeaway

Nectar does not change how you ask questions. It changes whether the answers are worth trusting.

The next time you ask your agent "where do we handle ___?" — fill in the blank with anything: payments, emails, logins, reporting — the difference is whether the agent hands you the obviously-named file, or the set of files that actually does the work. Nectar is what makes the second outcome the normal one.

---

## Where to go next

- [`what-is-nectar.md`](what-is-nectar.md) — the 60-second overview, if you have not read it.
- [`nectar-glossary.md`](nectar-glossary.md) — the words you will see, defined in plain language.
