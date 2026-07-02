# Sharing Understanding With Your Team

> Category: Guide | Version: 1.0 | Date: June 2026 | Status: Draft

Explains what happens when you commit Nectar's shared map to version control: a teammate who clones the repo gets the same file descriptions instantly, for free, with no re-scan — and everyone searches the same semantic index.

**Related:**
- [`getting-started-with-nectar.md`](getting-started-with-nectar.md)
- [`keeping-descriptions-accurate.md`](keeping-descriptions-accurate.md)

---

## The idea in one sentence

The first person to run Nectar on a project pays a small, one-time cost to describe every file. After that, those descriptions live in a small shared file at the project root, and **every teammate who clones the repo inherits them for free**.

No re-scan. No new cost. No waiting. The moment your teammate's copy of Nectar starts up, it recognizes the shared map, matches it against the files on disk, and the project's understanding is live — identical to yours.

---

## Why committing the shared map matters

After the [first scan](getting-started-with-nectar.md), Nectar writes a small file at the root of your project: `.honeycomb/nectars.json`. You can think of it as **a shared map of your codebase** — one entry per file, each carrying a short title and description of what that file does.

This file is meant to be committed, just like `package-lock.json` or any other project artifact your team relies on. Here is why that matters:

- **It is the bridge between "I scanned this" and "we all benefit."** The first scan's results do not help anyone else until the shared map reaches them. Committing it is what turns a single developer's investment into a team asset.
- **It makes descriptions a reviewable artifact.** When a teammate opens a pull request, they can see not only the code you changed but also the description Nectar wrote for any new file — and sanity-check that it reads reasonably. The shared map is human-readable, not an opaque database blob.
- **It works offline.** A teammate on a fresh clone gets the full set of descriptions without any network call, login, or cloud sync. Everything needed is already in the repo.

---

## The team-share journey, step by step

### Step 1 — Commit the shared map

After your first scan finishes, add the shared map to version control:

```bash
git add .honeycomb/nectars.json
git commit -m "Add Nectar shared map"
```

From this point on, the shared map travels with your repository like any other file. You do not need to think about it again — Nectar updates it automatically as descriptions change (see the [freshness guide](keeping-descriptions-accurate.md) for how that stays low-churn).

### Step 2 — A teammate clones the repo

When a teammate runs `git clone`, they get your source files **and** the shared map, in one step. Nothing special is required on their end — a normal clone is enough.

### Step 3 — Their Nectar recognizes the existing descriptions

The first time your teammate's copy of Nectar starts up in the cloned project, it notices the shared map and does something efficient: it matches every file on disk against the map's records. For each match, it inherits that file's description directly. No new descriptions are written. No AI calls are made.

A current shared map typically produces **zero re-scan work and zero cost** on a fresh clone. Every file's content lines up with a record in the map, so every description carries over. The person who first scanned the project paid the bill; the clone pays nothing.

### Step 4 — Everyone searches the same semantic index

Once inheritance finishes, your teammate's project is in the same state yours was right after the first scan. They can immediately ask their AI agent "where is the login logic?" and get the same right answers you do. There is one shared understanding of the codebase, and you are all working from it.

---

## What happens when descriptions differ

Two teammates may describe the same file differently over time — for example, you edit a file in your branch while a teammate edits a different file in theirs, and both of you commit an updated shared map. This is normal, and Nectar handles it without drama.

When those changes meet (on a merge or a pull), the system **reconciles** them. Each file is tracked independently, so two teammates updating two different files simply produce two independent updates in the shared map — no conflict, because they touch different entries. Even when two people change the *same* file, the resolution is straightforward: each file's description is tied to that file's current content, so the version that matches the file as it exists after the merge is the one that wins. The shared map reflects the merged state of the code, not a separate battle over wording.

The practical effect: merges stay clean, and the shared map always describes the code as it actually is.

---

## What happens on a branch switch

Switching branches can suddenly show or hide a batch of files — a feature branch might add new files, and switching back to `main` removes them again. You might worry that every branch switch throws away understanding and forces a re-scan.

It does not. Nectar gives deleted-or-switched-away files a **grace period**. When a file disappears from disk because you switched branches, its entry in the shared map is kept around for a while rather than dropped immediately. Switch back, and the file returns with its description intact — no re-scan, no cost.

Only after the grace period passes (and the file is still genuinely gone) is the entry cleaned up. This means hopping between branches as part of your normal workflow costs nothing. The understanding you built is sticky.

---

## What happens if the shared map is out of date

Sometimes a teammate clones a repo whose shared map is a few commits behind the files on disk — maybe someone added files but forgot to commit the updated map, or the map is simply old. Nectar handles this gracefully too.

For every file whose content lines up with a record in the map, the description is inherited as usual — free and instant. For files that do **not** line up (new files, or files that changed since the map was last updated), Nectar falls back to its normal tracking: it figures out the best match for each one, mints a fresh record where there is no match, and describes only those unmatched files. The bill in this case is limited to the gap — the files the map did not already cover — not a full re-scan.

So a stale shared map is never a disaster. It just means the teammate pays to describe whatever is new or changed since the map was last refreshed.

---

## A note on choosing not to commit

Some teams prefer not to commit the shared map — perhaps to avoid any extra diff noise in pull requests, or because each developer wants an independent scan. Nectar supports this: if you add `.honeycomb/nectars.json` to your ignore file, Nectar still writes it locally for your own use, but it is not shared.

The tradeoff is simple and worth understanding. Without the shared map in the repo:

- **Every clone pays for its own first scan.** Each teammate re-describes every file from scratch, including the cost.
- **Descriptions may drift between teammates.** Without a shared source, each person's copy can describe the same file with slightly different wording.
- **The team-share story stops working.** No inheritance on clone, no shared semantic index.

The recommendation is to commit it. The diff noise is small (one entry per changed file, written at most once per editing session), and the payoff — instant, free, identical understanding for every teammate — is large.

---

## Recap

- Commit `.honeycomb/nectars.json`. It is the bridge that turns one person's scan into the whole team's asset.
- A fresh clone inherits every description for free, with zero re-scan cost, and works offline.
- Everyone searches the same semantic index, so "where is the login logic?" returns the same right answers across the team.
- Merges reconcile cleanly because each file is tracked independently.
- Branch switches are free thanks to a grace period before any cleanup.
- A stale map is not a disaster — only the gap gets re-described.

That is the entire team-share model: understand once, share everywhere.
