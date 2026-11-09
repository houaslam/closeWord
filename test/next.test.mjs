import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const enabled = existsSync(".next/BUILD_ID");
test(
  "Next.js serves nonce-protected React pages and synchronizes six players through native API routes",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-next-")),
      file = join(dir, "game.sqlite"),
      origin = "https://next.test.invalid",
      base = "http://127.0.0.1:3015",
      controllers = [];
    let output = "",
      server;
    async function call(path, body, status = 200) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    }
    async function until(check) {
      for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail("Next.js live clients did not synchronize");
    }
    async function connect(code, seat) {
      const abort = new AbortController();
      controllers.push(abort);
      const response = await fetch(
        `${base}/api/events?code=${code}&token=${seat.token}`,
        { signal: abort.signal },
      );
      assert.equal(response.status, 200);
      const reader = response.body.getReader(),
        state = { room: null };
      let buffer = "";
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += new TextDecoder().decode(value);
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (event.startsWith("data: "))
                state.room = JSON.parse(event.slice(6));
            }
          }
        } catch (e) {
          if (e.name !== "AbortError") throw e;
        }
      })();
      return state;
    }
    try {
      server = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          "3015",
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            PORT: "3015",
            PUBLIC_ORIGIN: origin,
            DATABASE_PATH: file,
            STATE_FILE: join(dir, "legacy.json"),
            METRICS_TOKEN: "next-test-metrics",
            METRICS_TOKEN_FILE: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stdout.on("data", (chunk) => (output += chunk));
      server.stderr.on("data", (chunk) => (output += chunk));
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null) throw Error(output);
        try {
          ready = (await fetch(base + "/health/ready")).ok;
          if (ready) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(ready, output);
      const response = await fetch(base + "/multiplayer"),
        html = await response.text(),
        csp = response.headers.get("Content-Security-Policy");
      assert.equal(response.status, 200);
      assert.match(html, /__NEXT_DATA__/);
      assert.match(html, /_next\/static/);
      assert.doesNotMatch(html, /\/app.js/);
      assert.match(csp, /frame-ancestors 'none'/);
      const nonce = csp.match(/'nonce-([^']+)'/)[1];
      assert.match(html, new RegExp(`nonce="${nonce}"`));
      assert.ok(
        !csp
          .split(";")
          .find((value) => value.includes("script-src"))
          .includes("'unsafe-inline'"),
      );
      assert.ok(!csp.includes("'unsafe-eval'"));
      const again = await fetch(base + "/multiplayer");
      assert.notEqual(again.headers.get("Content-Security-Policy"), csp);
      assert.equal((await fetch(base + "/signup")).status, 404);
      assert.equal((await fetch(base + "/api/auth/me")).status, 404);
      assert.equal((await fetch(base + "/metrics")).status, 404);
      const denied = await fetch(base + "/api/rooms", {
        method: "POST",
        headers: {
          Origin: "https://other.test.invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Bad" }),
      });
      assert.equal(denied.status, 403);
      const host = await call("/api/rooms", {
          name: "Next Host",
          mode: "race",
          maxPlayers: 6,
        }),
        code = host.room.code,
        players = [host];
      for (let i = 1; i < 6; i++)
        players.push(
          await call(`/api/rooms/${code}/join`, { name: `Next Player ${i}` }),
        );
      await call(`/api/rooms/${code}/join`, { name: "Seventh" }, 409);
      const streams = await Promise.all(players.map((p) => connect(code, p)));
      await until(() => streams.every((s) => s.room?.players.length === 6));
      await call(`/api/rooms/${code}/start`, { token: host.token });
      await until(() => streams.every((s) => s.room?.status === "playing"));
      const db = new DatabaseSync(file, { readOnly: true });
      const target = JSON.parse(
        db.prepare("SELECT payload FROM rooms WHERE id=?").get(code).payload,
      ).target;
      db.close();
      const word = target === "ocean" ? "coffee" : "ocean";
      await Promise.all(
        players.map((p) =>
          call(`/api/rooms/${code}/guess`, { token: p.token, word }),
        ),
      );
      await until(() =>
        streams.every(
          (s) =>
            s.room?.guesses.length === 1 &&
            s.room.players.every((p) => p.guessCount === 1),
        ),
      );
      assert.ok(
        streams.every(
          (s) => !s.room.answer && s.room.players.every((p) => !("token" in p)),
        ),
      );
      await new Promise((r) => setTimeout(r, 220));
      await call(`/api/rooms/${code}/guess`, {
        token: players[5].token,
        word: target,
      });
      await until(() =>
        streams.every(
          (s) =>
            s.room?.winner === players[5].playerId && s.room.answer === target,
        ),
      );
      const rejoined = await call(`/api/rooms/${code}/join`, {
        token: host.token,
      });
      assert.equal(rejoined.playerId, host.playerId);
      await call(`/api/rooms/${code}/rematch`, { token: host.token });
      await until(() =>
        streams.every(
          (s) => s.room?.round === 2 && s.room.status === "waiting",
        ),
      );
      assert.equal((await fetch(base + `/multiplayer/m/${code}`)).status, 200);
      assert.ok(!output.includes(host.token));
    } finally {
      if (server && server.exitCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill("SIGTERM");
        assert.ok(
          [0, 143].includes(await exited),
          "Next.js must exit normally or with its standard SIGTERM status",
        );
        assert.doesNotMatch(
          output,
          /database_failure|database is not open|ERR_SQLITE/,
        );
      }
      for (const controller of controllers) controller.abort();
      if (existsSync(file)) {
        const db = new DatabaseSync(file, { readOnly: true });
        assert.equal(
          db
            .prepare("SELECT value FROM metadata WHERE key='writer_owner'")
            .get()?.value,
          "",
        );
        db.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
