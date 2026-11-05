import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
mkdirSync(".secrets", { recursive: true, mode: 0o700 });
chmodSync(".secrets", 0o700);
for (const [name, value] of [
  ["backup.key", randomBytes(32)],
  ["metrics.token", randomBytes(32).toString("hex")],
  ["resend_api_key", ""],
]) {
  const file = `.secrets/${name}`;
  if (!existsSync(file))
    writeFileSync(file, value, { flag: "wx", mode: 0o600 });
}
console.log(
  "Private secret files initialized in .secrets/. Existing keys were preserved.",
);
