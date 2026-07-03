/**
 * The `brood` CLI surface (PRD-007d).
 *
 * Owns the BROOD-verb behavior: flag parsing (`--force`, `--limit N`,
 * `--dry-run`, `--model <new>`), the two triggering paths (automatic on a fresh
 * project vs explicit invocation), and the `--dry-run` cost-preview formatting.
 * The CLI INVOCATION dispatch (the `nectar` binary, loopback thin-client) is
 * owned by PRD-002c; this module is the pure verb logic the orchestrator wires.
 */
import { existsSync } from "node:fs";
import type { Tenancy } from "../hive-graph/model.js";
import type { AsyncHiveGraphStore, HiveGraphStore } from "../hive-graph/store.js";
import { DEFAULT_PROJECTION_REL_PATH } from "../projection/format.js";
import { projectionFinalPath } from "../projection/write.js";
import type { BroodRunOptions } from "./pipeline.js";
import type { BroodCostEstimate } from "./cost.js";
import type { DiscoverySource } from "./discovery.js";

/** The parsed `brood` flags plus any parse errors. */
export interface ParsedBroodArgs {
  readonly options: BroodRunOptions;
  /** Non-empty when a flag was malformed (e.g. `--limit abc`); the caller should reject. */
  readonly errors: readonly string[];
}

function takeValue(argv: readonly string[], i: number, inlineValue: string | undefined): { value: string | undefined; next: number } {
  if (inlineValue !== undefined) return { value: inlineValue, next: i };
  const nextArg = argv[i + 1];
  if (nextArg === undefined || nextArg.startsWith("-")) return { value: undefined, next: i };
  return { value: nextArg, next: i + 1 };
}

/**
 * Parse the `brood` verb's flags. Recognizes `--force`, `--dry-run`,
 * `--limit N` (and `--limit=N`), and `--model <new>` (and `--model=<new>`).
 * Unknown flags and malformed values are reported in `errors`.
 */
export function parseBroodArgs(argv: readonly string[]): ParsedBroodArgs {
  let force = false;
  let dryRun = false;
  let limit: number | undefined;
  let model: string | undefined;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    switch (flag) {
      case "--force":
        force = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--limit": {
        const { value, next } = takeValue(argv, i, inline);
        i = next;
        if (value === undefined) {
          errors.push("--limit requires a non-negative integer");
          break;
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n < 0 || String(n) !== value.trim()) {
          errors.push(`--limit expects a non-negative integer, got ${JSON.stringify(value)}`);
          break;
        }
        limit = n;
        break;
      }
      case "--model": {
        const { value, next } = takeValue(argv, i, inline);
        i = next;
        if (value === undefined || value.trim() === "") {
          errors.push("--model requires a model id");
          break;
        }
        model = value;
        break;
      }
      default:
        errors.push(`unknown brood flag: ${flag}`);
        break;
    }
  }

  const options: BroodRunOptions = { force, dryRun };
  return {
    options: { ...options, ...(limit !== undefined ? { limit } : {}), ...(model !== undefined ? { model } : {}) },
    errors,
  };
}

/** Inputs the automatic-trigger decision needs (checked at startup / registration). */
export interface AutoBroodCheck {
  /** Whether the project already has any `hive_graph` rows. */
  readonly hasHiveGraphRows: boolean;
  /** Whether `.honeycomb/nectars.json` exists for the project. */
  readonly hasProjection: boolean;
}

/**
 * The automatic trigger (PRD-007d): brooding runs the first time hiveantennae
 * runs against a project with NO `hive_graph` rows OR NO `.honeycomb/nectars.json`.
 * The daemon must run this in the background (it does not block readiness).
 */
export function shouldAutoBrood(check: AutoBroodCheck): boolean {
  return !check.hasHiveGraphRows || !check.hasProjection;
}

