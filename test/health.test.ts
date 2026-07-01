import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthState, healthHttpStatus } from "../dist/health.js";

test("a fresh HealthState is ok and carries the purpose-built subsystem fields", () => {
  const h = new HealthState();
  const body = h.snapshot();
  assert.equal(body.status, "ok");
  assert.ok(body.uptimeMs >= 0);
  // hivenectar-native fields honeycomb's /health does not have (PRD-001b decision #20)
  assert.equal(body.brooding.active, false);
  assert.equal(body.enricher.queueDepth, 0);
  assert.equal(body.enricher.consecutiveFailures, 0);
  assert.equal(body.projection.lastWriteAt, null);
  assert.equal(body.cost.broodTotalUsd, 0);
  assert.equal(body.embeddings.provider, "off");
  assert.equal(body.portkey.enabled, false);
});

test("degrade flips the coarse bit hivedoctor classifies on", () => {
  const h = new HealthState();
  assert.equal(h.pipelineStatus, "ok");
  h.degrade();
  assert.equal(h.pipelineStatus, "degraded");
  assert.equal(h.snapshot().status, "degraded");
});

test("healthHttpStatus maps ok->200 and degraded->503", () => {
  assert.equal(healthHttpStatus("ok"), 200);
  assert.equal(healthHttpStatus("degraded"), 503);
});

test("uptime grows relative to a supplied start time", () => {
  const h = new HealthState();
  h.markStarted(1000);
  assert.equal(h.snapshot(1500).uptimeMs, 500);
});
