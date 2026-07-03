# PRD-018j: API security and doctor-registry hardening

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (0.5-1d)
> **Schema changes:** None

---

## Overview

This epic closes two hardening gaps on the daemon's outward surfaces: the HTTP API's unauthenticated cross-project override (NEC-029) and the doctor-registry file's non-atomic, lossy rewrite (NEC-032).

The mission ("analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed") assumes the daemon's tenancy boundaries hold and its supervision contract with doctor is durable. Today any local process can read another project's titles and descriptions or brood the local tree into another project's Deep Lake tenancy with billable LLM calls, and every `nectar install` rewrite of `~/.honeycomb/doctor.daemons.json` can hand doctor a torn file or silently discard keys other tools put there. Both are small, contained fixes with outsized blast radius if left unfixed at release.

## Goals

- The `?project=` tenancy override is dropped or allowlist-validated, at minimum on `POST /api/hive-graph/build`, so no unauthenticated caller can write into another project's tenancy.
- The daemon refuses to start with `allowAllPermission` when `NECTAR_HOST` is bound off loopback.
- Doctor-registry writes are atomic (temp file plus rename in the same directory) and preserve unknown top-level keys.
- The concurrent-install read-modify-write race on the registry is documented as a known limitation (fix optional; see Non-Goals).

## Non-Goals

- Lock lifecycle, stale-lock reclaim, PID reuse, shutdown drain, and the two-restart-authorities contention. Those belong to PRD-018a (daemon lock and lifecycle). This epic hardens the registry file write itself; who restarts the daemon is 018a's problem.
- Malformed-JSON-body status codes and the API `limit: 0` behavior. Those are enumerated Low items in PRD-018l's cleanup batch.
- A full authentication scheme for the API. The loopback-only `allowAllPermission` posture is documented and accepted for this release; this epic closes the two holes that break even that posture (cross-tenancy override, non-loopback bind with no gate).
- First-run credential documentation and the config file. PRD-018k owns those.

---

## NEC-029: No API auth plus an unauthenticated `?project=` tenancy override on every endpoint including `/build`

**Issue restated.** The default permission gate is `allowAllPermission`, a documented loopback posture. But the scope resolver additionally honors a per-request `?project=<id>` override on every endpoint. Any local process can read another project's data, or worse, brood the local tree's files into another project's tenancy. Compounding this, `NECTAR_HOST` can rebind the daemon off loopback with no gate at all.

**Evidence** (daemon review, M3):

- `src/api/router.ts:117-118` and `src/daemon.ts:379` (default gate is `allowAllPermission`)
- `src/api/hive-graph-api.ts:134-143` (`defaultScopeResolver` honors `?project=` on every endpoint)
- `src/api/daemon-api-wiring.ts:152-161` (`args.scope` is used as the brood tenancy, so `POST /build?project=X` broods the local tree into project X)
- `src/config.ts:72` (`NECTAR_HOST` rebinds off loopback with no gate)

**Failure mode.** Two concrete attacks from any local process, no credentials needed:

1. `GET /api/hive-graph/search?project=X` reads project X's titles and descriptions in the same workspace.
2. `POST /api/hive-graph/build?project=X` broods the local tree's files into project X's tenancy in Deep Lake: cross-project row pollution plus billable LLM calls charged to the operator.

If an operator sets `NECTAR_HOST` to a non-loopback address (for example to reach the daemon from a container), both attacks become network-reachable with no permission gate whatsoever.

**Fix direction** (expanded from the daemon review):

1. Drop the `?project=` override, or validate it against an allowlist of projects the daemon is legitimately serving. At minimum the override must be removed from `POST /build`, the mutating and billable endpoint.
2. Refuse to start when `allowAllPermission` is the active gate and the resolved `host` is non-loopback. The error message should name both the config knob and the risk.
3. Add the missing coverage the daemon review calls out (test-coverage gap 3): a test that exercises `?project=` against `/build`.

---

## NEC-032: Doctor-registry write is non-atomic and drops unknown top-level keys

**Issue restated.** `nectar install` rewrites `~/.honeycomb/doctor.daemons.json` with a plain in-place `writeFileSync` (no temp file plus rename, unlike the projection writer in the same codebase), and it serializes only `{ daemons }`, discarding any other top-level key an operator or another tool stored in the file.

**Evidence** (daemon review, M5):

