# Brooding Introduction and Theory

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

A conceptual essay for engineers and operators who want to understand *why* brooding exists as a distinct mode, why a long-context model is load-bearing rather than merely economical, and how the committed projection converts a one-time scan into a zero-cost inheritance for every subsequent clone.

**Related:**
- [`brooding-technical-specification.md`](brooding-technical-specification.md)
- [`brooding-user-stories.md`](brooding-user-stories.md)
- [`brooding-ecosystem-story-arc.md`](brooding-ecosystem-story-arc.md)
- [`brooding-conclusion-and-deliverables.md`](brooding-conclusion-and-deliverables.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`../../data/portable-registry.md`](../../data/portable-registry.md)
- [`../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md`](../../architecture/ADR-0001-minted-nectar-over-source-embedded-serial.md)

---

## Why this exists

Brooding is the one-time-per-project full scan that takes a codebase from "no nectars exist" to "every file has a nectar and most have a description." On its surface it looks like the obvious thing every indexing tool does on first run: walk the tree, describe the files, persist the results. The reason it earns a name and a mode of its own is that two of its properties cannot be shared with the steady-state maintenance loop, and getting them wrong costs an order of magnitude.

This essay exists because the two properties — aggressive batching and projection bootstrap — are easy to miss when reading the pipeline mechanics, and because the cost thesis that justifies the whole design (a 2000-file repo describes for roughly three dollars, once, forever) depends on both of them holding together. The mechanics live in [`brooding-technical-specification.md`](brooding-technical-specification.md); this document is the reasoning behind them.

The audience is an engineer or operator who has read the pipeline overview in [`../brooding-pipeline.md`](../brooding-pipeline.md) and wants the *why* before the *how* — why brooding is not just "the enricher run against the whole tree," why the model is named rather than generic, and why a single committed file is the difference between a one-time cost and a per-clone cost.

---

## Why brooding is a distinct mode

Hivenectar's hiveantennae daemon has four operating modes — brooding, live watch, cold catch-up, and projection sync — and brooding is the only one that runs against the entire codebase at once. The distinction is not a matter of scope; it is a matter of *what the daemon can assume*.

During live watch, descriptions are filled lazily, one file at a time, as the `node:fs.watch` intake notices edits. The enricher (documented in [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)) never sees more than a handful of changed files per cycle, and it has no reason to gather them: each file arrives independently, debounced and coalesced to its latest content. The natural call shape is one file per LLM round-trip, or a handful at most.

Brooding sees the whole codebase in a single pass. That changes the economics completely. With the entire tree in hand, the brooder can pack 30–50 small files into a single LLM call, because it controls the batching. The per-file cost collapses by roughly an order of magnitude versus the one-file-per-call shape the enricher is forced into. This is the first reason brooding is a separate mode: *it is the only mode with enough context to batch aggressively*, and aggressive batching is what makes a full-codebase description affordable.

The second reason is ownership of the projection bootstrap. Brooding is the only mode that writes the initial `.honeycomb/nectars.json`. Without that first write, a fresh clone has no identity map and no descriptions, and the team-share story — the single committed file that lets a teammate inherit every nectar without re-paying the LLM cost — does not exist. The enricher and cold catch-up maintain an already-bootstrapped projection; brooding creates it. This ownership is what makes brooding load-bearing rather than optional: it is the mode that establishes the portable projection the rest of the system inherits from.

After brooding completes, the daemon switches to live watch, with cold catch-up handling daemon restarts. Brooding runs once per project, then never again — unless the projection is lost and identity cannot be re-derived from it.

---

## Why long context is load-bearing

The model choice for brooding (and for the enricher) is Gemini 2.5 Flash, routed through the existing Portkey gateway. It is tempting to read this as "Hivenectar picked the cheapest acceptable model," but that framing misses the point. Raw cheapness is not the load-bearing property; **the 1M-token context window is**.

A model with a 200K-token window — Claude Haiku, Claude Sonnet, GPT-4o — can describe one large file or a handful of small files per call. A model with a 1M-token window can describe an entire directory of small files in a single round-trip. Four kilobytes of source is roughly one thousand tokens; forty small files is roughly forty thousand tokens of input, comfortably inside a one-million-token window and far inside even a 200K window *for the input*. The constraint that bites the smaller window is output: a batch of forty files produces two to four thousand output tokens of descriptions, and the round-trip reliability of structured JSON output degrades as the output grows. The one-million-token window gives enough headroom that the practical batch cap of 40–50 files is governed by output-token reliability and per-call economics, not by the input ceiling.

