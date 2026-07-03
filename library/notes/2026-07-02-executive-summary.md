# Nectar Pre-Release Review — Executive Summary (2026-07-02)

Mission under audit: **"analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed."**

Baseline: typecheck clean, 451/452 tests pass (1 skipped). The suite is green but does not exercise the failure modes below — most findings live in wiring, concurrency, and platform behavior the unit tests fake out.

Five detailed reports accompany this summary in this folder:

- `2026-07-02-brooding-review.md` — brooding pipeline
- `2026-07-02-change-detection-review.md` — NodeFS watcher / registration ladder / poll loop
- `2026-07-02-recall-review.md` — hive-graph search, embeddings, enricher
- `2026-07-02-daemon-api-review.md` — daemon lifecycle, lock, HTTP API, projection, service install
- `2026-07-02-spec-drift-review.md` — spec-vs-code drift matrix, public docs, end-to-end mission gaps

## Verdict by mission leg

**Leg 1 — brood an entire codebase: works, with real risk at scale.** The pipeline runs end to end, but descriptions are only persisted after the whole describe+embed stage (`pipeline.ts` Stage 6), so a mid-run kill loses all paid LLM work despite the spec's committed-write-per-file resumability contract. `prepareFiles` retains full bytes of every discovered file in memory for the whole run (OOM risk on monorepos), and a whole-batch transport failure retries ~50 files solo, turning one 429 into a request storm. Re-runs never refresh changed files (resume keys on nectar existence, not content hash).

**Leg 2 — update upon change with NodeFS: not functional.** This is the headline. `WatchIntake`, `RegistrationService`, and the re-association ladder are fully built and tested, but nothing in the shipped daemon or CLI ever constructs them — they are only re-exported from `index.ts` (127-128, 163-164) and the daemon boots its worker with `emptyJobSource` (`daemon.ts:366-367`). Three independent review passes converged on this. There is also no cold catch-up (`requestResync()` is never called on start), so offline edits are never reconciled. Even once wired: ignore rules drift between brooding (git-based) and watching (segment-based), directory renames are dropped silently, a watcher error kills the watcher permanently with no restart, and the fixed TLSH normalization mis-associates tiny files above the auto-carry band.

**Leg 3 — recall as needed: works, but ranking correctness is in doubt.** The vector arm orders `(1 + (embedding <#> vec))/2 DESC` while the repo's own spec defines `<#>` as cosine distance ordered ascending — under that convention the semantic arm returns the least similar files first. Tests fake the storage layer so this is never caught; it needs one integration test against real Deep Lake before release. Beyond that: the enricher's working set is hydrated once at boot (post-boot changes wait for a daemon restart), a file deleted mid-batch can shift descriptions onto the wrong files, all storage errors collapse to empty results with `degraded: false`, and the lexical arm has no ORDER BY under its LIMIT.

## Cross-cutting criticals

1. **Double-daemon via lock rollback (verified by live repro).** A failed `start()` — including failing precisely because another daemon is already running — rolls back through `shutdown()`, which unconditionally deletes the lock and pid files (`daemon.ts:584`, `lock.ts` release has no ownership check). The next start then succeeds alongside the live daemon. Compounded by non-atomic stale-lock reclaim and PID-reuse wedging.
2. **Public docs teach a product that doesn't exist yet.** `library/knowledge/public/` instructs `honeycomb nectar brood` / `review-matches`; the real binary is `nectar` and the mutating commands exit 2 as "wiring pending" stubs (`cli.ts:478-483`). The docs also promise agent-mediated recall while the only working surface is the undocumented `nectar search`.
3. **Fresh clones get permanently degraded recall.** Projection inherit writes `embedding: null` with status `described`; the enricher only selects `pending`, so inherited rows are never re-embedded — BM25-only forever, contradicting `portable-registry.md`.
4. **Concurrency between brooding and the enricher.** Both operate on the same rows with read-then-append `nextSeq`, risking duplicate LLM spend and seq collisions; auto-brood bypasses the `/build` in-flight guard.

## Suggested order of attack

1. Fix the lock rollback (ownership check on release) — small, catastrophic, verified.
2. Wire the registration service + watcher into the daemon, with cold-start resync — this is the missing mission leg.
3. Settle the `<#>` ordering question with one real-storage integration test; fix whichever side is wrong.
4. Make brooding persist per-batch (resumability contract) and stream file reads.
5. Unify ignore semantics between discovery and watch.
6. Fix inherit-status so clones re-embed; hydrate the enricher continuously rather than at boot.
7. Reconcile public docs with the actual CLI surface before anyone outside reads them.

Full detail, severity ratings, and file:line citations are in the five per-area reports.
