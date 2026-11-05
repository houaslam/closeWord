import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const tables = {
  users: "users",
  sessions: "auth_sessions",
  challenges: "auth_challenges",
  limits: "rate_limits",
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
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)),email TEXT GENERATED ALWAYS AS(json_extract(payload,'$.email')) STORED UNIQUE,nickname TEXT GENERATED ALWAYS AS(lower(json_extract(payload,'$.nickname'))) STORED UNIQUE) STRICT;
   CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)),user_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.userId')) STORED,expires_at INTEGER GENERATED ALWAYS AS(json_extract(payload,'$.expiresAt')) STORED) STRICT;
   CREATE INDEX IF NOT EXISTS sessions_user ON auth_sessions(user_id);
   CREATE INDEX IF NOT EXISTS sessions_expiry ON auth_sessions(expires_at);
   CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)),email TEXT GENERATED ALWAYS AS(json_extract(payload,'$.email')) STORED,expires_at INTEGER GENERATED ALWAYS AS(json_extract(payload,'$.expiresAt')) STORED) STRICT;
   CREATE INDEX IF NOT EXISTS challenges_email ON auth_challenges(email);
   CREATE TABLE IF NOT EXISTS rate_limits(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   CREATE TABLE IF NOT EXISTS solos(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   CREATE TABLE IF NOT EXISTS leaderboard(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
   CREATE TABLE IF NOT EXISTS game_history(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)),started_at INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS game_participants(game_id TEXT NOT NULL REFERENCES game_history(id) ON DELETE CASCADE,user_id TEXT NOT NULL,outcome TEXT NOT NULL,guess_count INTEGER NOT NULL,PRIMARY KEY(game_id,user_id)) STRICT;
   CREATE INDEX IF NOT EXISTS history_user ON game_participants(user_id,outcome);
   PRAGMA user_version=1; COMMIT;`);
    this.statements = new Map();
    this.snapshots = new Map();
    this.inTransaction = false;
    this.commitJobs = [];
    this.closed = false;
    this.key =
      this.meta("otp_key") ||
      this.setMeta("otp_key", randomBytes(32).toString("hex"));
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
    if (!Object.values(tables).includes(name) && name !== "game_history")
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
  loadAuth() {
    const data = { key: this.key };
    for (const key of ["users", "sessions", "challenges", "limits"]) {
      const rows = this.values(tables[key]);
      data[key] = rows.map((r) => r.value);
      this.snapshots.set(
        key,
        new Map(rows.map((r) => [r.id, JSON.stringify(r.value)])),
      );
    }
    return data;
  }
  saveAuth(data) {
    this.transaction(() => {
      for (const key of ["users", "sessions", "challenges", "limits"])
        this.sync(
          key,
          data[key].map((v) => [
            key === "sessions" ? v.hash : key === "limits" ? v.key : v.id,
            v,
          ]),
        );
    });
  }
  recordGame(game) {
    this.transaction(() => {
      this.statement(
        "INSERT INTO game_history(id,payload,started_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,started_at=excluded.started_at",
      ).run(game.id, JSON.stringify(game), game.startedAt);
      this.statement("DELETE FROM game_participants WHERE game_id=?").run(
        game.id,
      );
      for (const p of game.players.filter((p) => p.userId)) {
        const outcome = p.left
          ? "left"
          : game.status === "finished"
            ? game.winnerId === p.id
              ? "won"
              : "lost"
            : game.status === "abandoned"
              ? "abandoned"
              : "playing";
        const count = game.guesses.filter(
          (g) => game.kind === "solo" || g.playerId === p.id,
        ).length;
        this.statement(
          "INSERT INTO game_participants(game_id,user_id,outcome,guess_count) VALUES(?,?,?,?)",
        ).run(game.id, p.userId, outcome, count);
      }
    });
  }
  history(userId, { result = "all", limit = 21, offset = 0 } = {}) {
    return this.statement(
      `SELECT g.payload FROM game_history g JOIN game_participants p ON p.game_id=g.id WHERE p.user_id=? AND (?='all' OR p.outcome=?) ORDER BY g.started_at DESC,g.id DESC LIMIT ? OFFSET ?`,
    )
      .all(userId, result, result, limit, offset)
      .map((r) => JSON.parse(r.payload));
  }
  historyGame(userId, id) {
    const row = this.statement(
      "SELECT g.payload FROM game_history g JOIN game_participants p ON p.game_id=g.id WHERE p.user_id=? AND g.id=?",
    ).get(userId, id);
    return row ? JSON.parse(row.payload) : null;
  }
  summary(userId) {
    const row = this.statement(
      "SELECT count(*) AS games,coalesce(sum(outcome='won'),0) AS wins,coalesce(sum(outcome='lost'),0) AS losses,coalesce(sum(outcome IN ('left','abandoned')),0) AS left,coalesce(sum(outcome='playing'),0) AS playing,coalesce(sum(guess_count),0) AS totalGuesses FROM game_participants WHERE user_id=?",
    ).get(userId);
    return {
      ...row,
      winRate:
        row.wins + row.losses
          ? Math.round((row.wins / (row.wins + row.losses)) * 100)
          : 0,
    };
  }
  importLegacy({ accounts, state } = {}) {
    for (const [kind, file] of Object.entries({ accounts, state })) {
      if (!file || !existsSync(file) || this.meta(`imported_${kind}`)) continue;
      const data = JSON.parse(readFileSync(file, "utf8"));
      chmodSync(file, 0o600);
      this.transaction(() => {
        if (kind === "accounts") {
          if (this.values("users").length)
            throw Error(
              "Cannot import legacy accounts over an existing database.",
            );
          if (data.key) {
            this.key = data.key;
            this.setMeta("otp_key", data.key);
          }
          for (const key of ["users", "sessions", "challenges", "limits"])
            for (const v of data[key] || [])
              this.put(
                tables[key],
                key === "sessions" ? v.hash : key === "limits" ? v.key : v.id,
                v,
              );
          for (const g of data.games || []) this.recordGame(g);
        } else {
          for (const r of data.rooms || []) this.put("rooms", r.code, r);
          for (const [id, s] of data.solos || []) this.put("solos", id, s);
          for (const [i, r] of (data.records || []).entries())
            this.put("leaderboard", `legacy-${i}`, r);
        }
        this.setMeta(`imported_${kind}`, file);
      });
    }
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
