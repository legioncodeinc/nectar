/**
 * EX-2 (daemon-api review L6): `envInt` in `config.ts` must reject trailing
 * garbage and out-of-range values with a clear startup error, rather than
 * silently truncating (`NECTAR_PORT=3854abc` -> 3854) or letting a 0 interval
 * become a 1 ms tight poll. Runs against the compiled module from `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveConfig, DEFAULT_PORT, DEFAULT_POLL_INTERVAL_MS } from "../dist/config.js";
import { ConfigError } from "../dist/errors.js";

/** Set an env var for the duration of `fn`, restoring it afterward. */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

test("EX-2 NECTAR_PORT with trailing garbage throws a clear ConfigError (not silent truncation)", () => {
  withEnv("NECTAR_PORT", "3854abc", () => {
    assert.throws(() => resolveConfig(), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match((err as Error).message, /NECTAR_PORT/);
      return true;
    });
  });
});

test("EX-2 NECTAR_PORT out of range (>65535, 0, negative) throws ConfigError", () => {
  for (const bad of ["70000", "0", "-5", "65536"]) {
    withEnv("NECTAR_PORT", bad, () => {
      assert.throws(() => resolveConfig(), ConfigError, `port ${bad} should be rejected`);
    });
  }
});

test("EX-2 a valid NECTAR_PORT is parsed exactly", () => {
  withEnv("NECTAR_PORT", "4321", () => {
    assert.equal(resolveConfig().port, 4321);
  });
});

test("EX-2 NECTAR_POLL_INTERVAL_MS below the safe floor throws (no 1 ms tight poll)", () => {
  for (const bad of ["0", "1", "500"]) {
    withEnv("NECTAR_POLL_INTERVAL_MS", bad, () => {
      assert.throws(() => resolveConfig(), ConfigError, `interval ${bad} should be rejected`);
    });
  }
});

test("EX-2 a valid NECTAR_POLL_INTERVAL_MS is parsed exactly", () => {
  withEnv("NECTAR_POLL_INTERVAL_MS", "5000", () => {
    assert.equal(resolveConfig().pollIntervalMs, 5000);
  });
});

test("EX-2 unset or blank env values fall back to the defaults", () => {
  withEnv("NECTAR_PORT", undefined, () => {
    withEnv("NECTAR_POLL_INTERVAL_MS", "   ", () => {
      const config = resolveConfig();
      assert.equal(config.port, DEFAULT_PORT);
      assert.equal(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    });
  });
});

test("EX-2 an explicit override bypasses env parsing (an ephemeral port 0 override still works)", () => {
  withEnv("NECTAR_PORT", "3854abc", () => {
    // The override short-circuits envInt, so a garbage env var does not throw here.
    assert.equal(resolveConfig({ port: 0 }).port, 0);
  });
});

test("a-AC-2 resolveConfig default runtimeDir follows APIARY_HOME/nectar when APIARY_HOME is set", () => {
  withEnv("APIARY_HOME", "/custom/root", () => {
    withEnv("NECTAR_RUNTIME_DIR", undefined, () => {
      const cfg = resolveConfig();
      assert.equal(cfg.runtimeDir, join("/custom/root", "nectar"));
      assert.equal(cfg.pidFilePath, join("/custom/root", "nectar", "nectar.pid"));
      assert.equal(cfg.lockFilePath, join("/custom/root", "nectar", "nectar.lock"));
    });
  });
});

test("NECTAR_ENRICHER_ENABLED defaults to true (enricher on)", () => {
  withEnv("NECTAR_ENRICHER_ENABLED", undefined, () => {
    assert.equal(resolveConfig().enricherEnabled, true);
  });
});

test("NECTAR_ENRICHER_ENABLED kill switch: false/0/off/no disable the enricher", () => {
  for (const off of ["false", "0", "off", "no", "FALSE", "Off"]) {
    withEnv("NECTAR_ENRICHER_ENABLED", off, () => {
      assert.equal(resolveConfig().enricherEnabled, false, `"${off}" should disable the enricher`);
    });
  }
});

test("NECTAR_ENRICHER_ENABLED true/1/on/yes enable it; garbage falls back to the default", () => {
  for (const on of ["true", "1", "on", "yes"]) {
    withEnv("NECTAR_ENRICHER_ENABLED", on, () => {
      assert.equal(resolveConfig().enricherEnabled, true);
    });
  }
  withEnv("NECTAR_ENRICHER_ENABLED", "maybe", () => {
    assert.equal(resolveConfig().enricherEnabled, true, "unrecognized value falls back to the default");
  });
});

test("enricherEnabled override wins over the env (resolveConfig precedence)", () => {
  withEnv("NECTAR_ENRICHER_ENABLED", "false", () => {
    assert.equal(resolveConfig({ enricherEnabled: true }).enricherEnabled, true);
  });
});
