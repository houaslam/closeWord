// A test-only REST bridge to a real Redis server. Production uses Upstash HTTPS.
import net from "node:net";
import http from "node:http";
import https from "node:https";
const incomplete = Symbol("incomplete");
function parse(buffer, offset = 0) {
  if (offset >= buffer.length) return incomplete;
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return incomplete;
  const type = String.fromCharCode(buffer[offset]),
    line = buffer.toString("utf8", offset + 1, end),
    next = end + 2;
  if (type === "+") return { value: line, next };
  if (type === "-") return { value: Error(line), next };
  if (type === ":") return { value: Number(line), next };
  if (type === "$") {
    const size = Number(line);
    if (size < 0) return { value: null, next };
    if (buffer.length < next + size + 2) return incomplete;
    return {
      value: buffer.toString("utf8", next, next + size),
      next: next + size + 2,
    };
  }
  if (type === "*") {
    const count = Number(line);
    if (count < 0) return { value: null, next };
    let cursor = next;
    const value = [];
    for (let i = 0; i < count; i++) {
      const item = parse(buffer, cursor);
      if (item === incomplete) return incomplete;
      value.push(item.value);
      cursor = item.next;
    }
    return { value, next: cursor };
  }
  throw Error("Unknown Redis protocol response");
}
export class RedisConnection {
  constructor(port) {
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.socket = net.createConnection({ host: "127.0.0.1", port });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.pending.length) {
        const item = parse(this.buffer);
        if (item === incomplete) return;
        this.buffer = this.buffer.subarray(item.next);
        const pending = this.pending.shift();
        if (item.value instanceof Error) pending.reject(item.value);
        else pending.resolve(item.value);
      }
    });
    this.socket.on("error", (error) => {
      for (const pending of this.pending.splice(0)) pending.reject(error);
    });
  }
  command(args) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      const parts = [Buffer.from(`*${args.length}\r\n`)];
      for (const value of args) {
        const bytes = Buffer.from(String(value));
        parts.push(
          Buffer.from(`$${bytes.length}\r\n`),
          bytes,
          Buffer.from("\r\n"),
        );
      }
      this.socket.write(Buffer.concat(parts));
    });
  }
  close() {
    this.socket.destroy();
  }
}
export async function redisRestBridge(
  port,
  { token = "test-redis-token", tls } = {},
) {
  const redis = new RedisConnection(port);
  await redis.command(["PING"]);
  const handler = async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const args = JSON.parse(Buffer.concat(chunks).toString());
      const result = await redis.command(args);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    }
  };
  const server = tls
    ? https.createServer(tls, handler)
    : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    redis,
    url: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`,
    token,
    async close() {
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
      redis.close();
    },
  };
}

export function trustedFetch(ca) {
  return (url, options) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: options.method,
          headers: options.headers,
          signal: options.signal,
          ca,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: async () => JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
}
