# QA Report: PRD-010 Portkey Gateway Integration (PRD-vs-Corpus/Code Conformance)

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

Conformance audit of PRD-010 (index + 010a/010b/010c) against the Hivenectar knowledge corpus and the cited Honeycomb transport code, armed with quality-stinger + hivenectar-stinger. This is a PRD-vs-corpus/code pass: PRD-010 is a straddle PRD whose transport already ships in Honeycomb and whose data surface (`describe_model`) is carried from PRD-005, so there is no Hivenectar implementation to diff. Every acceptance criterion and load-bearing claim was traced to `ai/enricher-and-llm-model.md` (Gemini 2.5 Flash rationale, model comparison table, `describe_model` audit, server-side cache posture), `ai/brooding-pipeline.md` (batch call shape), and the real files under `honeycomb/src/daemon/runtime/inference/` and `honeycomb/src/daemon/runtime/vault/`. Matches the bar and format of the consolidated PRD-001-004 report and the PRD-005 report.

**Related:**
- [`prd-010-portkey-gateway-index.md`](../prd-010-portkey-gateway-index.md)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md)
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md)
- [`../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md`](../../../reports/2026-07-01-prd-001-004-corpus-conformance-qa.md)

---

## 1. Summary

PRD-010 is the transport-reuse module and is exceptionally well-grounded. All fifteen module + sub-PRD acceptance criteria trace to a corpus doc or a Honeycomb code citation, every cited Honeycomb symbol exists, and the load-bearing DECISION #6 (semantic cache and guardrails are Portkey-server-side, no client toggle) is documented honestly and matches the code: the `KNOWN_SETTING_KEYS` allow-list carries `portkey.enabled` / `portkey.config` / `portkey.fallbackToProvider` and no `portkey.cache` / `portkey.guardrails` key, so AC-010c.2.1 and AC-010c.2.2 verify TRUE against source. The model comparison table is carried verbatim from the corpus, and both DEFAULT-confirm flags (Gemini `gemini-2.5-flash`, the `/v1/chat/completions` endpoint) are preserved. Notably, PRD-010 does NOT carry the systemic honeycomb-code-as-markdown-link defect (W-1/W-3 in the prior reports): every honeycomb code reference is already a canonical backtick file-path span, and the Related-section cross-links resolve at the correct relative depth (the PRD-005 W-2 MASTER-PRD-INDEX depth error is not repeated here). The module **PASSES with one warning** to the medium-and-above standard: **zero Critical findings** and **one medium Warning** (W-1), a single line-drift citation defect in 010a where the "missing/malformed usage surfaces zero" claim is pinned to the wrong line range. Two sub-medium notes are recorded.

## 2. Verdict Scorecard (per sub-PRD)

| Sub-PRD | Completeness | Correctness | Alignment | Gaps | Detrimental Patterns | Verdict |
|---|---|---|---|---|---|---|
| PRD-010 index | PASS | PASS | PASS | PASS | PASS | PASS |
| PRD-010a | PASS | WARNING (W-1) | PASS | PASS | PASS | PASS-with-warnings |
| PRD-010b | PASS | PASS | PASS | PASS | PASS | PASS |
| PRD-010c | PASS | PASS | PASS | PASS | PASS; note N-1 | PASS |

## 3. Critical Issues (must fix)

None.

## 4. Warnings (should fix)

### W-1 (Correctness, 010a): "missing/malformed usage surfaces zero" is pinned to the wrong line range

`prd-010a-portkey-transport-reuse.md:59` reads: "A missing/malformed `usage` surfaces zero counts rather than throwing (`transport-portkey.ts:277-278`)." The claim is TRUE, but the cited coordinates do not contain the mechanism that produces the behavior. Lines 277-278 are the `cacheCreationInputTokens` comment and field:

```272:279:honeycomb/src/daemon/runtime/inference/transport-portkey.ts
		model: call.target.model,
		workload: call.request.workload,
		inputTokens: u.prompt_tokens,
		outputTokens: u.completion_tokens,
		cacheReadInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
		// Portkey's OpenAI-shaped usage has no cache-WRITE field; surface 0 (never fabricate).
		cacheCreationInputTokens: 0,
	};
```

