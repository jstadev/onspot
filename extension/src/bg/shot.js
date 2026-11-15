import { bytesToBase64 } from "../shared/image.js";
import { IMAGE_ID_RE, MSG, PIN_ID_RE, SHOT_KINDS, SHOT_MAX, SHOT_TYPES } from "../shared/protocol.js";
import { apiFetch, loggedOut } from "./request.js";

const TIMEOUT_MS = 30000;
const refuse = (status) => ({ ok: false, status });

// The body, or null when it is longer than `max`. It stops at the limit, so a response
// without a true Content-Length cannot fill the memory.
async function readUpTo(body, max) {
  const parts = [];
  let size = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// One image from the API, as base64. The content script draws it into a canvas, so no image
// URL reaches the page and the page CSP cannot block it. Shots and pin images share this reader.
async function readImage(fetchRequest, path, live, timeoutMs) {
  let response;
  try {
    response = await apiFetch(fetchRequest, path, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return refuse(0);
  }
  if (loggedOut(response)) {
    live?.requireLogin();
    return refuse(401);
  }
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const status = !response.ok ? response.status : !SHOT_TYPES.includes(type) ? 415 : Number(response.headers.get("content-length")) > SHOT_MAX ? 413 : 0;
  if (status) {
    response.body?.cancel().catch(() => {});
    return refuse(status);
  }
  let bytes;
  try { bytes = await readUpTo(response.body, SHOT_MAX); } catch { return refuse(0); }
  return bytes ? { ok: true, status: 200, type, data: bytesToBase64(bytes) } : refuse(413);
}

function createReader(allow, { fetch: fetchRequest = globalThis.fetch, live, timeoutMs = TIMEOUT_MS } = {}) {
  return function read(message) {
    const path = allow(message);
    return path ? readImage(fetchRequest, path, live, timeoutMs) : Promise.resolve(refuse(400));
  };
}

export function createShot(options) {
  return createReader((message) => {
    const id = message?.id;
    if (message?.t !== MSG.SHOT || !["number", "string"].includes(typeof id) || !PIN_ID_RE.test(String(id)) || !SHOT_KINDS.includes(message.kind)) return "";
    return `/api/pins/${id}/shots/${message.kind}`;
  }, options);
}

export function createImage(options) {
  return createReader((message) => {
    if (message?.t !== MSG.IMAGE || typeof message.id !== "string" || !IMAGE_ID_RE.test(message.id)) return "";
    return `/api/images/${message.id}`;
  }, options);
}
