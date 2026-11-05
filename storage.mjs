import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const tables = {
  rooms: "rooms",
  solos: "solos",
  records: "leaderboard",
};
const instances = new Map();
export function databaseFor(file) {
  const path = resolve(file);
  if (!instances.has(path)) instances.set(path, new Storage(path));
  return instances.get(path);
}
export class Storage {
  constructor(file) {
    this.file = resolve(file);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file, { timeout: 5000 });
    chmodSync(this.file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
    );
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1)
      throw Error("Database schema is newer than this application.");
    this.db.exec(`BEGIN IMMEDIATE;
   CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   CREATE TABLE IF NOT EXISTS solos(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   CREATE TABLE IF NOT EXISTS leaderboard(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   PRAGMA user_version=1; COMMIT;`);
    this.statements = new Map();
    this.snapshots = new Map();
    this.inTransaction = false;
    this.commitJobs = [];
    this.closed = false;
    this.dailyKey =
      this.meta("daily_key") ||
      this.setMeta("daily_key", randomBytes(32).toString("hex"));
  }
  statement(sql) {
    if (!this.statements.has(sql))
      this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    const snapshots = new Map(this.snapshots);
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    this.commitJobs = [];
    let result;
    try {
      if (this.owner) {
        this.assertOwner();
        this.setMeta("writer_seen", String(Date.now()));
      }
      result = fn();
      if (result?.then)
        throw Error("Database transactions must be synchronous.");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      if (String(e.code || "").startsWith("ERR_SQLITE")) this.healthy = false;
      this.snapshots = snapshots;
      this.commitJobs = [];
      throw e;
    } finally {
      this.inTransaction = false;
    }
    const jobs = this.commitJobs;
    this.commitJobs = [];
    for (const job of jobs) job();
    return result;
  }
  afterCommit(job) {
    if (this.inTransaction) this.commitJobs.push(job);
    else job();
  }

  meta(key) {
    return this.statement("SELECT value FROM metadata WHERE key=?").get(key)
      ?.value;
  }
  setMeta(key, value) {
    this.statement(
      "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, value);
    return value;
  }
  table(name) {
    if (!Object.values(tables).includes(name))
      throw Error("Unknown database collection");
    return name;
  }
  values(name) {
    return this.statement(`SELECT id,payload FROM ${this.table(name)}`)
      .all()
      .map((row) => ({ id: row.id, value: JSON.parse(row.payload) }));
  }
  get(name, id) {
    const row = this.statement(
      `SELECT payload FROM ${this.table(name)} WHERE id=?`,
    ).get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  put(name, id, value) {
    this.statement(
      `INSERT INTO ${this.table(name)}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
    ).run(String(id), JSON.stringify(value));
  }
  remove(name, id) {
    this.statement(`DELETE FROM ${this.table(name)} WHERE id=?`).run(id);
  }
  sync(name, rows) {
    const table = tables[name],
      previous = this.snapshots.get(name) || new Map(),
      next = new Map(
        rows.map(([id, value]) => [String(id), JSON.stringify(value)]),
      );
    this.transaction(() => {
      for (const [id, payload] of next)
        if (previous.get(id) !== payload)
          this.statement(
            `INSERT INTO ${table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
          ).run(id, payload);
      for (const id of previous.keys())
        if (!next.has(id)) this.remove(table, id);
    });
    this.snapshots.set(name, next);
  }
  importLegacy({ state } = {}) {
    if (!state || !existsSync(state) || this.meta("imported_state")) return;
    const data = JSON.parse(readFileSync(state, "utf8"));
    this.transaction(() => {
      for (const r of data.rooms || []) this.put("rooms", r.code, r);
      for (const [id, solo] of data.solos || []) this.put("solos", id, solo);
      for (const [i, record] of (data.records || []).entries())
        this.put("leaderboard", `legacy-${i}`, record);
      this.setMeta("imported_state", state);
    });
  }
  integrity() {
    return this.db.prepare("PRAGMA quick_check").get().quick_check === "ok";
  }
  async backup(destination) {
    await backup(this.db, destination);
    chmodSync(destination, 0o600);
  }
  assertOwner() {
    if (this.owner && this.meta("writer_owner") !== this.owner)
      throw Object.assign(
        Error("Database ownership was transferred to another server."),
        { code: "DATABASE_FENCED" },
      );
  }
  claimServer() {
    if (this.owner) throw Error("This database already has a game server.");
    const owner = randomBytes(24).toString("hex");
    this.transaction(() => {
      const existing = this.meta("writer_owner"),
        seen = Number(this.meta("writer_seen") || 0);
      if (existing && seen > Date.now() - 30000)
        throw Error(
          "Another game server owns this database. Run exactly one replica.",
        );
      this.setMeta("writer_owner", owner);
      this.setMeta("writer_seen", String(Date.now()));
    });
    this.owner = owner;
    this.lease = setInterval(() => {
      try {
        this.transaction(() => {});
      } catch {
        this.healthy = false;
        clearInterval(this.lease);
      }
    }, 5000);
    this.lease.unref();
  }

  close() {
    if (this.closed) return;
    if (this.lease) clearInterval(this.lease);
    if (this.owner && this.meta("writer_owner") === this.owner)
      this.transaction(() => {
        this.setMeta("writer_owner", "");
        this.setMeta("writer_seen", "0");
      });
    this.owner = null;
    this.closed = true;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    instances.delete(this.file);
  }
}
