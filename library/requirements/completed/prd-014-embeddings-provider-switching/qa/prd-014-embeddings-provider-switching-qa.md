# QA Report: PRD-014 Embeddings Provider Switching (PRD-vs-Corpus/Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-014 (index + 014a/014b/014c) against the Nectar knowledge corpus and the cited Honeycomb code, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass (no Nectar implementation exists yet), matching the bar and format of the consolidated PRD-001-004 report and the PRD-005 report. Every acceptance criterion and load-bearing claim was traced to `ai/enricher-and-llm-model.md` (the embeddings layer + 768-dim contract + BM25 fallback), `ADR-0001` (768-dim tied to schema), `MASTER-PRD-INDEX.md` decision #5, and the real Honeycomb files under `honeycomb/embeddings/src/` and `honeycomb/src/daemon/runtime/`.

**Related:**
- [`prd-014-embeddings-provider-switching-index.md`](../prd-014-embeddings-provider-switching-index.md)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md)
- [`2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)
- [`../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md`](../../completed/prd-005-hive-graph-catalog-tables/qa/prd-005-hive-graph-catalog-tables-qa.md)

---

## 1. Summary

PRD-014 is the embeddings-provider-switch module (decision #5). Its spec substance is excellent: the local-nomic-default plus Cohere-via-Portkey-opt-in design is faithful to `MASTER-PRD-INDEX.md:17` (decision #5) and to the corpus `ai/enricher-and-llm-model.md` § Embeddings; the 768-dim contract is held FIXED (never proposed as a flippable default); the provider selector extends the vault `embeddings.enabled` key rather than inventing a parallel enable mechanism; and every one of the ~20 cited Honeycomb symbols exists at the cited line range with **zero line drift**. The module **PASSES with one warning** to the medium-and-above standard: **zero Critical findings** and **one medium Warning** (W-1: the "Unix-socket NDJSON IPC" phrase mischaracterizes the local embed-daemon transport, which is loopback HTTP on `127.0.0.1:3851`; this originates in the corpus and the PRD faithfully mirrors it). On the doc-framework check the news is good: the systemic honeycomb-code-refs-as-markdown-links finding (W-1/W-3 of the prior reports) is **fully cleared here** (zero link-form tokens across all four files; every code ref is a backtick span), and the `MASTER-PRD-INDEX.md` and `knowledge/` cross-links resolve at the correct relative depth (no PRD-005 W-2 equivalent). One sub-medium suggestion (S-1) covers abbreviated code-path spans.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-014 index | PASS | WARNING (W-1) | PASS | PASS | PASS | PASS-with-warnings |
| PRD-014a | PASS | PASS | PASS | PASS | PASS; note S-1 | PASS |
| PRD-014b | PASS | PASS | PASS | PASS | PASS; note S-1 | PASS |
| PRD-014c | PASS | PASS | PASS | PASS | PASS; note S-1 | PASS |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-1 (Correctness / Alignment, index + corpus): "Unix-socket NDJSON IPC" mischaracterizes the local embed-daemon transport

The index describes the local nomic path as using "Unix-socket NDJSON IPC":

- `prd-014-embeddings-provider-switching-index.md:12`: "the existing local nomic daemon (`nomic-embed-text-v1.5`, q8, Unix-socket NDJSON IPC, the zero-marginal-cost default)".

The cited Honeycomb transport is not a Unix domain socket and is not NDJSON. It is a **loopback HTTP** server that accepts a JSON `POST /embed` on a TCP port:

- `embeddings/src/index.ts:6-10` (module header): "over a loopback HTTP/NDJSON-ish IPC (`POST <url>/embed { text } -> { vector }`, `GET <url>/health`)". Even the source's own comment hedges "NDJSON-ish", and the wire format is a single JSON request/response, not newline-delimited JSON.
- `embeddings/src/index.ts:66-68`: `EMBED_HOST = "127.0.0.1"`, `EMBED_PORT = 3851` (a TCP loopback bind, not a filesystem socket).
- `embeddings/src/index.ts:318-370`: `createServer(...)` plus `server.listen(port, host, ...)` (a Node `node:http` server).
- `embed-client.ts:52-55`: `HONEYCOMB_EMBED_URL` default `http://127.0.0.1:3851`.
- `embed-client.ts:253`: the client calls `fetch(`${this.options.url}/embed`, { method: "POST", ... })`.

Root cause: the phrase originates in the corpus at `ai/enricher-and-llm-model.md:114` ("Unix-socket NDJSON IPC"), and PRD-014 faithfully mirrors the corpus (which is the source of truth). Because the audit checks the PRD against BOTH the corpus and the cited honeycomb transports, and the two disagree, this is surfaced as a finding rather than silently passed. Blast radius is low: PRD-014 does not touch the local IPC mechanism (it abstracts the model consts behind a strategy), so the mislabel does not change any acceptance criterion. But it would mislead an implementer about the existing transport.

**Remediation (report-only; corpus is the root):** Correct the transport phrase to something like "loopback HTTP on `127.0.0.1:3851` (JSON `POST /embed`)" in the corpus `ai/enricher-and-llm-model.md:114` (owner: knowledge-worker-bee) and, once the corpus is corrected, align the mirror at `prd-014-...-index.md:12`. Do not edit the corpus or the PRD in this pass (audit scope is this PRD's `qa/` folder only).

## 5. Suggestions (consider improving) and sub-medium notes

- **S-1 (Detrimental Patterns / consistency, all four files):** The honeycomb code references are the correct canonical FORM (backtick file-path spans, per Documentation Framework section 6 and `AGENTS.md`) and carry **zero** markdown-link tokens, so the systemic finding from the prior reports (PRD-001/002/003 W-1, PRD-005 W-3) is cleared here. However, many spans are abbreviated to a bare filename or a partial path (for example `embed-client.ts:272-274`, `rerank-portkey.ts:46`, `transport-portkey.ts:74`, `vault/api.ts:66`, `storage/vector.ts:75-84`) rather than the full repo-relative `honeycomb/...` form that `MASTER-PRD-INDEX.md:164` and PRD-005 use (for example `honeycomb/src/daemon/runtime/services/embed-client.ts`). No functional impact and every span was traced with zero line drift, but a bare filename is harder to resolve unaided. Consider promoting to full `honeycomb/src/...` / `honeycomb/embeddings/src/...` spans for resolvability and cross-doc consistency. Sub-medium.

### Link-form honeycomb token counts per file (doc-framework check)

| File | Link-form honeycomb tokens | Backtick-span code refs | Verdict |
|---|---|---|---|
| `prd-014-...-index.md` | 0 | present, span-form | PASS |
| `prd-014a-embed-provider-strategy-and-config.md` | 0 | present, span-form | PASS |
| `prd-014b-cohere-via-portkey-transport.md` | 0 | present, span-form | PASS |
| `prd-014c-provider-switch-and-bm25-fallback.md` | 0 | present, span-form | PASS |
| **Total** | **0** | | **PASS** |

Remediation recipe (for completeness, not needed here): had any honeycomb ref been a markdown link of the shape `` [`honeycomb/...:LN`](../../../../honeycomb/...) ``, the fix would be to drop the link wrapper and keep the backtick span (promoting the target path into the span when the visible text is short-form), then `grep -rhoE '\]\(\.\.[^)]*honeycomb[^)]*\)' *.md | wc -l` and confirm it returns zero. In this module the count is already zero.

## 6. Plan Item (AC) Traceability

### PRD-014 index (4 ACs)

| AC (index) | Corpus / code source | Verdict |
|---|---|---|
| AC-1 no selection -> local nomic default | decision #5 (`MASTER-PRD-INDEX.md:17`); corpus `enricher-and-llm-model.md:114`; default-on resolve `embed-client.ts:169-177` | PASS |
| AC-2 Cohere selected -> POST Portkey embeddings via rerank pattern (`buildPortkeyHeaders` + same host) | `transport-portkey.ts:74` (`PORTKEY_BASE_URL`), `:95` (`buildPortkeyHeaders`); `rerank-portkey.ts:164` (header use) | PASS (the `/v1/embeddings` path is a flagged default to build, not a gap) |
| AC-3 non-768 vector -> `embed.dim_rejected` guard discards, column stays NULL | `embed-client.ts:272-274`; `storage/vector.ts:75-84` (`assertEmbeddingDim`), `:57-66` (`VectorDimensionError`) | PASS |
| AC-4 embeddings off -> NULL column, recall falls back to BM25, no error | `embed-client.ts:248`; `storage/vector.ts:260-284` (lexical degrade); corpus `:118` | PASS |

### PRD-014a embed provider strategy + config (5 ACs)

| AC (014a) | Source | Verdict |
|---|---|---|
| AC-014a.1.1 no selection -> local nomic resolved | decision #5; DEFAULT-confirm flag `prd-014a:69` (selector default `local`) | PASS |
| AC-014a.1.2 local honors pinned `MODEL_ID`/`MODEL_REVISION`/`MODEL_QUANTIZATION` (q8) | `embeddings/src/index.ts:46`, `:57`, `:60` | PASS (consts exist verbatim; kept pinned per Non-Goal) |
| AC-014a.2.1 select Cohere via config -> Cohere-via-Portkey resolved | 014b transport; decision #5 opt-in | PASS |
| AC-014a.2.2 Cohere selected -> local nomic path not exercised | strategy resolution (design) | PASS |
| AC-014a.3.1 `embeddings.enabled` false -> no vector regardless of provider (NULL, BM25) | `embed-client.ts:248`; `vault/api.ts:66` (`EMBEDDINGS_ENABLED_KEY`) | PASS |

### PRD-014b Cohere-via-Portkey transport (6 ACs)

| AC (014b) | Source | Verdict |
|---|---|---|
| AC-014b.1.1 POST with `buildPortkeyHeaders(resolvedKey, configId)` | `transport-portkey.ts:95`; use pattern `rerank-portkey.ts:164` | PASS |
| AC-014b.1.2 2xx -> parsed vector as `readonly number[]` | `EmbedClient.embed` contract `embed-client.ts:80-83` | PASS |
| AC-014b.2.1 non-768 -> `null` + `embed.dim_rejected` (expected 768, actual) | `embed-client.ts:272-274` | PASS |
| AC-014b.2.2 NULL column -> recall BM25, no error | `storage/vector.ts:260-284`; corpus `:118` | PASS |
| AC-014b.3.1 network/non-2xx -> `null`, never throws into hot path | rerank fail-soft template `rerank-portkey.ts:167-178`; `RerankCallResult` `:63-65` | PASS |
| AC-014b.3.2 resolved key never logged/returned/thrown | `transport-portkey.ts:38-42` (chat b-AC-3); `rerank-portkey.ts:32-36` (c-AC-2) | PASS |

### PRD-014c provider switch + BM25 fallback (6 ACs)

| AC (014c) | Source | Verdict |
|---|---|---|
| AC-014c.1.1 selector `local` -> local nomic transport runs | strategy resolution (014a) | PASS |
| AC-014c.1.2 selector `cohere` -> Cohere transport runs, local does not | strategy resolution (014a/014b) | PASS |
| AC-014c.2.1 disabled / dep absent / warm-failed -> column NULL, `describe_status = 'described'` | corpus failure table `:130`; `embed-client.ts:248`; warm-fail path `embeddings/src/index.ts:308-316` | PASS |
| AC-014c.2.2 NULL -> recall BM25 over title/description, no cliff | `storage/vector.ts:260-284`; corpus `:118` | PASS |
| AC-014c.3.1 non-768 from either provider -> `embed.dim_rejected`, discarded, NULL | `embed-client.ts:272-274` | PASS |
| AC-014c.3.2 discarded -> BM25 (same path as off) | attacher recheck `embed-client.ts:313-316`; `assertEmbeddingDim` `storage/vector.ts:75-84` | PASS |

## 7. Deliberate items preserved (NOT flagged as gaps)

Confirmed present and intentional, not defects:

- **768-dim held FIXED.** The index states "Schema changes: None (768-dim is fixed; a dimension change is a schema event, out of scope)" (`index:6`), the Non-Goals reject changing dimensionality (`index:27`, `014a:27`, `014b:26`), and no flagged default proposes flipping the dimension. This is the correct posture per the must-preserve constraint and `ADR-0001` (768 tied to `sessions.message_embedding` / `memory.summary_embedding`). The PRD relies on recall's `embed.dim_rejected` guard (`embed-client.ts:272-274`) and `assertEmbeddingDim` (`storage/vector.ts:75-84`), exactly as required. Not a finding.
- **Provider selector extends the vault `embeddings.enabled` boolean, no parallel enable mechanism** (`014a:62` citing `vault/api.ts:66`). The env-side `HONEYCOMB_EMBEDDINGS` opt-out (`embed-client.ts:169-177`) is correctly described as the separate opt-OUT switch, not a second enable path. Correct per must-preserve.
- **Local nomic default + Cohere-via-Portkey opt-in** is verified against decision #5 (`MASTER-PRD-INDEX.md:17`, "DECIDED"), not re-litigated. Both rejected alternatives (local-only for v1; default-to-Cohere) are carried verbatim in the PRD Non-Goals (`index:25-26`).
- **DEFAULT-confirm flags** are present and correctly marked: provider selector default `local` (`014a:69`), Cohere embed model id (`014b:70`), Cohere endpoint `/v1/embeddings` (`014b:71`). 014c introduces no new configurable default (`014c:69`). Each carries the "DEFAULT - confirm before implementation" marker.

## 8. High-risk surfaces verified verbatim / against source (zero drift)

- Nomic consts: `EMBED_DIMS = 768` (`embeddings/src/index.ts:43`), `MODEL_ID = "nomic-ai/nomic-embed-text-v1.5"` (`:46`), `MODEL_REVISION` (`:57`), `MODEL_QUANTIZATION = "q8"` (`:60`), `DOCUMENT_PREFIX = "search_document: "` (`:63`); daemon-side dim throw at `:213-217`. All present at the cited lines.
- Embed client: `EmbedClient.embed(): Promise<readonly number[] | null>` (`embed-client.ts:80-83`); disabled -> null (`:248`); opt-out resolution (`:169-177`); `embed.dim_rejected` guard (`:272-274`); attacher independent recheck (`:313-316`). All present.
- Vault key: `EMBEDDINGS_ENABLED_KEY = "embeddings.enabled"` (`vault/api.ts:66`), single source of truth for the settings allow-list + boot read + toggle action. Present verbatim.
- Rerank transport template: shared-header import (`rerank-portkey.ts:46`) and use (`:164`); jscpd-discipline note (`:9-15`); `RerankCallResult` typed failure (`:63-65`); `onTransportError` signal (`:84`, `:141-148`); c-AC-2 secret invariant (`:32-36`). All present.
- Portkey foundation: `PORTKEY_BASE_URL = "https://api.portkey.ai/v1"` (`transport-portkey.ts:74`, value verbatim); `buildPortkeyHeaders(apiKey, configId)` (`:95`); secret-never-logged invariant (`:38-42`). All present. (Note: no `PORTKEY_EMBEDDINGS_URL` const exists yet; the `/v1/embeddings` path is the thing 014b builds, correctly flagged as a default to confirm.)
- Vector storage: `EMBEDDING_DIMS = 768` (`storage/vector.ts:35`); `VectorDimensionError` (`:57-66`); `assertEmbeddingDim` (`:75-84`); `serializeFloat4Array` (`:91-98`); lexical-degrade builder (`:260-284`). All present.
- Corpus alignment: `enricher-and-llm-model.md:114` (provider switch: local nomic default + Cohere-via-Portkey opt-in), `:116` (both honor 768-dim; wrong dim rejected by guard; dim change is a schema event), `:118` (BM25 fallback), `:130` (provider unavailable -> description written, embedding NULL, `describe_status = 'described'`). All consistent with the PRD except the transport phrase in W-1.

All cited symbol/line ranges exist with no line drift. No fabricated values, no invented helper names, no invented Cohere/Portkey endpoint asserted as fact (it is a flagged default).

## 9. Files Audited

- `prd-014-embeddings-provider-switching-index.md` - audited (carries W-1). (audited)
- `prd-014a-embed-provider-strategy-and-config.md` - audited (note S-1). (audited)
- `prd-014b-cohere-via-portkey-transport.md` - audited (note S-1). (audited)
- `prd-014c-provider-switch-and-bm25-fallback.md` - audited (note S-1). (audited)

No PRD content, corpus, or code was modified by this audit (report-only, per quality-stinger). Only this `qa/` folder was created.

**Overall verdict (as-audited): PASS-with-warnings** (medium-and-above). Zero Critical findings. One medium Warning (W-1: the "Unix-socket NDJSON IPC" transport phrase contradicts the cited loopback-HTTP embed daemon; corpus-origin, low blast radius, remediation is corpus-side). The spec substance passes cleanly: the local-default + Cohere-opt-in design conforms to decision #5, the 768-dim contract is held fixed (not a flippable default), the vault `embeddings.enabled` extension is faithful, and all ~20 cited Honeycomb symbols exist with zero line drift. The doc-framework check is clean: zero honeycomb-code-as-markdown-link tokens (the systemic prior-report finding is cleared here) and all cross-links resolve at correct depth. One sub-medium suggestion (S-1: abbreviated code-path spans).

## Remediation addendum (2026-07-01, the-smoker Wave B) — PRD verified faithful; W-1 deferred to the corpus owner

- **W-1 disposition: DEFERRED (corpus-owner item), PRD-014 not edited.** The "Unix-socket NDJSON IPC" phrase originates in the corpus (`ai/enricher-and-llm-model.md:114`); PRD-014 faithfully mirrors the corpus, which is the correct behavior for a PRD-vs-corpus conformance artifact. Editing PRD-014 to diverge from the corpus would itself be a conformance defect, and editing the corpus is out of this run's scope (the corpus is knowledge-worker-bee's domain and has an active parallel editor). The finding is therefore recorded as a deferred cross-cutting corpus fix, in the same class as C-1/C-2 in the consolidated report. **Exact ask (for knowledge-worker-bee):** at `ai/enricher-and-llm-model.md:114`, replace "Unix-socket NDJSON IPC" with "loopback HTTP on `127.0.0.1:3851` (JSON `POST /embed`)" to match the real embed daemon (`honeycomb/embeddings/src/index.ts:6-10, 66-68, 318-370`); then align the mirror at `prd-014-...-index.md:12`.
- **Verdict:** PRD-014 as a document is VERIFIED faithful to the corpus and the cited code (zero line drift across ~20 symbols, 768-dim held fixed, `embeddings.enabled` extension faithful, doc-framework clean). Its one medium Warning is not a PRD-014 authoring defect; it is a corpus imprecision the PRD correctly inherits, parked with an exact ask.
- **Sub-medium (carried forward):** S-1 (promote abbreviated honeycomb code spans like `embed-client.ts:272-274` to full `honeycomb/src/...` form for resolvability).
