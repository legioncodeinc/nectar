/**
 * PRD-003b b-AC-5: the new bare verbs (start/stop/uninstall/login/status) are
 * wired, and every existing spelling (daemon/install/uninstall/service-status)
 * keeps working, with `service-status` an alias of the new `status` verb.
 * `main(["--help"])` lists them and exits 0 (AC-9: a clear terminating flow).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../dist/cli.js";

const src = readFileSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "utf8");

test("b-AC-5 status and service-status route to the SAME handler (alias)", () => {
  assert.match(src, /command === "status" \|\| command === "service-status"/, "service-status is an alias of status");
});

test("b-AC-5 the new bare verbs are dispatched", () => {
  assert.match(src, /command === "login"/);
  assert.match(src, /command === "start"/);
  assert.match(src, /command === "stop"/);
  assert.match(src, /command === "uninstall"/);
});

test("b-AC-5 the existing spellings keep working (daemon / install / service-status)", () => {
  assert.match(src, /command === "daemon"/);
  assert.match(src, /command === "install"/);
  assert.match(src, /command === "service-status"/);
});

test("AC-9 main --help lists the lifecycle + login verbs and exits 0", async () => {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(String(s));
    return true;
  };
  let code: number;
  try {
    code = await main(["--help"]);
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  const usage = lines.join("");
  assert.equal(code, 0);
  for (const verb of ["nectar login", "nectar start", "nectar stop", "nectar uninstall", "nectar status"]) {
    assert.ok(usage.includes(verb), `USAGE documents '${verb}'`);
  }
});
