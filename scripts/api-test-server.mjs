import http from "node:http";
import { createGameService } from "../lib/game-service.mjs";
import { configuration } from "../config.mjs";
import { log } from "../operations.mjs";
const service = createGameService();
const config = configuration();
const server = http.createServer(service.handle);
server.maxConnections = 2000;
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
function stop(signal) {
  log("shutdown", { signal });
  service.close();
  server.closeIdleConnections();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
server.listen(config.port, config.host, () =>
  log("listening", { port: config.port }),
);
