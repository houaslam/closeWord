import { randomBytes, createHash, createHmac } from "node:crypto";
import { daily, randomTarget, rankWord, hintWord } from "../engine.mjs";
import { configuration, loadEnvironment } from "../config.mjs";
import {
  readJson,
  clientIp,
  observe,
  telemetry,
  authorizedMetrics,
  log,
} from "../operations.mjs";
import { RedisStore } from "./redis-store.mjs";
const id = () => randomBytes(18).toString("hex");
const code = () =>
  [...randomBytes(6)]
    .map((n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n & 31])
    .join("");
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
const nameOf = (value) =>
  String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 24);
function player(room, token) {
  const found = room.players.find((p) => p.token === token);
  if (!found) fail("Join this room first.", 403);
  return found;
}
function addPlayer(room, name) {
  if (room.status !== "waiting") fail("This game has already started.", 409);
  if (room.players.length >= room.maxPlayers)
    fail(`This room is full (${room.maxPlayers} players).`, 409);
  if (!name) fail("Choose a nickname.");
  const p = {
    id: id(),
    token: id(),
    name,
    avatar: room.players.length,
    score: 0,
  };
  room.players.push(p);
  if (!room.host) room.host = p.id;
  return p;
}
function nextTurn(room, online) {
  const connected = room.players.filter((p) => online.has(p.id)),
    eligible = connected.length ? connected : room.players,
    index = room.players.findIndex((p) => p.id === room.turn);
  for (let i = 1; i <= room.players.length; i++) {
    const p = room.players[(index + i) % room.players.length];
    if (eligible.includes(p)) {
      room.turn = p.id;
      return;
    }
  }
}
function view(room, viewerId, online) {
  return {
    code: room.code,
    revision: room.revision,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    status: room.status,
    host: room.host,
    turn: room.turn,
    round: room.round,
    players: room.players.map(({ token, lastGuessAt, ...p }) => {
      const guesses = room.guesses.filter((g) => g.playerId === p.id);
      return {
        ...p,
        online: online.has(p.id),
        guessCount: guesses.length,
        bestRank: guesses.length
          ? Math.min(...guesses.map((g) => g.rank))
          : null,
      };
    }),
    guesses:
      room.mode === "race" && room.status !== "finished"
        ? room.guesses.filter((g) => g.playerId === viewerId)
        : room.guesses,
    winner: room.winner,
    answer: room.status === "finished" ? room.target : undefined,
    created: room.created,
  };
}
const soloView = (solo, token) => ({
  ...solo,
  token,
  target: undefined,
  answer: solo.won ? solo.target : undefined,
});
function ranked(target, word) {
  try {
    return rankWord(target, word);
  } catch (e) {
    fail(e.message);
  }
}
function validateOrigin(req, config) {
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin))
    fail("Origin not allowed.", 403);
  if (
    req.method === "POST" &&
    (req.headers["sec-fetch-site"] === "cross-site" ||
      (config.production && !origin))
  )
    fail("Origin not allowed.", 403);
}
export function createRedisGameService({
  config = configuration(),
  store = new RedisStore(config),
  streamDurationMs = 45000,
  pollMs = 1000,
} = {}) {
  const metrics = telemetry(),
    streams = new Set();
  let closed = false,
    secretPromise;
  function secret() {
    if (!secretPromise)
      secretPromise = store.secret().catch((e) => {
        secretPromise = null;
        throw e;
      });
    return secretPromise;
  }
  async function newRoom(body, match, ip) {
    await store.limit(`room-create:${ip}`, 20, 3600000);
    const name = nameOf(body.name);
    if (!name) fail("Choose a nickname.");
    const mode = body.mode === "race" ? "race" : "turn",
      maxPlayers = body.maxPlayers === undefined ? 6 : body.maxPlayers;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6)
      fail("Choose between 2 and 6 players.");
    if (match) {
      for (const candidate of await store.matches(mode, maxPlayers)) {
        try {
          return await join(candidate, { name });
        } catch (e) {
          if (![404, 409].includes(e.status)) throw e;
        }
      }
    }
    for (let i = 0; i < 8; i++) {
      const room = {
        code: code(),
        mode,
        maxPlayers,
        status: "waiting",
        players: [],
        guesses: [],
        target: randomTarget(),
        created: Date.now(),
        public: match,
        round: 1,
      };
      const p = addPlayer(room, name);
      if (await store.create("room", room.code, room))
        return {
          token: p.token,
          playerId: p.id,
          room: view(room, p.id, new Set()),
        };
    }
    fail("Could not create a room. Please retry.", 503);
  }
  async function join(roomCode, body) {
    let seat;
    const result = await store.mutate("room", roomCode, (room) => {
      if (room.mode === "challenge")
        fail("Room not found. Check your code.", 404);
      seat = room.players.find((p) => p.token === body.token);
      if (seat) return false;
      seat = addPlayer(room, nameOf(body.name));
    });
    const { online } = await store.presence(roomCode);
    return {
      token: seat.token,
      playerId: seat.id,
      room: view(result, seat.id, online),
    };
  }
  async function action(roomCode, action, body, ip) {
    if (action === "join") {
      await store.limit(`room-join:${ip}`, 60);
      return join(roomCode, body);
    }
    const { online } = await store.presence(roomCode);
    const result = await store.mutate("room", roomCode, (room) => {
      if (room.mode === "challenge")
        fail("Room not found. Check your code.", 404);
      const p = player(room, body.token);
      if (action === "start") {
        if (p.id !== room.host) fail("Only the host can start.", 403);
        if (room.status !== "waiting") fail("Game already started.");
        if (room.players.length < 2) fail("You need at least two players.");
        room.status = "playing";
        room.turn = room.players[0].id;
        room.started = Date.now();
        room.gameId = id();
      } else if (action === "guess") {
        if (room.status !== "playing") fail("The game is not in progress.");
        if (room.mode === "turn" && room.turn !== p.id)
          fail("Wait for your turn.", 409);
        if (room.guesses.length >= config.maxGuesses)
          fail("Guess limit reached. Leave and create a new room.");
        const now = Date.now();
        if (now - (p.lastGuessAt || 0) < 200)
          fail("Take a moment between guesses.", 429);
        const word = String(body.word || "")
          .trim()
          .toLowerCase();
        if (!/^[a-z]{2,40}$/.test(word)) fail("Enter one English word.");
        if (
          room.guesses.some(
            (g) =>
              g.word === word && (room.mode === "turn" || g.playerId === p.id),
          )
        )
          fail("You already guessed that word.");
        const rank = ranked(room.target, word);
        p.lastGuessAt = now;
        room.guesses.push({
          word,
          rank,
          playerId: p.id,
          name: p.name,
          time: now,
        });
        if (rank === 1) {
          room.status = "finished";
          room.winner = p.id;
          p.score++;
        } else if (room.mode === "turn") nextTurn(room, online);
      } else if (action === "skip") {
        if (
          room.status !== "playing" ||
          room.mode !== "turn" ||
          room.turn !== p.id
        )
          fail("You cannot skip now.");
        nextTurn(room, online);
      } else if (action === "rematch") {
        if (p.id !== room.host) fail("Only the host can start a rematch.", 403);
        if (room.status !== "finished") fail("Finish this round first.");
        room.status = "waiting";
        room.target = randomTarget();
        room.guesses = [];
        room.winner = null;
        room.turn = null;
        room.round++;
      } else if (action === "leave") {
        if (room.turn === p.id) nextTurn(room, online);
        room.players = room.players.filter((q) => q.id !== p.id);
        if (room.host === p.id) room.host = room.players[0]?.id;
        if (room.status === "playing" && room.players.length < 2) {
          room.status = "waiting";
          room.guesses = [];
          room.turn = null;
        }
      }
    });
    const viewer = result.players.find((p) => p.token === body.token);
    return view(result, viewer?.id, online);
  }
  async function startSolo(body, ip) {
    await store.limit(`solo-new:${ip}`, 60);
    const mode =
        body.mode === "practice"
          ? "practice"
          : body.mode === "challenge"
            ? "challenge"
            : "daily",
      key = await secret(),
      d = daily(key);
    let target =
      mode === "daily"
        ? await store.dailyTarget(d.id, d.target)
        : randomTarget();
    if (mode === "challenge") {
      if (!/^[A-Z0-9]{6}$/.test(body.code || ""))
        fail("Challenge not found.", 404);
      const challenge = await store.read("room", body.code);
      if (!challenge || challenge.value.mode !== "challenge")
        fail("Challenge not found.", 404);
      target = challenge.value.target;
    }
    const token =
      mode === "daily" && /^[a-z0-9-]{8,80}$/i.test(body.device || "")
        ? createHmac("sha256", key)
            .update(`device:${body.device}:${d.id}`)
            .digest("hex")
        : id();
    const solo = {
      target,
      guesses: [],
      hints: 0,
      mode,
      won: false,
      created: Date.now(),
      number: d.number,
    };
    if (await store.create("solo", token, solo)) return soloView(solo, token);
    const existing = await store.read("solo", token);
    if (!existing) fail("Start a new puzzle.", 404);
    return soloView(existing.value, token);
  }
  async function soloGuess(body, hint) {
    if (!/^[a-f0-9]{36,64}$/.test(body.token || ""))
      fail("Start a new puzzle.", 404);
    await store.limit(`solo-guess:${body.token}`, 120);
    const solo = await store.mutate("solo", body.token, (s) => {
      if (s.won) fail("You already solved this puzzle.");
      if (s.guesses.length >= config.maxGuesses)
        fail("Guess limit reached. Start a new practice game.");
      let word = String(body.word || "")
        .trim()
        .toLowerCase();
      if (hint) {
        if (s.hints >= 3) fail("No hints remaining.");
        word = hintWord(s.target, s.guesses, body.difficulty);
      }
      if (s.guesses.some((g) => g.word === word))
        fail("You already guessed that word.");
      const rank = ranked(s.target, word);
      s.guesses.push({ word, rank, hint });
      if (hint) s.hints++;
      s.won = rank === 1;
    });
    return soloView(solo, body.token);
  }
  async function stream(req, res, url, started) {
    const roomCode = url.searchParams.get("code"),
      token = url.searchParams.get("token");
    if (!/^[A-Z0-9]{6}$/.test(roomCode || "")) fail("Room not found.", 404);
    const record = await store.read("room", roomCode);
    if (!record || record.value.mode === "challenge")
      fail("Room not found.", 404);
    const p = player(record.value, token),
      connection = id(),
      abort = new AbortController();
    streams.add(abort);
    const disconnect = () => abort.abort();
    res.once("close", disconnect);
    let registered = false;
    try {
      let state = await store.presence(
        roomCode,
        p.id,
        connection,
        abort.signal,
      );
      registered = true;
      res.setTimeout(0);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 1500\n\n");
      let previous = "",
        lastPing = Date.now();
      while (
        !abort.signal.aborted &&
        !closed &&
        Date.now() - started < streamDurationMs
      ) {
        player(state.room, token);
        if (
          state.room.mode === "turn" &&
          state.room.status === "playing" &&
          state.online.size &&
          !state.online.has(state.room.turn)
        ) {
          state.room = await store.mutate("room", roomCode, (room) => {
            if (room.status !== "playing" || state.online.has(room.turn))
              return false;
            nextTurn(room, state.online);
          });
        }
        const body = JSON.stringify(view(state.room, p.id, state.online));
        if (body !== previous) {
          if (res.writableLength > 262144) break;
          res.write(`data: ${body}\n\n`);
          previous = body;
        } else if (Date.now() - lastPing > 15000) {
          res.write(": ping\n\n");
          lastPing = Date.now();
        }
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, pollMs);
          abort.signal.addEventListener("abort", done, { once: true });
          if (abort.signal.aborted) done();
        });
        if (
          abort.signal.aborted ||
          closed ||
          Date.now() - started >= streamDurationMs
        )
          break;
        state = await store.presence(roomCode, p.id, connection, abort.signal);
      }
    } finally {
      streams.delete(abort);
      res.removeListener("close", disconnect);
      if (res.headersSent && !res.writableEnded) res.end();
      if (registered)
        await store.release(roomCode, p.id, connection).catch(() => {});
    }
  }
  async function handle(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400);
      res.end("Invalid request URL");
      return;
    }
    if (url.pathname.startsWith("/api/health/"))
      url.pathname = url.pathname.slice(4);
    if (url.pathname === "/api/metrics") url.pathname = "/metrics";
    observe(req, res, url.pathname, metrics);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
    if (config.production)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    function json(data, status = 200) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    }
    try {
      if (closed) fail("Server is restarting. Please retry shortly.", 503);
      if (url.pathname === "/health/live") return json({ ok: true });
      if (url.pathname === "/health/ready") {
        await store.command(["PING"]);
        return json({ ready: true, storage: "redis" });
      }
      if (url.pathname === "/metrics") {
        if (!authorizedMetrics(req)) fail("Not found.", 404);
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(metrics.snapshot() + `closeword_streams ${streams.size}\n`);
        return;
      }
      validateOrigin(req, config);
      const ip = createHash("sha256")
        .update(clientIp(req, config.trustProxy))
        .digest("hex");
      await store.limit(`api:${ip}`, 240);
      if (req.method === "GET" && url.pathname === "/api/health")
        return json({ ok: true, maxPlayers: 6 });
      if (req.method === "GET" && url.pathname === "/api/leaderboard")
        return json(await store.leaders(url.searchParams.get("period")));
      if (req.method === "GET" && url.pathname === "/api/events")
        return await stream(req, res, url, started);
      if (
        req.method !== "POST" ||
        url.pathname.startsWith("/api/auth/") ||
        url.pathname.startsWith("/api/account")
      )
        fail("Not found", 404);
      if (
        String(req.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        fail("Use application/json.", 415);
      const b = await readJson(req);
      let result;
      if (url.pathname === "/api/rooms" || url.pathname === "/api/match")
        result = await newRoom(b, url.pathname === "/api/match", ip);
      else if (url.pathname === "/api/solo/new")
        result = await startSolo(b, ip);
      else if (
        url.pathname === "/api/solo/guess" ||
        url.pathname === "/api/solo/hint"
      )
        result = await soloGuess(b, url.pathname.endsWith("hint"));
      else if (url.pathname === "/api/challenge") {
        await store.limit(`room-create:${ip}`, 20, 3600000);
        const word = String(b.word || "")
          .trim()
          .toLowerCase();
        if (!/^[a-z]+$/.test(word)) fail("Enter one English word.");
        ranked(word, word);
        let room;
        for (let i = 0; i < 8; i++) {
          room = {
            code: code(),
            target: word,
            mode: "challenge",
            status: "waiting",
            players: [],
            guesses: [],
            created: Date.now(),
          };
          if (await store.create("room", room.code, room)) break;
          room = null;
        }
        if (!room) fail("Could not create a challenge. Please retry.", 503);
        result = { code: room.code };
      } else {
        const match = url.pathname.match(
          /^\/api\/rooms\/([A-Z0-9]{6})\/(join|start|guess|leave|rematch|skip)$/,
        );
        if (!match) fail("Not found", 404);
        result = await action(match[1], match[2], b, ip);
      }
      return json(result);
    } catch (e) {
      if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
      if (e.status === 413) res.setHeader("Connection", "close");
      if (!e.status && !res.destroyed)
        log("request_failed", { requestId: req.requestId, code: "INTERNAL" });
      if (!res.headersSent)
        json(
          {
            error: e.status
              ? e.message
              : "Something went wrong. Please try again.",
          },
          e.status || 500,
        );
      else if (!res.writableEnded) res.end();
    }
  }
  return {
    handle,
    close() {
      closed = true;
      for (const abort of streams) abort.abort();
      metrics.loop.disable();
    },
  };
}
const singleton = Symbol.for("closeword.redis-service");
export function redisGameService() {
  if (!globalThis[singleton]) {
    loadEnvironment(process.cwd());
    globalThis[singleton] = createRedisGameService();
  }
  return globalThis[singleton];
}
