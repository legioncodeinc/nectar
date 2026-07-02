# Brooding User Stories

> Category: AI | Version: 1.0 | Date: June 2026 | Status: Draft

Engineering and operator user stories for the brooding pipeline, scoped to the behaviors the brooder must implement and the workflows an operator drives around it. Each story carries acceptance criteria grounded in the pipeline contract; this is engineering scope, not a product spec.

**Related:**
- [`brooding-technical-specification.md`](brooding-technical-specification.md)
- [`brooding-introduction-and-theory.md`](brooding-introduction-and-theory.md)
- [`brooding-ecosystem-story-arc.md`](brooding-ecosystem-story-arc.md)
- [`brooding-conclusion-and-deliverables.md`](brooding-conclusion-and-deliverables.md)
- [`../brooding-pipeline.md`](../brooding-pipeline.md)
- [`../enricher-and-llm-model.md`](../enricher-and-llm-model.md)
- [`../../data/hive-graph-schema.md`](../../data/hive-graph-schema.md)

---

## How to read these stories

The personas are the operator running a first brood, the operator running a `--dry-run` to sanity-check cost, the brooder discovering files, the batcher bucketing by size and type, the daemon resuming after a kill, and the enricher embedding after a description is written. Stories are numbered `US-BR-NNN` and grouped by the pipeline stage they constrain. Acceptance criteria are conjunctive — a story is done when every criterion holds.

The pipeline contract these stories derive from is [`brooding-technical-specification.md`](brooding-technical-specification.md); the conceptual reasoning is in [`brooding-introduction-and-theory.md`](brooding-introduction-and-theory.md).

---

## Triggering and mode rationale

**US-BR-001** — As an operator running Nectar against a fresh project, I want brooding to begin automatically the first time the daemon sees no `hive_graph` rows (and no `.honeycomb/nectars.json`), so that I get a semantic index without an explicit command.

**Acceptance criteria:** (a) On daemon boot, if no `hive_graph` rows exist for the project tenancy triple and no valid projection is present, brooding begins in the background. (b) The daemon reaches readiness and accepts requests before brooding completes (brooding is non-blocking). (c) Recall queries during a brood return whatever has been described so far; undescribed files are absent from semantic results until the brood reaches them.

**US-BR-002** — As an engineer maintaining the hiveantennae daemon, I want brooding to be implemented as a distinct mode from live watch and cold catch-up, so that the aggressive batching and projection-bootstrap properties are not accidentally coupled to the steady-state loop.

**Acceptance criteria:** (a) Brooding is the only mode that writes the initial `.honeycomb/nectars.json`. (b) Brooding is the only mode permitted to pack 30–50 files into a single LLM call. (c) After brooding completes, the daemon transitions to live watch; brooding does not re-trigger on subsequent boots unless the projection is missing and identity cannot be re-derived.

---

## Discovery

**US-BR-003** — As the brooder, I want to discover files by reusing the CodeGraph's `git ls-files --cached --others --exclude-standard -z` logic (with manual recursive walk fallback when git is unavailable), so that Nectar and the CodeGraph never disagree on what counts as a file in the repo.

**Acceptance criteria:** (a) Discovery uses the same command and the same `~/.honeycomb/graph-ignore.json` per-repo ignore file as the CodeGraph. (b) Nectar maintains no separate ignore list. (c) A file in the CodeGraph's discovery set is in Nectar's; a file not in it is not.

**US-BR-004** — As the brooder running on a clone that already committed `.honeycomb/nectars.json`, I want to pre-check each discovered file's content hash against the projection and inherit matching nectars without an LLM call, so that a fresh clone pays zero brooding cost.

**Acceptance criteria:** (a) Before bucketing, each discovered file's `sha256(content)` is checked against the projection's content-hash index. (b) A file whose hash matches a projection entry inherits that nectar and description and is written to Deep Lake without any LLM call. (c) Only files with no projection match enter the bucketing flow.

---

## Bucketing

**US-BR-005** — As the batcher, I want to classify each undiscovered file into one of four buckets — skip-binary, skip-too-large, batch, or solo — before any LLM call, so that the call shape is decided by size and parsability and the cost is predictable.

**Acceptance criteria:** (a) Every file lands in exactly one bucket. (b) Bucketing produces no LLM calls; it is pure classification. (c) The classification is deterministic for a given file (same size, same extension, same first-8KB NUL check → same bucket).

**US-BR-006** — As the batcher, I want binary files (first 8KB contains NUL bytes, or extension in the known-binary list) routed to skip-binary, so that they receive a nectar but no LLM description.

**Acceptance criteria:** (a) A file matching the binary criteria gets a minted nectar. (b) Its `hive_graph_versions` row has `describe_status = 'skipped-binary'`, `title = filename`, `description = ''`. (c) No LLM call is made for the file.

