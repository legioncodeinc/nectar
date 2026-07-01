/**
 * The since-restart metrics snapshot writer (PRD-017b), per hivedoctor's
 * `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.
 *
 * `service_metrics` (id=1, latest-wins) carries five pure counts: files
 * registered, nectars minted, descriptions generated, source_graph_versions
 * written, and embeddings computed, all since the CURRENT process's start. A
 * restart is a fresh `MetricsWriter` instance (constructed by `daemon.ts` on
 * every `start()`), so the "reset to zero on restart" contract (AC-6 /
 * AC-017b.3.1) falls out of the daemon's own lifecycle rather than a
 * special-cased "detect a restart" branch.
 *
 * Every counter is a pure count of a pipeline EVENT (a file registered, a
 * nectar minted, a version row written, a description or embedding produced) -
 * never a nectar identity, source text, or description body (AC-10 /
 * AC-017b.4.1).
 */
import type { SourceGraphRow, SourceGraphVersionRow } from "../source-graph/model.js";
import type { SourceGraphStore } from "../source-graph/store.js";
import type { SqliteDatabaseLike } from "./db.js";

export interface MetricsSnapshot {
  readonly filesRegistered: number;
  readonly nectarsMinted: number;
  readonly descriptionsGenerated: number;
  readonly sourceGraphVersions: number;
  readonly embeddingsComputed: number;
}

/** The counter-increment surface pipeline touchpoints depend on (never the writer's SQLite internals). */
export interface PipelineMetricsSink {
  /** One file processed through the re-association ladder (PRD-006), any outcome. */
  incrementFilesRegistered(): void;
  /** One fresh nectar minted (ladder step 5). */
  incrementNectarsMinted(): void;
  /** One LLM description produced (the enricher/brooding loop, PRD-007/PRD-016). */
  incrementDescriptionsGenerated(): void;
  /** One `source_graph_versions` row written (PRD-005). */
  incrementSourceGraphVersions(): void;
  /** One embedding computed (PRD-014). */
  incrementEmbeddingsComputed(): void;
}

interface MutableCounts {
  filesRegistered: number;
  nectarsMinted: number;
  descriptionsGenerated: number;
  sourceGraphVersions: number;
  embeddingsComputed: number;
}

function zeroCounts(): MutableCounts {
  return {
    filesRegistered: 0,
    nectarsMinted: 0,
    descriptionsGenerated: 0,
    sourceGraphVersions: 0,
    embeddingsComputed: 0,
  };
}

export interface MetricsWriterOptions {
  readonly db: SqliteDatabaseLike;
  /** ISO 8601 "now"; injectable for deterministic tests. */
  now?(): string;
}

export class MetricsWriter implements PipelineMetricsSink {
  private readonly db: SqliteDatabaseLike;
  private readonly nowFn: () => string;
  private counts: MutableCounts = zeroCounts();

  constructor(opts: MetricsWriterOptions) {
    this.db = opts.db;
    this.nowFn = opts.now ?? (() => new Date().toISOString());
    // Establish the zero baseline immediately: a poll that lands before any
    // pipeline work still reads a real all-zero row, never a missing one.
    this.flush();
  }

  snapshot(): MetricsSnapshot {
    return { ...this.counts };
  }

  incrementFilesRegistered(): void {
    this.counts.filesRegistered += 1;
    this.flush();
  }

  incrementNectarsMinted(): void {
    this.counts.nectarsMinted += 1;
    this.flush();
  }

  incrementDescriptionsGenerated(): void {
    this.counts.descriptionsGenerated += 1;
    this.flush();
  }

  incrementSourceGraphVersions(): void {
    this.counts.sourceGraphVersions += 1;
    this.flush();
  }

  incrementEmbeddingsComputed(): void {
    this.counts.embeddingsComputed += 1;
    this.flush();
  }

  private flush(): void {
    try {
      this.db
        .prepare(
          `INSERT INTO service_metrics (id, files_registered, nectars_minted, descriptions_generated, source_graph_versions, embeddings_computed, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             files_registered = excluded.files_registered,
             nectars_minted = excluded.nectars_minted,
             descriptions_generated = excluded.descriptions_generated,
             source_graph_versions = excluded.source_graph_versions,
             embeddings_computed = excluded.embeddings_computed,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.counts.filesRegistered,
          this.counts.nectarsMinted,
          this.counts.descriptionsGenerated,
          this.counts.sourceGraphVersions,
          this.counts.embeddingsComputed,
          this.nowFn(),
        );
    } catch {
      // fail-soft (AC-7 / AC-017b): a metrics write error never surfaces into the pipeline.
    }
  }
}

/**
 * Wrap a {@link SourceGraphStore} so the two counters with a precise 1:1
 * store-level definition increment at their REAL completion point, with ZERO
 * changes to the ladder (`registration/ladder.ts`) or the store adapters:
 *
 *   - `nectarsMinted`: one `insertIdentity()` call = one freshly minted nectar
 *     (the ladder's step-5 `mintOrCopy` is the only caller in this repo). A
 *     THROWING insert (duplicate nectar, the store's own dedup guard) never
 *     increments, because the throw happens before the increment line below -
 *     no double counting across a rejected mint.
 *   - `sourceGraphVersions`: one `appendVersion()` call = one
 *     `source_graph_versions` row written (ladder steps 2/3/4/5), the exact
 *     PRD-005 catalog write.
 *
 * `descriptionsGenerated` and `embeddingsComputed` are wired to the CLOSEST
 * REAL signal available in this repo today rather than a fabricated hook: a
 * version row only ever carries `describeStatus === "described"` or a
 * non-null `embedding` once the enricher (PRD-007/PRD-016) and the embeddings
 * provider (PRD-014) actually populate those fields on the row they pass to
 * `appendVersion`. Neither pipeline exists in this repo yet - `ladder.ts`'s
 * `baseVersion()` always writes `title/description: ""`, `describeStatus:
 * "pending"`, and `embedding: null` - so both counters correctly read 0 until
 * those PRDs land. This is a documented, intentional approximation (see the
 * PRD-017 ledger evidence): the day a future PRD starts writing a "described"
 * row or a non-null embedding through this same `appendVersion` call, the
 * counter starts moving with no further wiring required.
 */
export function wrapStoreWithMetrics<T extends SourceGraphStore>(store: T, sink: PipelineMetricsSink): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "insertIdentity") {
        return (row: SourceGraphRow): void => {
          target.insertIdentity(row);
          sink.incrementNectarsMinted();
        };
      }
      if (prop === "appendVersion") {
        return (row: SourceGraphVersionRow): void => {
          target.appendVersion(row);
          sink.incrementSourceGraphVersions();
          if (row.describeStatus === "described") sink.incrementDescriptionsGenerated();
          if (row.embedding !== null) sink.incrementEmbeddingsComputed();
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
