import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { supabaseRestBridge } from "./helpers/supabase-rest.mjs";
import { SupabaseStore } from "../lib/supabase-store.mjs";
import { configuration } from "../config.mjs";
const enabled = Boolean(process.env.PG_TEST_PORT),
  namespace = "supabase-test-" + randomBytes(8).toString("hex"),
  origin = "https://supabase-test.invalid",
  controllers = [],
  children = new Map();
let bridge,
  store,
  turn = 0,
  race;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start(index) {
  const port = 3020 + index,
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
        : ["scripts/supabase-test-server.mjs"];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      NODE_ENV: "production",
      NODE_EXTRA_CA_CERTS: bridge.certPath,
      NEXT_TELEMETRY_DISABLED: "1",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "supabase-preview.test.invalid",
      GAME_STORAGE: "supabase",
      SUPABASE_URL: bridge.url,
      SUPABASE_SECRET_KEY: bridge.token,
      GAME_NAMESPACE: namespace,
      PUBLIC_ORIGIN: origin,
      PORT: String(port),
      METRICS_TOKEN_FILE: "",
      METRICS_TOKEN: "test-only-metrics",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  children.set(index, child);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(output);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return;
    } catch {}
    await pause(50);
  }
  throw Error(output.slice(-2500));
}
async function stop(index) {
  const child = children.get(index);
  if (child && child.exitCode === null) {
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exit;
  }
  children.delete(index);
}
async function raw(path, body, options = {}) {
  return fetch(
    `http://127.0.0.1:${3020 + (options.server ?? turn++ % 2)}` + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
async function call(path, body, status = 200, options) {
  const res = await raw(path, body, options),
    data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return data;
}
const action = (code, p, verb, body = {}, status = 200) =>
  call(`/api/rooms/${code}/${verb}`, { token: p.token, ...body }, status);
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(30);
  }
  assert.fail("Supabase clients did not synchronize");
}
async function stream(code, p, server) {
  const abort = new AbortController();
  controllers.push(abort);
  const state = { room: null, connections: 0 };
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  (async () => {
    try {
      while (!abort.signal.aborted) {
        const res = await fetch(
          `http://127.0.0.1:${3020 + server}/api/events?code=${code}&token=${p.token}`,
          { signal: abort.signal },
        );
        assert.equal(res.status, 200);
        state.connections++;
        readyResolve();
        let buffer = "";
        const reader = res.body.getReader();
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
    } catch (error) {
      if (!abort.signal.aborted) {
        state.error = error;
        readyReject(error);
      }
    }
  })();
  await ready;
  return { state, abort };
}
before(async () => {
  if (!enabled) return;
  bridge = await supabaseRestBridge(Number(process.env.PG_TEST_PORT));
  store = new SupabaseStore(
    {
      supabaseUrl: bridge.url,
      supabaseKey: bridge.token,
      namespace,
      maxRooms: 2000,
      maxSolos: 20000,
      maxStreams: 1000,
    },
    { fetcher: bridge.fetcher },
  );
  await start(0);
  await start(1);
});
after(async () => {
  for (const c of controllers) c.abort();
  await Promise.all([...children.keys()].map(stop));
  if (bridge) {
    for (const table of [
      "documents",
      "limits",
      "connections",
      "presence",
      "metadata",
      "scores",
      "daily_scores",
    ])
      await bridge.admin.query(
        `DELETE FROM closeword_private.${table} WHERE namespace LIKE $1`,
        [namespace + "%"],
      );
    await bridge.close();
  }
});
test(
  "Supabase migration is rerunnable and anonymous roles cannot read secrets or call server RPCs",
  { skip: !enabled },
  async () => {
    const client = await bridge.admin.connect();
    try {
      for (const role of ["anon", "authenticated", "service_role"]) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(
          () => client.query("SELECT * FROM closeword_private.documents"),
          (e) => e.code === "42501",
        );
        await client.query("ROLLBACK");
      }
      for (const role of ["anon", "authenticated"]) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(
          () => client.query("SELECT public.closeword_health()"),
          (e) => e.code === "42501",
        );
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    await store.check();
    assert.equal(await store.ping(), "PONG");
  },
);
test(
  "six players synchronize through Supabase and concurrent correct guesses award one winner once",
  { skip: !enabled },
  async () => {
    const host = await call("/api/rooms", {
        name: "Supabase Host",
        mode: "race",
        maxPlayers: 6,
      }),
      code = host.room.code,
      people = [host];
    for (let i = 1; i < 6; i++)
      people.push(
        await call(`/api/rooms/${code}/join`, { name: `Supabase Player ${i}` }),
      );
    await call(`/api/rooms/${code}/join`, { name: "Seventh" }, 409);
    const streams = await Promise.all(
      people.map((p, i) => stream(code, p, i % 2)),
    );
    await until(() => streams.every((s) => s.state.room?.players.length === 6));
    await action(code, people[1], "start", {}, 403);
    await action(code, host, "start");
    const target = (await store.read("room", code)).value.target,
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
      people.map((p, i) => action(code, p, "guess", { word: words[i] })),
    );
    await until(() =>
      streams.every(
        (s, i) =>
          s.state.room?.guesses.length === 1 &&
          s.state.room.guesses[0].word === words[i] &&
          s.state.room.players.every((p) => p.guessCount === 1),
      ),
    );
    assert.ok(
      streams.every(
        (s) =>
          !s.state.room.answer &&
          s.state.room.players.every((p) => !("token" in p)),
      ),
    );
    await pause(220);
    const replies = await Promise.all(
      people.map((p) =>
        raw(`/api/rooms/${code}/guess`, { token: p.token, word: target }),
      ),
    );
    assert.equal(replies.filter((r) => r.status === 200).length, 1);
    assert.ok(replies.every((r) => [200, 400].includes(r.status)));
    const winner = (await store.read("room", code)).value.winner;
    await until(() => streams.every((s) => s.state.room?.winner === winner));
    assert.equal(
      (await store.leaders("week")).reduce((sum, p) => sum + p.score, 0),
      15,
    );
    race = { host, people, code, target, winner };
    for (const s of streams) s.abort.abort();
  },
);
test(
  "Supabase survives instance restart and supports rematches and capacity enforcement",
  { skip: !enabled },
  async () => {
    await stop(1);
    await start(1);
    const restored = await call(
      `/api/rooms/${race.code}/join`,
      { token: race.host.token },
      200,
      { server: 1 },
    );
    assert.equal(restored.room.winner, race.winner);
    assert.equal(restored.room.answer, race.target);
    assert.equal(restored.playerId, race.host.playerId);
    assert.equal((await action(race.code, race.host, "rematch")).round, 2);
    for (const maxPlayers of [2, 3, 4, 5, 6]) {
      const host = await call("/api/rooms", { name: "Capacity", maxPlayers });
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          raw(`/api/rooms/${host.room.code}/join`, { name: `Guest ${i}` }),
        ),
      );
      assert.equal(
        replies.filter((r) => r.status === 200).length,
        maxPlayers - 1,
      );
      assert.equal(
        (await store.read("room", host.room.code)).value.players.length,
        maxPlayers,
      );
    }
  },
);
test(
  "Supabase daily progress, concurrent hint limits, challenges and matchmaking are shared",
  { skip: !enabled },
  async () => {
    const a = await call("/api/solo/new", {
        mode: "daily",
        device: "supabase-device-123",
      }),
      b = await call("/api/solo/new", {
        mode: "daily",
        device: "supabase-device-123",
      });
    assert.equal(a.token, b.token);
    const hints = await Promise.all(
      Array.from({ length: 5 }, () =>
        raw("/api/solo/hint", { token: a.token }),
      ),
    );
    assert.equal(hints.filter((r) => r.status === 200).length, 3);
    assert.equal((await store.read("solo", a.token)).value.hints, 3);
    const challenge = await call("/api/challenge", { word: "ocean" }),
      game = await call("/api/solo/new", {
        mode: "challenge",
        code: challenge.code,
      });
    assert.equal(
      (await call("/api/solo/guess", { token: game.token, word: "ocean" }))
        .answer,
      "ocean",
    );
    const first = await call("/api/match", {
        name: "Match A",
        mode: "race",
        maxPlayers: 2,
      }),
      other = await call("/api/match", {
        name: "Match B",
        mode: "race",
        maxPlayers: 3,
      }),
      second = await call("/api/match", {
        name: "Match C",
        mode: "race",
        maxPlayers: 2,
      });
    assert.equal(first.room.code, second.room.code);
    assert.notEqual(first.room.code, other.room.code);
  },
);
test(
  "Supabase stream renewal preserves turn ownership, and shared rate limits reject abuse",
  { skip: !enabled },
  async () => {
    const host = await call("/api/rooms", { name: "Turn Host", maxPlayers: 2 }),
      code = host.room.code,
      guest = await call(`/api/rooms/${code}/join`, { name: "Turn Guest" }),
      first = await stream(code, host, 1),
      second = await stream(code, guest, 0);
    await until(() => first.state.room?.players.every((p) => p.online));
    await action(code, host, "start");
    await until(() => first.state.connections >= 2);
    assert.equal(first.state.room.turn, host.playerId);
    await action(code, guest, "guess", { word: "ocean" }, 409);
    await action(code, host, "skip");
    await until(() => second.state.room?.turn === guest.playerId);
    const left = await action(code, host, "leave");
    assert.equal(left.host, guest.playerId);
    assert.equal(left.status, "waiting");
    first.abort.abort();
    second.abort.abort();
    const other = new SupabaseStore(store.config, { fetcher: bridge.fetcher });
    await store.limit("shared-test", 1);
    await assert.rejects(
      () => other.limit("shared-test", 1),
      (e) => e.status === 429,
    );
    await call("/api/rooms", { name: "Bad origin" }, 403, {
      headers: { Origin: "https://other.invalid" },
    });
    await action(race.code, { token: "bad" }, "start", {}, 403);
    assert.equal((await call("/health/ready")).storage, "supabase");
  },
);
test("Supabase errors never disclose keys and missing migrations have a distinct code", async () => {
  const config = {
    supabaseUrl: "https://test.supabase.co",
    supabaseKey: "sb_secret_private_value",
    namespace: "test",
  };
  const missing = new SupabaseStore(config, {
    fetcher: async () => ({
      ok: false,
      status: 404,
      json: async () => ({
        code: "PGRST202",
        message: "private backend contents",
      }),
    }),
  });
  await assert.rejects(
    () => missing.ping(),
    (e) =>
      e.code === "SUPABASE_SCHEMA_MISSING" &&
      !e.message.includes("private backend"),
  );
  const denied = new SupabaseStore(config, {
    fetcher: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(
    () => denied.ping(),
    (e) =>
      e.code === "SUPABASE_ACCESS_DENIED" &&
      !e.message.includes(config.supabaseKey),
  );
  let headers;
  const secret = new SupabaseStore(config, {
    fetcher: async (url, options) => {
      headers = options.headers;
      return { ok: true, json: async () => ({ ok: true, schema: 1 }) };
    },
  });
  await secret.ping();
  assert.equal(headers.apikey, config.supabaseKey);
  assert.equal(headers.Authorization, undefined);
});
test("Supabase is Vercel's default, requires a server secret, and keeps preview data separate", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_URL: "supabase-test.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "game.test.invalid",
    });
    for (const key of [
      "PUBLIC_ORIGIN",
      "GAME_STORAGE",
      "SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "GAME_NAMESPACE",
    ])
      delete process.env[key];
    assert.throws(configuration, /Supabase requires/);
    process.env.SUPABASE_URL = "https://example.supabase.co/";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_example";
    const production = configuration();
    assert.equal(production.storage, "supabase");
    assert.equal(production.supabaseUrl, "https://example.supabase.co");
    process.env.VERCEL_ENV = "preview";
    assert.notEqual(configuration().namespace, production.namespace);
    process.env.SUPABASE_SECRET_KEY = "sb_publishable_example";
    assert.throws(configuration, /server secret/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