The behavior the sentence describes (a response with absent/null/malformed `usage` surfacing zero rather than throwing) is enforced by the zod schema, specifically the `.catch(ZERO_PORTKEY_USAGE)` on the response `usage` field at `transport-portkey.ts:183` and the per-field `.catch(0).default(0)` guards at `transport-portkey.ts:165-172`. PRD-010c cites this correctly at `prd-010c-semantic-cache-and-guardrails.md:63` ("A missing/malformed `usage` surfaces zero counts rather than throwing (`transport-portkey.ts:183`)"), so 010a is inconsistent with its own sibling.

Impact: an implementer verifying the "surfaces zero, never throws" invariant against `:277-278` would find the cache-write comment, not the schema catch, and could conclude the guard is absent. No runtime impact (the code is correct), but the citation must point at the mechanism it claims. This is the same class of defect the prior reports treat as a Warning (grounded-citation accuracy).

**Remediation:** In `prd-010a:59`, change the second parenthetical from `(transport-portkey.ts:277-278)` to `(transport-portkey.ts:183; schema field guards at :165-172)`. Leave the first citation on that line (`transport-portkey.ts:271-279` for the `UsageSink` mapping) unchanged; it is correct. Do not touch the honeycomb source.

## 5. Suggestions (consider improving) and sub-medium notes

- **N-1 (Alignment / precision, 010c and 010a):** The PRDs describe `portkey.enabled` / `portkey.config` / `portkey.fallbackToProvider` as "vault keys" and phrase AC-010c.2.1 / AC-010c.2.2 as "Given the vault schema, then no `portkey.cache` ... key exists" (`prd-010c:56-57`, `:64`). In Honeycomb these are `setting`-class keys (daemon-readable, curated by the `/api/settings` allow-list), explicitly distinct from the `secret` class (`vault/api.ts:5-18` documents that a setting is daemon-readable while a secret is names-only). They are persisted through the `VaultStore`, so "vault" is defensible, but "vault schema" blurs the setting-vs-secret boundary Honeycomb is careful about. Sub-medium; consider "the `setting`-class allow-list" for precision. No correctness impact: the underlying claim (no cache/guardrail key exists) is TRUE.
- **N-2 (citation completeness, 010c):** `prd-010c:64` grounds "the vault keys that DO exist" in `vault/api.ts:53-58`, which is the doc-comment prose describing the three keys. The enforced allow-list is the `KNOWN_SETTING_KEYS` array at `vault/api.ts:68-77` (`portkey.enabled` at `:74`, `portkey.config` at `:75`, `portkey.fallbackToProvider` at `:76`). The doc-comment citation is accurate, but the array is the authoritative artifact an implementer would check against; consider citing `:68-77` alongside `:53-58`. Sub-medium; both citations resolve and support the claim.

## 6. Plan Item (AC) Traceability

### PRD-010 index (5 ACs)

