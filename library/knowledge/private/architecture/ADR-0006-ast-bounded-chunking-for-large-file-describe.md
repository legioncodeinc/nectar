# ADR-0006, Describe large files as AST-bounded chunks, not one silent-clamped description

> **Status:** Proposed · **Date:** 2026-07-06
> **Supersedes:** none · **Superseded by:** none
> **Owners:** nectar, enricher, hive-graph
> **Related:** `ADR-0001-minted-nectar-over-source-embedded-serial.md` (the nectar identity a chunk inherits from its parent file), `data/hive-graph-schema.md` (the `hive_graph_versions` table this extends), `ai/brooding-pipeline.md` (the bucketing this refines), `ai/enricher-and-llm-model.md` (the describe call this governs)
> **Blocks:** the nectar large-file-describe PRD (not yet authored) and the cross-repo chunker coordination with honeycomb (PRD-076 on the honeycomb side, also not started).

## Decisions to confirm

The design direction below was approved in design review, but four numeric/structural decisions remain open and must be locked before the PRD lands. They are called out here so the PRD cites this section rather than restating each one.

**1. Chunk budget.** The per-chunk byte target for the AST splitter. Leaning **8 KB** (twice today's effective `BATCH_FILE_SIZE` of 4 KB, well under the 32 KB describe clamp). Open because no corpus measurement has validated it yet; the PRD must run nectar's own source tree through the splitter and confirm the chunk-count distribution is sane (a 700-line `pipeline.ts` producing 40 one-function chunks would be wrong; producing 4-6 would be right).

**2. Schema shape.** How chunk bounds are persisted. Leaning **two additive nullable columns** (`line_start`, `line_end`) on `hive_graph_versions`, mirroring exactly how `embed_model` was added (`schema.ts:64-67`). The alternative is a sibling `hive_graph_chunks` table. Open because the query-time read path (does recall filter on bounds, or just return the chunk row?) has not been designed.

**3. Absolute skip cap.** The hard ceiling above which a file is never chunked, never described, just skipped. Leaning **1 MB**. Today's `MAX_DESCRIBE_SIZE` is 256 KB (`constants.ts:26`); this ADR raises the describe-able ceiling and introduces a new absolute skip for compiled/minified files that would produce hundreds of meaningless chunks. Open because 1 MB is a round-number guess, not a measurement.

**4. Cross-repo chunker home.** Where the shared chunker code lives. Nectar has **no tree-sitter dependency today** (verified: zero matches for `tree-sitter` in `src/` or `package.json`). honeycomb's extractors at `honeycomb/src/daemon/runtime/codebase/extractors/` build graph nodes/edges, not text chunks, so they need extending regardless. Open: vendor a chunker into nectar, extract a shared package, or add `web-tree-sitter` as a new nectar runtime dep. This is the single biggest implementation unknown.

## Context

Nectar's describe pipeline mints an LLM-written `title` / `description` / `concepts` triple for every file it discovers, so that recall can surface the file by meaning rather than by path. The describe call (`src/enricher/describe.ts`) builds one prompt per batch of files, wrapping each file's body in `<<<NECTAR-FILE-<n> BEGIN/END>>>` sentinels.

### The silent 32 KB clamp

`MAX_DESCRIBE_FILE_BYTES = 32 * 1024` (`describe.ts:38`) is applied inside `buildUserPrompt` via `clampUtf8Bytes(f.content, MAX_DESCRIBE_FILE_BYTES)` (`describe.ts:65`) **before the LLM ever sees the body**. A file larger than 32 KB is hard-truncated at a UTF-8 code-point boundary; everything past ~line 900 (for typical source density) is invisible to the describe call. There is no warning, no log, no per-file flag — the row is written as if the whole file were described.

Nectar's own source tree hits this. `src/cli.ts` is 1,627 lines, `src/daemon.ts` is 1,173 lines, `src/brooding/pipeline.ts` is 700 lines. Today, the second half of each is described as if it does not exist. A user asking "how does nectar's CLI parse the `brood` subcommand?" through recall gets the answer only if the relevant code lives in the first ~900 lines.

### This is a signal-to-noise problem, not a token-budget problem

The describe model is `gemini-2.5-flash` (`src/portkey/config.ts`) with a **1M-token input window**. A 110 KB source file is ~27K tokens — comfortably inside the window. The clamp exists not because the call would fail, but because **one description for 3,379 lines is too diffuse to be useful for specific recall**: the model produces a generic summary ("this file handles CLI argument parsing and dispatch") that matches every CLI query equally poorly. Recall needs a description scoped to the specific function or class the user is asking about.

### Existing guards (carried forward, not replaced)

The brooding pipeline already has three size-based gates upstream of describe (`src/brooding/bucketing.ts:51-57`, `src/brooding/constants.ts`):

- **`skip-binary`** — a NUL byte in the first 8 KB (`BINARY_SNIFF_BYTES = 8 * 1024`) or a known-binary extension (`KNOWN_BINARY_EXTENSIONS`). No LLM call.
- **`skip-too-large`** — `size_bytes > MAX_DESCRIBE_SIZE` (256 KB). No LLM call.
- **`batch` / `solo`** — text files split at `BATCH_FILE_SIZE` (4 KB); small files are packed into dynamic token-budgeted batches (`BATCH_INPUT_TOKEN_BUDGET = 20_000`, `MAX_BATCH_FILES = 50`), larger files go solo.

Discovery (`src/brooding/discovery.ts`) honors `.gitignore` via `git ls-files --exclude-standard` but applies **no path-based ignore** — there is no `dist/` / `node_modules/` / `*.min.*` exclusion, so compiled/minified files can reach the bucketing stage and would, under this ADR's raised ceiling, become hundreds of meaningless chunks unless an absolute skip cap is introduced.

### No chunker exists anywhere yet

Neither nectar nor honeycomb has a text chunker. honeycomb's `src/daemon/runtime/codebase/extractors/{structural,ts-js,walk}.ts` are AST extractors that build **graph nodes and edges** (file node + symbol nodes + imports/calls/heritage edges) for the codebase-graph feature — they do not produce text chunks for recall. Reusing them for chunking means extending their output, not calling them as-is.

## Decision

**Split large source files into AST-bounded chunks at describe time, with each chunk becoming its own described row carrying `line_start` / `line_end` bounds. Two splitting modes: tree-sitter AST chunking for code, a ported recursive-character splitter for prose. Copy both algorithms into nectar; do not pull new dependencies for the algorithms themselves.**

### 1. AST-aware splitting for code, not naive character-windowing

A source file is split along its syntax tree's top-level declaration boundaries (functions, classes, methods, interfaces, type aliases, top-level consts) using tree-sitter. A chunk never splits a signature from its body, never breaks a docblock from its declaration, and never ends mid-expression. This is the load-bearing decision: naive `\n\n`-or-character windowing produces chunks that cut a function in half, and the describe model then sees a headless body it cannot summarize honestly.

Each chunk becomes its own `hive_graph_versions` row: its own `title` ("`classifyBucket` — the four-bucket router"), its own `description` (scoped to that symbol's responsibility), its own `concepts`, its own embedding. Recall surfaces the specific chunk, not a file-level grab-bag.

### 2. One chunk for small files, N chunks for large files (preserves today's behavior)

A file whose content fits under the chunk budget (Decision-to-confirm #1, leaning 8 KB) produces **one chunk = one row**, identical to today's path. The describe pipeline, the prompt shape, the batch packing, and the schema for these files are unchanged. Only files exceeding the budget are split; for them, N chunks become N rows, each carrying `line_start` / `line_end`.

This means the great majority of nectar's own source files (most are under 8 KB) flow through describe exactly as they do today. The split path activates only for the long files where today's silent clamp is doing damage.

### 3. Prose splitting: port `RecursiveCharacterTextSplitter`, do not pull the dep

Assistant messages, Bash stdout, and other prose content use a separate splitter: a verbatim ~80-line port of LangChain's `RecursiveCharacterTextSplitter` (MIT-licensed), with attribution. The algorithm is a recursive boundary hierarchy — paragraph (`\n\n`) → sentence (`.` / `?` / `!`) → word (` `) → character — that prefers the largest boundary that fits the chunk budget and only descends when it must.

Nectar's dependency surface is deliberately tiny (`package.json` has zero runtime deps; only `@types/node` and `typescript` as devDeps). Pulling `@langchain/textsplitters` (or any equivalent) for an 80-line algorithm that has not changed in years would violate that discipline for no gain. The port is MIT-attributed in the source comment.

### 4. Schema: additive nullable `line_start` / `line_end` columns

`hive_graph_versions` (`schema.ts:47-74`) gains two nullable columns: `line_start` and `line_end` (both `BIGINT`, nullable, no default — a chunk carries bounds; a whole-file row leaves them null). This mirrors exactly how `embed_model` was added additively (`schema.ts:64-67`) and is healable through the existing `buildAddColumnSql` (`schema.ts:164`) / `healMissingColumn` path: pre-existing rows read back `null`, meaning "this row describes the whole file," which is correct for every row written before this ADR ships.

A whole-file row and a chunk row are therefore distinguishable by `line_start IS NULL`, and recall can treat them uniformly (a whole-file row is just a chunk that happens to cover the whole file). The alternative — a sibling `hive_graph_chunks` table — is rejected for now (see Alternatives) but remains the escalation path if chunk-level metadata grows beyond two columns.

### 5. Absolute skip cap at ~1 MB for compiled / minified files

A new absolute skip gate (Decision-to-confirm #3, leaning 1 MB) sits above `MAX_DESCRIBE_SIZE`. A file above this ceiling is `skip-too-large` regardless of extension or content — it is assumed to be compiled, bundled, or minified, and chunking it would produce hundreds of meaningless one-line chunks. This gate is also the backstop for the missing path-based ignore: a `dist/` bundle that escapes `.gitignore` is caught here rather than flooding the describe pipeline.

The existing 256 KB `MAX_DESCRIBE_SIZE` bucketing gate is **retained as the batch/solo boundary**; it is not the describe ceiling. Under this ADR, a 200 KB source file is no longer skipped — it is split into ~25 chunks and each chunk is described.

### 6. Per-chunk provenance inherits the file's nectar

A chunk does not get its own nectar (identity). It inherits the parent file's nectar (`ADR-0001`), its own `content_hash` (over the chunk's text), and its own `seq` within the file's version chain. This keeps the identity model intact: a rename still re-associates the file (and therefore its chunks); a content edit still bumps `seq` for the affected chunks only, not the whole file. Rechunking on edit is incremental — unchanged chunks keep their existing description and embedding.

## Consequences

**Positive.**

- **Honest recall for large files.** A query about a specific function in a 1,600-line file surfaces the chunk that describes that function, not a generic file-level summary that matches every query equally poorly. This is the entire reason nectar describes files at all; the silent clamp defeats it for exactly the files where specific recall matters most (large, multi-responsibility modules).
- **Small-file behavior is unchanged.** Files under the chunk budget produce one row, identical to today. No regression for the common case; no schema migration cost for existing small-file rows (they just read back `line_start IS NULL`).
- **Additive, healable schema.** Two nullable columns, added through the existing `healMissingColumn` path. No data migration, no downtime, no rewrite of existing rows. Old nectar installs heal the columns on first write after upgrade and read back `null` for every pre-existing row.
- **Incremental rechunking on edit.** An edit to one function re-describes only that chunk; the other chunks of the same file keep their descriptions and embeddings, so a one-line change to a 1,600-line file costs one LLM call, not twenty.
- **The two algorithms are well-understood.** Tree-sitter AST chunking is what honeycomb's extractors already do (for graph nodes); `RecursiveCharacterTextSplitter` has been LangChain's default for years. Neither is novel; both are copy-and-attribute, not research.

**Negative.**

- **A new runtime dependency surface in nectar (Decision-to-confirm #4).** Nectar today has zero runtime deps and zero tree-sitter usage. AST chunking requires `web-tree-sitter` plus per-language WASM grammars in nectar's process, or a build-time vendoring strategy. This is the single largest implementation cost and the reason the chunker-home decision is left open. WASM is preferred over native bindings for CI determinism (the same reasoning honeycomb used).
- **More LLM calls for large files.** A 1,600-line file that today costs one (clamped, dishonest) describe call costs ~6-8 chunk describe calls under this ADR. The cost is real but honest: each call produces a focused description that is actually useful for recall, where today's single call produces a diffuse one that is not. Batching still applies — chunks from the same file can be packed into a batch call under the existing `BATCH_INPUT_TOKEN_BUDGET`.
- **Chunk stability under edit is not free.** When a file is edited, the splitter must re-derive chunks and match them against the previous version's chunks to decide which re-describe and which are unchanged. A naive `content_hash`-per-chunk works for exact-match chunks; a function whose body shifted by N lines (because something above it grew) needs the AST node's identity, not its byte range, to match across versions. This is a real algorithm-design problem the PRD must specify, not a detail.
- **The describe prompt's sentinel contract extends.** Today's `<<<NECTAR-FILE-<n>>>` wrapper (`describe.ts:62-69`) is per-file. A chunk batch needs per-chunk sentinels that carry the parent file path plus the chunk's line range, so the model can produce a description scoped to that range. The untrusted-body invariant (the body is data, never instructions) is preserved.

**Reversibility.** High. The two schema columns are nullable and additive; leaving them `null` forever is a valid state that exactly reproduces today's behavior. The chunker itself is a pure function from `(path, content) → Chunk[]`; it can be turned off (one-chunk-per-file for every file) by raising the chunk budget to infinity, with no schema change. The only hard-to-reverse step is introducing the tree-sitter dependency — once nectar's build and CI depend on `web-tree-sitter`, removing it is a real refactor, not a config flip. That cost is the real commitment this ADR makes.

## Alternatives considered and rejected

### Status quo: keep the silent 32 KB clamp (REJECTED)

Leave `MAX_DESCRIBE_FILE_BYTES` as-is. Rejected because the clamp is dishonest: it writes a row claiming to describe the whole file when it has only seen the first ~900 lines. Every large file in nectar's own source tree is currently mis-described, and recall against those files returns confident-sounding answers that are silently incomplete. This is the option this ADR exists to end.

### Raise the clamp to 256 KB without chunking (REJECTED)

Lift `MAX_DESCRIBE_FILE_BYTES` to match `MAX_DESCRIBE_SIZE` (256 KB) so the whole file reaches the model, but still produce one description per file. Rejected because it does not solve the signal-to-noise problem: a 256 KB file gets one description, which is even more diffuse than today's clamped one. The model's 1M-token window can *ingest* the file, but it cannot produce a *useful single-paragraph summary* of 3,000 lines. More tokens in does not mean more signal out.

### Naive character-window chunking (REJECTED)

Split files on a fixed character or line window (e.g., every 4 KB, or every 200 lines). Rejected because it splits mid-signature: a window boundary lands inside a function body, a docblock, or a multi-line type signature, and the describe model then sees a fragment with no declaration context. The resulting chunk descriptions are worse than today's clamped file-level description, because at least the file-level description has the file's imports and top-level shape. This is the failure mode that forces the AST-aware approach.

### Pull `@langchain/textsplitters` for the prose path (REJECTED)

Use the published LangChain package instead of porting the algorithm. Rejected because nectar's runtime dependency surface is deliberately zero (`package.json` has no `dependencies`, only devDependencies), and the algorithm being ported is ~80 lines of stable, well-understood recursive-boundary logic. Adding a runtime dep — with its transitive closure, its security surface, its version-drift risk, and its build-time footprint — for 80 lines of code violates the dependency discipline nectar has maintained since v0.1. The port carries an MIT attribution comment; it is not a fork, it is a copy of a stable algorithm.

### Sibling `hive_graph_chunks` table instead of additive columns (DEFERRED)

Persist chunks in a new `hive_graph_chunks` table keyed by `(nectar, content_hash, line_start, line_end)` rather than as additional rows in `hive_graph_versions`. Deferred because the only metadata a chunk needs beyond a regular version row is its two line bounds, and two nullable additive columns are strictly cheaper (no new table, no new heal path, no new query surface, no join at recall time). This remains the **escalation path**: if chunk-level metadata later grows (a chunk kind, a symbol name, an AST node id, a parent-chunk pointer for nested splits), the two-column approach runs out of room and the sibling table becomes correct. That is a future ADR's call, not this one's.

### Describe-time chunking only, skip cross-repo coordination (REJECTED FOR NOW)

Ship nectar's describe-time chunker without coordinating with honeycomb's capture-time path. Rejected because the same chunker is needed on both sides (honeycomb chunks at capture-time for its own recall; nectar chunks at describe-time for its own recall), and two independently-evolving chunkers will drift. The cross-repo coordination (honeycomb PRD-076) is explicitly in scope for the chunker decision even though it lands after nectar's PRD; the chunker-home decision (Decision-to-confirm #4) is shaped by the fact that both repos need the same code.

## References

- `src/enricher/describe.ts:38` — `MAX_DESCRIBE_FILE_BYTES = 32 * 1024`, the silent clamp this ADR replaces.
- `src/enricher/describe.ts:46-53` — `clampUtf8Bytes`, the codepoint-safe truncation helper a chunker must respect at its boundaries.
- `src/enricher/describe.ts:62-70` — `buildUserPrompt`, the per-file sentinel contract that extends to per-chunk.
- `src/enricher/describe.ts:19-26` — the `SYSTEM_PROMPT` and its untrusted-body invariant, preserved per-chunk.
- `src/brooding/constants.ts:20-29` — `BATCH_FILE_SIZE` (4 KB), `MAX_DESCRIBE_SIZE` (256 KB), `BINARY_SNIFF_BYTES` (8 KB): the existing size gates this ADR refines but does not remove.
- `src/brooding/bucketing.ts:51-57` — `classifyBucket`, the four-bucket router whose `skip-too-large` branch gains the new absolute-cap condition.
- `src/brooding/discovery.ts:102-108` — `GIT_LS_FILES_ARGS`, the discovery command with no path-based ignore (the reason the absolute skip cap matters).
- `src/hive-graph/schema.ts:47-74` — `HIVE_GRAPH_VERSIONS_COLUMNS`, the append-only version chain that gains `line_start` / `line_end`.
- `src/hive-graph/schema.ts:64-67` — the `embed_model` additive-column precedent (nullable, `healMissingColumn`-healed) this ADR mirrors.
- `src/hive-graph/schema.ts:164-167` — `buildAddColumnSql`, the heal path the migration uses.
- `src/portkey/config.ts` — the `gemini-2.5-flash` model config and its 1M-token input window (the reason the constraint is signal-to-noise, not tokens).
- `honeycomb/src/daemon/runtime/codebase/extractors/{structural,ts-js,walk}.ts` — the existing tree-sitter AST extractors (graph nodes/edges, not text chunks) that the chunker extends or shares infrastructure with.
- `library/knowledge/private/data/hive-graph-schema.md` — the authoritative schema doc transcribed into `schema.ts`.
- `library/knowledge/private/ai/brooding-pipeline.md` — the bucketing and batch-packing contract this ADR's split path must fit inside.
- `library/knowledge/private/ai/enricher-and-llm-model.md` — the describe-call model and prompt contract.
- `ADR-0001-minted-nectar-over-source-embedded-serial.md` — the identity model a chunk inherits from its parent file (a chunk has no nectar of its own).
