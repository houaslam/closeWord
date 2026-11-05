import { randomUUID, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isIP } from "node:net";
const buckets = new Map();
export function limit(key, max, window = 60000) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.until <= now) {
    if (buckets.size >= 10000) {
      for (const [k, b] of buckets) if (b.until <= now) buckets.delete(k);
      if (buckets.size >= 10000)
        throw Object.assign(Error("Server is busy. Try again shortly."), {
          status: 503,
        });
    }
    bucket = { count: 0, until: now + window };
    buckets.set(key, bucket);
  }
  if (++bucket.count > max)
    throw Object.assign(Error("Too many requests. Try again later."), {
      status: 429,
      retryAfter: Math.ceil((bucket.until - now) / 1000),
    });
}
export function clientIp(req, trustProxy) {
  const peer = req.socket.remoteAddress || "unknown";
  if (!trustProxy) return peer;
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .at(-1)
    ?.trim();
  return isIP(forwarded) ? forwarded : peer;
}
export function log(event, fields = {}) {
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n",
  );
}
export function observe(req, res, path, metrics) {
  const start = performance.now();
  req.requestId = randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  res.once("finish", () => {
    metrics.requests++;
    if (res.statusCode >= 500) metrics.errors++;
    log("request", {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    });
  });
}
export function telemetry() {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  return {
    requests: 0,
    errors: 0,
    started: Date.now(),
    loop,
    snapshot() {
      return `closeword_uptime_seconds ${Math.floor((Date.now() - this.started) / 1000)}\ncloseword_requests_total ${this.requests}\ncloseword_errors_total ${this.errors}\ncloseword_memory_rss_bytes ${process.memoryUsage().rss}\ncloseword_event_loop_p99_seconds ${Number.isFinite(loop.percentile(99)) ? loop.percentile(99) / 1e9 : 0}\n`;
    },
  };
}
export function authorizedMetrics(req) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return false;
  const supplied = String(req.headers.authorization || "");
  const a = Buffer.from(supplied),
    b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function readJson(req, max = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      done = false;
    const fail = (message, status) => {
      if (done) return;
      done = true;
      req.pause();
      reject(Object.assign(Error(message), { status }));
    };
    if (Number(req.headers["content-length"] || 0) > max) {
      fail("Request too large.", 413);
      return;
    }
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        fail("Request too large.", 413);
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (done) return;
      done = true;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw Error();
        resolve(body);
      } catch {
        reject(
          Object.assign(Error("Expected a valid JSON object."), {
            status: 400,
          }),
        );
      }
    });
    req.once("error", () => fail("Request interrupted.", 400));
    req.once("aborted", () => fail("Request interrupted.", 400));
  });
}
