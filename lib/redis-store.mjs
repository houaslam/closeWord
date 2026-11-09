import { randomBytes } from "node:crypto";
// The compare-and-set, capacity, matchmaking and winner awards commit together.
const commitScript = `
local raw=redis.call('GET',KEYS[1])
local expected=tonumber(ARGV[1])
if raw then
  if expected < 0 or cjson.decode(raw).version ~= expected then return 0 end
elseif expected >= 0 then return -1 end
local now=tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
if not raw and redis.call('ZCARD',KEYS[2]) >= tonumber(ARGV[5]) then return -2 end
redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3])
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[3])*1000,ARGV[6])
redis.call('EXPIRE',KEYS[2],ARGV[3])
if ARGV[7]=='1' then
 redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3])*1000,ARGV[6])
 redis.call('EXPIRE',KEYS[3],ARGV[3])
else redis.call('ZREM',KEYS[3],ARGV[6]) end
local awards=cjson.decode(ARGV[8])
for _,award in ipairs(awards) do
 redis.call('ZINCRBY',KEYS[4],award[2],award[1])
 redis.call('ZINCRBY',KEYS[5],award[2],award[1])
end
if #awards>0 then redis.call('EXPIRE',KEYS[5],3024000) end
return 1`;
const rateScript = `local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return {n,redis.call('PTTL',KEYS[1])}`;
const presenceScript = `
local raw=redis.call('GET',KEYS[1]);if not raw then return {false,{}} end
local now=tonumber(ARGV[1]);local cutoff=now-tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',cutoff)
redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',cutoff)
redis.call('ZREMRANGEBYSCORE',KEYS[4],'-inf',cutoff)
if ARGV[2]~='' then
 local active=redis.call('ZRANGE',KEYS[3],0,-1);local count=0;local exists=false
 for _,member in ipairs(active) do
  if member==ARGV[3] then exists=true end
  if string.sub(member,1,string.len(ARGV[2])+1)==ARGV[2]..':' then count=count+1 end
 end
 if not exists and (count>=2 or redis.call('ZCARD',KEYS[4])>=tonumber(ARGV[5])) then return {'LIMIT',{}} end
 redis.call('ZADD',KEYS[2],now,ARGV[2])
 redis.call('ZADD',KEYS[3],now,ARGV[3])
 redis.call('ZADD',KEYS[4],now,ARGV[3])
 redis.call('EXPIRE',KEYS[2],60);redis.call('EXPIRE',KEYS[3],60);redis.call('EXPIRE',KEYS[4],60)
end
return {raw,redis.call('ZRANGE',KEYS[2],0,-1)}`;
const releaseScript = `redis.call('ZREM',KEYS[1],ARGV[1]);redis.call('ZREM',KEYS[2],ARGV[1]);return 1`;
const leadersScript = `
if #KEYS>1 then
 redis.call('ZUNIONSTORE',KEYS[1],#KEYS-1,unpack(KEYS,2))
 redis.call('EXPIRE',KEYS[1],10)
end
return redis.call('ZREVRANGE',KEYS[1],0,49,'WITHSCORES')`;
export function unavailable(
  message = "Game storage is temporarily unavailable. Please retry.",
) {
  return Object.assign(Error(message), { status: 503 });
}
export class RedisStore {
  constructor(config, { fetcher = fetch } = {}) {
    this.config = config;
    this.fetcher = fetcher;
    this.prefix = `cw:{${config.namespace}}:`;
  }
  key(value) {
    return this.prefix + value;
  }
  async command(args, { signal } = {}) {
    let response;
    try {
      response = await this.fetcher(this.config.redisUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.redisToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args.map(String)),
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw unavailable();
    }
    if (!response.ok) throw unavailable();
    let body;
    try {
      body = await response.json();
    } catch {
      throw unavailable();
    }
    if (body.error || !("result" in body)) throw unavailable();
    return body.result;
  }
  eval(script, keys, args = [], options) {
    return this.command(
      ["EVAL", script, keys.length, ...keys, ...args],
      options,
    );
  }
  async read(kind, id) {
    const raw = await this.eval("return redis.call('GET',KEYS[1])", [
      this.key(`${kind}:${id}`),
    ]);
    return raw ? JSON.parse(raw) : null;
  }
  async create(kind, id, value) {
    return this.commit(kind, id, -1, value);
  }
  async commit(kind, id, version, value, awards = []) {
    value.revision = version + 1;
    const now = Date.now(),
      day = Math.floor(now / 86400000),
      match =
        kind === "room" && value.public
          ? `match:${value.mode}:${value.maxPlayers}`
          : "unused";
    const result = await this.eval(
      commitScript,
      [
        this.key(`${kind}:${id}`),
        this.key(`${kind}:index`),
        this.key(match),
        this.key("leader:all"),
        this.key(`leader:day:${day}`),
      ],
      [
        version,
        JSON.stringify({ version: version + 1, value }),
        604800,
        now,
        kind === "room" ? this.config.maxRooms : this.config.maxSolos,
        id,
        kind === "room" &&
        value.public &&
        value.status === "waiting" &&
        value.players.length < value.maxPlayers
          ? 1
          : 0,
        JSON.stringify(awards),
      ],
    );
    if (result === -2) throw unavailable("Server is busy. Try again later.");
    return result === 1;
  }
  async mutate(kind, id, change) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const record = await this.read(kind, id);
      if (!record)
        throw Object.assign(
          Error(
            kind === "room"
              ? "Room not found. Check your code."
              : "Start a new puzzle.",
          ),
          { status: 404 },
        );
      const oldStatus = record.value.status,
        next = record.value;
      const changed = change(next);
      if (changed === false) return next;
      const awards =
        kind === "room" &&
        next.status === "finished" &&
        oldStatus !== "finished"
          ? next.players.map((p) => [p.name, p.id === next.winner ? 10 : 1])
          : [];
      if (await this.commit(kind, id, record.version, next, awards))
        return next;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 20)),
      );
    }
    throw unavailable("The room is busy. Please try your move again.");
  }
  async limit(key, max, window = 60000) {
    const [count, ttl] = await this.eval(
      rateScript,
      [this.key(`limit:${key}`)],
      [window],
    );
    if (count > max)
      throw Object.assign(Error("Too many requests. Try again later."), {
        status: 429,
        retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
      });
  }
  secret() {
    return this.eval(
      "local value=redis.call('GET',KEYS[1]);if value then return value end;redis.call('SET',KEYS[1],ARGV[1]);return ARGV[1]",
      [this.key("daily:key")],
      [randomBytes(32).toString("hex")],
    );
  }
  dailyTarget(day, target) {
    return this.eval(
      "local value=redis.call('GET',KEYS[1]);if value then return value end;redis.call('SET',KEYS[1],ARGV[1],'EX',864000);return ARGV[1]",
      [this.key(`daily:word:${day}`)],
      [target],
    );
  }
  async matches(mode, capacity) {
    return this.command([
      "ZRANGEBYSCORE",
      this.key(`match:${mode}:${capacity}`),
      Date.now(),
      "+inf",
      "LIMIT",
      0,
      20,
    ]);
  }
  async presence(code, playerId = "", connectionId = "", signal) {
    const [raw, online] = await this.eval(
      presenceScript,
      [
        this.key(`room:${code}`),
        this.key(`seen:${code}`),
        this.key(`streams:${code}`),
        this.key("streams:all"),
      ],
      [
        Date.now(),
        playerId,
        playerId ? `${playerId}:${connectionId}` : "",
        12000,
        this.config.maxStreams,
      ],
      { signal },
    );
    if (raw === "LIMIT")
      throw Object.assign(
        Error("Connection limit reached. Close another game tab."),
        { status: 429 },
      );
    if (!raw) throw Object.assign(Error("Room not found."), { status: 404 });
    return { room: JSON.parse(raw).value, online: new Set(online) };
  }
  release(code, playerId, connectionId) {
    return this.eval(
      releaseScript,
      [this.key(`streams:${code}`), this.key("streams:all")],
      [`${playerId}:${connectionId}`],
    );
  }
  async leaders(period) {
    let keys = [this.key("leader:all")];
    if (period === "week" || period === "month") {
      const days = period === "week" ? 7 : 30,
        day = Math.floor(Date.now() / 86400000);
      keys = [
        this.key(`leader:cache:${period}`),
        ...Array.from({ length: days }, (_, i) =>
          this.key(`leader:day:${day - i}`),
        ),
      ];
    }
    const rows = await this.eval(leadersScript, keys);
    return Array.from({ length: rows.length / 2 }, (_, i) => ({
      name: rows[i * 2],
      score: Number(rows[i * 2 + 1]),
    }));
  }
}
