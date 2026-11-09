import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("production HTTP supports name-only play without email, enforces origin, operational auth and log redaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-prod-http-")),
    file = join(dir, "db.sqlite"),
    base = "http://127.0.0.1:3014",
    origin = "https://game.test.invalid";
  let server,
    output = "",
    errors = "";
  try {
    server = spawn(process.execPath, ["scripts/api-test-server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: "3014",
        HOST: "127.0.0.1",
        PUBLIC_ORIGIN: origin,
        DATABASE_PATH: file,
        STATE_FILE: join(dir, "legacy.json"),
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
    const create = (headers = {}) =>
      fetch(base + "/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name: "PrivatePlayer", maxPlayers: 6 }),
      });
    assert.equal((await create()).status, 403);
    assert.equal(
      (await create({ Origin: "https://evil.invalid" })).status,
      403,
    );
    const response = await create({ Origin: origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.headers.get("Strict-Transport-Security"), /max-age/);
    const created = await response.json();
    assert.equal(created.room.players[0].name, "PrivatePlayer");
    assert.equal(created.room.maxPlayers, 6);
    assert.equal((await fetch(base + "/api/auth/me")).status, 404);
    assert.equal((await fetch(base + "/api/account")).status, 404);
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
    assert.ok(!output.includes("PrivatePlayer"));
    assert.ok(!output.includes(created.token));
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
