#!/usr/bin/env node
/**
 * Bake the PostHog ingest key into the COMPILED output at release time.
 *
 * nectar builds with plain tsc (no esbuild), so there is no `define`
 * mechanism to inject constants at build time. Instead, the source stub
 * src/telemetry-usage/posthog-key.ts is committed with empty strings, and this
 * script rewrites the compiled dist/telemetry-usage/posthog-key.js in place
 * with the values from the environment:
 *
 *   NECTAR_POSTHOG_KEY   the public write-only PostHog ingest key (phc_...)
 *   NECTAR_POSTHOG_HOST  the ingest host (optional; runtime defaults to
 *                        the PostHog US cloud when left empty)
 *
 * ADR-0002 decoupling: nectar's own NECTAR_* names are primary. The
 * HONEYCOMB_POSTHOG_KEY/HOST names are accepted as a DETECTED fallback only
 * (the org shares one PostHog ingest project across the family), never
 * required.
 *
 * Behavior:
 *   - both key envs unset or empty: log a line and exit 0 (a no-op, so forks
 *     and rehearsals without the secret stay green and unkeyed).
 *   - target file missing: exit 1 loudly (catches a moved or renamed module).
 *   - after writing, the script re-loads the emitted module and verifies the
 *     baked values round-trip, so a format drift fails the release gate here
 *     rather than shipping a broken import.
 *
 * The emitted JS matches tsc's module format for this package: package.json
 * has "type": "module", so dist/*.js are ESM and the replacement uses
 * `export const`. If the package ever flips to CommonJS the script emits
 * `exports.*` assignments instead.
 *
 * Usage: node scripts/bake-posthog-key.mjs [distDir]
 *   distDir defaults to <repo>/dist; tests pass a temp dist copy.
 *
 * Wired into .github/workflows/release.yaml (gate job) AFTER the last
 * build-producing step: `npm run test` re-runs tsc, so the bake must follow
 * both Test and Build (tsc) or the fresh build would overwrite the baked file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const distDir = resolve(process.argv[2] ?? join(repoRoot, "dist"));
const target = join(distDir, "telemetry-usage", "posthog-key.js");

function fail(message) {
  process.stderr.write(`bake-posthog-key: ${message}\n`);
  process.exit(1);
}

// The moved-file guard runs BEFORE the no-op branch so a relocated module is
// caught even on unkeyed rehearsals, not only on the real release.
if (!existsSync(target)) {
  fail(
    `target file not found: ${target}. ` +
      "Expected the tsc output of src/telemetry-usage/posthog-key.ts. " +
      "Run `npm run build` first, or update this script if the module moved.",
  );
}

const key = (process.env.NECTAR_POSTHOG_KEY ?? process.env.HONEYCOMB_POSTHOG_KEY ?? "").trim();
const host = (process.env.NECTAR_POSTHOG_HOST ?? process.env.HONEYCOMB_POSTHOG_HOST ?? "").trim();

if (key.length === 0) {
  process.stdout.write(
    "bake-posthog-key: NECTAR_POSTHOG_KEY (and the detected HONEYCOMB_POSTHOG_KEY fallback) is unset or empty; leaving the stub as-is (telemetry stays disabled in this build).\n",
  );
  process.exit(0);
}

// Sanity-check the compiled stub still exports what we are about to replace.
const current = readFileSync(target, "utf8");
if (!current.includes("POSTHOG_KEY") || !current.includes("POSTHOG_HOST")) {
  fail(
    `${target} does not export POSTHOG_KEY/POSTHOG_HOST; the stub module changed shape. Update this script to match.`,
  );
}

// Match tsc's emitted module format: "type": "module" means ESM export
// statements; anything else means CommonJS exports assignments.
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const isEsm = pkg.type === "module";

const header =
  "// Baked by scripts/bake-posthog-key.mjs at release time.\n" +
  "// The committed source stub (src/telemetry-usage/posthog-key.ts) stays empty.\n";
const baked = isEsm
  ? `${header}export const POSTHOG_KEY = ${JSON.stringify(key)};\nexport const POSTHOG_HOST = ${JSON.stringify(host)};\n`
  : `${header}"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.POSTHOG_HOST = exports.POSTHOG_KEY = void 0;\nexports.POSTHOG_KEY = ${JSON.stringify(key)};\nexports.POSTHOG_HOST = ${JSON.stringify(host)};\n`;

writeFileSync(target, baked, "utf8");

// Verify the emitted JS actually loads with the baked values (format drift
// fails HERE, in the gate, not in a published tarball). The query string
// busts the ESM module cache in case the file was imported earlier.
let loaded;
if (isEsm) {
  loaded = await import(`${pathToFileURL(target).href}?baked=${Date.now()}`);
} else {
  loaded = createRequire(import.meta.url)(target);
}
if (loaded.POSTHOG_KEY !== key || loaded.POSTHOG_HOST !== host) {
  fail(`verification failed: the rewritten ${target} did not round-trip the baked values.`);
}

process.stdout.write(
  `bake-posthog-key: baked key (${key.slice(0, 6)}..., ${key.length} chars) and host (${host.length > 0 ? host : "<empty, runtime default>"}) into ${target}; module load verified.\n`,
);
