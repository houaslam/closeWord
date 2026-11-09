import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rankWord, ranking, hintWord } from "../engine.mjs";
const dir = mkdtempSync(join(tmpdir(), "closeword-test-"));
const file = join(dir, "state.json");
const base = "http://127.0.0.1:3011";
let processHandle;
const controllers = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(path, body, status = 200) {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function create(mode = "turn") {
  return request("/api/rooms", { name: "Player 1", mode });
}
async function action(code, who, verb, body = {}, status = 200) {
  return request(
    `/api/rooms/${code}/${verb}`,
    { token: who.token, ...body },
    status,
  );
}
function secret(code) {
  const db = new DatabaseSync(join(dir, "closeword.sqlite"), {
    readOnly: true,
  });
  try {
    return JSON.parse(
      db.prepare("SELECT payload FROM rooms WHERE id=?").get(code).payload,
    ).target;
  } finally {
    db.close();
  }
}
async function stream(code, who) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(
    `${base}/api/events?code=${code}&token=${who.token}`,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  const state = { latest: null, updates: 0 };
  const reader = response.body.getReader();
  let buffer = "";
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += new TextDecoder().decode(value);
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (chunk.startsWith("data: ")) {
            state.latest = JSON.parse(chunk.slice(6));
            state.updates++;
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    }
  })();
  return state;
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(20);
  }
  assert.fail("Live clients did not synchronize within 2 seconds");
}
before(async () => {
  processHandle = spawn(process.execPath, ["scripts/api-test-server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "3011",
      HOST: "127.0.0.1",
      STATE_FILE: file,
      DATABASE_PATH: join(dir, "closeword.sqlite"),
      NODE_ENV: "test",
      TRUST_PROXY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    processHandle.stdout.once("data", resolve);
    processHandle.once("error", reject);
    processHandle.once("exit", (code) =>
      reject(Error(`Server exited ${code}`)),
    );
  });
});
after(() => {
  for (const c of controllers) c.abort();
  processHandle?.kill();
  rmSync(dir, { recursive: true, force: true });
});
test("word rankings use semantic similarity and hints get closer", () => {
  assert.equal(rankWord("ocean", "ocean"), 1);
  assert.ok(rankWord("ocean", "sea") < rankWord("ocean", "computer"));
  assert.ok(rankWord("ocean", "water") < 100);
  const guesses = [{ word: "computer", rank: rankWord("ocean", "computer") }];
  assert.ok(rankWord("ocean", hintWord("ocean", guesses)) < guesses[0].rank);
  assert.throws(() => rankWord("ocean", "asdfgqwerty"));
});
test("six independent remote connections synchronize; seventh rejected; turns, reconnect, win and rematch", async () => {
  const first = await create();
  const code = first.room.code;
  const people = [first];
  const streams = [await stream(code, first)];
  for (let i = 2; i <= 6; i++) {
    const p = await request(`/api/rooms/${code}/join`, { name: `Player ${i}` });
    people.push(p);
    streams.push(await stream(code, p));
  }
  await until(() => streams.every((s) => s.latest?.players.length === 6));
  await request(`/api/rooms/${code}/join`, { name: "Seventh" }, 409);
  await action(code, people[1], "start", {}, 403);
  await action(code, first, "start");
  await until(() => streams.every((s) => s.latest?.status === "playing"));
  assert.equal(streams[0].latest.answer, undefined);
  assert.ok(streams[0].latest.players.every((p) => !("token" in p)));
  await action(code, people[1], "guess", { word: "ocean" }, 409);
  const target = secret(code);
  const words = [
    "ocean",
    "garden",
    "mountain",
    "coffee",
    "music",
    "river",
    "forest",
    "window",
  ].filter((w) => w !== target);
  for (let i = 0; i < 6; i++) {
    const result = await action(code, people[i], "guess", { word: words[i] });
    assert.equal(result.turn, people[(i + 1) % 6].playerId);
  }
  await until(() => streams.every((s) => s.latest?.guesses.length === 6));
  const recovered = await request(`/api/rooms/${code}/join`, {
    name: "Ignored",
    token: people[3].token,
  });
  assert.equal(recovered.playerId, people[3].playerId);
  assert.equal(recovered.room.players.length, 6);
  await pause(220);
  await action(code, first, "guess", { word: "notawordxyz" }, 400);
  await pause(220);
  await action(code, first, "guess", { word: target });
  await until(() => streams.every((s) => s.latest?.status === "finished"));
  assert.equal(streams[5].latest.winner, first.playerId);
  assert.equal(streams[5].latest.answer, target);
  await action(code, first, "rematch");
  await until(() => streams.every((s) => s.latest?.round === 2));
  assert.equal(streams[0].latest.guesses.length, 0);
});
test("six-player speed race accepts simultaneous guesses and ends consistently", async () => {
  const first = await create("race");
  const code = first.room.code;
  const people = [first];
  for (let i = 2; i <= 6; i++)
    people.push(
      await request(`/api/rooms/${code}/join`, { name: `Racer ${i}` }),
    );
  const streams = await Promise.all(people.map((p) => stream(code, p)));
  await action(code, first, "start");
  const target = secret(code),
    word = target === "ocean" ? "coffee" : "ocean";
  const results = await Promise.all(
    people.map((p) => action(code, p, "guess", { word })),
  );
  assert.ok(results.every((r) => r.status === "playing"));
  await until(() =>
    streams.every(
      (s) =>
        s.latest?.guesses.length === 1 &&
        s.latest.players.every((p) => p.guessCount === 1),
    ),
  );
  await pause(220);
  await action(code, people[5], "guess", { word: target });
  await until(() =>
    streams.every((s) => s.latest?.winner === people[5].playerId),
  );
  await action(code, people[0], "guess", { word: "garden" }, 400);
});
test("leaving moves the turn and transfers hosting without breaking the room", async () => {
  const first = await create();
  const code = first.room.code;
  const second = await request(`/api/rooms/${code}/join`, { name: "Second" });
  const third = await request(`/api/rooms/${code}/join`, { name: "Third" });
  await action(code, first, "start");
  const result = await action(code, first, "leave");
  assert.equal(result.host, second.playerId);
  assert.equal(result.turn, second.playerId);
  assert.equal(result.players.length, 2);
  await action(code, second, "skip");
  const recovered = await action(code, third, "leave");
  assert.equal(recovered.status, "waiting");
});
test("daily progress resumes, hint limits apply, challenges solve, answers stay hidden", async () => {
  const first = await request("/api/solo/new", {
    mode: "daily",
    device: "test-device-123",
  });
  assert.equal(first.target, undefined);
  const second = await request("/api/solo/new", {
    mode: "daily",
    device: "test-device-123",
  });
  assert.equal(first.token, second.token);
  for (let i = 0; i < 3; i++) {
    const hinted = await request("/api/solo/hint", { token: first.token });
    assert.equal(hinted.hints, i + 1);
    assert.equal(hinted.guesses.at(-1).hint, true);
  }
  await request("/api/solo/hint", { token: first.token }, 400);
  const challenge = await request("/api/challenge", { word: "ocean" });
  const game = await request("/api/solo/new", {
    mode: "challenge",
    code: challenge.code,
  });
  assert.equal(game.target, undefined);
  const won = await request("/api/solo/guess", {
    token: game.token,
    word: "ocean",
  });
  assert.equal(won.won, true);
  assert.equal(won.answer, "ocean");
});
test("untrusted origins and missing room credentials are rejected", async () => {
  const r = await create();
  await action(r.room.code, { token: "wrong" }, "start", {}, 403);
  const response = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://malicious.example",
    },
    body: JSON.stringify({ name: "Guest" }),
  });
  assert.equal(response.status, 403);
});
test("chosen player limits are enforced from 2 to 6 and reject invalid values", async () => {
  for (const maxPlayers of [2, 3, 4, 5, 6]) {
    const host = await request("/api/rooms", { name: "Host", maxPlayers });
    const code = host.room.code;
    assert.equal(host.room.maxPlayers, maxPlayers);
    for (let i = 1; i < maxPlayers; i++)
      await request(`/api/rooms/${code}/join`, { name: `Guest ${i}` });
    await request(`/api/rooms/${code}/join`, { name: "Extra" }, 409);
    const rejoined = await request(`/api/rooms/${code}/join`, {
      token: host.token,
    });
    assert.equal(rejoined.room.players.length, maxPlayers);
  }
  for (const maxPlayers of [0, 1, 7, 2.5, "3", null])
    await request("/api/rooms", { name: "Host", maxPlayers }, 400);
});
test("public matchmaking respects the chosen capacity and separates room sizes", async () => {
  const a = await request("/api/match", {
    name: "A",
    mode: "race",
    maxPlayers: 2,
  });
  const b = await request("/api/match", {
    name: "B",
    mode: "race",
    maxPlayers: 3,
  });
  const c = await request("/api/match", {
    name: "C",
    mode: "race",
    maxPlayers: 2,
  });
  assert.notEqual(a.room.code, b.room.code);
  assert.equal(a.room.code, c.room.code);
  const d = await request("/api/match", {
    name: "D",
    mode: "race",
    maxPlayers: 2,
  });
  assert.notEqual(d.room.code, a.room.code);
});
test("HTTP rejects malformed objects, oversize bodies, wrong media types and protects operational endpoints", async () => {
  for (const body of ["null", "[]", "{broken"]) {
    const r = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(r.status, 400);
  }
  const oversized = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(9000) }),
  });
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/jsonp" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await fetch(base + "/metrics")).status, 404);
  assert.equal((await request("/health/ready")).ready, true);
  assert.equal((await request("/health/live")).ok, true);
  const headers = await fetch(base + "/api/health");
  assert.ok(
    headers.headers
      .get("Content-Security-Policy")
      .includes("frame-ancestors 'none'"),
  );
  assert.ok(headers.headers.get("X-Request-ID"));
});
