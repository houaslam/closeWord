import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration } from "../config.mjs";
import { deploymentFailure } from "../lib/deployment-status.mjs";
test("deployment diagnostics distinguish missing settings from missing word artifacts without exposing secrets", () => {
  const missing = deploymentFailure(
    Error(
      "Redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_URL/TOKEN pair).",
    ),
    "configuration",
  );
  assert.equal(missing.code, "MISSING_REDIS_CONFIG");
  assert.match(missing.detail, /redeploy/);
  const invalid = deploymentFailure(
    Object.assign(Error("invalid URL contains private-secret"), {
      code: "ERR_INVALID_URL",
    }),
    "configuration",
  );
  assert.equal(invalid.code, "INVALID_PUBLIC_ORIGIN");
  assert.ok(!JSON.stringify(invalid).includes("private-secret"));
  const artifact = deploymentFailure(
    Object.assign(Error("private/path"), {
      code: "ENOENT",
      path: "/private/runtime/data/vectors.bin",
    }),
    "redis",
  );
  assert.equal(artifact.code, "MISSING_WORD_ARTIFACTS");
  assert.ok(!JSON.stringify(artifact).includes("private/runtime"));
  const unknown = deploymentFailure(
    Error("provider-token=private-secret"),
    "redis",
  );
  assert.equal(unknown.code, "GAME_INITIALIZATION_FAILED");
  assert.ok(!JSON.stringify(unknown).includes("private-secret"));
});

test("deployment URLs normalize a trailing root slash and reject credentials or non-root paths", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      GAME_STORAGE: "redis",
      PUBLIC_ORIGIN: " https://game.test.invalid/ ",
      UPSTASH_REDIS_REST_URL: " https://redis.test.invalid/ ",
      UPSTASH_REDIS_REST_TOKEN: " test-only-token ",
    });
    const config = configuration();
    assert.equal(config.origin, "https://game.test.invalid");
    assert.equal(config.redisUrl, "https://redis.test.invalid");
    assert.equal(config.redisToken, "test-only-token");
    process.env.PUBLIC_ORIGIN = "https://game.test.invalid/path";
    assert.throws(configuration, /PUBLIC_ORIGIN/);
    process.env.PUBLIC_ORIGIN = "https://game.test.invalid/";
    process.env.UPSTASH_REDIS_REST_URL =
      "https://private:secret@redis.test.invalid/";
    assert.throws(configuration, /Redis REST URL/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
