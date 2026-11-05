import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../auth.mjs";
const directory = mkdtempSync(join(tmpdir(), "cw-accounts-"));
process.env.NODE_ENV = "test";
process.env.MAIL_TRANSPORT = "file";
process.env.MAIL_TEST_DIR = join(directory, "mail");
const store = new Accounts(join(directory, "accounts.json"));
let clientIndex = 0;
function client() {
  const c = { cookie: "", ip: `test-${++clientIndex}` };
  c.call = async (path, body, expected = 200) => {
    const req = {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: c.cookie },
      socket: { remoteAddress: c.ip },
    };
    const headers = {};
    try {
      const data = await store.handle(
        req,
        { setHeader: (name, value) => (headers[name] = value) },
        new URL(path, "http://localhost"),
        body,
      );
      assert.equal(expected, 200, JSON.stringify(data));
      if (headers["Set-Cookie"]) c.cookie = headers["Set-Cookie"].split(";")[0];
      return { data, headers };
    } catch (e) {
      if (e.code === "ERR_ASSERTION") throw e;
      assert.equal(e.status, expected, e.message);
      return { error: e.message };
    }
  };
  return c;
}
const password = "a long secure phrase for tests";
const signup = async (c, email, nickname) =>
  c.call("/api/auth/register", {
    email,
    nickname,
    password,
    passwordConfirmation: password,
  });
const code = (challengeId) =>
  JSON.parse(readFileSync(join(directory, "mail", `${challengeId}.json`))).code;
