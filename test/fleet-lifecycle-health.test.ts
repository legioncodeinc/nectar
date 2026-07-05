/**
 * PRD-003a a-AC-1: a credentials-missing daemon serves 503 degraded on /health
 * with a machine-readable reason, while every other behavior is preserved.
 * PRD-003a a-AC-2: the credentials watch flips /health healthy without restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthState, healthHttpStatus } from "../dist/health.js";
import { CredentialsWatch } from "../dist/credentials-watch.js";

test("a-AC-1 setStorageState(unreachable) degrades /health to 503 with a machine-readable reason", () => {
  const h = new HealthState();
  // Fresh default is reachable/ok (200) so pre-003a callers are unaffected.
  assert.equal(h.snapshot().status, "ok");
  assert.equal(h.snapshot().storage.reachable, true);
  assert.equal(h.snapshot().storage.reason, null);
  assert.equal(healthHttpStatus(h.snapshot().status), 200);

  h.setStorageState({ reachable: false, reason: "credentials-missing" });
  const body = h.snapshot();
  assert.equal(body.status, "degraded");
  assert.equal(body.storage.reachable, false);
  assert.equal(body.storage.reason, "credentials-missing", "the machine-readable reason names the cause");
  assert.equal(healthHttpStatus(body.status), 503, "degraded maps to HTTP 503");
});

test("a-AC-1 the degraded storage posture preserves the brooding dormancy reason (other behavior intact)", () => {
  const h = new HealthState();
  h.setBroodingState({ active: false, reason: "credentials_missing" });
  h.setStorageState({ reachable: false, reason: "credentials-missing" });
  const body = h.snapshot();
  assert.equal(body.status, "degraded");
  assert.equal(body.brooding.reason, "credentials_missing", "brooding dormancy reason still surfaced alongside the 503");
});

test("a-AC-2 setStorageState(reachable) restores /health to 200 and clears the reason (no restart)", () => {
  const h = new HealthState();
  h.setStorageState({ reachable: false, reason: "credentials-missing" });
  assert.equal(h.snapshot().status, "degraded");

  // The credentials watch calls this on the SAME running state - no restart.
  h.setStorageState({ reachable: true, reason: null });
  const body = h.snapshot();
  assert.equal(body.status, "ok");
  assert.equal(body.storage.reachable, true);
  assert.equal(body.storage.reason, null, "the reason clears when storage becomes reachable");
  assert.equal(healthHttpStatus(body.status), 200);
});

test("a-AC-2 CredentialsWatch fires onChange only when the probed presence changes", () => {
  let present = false;
  const changes: boolean[] = [];
  const watch = new CredentialsWatch({
    probe: () => present,
    onChange: (p) => changes.push(p),
    intervalMs: 1000,
  });

  // First evaluation observes the initial (false) state and reports it.
  assert.equal(watch.evaluate(), true, "the first evaluation is a change (unknown -> false)");
  assert.deepEqual(changes, [false]);

  // No change while the probe stays false.
  assert.equal(watch.evaluate(), false, "no change when the probe is unchanged");
  assert.deepEqual(changes, [false]);

  // Credentials appear -> a change to true (the login-lands transition).
  present = true;
  assert.equal(watch.evaluate(), true, "a false -> true transition is a change");
  assert.deepEqual(changes, [false, true]);

  // Idempotent while present.
  assert.equal(watch.evaluate(), false);
  assert.deepEqual(changes, [false, true]);

  // Credentials removed -> a change back to false.
  present = false;
  assert.equal(watch.evaluate(), true);
  assert.deepEqual(changes, [false, true, false]);
});
