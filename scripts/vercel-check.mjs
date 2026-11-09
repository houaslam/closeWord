import { existsSync } from "node:fs";
import { configuration } from "../config.mjs";
import { SupabaseStore } from "../lib/supabase-store.mjs";
import { RedisStore } from "../lib/redis-store.mjs";
// Use `node --env-file=.env.vercel.local scripts/vercel-check.mjs` for a pulled file.
const checks = [];
const [major, minor, patch] = process.versions.node.split(".").map(Number);
checks.push({
  check: "Supported Node.js 24 runtime",
  ok: major === 24 && (minor > 22 || (minor === 22 && patch >= 2)),
});
process.env.NODE_ENV = "production";
process.env.GAME_STORAGE ||= "supabase";
// A preflight check can run before Vercel assigns the actual deployment URL.
process.env.PUBLIC_ORIGIN ||= process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://preflight.invalid";
let config;
try {
  config = configuration();
  checks.push({ check: "Shared database environment configured", ok: true });
} catch (error) {
  checks.push({
    check: "Shared database environment configured",
    ok: false,
    reason: error.message,
  });
}
if (config) {
  if (config.storage === "supabase") {
    try {
      await new SupabaseStore(config).check();
      checks.push({
        check: "Supabase schema, server key and read/write permissions",
        ok: true,
      });
    } catch (error) {
      checks.push({
        check: "Supabase schema, server key and read/write permissions",
        ok: false,
        reason: error.status
          ? error.message
          : "Check Supabase URL, server key, and the SQL migration.",
      });
    }
  } else {
    const store = new RedisStore(config);
    try {
      if ((await store.command(["PING"])) !== "PONG") throw Error();
      const key = store.key("preflight:" + crypto.randomUUID());
      try {
        const result = await store.eval(
          "redis.call('SET',KEYS[1],ARGV[1],'EX',60);return redis.call('GET',KEYS[1])",
          [key],
          ["ok"],
        );
        if (result !== "ok") throw Error();
      } finally {
        await store.command(["DEL", key]);
      }
      checks.push({
        check: "Redis HTTPS connection, write permissions and Lua scripts",
        ok: true,
      });
    } catch {
      checks.push({
        check: "Redis HTTPS connection, write permissions and Lua scripts",
        ok: false,
        reason:
          "Check the database REST URL, read/write token, and database availability.",
      });
    }
  }
}
try {
  await import("../engine.mjs");
  checks.push({ check: "Bundled word artifacts", ok: true });
} catch {
  checks.push({ check: "Bundled word artifacts", ok: false });
}
checks.push({
  check: "Vercel configuration present",
  ok: existsSync("vercel.json"),
});
console.log(
  JSON.stringify(
    {
      ready: checks.every((c) => c.ok),
      checks,
      remainingVerification: [
        "Deploy a Preview and test six separate browsers/devices.",
        "Confirm the Production and Preview databases or namespaces are distinct.",
        "Monitor Vercel duration usage and database quotas.",
      ],
    },
    null,
    2,
  ),
);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
