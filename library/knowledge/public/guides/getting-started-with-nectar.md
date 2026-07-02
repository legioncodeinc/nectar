# Getting Started With Nectar

> Category: Guide | Version: 1.0 | Date: June 2026 | Status: Draft

Walks you through your project's very first scan — what Nectar does on first run, what it costs, and how to know it worked — so you can start asking your AI agent "where is the login logic?" and get the right files back.

**Related:**
- [`keeping-descriptions-accurate.md`](keeping-descriptions-accurate.md)
- [`sharing-understanding-with-your-team.md`](sharing-understanding-with-your-team.md)

---

## What happens on your first run

The first time Nectar meets your project, it does not know anything yet. Every file is just a name on disk. To turn that pile of names into something your AI agent can reason about, Nectar reads through your files and writes a short, plain-language description for each one. We call this first pass **the first scan** — internally it is called "brooding," but what it amounts to is: read your files, understand them, and write down what each one is for.

Once the first scan finishes, your AI agent can answer questions in a new way. Instead of only finding files whose names match a search word, it understands what each file *does*. Ask "where is the login logic?" and it can return a file like `src/middleware/session-refresh.ts` — even though that file has no "login" in its name — because Nectar described it as part of the login session lifecycle.

The understanding Nectar builds is saved as a small shared file at the root of your project: `.honeycomb/nectars.json`. Think of it as a shared map of your codebase. You do not need to open it or edit it. Nectar maintains it for you, and you commit it to your repo just like any other project file. (For what that shared map makes possible across your team, see the [team-share guide](sharing-understanding-with-your-team.md).)

---

## Before you run it: preview the cost

The first scan uses an AI model to describe your files, so it carries a small one-time cost. The good news is that cost is predictable, small, and paid only once for the whole project.

A typical project of 2,000 files costs about **three dollars** total for the first scan. A small service with 200 files runs about thirty cents. A very large codebase of 10,000 files runs around fifteen dollars. These are one-time numbers — you will not pay them again unless you delete the shared map and start fresh.

If you want to know the exact cost for *your* project before spending anything, run the preview:

```bash
honeycomb nectar brood --dry-run
```

This reads your files, counts them, sorts them by size, and prints an estimate of how many descriptions it will write and roughly what they will cost. It does **not** describe anything, does **not** spend money, and does **not** change your project. Use it whenever you want to sanity-check the bill.

---

## Run the first scan

When you are ready, start the first scan:

```bash
honeycomb nectar brood
```

You will see progress as it works through your files. Here is what it is doing behind the scenes, in plain terms:

1. **It discovers your files.** It looks at the same set of files your version control sees — it respects your ignore rules, so it will not waste effort on dependencies, build output, or anything else you have chosen to skip.
2. **It skips files it cannot or should not describe.** Images, fonts, binaries, and unusually large files are noted but not described. They still get tracked, but Nectar does not spend money trying to summarize a PNG.
3. **It groups the rest into efficient batches.** Many small files are described together in a single pass, which is what keeps the cost low. Larger files are described one at a time so each one gets enough attention.
4. **It writes a description for each described file.** Each description is one to three plain-language sentences: what the file does and what it is for, plus a short title and a few topic tags.
5. **It saves the shared map.** Everything is written to `.honeycomb/nectars.json`, the small committed file at your project root.

You can walk away while it runs. If you close your laptop or quit partway through, nothing is lost — the next time it starts, it picks up exactly where it left off. You never pay to redo work that already finished.

---

## What Nectar never does

Two promises worth stating plainly, because they matter for trust:

**It never modifies your source files.** Not a single character of your code, config, or documentation is ever changed. The only file Nectar writes is the shared map (`.honeycomb/nectars.json`), and even that is something it regenerates from scratch — it is not your code, and it is not a secret second copy of your project.

**It does not send your code to the model forever.** The first scan reads each file once to write its description. After that, Nectar only re-reads a file when that file has *meaningfully* changed — and it is smart enough to ignore cosmetic changes like reformatting. Day-to-day, the cost is essentially zero. (See the [freshness guide](keeping-descriptions-accurate.md) for exactly how it decides what to re-describe.)

---

## How to know it worked

The simplest test is to ask your AI agent a "where is" question the old search would get wrong. Try something like:

- "Where is the login logic?"
- "Give me everything related to sending email."
- "What handles retry on failed payments?"

If the agent returns files that do the thing you asked about — regardless of what those files are named — the first scan worked. Semantic understanding is live.

You can also check the shared map directly. After a successful first scan, `.honeycomb/nectars.json` exists at your project root and contains one entry per described file, each with a title and a short description. You never need to read it by hand, but it is there, and it is human-readable if you are curious.

---

## What comes next

- **Keep the shared map committed.** Add `.honeycomb/nectars.json` to version control. This is what lets teammates inherit your project's understanding instantly and for free — see [sharing understanding with your team](sharing-understanding-with-your-team.md).
- **Let it stay fresh on its own.** As you edit, rename, and reorganize, Nectar keeps descriptions current automatically — see [keeping descriptions accurate](keeping-descriptions-accurate.md).
- **Re-run with a cost cap if you like.** `honeycomb nectar brood --limit 100` describes at most 100 files at a time, useful if you added a large batch of new files and want to pace the cost.

That is the entire first-run journey. One scan, a small one-time cost, and your project is ready to answer questions the way a teammate who has been there for years would.