/** Build the {@link AutoBroodCheck} from the store + project root (a startup helper). */
export function evaluateAutoBrood(store: HiveGraphStore, tenancy: Tenancy, root: string): AutoBroodCheck {
  const hasHiveGraphRows = store.listLatestVersions(tenancy).length > 0;
  const hasProjection = existsSync(projectionFinalPath(root, DEFAULT_PROJECTION_REL_PATH));
  return { hasHiveGraphRows, hasProjection };
}

/**
 * The async twin of {@link evaluateAutoBrood} for the durable
 * {@link AsyncHiveGraphStore} (Deep Lake). Reads whether the project has any
 * hive_graph rows over the async store and whether the projection exists on
 * disk. The daemon's durable auto-brood path uses this so a real daemon with
 * Deep Lake credentials evaluates the trigger against the durable substrate.
 */
export async function evaluateAutoBroodAsync(
  store: AsyncHiveGraphStore,
  tenancy: Tenancy,
  root: string,
): Promise<AutoBroodCheck> {
  const hasHiveGraphRows = (await store.listLatestVersions(tenancy)).length > 0;
  const hasProjection = existsSync(projectionFinalPath(root, DEFAULT_PROJECTION_REL_PATH));
  return { hasHiveGraphRows, hasProjection };
}

/** The fields a dry-run preview prints (a subset shared by plan + result). */
export interface DryRunPreviewInput {
  readonly discoveredCount: number;
  readonly inheritedCount: number;
  readonly skipBinaryCount: number;
  readonly skipTooLargeCount: number;
  readonly batchFileCount: number;
  readonly soloFileCount: number;
  readonly batchCalls: number;
  readonly soloCalls: number;
  readonly estimate: BroodCostEstimate;
  /**
   * PRD-018c AC-018c.11: how discovery produced the candidate set ("git" or
   * "walk"). Optional so existing callers that predate this field keep
   * compiling; `formatDryRunReport` simply omits the line when absent.
   */
  readonly source?: DiscoverySource;
  /**
   * PRD-018c NEC-039 / AC-018c.10/11: set when `source` is "walk" because git
   * was PRESENT but ERRORED - the loud counterpart to the silent walk that
   * runs when git is simply absent (which leaves this undefined).
   */
  readonly degraded?: { readonly reason: string };
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Format the `--dry-run` cost preview (PRD-007d). Prints the bucket counts, the
 * estimated call count, and the estimated cost for THIS project, derived from
 * the 007b per-bucket economics applied to the actual discovery.
 *
 * PRD-018c AC-018c.11: also prints the discovery source (git or walk) and,
 * when discovery degraded to the walk because git errored (never when git is
 * simply absent), the reason - so a user can tell the degradation happened
 * instead of only noticing an inflated brood cost.
 */
export function formatDryRunReport(input: DryRunPreviewInput): string {
  const e = input.estimate;
  const lines = [
    "brood --dry-run (no LLM calls made)",
    ...(input.source !== undefined ? [`  discovery source:  ${input.source}`] : []),
    ...(input.degraded !== undefined
      ? [`  discovery DEGRADED: git ls-files failed, fell back to a manual walk (${input.degraded.reason})`]
      : []),
    `  discovered:        ${input.discoveredCount}`,
    `  inherited ($0):    ${input.inheritedCount}`,
    "  buckets:",
    `    skip-binary:     ${input.skipBinaryCount}`,
    `    skip-too-large:  ${input.skipTooLargeCount}`,
    `    batch files:     ${input.batchFileCount} (${input.batchCalls} calls)`,
    `    solo files:      ${input.soloFileCount} (${input.soloCalls} calls)`,
    `  estimated calls:   ${e.totalCalls}`,
    `  estimated input:   ${e.inputTokens} tokens`,
    `  estimated cost:    ${usd(e.totalUsd)} (input ${usd(e.inputUsd)} + output ${usd(e.outputUsd)}, embedding ${usd(e.embeddingUsd)})`,
  ];
  return lines.join("\n");
}
