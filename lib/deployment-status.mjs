import { basename } from "node:path";
export function deploymentFailure(error, stage) {
  const message = String(error?.message || "");
  if (stage === "configuration") {
    if (message.startsWith("Supabase requires SUPABASE_URL"))
      return {
        code: "MISSING_SUPABASE_CONFIG",
        detail:
          "Set SUPABASE_URL and SUPABASE_SECRET_KEY in Vercel, run the Supabase SQL migration, then redeploy.",
      };
    if (message.startsWith("Supabase URL"))
      return {
        code: "INVALID_SUPABASE_URL",
        detail: "Use your Supabase project's HTTPS URL without a path.",
      };
    if (message.startsWith("Supabase requires a server"))
      return {
        code: "INVALID_SUPABASE_KEY",
        detail:
          "Use a server secret key or the legacy service_role key; do not use an anon or publishable key.",
      };
    if (message.startsWith("Redis requires UPSTASH_REDIS_REST_URL"))
      return {
        code: "MISSING_REDIS_CONFIG",
        detail:
          "Connect Upstash Redis and add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to this Vercel environment, then redeploy.",
      };
    if (message.startsWith("Redis REST URL"))
      return {
        code: "INVALID_REDIS_URL",
        detail:
          "Set the Redis REST URL to the database HTTPS origin without a path or trailing slash.",
      };
    if (message.includes("PUBLIC_ORIGIN") || error?.code === "ERR_INVALID_URL")
      return {
        code: "INVALID_PUBLIC_ORIGIN",
        detail:
          "Enable Vercel system environment variables, or set PUBLIC_ORIGIN to the deployment HTTPS origin without a trailing slash.",
      };
    if (message.includes("GAME_STORAGE"))
      return {
        code: "INVALID_STORAGE",
        detail: "Use GAME_STORAGE=supabase (or redis) for Vercel deployments.",
      };
    if (message.startsWith("GAME_NAMESPACE"))
      return {
        code: "INVALID_NAMESPACE",
        detail:
          "Use 1–80 letters, digits, colons, underscores or hyphens in GAME_NAMESPACE.",
      };
    if (message.startsWith("PORT must"))
      return {
        code: "INVALID_PORT",
        detail: "Remove the custom PORT variable from Vercel settings.",
      };
    return {
      code: "INVALID_DEPLOYMENT_CONFIG",
      detail:
        "Review the deployment environment variables and Vercel function logs.",
    };
  }
  const missing =
    error?.code === "ENOENT" ? basename(String(error.path || "")) : "";
  if (["words.json", "vectors.bin", "manifest.json"].includes(missing))
    return {
      code: "MISSING_WORD_ARTIFACTS",
      detail:
        "The deployment is missing its bundled word model. Rebuild and redeploy the latest main branch.",
    };
  if (error?.code === "ENOENT")
    return {
      code: "MISSING_RUNTIME_FILE",
      detail:
        "Check function logs for missing runtime files. File-based local secrets must not be configured on Vercel.",
    };
  return {
    code: "GAME_INITIALIZATION_FAILED",
    detail:
      "Check Vercel function logs for the service initialization failure.",
  };
}
export function revision() {
  const value = process.env.VERCEL_GIT_COMMIT_SHA;
  return /^[a-f0-9]{7,40}$/i.test(value || "") ? value.slice(0, 7) : undefined;
}
