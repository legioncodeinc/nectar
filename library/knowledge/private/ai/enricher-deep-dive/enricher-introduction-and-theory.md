# Enricher Introduction and Theory

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

The conceptual essay behind the enricher: why steady-state description maintenance is a distinct problem from one-time bootstrap, why Gemini 2.5 Flash is the canonical model rather than "the cheapest available," why long context is load-bearing in a way it is not for most LLM applications, and why the model is a configurable default rather than a hardcoded constant.

**Related:**
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`enricher-technical-specification.md`](enricher-technical-specification.md)
- [`enricher-user-stories.md`](enricher-user-stories.md)
- [`enricher-ecosystem-story-arc.md`](enricher-ecosystem-story-arc.md)
- [`enricher-conclusion-and-deliverables.md`](enricher-conclusion-and-deliverables.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../../overview.md`](../../overview.md)

---

## The enricher as steady-state description maintenance

A codebase is not described once. It is described continuously, because it changes continuously. Nectar separates the two regimes sharply. Brooding is the one-time bootstrap: a full scan that takes a codebase from "no nectars exist" to "every file has a nectar and most have a description." The enricher is everything after. It is the steady-state description-maintenance loop — the component that keeps descriptions fresh as files are edited, moved, created, and deleted, without ever re-paying the brooding cost.

This separation is not organizational convenience; it reflects a real difference in workload shape. Brooding sees the whole codebase at once and can batch aggressively, packing 30–50 small files into a single LLM round-trip. The enricher sees a trickle of changes — one file edited here, three files created there — and works them off a queue. Brooding is throughput-optimized; the enricher is latency-tolerant and cost-disciplined. Conflating the two would either make brooding slow (treating every file as a solo enricher job) or make the enricher wasteful (re-batching the whole codebase on every edit).

The enricher earns its keep through restraint. It does not describe on every save; it debounces, then applies a meaningful-change heuristic, then — only if the change is genuinely semantic — pays for an LLM call. A reformat, a comment tweak, a whitespace edit produces a new content hash but not a new description. This is the change-laziness property, and it is what keeps the steady-state loop affordable on a codebase that is being actively edited all day.

---

## Why Gemini 2.5 Flash specifically

The model choice for Nectar is Gemini 2.5 Flash, routed through the Portkey gateway. The framing of that choice matters. Nectar does not specify "the cheapest available model," and it does not specify "a frontier reasoner." It specifies Gemini 2.5 Flash, because Gemini 2.5 Flash occupies a Pareto-optimal point that no cheaper model and no stronger model occupies simultaneously: frontier-tier quality, a 1-million-token context window, and the lowest price at that quality.

The comparison makes the Pareto argument concrete. Against Claude Haiku 4.5 (200K context), Gemini 2.5 Flash holds comparable single-file quality at roughly half the total cost on the 1500-small-file brood slice, because Haiku's smaller window caps the batch at ~8 files and quintuples the call count. Against GPT-4.1 (1M context, comparable quality), Gemini 2.5 Flash lands at roughly a quarter of the cost — the context windows match, so the batch counts match, but GPT-4.1's per-token price is higher. Against GPT-4o-mini (128K context), Gemini 2.5 Flash is price-competitive at face value, but GPT-4o-mini carries two hidden costs: its single-file summarization quality is measurably worse on code understanding benchmarks, and its 128K window forces tiny batches that increase call overhead and failure-retry cost.

The full comparison, reproduced in the technical specification, is the evidence for the choice. The choice is not "cheapest" — GPT-4o-mini is cheaper on paper. The choice is "lowest price at frontier quality with 1M context," which is a different and more defensible criterion.

---

## Why long context is load-bearing

For most LLM applications, context window is a ceiling that rarely matters: the prompt fits comfortably, and a larger window is nice-to-have but not decisive. For Nectar, long context is load-bearing. The reason is batching.

The brooding batch call packs 30–50 small files into a single LLM round-trip. The per-file cost collapses roughly linearly with batch size up to the context limit. A model with a 200K-token window caps the batch at ~6–10 small files per call, quintupling the call count and the per-file overhead relative to a 1M-token model. A model with a 1M-token window fits ~200 small files per call in principle, though batch size is capped at 40–50 in practice for output-token and reliability reasons. The 1M window is not consumed by a single file; it is consumed by aggregating many files into one call.

This is why a 200K-window model like Haiku is not simply "more expensive per file but otherwise equivalent." The smaller window changes the batch shape, which changes the call count, which changes the cost and the failure surface (more calls means more opportunities for a 429 or a malformed-JSON retry). Long context is not a quality property of the model; it is an economic property of the batching strategy that the model enables.

The enricher inherits this property from brooding. Its batch calls — when multiple pending files accumulate within a cycle — pack as many files as the configured model's window allows. Swap to a 200K-window model and the enricher's batch shape shrinks accordingly, with no code change. The capability tier encodes this: long context is required, ≥1M tokens preferred, ≥200K acceptable.

---

## The model-is-not-hardcoded thesis

The choice of Gemini 2.5 Flash is a default, not a commitment. The model is set in the model provider router, configurable via the same `agent.yaml` / Portkey config that routes every other LLM call in Honeycomb. An operator who wants Haiku (smaller batches, higher cost, no infrastructure change) or a local Ollama model (zero marginal cost, local GPU footprint, smaller batches) can swap without code changes.

This configurability is a deliberate design stance. Nectar never codes itself into one provider. The capability tier — long context, single-file code understanding, structured JSON output, function calling NOT required, multilingual tolerance — is the real contract. Any model that satisfies the tier is acceptable. Gemini 2.5 Flash is the default because it satisfies the tier at the lowest cost-per-file for the batch sizes Nectar uses, but the tier is what an alternative model must meet, not the model's name.

The `describe_model` column on every `hive_graph_versions` row is the mechanism that makes this stance auditable rather than implicit. Every description records which model produced it. After a swap, rows described by the previous model are identifiable and filterable, which is the basis for selective re-description. The system can answer "which descriptions came from which model" without inference, because it records the answer at write time.

---

## Why selective re-description, not automatic

A model swap does not re-describe existing rows automatically. Existing descriptions are valid until proven otherwise: a description of "this file refreshes JWT claims on each authenticated request" does not become wrong because the operator switched the default model. Re-describing every row on every swap would burn LLM budget re-deriving descriptions that are already correct.

The selective path exists for the case where quality demands it. An operator who swaps models and wants to re-describe everything runs `honeycomb nectar brood --force --model <new>`, which sets all non-skipped rows back to `pending`. The enricher then re-describes them on subsequent cycles using the new model, and the `describe_model` column records the transition. Between these two extremes — do nothing, and re-describe everything — the `describe_model` column supports a middle path: filter to rows described by the old model and re-describe only those, leaving inherited and already-swapped rows alone.

This is the auditability contract paying off. A system that hardcoded the model would have no way to tell old-model descriptions from new-model descriptions and would be forced into all-or-nothing re-description. A system that records the model per row can be surgical.

---

## What makes the enricher defensible

Three properties make the enricher's design defensible against the alternatives, and they are worth naming together because they reinforce each other.

First, **the choice of model is Pareto-optimal, not cheapest-available.** Defending "we picked the cheapest" is hard, because cheaper models tend to fail on quality. Defending "we picked the lowest price at frontier quality with 1M context" is easy, because the comparison table is the evidence.

Second, **the model is configurable, not hardcoded.** Defending "we are locked into one provider" is hard. Defending "the default is configurable via the same gateway everything else uses, and the real contract is a capability tier" is easy.

Third, **the choice is auditable, not implicit.** Defending "we cannot tell which model produced which description" is hard. Defending "every row records its `describe_model`, so a swap can be surgical" is easy.

The three properties compose. The Pareto-optimal default means the out-of-the-box choice is the right one for most operators. The configurable stance means an operator with different constraints (local-only, no external calls) can diverge. The auditable column means the divergence is visible and reversible. None of the three is sufficient alone; together they make the enricher's model strategy robust.

---

## The two lazinesses as a single idea

Time-laziness and change-laziness are usually described as two properties, but they are better understood as one idea expressed at two timescales. The shared idea is: *do not pay for work whose result would be thrown away*.

Time-laziness is the coarse-grained expression. A version row sits pending because there is no urgency — recall does not surface it, and the next edit to the same file would supersede it anyway. Describing it eagerly would produce a description that is correct for a state the file has already left. The 30-second poll interval is the timescale at which "this is probably the file's settled state" becomes a reasonable bet; below that, the enricher would be chasing a moving target.

Change-laziness is the fine-grained expression. Even after the poll interval fires, a content change may not be a meaning change. A reformat produces new bytes that describe the same file; describing it would produce a description that is equivalent to the existing one, phrased differently, polluting the version chain with artificial churn. The 0.85 Jaccard threshold is the granularity at which "this change is cosmetic" becomes a reasonable bet; below it, the enricher would be spending tokens to re-derive what it already knows.

The two properties share a failure mode and a defense. The failure mode is describing work that does not need describing. The defense is a cheap pre-check that costs nothing relative to an LLM call — a poll timestamp and a token-similarity score — and that gates the expensive operation behind a judgment about whether the result would survive. This is the same instinct behind Smith's `Hash != Described-Against-Hash` rule, generalized from raw-hash equality to token similarity so that reformats (which change the hash but not the tokens) are handled correctly. The generalization is the whole reason Nectar does not use raw-hash equality: a hash-equality rule would re-describe on every Prettier run.

---

## Why the enricher is not a cron job

A background loop that runs on a timer and drains a queue has the shape of a cron job, and it is worth being explicit about why the enricher is not one. A cron job is trigger-blind: it fires at its interval regardless of whether there is work, and it treats every queued item as equally deserving of processing. The enricher is trigger-aware and priority-aware.

It is trigger-aware because its input is not time but a content change, filtered through debounce and the meaningful-change heuristic. A codebase that is not being edited produces zero enricher work, not a stream of empty cycles. The poll interval is the upper bound on latency, not the rate of work.

It is priority-aware because the pending-work query orders by `MIN(observed_at)` and selects the latest version per nectar. A file that went pending an hour ago is processed before a file that went pending a second ago, and intermediate versions of the same file are skipped entirely. A cron job that processed the queue in insertion order would describe stale intermediates and starve old pending rows behind a pile of fresh ones.

The distinction matters for cost. A cron-shaped enricher would consume a predictable amount of LLM budget per cycle regardless of need; the trigger-aware enricher consumes budget proportional to genuine semantic change. On a quiet day, the cost is near zero. On a heavy-edit day, the cost scales with the edit volume, filtered by the heuristic. The cost counter on the dashboard reflects actual work done, not a fixed operational tax.
