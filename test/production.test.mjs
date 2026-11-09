import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Storage } from "../storage.mjs";
import { encryptedBackup, restoreBackup } from "../ops/backups.mjs";
import { configuration, loadEnvironment } from "../config.mjs";
import { daily } from "../engine.mjs";
const temp = () => mkdtempSync(join(tmpdir(), "cw-production-"));
test("SQLite transactions roll back related state and do not publish rolled-back events", () => {
  const dir = temp(),
    db = new Storage(join(dir, "db.sqlite"));
  try {
    let published = false;
    assert.throws(() =>
      db.transaction(() => {
        db.sync("rooms", [["ROOM01", { code: "ROOM01" }]]);
        db.afterCommit(() => (published = true));
        throw Error("interrupted");
      }),
    );
    assert.equal(db.get("rooms", "ROOM01"), null);
    assert.equal(published, false);
    db.transaction(() => {
      db.sync("rooms", [["ROOM01", { code: "ROOM01" }]]);
      db.afterCommit(() => (published = true));
    });
    assert.equal(db.get("rooms", "ROOM01").code, "ROOM01");
    assert.equal(published, true);
    assert.equal(statSync(db.file).mode & 0o777, 0o600);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy guest games import once without modifying their source", () => {
  const dir = temp(),
    db = new Storage(join(dir, "db.sqlite")),
    state = join(dir, "state.json");
  try {
    const original = JSON.stringify({
      rooms: [{ code: "ABCDEF" }],
      solos: [],
      records: [],
    });
    writeFileSync(state, original);
    db.importLegacy({ state });
    db.importLegacy({ state });
    assert.equal(db.values("rooms").length, 1);
    assert.equal(readFileSync(state, "utf8"), original);
    assert.throws(() => db.values("users"), /Unknown/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("database fencing prevents two servers from writing even after lease takeover", () => {
  const dir = temp(),
    file = join(dir, "db.sqlite"),
    first = new Storage(file),
    second = new Storage(file);
  try {
    first.claimServer();
    assert.throws(() => second.claimServer(), /Another game server/);
    first.setMeta("writer_seen", "0");
    second.claimServer();
    assert.throws(
      () => first.transaction(() => first.put("rooms", "bad", {})),
      /ownership/,
    );
    second.transaction(() => second.put("rooms", "good", { code: "good" }));
    assert.equal(second.get("rooms", "bad"), null);
    assert.equal(second.get("rooms", "good").code, "good");
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("encrypted online backup restores consistent data, rejects tampering and overwrites", async () => {
  const dir = temp(),
    file = join(dir, "db.sqlite"),
    db = new Storage(file),
    key = join(dir, "key"),
    archive = join(dir, "backup.enc"),
    restored = join(dir, "restored.sqlite");
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  try {
    db.put("rooms", "ABCDEF", {
      code: "ABCDEF",
      players: [{ name: "PrivatePlayer" }],
    });
    await encryptedBackup(file, archive, key);
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    assert.ok(!readFileSync(archive).includes(Buffer.from("PrivatePlayer")));
    await restoreBackup(archive, restored, key);
    const recovered = new Storage(restored);
    assert.equal(recovered.integrity(), true);
    assert.equal(recovered.values("rooms").length, 1);
    recovered.close();
    await assert.rejects(
      () => restoreBackup(archive, restored, key),
      /overwrite/,
    );
    const damaged = readFileSync(archive);
    damaged[damaged.length - 20] ^= 1;
    writeFileSync(join(dir, "damaged.enc"), damaged);
    await assert.rejects(() =>
      restoreBackup(join(dir, "damaged.enc"), join(dir, "bad.sqlite"), key),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("production requires HTTPS but needs no email provider or account credentials", () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    assert.throws(configuration, /HTTPS/);
    process.env.PUBLIC_ORIGIN = "https://game.test.invalid";
    assert.equal(configuration().production, true);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
test("daily secrets are stable per deployment and do not follow the public day-index schedule", () => {
  const key = "deployment-secret-one";
  assert.equal(daily(key).target, daily(key).target);
  assert.ok(
    new Set(Array.from({ length: 12 }, (_, i) => daily("secret-" + i).target))
      .size > 1,
  );
});
test("concurrent backups never overwrite or remove a completed archive", async () => {
  const dir = temp(),
    file = join(dir, "db.sqlite"),
    db = new Storage(file),
    key = join(dir, "key"),
    archive = join(dir, "shared.enc");
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  try {
    db.put("rooms", "ABCDEF", { code: "ABCDEF" });
    const outcomes = await Promise.allSettled([
      encryptedBackup(file, archive, key),
      encryptedBackup(file, archive, key),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    await restoreBackup(archive, join(dir, "restored.sqlite"), key);
    const restored = new Storage(join(dir, "restored.sqlite"));
    assert.equal(restored.values("rooms").length, 1);
    restored.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret-file loading is repeatable across Next.js initialization and retries", () => {
  const dir = temp(),
    file = join(dir, "metrics.token"),
    saved = { ...process.env };
  try {
    writeFileSync(file, "test-private-metrics", { mode: 0o600 });
    process.env.NODE_ENV = "test";
    process.env.METRICS_TOKEN_FILE = file;
    delete process.env.METRICS_TOKEN;
    loadEnvironment(dir);
    loadEnvironment(dir);
    assert.equal(process.env.METRICS_TOKEN, "test-private-metrics");
    process.env.METRICS_TOKEN = "different";
    assert.throws(() => loadEnvironment(dir), /Configure only/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
