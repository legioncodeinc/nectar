# PRD-010c: Semantic cache and guardrails (Portkey-server-side)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XS (< 1h)
> **Schema changes:** None

---

## Overview

This is a documentation sub-PRD, not an implementation sub-PRD. Per DECISION #6, Portkey semantic caching and guardrails are **server-side features configured in the Portkey dashboard** via the `portkey.config` / virtual-key id — they are not toggled in this codebase. The codebase only *accounts for* upstream cached tokens when Portkey reports them (through the transport's existing usage seam); it does not maintain a client-side semantic cache and it does not introduce a separate cache-enabled vault key. This document records that posture honestly so the implementation does not invent a client toggle the architecture deliberately rejects.

---

## Goals

- Document semantic caching as a Portkey-server-side `portkey.config` feature: enabled and tuned in the Portkey dashboard, not in this codebase.
- Document guardrails as likewise Portkey-server-side via the config id.
- Confirm the codebase accounts for upstream cached tokens through the transport's existing `UsageSink` seam (no separate accounting path).

## Non-Goals

- A client vault key that selects a cache-enabled config id. DECISION #6 rejects this (the alternative "implies the client does the caching").
- A client-side response cache. DECISION #6 rejects this (it duplicates Portkey's server-side cache, adds an invalidation surface, and does not fit the 30–50-file batch shape).
- A client toggle for guardrails. Guardrails travel with the `portkey.config` id the gateway applies upstream.

---

## The server-side posture (DECISION #6)

Semantic caching is configured in the Portkey dashboard (server-side via the `portkey.config` / virtual-key id), not toggled in this codebase. Brooding and enricher calls route through Portkey with the configured virtual key / `portkey.config`; cache behavior is enabled and tuned in the dashboard. The codebase records and accounts for cached-token effects when Portkey reports them, but it does not maintain a client-side semantic cache and it does not introduce a separate "cache-enabled" vault key. Guardrails are likewise Portkey-server-side via the config id.

The two alternatives DECISION #6 explicitly rejects:

1. **A client vault key that selects a cache-enabled config id** — rejected because it implies the client does the caching.
2. **A client-side response cache** — rejected because it duplicates Portkey's server-side cache, adds an invalidation surface, and does not fit the 30–50-file batch call shape.

---

## User stories

### US-010c.1 — Account for cached tokens without enabling caching

**As a** cost reviewer, **I want to** upstream cached tokens recorded when Portkey reports them, **so that** cost accounting stays accurate under the gateway's server-side cache.

**Acceptance criteria:**
- AC-010c.1.1 Given a successful Portkey call that reports `prompt_tokens_details.cached_tokens`, then the transport maps it to `cacheReadInputTokens` on the `UsageSink` seam (`transport-portkey.ts:276`).
- AC-010c.1.2 Given a response that omits cached-token details, then the transport surfaces `cacheReadInputTokens = 0` (never fabricates).

### US-010c.2 — No client toggle for caching or guardrails

**As a** maintainer, **I want to** no client vault key for cache-enable or guardrail-enable, **so that** the architecture's server-side posture stays intact.

**Acceptance criteria:**
- AC-010c.2.1 Given the vault schema, then no `portkey.cache` / `portkey.cacheEnabled` key exists (caching is server-side via `portkey.config`).
- AC-010c.2.2 Given the vault schema, then no `portkey.guardrails` key exists (guardrails are server-side via `portkey.config`).

---

## Implementation notes

- **The usage seam is the only client touchpoint.** The transport feeds `cacheReadInputTokens` from `prompt_tokens_details.cached_tokens` (`transport-portkey.ts:276`); `cacheCreationInputTokens` stays `0` because Portkey's OpenAI-shaped usage has no cache-WRITE field (`transport-portkey.ts:277-278`). A missing/malformed `usage` surfaces zero counts rather than throwing (`transport-portkey.ts:183`).
- **The vault keys that DO exist** are `portkey.enabled`, `portkey.config`, and `portkey.fallbackToProvider` (`vault/api.ts:53-58`); `portkey.config` carries the config / virtual-key id that selects the server-side cache + guardrail behavior. There is no cache-specific or guardrail-specific key.
- **Do not add a client response cache.** The batch call packs 30–50 files per round-trip (`ai/brooding-pipeline.md`); a client-side cache keyed on the batch body would invalidate on any one-file change and add surface without benefit.

---

## Flagged defaults

None. This sub-PRD documents an already-locked decision (DECISION #6); it introduces no configurable default.

---

## Related

- [`./prd-010-portkey-gateway-index.md`](./prd-010-portkey-gateway-index.md)
- [`./prd-010a-portkey-transport-reuse.md`](./prd-010a-portkey-transport-reuse.md) — owns the usage seam this sub-PRD references.
- [`../../../requirements/MASTER-PRD-INDEX.md`](../../../requirements/MASTER-PRD-INDEX.md) — DECISION #6.
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) — the server-side cache/guardrails posture.
