import { encryptedBackup } from "../ops/backups.mjs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const directory = process.env.BACKUP_DIR || "/backups";
let stopped = false;
async function run() {
  const file = join(
    directory,
    `closeword-${new Date().toISOString().replaceAll(":", "-")}.sqlite.enc`,
  );
  try {
    await encryptedBackup(
      process.env.DATABASE_PATH || "/data/closeword.sqlite",
      file,
      process.env.BACKUP_KEY_FILE,
    );
    await writeFile("/tmp/backup-success", String(Date.now()), { mode: 0o600 });
    console.log(JSON.stringify({ event: "backup_complete", file }));
    for (const name of await readdir(directory)) {
      if (!/^closeword-.*\.sqlite\.enc$/.test(name)) continue;
      const path = join(directory, name);
      if ((await stat(path)).mtimeMs < Date.now() - 30 * 86400000)
        await unlink(path);
    }
  } catch {
    console.error(JSON.stringify({ event: "backup_failed" }));
    process.exit(1);
  }
  if (!stopped) setTimeout(run, 86400000);
}
process.on("SIGTERM", () => {
  stopped = true;
  process.exit(0);
});
await run();
