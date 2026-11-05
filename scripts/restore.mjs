import { restoreBackup } from "../ops/backups.mjs";
import { loadEnvironment } from "../config.mjs";
loadEnvironment(process.cwd());
const [, , source, destination] = process.argv;
if (!source || !destination || !process.env.BACKUP_KEY_FILE)
  throw Error(
    "Usage: BACKUP_KEY_FILE=/private/key node scripts/restore.mjs BACKUP NEW_DATABASE_PATH",
  );
await restoreBackup(source, destination, process.env.BACKUP_KEY_FILE);
console.log(
  JSON.stringify({
    event: "restore_complete",
    file: destination,
    sessionsRevoked: true,
  }),
);
