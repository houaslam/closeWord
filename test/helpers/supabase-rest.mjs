// Test-only PostgREST-compatible bridge backed by real PostgreSQL functions.
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { trustedFetch } from "./redis-rest.mjs";
const functions = new Set([
  "closeword_doc_read",
  "closeword_doc_commit",
  "closeword_limit",
  "closeword_presence",
  "closeword_release",
  "closeword_meta",
  "closeword_matches",
  "closeword_leaders",
  "closeword_health",
  "closeword_preflight",
  "closeword_cleanup",
]);
export async function supabaseRestBridge(port) {
  const config = {
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
    },
    admin = new pg.Pool(config);
  for (const role of ["anon", "authenticated", "service_role"])
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $$`,
    );
  const migration = readFileSync(
    "supabase/migrations/202611090001_closeword.sql",
    "utf8",
  );
  await admin.query(migration);
  await admin.query(migration);
  const service = new pg.Pool({ ...config, options: "-c role=service_role" });
  const dir = mkdtempSync(join(tmpdir(), "cw-supabase-tls-")),
    certPath = join(dir, "cert.pem"),
    keyPath = join(dir, "key.pem");
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
  const cert = readFileSync(certPath),
    token = "sb_secret_fixture_only";
  const server = https.createServer(
    { key: readFileSync(keyPath), cert },
    async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.headers.apikey !== token) {
        res.writeHead(401);
        res.end(JSON.stringify({ code: "AUTH_FAILED" }));
        return;
      }
      const name = req.url.split("/").at(-1);
      if (!functions.has(name)) {
        res.writeHead(404);
        res.end(JSON.stringify({ code: "PGRST202" }));
        return;
      }
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()),
          keys = Object.keys(body);
        if (!keys.every((key) => /^p_[a-z_]+$/.test(key)))
          throw Error("Invalid arguments");
        const result = await service.query(
          `SELECT public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(",")}) AS value`,
          keys.map((key) => body[key]),
        );
        res.end(JSON.stringify(result.rows[0].value));
      } catch (error) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            code: error.code || "TEST_ERROR",
            message: error.message,
          }),
        );
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    admin,
    certPath,
    url: `https://127.0.0.1:${server.address().port}`,
    token,
    fetcher: trustedFetch(cert),
    async close() {
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
      await service.end();
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
