# PRD-019d: Ignore-contract hardening (CLI parity + git-absent gitignore)

> **Parent:** [PRD-019](./prd-019-project-scoped-brooding-activation-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S-M

---

## Problem

PRD-018c built the shared ignore predicate (`createSharedIgnore`, `src/registration/ignore.ts:237`) = always-ignored segments (`.git`, `node_modules`, `.honeycomb`) UNION `graph-ignore.json` prefixes UNION gitignore semantics. The daemon watch/auto-brood path wires it in (`resolvedIgnore`, `src/daemon.ts:513`). Two gaps remain that make a non-git (or git-erroring) root gitignore-blind:

1. **`.gitignore` is honored only when git is available.** `createSharedIgnore`'s gitignore layer is a cached `git ls-files` snapshot plus a `git check-ignore` fallback (`src/registration/ignore.ts:248-291`). When the root is not a git repo (or `git` is absent / erroring), `eligible` is `null` and `isGitIgnored` returns `false` for everything (`ignore.ts:282-291`). The walk fallback in discovery then applies only `createDefaultIgnore` (segments + `graph-ignore.json`), which does not read `.gitignore` at all (`src/brooding/discovery.ts:248`, `src/registration/ignore.ts:113-127`). So a bound non-git folder ingests everything except `.git`/`node_modules`/`.honeycomb`.

2. **The CLI discovery paths pass no ignore predicate.** `createDiskRegistrationFs` defaults `isIgnored` to `() => false` (ignore nothing) (`src/registration/disk-fs.ts:48`), and the CLI constructs it without a predicate:
   - `src/cli.ts:306` (`brood --dry-run`)
   - `src/cli.ts:547`
   - `src/cli.ts:601`
   - `src/cli.ts:780` + `781` (skillify/discovery)
   - `src/cli.ts:843`
   These lean on `discoverFiles`' internal `git ls-files --exclude-standard` (which does honor `.gitignore`) when git is present, but on a non-git root the walk fallback is doubly gitignore-blind.

With 019a activating explicitly-bound folders (which may well be non-git subtrees), this gap must close.

## Solution

Two changes, both additive and fail-soft.

### 1. A dependency-free `.gitignore` parser for the walk fallback

Add a `.gitignore` matcher used by the ignore contract when git cannot supply the answer. It reads the root `.gitignore` (and nested `.gitignore` files as encountered during the walk), plus `.git/info/exclude` when present, and applies standard gitignore matching (negation with `!`, directory-only patterns with a trailing `/`, anchored patterns with a leading `/`, `**`, and basename globs). Node built-ins only (AGENTS.md: zero runtime dependencies).

`createSharedIgnore` (and `createDefaultIgnore`'s consumers) gain a third source: when the git snapshot is unavailable (`eligible === null`), consult the parsed-gitignore matcher instead of returning `false`. When git IS available, the `git ls-files` snapshot remains authoritative (it already reflects `.gitignore`), so the parser is the fallback, not a second opinion that could disagree.

This keeps the NEC-039 honesty contract intact: git-present-but-erroring still surfaces loudly (`onGitError`); the parser only fills the git-genuinely-absent gap that today reads as "nothing ignored."

### 2. CLI discovery uses the shared predicate

Every CLI discovery/registration-fs construction passes the shared ignore predicate for its resolved root:

- Build the predicate once per command via `createSharedIgnore(root).isIgnored` (the same reference the daemon uses).
- Pass it to `createDiskRegistrationFs(root, isIgnored)` and to `discoverFiles({ root, fs, isIgnored })` at every CLI site listed above.

Change `createDiskRegistrationFs`'s default from `() => false` to `createDefaultIgnore(root)` so an omitted predicate still drops the always-ignored segments rather than ignoring nothing (defense in depth against a future caller that forgets).

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | Given a bound root that is NOT a git repository containing a `.gitignore` with `dist/` and `*.log`, when discovery runs (daemon walk fallback), then files under `dist/` and matching `*.log` are excluded, and a non-ignored `src/x.ts` is included. |
| d-AC-2 | Given a nested `.gitignore` (e.g. `packages/a/.gitignore` ignoring `build/`), when the walk descends into it, then `packages/a/build/**` is excluded while `packages/b/build/**` (no such rule) is not. |
| d-AC-3 | Given a `.gitignore` negation (`*.log` then `!keep.log`), when discovery runs without git, then `keep.log` is included and other `*.log` files are excluded. |
| d-AC-4 | Given git IS available for the root, when discovery runs, then behavior is unchanged (the `git ls-files --exclude-standard` snapshot remains authoritative and the parser does not override it). |
| d-AC-5 | Given git is present but `ls-files` ERRORS, when discovery runs, then the degradation is still surfaced loudly (`onGitError` / `degraded` on the dry-run report), not silently masked by the parser. |
| d-AC-6 | Given each CLI discovery site (`cli.ts:306/547/601/780/843`), when it constructs the registration fs / calls `discoverFiles`, then it passes the shared ignore predicate, so a non-git CLI `brood --dry-run` reports the same file set the daemon would brood. |
| d-AC-7 | Given `createDiskRegistrationFs(root)` is called with no predicate, when it lists paths, then it still drops `.git` / `node_modules` / `.honeycomb` (the default is `createDefaultIgnore(root)`, not `() => false`). |

## Implementation notes

- Put the parser in `src/registration/gitignore.ts` with a pure `compileGitignore(patterns): (relPath, isDir) => boolean` core so it is unit-testable without disk, plus a thin disk loader that reads `.gitignore` / `.git/info/exclude`.
- Wire it into `createSharedIgnore` behind the existing `eligible === null` branch (`src/registration/ignore.ts:282`), so the change is localized and the git-present path is untouched.
- Keep the matcher's semantics conservative: when in doubt, do NOT ignore (fail-open to inclusion is safer for a memory layer than dropping a file the user expected indexed). Document the known-unsupported edge cases (e.g. `core.excludesfile` global ignores are out of scope for the parser; git-present already covers them).
- Add fixtures under `test/` mirroring the existing discovery/ignore suites; name each test after the AC it proves.

## Related

- `src/registration/ignore.ts` - `createSharedIgnore` / `createDefaultIgnore`, extended with the parser fallback.
- `src/brooding/discovery.ts` - the walk fallback (`discoverFiles`) that consumes the predicate.
- `src/registration/disk-fs.ts:46-48` - the `createDiskRegistrationFs` default-ignore change.
- `src/cli.ts:306,547,601,780,843` - the CLI discovery sites to wire.
- [`prd-018-pre-release-close-out`](../../in-work/prd-018-pre-release-close-out/prd-018c-watcher-robustness-and-ignore-parity.md) - PRD-018c, which introduced the shared predicate this sub-PRD completes.
