import { gameService } from "../../lib/game-service.mjs";

export const config = {
  api: { bodyParser: false, responseLimit: false, externalResolver: true },
};

export default function handler(req, res) {
  return gameService().handle(req, res);
}
