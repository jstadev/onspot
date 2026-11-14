import { ID_RE } from "./id.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

/** The request body as a Buffer; 413 beyond `limit` bytes. */
export function readBody(req, limit) {
  if (Number(req.headers["content-length"]) > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, "body too large"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      if (error) {
        req.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) finish(new HttpError(413, "body too large"));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error) => finish(error);
    const onAbort = () => finish(new HttpError(400, "request aborted"));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAbort);
  });
}

// take(count) returns zero when it took the tokens, otherwise the seconds until that many are there.
export function tokenBucket({ capacity, perMs }) {
  if (!(capacity >= 1) || !Number.isFinite(capacity) || !(perMs > 0) || !Number.isFinite(perMs)) {
    throw new TypeError("invalid write limit");
  }
  let tokens = capacity;
  let last = performance.now();
  return (count = 1) => {
    const now = performance.now();
    tokens = Math.min(capacity, tokens + (now - last) * capacity / perMs);
    last = now;
    if (tokens < count) return Math.max(1, Math.ceil((count - tokens) * perMs / capacity / 1000));
    tokens -= count;
    return 0;
  };
}

export const parseId = (value) => ID_RE.test(value ?? "") ? Number(value) : null;

export function allowMethod(req, res, methods) {
  if (methods.includes(req.method)) return;
  res.setHeader("Allow", methods.join(", "));
  throw new HttpError(405, "method not allowed");
}
