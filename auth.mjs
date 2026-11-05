import { writeFileSync, mkdirSync } from "node:fs";
import { databaseFor } from "./storage.mjs";
import { dirname, join } from "node:path";
import {
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const opaque = () => randomBytes(32).toString("hex");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const reject = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
const emailAddress = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const validEmail = (email) =>
  email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  nickname: u.nickname,
  createdAt: u.createdAt,
  verified: true,
});
const equal = (a, b) => {
  const aa = Buffer.from(a, "hex"),
    bb = Buffer.from(b, "hex");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const dummy = `${"0".repeat(32)}:${"0".repeat(64)}`;
let hashing = 0;
async function derive(password, salt) {
  if (hashing >= 2) reject("Please try again in a moment.", 503);
  hashing++;
  try {
    return (
      await scrypt(password, salt, 32, {
        N: 131072,
        r: 8,
        p: 1,
        maxmem: 256 * 1024 * 1024,
      })
    ).toString("hex");
  } finally {
    hashing--;
  }
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${await derive(password, salt)}`;
}
async function checkPassword(password, stored = dummy) {
  const [salt, hash] = stored.split(":");
  return equal(await derive(password, salt), hash);
}
function validatePassword(password, confirmation) {
  if (
    typeof password !== "string" ||
    password.length < 15 ||
    password.length > 128
  )
    reject("Use a password between 15 and 128 characters.");
  if (password !== confirmation) reject("The passwords do not match.");
}

export class Accounts {
  constructor(file, { database } = {}) {
    this.file = file;
    this.store =
      database || databaseFor(join(dirname(file), "closeword.sqlite"));
    this.mailJobs = new Set();
    this.mutations = new Set();
    this.secure =
      process.env.COOKIE_SECURE === "true" ||
      process.env.NODE_ENV === "production";
    this.cookieName = this.secure ? "__Host-cw_session" : "cw_session";
    this.transport = process.env.MAIL_TRANSPORT || "resend";
    if (this.transport === "file" && process.env.NODE_ENV !== "test")
      throw Error("The file email transport is restricted to automated tests.");
    this.store.importLegacy({ accounts: file });
    this.data =
      this.store.authState || (this.store.authState = this.store.loadAuth());
    Object.defineProperty(this.data, "games", {
      configurable: true,
      get: () => this.store.values("game_history").map((r) => r.value),
    });
    this.prune(true);
  }
  prune(recover = false) {
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter(
      (s) => s.expiresAt > now && s.lastSeen > now - 7 * 86400000,
    );
    this.data.challenges = this.data.challenges
      .filter((c) => c.expiresAt > now)
      .map((c) =>
        recover && c.sending
          ? { ...c, sending: false, codeHash: "" }
          : recover && c.consuming
            ? { ...c, consuming: false, codeHash: "" }
            : c,
      );
    this.data.limits = this.data.limits.filter((l) => l.until > now);
    this.save();
  }
  save() {
    this.store.saveAuth(this.data);
  }
  backgroundIssue(c) {
    const job = this.issue(c)
      .catch(() =>
        console.error(
          JSON.stringify({ event: "email_delivery_failed", purpose: "reset" }),
        ),
      )
      .finally(() => this.mailJobs.delete(job));
    this.mailJobs.add(job);
  }
  async drain() {
    await Promise.allSettled([...this.mailJobs]);
  }

  configured() {
    return (
      this.transport === "file" ||
      Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
    );
  }
  rate(key, max, window) {
    const now = Date.now();
    this.data.limits = this.data.limits.filter((l) => l.until > now);
    let entry = this.data.limits.find((l) => l.key === key);
    if (!entry) {
      entry = { key, count: 0, until: now + window };
      this.data.limits.push(entry);
    }
    if (entry.count >= max)
      reject("Too many attempts. Please try again later.", 429);
    entry.count++;
    this.save();
  }
  sessionHash(req) {
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(this.cookieName + "="));
    const token = cookie?.slice(this.cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? digest(token) : null;
  }
  user(req) {
    const session = this.data.sessions.find(
      (s) => s.hash === this.sessionHash(req),
    );
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      session.lastSeen < Date.now() - 7 * 86400000
    )
      return null;
    const user = this.data.users.find((u) => u.id === session.userId);
    if (user && session.lastSeen < Date.now() - 300000) {
      session.lastSeen = Date.now();
      this.save();
    }
    return user || null;
  }
  sessionValid(hash) {
    const s = this.data.sessions.find((s) => s.hash === hash);
    return Boolean(
      s && s.expiresAt > Date.now() && s.lastSeen > Date.now() - 7 * 86400000,
    );
  }
  requireUser(req) {
    const user = this.user(req);
    if (!user) reject("Please log in to continue.", 401);
    return user;
  }
  setSession(req, res, user) {
    const token = opaque();
    this.data.sessions = this.data.sessions.filter(
      (s) => s.expiresAt > Date.now(),
    );
    const existing = this.data.sessions
      .filter((s) => s.userId === user.id)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    while (existing.length >= 10) {
      const oldest = existing.shift();
      this.data.sessions = this.data.sessions.filter((s) => s !== oldest);
    }
    this.data.sessions.push({
      hash: digest(token),
      userId: user.id,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      expiresAt: Date.now() + 30 * 86400000,
    });
    res.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${this.secure ? "; Secure" : ""}`,
    );
    this.save();
  }
  clearSession(req, res) {
    const hash = this.sessionHash(req);
    this.data.sessions = this.data.sessions.filter((s) => s.hash !== hash);
    res.setHeader(
      "Set-Cookie",
      `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? "; Secure" : ""}`,
    );
    this.save();
  }
  codeHash(id, code) {
    return createHmac("sha256", this.data.key)
      .update(`${id}:${code}`)
      .digest("hex");
  }
  async send(challenge, code) {
    const message = {
      from: process.env.EMAIL_FROM,
      to: [challenge.email],
      subject:
        challenge.purpose === "signup"
          ? "Verify your CloseWord email"
          : "Reset your CloseWord password",
      text: `Your CloseWord verification code is ${code}.\n\nThis code expires in 10 minutes. Do not share it. If you did not request this, you can ignore this email.`,
    };
    if (this.transport === "file") {
      mkdirSync(process.env.MAIL_TEST_DIR, { recursive: true });
      writeFileSync(
        join(process.env.MAIL_TEST_DIR, `${challenge.id}.json`),
        JSON.stringify({ ...message, code }),
        { mode: 0o600 },
      );
      return;
    }
    if (!this.configured())
      reject(
        "Email verification is temporarily unavailable. Please try again later.",
        503,
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `closeword-${challenge.id}-${challenge.generation}`,
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) return;
        if (response.status !== 429 && response.status < 500) break;
      } catch {}
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    reject("We could not send the email. Please try again later.", 503);
  }
  async issue(challenge) {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    challenge.codeHash = this.codeHash(challenge.id, code);
    challenge.expiresAt = Date.now() + 600000;
    challenge.sentAt = Date.now();
    challenge.attempts = 0;
    challenge.generation = (challenge.generation || 0) + 1;
    challenge.sending = true;
    this.save();
    try {
      if (
        challenge.purpose !== "reset" ||
        this.data.users.some((u) => u.email === challenge.email)
      )
        await this.send(challenge, code);
    } catch (e) {
      challenge.codeHash = "";
      throw e;
    } finally {
      challenge.sending = false;
      this.save();
    }
  }
  verifyChallenge(id, code, purpose) {
    const c = this.data.challenges.find(
      (c) => c.id === id && c.purpose === purpose,
    );
    if (
      !c ||
      c.sending ||
      c.expiresAt <= Date.now() ||
      c.attempts >= 5 ||
      !c.codeHash
    )
      reject("This code is invalid or expired. Request a new code.");
    c.attempts++;
    this.save();
    if (
      !/^\d{6}$/.test(String(code)) ||
      !equal(c.codeHash, this.codeHash(c.id, String(code)))
    )
      reject("This code is invalid or expired. Request a new code.");
    return c;
  }
  recordGame(game) {
    this.store.recordGame(game);
  }
  serializeGame(game, user, details = false) {
    const me = game.players.find((p) => p.userId === user.id);
    const outcome = me.left
      ? "left"
      : game.status === "finished"
        ? game.winnerId === me.id
          ? "won"
          : "lost"
        : game.status === "abandoned"
          ? "abandoned"
          : "playing";
    const guesses = game.guesses.filter(
      (g) => g.playerId === me.id || game.kind === "solo",
    );
    return {
      id: game.id,
      kind: game.kind,
      mode: game.mode,
      status: game.status,
      outcome,
      round: game.round,
      startedAt: game.startedAt,
      finishedAt: game.finishedAt,
      word: game.status === "finished" ? game.word : undefined,
      guessCount: guesses.length,
      bestRank: guesses.length ? Math.min(...guesses.map((g) => g.rank)) : null,
      hints: guesses.filter((g) => g.hint).length,
      winner: game.players.find((p) => p.id === game.winnerId)?.name,
      players: game.players.map((p) => ({
        name: p.name,
        you: p.userId === user.id,
        outcome: p.left
          ? "left"
          : game.status === "finished"
            ? p.id === game.winnerId
              ? "won"
              : "lost"
            : game.status === "abandoned"
              ? "abandoned"
              : "playing",
      })),
      ...(details
        ? {
            guesses: game.guesses
              .filter(
                (g) =>
                  game.status === "finished" ||
                  game.mode !== "race" ||
                  g.playerId === me.id,
              )
              .map(({ word, rank, name, hint }) => ({
                word,
                rank,
                name,
                hint,
              })),
          }
        : {}),
    };
  }
  async handle(req, res, url, b = {}) {
    const path = url.pathname,
      method = req.method;
    if (path === "/api/auth/me" && method === "GET") {
      const u = this.user(req);
      return {
        user: u ? publicUser(u) : null,
        emailAvailable: this.configured(),
      };
    }
    if (path.startsWith("/api/account") && method === "GET") {
      const user = this.requireUser(req);
      if (path === "/api/account")
        return { user: publicUser(user), stats: this.store.summary(user.id) };
      if (path === "/api/account/games") {
        const page = Number(url.searchParams.get("page") || 0);
        if (!Number.isInteger(page) || page < 0 || page > 10000)
          reject("Invalid page.");
        const result = url.searchParams.get("result") || "all";
        if (
          !["all", "won", "lost", "left", "playing", "abandoned"].includes(
            result,
          )
        )
          reject("Invalid result filter.");
        const rows = this.store.history(user.id, {
          result,
          limit: 21,
          offset: page * 20,
        });
        return {
          games: rows.slice(0, 20).map((g) => this.serializeGame(g, user)),
          hasMore: rows.length > 20,
          page,
        };
      }
      const id = path.slice("/api/account/games/".length);
      const game = this.store.historyGame(user.id, id);
      if (!game) reject("Game not found.", 404);
      return { game: this.serializeGame(game, user, true) };
    }

    if (method !== "POST") reject("Not found.", 404);
    if (path === "/api/auth/logout") {
      this.clearSession(req, res);
      return { ok: true };
    }
    const ip = req.clientIp || req.socket.remoteAddress || "unknown";
    this.rate(`auth-ip:${ip}`, 60, 15 * 60000);
    if (path === "/api/auth/register") {
      if (!this.configured())
        reject(
          "Email verification is temporarily unavailable. Please try again later.",
          503,
        );
      const email = emailAddress(b.email),
        nickname = String(b.nickname || "").trim();
      if (!validEmail(email)) reject("Enter a valid email address.");
      if (
        nickname.length < 2 ||
        nickname.length > 24 ||
        /[<>\x00-\x1f]/.test(nickname)
      )
        reject("Use a nickname between 2 and 24 characters.");
      validatePassword(b.password, b.passwordConfirmation);
      this.rate(`signup-ip:${ip}`, 10, 3600000);
      this.rate(`mail:${digest(email)}`, 5, 3600000);
      const password = await hashPassword(b.password);
      const challenge = {
        id: opaque(),
        purpose: "signup",
        email,
        nickname,
        password,
        createdAt: Date.now(),
      };
      this.data.challenges = this.data.challenges.filter(
        (c) =>
          c.expiresAt > Date.now() &&
          !(c.email === email && c.purpose === "signup"),
      );
      this.data.challenges.push(challenge);
      await this.issue(challenge);
      return {
        challengeId: challenge.id,
        email,
        expiresIn: 600,
        resendAfter: 60,
      };
    }
    if (path === "/api/auth/resend") {
      const c = this.data.challenges.find((c) => c.id === b.challengeId);
      if (!c) reject("Request a new verification code.");
      if (c.sending || c.consuming || Date.now() - c.sentAt < 60000)
        reject("Wait 60 seconds before requesting another code.", 429);
      this.rate(`mail:${digest(c.email)}`, 5, 3600000);
      if (c.purpose === "reset") this.backgroundIssue(c);
      else await this.issue(c);
      return { expiresIn: 600, resendAfter: 60 };
    }
    if (path === "/api/auth/verify") {
      const c = this.verifyChallenge(b.challengeId, b.code, "signup");
      if (
        this.data.users.some(
          (u) =>
            u.email === c.email ||
            u.nickname.toLowerCase() === c.nickname.toLowerCase(),
        )
      )
        reject(
          "These account details are no longer available. Please sign up again.",
        );
      const u = {
        id: opaque(),
        email: c.email,
        nickname: c.nickname,
        password: c.password,
        createdAt: Date.now(),
      };
      this.data.users.push(u);
      this.data.challenges = this.data.challenges.filter(
        (p) => p.email !== u.email,
      );
      this.setSession(req, res, u);
      return { user: publicUser(u) };
    }
    if (path === "/api/auth/login") {
      const email = emailAddress(b.email);
      this.rate(`login:${digest(email)}`, 10, 15 * 60000);
      if (typeof b.password !== "string" || b.password.length > 128)
        reject("Email or password is incorrect.", 401);
      const user = this.data.users.find((u) => u.email === email);
      const stored = user?.password;
      const valid = await checkPassword(b.password, stored);
      if (!user || !valid || user.password !== stored)
        reject("Email or password is incorrect.", 401);
      this.setSession(req, res, user);
      return { user: publicUser(user) };
    }
    if (path === "/api/auth/forgot") {
      if (!this.configured())
        reject(
          "Email verification is temporarily unavailable. Please try again later.",
          503,
        );
      const email = emailAddress(b.email);
      if (!validEmail(email)) reject("Enter a valid email address.");
      this.rate(`mail:${digest(email)}`, 5, 3600000);
      const challengeId = opaque();
      const c = {
        id: challengeId,
        purpose: "reset",
        email,
        createdAt: Date.now(),
      };
      this.data.challenges = this.data.challenges.filter(
        (c) =>
          c.expiresAt > Date.now() &&
          !(c.email === email && c.purpose === "reset"),
      );
      this.data.challenges.push(c);
      this.backgroundIssue(c);
      return {
        challengeId,
        email,
        message: "If an account exists for this email, a code has been sent.",
        expiresIn: 600,
        resendAfter: 60,
      };
    }
    if (path === "/api/auth/reset") {
      validatePassword(b.password, b.passwordConfirmation);
      const c = this.verifyChallenge(b.challengeId, b.code, "reset");
      const u = this.data.users.find((u) => u.email === c.email);
      if (!u || c.consuming || this.mutations.has(u.id))
        reject("Please request a new code.");
      c.consuming = true;
      this.mutations.add(u.id);
      this.save();
      try {
        const hash = await hashPassword(b.password);
        if (!this.data.challenges.includes(c))
          reject("This code has been replaced. Request a new code.");
        u.password = hash;
        this.data.sessions = this.data.sessions.filter(
          (s) => s.userId !== u.id,
        );
        this.data.challenges = this.data.challenges.filter(
          (ch) => ch.email !== u.email,
        );
        this.clearSession(req, res);
        return { ok: true };
      } catch (e) {
        c.consuming = false;
        this.save();
        throw e;
      } finally {
        this.mutations.delete(u.id);
      }
    }
    if (path === "/api/auth/password") {
      const user = this.requireUser(req);
      this.rate(`password:${user.id}`, 5, 15 * 60000);
      validatePassword(b.password, b.passwordConfirmation);
      if (this.mutations.has(user.id))
        reject("Please try again in a moment.", 503);
      this.mutations.add(user.id);
      try {
        if (
          typeof b.currentPassword !== "string" ||
          b.currentPassword.length > 128 ||
          !(await checkPassword(b.currentPassword, user.password))
        )
          reject("Current password is incorrect.", 401);
        if (!this.user(req)) reject("Please log in again.", 401);
        user.password = await hashPassword(b.password);
        this.data.sessions = this.data.sessions.filter(
          (s) => s.userId !== user.id,
        );
        this.data.challenges = this.data.challenges.filter(
          (c) => c.email !== user.email,
        );
        this.setSession(req, res, user);
        return { ok: true };
      } finally {
        this.mutations.delete(user.id);
      }
    }
    reject("Not found.", 404);
  }
}
