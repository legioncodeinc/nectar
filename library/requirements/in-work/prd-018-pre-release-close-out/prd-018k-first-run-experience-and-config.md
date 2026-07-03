# PRD-018k: First-run experience and the config file

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M (0.5-1d)
> **Schema changes:** None

---

## Overview

This epic fixes the two gaps a brand-new user hits before any code path even gets a chance to fail: the daemon boots and silently describes nothing because brooding's prerequisites are undocumented and unmet (NEC-023), and the `~/.honeycomb/nectar.json` config file that two knowledge docs promise for per-repo tunables does not exist in any form (NEC-041).

The mission ("analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed") begins with leg 1: brood the codebase. Today a user who installs nectar, runs the daemon, and waits gets a healthy `/health`, zero descriptions, and no explanation. The spec says brooding "triggers automatically"; the code agrees only when two undocumented prerequisites (Deep Lake credentials and three Portkey env vars) are already in place. Making the dormancy loud and the prerequisites documented is the difference between "works on first run" and "appears broken on first run".

## Goals

- A daemon booting without brooding prerequisites says so loudly: a startup log line naming the missing prerequisites, and a `/health` field that reports brooding as dormant with the reason.
- The prerequisites (`~/.deeplake/credentials.json`; `NECTAR_PORTKEY_ENABLED`, `NECTAR_PORTKEY_API_KEY`, `NECTAR_PORTKEY_CONFIG`) are documented in the README and the public getting-started guide.
- The spec claim that brooding "triggers automatically" (`brooding-pipeline.md:138`) is reconciled with reality: either a guided first-run path is implemented or the spec is corrected. Both options are presented below; this epic recommends and defaults to correcting the spec plus loud dormancy signaling, with the guided prompt as an optional stretch.
- The `~/.honeycomb/nectar.json` config-file loader is implemented for the spec'd per-repo tunables (redescribe threshold, recall multiplier), with environment variables taking precedence; or the file is formally de-spec'd from both knowledge docs. This epic recommends implementing, since two knowledge docs promise it.

## Non-Goals

- Wiring the update-on-change pipeline or the mutating CLI verbs. PRD-018b owns wiring; this epic only makes the first-run state honest about what is and is not active.
- Rewriting the public guides' command examples and the broader docs truth pass. PRD-018l owns that; this epic contributes only the prerequisite documentation for brooding.
- API auth and host binding. PRD-018j owns those.
- The recall RRF multiplier's actual fusion behavior. The config loader here makes the knob loadable; whether and how the search engine consumes `nectar_rrf_multiplier` remains scoped to the recall engine's own spec-conformance work (the recall review notes fusion is deliberately "no cross-table arm-class weighting" per PRD-012a).

---

## NEC-023: Brooding is dormant out of the box, silently

**Issue restated.** Auto-brood on boot exists, but it runs only when Deep Lake credentials resolve AND Portkey is explicitly enabled via `NECTAR_PORTKEY_ENABLED` plus `NECTAR_PORTKEY_API_KEY` plus `NECTAR_PORTKEY_CONFIG` (default: disabled). Out of the box the daemon boots, serves `/health`, and describes nothing, with no warning beyond the provider bits in `/health`. The spec meanwhile promises brooding "triggers automatically the first time hiveantennae runs against a project with no hive_graph rows (or no nectars.json)".

**Evidence** (spec-drift review, drift matrix row 9 and the leg A mission check):

- `src/cli.ts:611-616` (both brood paths require credentials plus the Portkey trio)
- `src/portkey/config.ts:61-81` (absent env means Portkey off)
- `src/daemon.ts:460-497` (auto-brood gating)
- Spec claim contradicted: `brooding-pipeline.md:138` ("triggers automatically")
- Neither prerequisite is documented in README or any public doc; without them the daemon boots, serves `/health`, and does nothing, with no warning that brooding is dormant beyond the `/health` provider bits (spec-drift review, leg A)

**Failure mode.** The first-run experience is indistinguishable from a broken install. A user following the getting-started guide sees a running daemon and an empty index, with no pointer to the two missing prerequisites.

**Fix direction.**

