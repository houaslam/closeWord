import { configuration } from "../../config.mjs";
import { log } from "../../operations.mjs";
export const config = {
  api: { bodyParser: false, responseLimit: false, externalResolver: true },
  maxDuration: 60,
};
export default async function handler(req, res) {
  try {
    if (configuration().storage === "redis") {
      const { redisGameService } =
        await import("../../lib/redis-game-service.mjs");
      return await redisGameService().handle(req, res);
    }
    const { gameService } = await import("../../lib/game-service.mjs");
    return await gameService().handle(req, res);
  } catch {
    log("service_configuration_error");
    if (!res.headersSent)
      res.status(503).json({
        error:
          "Game service is not configured. Check the deployment environment variables.",
      });
    else res.end();
  }
}
