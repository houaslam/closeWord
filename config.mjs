import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
export function loadEnvironment(root) {
  const env = resolve(root, ".env");
  if (!["test", "production"].includes(process.env.NODE_ENV) && existsSync(env))
    process.loadEnvFile(env);
  for (const name of ["METRICS_TOKEN"]) {
    const file = process.env[`${name}_FILE`];
    if (file) {
      const value = readFileSync(file, "utf8").trim();
      if (process.env[name] && process.env[name] !== value)
        throw Error(`Configure only ${name} or ${name}_FILE`);
      process.env[name] = value;
    }
  }
}
export function configuration() {
  const production = process.env.NODE_ENV === "production";
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORT must be between 1 and 65535.");
  const vercel = process.env.VERCEL === "1";
  const generatedHost =
    vercel &&
    (process.env.VERCEL_ENV === "production"
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
      : process.env.VERCEL_URL);
  const originInput =
    process.env.PUBLIC_ORIGIN ||
    (generatedHost ? `https://${generatedHost}` : `http://localhost:${port}`);
  let parsed;
  try {
    parsed = new URL(originInput.trim());
  } catch {
    throw Error(
      "PUBLIC_ORIGIN must be an origin without a path or trailing slash.",
    );
  }
  const origin = parsed.origin;
  if (
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    !["http:", "https:"].includes(parsed.protocol)
  )
    throw Error(
      "PUBLIC_ORIGIN must be an origin without a path or trailing slash.",
    );
  if (production) {
    if (parsed.protocol !== "https:")
      throw Error("Production requires an HTTPS PUBLIC_ORIGIN.");
  }
  const storage = process.env.GAME_STORAGE || (vercel ? "redis" : "sqlite");
  if (!["sqlite", "redis"].includes(storage))
    throw Error("GAME_STORAGE must be sqlite or redis.");
  if (vercel && storage !== "redis")
    throw Error(
      "Vercel requires GAME_STORAGE=redis; local SQLite is not persistent there.",
    );
  const upstash = Boolean(
    process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN,
  );
  let redisUrl = (
    (upstash
      ? process.env.UPSTASH_REDIS_REST_URL
      : process.env.KV_REST_API_URL) || ""
  ).trim();
  const redisToken = (
    (upstash
      ? process.env.UPSTASH_REDIS_REST_TOKEN
      : process.env.KV_REST_API_TOKEN) || ""
  ).trim();
  if (storage === "redis") {
    if (!redisUrl || !redisToken)
      throw Error(
        "Redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_URL/TOKEN pair).",
      );
    let endpoint;
    try {
      endpoint = new URL(redisUrl);
    } catch {
      throw Error("Redis REST URL must be a valid HTTPS origin.");
    }
    const testLoopback =
      process.env.NODE_ENV === "test" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.protocol !== "https:" &&
        !(testLoopback && endpoint.protocol === "http:"))
    )
      throw Error("Redis REST URL must be an HTTPS origin without a path.");
    redisUrl = endpoint.origin;
  }
  const preview = vercel && process.env.VERCEL_ENV !== "production";
  const previewId = createHash("sha256")
    .update(
      process.env.VERCEL_URL || process.env.VERCEL_GIT_COMMIT_SHA || "local",
    )
    .digest("hex")
    .slice(0, 20);
  const namespace =
    process.env.GAME_NAMESPACE ||
    (vercel
      ? preview
        ? `preview-${previewId}`
        : "production"
      : "development");
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(namespace))
    throw Error(
      "GAME_NAMESPACE must use 1–80 letters, digits, colons, underscores or hyphens.",
    );
  const allowedOrigins = new Set([origin]);
  for (const host of vercel
    ? [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
    : []) {
    if (host) allowedOrigins.add(`https://${host}`);
  }
  return {
    production,
    vercel,
    storage,
    redisUrl,
    redisToken,
    namespace,
    allowedOrigins: [...allowedOrigins],
    port,
    origin,
    host: process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    database: resolve(
      process.env.DATABASE_PATH ||
        resolve(
          dirname(process.env.STATE_FILE || "data/state.json"),
          "mvp.sqlite",
        ),
    ),
    trustProxy: vercel || process.env.TRUST_PROXY === "true",
    maxRooms: 2000,
    maxSolos: 20000,
    maxGuesses: 2000,
    maxStreams: 1000,
  };
}
