import http from "node:http";
import { createSupabaseGameService } from "../lib/supabase-game-service.mjs";
const service = createSupabaseGameService({
  streamDurationMs: 1200,
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
