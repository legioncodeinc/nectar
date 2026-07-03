# PRD-018l: Docs truth pass and low-severity cleanup batch

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Overview

This epic is the release truth pass plus the batched Low-severity cleanup. It has three parts: rewrite the public docs to the CLI surface that actually runs (NEC-004), fix the corpus's internal contradictions and stale status claims (NEC-040), and knock out the roughly fourteen small, self-contained defects the reviews filed as one batch (NEC-042).

The mission is "analyze an entire code base using the brooding process, update it upon change with NodeFS, and recall it as needed." The public docs are the first thing a user touches, and today every command they teach is wrong or refuses to run, while the one recall surface that works (`nectar search`) is documented nowhere. A release whose docs describe a different product than the binary poisons trust before the first brood. The Low batch, individually harmless, collectively adds up to a rough first week: 500s where 400s belong, lost launchd logs, phantom telemetry opt-outs, and a spec whose example projection fails validation.

## Goals

- Every command example in `library/knowledge/public/` and README runs as written against the shipped binary.
- The corpus carries one cost figure, one accurate status block, and zero `honeycomb nectar` command prefixes (completing the sweep ADR-0002 claims was done).
- All fourteen NEC-042 items are fixed, each with at least one acceptance-criterion row and a test.
- A lint-style docs check exists so dead commands cannot silently reappear in the guides.

## Non-Goals

- Wiring `brood`, `prune`, and `review-matches` for real. PRD-018b owns the update-on-change wiring; this epic only makes the docs match whatever reality exists at merge time. If 018b lands first, the docs document the wired verbs; if not, the docs document `nectar brood --dry-run`, `nectar search`, and `nectar rebuild-projection` and mark the rest as pending.
- The brood prerequisites documentation content. PRD-018k authors that section; this epic's sweep must not conflict with it (coordinate on `getting-started-with-nectar.md` and README).
- API auth and the `?project=` override (PRD-018j), lock lifecycle (PRD-018a), and ranking correctness (PRD-018h). The NEC-042 items touching the API (`400` on malformed JSON, `limit: 0`) are boundary-behavior fixes, not auth work.
- Agent-mediated recall (Honeycomb 4th arm, MCP surface). Out of repo and spec-stage; the docs pass softens those promises to future tense rather than implementing them.

---

## NEC-004: Public docs teach commands that do not exist

**Issue restated.** The public guides instruct `honeycomb nectar brood` / `review-matches`; the shipped binary is `nectar`, and the mutating verbs exit 2 as "wiring pending" stubs. The docs also promise agent-mediated recall while the only working surface, `nectar search`, is documented nowhere.

**Evidence** (spec-drift review, "Public docs: promises vs reality" table):

