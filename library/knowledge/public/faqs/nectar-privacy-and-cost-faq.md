# Nectar Privacy and Cost FAQ

> Category: FAQ | Version: 1.0 | Date: June 2026 | Status: Draft

The trust questions: where your code goes, what it costs, how often it runs, and what happens if you stop using it.

**Related:**
- [`nectar-basics-faq.md`](nectar-basics-faq.md)
- [`nectar-comparison-faq.md`](nectar-comparison-faq.md)
- [`../README.md`](../README.md)
- [`../overview/what-is-nectar.md`](../overview/what-is-nectar.md)
- [`../guides/`](../guides/)

---

## Q: Does my code leave my machine?

When Nectar writes a plain-language description for a file, that description is produced by an AI language model. To produce it, the relevant file contents are sent to the model so it can read them. The important detail is **how** they are sent: the system routes through a gateway that you configure yourself, using the same connection the rest of the tool already trusts.

Here is what happens, in plain terms. Nectar runs as a background service on your machine. It reads your files locally. When a file needs describing, it sends only that file's contents — through your own configured gateway — to the model, receives a short description back, and stores the result. It does not upload your entire project in one go, and it does not send files to an unknown or hard-coded destination.

A few practical points:

- **Identity is local.** The stable identity assigned to each file is created on your machine and stored locally. It never needs to leave.
- **Descriptions are generated, not your code.** What comes back from the model is a one-to-three sentence summary of what the file is for. Your raw source is not kept on the other end.
- **You control the route.** Because requests go through your configured gateway, the same policies, keys, and privacy controls you already trust apply here too.

If your organization requires that no source leave the network at all, that is a gateway-configuration question. Nectar's design makes the routing explicit and yours to control, rather than hiding a fixed endpoint inside the tool.

---

## Q: What does the first scan cost?

The first scan — the one-time process that builds the shared map for a project — uses a fast, low-cost AI model to produce the descriptions, and the cost scales with the number of files. It is a **one-time cost per project**, not a recurring fee.

For a typical project of about 2,000 files, the first scan lands around **$3**. The cost scales predictably with size: a small 200-file service runs about $0.30, and a large 10,000-file codebase around $15. Smaller files are described efficiently several dozen at a time, which keeps the price low; only genuinely large files cost more, one at a time.

Before you spend anything, you can run the first scan in **dry-run mode**. This shows you exactly how many files will be described, how they will be grouped, and the estimated dollar cost — without making any calls. It is the recommended first step on any new project, so there are no surprises.

---

## Q: Subsequent clones of the same project are free — how?

Yes. Once the shared map has been built for a project, it can be committed to your repository — much like a lockfile. When a teammate clones the project, their copy already contains the map, so their Nectar recognizes every file and inherits its description without doing a new scan.

Here is why that works. Nectar records a fingerprint of each file's contents. When a fresh clone is opened, the tool checks each file's fingerprint against the committed map. A match means *"this is the same file someone already described"* — so it simply adopts the existing identity and description. No AI model is called, and no scanning cost is incurred.

The practical effect: one person (or one automated run) pays the one-time cost to build the map; everyone else on the team gets it for free, instantly, the moment they clone. And because the map is just a committed file, this works even with no network connection at all.

---

## Q: Does it re-scan on every edit?

No. Re-describing the whole project on every save would be wasteful and slow. Instead, Nectar only re-describes a file when its contents have **meaningfully changed**, and it waits for a natural pause in editing before doing anything.

Two behaviors make this efficient:

- **Identity survives edits.** A file's identity is not derived from its contents, so editing a file does not break the link to its history. The existing description stays attached; only the description itself may need a refresh.
- **Updates are debounced and targeted.** If you are in the middle of a rapid edit session, Nectar waits for you to stop, then refreshes only the files that actually changed — not the entire project. One burst of editing produces one small update, not a flurry of one per keystroke.

The result is that day-to-day cost is minimal: pennies for the occasional file that genuinely changed, and nothing at all for files that did not.

---

## Q: What happens to the descriptions if I stop using Nectar?

Nothing is lost. The descriptions and identities live in a shared map that is stored as part of your project, separate from your source code. If you stop using Nectar, that map simply sits there — it does not vanish, and it does not damage your code.

Because the map is a committed, reviewable file in your repository, it is also portable and durable. It does not depend on a running service or a continued subscription to exist. You can walk away from the tool today and the map is still there tomorrow, intact, for anyone who wants it.

If you ever come back, or a teammate picks it up later, the map is ready and waiting. And because your source files were never modified, removing Nectar leaves your code exactly as it was — there is nothing to clean up, no embedded markers to strip out, no leftover edits to undo.

---

## Q: Does it work offline?

Yes. Because the shared map can be committed to your repository, a clone of the project works without any network connection at all.

When the map is present, Nectar can recognize every file and serve its description purely from what is already on disk — no calls home, no cloud lookup. This makes the project fully usable for reading, searching, and recall even on a plane, behind a strict firewall, or during an outage.

The one thing that does require a connection is **producing new descriptions** — for a file nobody has described yet. That step calls an AI model through your gateway, so it needs network access. But once a description exists and is saved to the map, it is available offline forever. For an already-described project, offline use is the norm, not a special case.
