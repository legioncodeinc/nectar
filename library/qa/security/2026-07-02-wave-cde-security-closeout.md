# Security Audit - Nectar Wave C/D/E Smoker Close-out

- **Date:** 2026-07-02
- **Auditor:** security-worker-bee
- **Scope:** three branch deltas vs `main`, audited delta-only:
  1. **nectar** (primary) - `feature/smoker-wave-c-d-e` @ `C:/Users/mario/GitHub/nectar-worktrees/smoker-wave-cde` (HEAD `b8181a6`)
  2. **honeycomb** - `feature/prd-013-hive-graph-recall-arm` @ `C:/Users/mario/GitHub/honeycomb-worktrees/hive-graph-recall-arm`
  3. **hive** - `feature/prd-015-hive-graph-page` @ `C:/Users/mario/GitHub/hive-worktrees/hive-graph-page`
- **Ordering:** run BEFORE `quality-worker-bee`. No prior branch-level QA/quality report exists in any of the three `library/qa/` trees, so no ordering inversion. The final `quality-worker-bee` pass is still owed after this audit.

---

## Executive summary

**No Critical, High, or Medium findings across all three deltas. Nothing was remediated because nothing at Medium-or-above was found; no code was changed and no per-repo remediation commit was created (an empty security fix would violate minimal-blast-radius).** Three Low / defense-in-depth observations are documented below for the record.

This is a mature codebase with disciplined security primitives, and the ~9,880-line nectar delta plus the honeycomb recall arm and the hive dashboard page all stay inside those primitives:

- **SQL:** every new builder (nectar `hive-graph/search.ts`, `api/status-query.ts`, `enricher/sql-update.ts`, `enricher/pending-query.ts`; honeycomb `memories/recall.ts` hive-graph arm) routes every identifier through `sqlIdent`, every value through `sLiteral`/`eLiteral`/`sqlNum`, every `LIKE`/`ILIKE` term through `sqlLike`, and every vector through `sqlFloat4Array` (which `sqlNum`-guards each entry). Honeycomb `npm run audit:sql` passes clean (285 files scanned).
- **HTTP surface:** the `/api/hive-graph/*` group is `protect: true` and the gate runs BEFORE the handler in `NectarRouter.dispatch`; the 1 MiB body cap is enforced pre-handler with over-cap draining; malformed JSON and stream errors degrade to structured `400`/`500` bodies, never an unhandled throw; parsed bodies are read field-by-field (no merge), so prototype pollution is inert; the socket binds loopback-only (`127.0.0.1`, `DEFAULT_HOST`) and the CLI loopback client targets a fixed path with operator-configured host/port (no attacker-controlled SSRF target).
- **Child process:** `spawnGitLsFiles` uses `spawnSync("git", [fixed argv], { cwd: root, windowsHide: true })` - no shell, no interpolated arguments, fixed flag list, `cwd` is the operator's project root.
- **Untrusted file content -> LLM -> parsed JSON:** model output is parsed with `JSON.parse` (no `eval`/`Function`), and is only ever used as `title`/`description`/`concepts`/`primary_symbol` display text - never as a filesystem path, never as code. `describe_model` is stamped from the resolved model id, not from model output. File reads are contained by `realpathContained` (lexical `..`/absolute rejection + `realpathSync` symlink clamp, CWE-22).
- **Operator config (`~/.honeycomb/nectar.json`):** fail-soft parse (missing file / malformed JSON / non-object / absent key all resolve to the `1.0` default), clamped to `[0, 10]`; the only value consumed is a numeric RRF multiplier that never reaches SQL or a shell.
- **XSS (hive dashboard):** all LLM-derived titles/descriptions/paths and search hits render as React text children or attribute values (auto-escaped); no `dangerouslySetInnerHTML`; the SVG graph renders `node.label` as a `<text>` child and `aria-label` attribute (both escaped); no node-derived `href`.
- **Secrets / PII:** the Portkey API key is placed only in the `x-portkey-api-key` header; Deep Lake JWT only in `Authorization: Bearer`; telemetry log writes pass through `redactLogMessage` (Bearer/api-key/secret regex redaction + 2,000-char drop cap); no token or captured content is written to logs or telemetry rows.

