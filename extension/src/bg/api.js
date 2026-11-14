import { API_METHODS, API_PATH_RE, MSG, SETTINGS_METHODS } from "../shared/protocol.js";
import { apiFetch, loggedOut } from "./request.js";

const TIMEOUT_MS = 30000;
// The server has the exact limits (64 KiB, 512 KiB for a batch). These bounds stop a runaway message.
const PATH_MAX = 2048;
const BODY_MAX = 512 * 1024;
// The methods of each path that has no pin id (docs/protocol.md, Routes).
const METHODS = { health: ["GET"], stats: ["GET"], batches: ["POST"], settings: SETTINGS_METHODS, pins: ["GET", "POST"] };

function plainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// The methods that the server takes for a path, or null when the path is not on the list.
function methodsFor(path) {
  const match = typeof path === "string" && path.length <= PATH_MAX && API_PATH_RE.exec(path);
  if (!match) return null;
  const [, name, pin, action] = match;
  return action ? ["POST"] : pin ? ["GET", "PATCH", "DELETE"] : METHODS[name];
}

const refuse = (status, error) => ({ ok: false, status, data: null, error });
const invalid = (error) => refuse(400, error);

export function createAPI({ fetch: fetchRequest = globalThis.fetch, live, timeoutMs = TIMEOUT_MS } = {}) {
  return async function api(message) {
    if (!plainObject(message) || message.t !== MSG.API) return invalid("invalid request");
    if (!API_METHODS.includes(message.method)) return invalid("invalid method");
    const methods = methodsFor(message.path);
    if (!methods) return invalid("invalid path");
    if (!methods.includes(message.method)) return invalid("invalid method");
    const options = { method: message.method, signal: AbortSignal.timeout(timeoutMs) };
    if (message.body !== undefined) {
      // `fetch` refuses a GET with a body; without this check the caller would read "offline".
      if (message.method === "GET" || !plainObject(message.body)) return invalid("invalid body");
      try {
        options.body = JSON.stringify(message.body);
      } catch {
        return invalid("invalid body");
      }
      if (options.body.length > BODY_MAX) return refuse(413, "body too large");
      options.headers = { "Content-Type": "application/json" };
    }

    // Status 0: no answer. "timeout" when the limit ended the request, else "offline". A slow
    // request does not mean that the connection is gone, so the caller must tell them apart.
    const noAnswer = () => refuse(0, options.signal.aborted ? "timeout" : "offline");
    let response;
    try {
      response = await apiFetch(fetchRequest, message.path, options);
    } catch {
      return noAnswer();
    }
    if (loggedOut(response)) {
      live?.requireLogin();
      return refuse(401, "login required");
    }

    let data = null;
    if (response.status !== 204) {
      try { data = await response.json(); } catch { if (options.signal.aborted) return noAnswer(); /* Else an empty or non-JSON response. */ }
    }
    // Every API success except 204 carries JSON; anything else came from the wrong place.
    if (response.ok && response.status !== 204 && data === null) return refuse(502, "unexpected response");
    if (response.ok) live?.apiSucceeded();
    return {
      ok: response.ok,
      status: response.status,
      data,
      ...(!response.ok ? { error: typeof data?.error === "string" ? data.error : `HTTP ${response.status}` } : {}),
    };
  };
}
