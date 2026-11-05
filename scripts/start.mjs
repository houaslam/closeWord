const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 22 || (minor === 22 && patch < 2)) {
  console.error(
    "CloseWord requires Node.js 24.22.2 or newer in the 24.x LTS line. Use Docker or switch to a supported Node 24 release.",
  );
  process.exit(1);
}
await import("../server.mjs");