**US-BR-007** — As the batcher, I want files above `MAX_DESCRIBE_SIZE` (256 KB) routed to skip-too-large, so that genuinely huge files get identity but do not consume a solo LLM call.

**Acceptance criteria:** (a) A file with `size_bytes > 256 KB` gets a minted nectar. (b) Its row has `describe_status = 'skipped-too-large'`, `title = filename`. (c) The structural CodeGraph still extracts symbols from the file if it is source; Nectar simply does not describe it semantically.

**US-BR-008** — As the batcher, I want text files at or under 4 KB (and keeping cumulative batch size under 100 KB) grouped into batches of 30–50 files, so that the per-file LLM cost collapses by an order of magnitude versus one-per-call.

**Acceptance criteria:** (a) A batch contains files each with `size_bytes <= 4 KB`. (b) The cumulative size of files in a single batch is under 100 KB. (c) A batch contains between 30 and 50 files where supply allows. (d) One LLM call is made per batch, returning one description object per input file in input order.

**US-BR-009** — As the batcher, I want text files above 4 KB and at or under 256 KB routed to solo (one file per LLM call), so that mid-sized files get the richer prompt without overflowing batch economics.

**Acceptance criteria:** (a) A file with `size_bytes > 4 KB` and `<= 256 KB` gets one dedicated LLM call. (b) The solo prompt permits a longer description (3–5 sentences) and asks for a primary symbol. (c) The result is written to the file's version row.

---

## LLM calls

**US-BR-010** — As the brooder making a batch call, I want to send a JSON array of `{ nectar, path, content }` and receive a JSON array of `{ nectar, title, description, concepts }` in the same order, using the fixed batch system prompt, so that 40 files are described in one round-trip.

**Acceptance criteria:** (a) The request body is a JSON array of objects with `nectar`, `path`, `content`. (b) The system prompt matches the verbatim batch prompt. (c) The response is parsed as a JSON array and validated for per-entry shape and array length. (d) Descriptions are written to the corresponding `hive_graph_versions` rows with `describe_status = 'described'`.

**US-BR-011** — As the brooder, I want malformed batch responses (bad JSON, wrong shape, or wrong entry count) retried once with a stricter prompt, then fallen back to solo per-file calls, so that one bad batch does not lose the whole batch's files.

**Acceptance criteria:** (a) A malformed response triggers one retry with a stricter prompt. (b) If the retry is still malformed, each file in the batch is processed solo on the next cycle. (c) Files that fail solo are marked `describe_status = 'failed'` and retried on the subsequent cycle.

**US-BR-012** — As the brooder making a solo call, I want to use the richer prompt that allows a 3–5 sentence description and asks for a primary symbol, so that large files get a description useful for cross-linking to the structural CodeGraph.

**Acceptance criteria:** (a) The solo prompt permits a longer description than the batch prompt. (b) The prompt requests a primary symbol (the most important function/class/type). (c) The primary symbol is recorded as a hint for cross-linking to the structural CodeGraph.

---

## Embedding

**US-BR-013** — As the enricher, after a description is written (batch or solo), I want to compute a 768-dim embedding over `title + ' ' + description` using the configured embedding provider (local nomic by default, Cohere via Portkey opt-in), so that the description participates in hybrid vector recall alongside sessions and memory.

**Acceptance criteria:** (a) The embedding is computed over the concatenation `title + ' ' + description`. (b) The vector dimensionality is 768, matching `sessions.message_embedding` and `memory.summary_embedding`. (c) The embedding is written to the version row's `embedding` column.

**US-BR-014** — As the enricher, when the configured embedding provider is unavailable (local daemon not installed/warmed up or hosted provider unavailable), I want to leave the embedding NULL and let recall fall back to BM25 over `title` and `description`, so that there is no error and no quality cliff.

**Acceptance criteria:** (a) A missing or unavailable embedding provider does not raise an error. (b) The version row's `embedding` is NULL while `describe_status` is still `described`. (c) Recall silently degrades to lexical-only matching over the description, identical to the fallback behavior for session and memory recall.

---

## Projection bootstrap

**US-BR-015** — As the brooder, at the end of a brood I want to regenerate `.honeycomb/nectars.json` from Deep Lake (temp file plus atomic rename), so that the committed projection captures the result and a fresh clone can inherit it.

**Acceptance criteria:** (a) The projection is written to a temp file and atomically renamed into place. (b) The projection contains the latest described version per nectar, keyed by nectar, with a content-hash index. (c) A crashed regeneration leaves the previous projection intact, not a partial file. (d) The projection is regenerable from Deep Lake alone via `honeycomb nectar rebuild-projection`.

---

## Resumability

**US-BR-016** — As the daemon resuming after being killed mid-brood, I want to derive progress entirely from `hive_graph_versions.describe_status` with no lockfile, so that the next boot continues the brood without state reconciliation.