async function verified(email, nickname) {
  const c = client();
  const pending = await signup(c, email, nickname);
  await c.call("/api/auth/verify", {
    challengeId: pending.data.challengeId,
    code: code(pending.data.challengeId),
  });
  return c;
}
after(() => rmSync(directory, { recursive: true, force: true }));
test("registration creates only a pending signup; OTP creates account and HttpOnly session", async () => {
  const c = client();
  const { data } = await signup(c, "ALICE@example.com", "Alice");
  assert.equal(store.data.users.length, 0);
  assert.equal((await c.call("/api/auth/me")).data.user, null);
  assert.equal(store.data.challenges[0].password.includes(password), false);
  await c.call(
    "/api/auth/verify",
    { challengeId: data.challengeId, code: "notvalid" },
    400,
  );
  const verification = await c.call("/api/auth/verify", {
    challengeId: data.challengeId,
    code: code(data.challengeId),
  });
  assert.equal(verification.data.user.email, "alice@example.com");
  assert.match(verification.headers["Set-Cookie"], /HttpOnly; SameSite=Lax/);
  assert.equal(verification.data.user.password, undefined);
  assert.ok(store.data.users[0].password !== password);
  await c.call(
    "/api/auth/verify",
    { challengeId: data.challengeId, code: code(data.challengeId) },
    400,
  );
  const other = client();
  await other.call("/api/account", undefined, 401);
  await other.call(
    "/api/auth/login",
    { email: "alice@example.com", password: "incorrect" },
    401,
  );
  await other.call("/api/auth/login", { email: "alice@example.com", password });
  assert.equal((await other.call("/api/auth/me")).data.user.nickname, "Alice");
  const reloaded = new Accounts(join(directory, "accounts.json"));
  assert.equal(
    reloaded.user({ headers: { cookie: other.cookie } }).nickname,
    "Alice",
  );
  await c.call("/api/auth/logout", {});
  assert.equal((await c.call("/api/auth/me")).data.user, null);
  assert.equal((await other.call("/api/auth/me")).data.user.nickname, "Alice");
});
test("codes expire, have five attempts, and resends invalidate old codes", async () => {
  const c = client();
  const pending = await signup(c, "codes@example.com", "Codes");
  const id = pending.data.challengeId;
  const challenge = store.data.challenges.find((c) => c.id === id);
  const first = code(id);
  await c.call("/api/auth/resend", { challengeId: id }, 429);
  challenge.sentAt = Date.now() - 61000;
  await c.call("/api/auth/resend", { challengeId: id });
  assert.equal(challenge.generation, 2);
  const latest = code(id);
  if (latest !== first)
    await c.call("/api/auth/verify", { challengeId: id, code: first }, 400);
  challenge.expiresAt = Date.now() - 1;
  await c.call("/api/auth/verify", { challengeId: id, code: latest }, 400);
  challenge.expiresAt = Date.now() + 600000;
  challenge.attempts = 0;
  const wrong = latest === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++)
    await c.call("/api/auth/verify", { challengeId: id, code: wrong }, 400);
  await c.call("/api/auth/verify", { challengeId: id, code: latest }, 400);
  assert.ok(!store.data.users.some((u) => u.email === "codes@example.com"));
});
test("password recovery revokes every session and requires a valid email code", async () => {
  const c = await verified("reset@example.com", "Reset");
  const other = client();
  await other.call("/api/auth/login", { email: "reset@example.com", password });
  const oldCookie = other.cookie;
  const pending = await c.call("/api/auth/forgot", {
    email: "reset@example.com",
  });
  const newPassword = "this is a different long secure password";
  await c.call(
    "/api/auth/reset",
    {
      challengeId: pending.data.challengeId,
      code: "wrong",
      password: newPassword,
      passwordConfirmation: newPassword,
    },
    400,
  );
  await c.call("/api/auth/reset", {
    challengeId: pending.data.challengeId,
    code: code(pending.data.challengeId),
    password: newPassword,
    passwordConfirmation: newPassword,
  });
  assert.equal((await other.call("/api/auth/me")).data.user, null);
  assert.ok(
    !store.sessionValid(store.sessionHash({ headers: { cookie: oldCookie } })),
  );
  await other.call(
    "/api/auth/login",
    { email: "reset@example.com", password },
    401,
  );
  await other.call("/api/auth/login", {
    email: "reset@example.com",
    password: newPassword,
  });
});
test("game history is private, retains opponents and results, hides active secrets", async () => {
  const alice = client();
  await alice.call("/api/auth/login", { email: "alice@example.com", password });
  const bob = await verified("bob@example.com", "Bob");
  const a = store.user({ headers: { cookie: alice.cookie } }),
    b = store.user({ headers: { cookie: bob.cookie } });
  store.recordGame({
    id: "fixture-game",
    kind: "multiplayer",
    mode: "race",
    round: 1,
    status: "playing",
    word: "secret",
    startedAt: Date.now(),
    players: [
      { id: "a", userId: a.id, name: "Alice" },
      { id: "b", userId: b.id, name: "Bob" },
    ],
    guesses: [
      { word: "water", rank: 3, playerId: "a", name: "Alice" },
      { word: "ocean", rank: 1, playerId: "b", name: "Bob" },
    ],
  });
  const active = (await alice.call("/api/account/games/fixture-game")).data
    .game;
  assert.equal(active.word, undefined);
  assert.equal(active.guesses.length, 1);
  assert.equal(active.guesses[0].word, "water");
  assert.ok(active.players.every((p) => !p.userId));
  store.recordGame({
    ...store.data.games.find((g) => g.id === "fixture-game"),
    status: "finished",
    winnerId: "b",
    finishedAt: Date.now(),
  });
  assert.equal(
    (await alice.call("/api/account/games/fixture-game")).data.game.outcome,
    "lost",
  );
  assert.equal(
    (await bob.call("/api/account/games/fixture-game")).data.game.outcome,
    "won",
  );
  assert.equal((await alice.call("/api/account")).data.stats.losses, 1);
  const outsider = await verified("outsider@example.com", "Outsider");
  await outsider.call("/api/account/games/fixture-game", undefined, 404);
  assert.equal(
    (await outsider.call("/api/account/games")).data.games.length,
    0,
  );
});
test("authenticated password changes revoke other devices; login attempts are limited", async () => {
  const c = await verified("change@example.com", "Change");
  const other = client();
  await other.call("/api/auth/login", {
    email: "change@example.com",
    password,
  });
  const newPassword = "another unique long password for changes";
  await c.call(
    "/api/auth/password",
    {
      currentPassword: "bad",
      password: newPassword,
      passwordConfirmation: newPassword,
    },
    401,
  );
  await c.call("/api/auth/password", {
    currentPassword: password,
    password: newPassword,
    passwordConfirmation: newPassword,
  });
  assert.equal((await other.call("/api/auth/me")).data.user, null);
  assert.equal((await c.call("/api/auth/me")).data.user.nickname, "Change");
  const attacker = client();
  for (let i = 0; i < 10; i++)
    await attacker.call(
      "/api/auth/login",
      { email: "nonexistent@example.com", password: "no" },
      401,
    );
  await attacker.call(
    "/api/auth/login",
    { email: "nonexistent@example.com", password: "no" },
    429,
  );
});
test("mail transport fails closed without configuration; test-only transport cannot run in production", async () => {
  const old = store.transport;
  store.transport = "resend";
  const c = client();
  await c.call(
    "/api/auth/register",
    {
      email: "unconfigured@example.com",
      nickname: "Unavailable",
      password,
      passwordConfirmation: password,
    },
    503,
  );
  assert.ok(
    !store.data.users.some((u) => u.email === "unconfigured@example.com"),
  );
  store.transport = old;
  process.env.NODE_ENV = "production";
  assert.throws(
    () => new Accounts(join(directory, "unsafe.json")),
    /restricted to automated tests/,
  );
  process.env.NODE_ENV = "test";
});
test("logout remains available after authentication rate limiting", async () => {
  const c = client();
  await c.call("/api/auth/login", { email: "alice@example.com", password });
  const entry = store.data.limits.find((l) => l.key === `auth-ip:${c.ip}`);
  entry.count = 60;
  await c.call("/api/auth/logout", {});
  assert.equal((await c.call("/api/auth/me")).data.user, null);
});
test("signup does not expose whether an email or nickname exists before OTP proof", async () => {
  const c = client();
  const before = store.data.users.length,
    hash = store.data.users.find(
      (u) => u.email === "alice@example.com",
    ).password;
  const pending = await c.call("/api/auth/register", {
    email: "alice@example.com",
    nickname: "Alice",
    password,
    passwordConfirmation: password,
  });
  assert.ok(pending.data.challengeId);
  await c.call(
    "/api/auth/verify",
    {
      challengeId: pending.data.challengeId,
      code: code(pending.data.challengeId),
    },
    400,
  );
  assert.equal(store.data.users.length, before);
  assert.equal(
    store.data.users.find((u) => u.email === "alice@example.com").password,
    hash,
  );
});
test("Resend retries transient failures with the same idempotency key and never sends passwords", async () => {
  const originalFetch = global.fetch,
    transport = store.transport,
    key = process.env.RESEND_API_KEY,
    from = process.env.EMAIL_FROM;
  const calls = [];
  try {
    store.transport = "resend";
    process.env.RESEND_API_KEY = "test-key-never-sent";
    process.env.EMAIL_FROM = "Game <accounts@test.invalid>";
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 429 };
    };
    await store.send(
      {
        id: "provider-test",
        generation: 1,
        purpose: "signup",
        email: "fixture@test.invalid",
      },
      "123456",
    );
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].options.headers["Idempotency-Key"],
      calls[1].options.headers["Idempotency-Key"],
    );
    assert.equal(JSON.parse(calls[0].options.body).password, undefined);
    assert.match(JSON.parse(calls[0].options.body).text, /123456/);
  } finally {
    global.fetch = originalFetch;
    store.transport = transport;
    if (key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = key;
    if (from === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = from;
  }
});