### Baseline verification (all green, pre-audit == post-audit since no code changed)

| Repo | Typecheck | Tests | SQL audit |
|---|---|---|---|
| nectar | `tsc --noEmit` clean | `npm test` - 449 passed, 3 skipped | n/a |
| honeycomb | `tsc --noEmit` clean | `vitest run tests/daemon/runtime/memories` - 429 passed (35 files) | `npm run audit:sql` clean (285 files) |
| hive | `tsc --noEmit` clean | `vitest run tests/dashboard` - 79 passed (15 files) | n/a |

---

## Per-repo findings

### 1. nectar (`feature/smoker-wave-c-d-e`)

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| L1 | Low | `src/api/hive-graph-api.ts:174,202,222,236,253` | Handler `500` bodies echo `reason: errorReason(err)`, which can carry a `TransportError` message of the form `${status}: ${deeplakeBody.slice(0,200)}`; a Deep Lake error body may echo the failing SQL, which contains the caller's own `org_id`/`workspace_id`/`project_id` literals. | Documented (no fix) |
| L2 | Low | `src/enricher/sql-update.ts:28` | The enricher `UPDATE ... WHERE nectar = <n> AND seq = <s>` is keyed by nectar+seq only, not by tenancy columns. | Documented (no fix) |

**Why L1 is Low, not Medium:** the rubric names "verbose error echoing org id" as Medium in a multi-tenant HTTP context. Here there is no trust boundary crossed - the daemon binds loopback-only, and the `org_id`/`workspace_id` that could surface are the caller's OWN identifiers (the caller already holds `~/.deeplake/credentials.json` for that org to reach the data at all). The search and status paths are additionally fail-soft (`runArm` and `readHiveGraphStatusOverStorage` swallow storage errors and degrade), so only the `build_failed` path can realistically surface a transport body, and only to the operator's own dashboard. No cross-tenant exposure -> Low.

**Why L2 is Low, not High:** nectars are globally-unique daemon-minted ULIDs (one nectar belongs to exactly one org/workspace/project), and the write-back rides `HttpDeepLakeTransport`, which is itself org/workspace-scoped via `Authorization` + org headers against the workspace's dataset. A cross-tenant write would require a ULID collision across datasets, which the identity model precludes. The missing `project_id` in the `WHERE` is defense-in-depth only.

- SQL injection (all four new/changed builders): **None detected** - guards routed end-to-end (CLI term -> endpoint -> `searchHiveGraph` -> `sqlLike` in `buildHiveGraphLexicalArmSql`).
- HTTP surface (auth gate, body cap, malformed JSON, prototype pollution, error leakage, loopback SSRF): **None detected** beyond L1.
- Child-process (git spawn) argument injection / cwd trust / output parsing: **None detected**.
- Untrusted file content / model-output handling (eval, path traversal, describe_model stamping): **None detected**.
- Secrets / PII in logs / telemetry / Portkey key handling: **None detected**.

### 2. honeycomb (`feature/prd-013-hive-graph-recall-arm`)

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| - | - | - | No findings. | - |

