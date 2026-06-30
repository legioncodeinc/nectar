# PRD-010: Portkey gateway integration

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Overview

All Hivenectar LLM calls route through the existing Portkey gateway rather than calling any model provider directly. The brooding batch calls and the enricher's single-file calls reuse Honeycomb's already-shipped Portkey transport (`buildPortkeyHeaders` + `PORTKEY_BASE_URL`, hitting `/v1/chat/completions`) so Hivenectar sends no new transport code to the gateway. The default model is **Gemini 2.5 Flash** (the Pareto-optimal point on the model comparison table, see `prd-010b`); the operator swaps models with `brood --force --model <new>`, and the `describe_model` column audits which model produced each description. Semantic caching and guardrails are **Portkey-server-side** features configured in the Portkey dashboard via the `portkey.config` / virtual-key id — this codebase carries **no client toggle** for either (DECISION #6). **This index covers the module scope.** Sub-feature PRDs cover the transport reuse, model selection, and the server-side cache/guardrails story separately.

---

## Goals

- Every brooding and enricher description call routes through Portkey's `/v1/chat/completions` using the existing `buildPortkeyHeaders` + `PORTKEY_BASE_URL`, never a direct provider call.
- The default model resolves to Gemini 2.5 Flash (`activeModel` vault setting) with the model comparison table carried verbatim as the rationale.
- `brood --force --model <new>` forces re-description under a swapped model and stamps the new `describe_model` on each re-described row.
- The `describe_model` column records which model produced each description so a model swap is auditable.
- Semantic caching and guardrails are documented honestly as Portkey-server-side `portkey.config` behavior, with no client vault key introduced to enable or disable either.

## Non-Goals

- A client-side response cache. Portkey already maintains a server-side semantic cache; a second cache duplicates it and adds an invalidation surface that does not fit the 30–50-file batch shape (DECISION #6, alternative rejected).
- A client vault key that selects a cache-enabled config id. The codebase only *accounts for* upstream cached tokens in the usage seam; it does not do the caching.
- Hardcoding the model. Gemini 2.5 Flash is the **default**, configurable via `activeModel` / `portkey.config`.
- Automatic re-description on a model swap. Existing descriptions stay valid until the operator runs `brood --force --model <new>`.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-010a-portkey-transport-reuse`](./prd-010a-portkey-transport-reuse.md) | Reuse `buildPortkeyHeaders` + `PORTKEY_BASE_URL`; route brooding/enricher calls to `/v1/chat/completions` | Draft |
| [`prd-010b-model-selection-and-describe-model`](./prd-010b-model-selection-and-describe-model.md) | Default Gemini 2.5 Flash; `brood --force --model <new>`; `describe_model` audit column (carries the model comparison table verbatim) | Draft |
| [`prd-010c-semantic-cache-and-guardrails`](./prd-010c-semantic-cache-and-guardrails.md) | DECISION #6: document semantic cache + guardrails as Portkey-SERVER-SIDE via `portkey.config`; no client toggle | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given Portkey is enabled + keyed, when the brooding/enricher call runs, then it POSTs `https://api.portkey.ai/v1/chat/completions` with the `x-portkey-api-key` + `x-portkey-config` headers from `buildPortkeyHeaders`. |
| AC-2 | Given no explicit model is set, when a description is generated, then the requested model resolves to Gemini 2.5 Flash (`activeModel` default). |
| AC-3 | Given the operator runs `brood --force --model <new>`, then every non-skipped row is reset to `pending` and re-described under the new model, with `describe_model` stamped to the new id. |
| AC-4 | Given any description is produced, then the `source_graph_versions.describe_model` column records the model that produced it. |
| AC-5 | Given semantic caching / guardrails are in effect, then no client vault key enables or disables either; both are Portkey-server-side via the `portkey.config` id (DECISION #6). |

---

## Data model changes

None at the table level. The existing `describe_model` column on `source_graph_versions` is the audit surface this PRD populates (carried over from PRD-005's schema; see `ai/enricher-and-llm-model.md`).

---

## API changes

None. Portkey routing is an internal transport concern, not an exposed endpoint. The `--force --model` flag extends the `brood` CLI surface (owned jointly with PRD-007).

---

## Related

- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — DECISION #6 (Portkey cache is server-side) and the PRD-010 entry.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — Gemini 2.5 Flash rationale, the model comparison table, `describe_model` audit, server-side cache/guardrails posture.
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) — batch call shape the transport carries.
