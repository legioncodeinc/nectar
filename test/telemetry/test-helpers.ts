import { rmSync } from "node:fs";

/**
 * Windows can hold a brief, delayed lock on a just-closed SQLite WAL/SHM
 * sidecar file (real-time AV scanning / indexing racing the OS's own file
 * handle teardown) - an environmental artifact, not a correctness bug in the
 * telemetry writers themselves (every writer's own `close()`/fail-soft paths
 * are covered directly by the tests in this directory). Retry the recursive
 * delete a few times with a short backoff instead of failing the test suite
 * on an unrelated OS race.
 */
export function rmDirWithRetry(dir: string, attempts = 8, delayMs = 40): void {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        /* brief synchronous backoff; test-cleanup only. */
      }
    }
  }
}
