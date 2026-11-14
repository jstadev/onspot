import { MSG, STATE } from "../shared/protocol.js";
import { apiFetch, loggedOut } from "./request.js";
import { createSSEParser } from "./sse.js";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const LOGIN_RETRY_MS = 60000;
const IDLE_MS = 30000;
// The server sends a comment every 20 s. No byte during three of them means a dead stream.
const STALL_MS = 60000;
// A stream that stays open this long was a real connection: the next retry starts at 1 s again.
// A stream that ends sooner keeps the backoff, so a stream that opens and breaks cannot make
// one connection and one refetch per tab every second.
const STABLE_MS = 30000;

export function createLive({ fetch: fetchRequest = globalThis.fetch, clock = globalThis } = {}) {
  const ports = new Map();
  let state = STATE.OFFLINE;
  let connection = null;
  let reconnectTimer = null;
  let idleTimer = null;
  let failures = 0;

  function clearReconnect() {
    if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearTimers(current) {
    clock.clearTimeout(current.stall);
    clock.clearTimeout(current.stable);
  }

  function abort(current) {
    current.controller.abort();
    current.reader?.cancel().catch(() => {});
  }

  // Starts the stall timer again. It covers the time until the answer and each wait for bytes.
  function watch(current) {
    clock.clearTimeout(current.stall);
    current.stall = clock.setTimeout(() => abort(current), STALL_MS); // The read ends; `read` connects again.
  }

  function stopConnection() {
    const previous = connection;
    connection = null; // An aborted read must not schedule another connection.
    if (!previous) return;
    clearTimers(previous);
    abort(previous);
  }

  function removePort(port) {
    const listeners = ports.get(port);
    if (!listeners) return;
    port.onMessage.removeListener(listeners.message);
    port.onDisconnect.removeListener(listeners.disconnect);
    ports.delete(port);
    if (ports.size === 0) {
      clearReconnect();
      idleTimer = clock.setTimeout(() => {
        idleTimer = null;
        stopConnection();
        failures = 0;
        setState(STATE.OFFLINE);
      }, IDLE_MS);
    }
  }

  function send(port, message) {
    try { port.postMessage(message); } catch { removePort(port); }
  }

  function broadcast(message) {
    for (const port of ports.keys()) send(port, message);
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    broadcast({ t: MSG.STATE, state });
  }

  function schedule(delay) {
    clearReconnect();
    if (!ports.size) return;
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      start();
    }, delay);
  }

  function requireLogin() {
    stopConnection();
    failures = 0;
    setState(STATE.LOGIN);
    schedule(LOGIN_RETRY_MS);
  }

  function fanOut(event) {
    if (event.event !== MSG.PIN && event.event !== MSG.REPLY && event.event !== MSG.SETTINGS) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    // Settings belong to the server, not to a host: every port gets them.
    if (event.event === MSG.SETTINGS) {
      if (data && typeof data === "object" && !Array.isArray(data)) broadcast({ t: MSG.SETTINGS, settings: data });
      return;
    }
    if (typeof data?.pin?.host !== "string") return;
    let message;
    if (event.event === MSG.PIN) {
      if (!["created", "updated", "deleted"].includes(data.action)) return;
      message = { t: MSG.PIN, action: data.action, pin: data.pin };
    } else {
      if (!data.reply || typeof data.reply !== "object" || Array.isArray(data.reply)) return;
      message = { t: MSG.REPLY, pin: data.pin, reply: data.reply };
    }
    for (const [port, subscription] of ports) {
      if (subscription.host === data.pin.host) send(port, message);
    }
  }

  async function read(current) {
    try {
      watch(current);
      const response = await apiFetch(fetchRequest, "/api/events", { signal: current.controller.signal });
      if (connection !== current) {
        await response.body?.cancel();
        return;
      }
      if (loggedOut(response)) {
        requireLogin();
        await response.body?.cancel();
        return;
      }
      if (!response.ok || !response.body ||
          !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get("content-type") || "")) {
        await response.body?.cancel();
        throw new Error("Stream unavailable");
      }
      current.reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSSEParser();
      current.stable = clock.setTimeout(() => { failures = 0; }, STABLE_MS);
      broadcast({ t: MSG.RESYNC });
      setState(STATE.LIVE);
      while (connection === current) {
        const { done, value } = await current.reader.read();
        if (connection !== current) break;
        if (done) {
          for (const event of parser.feed(decoder.decode())) fanOut(event);
          break;
        }
        watch(current);
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) fanOut(event);
      }
    } catch {
      // Fetch failures, read failures, an event over the size limit and EOF all use the same reconnect policy.
    } finally {
      clearTimers(current);
      abort(current); // An error inside the loop leaves the stream open; close it.
      current.reader?.releaseLock();
      if (connection === current) {
        connection = null;
        if (state === STATE.LOGIN) schedule(LOGIN_RETRY_MS);
        else {
          setState(STATE.OFFLINE);
          schedule(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]);
        }
      }
    }
  }

  function start() {
    if (connection || !ports.size) return;
    clearReconnect();
    const current = { controller: new AbortController(), reader: null, stall: null, stable: null };
    connection = current;
    if (state !== STATE.LOGIN) setState(STATE.CONNECTING);
    void read(current);
  }

  return {
    getState: () => state,
    requireLogin,
    apiSucceeded() {
      if (state !== STATE.LOGIN) return;
      clearReconnect();
      stopConnection();
      failures = 0;
      setState(ports.size ? STATE.CONNECTING : STATE.OFFLINE);
      start();
    },
    addPort(port) {
      if (ports.has(port)) return;
      if (idleTimer !== null) clock.clearTimeout(idleTimer);
      idleTimer = null;
      const subscription = {
        host: null,
        message(message) {
          if (message?.t === MSG.SUB) subscription.host = typeof message.host === "string" ? message.host : null;
          // Pings need no response or stored state. Receiving them keeps MV3 awake.
          else if (message?.t === MSG.PING) return;
        },
        disconnect: () => removePort(port),
      };
      ports.set(port, subscription);
      port.onMessage.addListener(subscription.message);
      port.onDisconnect.addListener(subscription.disconnect);
      send(port, { t: MSG.STATE, state });
      if (reconnectTimer === null) start();
    },
    dispose() {
      for (const [port, listeners] of ports) {
        port.onMessage.removeListener(listeners.message);
        port.onDisconnect.removeListener(listeners.disconnect);
      }
      ports.clear();
      if (idleTimer !== null) clock.clearTimeout(idleTimer);
      idleTimer = null;
      clearReconnect();
      stopConnection();
      state = STATE.OFFLINE;
    },
  };
}
