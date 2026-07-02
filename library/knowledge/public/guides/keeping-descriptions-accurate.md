# Keeping Descriptions Accurate

> Category: Guide | Version: 1.0 | Date: June 2026 | Status: Draft

Explains how Nectar keeps every file's description current as you edit, rename, move, and copy-paste — without re-describing on every keystroke, and without losing track of a file when it moves.

**Related:**
- [`getting-started-with-nectar.md`](getting-started-with-nectar.md)
- [`sharing-understanding-with-your-team.md`](sharing-understanding-with-your-team.md)

---

## The promise

After the [first scan](getting-started-with-nectar.md), your project has a description for every file. But code is not static. You edit files, rename them, move them between folders, copy blocks from one place to another, and delete things. If the descriptions stayed frozen at their first-scan wording, they would drift out of sync with reality within a day.

Nectar's job in steady state is to keep descriptions accurate **without hovering over your shoulder**. It does this with four behaviors, each tuned to a specific kind of change. The guiding principle throughout: only re-describe when something has *meaningfully* changed, so cost stays low and your descriptions stay trustworthy.

---

## Edits — descriptions update after a pause, not on every keystroke

When you save a file, Nectar notices. But it does not rush to re-describe it the instant you press save — and it certainly does not re-describe on every keystroke. That would be wasteful, jumpy, and expensive.

Instead, it waits through a short pause. If you save the same file several times in quick succession (as you almost always do while working), those saves collapse into a single "this file changed" signal. Only after you have stopped editing for a moment does Nectar take a closer look.

Even then, it does not always re-describe. Before spending anything, it asks a simple question: **did the meaning of this file actually change?** It compares the new version of the file to the old one. If the change is purely cosmetic — reformatting, whitespace, a touched-up comment — it quietly keeps the existing description. No AI call is made, no money is spent, and the description does not churn.

Only when the change crosses a meaningful threshold does Nectar write a fresh description. The result is that routine editing costs essentially nothing, and descriptions only change when they genuinely need to.

---

## Renames and moves — the description follows the file

A common worry with any tool that tracks files is: *what happens when I move or rename a file?* Many tools lose track, because they identify a file by its path or name — change the path, and as far as they know, it is a brand-new file.

Nectar does not work that way. It gives each file a stable identity that is **independent of its name or location**. When you rename a file or move it to a different folder, Nectar recognizes that it is the same file in a new place. The description travels with it.

In practice this means:

- **Rename `login.ts` to `auth-handler.ts`** — the description stays attached. You do not lose the understanding Nectar built, and you do not pay to re-build it.
- **Move `utils.ts` from `src/` to `src/lib/legacy/`** — same thing. The file is tracked across the move, description intact.
- **Reorganize a whole directory** — every file you shuffle keeps its description, because each one is tracked by identity, not by where it happens to sit.

This is one of the most important properties of Nectar: **refactoring does not reset understanding.** You are free to rename and reorganize as much as you like.

---

## Copy-paste — the copy remembers where it came from

When you copy a file (or copy a chunk of code into a new file), something interesting happens. The new file is genuinely a new thing — it deserves its own identity and, eventually, its own description. But it is also *derived* from something that already exists, and that relationship is worth remembering.

Nectar handles this by giving the copy a fresh identity **and a link back to the original**. The copy keeps a pointer that says "I came from here." This is useful in two ways:

- **Seeing where code came from.** When you are reading a file that started life as a copy, the link lets you trace it back to its source. This is handy for understanding why a file looks the way it does, or for finding the canonical version of something that has been duplicated.
- **Inheriting a head start.** The copy can carry over the original's description as a starting point, rather than being described from a blank slate. As the copy evolves and diverges, its description updates to reflect what it has become.

So copy-paste is not a confused event (two files claiming to be the same thing) and not a lost event (the relationship forgotten). It is a tracked, recoverable event — the copy stands on its own, but never forgets its origin.

---

## What to do if a description seems wrong

Descriptions are written by an AI model, and no model is perfect. Occasionally you will see a description that is vague, slightly off, or just unhelpful. This is expected, and there is a straightforward way to deal with it.

Most of the time, **the problem fixes itself.** The next time you meaningfully edit that file, Nectar re-describes it from scratch, and the fresh description is often clearer than the original. Patience is a valid strategy.

When a description seems consistently wrong — especially right after the first scan, or for a file whose purpose is genuinely ambiguous — you can ask Nectar to take a second look. The command for low-confidence or suspicious cases is:

```bash
honeycomb nectar review-matches
```

This surfaces the files Nectar was least sure about — the ones where its tracking or description confidence was low — so you can see what it decided and, where needed, prompt it to reconsider. It is the right tool when something feels off and you want to nudge the system rather than wait for the next natural re-description.

For the vast majority of files, you will never need this. But it is there for the cases where a description is misleading enough to send your AI agent down the wrong path.

---

## Why the cost stays low

It is worth restating the reassurance, because "AI describes your files" can sound expensive. The first scan is the only time Nectar describes everything at once, and even that is a small one-time cost (see the [getting started guide](getting-started-with-nectar.md)).

After that, Nectar re-describes a file only when **all** of these are true:

1. The file was meaningfully edited (not just reformatted).
2. The editing settled down past the pause window (not on every save).
3. The change crossed the threshold where the old description no longer fits.

On a typical workday, that filters down to a handful of files at most — often zero. Cosmetic changes, rapid-fire saves, and untouched files all cost nothing. The steady-state bill for keeping descriptions accurate is a small fraction of the one-time first-scan cost, and for many projects it rounds to zero.

---

## Recap

- **Edits** update a description only after a pause and only when the change is meaningful — cosmetic changes and rapid saves cost nothing.
- **Renames and moves** never lose the description, because files are tracked by stable identity, not by name or path.
- **Copy-paste** gives the copy its own identity plus a link back to the original, so you can trace where code came from.
- **Wrong descriptions** usually self-correct on the next meaningful edit; for stubborn low-confidence cases, use `honeycomb nectar review-matches`.
- **Cost stays low** because re-description is rare and selective, not constant.

The result is a project whose descriptions stay accurate as it evolves — quietly, cheaply, and without you having to think about it.
