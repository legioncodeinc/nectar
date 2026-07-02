/**
 * Content hashing for the Hive Graph (PRD-005 / PRD-006).
 *
 * `content_hash` is the sha256 of file content at observation, and the composite
 * key part 2 on `hive_graph_versions`. Node built-ins only (`node:crypto`).
 */
import { createHash } from "node:crypto";

/** Lowercase hex sha256 of the given data. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
