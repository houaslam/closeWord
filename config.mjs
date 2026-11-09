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
  const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin ||
    !["http:", "https:"].includes(parsed.protocol)
  )
    throw Error(
      "PUBLIC_ORIGIN must be an origin without a path or trailing slash.",
    );
  if (production) {
    if (parsed.protocol !== "https:")
      throw Error("Production requires an HTTPS PUBLIC_ORIGIN.");
  }
  return {
    production,
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
    trustProxy: process.env.TRUST_PROXY === "true",
    maxRooms: 2000,
    maxSolos: 20000,
    maxGuesses: 2000,
    maxStreams: 1000,
  };
}
