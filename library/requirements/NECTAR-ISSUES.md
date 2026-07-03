# Nectar Pre-Release Issues (2026-07-02)

Consolidated from the six review reports in `nectar/library/notes/`. Each issue is self-contained and tagged for handoff to Claude Code. All paths are relative to `nectar/`. Mission under audit: "analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed."

Baseline at review time: typecheck clean, 451/452 tests pass. Everything below is untested wiring, concurrency, or platform behavior the unit suite fakes out.

---

## Critical

- [x] **NEC-001 — NodeFS update-on-change pipeline is dead code.** `WatchIntake`, `RegistrationService`, and the re-association ladder are built and tested but never constructed by the daemon or CLI — only re-exported (`src/index.ts:127-128,163-164`). Daemon boots with `emptyJobSource` (`src/daemon.ts:366-367`); `brood`/`prune`/`review-matches` CLI commands exit 2 as "wiring pending" stubs (`src/cli.ts:478-483`). The service also consumes the sync store and cannot be wired to the async Deep Lake store as-is. Mission leg 2 is non-functional. *Fix: wire RegistrationService + WatchIntake into daemon start, adapt to async store, unstub CLI.*

- [x] **NEC-002 — Failed daemon start deletes the live daemon's lock → double daemon (verified by live repro).** Start rollback calls `shutdown()` (`src/daemon.ts:563-569`), which unconditionally `releaseSingleInstanceLock` (`src/daemon.ts:584`; `src/lock.ts` release does `rmSync` with no ownership check). A start that fails *because another daemon is running* deletes that daemon's lock; the next start succeeds alongside it. *Fix: only release a lock the current process acquired.*

- [x] **NEC-003 — Brooding loses all paid LLM work on mid-run kill.** Descriptions accumulate in memory and persist only in Stage 6 after the entire describe+embed stage (`src/brooding/pipeline.ts:434→480-499`; async variant `src/brooding/pipeline-async.ts:321→367`), contradicting the spec's committed-write-before-next-file resumability contract. *Fix: persist per batch (or per file) as descriptions arrive.*

- [x] **NEC-004 — Public docs teach commands that don't exist.** `library/knowledge/public/guides/` instructs `honeycomb nectar brood` / `review-matches`; the binary is `nectar` and the mutating commands are stubs (see NEC-001). Docs also promise agent-mediated recall while the only working surface, `nectar search`, is documented nowhere. *Fix: reconcile public docs with the real CLI surface before release.*

## High

- [x] **NEC-005 — Semantic ranking likely inverted.** Vector arm orders `(1 + (embedding <#> vec))/2 DESC` (`src/hive-graph/search.ts:121-127`) but the corpus defines `<#>` as cosine *distance* ordered ascending (`recall-integration-deep-dive` tech spec :113). If so, recall returns the *least* similar files first. Tests mock storage so it's never caught. *Fix: one integration test against real Deep Lake; correct whichever side is wrong.*

- [x] **NEC-006 — No cold catch-up on daemon start.** Nothing calls `requestResync()` (`src/registration/service.ts:133-135`); auto-brood only fires on empty projects (`src/daemon.ts:460-497`). Offline edits/renames are never reconciled. *Fix: resync on start once NEC-001 lands.*

- [x] **NEC-007 — Ignore rules drift between brooding and watching.** Brooding discovery uses `git ls-files` without segment/graph-ignore rules (`src/brooding/discovery.ts:136-146`); the watcher uses segment rules without `.gitignore` (`src/registration/ignore.ts:98-112`). Result: `.env`/`dist/` get minted and enrich-queued by one leg while graph-ignored files get LLM-described by the other. *Fix: single shared ignore predicate.*

- [x] **NEC-008 — Directory renames dropped silently.** Dir-level watch events are discarded (`src/registration/disk-fs.ts:28`, `src/registration/classify.ts:33-38`); all children keep stale paths with no resync fallback.

- [x] **NEC-009 — Watcher error kills the watcher permanently.** `fs.watch` error (e.g. Linux inotify ENOSPC) is only logged (`src/registration/fs-watch.ts:124`) — no restart, no poll fallback, no health flag.

- [x] **NEC-010 — TLSH fuzzy matching mis-associates tiny files.** Confidence normalizes by fixed MAX_DISTANCE=801 (`src/registration/tlsh.ts:42,154-158`), so unrelated ~10-byte files score ≥0.87, above the 0.85 auto-carry band; `MIN_FUZZY_BYTES=3` is far too low. Wrong nectar carried between unrelated files.

