const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 22 || (minor === 22 && patch < 2)) {
  console.error(
    "CloseWord requires Node.js 24.22.2 or newer in the 24.x LTS line. Use Docker or switch to a supported Node 24 release.",
  );
  process.exit(1);
}
const { spawn } = await import("node:child_process");
const { configuration } = await import("../config.mjs");
const dev = process.argv.includes("--dev");
if (dev) process.env.NODE_ENV = "development";
else process.env.NODE_ENV = "production";
if (dev) {
  const { existsSync } = await import("node:fs");
  if (existsSync(".env")) process.loadEnvFile(".env");
}
const config = configuration();
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    dev ? "dev" : "start",
    ...(dev ? ["--webpack"] : []),
    "--hostname",
    config.host,
    "--port",
    String(config.port),
  ],
  { stdio: "inherit", env: process.env },
);
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGINT"));
child.once("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
