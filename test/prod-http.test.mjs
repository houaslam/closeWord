import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, scryptSync } from "node:crypto";
import { Storage } from "../storage.mjs";
test("production HTTP enforces origin, secure cookie names, operational auth and log redaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-prod-http-")),
    file = join(dir, "db.sqlite"),
    base = "http://127.0.0.1:3014",
    origin = "https://game.test.invalid";
  let server,
    output = "",
    errors = "";
  const password = "a disposable production HTTP passphrase",
    email = "private-http@test.invalid",
    salt = randomBytes(16).toString("hex");
  const db = new Storage(file);
  db.put("users", "fixture", {
    id: "fixture",
    email,
    nickname: "Fixture",
    createdAt: Date.now(),
    password:
      salt +
      ":" +
      scryptSync(password, salt, 32, {
        N: 131072,
        r: 8,
        p: 1,
        maxmem: 256 * 1024 * 1024,
      }).toString("hex"),
  });
  db.close();
  try {
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: "3014",
        HOST: "127.0.0.1",
        PUBLIC_ORIGIN: origin,
        COOKIE_SECURE: "true",
        MAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "test-only-not-a-real-key",
        RESEND_API_KEY_FILE: "",
        EMAIL_FROM: "Game <accounts@test.invalid>",
        DATABASE_PATH: file,
        STATE_FILE: join(dir, "legacy.json"),
        AUTH_FILE: join(dir, "accounts.json"),
        METRICS_TOKEN: "private-test-metrics",
        METRICS_TOKEN_FILE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (chunk) => (errors += chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Server startup timed out: " + errors)),
        5000,
      );
      server.stdout.on("data", (chunk) => {
        output += chunk;
        if (String(chunk).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Server exited ${code}: ${errors}`));
      });
    });
    const login = (headers = {}) =>
      fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ email, password }),
      });
    assert.equal((await login()).status, 403);
    assert.equal((await login({ Origin: "https://evil.invalid" })).status, 403);
    const response = await login({ Origin: origin });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^__Host-cw_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(response.headers.get("Strict-Transport-Security"), /max-age/);
    assert.equal((await response.json()).user.nickname, "Fixture");
    const who = await fetch(base + "/api/auth/me", {
      headers: { Cookie: cookie.split(";")[0] },
    });
    assert.equal((await who.json()).user.nickname, "Fixture");
    const renamedCookie = cookie
      .split(";")[0]
      .replace("__Host-cw_session", "cw_session");
    assert.equal(
      (
        await (
          await fetch(base + "/api/auth/me", {
            headers: { Cookie: renamedCookie },
          })
        ).json()
      ).user,
      null,
    );
    assert.equal((await fetch(base + "/metrics")).status, 404);
    assert.equal(
      (
        await fetch(base + "/metrics", {
          headers: { Authorization: "Bearer incorrect" },
        })
      ).status,
      404,
    );
    const metrics = await fetch(base + "/metrics", {
      headers: { Authorization: "Bearer private-test-metrics" },
    });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /closeword_requests_total/);
    assert.equal((await fetch(base + "/health/ready")).status, 200);
    const logout = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie.split(";")[0],
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /^__Host-cw_session=;/);
    assert.ok(!output.includes(password));
    assert.ok(!output.includes(email));
    assert.ok(!output.includes("private-test-metrics"));
    assert.ok(output.includes("requestId"));
  } finally {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
