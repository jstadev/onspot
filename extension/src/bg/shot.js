import { MSG, PIN_ID_RE, SHOT_KINDS, SHOT_MAX, SHOT_TYPES } from "../shared/protocol.js";
import { apiFetch, loggedOut } from "./request.js";

const TIMEOUT_MS = 30000;
const refuse = (status) => ({ ok: false, status });

// `apply` on 8 KiB parts: 13 ms for 2 MiB. The spread form on 32 KiB parts took 104 ms.
function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x2000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(text);
}

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

// One before/after image of a pin, as base64. The content script draws it into a canvas, so
// no image URL reaches the page and the page CSP cannot block it.
export function createShot({ fetch: fetchRequest = globalThis.fetch, live, timeoutMs = TIMEOUT_MS } = {}) {
  return async function shot(message) {
    const id = message?.id;
    if (message?.t !== MSG.SHOT || !["number", "string"].includes(typeof id) || !PIN_ID_RE.test(String(id)) || !SHOT_KINDS.includes(message.kind)) return refuse(400);
    let response;
    try {
      response = await apiFetch(fetchRequest, `/api/pins/${id}/shots/${message.kind}`, { signal: AbortSignal.timeout(timeoutMs) });
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
    return bytes ? { ok: true, status: 200, type, data: base64(bytes) } : refuse(413);
  };
}
