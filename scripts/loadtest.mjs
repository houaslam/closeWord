import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const directory = mkdtempSync(join(tmpdir(), "cw-load-"));
const port = Number(process.env.LOADTEST_PORT || 3040),
  base = `http://127.0.0.1:${port}`;
const controllers = [],
  latencies = [];
let server,
  stderr = "",
  peopleIndex = 0,
  peakMemory = 0,
  monitor;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, data, ip = "198.51.100.254") {
  const start = performance.now();
  const response = await fetch(base + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      Origin: "https://load.test.invalid",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  latencies.push(performance.now() - start);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function stream(room, p) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(
    `${base}/api/events?code=${room.code}&token=${p.token}`,
    { signal: controller.signal, headers: { "X-Forwarded-For": p.ip } },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    state = { value: null };
  let buffer = "";
  (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        buffer += new TextDecoder().decode(result.value);
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (event.startsWith("data: "))
            state.value = JSON.parse(event.slice(6));
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
      String(port),
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://load.test.invalid",
        NEXT_TELEMETRY_DISABLED: "1",
        METRICS_TOKEN_FILE: "",
        PORT: String(port),
        HOST: "127.0.0.1",
        DATABASE_PATH: join(directory, "game.sqlite"),
        STATE_FILE: join(directory, "legacy.json"),
        TRUST_PROXY: "true",
        METRICS_TOKEN: "load-test-metrics-only",
        NODE_OPTIONS: "--max-old-space-size=384",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stderr.on("data", (chunk) => (stderr += chunk));
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Ready")) resolve();
    });
    server.once("error", reject);
    server.once("exit", (code) =>
      reject(Error(`Server exited ${code}: ${stderr}`)),
    );
  });
  monitor = setInterval(async () => {
    try {
      const metrics = await (
        await fetch(base + "/metrics", {
          headers: { Authorization: "Bearer load-test-metrics-only" },
        })
      ).text();
      peakMemory = Math.max(
        peakMemory,
        Number(metrics.match(/closeword_memory_rss_bytes (\d+)/)?.[1] || 0),
      );
    } catch {}
  }, 50);
  const rooms = await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      const mode = index % 2 ? "race" : "turn",
        ip = `198.51.100.${++peopleIndex}`;
      const first = await request(
        "/api/rooms",
        { name: `Host ${index}`, mode, maxPlayers: 6 },
        ip,
      );
      const r = { code: first.room.code, mode, people: [{ ...first, ip }] };
      for (let j = 1; j < 6; j++) {
        const guestIp = `198.51.100.${++peopleIndex}`;
        r.people.push({
          ...(await request(
            `/api/rooms/${r.code}/join`,
            { name: `Guest ${index}-${j}` },
            guestIp,
          )),
          ip: guestIp,
        });
      }
      r.states = await Promise.all(r.people.map((p) => stream(r, p)));
      return r;
    }),
  );
  const db = new DatabaseSync(join(directory, "game.sqlite"), {
    readOnly: true,
  });
  for (const r of rooms)
    r.target = JSON.parse(
      db.prepare("SELECT payload FROM rooms WHERE id=?").get(r.code).payload,
    ).target;
  db.close();
  await Promise.all(
    rooms.map((r) =>
      request(
        `/api/rooms/${r.code}/start`,
        { token: r.people[0].token },
        r.people[0].ip,
      ),
    ),
  );
  for (let wave = 0; wave < 3; wave++) {
    await Promise.all(
      rooms.map(async (r) => {
        const words = [
          "ocean",
          "garden",
          "mountain",
          "coffee",
          "music",
          "river",
          "forest",
          "window",
          "water",
          "sea",
          "apple",
          "bread",
          "school",
          "camera",
          "summer",
          "winter",
          "cloud",
          "bridge",
          "candle",
          "flower",
        ].filter((w) => w !== r.target);
        const guess = (p, i) =>
          request(
            `/api/rooms/${r.code}/guess`,
            {
              token: p.token,
              word: words[r.mode === "race" ? wave : wave * 6 + i],
            },
            p.ip,
          );
        if (r.mode === "race") await Promise.all(r.people.map(guess));
        else for (const [i, p] of r.people.entries()) await guess(p, i);
      }),
    );
    await pause(220);
  }
  await Promise.all(
    rooms.map((r) =>
      request(
        `/api/rooms/${r.code}/guess`,
        { token: r.people[0].token, word: r.target },
        r.people[0].ip,
      ),
    ),
  );
  for (
    let i = 0;
    i < 100 &&
    !rooms.every((r) => r.states.every((s) => s.value?.status === "finished"));
    i++
  )
    await pause(20);
  assert.ok(
    rooms.every((r) => r.states.every((s) => s.value?.status === "finished")),
    "All 120 clients must receive the completed game",
  );
  const metrics = await (
    await fetch(base + "/metrics", {
      headers: { Authorization: "Bearer load-test-metrics-only" },
    })
  ).text();
  const memory = Number(metrics.match(/closeword_memory_rss_bytes (\d+)/)?.[1]);
  latencies.sort((a, b) => a - b);
  const report = {
    rooms: rooms.length,
    connectedPlayers: 120,
    modes: ["turn", "race"],
    requests: latencies.length,
    p50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]),
    p95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]),
    maxMs: Math.round(latencies.at(-1)),
    rssMiB: Math.round(memory / 1048576),
    peakRssMiB: Math.round(Math.max(memory, peakMemory) / 1048576),
    allClientsReceivedResults: true,
    node: process.version,
  };
  assert.ok(report.p95Ms < 2000, "p95 must be below 2 seconds");
  assert.ok(
    Math.max(memory, peakMemory) < 720 * 1048576,
    "Game load must fit the deployment memory budget",
  );
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/loadtest.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(monitor);
  for (const c of controllers) c.abort();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 10000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  rmSync(directory, { recursive: true, force: true });
}
