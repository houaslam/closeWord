import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  context = process.env.DOCKER_CONTEXT
    ? ["--context", process.env.DOCKER_CONTEXT]
    : [],
  image = process.env.SMOKE_IMAGE || "closeword:local",
  name = "closeword-smoke-" + randomBytes(5).toString("hex");
const docker = async (args) =>
  (
    await exec("docker", [...context, ...args], {
      timeout: 60000,
      maxBuffer: 1048576,
    })
  ).stdout.trim();
const restrictions = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--memory=768m",
  "--cpus=2",
  "--pids-limit=128",
  "--tmpfs",
  "/tmp:rw",
  "--mount",
  `type=volume,source=${name}-data,target=/data`,
];
let running = false;
let volumeCreated = false;
try {
  await docker(["volume", "create", `${name}-data`]);
  volumeCreated = true;
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    ...restrictions,
    "-e",
    "PUBLIC_ORIGIN=https://smoke.test.invalid",
    "-e",
    "EMAIL_FROM=Game <accounts@test.invalid>",
    "-e",
    "RESEND_API_KEY=test-only-not-a-real-provider-key",
    "-e",
    "COOKIE_SECURE=true",
    image,
  ]);
  running = true;
  let result;
  for (let i = 0; i < 30; i++) {
    try {
      result = JSON.parse(
        await docker([
          "exec",
          name,
          "node",
          "--input-type=module",
          "-e",
          "const response=await fetch('http://127.0.0.1:3000/health/ready');console.log(JSON.stringify({status:response.status,...await response.json(),uid:process.getuid(),node:process.version}));",
        ]),
      );
      if (result.ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    result?.ready,
    true,
    await docker(["logs", name]).catch(
      () => "Container exited before readiness",
    ),
  );
  assert.equal(result.status, 200);
  assert.equal(result.uid, 1000);
  const settings = JSON.parse(
    await docker(["inspect", name, "--format", "{{json .HostConfig}}"]),
  );
  assert.equal(settings.ReadonlyRootfs, true);
  const privileges = JSON.parse(
    await docker([
      "exec",
      name,
      "node",
      "-e",
      "const fs=require('node:fs');const s=fs.readFileSync('/proc/self/status','utf8');console.log(JSON.stringify({capEff:s.match(/^CapEff:\\s*(\\w+)/m)[1],noNew:s.match(/^NoNewPrivs:\\s*(\\d+)/m)[1]}));",
    ]),
  );
  assert.equal(BigInt("0x" + privileges.capEff), 0n);
  assert.equal(privileges.noNew, "1");
  assert.equal(settings.Memory, 768 * 1024 * 1024);
  await docker(["stop", "-t", "40", name]);
  running = false;
  let rejected = false;
  try {
    await docker([
      "run",
      "--rm",
      ...restrictions,
      "-e",
      "PUBLIC_ORIGIN=https://smoke.test.invalid",
      image,
    ]);
  } catch (e) {
    rejected = String(e.stderr || "").includes("RESEND_API_KEY");
  }
  assert.equal(
    rejected,
    true,
    "Production must reject missing email credentials",
  );
  const report = {
    image,
    imageId: await docker(["image", "inspect", image, "--format", "{{.Id}}"]),
    ...result,
    readOnlyRoot: true,
    capabilitiesDropped: true,
    productionFailsClosed: true,
    liveEmailVerified: false,
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/container-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (running) await docker(["stop", "-t", "40", name]).catch(() => {});
  if (volumeCreated)
    await docker(["volume", "rm", `${name}-data`]).catch(() => {});
}