1. Surface the dormancy. At startup, when the brood gate fails, log one loud line enumerating exactly which prerequisites are missing (credentials file absent; which of the three `NECTAR_PORTKEY_*` vars is unset). Add a `/health` field (for example `brooding: { active: false, reason: "portkey_disabled" | "credentials_missing" | ... }`) so supervision and humans can both see it.
2. Document the prerequisites. README and `library/knowledge/public/guides/getting-started-with-nectar.md` gain a prerequisites section: `~/.deeplake/credentials.json`, `NECTAR_PORTKEY_ENABLED`, `NECTAR_PORTKEY_API_KEY`, `NECTAR_PORTKEY_CONFIG`, and what each unlocks. (PRD-018l's docs pass will carry the same content into its truth sweep; coordinate to avoid conflicting edits.)
3. Reconcile the spec claim. Two options, decide during implementation:
   - Option A (recommended default): correct `brooding-pipeline.md:138` to state that auto-brood triggers automatically once credentials and Portkey are configured, and cross-link the prerequisites. Cheap, honest, no new surface.
   - Option B (stretch): implement a guided first-run prompt: when the CLI detects the dormant state on an interactive terminal, print the exact steps (or prompt) to configure the prerequisites. More work, better experience; can land after option A without conflict.

---

## NEC-041: `~/.honeycomb/nectar.json` is spec'd but unwired

**Issue restated.** Two knowledge docs promise a per-repo config file at `~/.honeycomb/nectar.json` carrying tunables: the enricher's redescribe threshold and the recall multiplier. No code anywhere reads such a file; all tunables are code-level parameters or `NECTAR_*` env vars.

**Evidence** (spec-drift review, drift matrix row 18):

- Spec promises: `ai/enricher-and-llm-model.md:108` (redescribe threshold "configurable and tunable per-repo via `~/.honeycomb/nectar.json`"); `data/recall-integration.md:105-113` (`nectar_rrf_multiplier` knob)
- Code status: `src/enricher/config.ts:4` (the filename appears in a comment only); `src/config.ts:66-83` (config resolution is env-only)
- Corroborating: spec-drift drift matrix row 7 ("no code anywhere reads `~/.honeycomb/nectar.json`") and the recall review's spec-conformance note that the multiplier knob is unimplemented

**Failure mode.** A user who follows either knowledge doc and writes the file sees no effect and no error. The docs promise a configuration surface the product ignores.

**Fix direction.** Two options; this epic recommends implementing, since two shipped knowledge docs promise the file:

- Option A (recommended): implement a small loader for `~/.honeycomb/nectar.json`.
  - Scope it to the spec'd tunables only: the redescribe threshold (`ai/enricher-and-llm-model.md:108`) and the recall multiplier (`data/recall-integration.md:105-113`). No speculative keys.
  - Precedence: environment variables win over the file; the file wins over code defaults. Document the precedence in both knowledge docs.
  - Fail-soft on malformed JSON: log a warning, fall back to env/defaults; never crash the daemon over a config typo.
  - Unknown keys are ignored with a warning (forward compatibility).
- Option B: formally de-spec the file. Remove the promise from `ai/enricher-and-llm-model.md:108` and `data/recall-integration.md:105-113`, and note the removal in the docs. Choose this only if the team decides per-repo tunables are not wanted before release.

---

## Acceptance criteria

| ID | Acceptance criterion |
|---|---|
| AC-018k.1 | Given a daemon booting with no `~/.deeplake/credentials.json`, when startup completes, then a startup log line names the missing credentials file as the reason brooding is dormant. |
| AC-018k.2 | Given a daemon booting with credentials present but any of `NECTAR_PORTKEY_ENABLED`, `NECTAR_PORTKEY_API_KEY`, `NECTAR_PORTKEY_CONFIG` unset, when startup completes, then the startup log names the specific unset variable(s). |
| AC-018k.3 | Given a dormant-brooding daemon, when `GET /health` is served, then the body contains a brooding-status field reporting inactive with a machine-readable reason; given a fully configured daemon, the field reports active. |
| AC-018k.4 | Given the README and `library/knowledge/public/guides/getting-started-with-nectar.md`, when read, then both document the brood prerequisites (`~/.deeplake/credentials.json` and the three `NECTAR_PORTKEY_*` variables). |
| AC-018k.5 | Given `brooding-pipeline.md:138`, when the epic lands, then the "triggers automatically" claim either matches implemented behavior (option B guided first-run) or is corrected to state the prerequisites (option A); the spec and the code no longer disagree. |
| AC-018k.6 | Given a valid `~/.honeycomb/nectar.json` containing the redescribe threshold, when the enricher config resolves and no overriding env var is set, then the file's value is used; given the corresponding env var is also set, the env var wins. |
| AC-018k.7 | Given a valid `~/.honeycomb/nectar.json` containing the recall multiplier key, when config resolves, then the value is loaded and exposed to the recall configuration surface (env precedence identical to AC-018k.6). |
| AC-018k.8 | Given a malformed `~/.honeycomb/nectar.json`, when the daemon boots, then it logs a warning and proceeds on env/defaults; it does not crash. |
| AC-018k.9 | Given `~/.honeycomb/nectar.json` contains an unknown key, when the loader runs, then the key is ignored with a logged warning. |
| AC-018k.10 | Given option B (de-spec) is chosen instead of the loader, when the epic lands, then `ai/enricher-and-llm-model.md:108` and `data/recall-integration.md:105-113` no longer promise the file, and AC-018k.6 through AC-018k.9 are recorded as waived in this PRD. |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/daemon.ts` | modify | Dormant-brooding detection at boot (`:460-497` gate); loud startup log; feeds the health field. |
| `src/health.ts` | modify | Brooding-status field in the `/health` body. |
| `src/cli.ts` | modify | Prerequisite check surfaced where the brood gate lives (`:611-616`); optional guided first-run prompt (option B stretch). |
| `src/config.ts` | modify | `~/.honeycomb/nectar.json` loader with env-over-file precedence (option A). |
| `src/enricher/config.ts` | modify | Redescribe threshold sourced through the loader (`:4` comment becomes real). |
| `src/hive-graph/search.ts` | modify | Recall multiplier config surface consumes the loaded value (wiring only; fusion semantics out of scope). |
| `README.md` | modify | Brood prerequisites section. |
| `library/knowledge/public/guides/getting-started-with-nectar.md` | modify | Prerequisites documented before the first-scan instructions. |
| `library/knowledge/private/ai/brooding-pipeline.md` | modify | Line 138 "triggers automatically" reconciled per the chosen option. |
| `library/knowledge/private/ai/enricher-and-llm-model.md` | modify | Config-file precedence documented (option A) or promise removed (option B) at `:108`. |
| `library/knowledge/private/data/recall-integration.md` | modify | Same treatment for `:105-113`. |
| `test/daemon.test.ts` | modify | Dormancy log and gating coverage. |
| `test/health.test.ts` | modify | Brooding-status field coverage. |
| `test/fixes.test.ts` | modify | Config-file loader precedence, malformed-file fail-soft, unknown-key warning. |
| `test/enricher.test.ts` | modify | Redescribe threshold sourced from the file when env is unset. |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018k.1 | `test/daemon.test.ts` | Boot with a fake credentials resolver returning absent; capture the log seam; assert the line names the credentials file. |
| AC-018k.2 | `test/daemon.test.ts` | Boot with credentials present and `NECTAR_PORTKEY_API_KEY` unset; assert the log names that variable. |
| AC-018k.3 | `test/health.test.ts` | Health body includes `brooding` inactive with reason when dormant; active when the gate passes. |
| AC-018k.4 | `test/fixes.test.ts` | Doc-lint assertion: grep README and the getting-started guide for `NECTAR_PORTKEY_ENABLED` and `.deeplake/credentials.json`; both must appear. (Shares the doc-scan harness PRD-018l introduces.) |
| AC-018k.5 | `test/fixes.test.ts` | Doc-lint assertion: `brooding-pipeline.md` line for the auto-trigger claim mentions the prerequisites (option A) or the guided flow exists (option B). |
| AC-018k.6 | `test/fixes.test.ts` | Write a temp `nectar.json` with a threshold; resolve enricher config with and without the env var; assert precedence order. |
| AC-018k.7 | `test/fixes.test.ts` | Same harness for the recall multiplier key; assert the value reaches the recall config surface. |
| AC-018k.8 | `test/fixes.test.ts` | Malformed JSON in the file; assert warning logged and defaults used, no throw. |
| AC-018k.9 | `test/fixes.test.ts` | Unknown key in the file; assert warning logged and key ignored. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-023, NEC-041)
- [`../../../notes/2026-07-02-spec-drift-review.md`](../../../notes/2026-07-02-spec-drift-review.md) (drift matrix rows 9 and 18; leg A mission check; recommended action 7)
- [`../../../notes/2026-07-02-recall-review.md`](../../../notes/2026-07-02-recall-review.md) (spec-conformance note: `nectar_rrf_multiplier` unimplemented)
- [`../../../knowledge/private/ai/brooding-pipeline.md`](../../../knowledge/private/ai/brooding-pipeline.md) (the "triggers automatically" claim at :138)
- [`../../../knowledge/private/ai/enricher-and-llm-model.md`](../../../knowledge/private/ai/enricher-and-llm-model.md) (config-file promise at :108)
- [`../../../knowledge/private/data/recall-integration.md`](../../../knowledge/private/data/recall-integration.md) (multiplier knob at :105-113)
- [`../../../knowledge/public/guides/getting-started-with-nectar.md`](../../../knowledge/public/guides/getting-started-with-nectar.md) (the guide gaining the prerequisites section)
