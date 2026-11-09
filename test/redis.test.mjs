import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redisRestBridge, trustedFetch } from "./helpers/redis-rest.mjs";
import { RedisStore } from "../lib/redis-store.mjs";
import { configuration } from "../config.mjs";
const enabled = Boolean(process.env.REDIS_TEST_PORT),
  origin = "https://redis.test.invalid",
  namespace = "integration-" + randomBytes(8).toString("hex");
let tlsDir, certPath, fetcher;
const controllers = [],
  children = new Map();
let bridge,
  store,
  requestIndex = 0,
  requestIp = "198.51.100.9",
  race;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start(index) {
  const port = 3016 + index,
    args =
      index === 0 && existsSync(".next/BUILD_ID")
        ? [
            "node_modules/next/dist/bin/next",
            "start",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(port),
          ]
        : ["scripts/redis-test-server.mjs"];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      NODE_ENV: index === 0 ? "production" : "test",
      NODE_EXTRA_CA_CERTS: certPath,
      NEXT_TELEMETRY_DISABLED: "1",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "redis-preview.test.invalid",
      GAME_STORAGE: "redis",
      UPSTASH_REDIS_REST_URL: bridge.url,
      UPSTASH_REDIS_REST_TOKEN: bridge.token,
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
      GAME_NAMESPACE: namespace,
      TRUST_PROXY: "true",
      METRICS_TOKEN_FILE: "",
      METRICS_TOKEN: "redis-test-metrics",
      TEST_STREAM_DURATION_MS: "1200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  children.set(index, child);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(output);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return;
    } catch {}
    await pause(50);
  }
  throw Error("Redis game server not ready: " + output);
}
async function stop(index) {
  const child = children.get(index);
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  children.delete(index);
}
async function raw(
  path,
  body,
  { server = requestIndex++ % 2, headers = {} } = {},
) {
  return fetch(`http://127.0.0.1:${3016 + server}` + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Forwarded-For": requestIp,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(path, body, status = 200, options) {
  const response = await raw(path, body, options),
    data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function action(room, person, verb, body = {}, status = 200) {
  return call(
    `/api/rooms/${room}/${verb}`,
    { token: person.token, ...body },
    status,
  );
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(30);
  }
  assert.fail("Distributed game clients did not synchronize");
}
async function live(room, person, { server = requestIndex++ % 2 } = {}) {
  const abort = new AbortController();
  controllers.push(abort);
  const state = { room: null, connections: 0 };
  let firstResolve, firstReject;
  const first = new Promise((resolve, reject) => {
    firstResolve = resolve;
    firstReject = reject;
  });
  (async () => {
    try {
      while (!abort.signal.aborted) {
        const response = await fetch(
          `http://127.0.0.1:${3016 + server}/api/events?code=${room}&token=${person.token}`,
          { signal: abort.signal, headers: { "X-Forwarded-For": requestIp } },
        );
        assert.equal(response.status, 200);
        state.connections++;
        firstResolve();
        const reader = response.body.getReader();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (event.startsWith("data: "))
              state.room = JSON.parse(event.slice(6));
          }
        }
        if (!abort.signal.aborted) await pause(20);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        state.error = e;
        firstReject(e);
      }
    }
  })();
  await first;
  return {
    ...state,
    get room() {
      return state.room;
    },
    get connections() {
      return state.connections;
    },
    abort,
  };
}
before(async () => {
  if (!enabled) return;
  tlsDir = mkdtempSync(join(tmpdir(), "cw-redis-tls-"));
  certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  fetcher = trustedFetch(cert);
  bridge = await redisRestBridge(Number(process.env.REDIS_TEST_PORT), {
    tls: { key: readFileSync(keyPath), cert },
  });
  store = new RedisStore(
    {
      redisUrl: bridge.url,
      redisToken: bridge.token,
      namespace,
      maxRooms: 2000,
      maxSolos: 20000,
      maxStreams: 1000,
    },
    { fetcher },
  );
  await start(0);
  await start(1);
});
after(async () => {
  for (const c of controllers) c.abort();
  await Promise.all([...children.keys()].map(stop));
  if (bridge) {
    const keys = await bridge.redis.command(["KEYS", store.prefix + "*"]);
    if (keys.length) await bridge.redis.command(["DEL", ...keys]);
    await bridge.close();
  }
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});
test(
  "six players on independent servers see private race guesses and exactly one winner",
  { skip: !enabled },
  async () => {
    const host = await call("/api/rooms", {
        name: "Redis Host",
        mode: "race",
        maxPlayers: 6,
      }),
      room = host.room.code,
      people = [host];
    for (let i = 1; i < 6; i++)
      people.push(
        await call(`/api/rooms/${room}/join`, { name: `Redis Player ${i}` }),
      );
    await call(`/api/rooms/${room}/join`, { name: "Seventh" }, 409);
    const states = await Promise.all(people.map((p) => live(room, p)));
    await until(() => states.every((s) => s.room?.players.length === 6));
    await action(room, people[1], "start", {}, 403);
    await action(room, host, "start");
    const target = (await store.read("room", room)).value.target,
      words = [
        "ocean",
        "garden",
        "mountain",
        "coffee",
        "music",
        "river",
        "forest",
      ].filter((w) => w !== target);
    await Promise.all(
      people.map((p, i) => action(room, p, "guess", { word: words[i] })),
    );
    await until(() =>
      states.every(
        (s, i) =>
          s.room?.guesses.length === 1 &&
          s.room.guesses[0].word === words[i] &&
          s.room.players.every((p) => p.guessCount === 1),
      ),
    );
    assert.ok(
      states.every(
        (s) => !s.room.answer && s.room.players.every((p) => !("token" in p)),
      ),
    );
    await pause(220);
    const attempts = await Promise.all(
      people.map((p) =>
        raw(`/api/rooms/${room}/guess`, { token: p.token, word: target }),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === 200).length, 1);
    assert.ok(attempts.every((r) => [200, 400].includes(r.status)));
    const final = (await store.read("room", room)).value;
    await until(() =>
      states.every(
        (s) => s.room?.winner === final.winner && s.room.answer === target,
      ),
    );
    const leaders = await call("/api/leaderboard?period=week");
    assert.equal(
      leaders
        .filter((p) => p.name.startsWith("Redis "))
        .reduce((n, p) => n + p.score, 0),
      15,
    );
    race = { room, host, people, target, winner: final.winner };
    for (const state of states) state.abort.abort();
  },
);
test(
  "cold instance restart preserves seats, winner and rematches without a local database",
  { skip: !enabled },
  async () => {
    await stop(1);
    await start(1);
    const restored = await call(
      `/api/rooms/${race.room}/join`,
      { token: race.host.token },
      200,
      { server: 1 },
    );
    assert.equal(restored.playerId, race.host.playerId);
    assert.equal(restored.room.winner, race.winner);
    assert.equal(restored.room.answer, race.target);
    await action(race.room, race.people[1], "rematch", {}, 403);
    const rematch = await action(race.room, race.host, "rematch");
    assert.equal(rematch.round, 2);
    assert.equal(rematch.status, "waiting");
    assert.equal(rematch.guesses.length, 0);
  },
);
test(
  "concurrent joins cannot exceed any chosen capacity",
  { skip: !enabled },
  async () => {
    requestIp = "198.51.100.10";
    for (const maxPlayers of [2, 3, 4, 5, 6]) {
      const host = await call("/api/rooms", {
          name: "Capacity Host",
          maxPlayers,
        }),
        room = host.room.code;
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          raw(`/api/rooms/${room}/join`, { name: `Join ${i}` }),
        ),
      );
      assert.equal(
        replies.filter((r) => r.status === 200).length,
        maxPlayers - 1,
      );
      assert.ok(replies.every((r) => [200, 409].includes(r.status)));
      assert.equal(
        (await store.read("room", room)).value.players.length,
        maxPlayers,
      );
      assert.equal((await action(room, host, "join")).playerId, host.playerId);
    }
    for (const maxPlayers of [0, 1, 7, 2.5, "3", null])
      await call("/api/rooms", { name: "Bad size", maxPlayers }, 400);
  },
);
test(
  "public matchmaking respects mode and capacity across instances",
  { skip: !enabled },
  async () => {
    requestIp = "198.51.100.11";
    const a = await call("/api/match", {
        name: "Match A",
        mode: "race",
        maxPlayers: 2,
      }),
      b = await call("/api/match", {
        name: "Match B",
        mode: "race",
        maxPlayers: 3,
      }),
      c = await call("/api/match", {
        name: "Match C",
        mode: "race",
        maxPlayers: 2,
      });
    assert.notEqual(a.room.code, b.room.code);
    assert.equal(a.room.code, c.room.code);
    const d = await call("/api/match", {
      name: "Match D",
      mode: "turn",
      maxPlayers: 2,
    });
    assert.notEqual(d.room.code, a.room.code);
  },
);
test(
  "bounded SSE streams reconnect without losing a seat or skipping its turn",
  { skip: !enabled },
  async () => {
    const host = await call("/api/rooms", {
        name: "Renewal Host",
        maxPlayers: 2,
      }),
      room = host.room.code,
      guest = await call(`/api/rooms/${room}/join`, { name: "Renewal Guest" });
    const first = await live(room, host, { server: 1 }),
      second = await live(room, guest, { server: 0 });
    await until(
      () =>
        first.room?.players.every((p) => p.online) &&
        second.room?.players.every((p) => p.online),
    );
    await action(room, host, "start");
    await until(() => first.connections >= 2);
    assert.equal(first.room.turn, host.playerId);
    assert.equal(first.room.players.length, 2);
    await action(room, guest, "guess", { word: "ocean" }, 409);
    await action(room, host, "skip");
    await until(() => second.room?.turn === guest.playerId);
    const left = await action(room, host, "leave");
    assert.equal(left.host, guest.playerId);
    assert.equal(left.status, "finished");
    assert.equal(left.winner, guest.playerId);
    assert.equal(left.finishReason, "last-player");
    first.abort.abort();
    second.abort.abort();
  },
);
test(
  "daily progress, concurrent hints and custom challenges use shared Redis state",
  { skip: !enabled },
  async () => {
    const first = await call("/api/solo/new", {
        mode: "daily",
        device: "distributed-device-123",
      }),
      again = await call("/api/solo/new", {
        mode: "daily",
        device: "distributed-device-123",
      });
    assert.equal(first.token, again.token);
    assert.equal(first.target, undefined);
    const hints = await Promise.all(
      Array.from({ length: 5 }, () =>
        raw("/api/solo/hint", { token: first.token }),
      ),
    );
    assert.equal(hints.filter((r) => r.status === 200).length, 3);
    assert.equal((await store.read("solo", first.token)).value.hints, 3);
    const challenge = await call("/api/challenge", { word: "ocean" }),
      game = await call("/api/solo/new", {
        mode: "challenge",
        code: challenge.code,
      }),
      won = await call("/api/solo/guess", { token: game.token, word: "ocean" });
    assert.equal(won.won, true);
    assert.equal(won.answer, "ocean");
  },
);
test(
  "room tokens, origins, body validation and operational endpoints stay protected",
  { skip: !enabled },
  async () => {
    await action(race.room, { token: "invalid" }, "start", {}, 403);
    await call("/api/rooms", { name: "Bad origin" }, 403, {
      headers: { Origin: "https://other.test.invalid" },
    });
    assert.equal(
      (await raw("/api/rooms", { name: "x".repeat(9000) })).status,
      413,
    );
    assert.equal(
      (
        await raw(
          "/api/rooms",
          { name: "Test" },
          { headers: { "Content-Type": "text/plain" } },
        )
      ).status,
      415,
    );
    assert.equal((await raw("/metrics")).status, 404);
    assert.equal((await call("/health/ready")).storage, "redis");
    assert.equal((await raw("/api/auth/me")).status, 404);
    const broken = new RedisStore({
      redisUrl: bridge.url,
      redisToken: "private-wrong-token",
      namespace,
    });
    await assert.rejects(
      () => broken.command(["PING"]),
      (e) => e.status === 503 && !e.message.includes("private-wrong-token"),
    );
  },
);
test(
  "rate limits and room resource limits are enforced in shared storage",
  { skip: !enabled },
  async () => {
    const other = new RedisStore({ ...store.config }, { fetcher });
    await store.limit("shared-limit", 1);
    await assert.rejects(
      () => other.limit("shared-limit", 1),
      (e) => e.status === 429 && e.retryAfter > 0,
    );
    const restricted = new RedisStore(
      {
        ...store.config,
        namespace: namespace + "-limits",
        maxRooms: 1,
      },
      { fetcher },
    );
    try {
      assert.ok(
        await restricted.create("room", "ABCDEF", {
          mode: "turn",
          players: [],
          status: "waiting",
        }),
      );
      await assert.rejects(
        () =>
          restricted.create("room", "UVWXYZ", {
            mode: "turn",
            players: [],
            status: "waiting",
          }),
        (e) => e.status === 503,
      );
    } finally {
      const keys = await bridge.redis.command([
        "KEYS",
        restricted.prefix + "*",
      ]);
      if (keys.length) await bridge.redis.command(["DEL", ...keys]);
    }
  },
);
test("Vercel configuration requires Redis secrets, derives origins and isolates preview data", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_URL: "build-123.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "my-game.vercel.app",
    });
    for (const key of [
      "PUBLIC_ORIGIN",
      "GAME_STORAGE",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "KV_REST_API_URL",
      "KV_REST_API_TOKEN",
      "GAME_NAMESPACE",
    ])
      delete process.env[key];
    process.env.GAME_STORAGE = "redis";
    assert.throws(configuration, /Redis requires/);
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-only";
    const production = configuration();
    assert.equal(production.storage, "redis");
    assert.equal(production.origin, "https://my-game.vercel.app");
    assert.equal(production.namespace, "production");
    process.env.VERCEL_ENV = "preview";
    const preview = configuration();
    assert.equal(preview.origin, "https://build-123.vercel.app");
    assert.notEqual(preview.namespace, production.namespace);
    assert.ok(!preview.allowedOrigins.includes(production.origin));
    process.env.GAME_STORAGE = "sqlite";
    assert.throws(configuration, /Vercel requires/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
