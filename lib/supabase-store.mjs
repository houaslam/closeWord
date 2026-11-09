import { randomBytes } from "node:crypto";
import { SharedStore } from "./shared-store.mjs";
function unavailable(
  message = "Game storage is temporarily unavailable. Please retry.",
  code = "SUPABASE_UNAVAILABLE",
) {
  return Object.assign(Error(message), { status: 503, code });
}
export class SupabaseStore extends SharedStore {
  constructor(config, { fetcher = fetch } = {}) {
    super();
    this.config = config;
    this.fetcher = fetcher;
  }
  async rpc(name, args = {}, options = {}) {
    const headers = {
      apikey: this.config.supabaseKey,
      "Content-Type": "application/json",
    };
    // Modern secret keys belong on apikey, not on the JWT Authorization header.
    if (this.config.supabaseKey.startsWith("eyJ"))
      headers.Authorization = `Bearer ${this.config.supabaseKey}`;
    let response;
    try {
      response = await this.fetcher(
        `${this.config.supabaseUrl}/rest/v1/rpc/${name}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(args),
          cache: "no-store",
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
        },
      );
    } catch (e) {
      if (options.signal?.aborted) throw e;
      throw unavailable();
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      if (["PGRST202", "PGRST205", "42P01", "42883"].includes(data?.code))
        throw unavailable(
          "Supabase database setup is incomplete. Run the CloseWord SQL migration.",
          "SUPABASE_SCHEMA_MISSING",
        );
      if ([401, 403].includes(response.status))
        throw unavailable(
          "Supabase access was rejected. Check the server secret key and database migration.",
          "SUPABASE_ACCESS_DENIED",
        );
      throw unavailable();
    }
    return data;
  }
  read(kind, id) {
    return this.rpc("closeword_doc_read", {
      p_namespace: this.config.namespace,
      p_kind: kind,
      p_id: id,
    });
  }
  async commit(kind, id, version, value) {
    value.revision = version + 1;
    const result = await this.rpc("closeword_doc_commit", {
      p_namespace: this.config.namespace,
      p_kind: kind,
      p_id: id,
      p_expected: version,
      p_payload: value,
      p_max: kind === "room" ? this.config.maxRooms : this.config.maxSolos,
    });
    if (result === -2) throw unavailable("Server is busy. Try again later.");
    return result === 1;
  }
  async limit(key, max, window = 60000) {
    const [count, ttl] = await this.rpc("closeword_limit", {
      p_namespace: this.config.namespace,
      p_key: key,
      p_window: window,
    });
    if (count > max)
      throw Object.assign(Error("Too many requests. Try again later."), {
        status: 429,
        retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
      });
  }
  secret() {
    return this.rpc("closeword_meta", {
      p_namespace: this.config.namespace,
      p_key: "daily:key",
      p_candidate: randomBytes(32).toString("hex"),
      p_ttl: null,
    });
  }
  dailyTarget(day, target) {
    return this.rpc("closeword_meta", {
      p_namespace: this.config.namespace,
      p_key: `daily:word:${day}`,
      p_candidate: target,
      p_ttl: 864000,
    });
  }
  matches(mode, capacity) {
    return this.rpc("closeword_matches", {
      p_namespace: this.config.namespace,
      p_mode: mode,
      p_capacity: capacity,
    });
  }
  async presence(code, playerId = "", connectionId = "", signal) {
    const result = await this.rpc(
      "closeword_presence",
      {
        p_namespace: this.config.namespace,
        p_code: code,
        p_player: playerId,
        p_connection: connectionId,
        p_window: 12000,
        p_max: this.config.maxStreams,
      },
      { signal },
    );
    if (result.code === "LIMIT")
      throw Object.assign(
        Error("Connection limit reached. Close another game tab."),
        { status: 429 },
      );
    if (!result.record)
      throw Object.assign(Error("Room not found."), { status: 404 });
    return { room: result.record.value, online: new Set(result.online) };
  }
  release(code, playerId, connectionId) {
    return this.rpc("closeword_release", {
      p_namespace: this.config.namespace,
      p_code: code,
      p_player: playerId,
      p_connection: connectionId,
    });
  }
  leaders(period) {
    return this.rpc("closeword_leaders", {
      p_namespace: this.config.namespace,
      p_period: period || "all",
    });
  }
  async ping() {
    const result = await this.rpc("closeword_health");
    if (result?.schema !== 1 || !result.ok)
      throw unavailable(
        "Supabase database setup is incomplete. Run the CloseWord SQL migration.",
        "SUPABASE_SCHEMA_MISSING",
      );
    return "PONG";
  }
  async check() {
    await this.ping();
    const result = await this.rpc("closeword_preflight", {
      p_namespace: this.config.namespace,
    });
    if (!result?.ok) throw unavailable();
  }
}