**Acceptance criteria:** (a) There is no "brood in progress" lockfile or partial-state marker. (b) On resume, files with `describe_status != 'pending'` are skipped. (c) Files with `describe_status = 'pending'` are re-enqueued. (d) Files absent from Deep Lake are discovered fresh and enter bucketing.

**US-BR-017** — As an operator whose laptop closed during a brood, I want the next daemon boot to resume the brood and complete it without re-describing already-described files, so that the interruption does not double the cost.

**Acceptance criteria:** (a) Already-described files are not re-described on resume (their `describe_status` is `described` or a skip state). (b) Pending files are re-enqueued and processed. (c) The brood completes and regenerates the projection once all files reach a terminal `describe_status`.

---

## CLI surface

**US-BR-018** — As an operator, I want `honeycomb nectar brood --dry-run` to run discovery and bucketing, print the estimated call count and cost, and exit without LLM calls, so that I can sanity-check the cost of a brood before committing to it.

**Acceptance criteria:** (a) `--dry-run` performs discovery and bucketing. (b) It prints the per-bucket file counts, the estimated call count, and the estimated cost. (c) No LLM calls are made. (d) No rows are written to Deep Lake and no projection is regenerated.

**US-BR-019** — As an operator, I want `honeycomb nectar brood --limit N` to cap the number of pending files processed in one invocation, so that I can bound the cost of an explicit brood.

**Acceptance criteria:** (a) At most N pending files are processed per invocation. (b) Files beyond the limit remain `pending` and are picked up by a subsequent invocation or the enricher loop. (c) The cost of the invocation is bounded by N and the bucket distribution of those N files.

**US-BR-020** — As an operator, I want `honeycomb nectar brood --force` to re-describe every non-skipped file (ignoring existing descriptions), so that I can re-brood after a model swap or a quality regression.

**Acceptance criteria:** (a) `--force` resets non-skipped described rows back to `pending`. (b) Skipped rows (binary, too-large) are not reset — they remain skipped. (c) The brood proceeds normally from the reset state, re-describing and re-embedding.

**US-BR-021** — As an operator, I want a plain `honeycomb nectar brood` to respect existing descriptions and only process pending files, so that re-running an interrupted or `--limit`-capped brood fills in the gaps without redoing finished work.

**Acceptance criteria:** (a) Existing described rows are not re-described. (b) Only `pending` rows are processed. (c) The projection is regenerated at the end to reflect any newly-described rows.

---

## Cost and readiness

**US-BR-022** — As an operator, I want the brood cost for a 2000-file repo to land near $3.05 (and scale linearly: ~$15 for 10K files, ~$0.30 for 200 files), so that the semantic index is affordable relative to its value and predictable across repo sizes.

**Acceptance criteria:** (a) The batch path dominates the small-file cost at ~38 calls for ~1500 files. (b) The solo path dominates the large-file cost at ~280 calls for ~280 files. (c) Embeddings are local and contribute $0. (d) The total for a 2000-file repo is approximately $3.05 (input ~$0.65, output ~$2.40).

**US-BR-023** — As an operator, I want brooding to run in the background after the daemon reaches readiness, so that recall and other daemon services stay available during a brood.

**Acceptance criteria:** (a) The daemon accepts requests before the brood completes. (b) Brooding does not hold a read-lock that blocks recall. (c) Recall during a brood returns described-so-far results; undescribed files are simply absent until reached.

---

## Composability and non-goals

**US-BR-024** — As an engineer, I want brooding and the structural CodeGraph to describe the same files independently, so that both the semantic layer and the structural layer ship for every source file.

**Acceptance criteria:** (a) Brooding does not skip files the CodeGraph covers structurally. (b) A source file is present in both `hive_graph_versions` (semantic) and the CodeGraph's `codebase` table (structural). (c) The two workers may run concurrently against the same file without coordination because they write to different tables.

**US-BR-025** — As an engineer, I want brooding to feed the enricher's pending queue for any file minted but not described during brooding (cost cap via `--limit`, or a skip), so that the steady-state loop fills the gaps over time.

**Acceptance criteria:** (a) Files minted but left `pending` (due to `--limit` or interrupted brood) appear in the enricher's pending-work query. (b) The enricher processes them on its cycle (latest-pending-per-nectar semantics). (c) A file skipped as binary or too-large is not enqueued for enrichment — its skip state is terminal.

---

## Related acceptance context

The verbatim bucket criteria, the batch system prompt, the cost-math table, and the resumability state machine are in [`brooding-technical-specification.md`](brooding-technical-specification.md). The end-to-end composition — how a first brood feeds the enricher and bootstraps the projection, and how a fresh clone with a committed projection skips brooding entirely — is traced in [`brooding-ecosystem-story-arc.md`](brooding-ecosystem-story-arc.md).
