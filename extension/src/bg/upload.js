// Post one image. The content script sends base64. This posts the raw bytes.
import { base64ToBytes, imageType } from "../shared/image.js";
import { IMAGE_ID_RE, MSG, SHOT_MAX, SHOT_TYPES } from "../shared/protocol.js";
import { apiFetch, loggedOut } from "./request.js";

const TIMEOUT_MS = 30000;
const fail = (status, error) => ({ ok: false, status, data: null, ...(error ? { error } : {}) });

export function createUpload({ fetch: fetchRequest = globalThis.fetch, live, timeoutMs = TIMEOUT_MS } = {}) {
  return async function upload(message) {
    const bytes = base64ToBytes(message?.data, SHOT_MAX);
    if (message?.t !== MSG.UPLOAD || !SHOT_TYPES.includes(message?.type) || !bytes || imageType(bytes) !== message.type) return fail(400);
    const signal = AbortSignal.timeout(timeoutMs);
    const noAnswer = () => fail(0, signal.aborted ? "timeout" : "offline");
    let response;
    try {
      response = await apiFetch(fetchRequest, "/api/images", { method: "POST", signal, headers: { "Content-Type": message.type }, body: bytes });
    } catch {
      return noAnswer();
    }
    if (loggedOut(response)) {
      live?.requireLogin();
      return fail(401, "login required");
    }
    let data = null;
    try { data = await response.json(); } catch { if (signal.aborted) return noAnswer(); }
    if (response.ok && !IMAGE_ID_RE.test(data?.image?.id ?? "")) return fail(502, "unexpected response");
    if (!response.ok) return fail(response.status, typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
    return { ok: true, status: response.status, data };
  };
}
