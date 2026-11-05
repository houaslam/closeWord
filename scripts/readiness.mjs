import { loadEnvironment, configuration } from "../config.mjs";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
loadEnvironment(process.cwd());
const checks = [];
let config;
const [major, minor, patch] = process.versions.node.split(".").map(Number);
checks.push({
  check: "Node.js 24.22.2+ LTS",
  ok: major === 24 && (minor > 22 || (minor === 22 && patch >= 2)),
});
try {
  config = configuration();
  checks.push({ check: "Environment configuration", ok: true });
} catch (e) {
  checks.push({
    check: "Environment configuration",
    ok: false,
    reason: e.message,
  });
}
checks.push({
  check: "HTTPS public origin",
  ok: Boolean(process.env.PUBLIC_ORIGIN?.startsWith("https://")),
});
checks.push({
  check: "Email credentials present (delivery not verified)",
  ok: Boolean(
    process.env.RESEND_API_KEY &&
    process.env.EMAIL_FROM &&
    !process.env.EMAIL_FROM.includes(".example"),
  ),
});
if (!process.argv.includes("--application-only"))
  checks.push({
    check: "Encrypted backup key",
    ok: Boolean(
      process.env.BACKUP_KEY_FILE &&
      existsSync(process.env.BACKUP_KEY_FILE) &&
      readFileSync(process.env.BACKUP_KEY_FILE).length === 32,
    ),
  });
checks.push({
  check: "Production mode",
  ok: process.env.NODE_ENV === "production",
});
try {
  if (!config || !existsSync(config.database))
    throw Error("Database is not initialized.");
  const db = new DatabaseSync(config.database, { readOnly: true });
  try {
    checks.push({
      check: "Database integrity",
      ok: db.prepare("PRAGMA quick_check").get().quick_check === "ok",
    });
  } finally {
    db.close();
  }
} catch (e) {
  checks.push({ check: "Database integrity", ok: false, reason: e.message });
}
try {
  await import("../engine.mjs");
  checks.push({ check: "Word artifact checksums", ok: true });
} catch {
  checks.push({ check: "Word artifact checksums", ok: false });
}
console.log(
  JSON.stringify(
    {
      ready: checks.every((c) => c.ok),
      externalChecks: [
        "Real email delivery",
        "Public TLS certificate",
        "Off-host backup copy and restore",
        "Operator alerts",
      ],
      checks,
    },
    null,
    2,
  ),
);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