- SQL injection (`buildHiveGraphVersionsArmSql`, the 4th lexical arm + the hive-graph semantic arm + `buildSemanticHydrateSql`): **None detected** - term via `sqlLike`, identifiers via `sqlIdent`, ids via `sLiteral`, project segment via the shared `buildProjectScopeConjunct`; `npm run audit:sql` clean.
- LIKE-escaping of the search term end-to-end: **None detected** - `'%${sqlLike(term)}%'`, consistent with the three pre-existing arms.
- Cross-project isolation of the new arm: **None detected** - the `project_id` conjunct is applied in the `MAX(seq)` latest-per-nectar subquery and transitively scopes the outer row via the `nectar`+`seq` join (nectar uniqueness makes this sound); `recall-project-isolation.test.ts` passes.
- Operator config read (`nectar-recall-config.ts`, `~/.honeycomb/nectar.json`): **None detected** - fail-soft parse + `[0,10]` clamp, numeric-only value, never reaches SQL/shell.
- Fusion / provenance coercion (`readSource`, `recencyClassOf`): **None detected** - the `hive_graph_versions` source literal is recognized (not mis-defaulted to `sessions`), preserving the dedup key and arm-class weight.

### 3. hive (`feature/prd-015-hive-graph-page`)

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| L3 | Low (informational) | `src/dashboard/web/wire.ts` (`PortableProjectionSchema`, `z.record`) + `hive-graph-projection.ts` (`Object.entries`) | The projection `files`/`derived` maps are parsed with `z.record` and iterated with `Object.entries`; a `__proto__`/`constructor` key in the projection could be mishandled by downstream object indexing. | Documented (no fix) |

**Why L3 is informational:** the projection is served by the operator's OWN nectar daemon over loopback, and its map keys are daemon-minted nectars (ULIDs) and paths, not attacker-controlled input. There is no untrusted producer in the threat model. Reading `files[selectedNode.id]` for a `__proto__` id would at worst read a prototype value, not mutate one (no `obj[key] = ...` write of parsed keys). No exploit path -> informational.

- XSS (LLM-derived titles/descriptions/paths, search hits, SVG/canvas graph): **None detected** - React text/attribute escaping throughout; no `dangerouslySetInnerHTML`; no node-derived `href`/`xlink`.
- Wire-client robustness (malformed/absent bodies, non-2xx): **None detected** - every method `safeParse`s and degrades to an empty view with an honest `unreachable`/`degraded` flag; never throws into React.
- Secrets / PII in the dashboard: **None detected** - no token/secret rides any wire shape; session headers only.

---

## Categories checked (all three deltas)

| Category | Result |
|---|---|
| SQL injection into Deep Lake (all new builders) | None detected |
| Authn/authz - `/api/hive-graph/*` protect-gate inheritance | None detected (gate enforced pre-handler) |
| HTTP body parsing (size cap, malformed JSON, prototype pollution) | None detected |
| Error-response internal leakage | L1 (Low, same-tenant loopback) |
| Loopback client SSRF | None detected (fixed path, operator-configured target) |
| Child-process argument injection (git spawn) | None detected |
| Untrusted file content -> LLM -> parsed output | None detected |
| Model-suggested path traversal / eval | None detected |
| Operator config parse safety + clamp | None detected |
| XSS (dashboard, SVG graph) | None detected |
| Cross-tenant / cross-scope read/write | L2 (Low, ULID uniqueness + header scoping) |
| Secrets / PII in logs, telemetry, Portkey key handling | None detected |
| Prototype pollution (projection ingest) | L3 (Low/informational, trusted loopback source) |

---

## Recommendations (non-blocking, future hardening)

1. **L1:** for the nectar `/api/hive-graph` `500` handlers, consider mapping `TransportError` to a generic `reason` (e.g. `"upstream storage error"`) while logging the detail server-side, so a Deep Lake error body never reaches the response even to the operator's dashboard.
2. **L2:** add the tenancy columns to the enricher `UPDATE ... WHERE` for defense-in-depth, matching the scoping discipline of the read-side builders.
3. **L3:** if the projection ingest is ever fed by an untrusted producer, switch map iteration to `Object.entries` on a null-prototype copy or reject `__proto__`/`constructor` keys at the zod boundary.

## Next step

Hand off to `quality-worker-bee` for the branch-level quality gate. This audit made no code changes, so its report will not be invalidated by security remediations.