The cost consequence is direct and large. On the representative 2000-file brood, the batch path (the ~1500 small files) makes 38 LLM calls at forty files per call. A 200K-window model forced into eight-file batches makes 188 calls for the same files — roughly five times the call count, five times the per-call overhead, and five times the failure-retry surface. The full comparison, with dollar figures, lives in [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md): Gemini 2.5 Flash broods the 2000-file repo for about $3.05; Claude Haiku 4.5, with the same quality of description, broods it for about $7.00 — and the gap is almost entirely the batch size the context window permits.

This is why Hivenectar specifies Gemini 2.5 Flash rather than "the cheapest available model." A cheaper model with a small window loses the batching that makes the whole design affordable. The model is configurable through the same Portkey router that governs every other LLM call in Honeycomb, so an operator who wants to swap models can — but the default exists because long context at frontier-tier quality and price is the Pareto-optimal point for this workload.

---

## The one-time-per-project thesis

The single most important property of brooding is that it is billed once. The mechanism that makes "once" true is the committed portable projection.

When brooding finishes, the daemon regenerates `.honeycomb/nectars.json` from Deep Lake. The projection (documented in [`../../data/portable-registry.md`](../../data/portable-registry.md)) is a content-hash-keyed map of `{ content_hash: { nectar, title, description, concepts } }` for the latest described version of each nectar in the project. It is committed to the repo, like a lockfile, so that every clone inherits it.

The thesis plays out as follows. The first engineer to run Hivenectar against a project pays the brooding cost: roughly $3 for a 2000-file repo, scaling linearly with file count. They commit `.honeycomb/nectars.json` alongside their code. Every subsequent clone — by a teammate, by a fresh CI runner, by a new laptop — loads that projection and matches on-disk files into it by content hash. A file whose `content_hash` matches a projection entry inherits that nectar and description without any LLM call. A fresh clone with a current projection typically achieves **zero LLM calls and zero fuzzy matches**: every file finds its nectar through the projection's content-hash index.

The brooding cost is therefore paid by whoever first broods the project; every clone after that pays nothing. This is the property that makes brooding a one-time cost rather than a per-clone cost, and it is why committing the projection is the recommended default. A team that gitignores the projection forces every clone to brood from scratch, re-paying the LLM cost each time — the system works either way, but the economics flip from "once" to "every time."

---

## The resumability philosophy

Brooding is resumable, and the resumability model is worth understanding because it sets the pattern for the rest of the hiveantennae daemon.

The naïve approach to "a long-running scan that might be interrupted" is a lockfile or a progress marker: write "brood in progress, checkpoint at file N" to a sidecar, update it as you go, clean it up when done. Hivenectar rejects this. There is no brood-in-progress lockfile, no partial-state marker, no checkpoint file. The reason is that the state of a brood is *fully derivable* from data that is already being written: the `describe_status` column on every `source_graph_versions` row.

Every nectar mint and every description write during brooding is a committed Deep Lake write, not an in-memory accumulation. The `describe_status` column takes one of five values — `pending`, `described`, `failed`, `skipped-binary`, `skipped-too-large` — and the value tells the brooder everything it needs to know on resume:

- A file with `describe_status != 'pending'` (described, skipped, or failed-and-retried) is done; skip it.
- A file minted but not yet described has `describe_status = 'pending'`; re-enqueue it.
- A file not yet minted is simply absent from Deep Lake; discover it fresh and enter the bucketing flow.

If the daemon is killed mid-brood — laptop closed, process crashed, Ctrl-C — the next boot reads `describe_status` and picks up where it left off. No lockfile to clean up, no partial state to reconcile, no "did the checkpoint get flushed before the crash" ambiguity. The database *is* the checkpoint.

This is the same append-only, resumable pattern Honeycomb uses for the pollinating loop and the skillify miner. The principle is: if the durable store already records progress as a side effect of doing the work, do not duplicate that progress in a separate marker. The marker drifts; the database does not.

---

## What this essay is not

This document is the reasoning, not the contract. The verbatim bucket criteria, the system prompt text, the cost-math table, and the resumability state machine live in [`brooding-technical-specification.md`](brooding-technical-specification.md). The end-to-end flow — trigger, discovery, content-hash shortcut, bucketing, calls, writes, embedding, projection, handoff to live watch — is traced in [`brooding-ecosystem-story-arc.md`](brooding-ecosystem-story-arc.md). The deliverable and the explicit non-goals are restated in [`brooding-conclusion-and-deliverables.md`](brooding-conclusion-and-deliverables.md).

The thread that ties them together is the thesis above: brooding is a distinct mode because it is the only mode that can batch aggressively and the only mode that bootstraps the projection; it is affordable because long context enables the batching; and it is billed once because the committed projection converts the scan into an inheritance.
