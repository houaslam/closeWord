import { configuration, loadEnvironment } from "../config.mjs";
import { RedisStore } from "./redis-store.mjs";
import { createSharedGameService } from "./shared-game-service.mjs";
export function createRedisGameService(options = {}) {
  const config = options.config || configuration();
  return createSharedGameService({
    ...options,
    config,
    store: options.store || new RedisStore(config),
  });
}
const singleton = Symbol.for("closeword.redis-service");
export function redisGameService() {
  if (!globalThis[singleton]) {
    loadEnvironment(process.cwd());
    globalThis[singleton] = createRedisGameService();
  }
  return globalThis[singleton];
}
