import http from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, extname, dirname } from "node:path";
import { databaseFor } from "./storage.mjs";
import { loadEnvironment, configuration } from "./config.mjs";
import {
  limit,
  clientIp,
  log,
  observe,
  telemetry,
  authorizedMetrics,
  readJson,
} from "./operations.mjs";
import { Accounts } from "./auth.mjs";
import {
  daily,
  randomTarget,
  rankWord as calculateRank,
  hintWord,
} from "./engine.mjs";
const root = fileURLToPath(new URL(".", import.meta.url));
loadEnvironment(root);
const config = configuration();
const stateFile = process.env.STATE_FILE || join(root, "data", "state.json");
const database = databaseFor(config.database);
database.importLegacy({
  state: stateFile,
  accounts: process.env.AUTH_FILE || join(dirname(stateFile), "accounts.json"),
});
database.claimServer();
const accounts = new Accounts(
  process.env.AUTH_FILE || join(dirname(stateFile), "accounts.json"),
  { database },
);
const rooms = new Map(
  database
    .values("rooms")
    .map(({ value: r }) => [
      r.code,
      { ...r, maxPlayers: r.maxPlayers ?? 6, clients: new Map() },
    ]),
);
const solos = new Map(
  database.values("solos").map(({ id, value }) => [id, value]),
);
// Reconstruct snapshots so only changed rows are written on a mutation.
database.snapshots.set(
  "rooms",
  new Map(database.values("rooms").map((r) => [r.id, JSON.stringify(r.value)])),
);
database.snapshots.set(
  "solos",
  new Map(database.values("solos").map((r) => [r.id, JSON.stringify(r.value)])),
);
function persist() {
  database.transaction(() => {
    database.sync(
      "rooms",
      [...rooms.values()].map(({ clients, ...r }) => [r.code, r]),
    );
    database.sync("solos", [...solos]);
  });
}
const metrics = telemetry();
let shuttingDown = false;
let streamCount = 0;
const id = () => randomBytes(18).toString("hex");
const roomCode = () =>
  [...randomBytes(6)]
    .map((byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte & 31])
    .join("");
const cleanName = (n) =>
  String(n || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 24);
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
function rankWord(target, word) {
  try {
    return calculateRank(target, word);
  } catch (e) {
    fail(e.message);
  }
}
function player(room, token, user) {
  const p = room.players.find((p) => p.token === token);
  if (p?.userId && p.userId !== user?.id)
    fail("Log in to the account that joined this game.", 403);
  if (!p) fail("Join this room first.", 403);
  return p;
}
function roomView(r, viewerId) {
  return {
    code: r.code,
    mode: r.mode,
    maxPlayers: r.maxPlayers,
    status: r.status,
    host: r.host,
    turn: r.turn,
    round: r.round,
    players: r.players.map(({ token, userId, ...p }) => ({
      ...p,
      online: r.clients.has(p.id),
      guessCount: r.guesses.filter((g) => g.playerId === p.id).length,
      bestRank: r.guesses.some((g) => g.playerId === p.id)
        ? Math.min(
            ...r.guesses.filter((g) => g.playerId === p.id).map((g) => g.rank),
          )
        : null,
    })),
    guesses:
      r.mode === "race" && r.status !== "finished"
        ? r.guesses.filter((g) => g.playerId === viewerId)
        : r.guesses,
    winner: r.winner,
    answer: r.status === "finished" ? r.target : undefined,
    created: r.created,
  };
}
function emit(r) {
  persist();
  database.afterCommit(() => {
    for (const [playerId, streams] of r.clients) {
      const body = `data: ${JSON.stringify(roomView(r, playerId))}\n\n`;
      for (const stream of streams) {
        if (stream.destroyed) continue;
        if (
          (stream.accountSession &&
            !accounts.sessionValid(stream.accountSession)) ||
          stream.writableLength > 262144
        ) {
          stream.end();
          continue;
        }
        stream.write(body);
      }
    }
  });
}

