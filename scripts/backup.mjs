import { encryptedBackup } from "../ops/backups.mjs";
import { loadEnvironment } from "../config.mjs";
import { resolve } from "node:path";
loadEnvironment(process.cwd());
const target =
  process.argv[2] ||
  resolve(
    process.env.BACKUP_DIR || "backups",
    `closeword-${new Date().toISOString().replaceAll(":", "-")}.sqlite.enc`,
  );
if (!process.env.BACKUP_KEY_FILE)
  throw Error("Set BACKUP_KEY_FILE to a private 32-byte key file.");
await encryptedBackup(
  resolve(process.env.DATABASE_PATH || "data/mvp.sqlite"),
  target,
  process.env.BACKUP_KEY_FILE,
);
console.log(JSON.stringify({ event: "backup_complete", file: target }));