- [x] **NEC-011 — Enricher races brooding on the same rows.** Enricher polls `pending`/`failed` every 30s (`src/enricher/pending-query.ts:30-40`) while a brood writes those rows; `nextSeq` is read-then-append (`src/hive-graph/deeplake-store.ts:379-389`) → duplicate LLM spend + seq collisions. Auto-brood also bypasses the `/build` `broodInFlight` guard → concurrent broods double-mint.

- [x] **NEC-012 — Whole-tree memory residency during brooding.** `prepareFiles` reads and retains full bytes of every discovered file for the run, including known-binary and >256KB files that need no read (`src/brooding/precheck.ts:56-82`). OOM risk on monorepos. *Fix: stream/hash then drop bytes; skip reads for pre-excluded files.*

- [x] **NEC-013 — Batch describe failure → solo retry storm.** A whole-call transport failure retries all ~50 files individually (`src/brooding/describe.ts:159-163`, `src/brooding/pipeline.ts:447-459`); batch calls inherit `max_tokens=4096` (`src/portkey/transport.ts:18`) vs the spec's 2-4K batch output → predictable JSON truncation → same storm; `finish_reason` never checked; 15s timeout is tight for batches.

- [x] **NEC-014 — Positional batch-parse fallback can attach the wrong description.** `entries[i]` fallback (`src/brooding/describe.ts:180-185`) without the spec-required array-length validation silently persists mismatched descriptions.

- [x] **NEC-015 — Enricher can attach descriptions to the wrong files.** `src/enricher/cycle.ts:117-146` re-reads content around the LLM call and realigns by a manually-advanced index; a file deleted mid-batch shifts every later description/embedding one slot, stored as `described` and served forever.

- [x] **NEC-016 — Enricher working set frozen at boot.** `DeepLakeEnricherStore` hydrates once at daemon start (`src/cli.ts:665`); post-boot pending/failed rows wait for a restart. Stale recall after change.

- [x] **NEC-017 — Enrichment writes use a pattern the codebase calls unreliable.** Fire-and-forget in-place `UPDATE` (`src/enricher/store-adapter.ts:93-99`, `src/enricher/sql-update.ts`) on a table declared append-only (`src/hive-graph/schema.ts:82`) — the exact stale-snapshot pattern documented in `deeplake-store.ts:344-359`. Described files may never surface in recall.

- [x] **NEC-018 — Switching embedding providers mixes vector spaces.** Local nomic and hosted `text-embedding-3-small` are both 768-dim; no `embed_model` column or re-embed invalidation, so flipping `NECTAR_EMBEDDINGS_PROVIDER` silently corrupts cosine comparisons with `degraded: false`.

- [x] **NEC-019 — Fresh clones get permanently degraded recall.** Projection inherit writes `embedding: null` with status `described` (`src/projection/inherit.ts:85,90`); the enricher only selects `pending` → inherited rows never re-embed. Contradicts `portable-registry.md:85`. BM25-only forever.

- [x] **NEC-020 — Lock: non-atomic stale reclaim + PID-reuse wedge.** rm-then-retry reclaim (`src/lock.ts:79-86`) lets two supervisor restarts both win; a reused PID reads as "already running" (`src/lock.ts:66-108`) → crash-loop every 5s until manual lock deletion.

- [x] **NEC-021 — Shutdown hangs forever behind one active request.** `server.ts:132-138` never force-closes active connections and `POST /build` runs a minutes-long brood in-request → supervisor SIGKILL → stale lock.

