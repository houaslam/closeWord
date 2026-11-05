import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
test("graceful restart and crash recovery preserve name-only room seats, guesses and results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-restart-")),
    file = join(dir, "db.sqlite"),
    base = "http://127.0.0.1:3013";
  let server;
  const start = async () => {
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "3013",
        HOST: "127.0.0.1",
        DATABASE_PATH: file,
        STATE_FILE: join(dir, "legacy.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    server.stderr.on("data", (chunk) => (errors += chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Server did not become ready: " + errors)),
        5000,
      );
      server.stdout.on("data", (chunk) => {
        if (String(chunk).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("Server exited " + code + ": " + errors));
      });
    });
  };
  const stop = async (signal) => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill(signal);
    await exited;
  };
  const api = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  try {
    await start();
    const host = await api("/api/rooms", {
      name: "Host",
      mode: "turn",
      maxPlayers: 2,
    });
    const code = host.room.code;
    const guest = await api(
      `/api/rooms/${code}/join`,
      { name: "Guest" },
      false,
    );
    await api(`/api/rooms/${code}/start`, { token: host.token });
    let db = new DatabaseSync(file, { readOnly: true });
    const target = JSON.parse(
      db.prepare("SELECT payload FROM rooms WHERE id=?").get(code).payload,
    ).target;
    db.close();
    await api(`/api/rooms/${code}/guess`, {
      token: host.token,
      word: target === "water" ? "coffee" : "water",
    });
    await stop("SIGTERM");
    await start();
    const recovered = await api(`/api/rooms/${code}/join`, {
      token: host.token,
    });
    assert.equal(recovered.playerId, host.playerId);
    assert.equal(recovered.room.guesses.length, 1);
    assert.equal(recovered.room.turn, guest.playerId);
    await api(
      `/api/rooms/${code}/guess`,
      { token: guest.token, word: target },
      false,
    );
    await stop("SIGKILL");
    db = new DatabaseSync(file);
    db.prepare("UPDATE metadata SET value='0' WHERE key='writer_seen'").run();
    db.close();
    await start();
    const restored = await api(`/api/rooms/${code}/join`, {
      token: host.token,
    });
    assert.equal(restored.room.status, "finished");
    assert.equal(restored.room.winner, guest.playerId);
    assert.equal(restored.room.answer, target);
    assert.equal((await api("/health/ready")).ready, true);
  } finally {
    if (server && server.exitCode === null) await stop("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
