import { DatabaseSync, backup } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  fsyncSync,
  appendFileSync,
  chmodSync,
  unlinkSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
const magic = Buffer.from("CWBACKUP1");
function publishFile(source, destination) {
  const file = openSync(source, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  linkSync(source, destination);
  const directory = openSync(dirname(destination), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function keyFrom(file) {
  const key = readFileSync(file);
  if (key.length !== 32)
    throw Error("Backup key must contain exactly 32 raw bytes.");
  return key;
}
export async function encryptedBackup(databaseFile, destination, keyFile) {
  if (!existsSync(databaseFile)) throw Error("Database does not exist.");
  if (existsSync(destination))
    throw Error("Backup destination already exists.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), "closeword-backup-"));
  const temporary = join(work, "snapshot.sqlite");
  const staged = `${destination}.incomplete-${randomBytes(12).toString("hex")}`;
  const db = new DatabaseSync(databaseFile, { readOnly: true, timeout: 5000 });
  try {
    await backup(db, temporary);
    chmodSync(temporary, 0o600);
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", keyFrom(keyFile), nonce),
      output = createWriteStream(staged, { flags: "wx", mode: 0o600 });
    output.write(Buffer.concat([magic, nonce]));
    try {
      await pipeline(createReadStream(temporary), cipher, output);
      appendFileSync(staged, cipher.getAuthTag());
      publishFile(staged, destination);
    } catch (e) {
      if (existsSync(staged)) unlinkSync(staged);
      throw e;
    }
  } finally {
    db.close();
    if (existsSync(staged)) unlinkSync(staged);
    if (existsSync(temporary)) unlinkSync(temporary);
    rmSync(work, { recursive: true, force: true });
  }
  return destination;
}
export async function restoreBackup(source, destination, keyFile) {
  if (existsSync(destination))
    throw Error(
      "Restore refuses to overwrite an existing database. Restore to a new path.",
    );
  const size = statSync(source).size;
  if (size < magic.length + 12 + 16) throw Error("Invalid backup.");
  const fd = openSync(source, "r"),
    header = Buffer.alloc(magic.length + 12),
    tag = Buffer.alloc(16);
  try {
    readSync(fd, header, 0, header.length, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, magic.length).equals(magic))
    throw Error("Invalid backup format.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.restore-${randomBytes(8).toString("hex")}`;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFrom(keyFile),
      header.subarray(magic.length),
    );
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(source, { start: header.length, end: size - 17 }),
      decipher,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const db = new DatabaseSync(temporary);
    try {
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw Error("Restored database failed integrity validation.");
      db.exec(
        `BEGIN IMMEDIATE; DELETE FROM auth_sessions; DELETE FROM auth_challenges; UPDATE metadata SET value='' WHERE key='writer_owner'; UPDATE metadata SET value='0' WHERE key='writer_seen'; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);`,
      );
    } finally {
      db.close();
    }
    publishFile(temporary, destination);
    chmodSync(destination, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return destination;
}