- [x] **NEC-022 — systemd template omits the node interpreter.** `src/service/templates.ts:106` (launchd/schtasks prefix `process.execPath`; systemd doesn't) → infinite 5s crash loop on nvm-installed Linux (`StartLimitIntervalSec=0`).

- [x] **NEC-023 — Brooding dormant out of the box.** Auto-brood requires undocumented `~/.deeplake/credentials.json` + `NECTAR_PORTKEY_*` env; spec says it "triggers automatically" on first run (`brooding-pipeline.md:138`).

## Medium

- [x] **NEC-024 — Recall error swallowing.** Every storage error returns `[]` (`src/hive-graph/search.ts:235-250`; missing-table classification is dead code) and `degraded: false` is reported when the semantic arm silently failed (`search.ts:377`).
- [x] **NEC-025 — Lexical arm has no ORDER BY under LIMIT** (`src/hive-graph/search.ts:96-104`) — nondeterministic subset, meaningless RRF ranks.
- [x] **NEC-026 — Jaccard cosmetic-change inheritance is dead code.** `classifyMeaningfulChange`/`applyCosmeticInheritance` exported and tested, invoked nowhere — every whitespace edit pays a full re-describe.
- [x] **NEC-027 — One bad `describe_status` row poisons tenancy scans** (`src/hive-graph/deeplake-store.ts:73-78` throws inside hydrate/list) — breaks projection rebuilds, empties the enricher.
- [x] **NEC-028 — Embedding dim-rejection sink never wired** (`src/api/daemon-api-wiring.ts:107`); a wrong `NECTAR_EMBEDDINGS_OUTPUT_DIMENSION` silently nulls all embeddings.
- [x] **NEC-029 — No API auth; unauthenticated `?project=` tenancy override on every endpoint incl. `/build`** (`src/api/hive-graph-api.ts:134-143`); `NECTAR_HOST` can rebind off loopback with no gate.
- [x] **NEC-030 — Two restart authorities** (OS unit restart + doctor registry policy) contend on one lock; compounds NEC-002.
- [x] **NEC-031 — Enricher-cycle projection regeneration spec'd but unwired** (`src/enricher/cycle.ts:266` seam never filled by `src/cli.ts:618-629`) → committed `nectars.json` goes stale in steady state.
- [x] **NEC-032 — Doctor registry write non-atomic and drops unknown top-level keys** (`src/doctor-registry.ts:216-222`); doctor's fail-loud reader can hit a torn file.
- [x] **NEC-033 — Shutdown doesn't drain** in-flight worker job or `bootSettled` before `process.exit(0)` (`src/daemon.ts:572-600`).
- [x] **NEC-034 — Case-only renames (APFS/NTFS) classify as copies** (`src/registration/ladder.ts:143-154`) — duplicate nectar minted, old identity stranded.
- [x] **NEC-035 — Ladder step-2 no-op never refreshes stored mtime/size** (`src/registration/ladder.ts:131-135`) — after `git checkout`/touch, every observation re-hashes forever.
- [x] **NEC-036 — Non-atomic multi-write ladder actions + lossy review queue.** insertIdentity→appendVersion and carry→remove→delete are not atomic across crashes; file-backed review store loses concurrent daemon+CLI updates (`src/registration/review-store.ts:128-140`).
- [x] **NEC-037 — Duplicate-content files collapse to one nectar on inherit** (`src/projection/load.ts:271-279`, `src/projection/inherit.ts:118-136`) — dup seq-0 rows, orphaned nectars.
- [x] **NEC-038 — Brood resume never refreshes changed files** (resume keys on nectar existence, ignores content hash) — re-runs skip modified files.
- [x] **NEC-039 — Any git error silently degrades discovery to a walk that ignores `.gitignore`** (incl. ENOBUFS at 64MB) — cost blowup and `.env` exposure.
- [x] **NEC-040 — Corpus/docs contradictions:** cost $2 (`overview.md:67`) vs $3.05 (`brooding-pipeline.md`, `src/brooding/cost.ts:49`); AGENTS.md claims PRD-002-only status while PRD-003–017 code exists; README lists working `rebuild-projection` as not-ready and omits `search`; five corpus sites still use `honeycomb nectar ...` prefixes (ADR-0002 sweep never done).
- [x] **NEC-041 — `~/.honeycomb/nectar.json` config file spec'd but unwired.**

## Low (batch as one cleanup pass)

- [x] **NEC-042 —** Malformed JSON body → 500 not 400 (`src/api/router.ts:279-285`); launchd log dir never created; systemd reinstall lacks `daemon-reload`; telemetry opt-out honors only literal `"0"`; `ILIKE` pattern lacks `ESCAPE` clause (`search.ts:86` vs `sql-guards.ts:91-100`); same-ms ULIDs non-monotonic (`src/hive-graph/ulid.ts:36`); `.lock` extension misclassifies text lockfiles as binary (and `--force`-unrecoverable); O(tenancy) by-path/by-hash lookups; debounce has no max-wait; symlink contract diverges between watch and resync; backslash-in-filename corruption on POSIX; API `limit: 0` silently becomes 20; no permission check on credentials file; spec shows `sha256-`-prefixed hashes the code rejects.

---

**Suggested order:** NEC-002 (small, catastrophic) → NEC-001/006 (missing mission leg) → NEC-005 (ranking correctness) → NEC-003/012/013 (brooding durability/scale) → NEC-007 (ignore parity) → NEC-019/016 (recall freshness) → NEC-004/040 (docs) → the rest.

Full failure-mode analysis and fix directions: `nectar/library/notes/2026-07-02-*.md`.
