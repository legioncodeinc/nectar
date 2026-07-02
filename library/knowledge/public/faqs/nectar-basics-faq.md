# Nectar Basics FAQ

> Category: FAQ | Version: 1.0 | Date: June 2026 | Status: Draft

The foundational questions a new user asks: what Nectar is, whether it changes how you work, and what it does (and does not) touch in your project.

**Related:**
- [`nectar-privacy-and-cost-faq.md`](nectar-privacy-and-cost-faq.md)
- [`nectar-comparison-faq.md`](nectar-comparison-faq.md)
- [`../README.md`](../README.md)
- [`../overview/what-is-nectar.md`](../overview/what-is-nectar.md)
- [`../guides/`](../guides/)

---

## Q: What is Nectar?

Nectar is a semantic memory layer for your project. It gives every file a stable identity and a short, plain-language description of what that file is for, so an AI coding assistant can answer a question like *"where is the login logic?"* and get back the right files — even the ones that are not named `login`.

The key idea is matching by **meaning**, not just by name. Regular search can only find a file if you already know part of its name or the exact text inside it. Nectar understands what each file *does*, so it can surface a file like a session-refresh middleware as part of "the login logic," even though the word "login" never appears in it.

It runs quietly in the background while you work. You do not launch it, configure it per query, or think about it day to day. It builds a shared map of your codebase once, keeps it up to date as files change, and feeds that understanding to your AI assistant.

---

## Q: Do I need to change how I write code?

No. You write, name, and organize your code exactly as you do today. Nectar reads your files and builds its understanding from what is already there.

There are no special comments to add, no markers to insert, no naming conventions to follow, and no annotations required. You do not have to tag files, fill out metadata, or describe anything yourself. The whole point is that the descriptions are produced for you, automatically, so you can keep working the way you already do.

Your existing workflow — your editor, your version control, your build — is untouched. Nectar layers on top of it without asking you to adapt to it.

---

## Q: Does it work with my existing AI coding assistant?

Yes. Nectar is designed to feed the assistant you already use, not to replace it. It plugs into the search and memory that your assistant already relies on, so that when your assistant goes looking for relevant code, it draws on Nectar's understanding of what each file means.

Think of it as giving your assistant a shared map of the codebase that it can consult. Your assistant still does the thinking, the editing, and the answering. Nectar just makes sure it is looking in the right places — by meaning, not only by keyword.

Because the understanding lives in a single shared map that is part of your project, every member of your team's assistant benefits from the same map, with no extra setup per person.

---

## Q: Does it modify my source files?

No, never. Nectar only **reads** your source files. It does not edit them, does not insert comments into them, and does not rewrite your license headers or any other line of any file.

The one and only thing it writes is a single separate file at the root of your project — a shared map that records each file's identity and its plain-language description. This file is kept apart from your source code, and it is fully regenerable: it can be deleted and rebuilt from Nectar's memory store at any time, with nothing lost.

This is a deliberate design choice. Mutating source files (for example, stamping an identity number into the first line of every file) was considered and rejected because it would collide with license headers, create merge conflicts, and fail on files that have no comment syntax at all. Nectar keeps identity out of your code entirely.

---

## Q: What kinds of files does it understand?

Nectar looks at the whole project, not just source code. It describes any text file that carries meaning: source files, configuration files, documentation, environment-example files, and more. If a file helps explain how the project works, Nectar can describe it.

A few categories are handled specially. Binary files (images, fonts, compiled assets) and very large files are not given a prose description — there is nothing meaningful for a language model to say about them — but they are still tracked and identified, so they are never invisible to the system.

The practical effect is that Nectar's map covers the parts of your project that matter for understanding it: the code, the configs, and the docs. It does not force everything into the same mold.

---

## Q: Does it replace my editor's search?

No — the two are complementary, and you will likely use both.

Your editor's search (and its "go to symbol" or "find references" features) is structural. It is excellent at precise tasks: jump to this exact function, find everywhere this exact name is used, rename a symbol safely across the codebase. It works because it reads the literal structure of the code.

Nectar is semantic. It answers questions that structural search cannot: *"where do we handle a user logging in,"* *"what files are involved in sending email,"* *"find everything related to the checkout flow."* These questions are about meaning and intent, not exact names.

Use your editor's tools when you know the name. Use Nectar (through your AI assistant) when you know the *idea* but not the name. They cover different ground and do not get in each other's way.

---

## Q: Is it free, and what does it cost to run?

Building the shared map the first time uses a fast, low-cost AI language model to produce the descriptions, so there is a small one-time cost per project. For a typical project of about 2,000 files, the first scan lands at roughly **$3**. It scales predictably with size: a small 200-file service costs about $0.30, and a large 10,000-file codebase around $15.

You can preview the exact cost before spending anything by running the first scan in a dry-run mode, which shows the estimated price without making any calls.

After that, the ongoing cost is minimal. Nectar does not re-describe your whole project on every edit — it only re-describes a file when its contents have meaningfully changed, and it waits for a pause in editing before doing so. Day-to-day refreshing costs pennies or nothing.

There is also a way to make clones of the same project free: the shared map can be committed to your repository, so a teammate who clones the project inherits all the descriptions without any new scanning cost. (See the privacy and cost FAQ for the details.)
