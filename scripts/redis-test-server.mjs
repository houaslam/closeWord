import http from "node:http";
import { createRedisGameService } from "../lib/redis-game-service.mjs";
const service = createRedisGameService({
  streamDurationMs: Number(process.env.TEST_STREAM_DURATION_MS || 45000),
  pollMs: 50,
});
const server = http.createServer(service.handle);
server.listen(Number(process.env.PORT), "127.0.0.1", () =>
  console.log("listening"),
);
function close() {
  service.close();
  server.closeIdleConnections();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
