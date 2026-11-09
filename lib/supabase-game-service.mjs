import { configuration, loadEnvironment } from "../config.mjs";
import { SupabaseStore } from "./supabase-store.mjs";
import { createSharedGameService } from "./shared-game-service.mjs";
export function createSupabaseGameService(options = {}) {
  const config = options.config || configuration();
  return createSharedGameService({
    ...options,
    config,
    store: options.store || new SupabaseStore(config),
  });
}
const singleton = Symbol.for("closeword.supabase-service");
export function supabaseGameService() {
  if (!globalThis[singleton]) {
    loadEnvironment(process.cwd());
    globalThis[singleton] = createSupabaseGameService();
  }
  return globalThis[singleton];
}
