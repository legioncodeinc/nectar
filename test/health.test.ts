import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthState, healthHttpStatus } from "../dist/health.js";

test("a fresh HealthState is ok and carries the purpose-built subsystem fields", () => {
  const h = new HealthState();
  const body = h.snapshot();
  assert.equal(body.status, "ok");
  assert.ok(body.uptimeMs >= 0);
  // nectar-native fields honeycomb's /health does not have (PRD-001b decision #20)
  assert.equal(body.brooding.active, false);
  assert.equal(body.enricher.queueDepth, 0);
  assert.equal(body.enricher.consecutiveFailures, 0);
  assert.equal(body.projection.lastWriteAt, null);
  assert.equal(body.cost.broodTotalUsd, 0);
  assert.equal(body.embeddings.provider, "off");
  assert.equal(body.portkey.enabled, false);
});

test("AC-018k.3 a dormant brooding daemon carries a machine-readable reason; a ready one clears it", () => {
  const h = new HealthState();
  // Fresh default: inactive, no reason yet.
  assert.equal(h.snapshot().brooding.active, false);
  assert.equal(h.snapshot().brooding.reason, null);

  // Dormant: the reason is surfaced on the existing brooding slice (not a new one).
  h.setBroodingState({ active: false, reason: "credentials_missing" });
  let body = h.snapshot();
  assert.equal(body.brooding.active, false);
  assert.equal(body.brooding.reason, "credentials_missing");

  h.setBroodingState({ reason: "portkey_disabled" });
  assert.equal(h.snapshot().brooding.reason, "portkey_disabled");

  // Ready/active: the reason clears back to null while active flips true.
  h.setBroodingState({ active: true, reason: null });
  body = h.snapshot();
  assert.equal(body.brooding.active, true);
  assert.equal(body.brooding.reason, null);
});

test("degrade flips the coarse bit doctor classifies on", () => {
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