- `src/doctor-registry.ts:221-222` (`writeFileSync` in place, no temp+rename)
- `src/doctor-registry.ts:216-222` (rewrite serializes only `{ daemons }`; unknown top-level keys silently discarded)
- `src/doctor-registry.ts:19-25` (module doc: doctor's reader is fail-loud on malformed registries, so a torn mid-write read is not benign)
- Contrast: `src/projection/write.ts:56-73` already implements the correct atomic temp+rename pattern in this repo

**Failure mode.** Doctor polls this file. A reader that hits the torn or empty mid-write state can error out or drop supervision of every registered daemon, not just nectar. Separately, any top-level metadata another product wrote into the registry is lost on the next `nectar install`.

**Known race (documented, not necessarily fixed here).** Concurrent installs of two products (for example nectar and hive installing simultaneously) perform read-modify-write with no serialization; one entry can be lost. This epic must at minimum document the race in the module doc; an advisory-lock fix is welcome but not required for release.

**Fix direction** (expanded from the daemon review):

1. Write via temp file plus `rename` in the same directory as the registry (same-directory rename is what makes it atomic on the same filesystem), mirroring `projection/write.ts:56-73`.
2. Preserve unknown keys: parse the existing root object, spread it, and replace only the `daemons` key when serializing.
3. Add a module-doc note (and a code comment at the write site) naming the concurrent-install read-modify-write race.

---

## Acceptance criteria

| ID | Acceptance criterion |
|---|---|
| AC-018j.1 | Given a request to `POST /api/hive-graph/build?project=X` where X differs from the daemon's own project scope, when the request is dispatched, then it is rejected (or X is validated against an explicit allowlist); the brood never runs under a caller-chosen tenancy. |
| AC-018j.2 | Given a request to `GET /api/hive-graph/search?project=X`, when the `?project=` override has been dropped or allowlisted per the chosen design, then a non-allowlisted X does not resolve to another project's tenancy scope. |
| AC-018j.3 | Given `NECTAR_HOST` resolved to a non-loopback address and `allowAllPermission` as the active gate, when the daemon starts, then startup is refused with an error naming the host config and the missing permission gate. |
| AC-018j.4 | Given `NECTAR_HOST` at its loopback default, when the daemon starts with `allowAllPermission`, then startup proceeds exactly as before (no regression to the documented loopback posture). |
| AC-018j.5 | Given a doctor-registry rewrite, when the write occurs, then it lands via temp file plus rename in the registry's own directory; no code path performs an in-place `writeFileSync` on `doctor.daemons.json`. |
| AC-018j.6 | Given an existing registry containing an unknown top-level key (for example `{"schemaHint": 1, "daemons": {...}}`), when `nectar install` rewrites the file, then the unknown key survives byte-for-byte and only `daemons` is replaced. |
| AC-018j.7 | Given the registry module, when reviewed, then the concurrent-install read-modify-write race is named in the module doc and at the write site. |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `src/api/hive-graph-api.ts` | modify | `defaultScopeResolver` (`:134-143`) drops or allowlist-validates `?project=`; `/build` never accepts a caller-chosen tenancy. |
| `src/daemon.ts` | modify | Startup refusal when `allowAllPermission` is active and the resolved host is non-loopback. |
| `src/config.ts` | modify | Expose a loopback check on the resolved host (`:72`) for the startup gate. |
| `src/doctor-registry.ts` | modify | Temp+rename write in the same directory; spread the parsed root and replace only `daemons` (`:216-222`); race documented in the module doc. |
| `test/hive-graph-api.test.ts` | modify | `?project=` rejection/allowlist coverage on search and build. |
| `test/api-router.test.ts` | modify | Scope resolution regression coverage under the new resolver behavior. |
| `test/daemon.test.ts` | modify | Non-loopback + `allowAllPermission` startup refusal; loopback default unaffected. |
| `test/doctor-registry.test.ts` | modify | Atomic write shape; unknown-key preservation. |

---

## Tests to add

| AC | Test file | Scenario |
|---|---|---|
| AC-018j.1 | `test/hive-graph-api.test.ts` | POST `/build?project=other-project`; assert rejection (or allowlist miss) and that the brood runner was never invoked with the foreign scope. |
| AC-018j.2 | `test/hive-graph-api.test.ts` | GET `/search?project=other-project`; assert the resolved scope is not the foreign tenancy under the chosen design. |
| AC-018j.3 | `test/daemon.test.ts` | Assemble the daemon with `NECTAR_HOST=0.0.0.0` and the default gate; assert `start()` rejects with the named error before binding. |
| AC-018j.4 | `test/daemon.test.ts` | Default loopback host with the default gate; assert startup succeeds (regression guard). |
| AC-018j.5 | `test/doctor-registry.test.ts` | Spy the fs seam during a registry write; assert a temp-file write followed by a same-directory rename, and no direct write to the final path. |
| AC-018j.6 | `test/doctor-registry.test.ts` | Seed a registry with an extra top-level key; run the upsert; assert the key survives and `daemons` was replaced. |
| AC-018j.7 | `test/doctor-registry.test.ts` | Assertion-light companion: the module exports/doc mention the race (or covered by review checklist; a comment-presence check is acceptable). |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-029, NEC-032)
- [`../../../notes/2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) (M3, M5; test-coverage gap 3)
- [`../../../knowledge/private/architecture/`](../../../knowledge/private/architecture/) (ADR-0003 registered-daemon topology: loopback `/health`, doctor registry entry; ADR-0004 hive boundaries: data leaves only via `/api/*`)
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) (the atomic temp+rename precedent this epic mirrors)