| AC (index) | Corpus / code source | Verdict |
|---|---|---|
| AC-1 POSTs `/v1/chat/completions` with `x-portkey-api-key` + `x-portkey-config` from `buildPortkeyHeaders` | `transport-portkey.ts:95-101` (headers), `:247` (headers used in POST), `:74`/`:77`/`:220` (URL) | PASS |
| AC-2 no explicit model resolves to Gemini 2.5 Flash (`activeModel` default) | `model-client-factory.ts:97-98` (model = vault `activeModel`, D-2), `:406` (model into Portkey target); default value flagged DEFAULT at `prd-010b:84` | PASS |
| AC-3 `brood --force --model <new>` resets non-skipped rows to pending, re-describes, stamps new `describe_model` | corpus `enricher-and-llm-model.md:143` (`brood --force --model <new>`), `:105` (`describe_model`); `brooding-pipeline.md:141-144` (`--force`) | PASS (mechanic owned by PRD-007/016; interaction owned here) |
| AC-4 `describe_model` records the producing model | corpus `enricher-and-llm-model.md:46`, `:105` | PASS |
| AC-5 no client vault key for cache/guardrails; server-side via `portkey.config` (DECISION #6) | `vault/api.ts:68-77` (`KNOWN_SETTING_KEYS`, no cache/guardrail key); corpus `enricher-and-llm-model.md:48` | PASS (must-preserve honored) |

### PRD-010a transport reuse (4 ACs)

| AC (010a) | Source | Verdict |
|---|---|---|
| AC-010a.1.1 POST to `PORTKEY_CHAT_COMPLETIONS_URL` with `buildPortkeyHeaders(resolvedKey, configId)` | `transport-portkey.ts:220` (url), `:247` (headers), `:95-101` (builder) | PASS |
| AC-010a.1.2 maps request verbatim via `toPortkeyBody`; `model` = target model; `max_tokens` always sent | `transport-portkey.ts:192-202` (`:198` model, `:199` max_tokens) | PASS |
| AC-010a.1.3 network/transport failure throws `ProviderError` `statusCode: 503`, status string only | `transport-portkey.ts:254-256` | PASS |
| AC-010a.2.1 failure path carries short status string only, never body or key | `transport-portkey.ts:256`, `:263`; doc invariant `:34-36`, `:38-41` | PASS |

### PRD-010b model selection + describe_model (6 ACs)

| AC (010b) | Source | Verdict |
|---|---|---|
| AC-010b.1.1 no override resolves `model` to `activeModel` default (Gemini 2.5 Flash) | `model-client-factory.ts:97-98`, `:399-406` (`buildPortkeyConfig` target model) | PASS (default value flagged DEFAULT) |
| AC-010b.1.2 configurable via `activeModel`; swap to Haiku/GPT-4.1/Ollama without code change | `vault/api.ts:74` (`activeModel` key), `:48-49` (doc); corpus `enricher-and-llm-model.md:46` | PASS |
| AC-010b.2.1 `brood --force --model <new>` resets every non-skipped row to `pending` | corpus `enricher-and-llm-model.md:143`; `brooding-pipeline.md:141-144` | PASS |
| AC-010b.2.2 forced re-description stamps `describe_model` to the new id | corpus `enricher-and-llm-model.md:46`, `:105` | PASS |
| AC-010b.3.1 `describe_model` records the producing model id per row | corpus `enricher-and-llm-model.md:46` | PASS |
| AC-010b.3.2 cosmetic inherit sets `describe_model = inherited-from:<prev_content_hash>` at Jaccard >= `REDESCRIBE_THRESHOLD` | corpus `enricher-and-llm-model.md:105` (marker), `:108` (threshold default 0.85) | PASS |

### PRD-010c server-side cache + guardrails (4 ACs)

| AC (010c) | Source | Verdict |
|---|---|---|
| AC-010c.1.1 reported `cached_tokens` maps to `cacheReadInputTokens` on the `UsageSink` | `transport-portkey.ts:276` | PASS |
| AC-010c.1.2 omitted cached-token details surface `cacheReadInputTokens = 0` (never fabricates) | `transport-portkey.ts:276` (`?? 0`), `:169` (schema default), `:183` (`.catch`) | PASS |
| AC-010c.2.1 no `portkey.cache` / `portkey.cacheEnabled` key exists | `vault/api.ts:68-77` (`KNOWN_SETTING_KEYS`; key absent) | PASS (verified against source) |
| AC-010c.2.2 no `portkey.guardrails` key exists | `vault/api.ts:68-77` (key absent) | PASS (verified against source) |

## 7. Deliberate items preserved (NOT flagged as gaps)

- **DECISION #6 (server-side-only cache + guardrails).** PRD-010c documents semantic caching and guardrails as Portkey-server-side via the `portkey.config` id, with no client toggle, and both rejected alternatives (a cache-enabled config-id vault key; a client-side response cache) recorded. This matches corpus `enricher-and-llm-model.md:48` and the code: no `portkey.cache` / `portkey.guardrails` key exists in `KNOWN_SETTING_KEYS` (`vault/api.ts:68-77`). The PRD does NOT invent a client-side cache or guardrail toggle. This is the CORRECT documentation of the deliberate gap, not a finding.
- **DEFAULT-confirm flags.** `prd-010b:84` flags `gemini-2.5-flash` as `[DEFAULT - confirm before implementation]`, and `prd-010a:65` flags the `https://api.portkey.ai/v1/chat/completions` endpoint likewise. Both preserved.
- **Model comparison table carried verbatim.** `prd-010b:34-39` reproduces the corpus table (`enricher-and-llm-model.md:37-42`) character-for-character, including the four model rows, the `$3.05` Gemini total, and the "(quality risk)" GPT-4o-mini annotation. The "2000-file brood / 1500 small files" framing is carried faithfully from the corpus (the corpus uses the same phrasing at `:35-37`); not a divergence.
- **`REDESCRIBE_THRESHOLD` default 0.85** is grounded (corpus `:105`, `:108`), not invented. Symbol/directory-level description is preserved as a stated v1 non-goal (`prd-010b:26`).
- **Reuse-not-fork posture.** 010a correctly frames the transport as reused from Honeycomb (`createPortkeyTransport`), with no Hivenectar-authored transport, matching ADR-0002 (mirror, do not import).

## 8. High-risk surfaces verified against source (spot-check, drift recorded)

All cited Honeycomb symbols exist. Line ranges are accurate except the single W-1 drift.

- `PORTKEY_BASE_URL = "https://api.portkey.ai/v1"` at `transport-portkey.ts:74` (exact).
- `PORTKEY_CHAT_COMPLETIONS_URL` at `transport-portkey.ts:77` (exact).
- `buildPortkeyHeaders(apiKey, configId)` returning `{x-portkey-api-key, x-portkey-config, content-type}` at `transport-portkey.ts:95-101` (exact).
- `toPortkeyBody` at `transport-portkey.ts:192-202`; `model: call.target.model` at `:198`; `max_tokens` always sent at `:199` (exact).
- Error mapping: network failure to `ProviderError(503, ...)` at `transport-portkey.ts:254-256`; non-2xx to `ProviderError(res.status, ...)` at `:258-263`; the cited span `:256-263` straddles both (accurate).
- Secret-never-logged invariant doc at `transport-portkey.ts:34-36` and `:38-41` (exact); enforced at the throw sites (`:256`, `:263`, body never included).
- Usage seam: `cached_tokens` to `cacheReadInputTokens` at `transport-portkey.ts:276`; `cacheCreationInputTokens: 0` at `:277-278`; `UsageReport` mapping at `:271-279` (exact).
- Malformed-usage-surfaces-zero mechanism at `transport-portkey.ts:183` (`.catch(ZERO_PORTKEY_USAGE)`) and field guards `:165-172`. This is where 010a:59 SHOULD point (see W-1); 010c:63 points here correctly.
- `PortkeySelection.model` = vault `activeModel` (D-2) at `model-client-factory.ts:97-98`; `buildPortkeyConfig(model)` at `:399`; `model` into the target at `:406` (cited `:404-406`, exact); `createPortkeyTransport` call at `:362-368` sends `portkey.model`.
- Setting-class keys `portkey.enabled` / `portkey.config` / `portkey.fallbackToProvider`: doc comment at `vault/api.ts:53-58`; enforced allow-list `KNOWN_SETTING_KEYS` at `:68-77`; `portkey.config` control-character / non-empty-when-enabled validation at `:271-288`. No `portkey.cache` / `portkey.guardrails` key present.

## 9. Documentation-framework conformance (honeycomb code-reference form)

Clean. Every honeycomb code reference in the PRD-010 files is a canonical backtick file-path span (for example `transport-portkey.ts:74`, `vault/api.ts:53-58`), NOT a markdown link to a non-resolving `../../../../honeycomb/...` target. The systemic W-1/W-3 finding from the PRD-001-004 and PRD-005 reports is ABSENT here.

Link-form honeycomb token counts (markdown links whose target is a honeycomb path):

| File | Link-form honeycomb tokens | Notes |
|---|---|---|
| `prd-010-portkey-gateway-index.md` | 0 | honeycomb refs are backtick spans; Related links target sibling PRDs, `knowledge/`, and `MASTER-PRD-INDEX.md` |
| `prd-010a-portkey-transport-reuse.md` | 0 | full-path honeycomb ref at `:52` is a plain backtick span, not a link |
| `prd-010b-model-selection-and-describe-model.md` | 0 | |
| `prd-010c-semantic-cache-and-guardrails.md` | 0 | |
| **Total** | **0** | |

Cross-link depth also resolves correctly (the PRD-005 W-2 defect is not repeated): the Related-section `[...](../../../requirements/MASTER-PRD-INDEX.md)` links at `prd-010-...-index.md:69` and `prd-010c-...:79` resolve to `library/requirements/MASTER-PRD-INDEX.md` (three levels up from `in-work/prd-010-portkey-gateway/` reaches `library/`, then `requirements/MASTER-PRD-INDEX.md`), and the `../../../knowledge/private/ai/...` links resolve to `library/knowledge/private/ai/...`. Both targets exist.

Remediation recipe (for future divergence, not needed this pass): if any honeycomb ref is ever authored as `[`honeycomb/...`](../../../../honeycomb/...)`, drop the markdown-link wrapper and keep only the backtick span (per Documentation Framework section 6 and `AGENTS.md`). Verify with `grep -rnoE '\]\(\.\./\.\./\.\./\.\./honeycomb[^)]*\)' *.md` in the PRD folder returning zero. As of this audit it already returns zero.

## 10. Files Audited

- `prd-010-portkey-gateway-index.md` - audited (clean).
- `prd-010a-portkey-transport-reuse.md` - audited (carries W-1).
- `prd-010b-model-selection-and-describe-model.md` - audited (clean).
- `prd-010c-semantic-cache-and-guardrails.md` - audited (clean; note N-1, N-2).

No PRD content, corpus, or code was modified by this audit (report-only, per quality-stinger). The `qa/` folder was created to hold this report.

**Overall verdict: PASS-with-warnings** (medium-and-above). Zero Critical findings. One medium Warning (W-1: the "missing/malformed usage surfaces zero" claim in `prd-010a:59` is pinned to `:277-278`, but the mechanism lives at `transport-portkey.ts:183` / `:165-172`; corrected). The spec substance passes cleanly: all fifteen ACs trace to corpus or code, every cited Honeycomb symbol exists with no drift beyond W-1, DECISION #6's server-side-only cache/guardrails story is documented honestly and verified against the code (no client cache/guardrail key exists), both DEFAULT-confirm flags are preserved, the model comparison table is verbatim, and the honeycomb code-reference form is fully conformant (zero link-form tokens, zero broken cross-links).

## Remediation addendum (2026-07-01, the-smoker Wave B) — post-remediation verdict: PASS (clean at medium+)

- **W-1 resolved:** `prd-010a:59` citation corrected from `(transport-portkey.ts:277-278)` to `(transport-portkey.ts:183; schema field guards at :165-172)`, pointing at the actual `.catch(ZERO_PORTKEY_USAGE)` mechanism that produces the "surfaces zero, never throws" behavior (now consistent with the sibling citation at `prd-010c:63`). The first citation on that line (`transport-portkey.ts:271-279`, the `UsageSink` mapping) was left unchanged (correct). No honeycomb source touched.
- **Sub-medium (carried forward, not blocking):** N-1 ("vault schema" vs the more precise "setting-class allow-list") and N-2 (cite the `KNOWN_SETTING_KEYS` array at `vault/api.ts:68-77` alongside the doc-comment `:53-58`). Both are precision suggestions; the underlying claims are TRUE.
