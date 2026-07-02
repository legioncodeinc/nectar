/**
 * The PostHog ingest destination stub for USAGE telemetry (lifecycle events).
 * Not related to src/telemetry/, which is the doctor SQLite fleet store.
 *
 * BOTH constants are committed EMPTY and MUST stay "" in source. nectar
 * builds with plain tsc (no esbuild, so no `define` mechanism); the real
 * values are baked into the compiled OUTPUT instead: the release workflow's
 * gate job runs scripts/bake-posthog-key.mjs after the last build step, which
 * rewrites dist/telemetry-usage/posthog-key.js in place from the
 * NECTAR_POSTHOG_KEY / NECTAR_POSTHOG_HOST environment (the HONEYCOMB_* names
 * are a detected fallback while the family shares one ingest project; never
 * required, per ADR-0002). The baked dist/ is what the publish job ships
 * verbatim.
 *
 * An empty key hard-disables usage telemetry (src/telemetry-usage/emit.ts
 * gate 1), so every dev/source/fork build sends nothing. The key is a public
 * write-only PostHog ingest key, not a read-capable secret; it is still kept
 * out of source so unkeyed builds stay silent by construction.
 */
export const POSTHOG_KEY = "";
export const POSTHOG_HOST = "";
