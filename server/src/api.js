import { isUtf8 } from "node:buffer";
import { parseStatuses } from "./store.js";
import { HttpError, parseId, sendJson } from "./http.js";
import { IMAGE_ID_RE } from "./shots.js";

export function apiRoute(path) {
  if (path === "/api/health") return { name: "health", methods: ["GET"] };
  if (path === "/api/stats") return { name: "stats", methods: ["GET"] };
  if (path === "/api/settings") return { name: "settings", methods: ["GET", "PATCH"] };
  if (path === "/api/pins") return { name: "pins", methods: ["GET", "POST"] };
  if (path === "/api/batches") return { name: "batches", methods: ["POST"] };
  if (path === "/api/images") return { name: "images", methods: ["POST"] };
  const image = /^\/api\/images\/([^/]+)$/.exec(path);
  if (image) return IMAGE_ID_RE.test(image[1]) ? { name: "image", imageId: image[1], methods: ["GET"] } : null;
  const match = /^\/api\/pins\/([^/]+)(?:\/(start|resolve|dismiss|ask|reopen|accept|revert|replies|progress|shots\/(before|after)))?$/.exec(path);
  const id = match && parseId(match[1]);
  if (!id) return null;
  if (match[3]) return { name: "shot", id, kind: match[3], methods: ["GET", "PUT"] };
  return { name: match[2] || "pin", id, methods: match[2] ? ["POST"] : ["GET", "PATCH", "DELETE"] };
}

// A header value arrives as latin1 text: one character per byte. A name is UTF-8 when its bytes are valid UTF-8
// ("Γιάννης"); other bytes stay as they came.
function headerText(value) {
  const bytes = Buffer.from(value, "latin1");
  return isUtf8(bytes) ? bytes.toString("utf8") : value;
}

export function getActor(req) {
  const agent = req.headers["x-pins-agent"];
  const kind = agent === undefined ? "user" : "agent";
  const name = headerText(agent ?? req.headers["x-sso-user"] ?? "user").trim();
  // The HTTP parser lets a tab and the bytes 0x80 to 0x9F through. The name is shown in terminals and pages.
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new HttpError(400, "actor name must be 1 to 60 characters, with no control character");
  }
  return { kind, name };
}

function listOptions(query) {
  const limit = query.has("limit") ? Number(query.get("limit")) : 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new HttpError(400, "limit must be an integer from 1 to 500");
  }
  const before = query.has("before") ? parseId(query.get("before")) : undefined;
  if (before === null) throw new HttpError(400, "before must be a pin id");
  const batch = query.has("batch") ? parseId(query.get("batch")) : undefined;
  if (batch === null) throw new HttpError(400, "batch must be a batch id");
  const selector = query.get("selector");
  if (selector?.length > 500) throw new HttpError(400, "selector is longer than 500 characters");
  return { statuses: parseStatuses(query.get("status")), host: query.get("host"), path: query.get("path"), q: query.get("q"), limit, before, batch, selector };
}

// The bytes are an image from a page or his clipboard; the headers stop a browser from treating them as anything else.
function sendImage(res, image, missing) {
  if (!image) throw new HttpError(404, missing);
  res.writeHead(200, {
    "Content-Type": image.type,
    "Content-Length": image.bytes.length,
    "Cache-Control": "private, no-cache",
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  return res.end(image.bytes);
}

function found(value) {
  if (!value) throw new HttpError(404, "pin not found");
  return value;
}

export function serveApi(req, res, { store, version, extension, route, query, body, actor }) {
  const { name, id } = route;
  if (name === "health") {
    const { queued, working, waiting } = store.stats().total;
    return sendJson(res, 200, { ok: true, version, extension, open: { queued, working, waiting } });
  }
  if (name === "batches") {
    const result = store.createBatch({ pins: body.pins, key: body.key, author: actor.name });
    return sendJson(res, result.created ? 201 : 200, { batch: result.batch, pins: result.pins });
  }
  if (name === "stats") return sendJson(res, 200, store.stats());
  if (name === "settings") return sendJson(res, 200, req.method === "GET" ? store.getSettings() : store.setSettings(body));
  if (name === "pins") {
    if (req.method === "GET") return sendJson(res, 200, { pins: store.listPins(listOptions(query)) });
    return sendJson(res, 201, { pin: store.createPin({ ...body, author: actor.name }) });
  }
  if (name === "pin") {
    if (req.method === "GET") return sendJson(res, 200, { pin: found(store.getPin(id)), replies: store.listReplies(id), steps: store.listSteps(id) });
    if (req.method === "PATCH") return sendJson(res, 200, { pin: found(store.updateNote(id, body.note)) });
    found(store.deletePin(id));
    res.writeHead(204);
    return res.end();
  }
  if (name === "progress") {
    if (actor.kind !== "agent") throw new HttpError(403, "only an agent can post progress");
    return sendJson(res, 201, found(store.addStep(id, { author: actor.name, body: body.text })));
  }
  if (name === "shot") {
    if (req.method === "PUT") return sendJson(res, 200, { pin: found(store.setShot(id, route.kind, body)) });
    return sendImage(res, store.getShot(id, route.kind), "shot not found");
  }
  if (name === "images") return sendJson(res, 201, { image: store.addImage({ ...body, author: actor.name }) });
  if (name === "image") return sendImage(res, store.getImage(route.imageId), "image not found");
  if (name === "replies") {
    if (body.reopen !== undefined && typeof body.reopen !== "boolean") throw new HttpError(400, "reopen must be true or false");
    const reply = found(store.addReply(id, { kind: actor.kind, author: actor.name, body: body.body, reopen: body.reopen === true, images: body.images }));
    return sendJson(res, 201, { reply, pin: store.getPin(id) });
  }
  const pin = found(store.transition(id, name, {
    agent: actor.kind === "agent" ? actor.name : null,
    kind: actor.kind,
    author: actor.name,
    summary: body.summary,
    commit: body.commit,
    reason: body.reason,
    question: body.question,
    run: body.run,
    model: body.model,
  }));
  return sendJson(res, 200, { pin });
}
