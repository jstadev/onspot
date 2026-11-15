import { apiRoute, getActor, serveApi } from "./api.js";
import { createEvents } from "./events.js";
import { allowMethod, HttpError, readBody, sendJson, tokenBucket } from "./http.js";
import { SHOT_MAX, SHOT_TYPES } from "./shots.js";
import { createStatic, decodePath } from "./static.js";

// PUT exists only on the shot route. A shot and an image for a pin arrive as raw bytes.
const WRITES = new Set(["POST", "PATCH", "DELETE", "PUT"]);
const HOST_RE = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/i;
const mediaType = (req) => req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
// A JSON-RPC error for an MCP body that the handler never gets.
const rpcRefusal = (code, message) => ({ jsonrpc: "2.0", id: null, error: { code, message } });

export function createApp({ store, version, extension = null, queueUrl = "https://ai.koglabs.com/triad?tab=pins", downloadDir, mcpHandler, writeLimit = { capacity: 120, perMs: 60000 }, heartbeatMs = 20000 }) {
  const takeToken = tokenBucket(writeLimit);
  const events = createEvents({ store, heartbeatMs });
  const files = createStatic({ downloadDir });

  async function dispatch(req, res) {
    const port = req.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) throw new HttpError(403, "forbidden host");
    if (req.headers.origin !== undefined) throw new HttpError(403, "origin forbidden");
    const path = decodePath(req.url);
    const queryAt = req.url.indexOf("?");
    const query = new URLSearchParams(queryAt < 0 ? "" : req.url.slice(queryAt + 1));
    const mcp = path === "/mcp";
    if (mcp && req.headers["x-forwarded-for"] !== undefined) throw new HttpError(403, "mcp is local only");
    const route = apiRoute(path);
    const stream = path === "/api/events";
    let file;
    if (mcp) allowMethod(req, res, ["POST"]);
    else if (route) allowMethod(req, res, route.methods);
    else if (stream) allowMethod(req, res, ["GET"]);
    else if (path === "/") {
      // The old queue page address (and the extension's older builds) lead to the Triad Pins tab.
      allowMethod(req, res, ["GET"]);
      const to = new URL(queueUrl);
      const host = query.get("host");
      if (host && HOST_RE.test(host)) to.searchParams.set("host", host);
      res.writeHead(302, { Location: to.href });
      return res.end();
    } else {
      if (path === "/api" || path.startsWith("/api/")) throw new HttpError(404, "not found");
      file = await files.find(path);
      if (!file) throw new HttpError(404, "not found");
      allowMethod(req, res, ["GET"]);
    }

    let body = {};
    let actor;
    const limited = (retry) => sendJson(res, 429, { error: "write limit exceeded" }, { "Retry-After": String(retry) });
    if (WRITES.has(req.method)) {
      const retry = takeToken();
      if (retry) return limited(retry);
      if (route?.name === "shot" || route?.name === "images") {
        // A shot comes from a local agent. Caddy adds X-Forwarded-For, so a browser never gets here.
        // An image for a pin comes from him through Caddy, or from an agent.
        if (route.name === "shot" && req.headers["x-forwarded-for"] !== undefined) throw new HttpError(403, "shot upload is local only");
        actor = getActor(req);
        if (route.name === "shot" && actor.kind !== "agent") throw new HttpError(403, "only an agent can upload a shot");
        const type = mediaType(req);
        if (!SHOT_TYPES.includes(type)) throw new HttpError(415, `content type must be ${SHOT_TYPES.join(", ")}`);
        body = { type, bytes: await readBody(req, SHOT_MAX) };
      } else {
        const hasBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"] !== undefined;
        if ((mcp || hasBody) && mediaType(req) !== "application/json") throw new HttpError(415, "content type must be application/json");
        // A batch carries up to 30 pins with their element data; one pin stays small.
        const text = (await readBody(req, mcp ? 1024 * 1024 : route?.name === "batches" ? 512 * 1024 : 64 * 1024)).toString("utf8");
        try { body = text || mcp ? JSON.parse(text) : {}; }
        catch {
          if (mcp) return sendJson(res, 400, rpcRefusal(-32700, "Parse error"));
          throw new HttpError(400, "invalid JSON");
        }
        if (!mcp) {
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
          actor = getActor(req);
        } else if (Array.isArray(body) && body.length > 1) {
          // Each request of a JSON-RPC batch can be a write, so each one takes a token. The first one went above.
          if (body.length > writeLimit.capacity) return sendJson(res, 400, rpcRefusal(-32600, `Invalid Request: a batch holds at most ${writeLimit.capacity} requests`));
          const wait = takeToken(body.length - 1);
          if (wait) return limited(wait);
        }
      }
    }
    if (mcp) return await mcpHandler(req, res, body);
    if (stream) return events.open(req, res, query);
    if (route) return serveApi(req, res, { store, version, extension, route, query, body, actor });
    return await files.send(req, res, file);
  }

  const app = (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    dispatch(req, res).catch((error) => {
      const expected = error instanceof HttpError || [400, 403, 409].includes(error?.status);
      if (!expected) console.error(`pins: ${String(error?.message ?? error).replace(/[\r\n]+/g, " ")}`);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      sendJson(res, expected ? error.status : 500, { error: expected ? error.message : "internal error" });
    });
  };
  app.close = events.close;
  return app;
}