function nextTurn(r) {
  const connected = r.players.filter((p) => r.clients.has(p.id));
  const eligible = connected.length ? connected : r.players;
  const i = r.players.findIndex((p) => p.id === r.turn);
  for (let j = 1; j <= r.players.length; j++) {
    const p = r.players[(i + j) % r.players.length];
    if (eligible.includes(p)) {
      r.turn = p.id;
      return;
    }
  }
}
function addPlayer(r, name, user) {
  if (user) {
    const existing = r.players.find((p) => p.userId === user.id);
    if (existing) return existing;
  }
  if (r.status !== "waiting") fail("This game has already started.", 409);
  if (r.players.length >= r.maxPlayers)
    fail(`This room is full (${r.maxPlayers} players).`, 409);
  if (!name) fail("Choose a nickname.");
  const p = {
    id: id(),
    token: id(),
    name: user?.nickname || name,
    userId: user?.id,
    member: Boolean(user),
    avatar: r.players.length,
    score: 0,
  };
  r.players.push(p);
  if (!r.host) r.host = p.id;
  return p;
}
function saveRoomHistory(r, status = r.status) {
  if (!r.gameId || !r.participants?.some((p) => p.userId)) return;
  accounts.recordGame({
    id: r.gameId,
    kind: "multiplayer",
    mode: r.mode,
    round: r.round,
    status,
    startedAt: r.started,
    finishedAt:
      status === "finished" || status === "abandoned" ? Date.now() : undefined,
    word: status === "finished" ? r.target : undefined,
    winnerId: r.winner,
    players: r.participants.map((p) => ({
      ...p,
      left: !r.players.some((q) => q.id === p.id),
    })),
    guesses: r.guesses.map((g) => ({ ...g })),
  });
}
function saveSoloHistory(s, key, status = s.won ? "finished" : "playing") {
  if (!s.userId) return;
  accounts.recordGame({
    id: s.gameId,
    kind: "solo",
    mode: s.mode,
    status,
    startedAt: s.created,
    finishedAt:
      status === "abandoned" ? Date.now() : s.won ? s.finishedAt : undefined,
    word: s.won ? s.target : undefined,
    winnerId: s.won ? s.userId : undefined,
    players: [{ id: s.userId, userId: s.userId, name: s.nickname }],
    guesses: s.guesses.map((g) => ({
      ...g,
      playerId: s.userId,
      name: s.nickname,
    })),
  });
}
const rates = new Map();
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    res.end("Invalid request URL");
    return;
  }
  observe(req, res, url.pathname, metrics);
  req.clientIp = clientIp(req, config.trustProxy);
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (accounts.secure)
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  function json(data, status = 200) {
    if (database.inTransaction) return { data, status };
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  try {
    database.assertOwner();
    if (database.healthy === false) fail("Database is unavailable.", 503);
    if (url.pathname === "/health/live")
      return json({ ok: !shuttingDown }, shuttingDown ? 503 : 200);
    if (url.pathname === "/health/ready") {
      const ready =
        !shuttingDown &&
        database.statement("SELECT 1 AS ok").get().ok === 1 &&
        (!config.production || accounts.configured());
      return json({ ready }, ready ? 200 : 503);
    }
    if (url.pathname === "/metrics") {
      if (!authorizedMetrics(req)) fail("Not found.", 404);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(
        metrics.snapshot() +
          `closeword_streams ${streamCount}\ncloseword_rooms ${rooms.size}\n`,
      );
      return;
    }
    if (shuttingDown) fail("Server is restarting. Please retry shortly.", 503);
    if (url.pathname.startsWith("/api/")) {
      limit(`api:${req.clientIp}`, 240);
      const user = accounts.user(req);
      if (
        req.headers.origin &&
        (config.production
          ? req.headers.origin !== config.origin
          : req.headers.origin !== `http://${req.headers.host}` &&
            req.headers.origin !== `https://${req.headers.host}`)
      )
        fail("Origin not allowed.", 403);
      if (
        req.method === "POST" &&
        (req.headers["sec-fetch-site"] === "cross-site" ||
          (config.production && !req.headers.origin))
      )
        fail("Origin not allowed.", 403);
      if (
        req.method === "GET" &&
        (url.pathname.startsWith("/api/auth/") ||
          url.pathname.startsWith("/api/account"))
      )
        return json(await accounts.handle(req, res, url));
      if (req.method === "GET" && url.pathname === "/api/health")
        return json({ ok: true, maxPlayers: 6 });
      if (req.method === "GET" && url.pathname === "/api/leaderboard") {
        const period = url.searchParams.get("period");
        const cutoff =
          period === "week"
            ? Date.now() - 7 * 86400000
            : period === "month"
              ? Date.now() - 30 * 86400000
              : 0;
        return json(
          database
            .statement(
              "SELECT json_extract(payload,'$.name') AS name,sum(json_extract(payload,'$.points')) AS score FROM leaderboard WHERE json_extract(payload,'$.time')>=? GROUP BY name ORDER BY score DESC LIMIT 50",
            )
            .all(cutoff),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        const r = rooms.get(url.searchParams.get("code"));
        if (!r) fail("Room not found.", 404);
        const p = player(r, url.searchParams.get("token"), user);
        if (
          streamCount >= config.maxStreams ||
          (r.clients.get(p.id)?.size || 0) >= 2
        )
          fail("Connection limit reached. Close another game tab.", 429);
        streamCount++;
        res.setTimeout(0);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 1500\n\n");
        if (p.userId) res.accountSession = accounts.sessionHash(req);
        if (!r.clients.has(p.id)) r.clients.set(p.id, new Set());
        r.clients.get(p.id).add(res);
        emit(r);
        const heartbeat = setInterval(() => {
          if (
            res.accountSession &&
            !accounts.sessionValid(res.accountSession)
          ) {
            res.end();
            return;
          }
          res.write(": ping\n\n");
        }, 20000);
        res.on("close", () => {
          streamCount--;
          clearInterval(heartbeat);
          const streams = r.clients.get(p.id);
          streams?.delete(res);
          if (streams?.size === 0) {
            r.clients.delete(p.id);
            if (r.status === "playing" && r.turn === p.id) nextTurn(r);
          }
          emit(r);
        });
        return;
      }
      if (req.method !== "POST") fail("Not found", 404);
      if (
        String(req.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        fail("Use application/json.", 415);
      const b = await readJson(req);
      if (url.pathname.startsWith("/api/auth/"))
        return json(await accounts.handle(req, res, url, b));
      const result = database.transaction(() => {
        if (url.pathname === "/api/solo/new") {
          limit(`solo-new:${req.clientIp}`, 60);
          const mode =
            b.mode === "practice"
              ? "practice"
              : b.mode === "challenge"
                ? "challenge"
                : "daily";
          const d = daily(database.dailyKey);
          const dayKey = `daily:${d.id}`;
          const savedWord = database.meta(dayKey);
          if (savedWord) d.target = savedWord;
          else {
            const existing = [...solos.values()].find(
              (s) =>
                s.mode === "daily" && Math.floor(s.created / 86400000) === d.id,
            );
            if (existing) d.target = existing.target;
            database.setMeta(dayKey, d.target);
          }
          let target = mode === "daily" ? d.target : randomTarget();
          if (mode === "challenge") {
            const r = rooms.get(b.code);
            if (!r || r.mode !== "challenge") fail("Challenge not found.", 404);
            target = r.target;
          }
          const key =
            mode === "daily" &&
            (user || /^[a-z0-9-]{8,80}$/i.test(b.device || ""))
              ? `${user ? "account:" + user.id : "device:" + b.device}:${d.id}`
              : id();
          if (!solos.has(key) && solos.size >= config.maxSolos)
            fail("Server is busy. Try again later.", 503);
          if (!solos.has(key))
            solos.set(key, {
              target,
              guesses: [],
              hints: 0,
              mode,
              won: false,
              userId: user?.id,
              nickname: user?.nickname,
              gameId: id(),
              created: Date.now(),
            });
          persist();
          const s = solos.get(key);
          if (s.userId && s.userId !== user?.id)
            fail("Please log in to continue this puzzle.", 403);
          saveSoloHistory(s, key);
          return json({
            token: key,
            ...s,
            target: undefined,
            number: d.number,
            answer: s.won ? s.target : undefined,
          });
        }
        if (
          url.pathname === "/api/solo/guess" ||
          url.pathname === "/api/solo/hint"
        ) {
          const s = solos.get(b.token);
          if (!s) fail("Start a new puzzle.", 404);
          if (s.userId && s.userId !== user?.id)
            fail("Please log in to continue this puzzle.", 403);
          if (s.won) fail("You already solved this puzzle.");
          limit(`solo-guess:${b.token}`, 120);
          if (s.guesses.length >= config.maxGuesses)
            fail("Guess limit reached. Start a new practice game.");
          let word = String(b.word || "")
            .trim()
            .toLowerCase();
          const hint = url.pathname.endsWith("/hint");
          if (hint) {
            if (s.hints >= 3) fail("No hints remaining.");
            word = hintWord(s.target, s.guesses, b.difficulty);
          }
          if (s.guesses.some((g) => g.word === word))
            fail("You already guessed that word.");
          const rank = rankWord(s.target, word);
          s.guesses.push({ word, rank, hint });
          if (hint) s.hints++;
          s.won = rank === 1;
          if (s.won) s.finishedAt = Date.now();
          saveSoloHistory(s, b.token);
          persist();
          return json({
            ...s,
            target: undefined,
            answer: s.won ? s.target : undefined,
          });
        }
        if (url.pathname === "/api/challenge") {
          limit(`room-create:${req.clientIp}`, 20, 3600000);
          if (rooms.size >= config.maxRooms)
            fail("Server is busy. Try again later.", 503);
          const word = String(b.word || "")
            .trim()
            .toLowerCase();
          if (!/^[a-z]+$/.test(word)) fail("Enter one English word.");
          rankWord(word, word);
          let code;
          do {
            code = roomCode();
          } while (rooms.has(code));
          rooms.set(code, {
            code,
            target: word,
            mode: "challenge",
            status: "waiting",
            players: [],
            guesses: [],
            clients: new Map(),
            created: Date.now(),
          });
          persist();
          return json({ code });
        }
        if (url.pathname === "/api/rooms" || url.pathname === "/api/match") {
          limit(`room-create:${req.clientIp}`, 20, 3600000);
          const name = user?.nickname || cleanName(b.name);
          if (!name) fail("Choose a nickname.");
          const mode = b.mode === "race" ? "race" : "turn";
          const maxPlayers = b.maxPlayers === undefined ? 6 : b.maxPlayers;
          if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6)
            fail("Choose between 2 and 6 players.");
          let r;
          if (url.pathname === "/api/match")
            r = [...rooms.values()].find(
              (r) =>
                r.public &&
                r.mode === mode &&
                r.maxPlayers === maxPlayers &&
                r.status === "waiting" &&
                r.players.length < r.maxPlayers,
            );
          if (!r) {
            if (rooms.size >= config.maxRooms)
              fail("Server is busy. Try again later.", 503);
            let code;
            do {
              code = roomCode();
            } while (rooms.has(code));
            r = {
              code,
              mode,
              maxPlayers,
              status: "waiting",
              players: [],
              guesses: [],
              target: randomTarget(),
              created: Date.now(),
              clients: new Map(),
              public: url.pathname === "/api/match",
              round: 1,
            };
            rooms.set(code, r);
          }
          const p = addPlayer(r, name, user);
          emit(r);
          return json({
            token: p.token,
            playerId: p.id,
            room: roomView(r, p.id),
          });
        }
        const match = url.pathname.match(
          /^\/api\/rooms\/([A-Z0-9]{6})\/(join|start|guess|leave|rematch|skip)$/,
        );
        if (!match) fail("Not found", 404);
        const r = rooms.get(match[1]);
        if (!r || r.mode === "challenge")
          fail("Room not found. Check your code.", 404);
        const action = match[2];
        if (action === "join") {
          limit(`room-join:${req.clientIp}`, 60);
          let p =
            r.players.find((p) => user && p.userId === user.id) ||
            r.players.find((p) => !p.userId && p.token === b.token);
          if (!p) p = addPlayer(r, user?.nickname || cleanName(b.name), user);
          emit(r);
          return json({
            token: p.token,
            playerId: p.id,
            room: roomView(r, p.id),
          });
        }
        const p = player(r, b.token, user);
        if (action === "start") {
          if (p.id !== r.host) fail("Only the host can start.", 403);
          if (r.status !== "waiting") fail("Game already started.");
          if (r.players.length < 2) fail("You need at least two players.");
          r.status = "playing";
          r.turn = r.players[0].id;
          r.started = Date.now();
          r.gameId = id();
          r.participants = r.players.map((p) => ({
            id: p.id,
            userId: p.userId,
            name: p.name,
          }));
          saveRoomHistory(r);
        } else if (action === "guess") {
          if (r.status !== "playing") fail("The game is not in progress.");
          if (r.mode === "turn" && r.turn !== p.id)
            fail("Wait for your turn.", 409);
          if (r.guesses.length >= config.maxGuesses)
            fail("Guess limit reached. Leave and create a new room.");
          const key = p.id;
          const now = Date.now();
          if (now - (rates.get(key) || 0) < 200)
            fail("Take a moment between guesses.", 429);
          rates.set(key, now);
          const word = String(b.word || "")
            .trim()
            .toLowerCase();
          if (!/^[a-z]{2,40}$/.test(word)) fail("Enter one English word.");
          if (
            r.guesses.some(
              (g) =>
                g.word === word && (r.mode === "turn" || g.playerId === p.id),
            )
          )
            fail("You already guessed that word.");
          const rank = rankWord(r.target, word);
          r.guesses.push({
            word,
            rank,
            playerId: p.id,
            name: p.name,
            time: now,
          });
          if (rank === 1) {
            r.status = "finished";
            r.winner = p.id;
            p.score++;
            for (const q of r.players)
              database.put("leaderboard", `${r.gameId}:${q.id}`, {
                name: q.name,
                points: q.id === p.id ? 10 : 1,
                time: now,
              });
          } else if (r.mode === "turn") nextTurn(r);
          saveRoomHistory(r);
        } else if (action === "skip") {
          if (r.status !== "playing" || r.mode !== "turn" || p.id !== r.turn)
            fail("You cannot skip now.");
          nextTurn(r);
        } else if (action === "rematch") {
          if (p.id !== r.host) fail("Only the host can start a rematch.", 403);
          if (r.status !== "finished") fail("Finish this round first.");
          r.status = "waiting";
          r.target = randomTarget();
          r.guesses = [];
          r.winner = null;
          r.turn = null;
          r.round++;
        } else if (action === "leave") {
          const wasTurn = r.turn === p.id;
          if (wasTurn) nextTurn(r);
          r.players = r.players.filter((q) => q.id !== p.id);
          r.clients.get(p.id)?.forEach((s) => s.end());
          r.clients.delete(p.id);
          if (r.host === p.id) r.host = r.players[0]?.id;
          if (r.status === "playing")
            saveRoomHistory(r, r.players.length < 2 ? "abandoned" : "playing");
          if (r.status === "playing" && r.players.length < 2) {
            r.status = "waiting";
            r.guesses = [];
            r.turn = null;
          }
        }
        emit(r);
        return json(roomView(r, p.id));
      });
      return json(result.data, result.status);
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      fail("Method not allowed", 405);
    const path =
      url.pathname === "/" || !extname(url.pathname)
        ? "index.html"
        : url.pathname.slice(1);
    if (path.includes("..")) fail("Not found", 404);
    let data;
    try {
      data = readFileSync(join(root, "public", path));
    } catch {
      fail("Not found", 404);
    }
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".svg": "image/svg+xml",
        }[extname(path)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(data);
  } catch (e) {
    if (e.status === 413) res.setHeader("Connection", "close");
    if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
    if (
      e.code === "DATABASE_FENCED" ||
      String(e.code || "").startsWith("ERR_SQLITE")
    )
      setImmediate(() => {
        log("database_failure");
        process.exit(1);
      });
    if (!e.status)
      log("request_failed", {
        requestId: req.requestId,
        code: e.code || "INTERNAL",
      });
    if (!res.headersSent)
      json(
        {
          error: e.status
            ? e.message
            : "Something went wrong. Please try again.",
        },
        e.status || 500,
      );
    else res.end();
  }
});
server.maxConnections = 2000;
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
function cleanup() {
  database.transaction(() => {
    const cutoff = Date.now() - 7 * 86400000;
    for (const [key, room] of rooms) {
      if (room.created < cutoff && !room.clients.size) {
        if (room.status === "playing") saveRoomHistory(room, "abandoned");
        rooms.delete(key);
      }
    }
    for (const [key, solo] of solos) {
      if (solo.created < cutoff) {
        if (!solo.won) saveSoloHistory(solo, key, "abandoned");
        solos.delete(key);
      }
    }
    persist();
    accounts.prune();
  });
}
cleanup();
const maintenance = setInterval(cleanup, 3600000);
maintenance.unref();
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", { signal });
  clearInterval(maintenance);
  for (const r of rooms.values())
    for (const streams of r.clients.values())
      for (const stream of streams) stream.end();
  server.closeIdleConnections();
  const timer = setTimeout(() => {
    log("shutdown_timeout");
    process.exit(1);
  }, 30000);
  timer.unref();
  await new Promise((resolve) => server.close(resolve));
  await accounts.drain();
  persist();
  database.close();
  metrics.loop.disable();
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
server.listen(config.port, config.host, () =>
  log("listening", {
    port: config.port,
    node: process.version,
    production: config.production,
  }),
);
