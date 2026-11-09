import { randomUUID } from "node:crypto";
import { configuration } from "../../config.mjs";
import { log } from "../../operations.mjs";
import { deploymentFailure, revision } from "../../lib/deployment-status.mjs";
export const config = {
  api: { bodyParser: false, responseLimit: false, externalResolver: true },
  maxDuration: 60,
};
export default async function handler(req, res) {
  let stage = "configuration";
  const pathname = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Request-ID", randomUUID());
  try {
    const settings = configuration();
    stage = settings.storage;
    if (settings.storage === "supabase") {
      const { supabaseGameService } =
        await import("../../lib/supabase-game-service.mjs");
      return await supabaseGameService().handle(req, res);
    }
    if (settings.storage === "redis") {
      const { redisGameService } =
        await import("../../lib/redis-game-service.mjs");
      return await redisGameService().handle(req, res);
    }
    const { gameService } = await import("../../lib/game-service.mjs");
    return await gameService().handle(req, res);
  } catch (error) {
    const failure = deploymentFailure(error, stage);
    log("service_initialization_failed", {
      stage,
      code: failure.code,
      revision: revision(),
    });
    if (!res.headersSent) {
      const readiness = ["/health/ready", "/api/health/ready"].includes(
        pathname,
      );
      res.status(503).json(
        readiness
          ? { ready: false, ...failure, revision: revision() }
          : {
              error:
                "The game server is not ready yet. Please try again later.",
              code: failure.code,
            },
      );
    } else res.end();
  }
}