- `public/guides/getting-started-with-nectar.md:32,44,87` ("Run the first scan: `honeycomb nectar brood`", "`honeycomb nectar brood --limit 100`"); mutating `nectar brood` exits 2 (`src/cli.ts:327-335`)
- `getting-started:86` and `keeping-descriptions-accurate.md:23-45,49-58` (automatic freshness promises; the watcher is never started, spec-drift rows 1-2)
- `overview/what-is-nectar.md:54`, `getting-started:71-77`, `sharing-understanding:58` ("You will not open a Nectar search box... through your AI coding assistant"; inverted: the only working surfaces are `nectar search` and the HTTP endpoint)
- `keeping-descriptions-accurate.md:68-75,99` (`review-matches` framed as fixing wrong descriptions; the verb exits 2 and its spec'd purpose is identity fuzzy-match review per `ai/identity-and-reassociation.md:138`)
- `keeping-descriptions-accurate.md:56` (copy carrying over the original's description: not implemented and not in the private spec either)
- `sharing-understanding:52-58`, `nectar-privacy-and-cost-faq.md:44-48,75-81` (teammate "immediately has working semantic recall": inherited rows never re-embed, PRD-018i's NEC-019)

**Failure mode.** A user follows the getting-started guide verbatim and cannot complete a single step. Worse, the guides teach recovery procedures (`review-matches` for bad descriptions) that neither run nor would achieve the stated goal if they did.

**Fix direction.**

1. Rewrite every command example to the real CLI surface: `nectar brood --dry-run`, `nectar search`, `nectar rebuild-projection` today; plus the wired `brood`/`prune`/`review-matches` if PRD-018b has landed by then.
2. Document `nectar search <query> [--limit N] [--json]` as the recall surface, in the guides and README.
3. Soften or future-tense the agent-mediated-recall promises ("works through your AI coding assistant") and the automatic-freshness promises until the corresponding legs ship; same for merge reconciliation and branch-switch grace prose in `keeping-descriptions-accurate.md` and `sharing-understanding-with-your-team.md`.
4. Correct the `review-matches` framing to its spec'd purpose (low-confidence identity matches, not description repair).
5. Remove or future-tense the copy-carries-description claim (`keeping-descriptions-accurate.md:56`); it is in neither the code nor the private spec.

---

## NEC-040: Corpus and repo-doc contradictions

**Issue restated.** The corpus contradicts itself on cost, AGENTS.md reports a status ten PRDs stale, README is stale in both directions, and the `honeycomb nectar` prefix sweep that ADR-0002 records as done was never completed.

**Evidence** (spec-drift review, drift matrix rows 10, 14, 25, 26, 27):

- Cost: `overview.md:67` says "under $2"; `brooding-pipeline.md:107-116` computes $3.05; code carries $3.05 verbatim (`src/brooding/cost.ts:36-52`); README says "under $3". `overview.md` is the outlier; fix it, not the others.
- Prefix sweep: ADR-0002:57 claims "The corpus sweep records the change at each affected site", yet five-plus private-corpus sites still command `honeycomb nectar ...`: `brooding-pipeline.md:141-147`, `identity-and-reassociation.md:138,214`, `hive-graph-schema.md:155`, `portable-registry.md:121`, `enricher-and-llm-model.md:143`; README `:174` demos `honeycomb recall`.
- AGENTS.md: `AGENTS.md:24-30` claims "The current implementation status is PRD-002 (the daemon)" while PRD-003 through PRD-017 code exists under `src/`; the repo layout tree omits `api/`, `brooding/`, `embeddings/`, `enricher/`, `hive-graph/`, `portkey/`, `projection/`, `registration/`, `service/`, `telemetry/`.
- README stale in both directions: `README.md:152-162` lists working `rebuild-projection` as not ready and omits `search` (and `brood --dry-run`) from the CLI list entirely.
- README `:102` still describes the recall arm as "A `UNION ALL` arm", contradicting locked decision #2 in `MASTER-PRD-INDEX.md` (the corpus's `recall-integration.md:66` was corrected; README was not).

**Failure mode.** Three documents give three different costs; an agent reading AGENTS.md plans against a repo ten PRDs behind reality; a contributor reading README believes a working verb is broken.

**Fix direction.** Fix `overview.md:67` to the $3.05 figure; sweep every `honeycomb nectar` (and README's `honeycomb recall`) prefix to the `nectar` binary; rewrite AGENTS.md's status block and layout tree to the shipped module set; update README's CLI and status sections in both directions (add `search`, `rebuild-projection`, `brood --dry-run`; keep the honest not-wired notices for the rest); fix README:102 per decision #2.

---

## NEC-042: The Low-severity cleanup batch, enumerated

**Issue restated.** NECTAR-ISSUES.md batches roughly fourteen Low items into one paragraph. Each is enumerated here as its own checklist row with its citation, failure mode, and fix. All are small and self-contained; none changes schema or architecture.

| # | Item | Evidence | Fix |
|---|---|---|---|
| 1 | Malformed JSON body returns 500 instead of 400, and the body cache is poisoned: `parsedOnce = true` is set before the parse, so after one throw, later `body()` calls return `undefined` silently | `src/api/router.ts:279-285` (parse inside handler; `parsedOnce` set at `:281`); dispatcher catch at `router.ts:221-226` returns `500 handler_error` (daemon review L1) | Catch the parse error and map to a 400 client-error response; set `parsedOnce` only after a successful parse (or cache the thrown state and rethrow consistently) |
| 2 | launchd log directory is never created, so daemon stdout/stderr are silently lost on macOS | `src/service/templates.ts:89-92` (paths under `~/.honeycomb/nectar/`); macOS install mkdirps only the LaunchAgents dir (`src/service/index.ts:222-223`); the log dir is created only on the Windows path (`:219-221`) (daemon review L2) | Mkdirp the log directory during macOS install |
| 3 | systemd reinstall never runs `daemon-reload`, so a changed unit file may keep serving the cached unit | `src/service/argv.ts:65-67` (install is only `systemctl --user enable --now nectar.service`) (daemon review L3) | Run `systemctl --user daemon-reload` before `enable --now` |
| 4 | Telemetry opt-out honors only the literal `"0"`: `NECTAR_TELEMETRY=false`/`off` are silently ignored, while `DO_NOT_TRACK` accepts any non-`"0"` value; `emitUninstalled` also fires before the uninstall outcome is known | `src/telemetry-usage/emit.ts:141-146`; allow-list at `emit.ts:212-214`; `emitUninstalled` timing at `src/cli.ts:148` (daemon review L4) | Accept the falsy family (`0`, `false`, `off`, case-insensitive) for `NECTAR_TELEMETRY`; document default-on plus the switch in README (folds into this epic's docs pass); move `emitUninstalled` after the outcome is known |
| 5 | `ILIKE` pattern lacks an `ESCAPE` clause: `sqlLike` emits backslash escapes embedded in a plain literal, and whether `\%` survives to the ILIKE evaluator is dialect-dependent, contradicting `eLiteral`'s own guidance | `src/hive-graph/search.ts:86` vs `src/hive-graph/sql-guards.ts:91-100` (recall review L1) | Add an explicit `ESCAPE '\'` clause (or use `eLiteral` for the pattern) once semantics are confirmed with one integration probe |
| 6 | ULIDs are not monotonic within a millisecond; the module doc over-claims "lexicographic sortability by creation time" | `src/hive-graph/ulid.ts:36-38` (fresh randomness per call, no same-ms counter) (recall review L2) | Add a monotonic-within-ms counter (the standard `monotonicFactory` behavior) or soften the doc claim; either resolves the item |
| 7 | `.lock` extension misclassifies text lockfiles (`yarn.lock`, `Cargo.lock`, `Gemfile.lock`) as `skipped-binary`, and `--force` can never re-describe them; `ds_store` entry is unreachable dead config | `src/brooding/constants.ts:75`; force-block at `src/brooding/resumability.ts:40-42`; `extOf(".DS_Store")` returns `""` per `src/hive-graph/paths.ts:25-28` (brooding review L1) | Give lockfiles an honest terminal status (a `skipped-lockfile`-style status or a plain size rule) that `--force` semantics treat correctly; delete the dead `ds_store` entry |
| 8 | `latestVersionByPath` / `latestVersionByHash` fetch the entire tenancy per lookup: O(all identities + all version rows) per probe, on what becomes a per-file-event hot path once the ladder is wired | `src/hive-graph/deeplake-store.ts:476-484` delegating to `listLatestVersions` (`:410-438`) (recall review L3) | Predicate pushdown (`WHERE path = ...` / `WHERE content_hash = ...`), keeping the client-side MAX(seq) reduction |
| 9 | Watcher debounce has no max-wait: a file written more often than every 500ms never settles and is registered only when writes pause | `src/registration/fs-watch.ts:104-116` (timer cleared and re-armed per observation; 500ms default at `:39`) (change-detection review L1) | Cap total deferral (for example fire after 10x the debounce window regardless of continuing events) |
| 10 | Symlink contract diverges between watch and resync: `walk()` skips every symlink while `statPath`/`existsOnDisk` accept in-root symlinks, so a symlinked file registered via a live event is invisible to resync | `src/registration/disk-fs.ts:59` (walk skips) vs `disk-fs.ts:19-27,35-42` (`realpathContained` accepts) (change-detection review L2) | Pick one contract; suggested: skip symlinks in both paths, matching git's treatment |
| 11 | POSIX filenames containing a literal backslash are corrupted by discovery: `\` is rewritten to `/` in every path, so `a\b.ts` becomes `a/b.ts`, fails to stat, and is silently dropped | `src/brooding/discovery.ts:95` (brooding review L2) | Make the separator rewrite Windows-only (or drop it; git emits forward slashes on Windows already) |
| 12 | API `limit: 0` silently becomes 20, and the API accepts float limits (`2.9` truncates to 2) while the CLI validates strictly | `src/hive-graph/search.ts:44-50` (`resolveRecallLimit`); `src/api/hive-graph-api.ts:92-99`; CLI contrast at `src/cli.ts:365-384` (recall review L5) | Reject non-positive and non-integer limits with a 400 at `parseSearchRequest`, keeping the engine clamp as backstop |
| 13 | Credentials file is read with no permissions check: a 0644 `~/.deeplake/credentials.json` token file is consumed without warning | `src/hive-graph/deeplake-credentials.ts:91-125` (loader validates shape and redacts but never checks mode) (recall review L6) | Warn on group/other-readable modes at load, mirroring ssh's posture (advisory; nectar is not the file's writer) |
| 14 | Spec shows `sha256-`-prefixed hashes the code rejects: a projection hand-built from the spec example fails validation with `invalid_content_hash` | `portable-registry.md:47,55,66-67` vs `src/projection/format.ts:48-53` (bare 64-char lowercase hex, deliberate per its module doc) (daemon review L5) | Fix the doc examples to bare hex (the code's choice is the right one) |

---

## Acceptance criteria

Docs criteria are testable as checkable assertions: a docs-lint test scans the named files for the named patterns.

| ID | Acceptance criterion |
|---|---|
| AC-018l.1 | Given the docs-lint scan, when run over `library/` and `README.md`, then grep for `honeycomb nectar` returns zero command examples, and README contains no `honeycomb recall` demo. |
| AC-018l.2 | Given the public guides (`library/knowledge/public/`), when every fenced command line beginning with `nectar ` is extracted, then each command exists in `nectar --help` output and exits 0 on its happy path against a configured daemon (verbs documented as pending are marked as such and excluded from the run check). |
| AC-018l.3 | Given the public docs, when scanned, then `nectar search` is documented in at least the getting-started guide and README, and no present-tense claim remains that recall "works through your AI coding assistant" or that edits/renames are tracked automatically (future-tense or explicitly-pending phrasing is acceptable). |
| AC-018l.4 | Given `keeping-descriptions-accurate.md`, when read, then `review-matches` is described as low-confidence identity-match review (not description repair), and the copy-carries-description claim is removed or future-tensed. |
| AC-018l.5 | Given the corpus, when scanned, then exactly one first-scan cost figure ($3.05 for the 2000-file reference repo) appears across `overview.md:67`, `brooding-pipeline.md`, and README (rounding phrases like "about three dollars" that agree with $3.05 are acceptable; "under $2" is not). |
| AC-018l.6 | Given `AGENTS.md`, when read, then the implementation-status block names the shipped PRD range (through PRD-017) and the layout tree includes `api/`, `brooding/`, `embeddings/`, `enricher/`, `hive-graph/`, `portkey/`, `projection/`, `registration/`, `service/`, and `telemetry/`. |
| AC-018l.7 | Given `README.md`, when read, then `search`, `rebuild-projection`, and `brood --dry-run` are listed as working; `rebuild-projection` no longer appears in the not-ready list; and the recall arm is not described as "A `UNION ALL` arm" (per locked decision #2). |
| AC-018l.8 | Given a request with a malformed JSON body, when dispatched, then the response is 400 (not 500), and a second `body()` call after a parse failure does not silently return `undefined` (NEC-042 item 1). |
| AC-018l.9 | Given a macOS service install, when it completes, then the launchd log directory exists (NEC-042 item 2). |
| AC-018l.10 | Given a systemd reinstall, when the install command sequence runs, then `systemctl --user daemon-reload` is issued before `enable --now` (NEC-042 item 3). |
| AC-018l.11 | Given `NECTAR_TELEMETRY` set to `0`, `false`, or `off` (any case), when telemetry gating resolves, then telemetry is disabled; and `emitUninstalled` fires only after a successful uninstall (NEC-042 item 4). |
| AC-018l.12 | Given a search term containing `%`, `_`, or `\`, when the lexical arm SQL is built, then the ILIKE pattern carries an explicit `ESCAPE` clause (or the confirmed-safe `eLiteral` form), verified by one integration-shaped test against the live dialect or a recorded fixture (NEC-042 item 5). |
| AC-018l.13 | Given two nectars minted in the same millisecond, when compared, then they sort monotonically (counter added), or the module doc no longer claims sub-ms creation-time sortability (doc softened); one of the two holds (NEC-042 item 6). |
| AC-018l.14 | Given `yarn.lock` in a brood, when bucketed, then its terminal status is not `skipped-binary` and the chosen status is honest about the skip reason; the dead `ds_store` entry is removed (NEC-042 item 7). |
| AC-018l.15 | Given a by-path or by-hash lookup against the Deep Lake store, when executed, then the emitted SQL carries a `WHERE path = ...` / `WHERE content_hash = ...` predicate rather than listing the whole tenancy (NEC-042 item 8). |
| AC-018l.16 | Given a path receiving events more frequently than the debounce window indefinitely, when the max-wait cap elapses, then the path settles and enters re-association anyway (NEC-042 item 9). |
| AC-018l.17 | Given an in-root file symlink, when observed by the watcher and by a resync walk, then both paths apply the same contract (both skip, per the chosen fix) (NEC-042 item 10). |
| AC-018l.18 | Given a POSIX filename containing a literal backslash, when discovery runs on a non-Windows platform, then the path is preserved and the file is not dropped (NEC-042 item 11). |
| AC-018l.19 | Given `POST /api/hive-graph/search` with `limit: 0` or `limit: 2.9`, when parsed, then the response is a 400; the engine clamp remains as backstop for internal callers (NEC-042 item 12). |
| AC-018l.20 | Given a group- or other-readable `~/.deeplake/credentials.json`, when loaded on a POSIX platform, then a warning naming the file mode is emitted (NEC-042 item 13). |
| AC-018l.21 | Given `portable-registry.md`, when scanned, then no `sha256-`-prefixed hash examples remain; all examples are bare 64-char lowercase hex matching `projection/format.ts` validation (NEC-042 item 14). |

---

## Files touched

| File | Change | What changes |
|---|---|---|
| `library/knowledge/public/guides/getting-started-with-nectar.md` | modify | Real CLI surface (`:32,44,87`); document `nectar search`; automatic-freshness promises future-tensed (`:86`); coordinate prerequisites content with PRD-018k. |
| `library/knowledge/public/guides/keeping-descriptions-accurate.md` | modify | `review-matches` framing corrected (`:68-75,99`); copy-carries-description removed or future-tensed (`:56`); live-tracking claims future-tensed (`:23-45,49-58`); merge/grace prose softened. |
| `library/knowledge/public/guides/sharing-understanding-with-your-team.md` | modify | Agent-recall promise (`:58`) and immediate-semantic-recall claim (`:52-58`) softened. |
| `library/knowledge/public/overview/what-is-nectar.md` | modify | "No search box... through your AI coding assistant" (`:54`) future-tensed; `nectar search` acknowledged. |
| `library/knowledge/public/faqs/nectar-privacy-and-cost-faq.md` | modify | Teammate-recall claims (`:44-48,75-81`) aligned with inherit reality. |
| `library/knowledge/private/overview.md` | modify | Cost fixed to $3.05 (`:67`). |
| `library/knowledge/private/ai/brooding-pipeline.md` | modify | `honeycomb nectar` prefixes swept (`:141-147`). |
| `library/knowledge/private/ai/identity-and-reassociation.md` | modify | Prefixes swept (`:138,214`). |
| `library/knowledge/private/data/hive-graph-schema.md` | modify | Prefix swept (`:155`). |
| `library/knowledge/private/data/portable-registry.md` | modify | Prefix swept (`:121`); `sha256-` example hashes fixed to bare hex (`:47,55,66-67`). |
| `library/knowledge/private/ai/enricher-and-llm-model.md` | modify | Prefix swept (`:143`). |
| `README.md` | modify | CLI/status sections updated both directions (`:152-162`); `honeycomb recall` demo fixed (`:174`); UNION ALL prose fixed (`:102`); telemetry default-on plus opt-out documented. |
| `AGENTS.md` | modify | Status block (`:24-30`) and layout tree refreshed to the shipped module set. |
| `src/api/router.ts` | modify | Malformed JSON to 400; body-cache poisoning fixed (`:279-285`). |
| `src/service/index.ts` | modify | launchd log dir mkdirp on macOS install (`:219-223`). |
| `src/service/argv.ts` | modify | `daemon-reload` before `enable --now` (`:65-67`). |
| `src/telemetry-usage/emit.ts` | modify | Falsy-family opt-out (`:141-146`). |
| `src/cli.ts` | modify | `emitUninstalled` after outcome (`:148`). |
| `src/hive-graph/search.ts` | modify | `ESCAPE` clause on the ILIKE pattern (`:86`). |
| `src/hive-graph/ulid.ts` | modify | Monotonic-within-ms counter or doc softening (`:36-38`). |
| `src/brooding/constants.ts` | modify | Lockfile classification honesty; dead `ds_store` entry removed (`:75`). |
| `src/brooding/resumability.ts` | modify | `--force` semantics for the new lockfile status (`:40-42`). |
| `src/hive-graph/deeplake-store.ts` | modify | By-path/by-hash predicate pushdown (`:410-438,476-484`). |
| `src/registration/fs-watch.ts` | modify | Debounce max-wait cap (`:104-116`). |
| `src/registration/disk-fs.ts` | modify | Unified symlink contract (`:19-27,35-42,59`). |
| `src/brooding/discovery.ts` | modify | Windows-only separator rewrite (`:95`). |
| `src/api/hive-graph-api.ts` | modify | 400 on non-positive/non-integer `limit` (`:92-99`). |
| `src/hive-graph/deeplake-credentials.ts` | modify | Permission-mode warning (`:91-125`). |
| `test/docs-lint.test.ts` | create | Docs-lint suite: prefix scan, dead-command scan, cost-figure consistency, `sha256-` example scan. |
| `test/api-router.test.ts` | modify | 400 on malformed JSON; body-cache behavior. |
| `test/service-index.test.ts` | modify | launchd log dir creation. |
| `test/service-argv.test.ts` | modify | `daemon-reload` sequencing. |
| `test/telemetry-usage.test.ts` | modify | Falsy-family opt-out; `emitUninstalled` timing. |
| `test/hive-graph-search.test.ts` | modify | ESCAPE clause presence; limit rejection at the parser. |
| `test/hive-graph.test.ts` | modify | ULID monotonicity (if the counter option is taken). |
| `test/brooding.test.ts` | modify | Lockfile status; backslash-filename preservation. |
| `test/hive-graph-deeplake.test.ts` | modify | Predicate pushdown SQL shape. |
| `test/registration.test.ts` | modify | Debounce max-wait; symlink contract parity. |
| `test/hive-graph-api.test.ts` | modify | `limit: 0` / float limit 400s. |

---

## Tests to add

For the docs ACs, the mechanism is a lint-style test suite (`test/docs-lint.test.ts`, run by the normal `npm test`) that reads the named markdown files and asserts on their content; the command-liveness check extracts fenced `nectar ...` commands from the public guides and verifies each against the CLI's usage output (and, where cheap, executes the happy path).

| AC | Test file | Scenario |
|---|---|---|
| AC-018l.1 | `test/docs-lint.test.ts` | Scan `library/**/*.md` and `README.md`; assert zero `honeycomb nectar` command examples and no `honeycomb recall` in README. |
| AC-018l.2 | `test/docs-lint.test.ts` | Extract fenced commands starting with `nectar ` from `library/knowledge/public/`; assert each verb appears in the CLI USAGE text (`src/cli.ts`); happy-path exit-0 execution for the safe verbs (`--dry-run`, `search --help` shapes). |
| AC-018l.3 | `test/docs-lint.test.ts` | Assert `nectar search` appears in the getting-started guide and README; assert the named present-tense promise strings are gone from the cited files. |
| AC-018l.4 | `test/docs-lint.test.ts` | Assert `keeping-descriptions-accurate.md` no longer contains the description-repair framing string or the copy-carry claim in present tense. |
| AC-018l.5 | `test/docs-lint.test.ts` | Assert `overview.md` no longer contains "under $2" and that the $3.05 figure (or an agreeing rounding) is the only cost claim across the three files. |
| AC-018l.6 | `test/docs-lint.test.ts` | Assert AGENTS.md names PRD-017 (or the shipped range) and lists each of the ten module directories in its layout tree. |
| AC-018l.7 | `test/docs-lint.test.ts` | Assert README lists the three working verbs, omits `rebuild-projection` from not-ready, and contains no "UNION ALL arm" phrase. |
| AC-018l.8 | `test/api-router.test.ts` | POST a malformed JSON body; assert 400; call `body()` twice through a handler and assert the second call does not silently yield `undefined`. |
| AC-018l.9 | `test/service-index.test.ts` | Run the macOS install path against a temp HOME; assert the launchd log directory exists afterward. |
| AC-018l.10 | `test/service-argv.test.ts` | Capture the systemd install command sequence; assert `daemon-reload` precedes `enable --now`. |
| AC-018l.11 | `test/telemetry-usage.test.ts` | Gate resolution under `NECTAR_TELEMETRY` = `0` / `false` / `off` / `OFF`; all disable. Uninstall-failure path: assert no `nectar_uninstalled` event. |
| AC-018l.12 | `test/hive-graph-search.test.ts` | Build the lexical arm SQL for a term containing `%`; assert the `ESCAPE` clause (or `eLiteral` form) is present; one recorded-fixture probe against live-dialect semantics. |
| AC-018l.13 | `test/hive-graph.test.ts` | Mint many ULIDs inside one mocked millisecond; assert strictly increasing order (counter option), or assert the doc claim was softened (doc option; covered by docs-lint). |
| AC-018l.14 | `test/brooding.test.ts` | Bucket `yarn.lock`; assert the status is not `skipped-binary` and `--force` semantics behave per the chosen status; assert `ds_store` is gone from the constants. |
| AC-018l.15 | `test/hive-graph-deeplake.test.ts` | Spy the transport during `latestVersionByPath` / `latestVersionByHash`; assert the emitted SQL contains the path/hash predicate. |
| AC-018l.16 | `test/registration.test.ts` | Fire events on one path every 100ms past the max-wait horizon with fake timers; assert a settle fires at the cap. |
| AC-018l.17 | `test/registration.test.ts` | Create an in-root symlink fixture; assert watcher-path and walk-path classification agree (both skip). |
| AC-018l.18 | `test/brooding.test.ts` | Discovery over a fixture list containing `a\\b.ts` on a non-Windows platform stub; assert the path survives unmodified. |
| AC-018l.19 | `test/hive-graph-api.test.ts` | `limit: 0` and `limit: 2.9` search requests; assert 400 with a named error; valid integer limit unaffected. |
| AC-018l.20 | `test/fixes.test.ts` | Load credentials from a temp file with mode 0644 (POSIX-only test); assert the warning names the mode; 0600 loads silently. |
| AC-018l.21 | `test/docs-lint.test.ts` | Scan `portable-registry.md`; assert no `sha256-` prefixed hash examples remain. |

---

## Related

- [`./prd-018-pre-release-close-out-index.md`](./prd-018-pre-release-close-out-index.md)
- [`../../NECTAR-ISSUES.md`](../../NECTAR-ISSUES.md) (NEC-004, NEC-040, NEC-042)
- [`../../../notes/2026-07-02-spec-drift-review.md`](../../../notes/2026-07-02-spec-drift-review.md) (public-docs promises table; drift matrix rows 10, 14, 20, 25, 26, 27; recommended actions 1, 3, 6)
- [`../../../notes/2026-07-02-daemon-api-review.md`](../../../notes/2026-07-02-daemon-api-review.md) (L1-L5)
- [`../../../notes/2026-07-02-recall-review.md`](../../../notes/2026-07-02-recall-review.md) (L1-L3, L5, L6)
- [`../../../notes/2026-07-02-brooding-review.md`](../../../notes/2026-07-02-brooding-review.md) (L1, L2)
- [`../../../notes/2026-07-02-change-detection-review.md`](../../../notes/2026-07-02-change-detection-review.md) (L1, L2)
- [`../../../knowledge/public/guides/getting-started-with-nectar.md`](../../../knowledge/public/guides/getting-started-with-nectar.md)
- [`../../../knowledge/public/guides/keeping-descriptions-accurate.md`](../../../knowledge/public/guides/keeping-descriptions-accurate.md)
- [`../../../knowledge/public/guides/sharing-understanding-with-your-team.md`](../../../knowledge/public/guides/sharing-understanding-with-your-team.md)
- [`../../../knowledge/public/overview/what-is-nectar.md`](../../../knowledge/public/overview/what-is-nectar.md)
- [`../../../knowledge/private/overview.md`](../../../knowledge/private/overview.md) (the $2 outlier at :67)
- [`../../../knowledge/private/data/portable-registry.md`](../../../knowledge/private/data/portable-registry.md) (the `sha256-` examples)
