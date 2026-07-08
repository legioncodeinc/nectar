/**
 * The enricher refresh signal (scale-to-zero): the one-bit dirty flag that gates
 * the enricher's Deep Lake working-set refresh. Producer (registration)
 * `markDirty`s on a durable write; consumer (enricher) `consume`s read-and-clear.
 * Runs against the compiled module from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefreshSignal } from "../dist/enricher/refresh-signal.js";

test("starts dirty by default so the FIRST enricher cycle refreshes once", () => {
  const sig = createRefreshSignal();
  assert.equal(sig.dirty, true);
  assert.equal(sig.consume(), true);
});

test("consume is read-and-clear: a second consume with no markDirty is clean", () => {
  const sig = createRefreshSignal();
  assert.equal(sig.consume(), true); // the initial dirty
  assert.equal(sig.consume(), false); // idle: no refresh warranted
  assert.equal(sig.consume(), false);
});

test("markDirty re-arms exactly one refresh (idle-then-activity-then-idle)", () => {
  const sig = createRefreshSignal(false); // start clean to model a settled idle daemon
  assert.equal(sig.consume(), false); // idle tick: no Deep Lake read
  sig.markDirty(); // a file changed -> registration wrote durably
  assert.equal(sig.consume(), true); // next tick refreshes once
  assert.equal(sig.consume(), false); // then goes quiet again
});

test("multiple markDirty between consumes collapse to a single refresh", () => {
  const sig = createRefreshSignal(false);
  sig.markDirty();
  sig.markDirty();
  sig.markDirty();
  assert.equal(sig.consume(), true);
  assert.equal(sig.consume(), false);
});

test("dirty getter is non-destructive (observability, not consumption)", () => {
  const sig = createRefreshSignal(false);
  sig.markDirty();
  assert.equal(sig.dirty, true);
  assert.equal(sig.dirty, true); // reading it did not clear it
  assert.equal(sig.consume(), true); // consume still sees it
});
