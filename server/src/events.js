import { sendJson } from "./http.js";

// A client that does not read is dropped when more than this many bytes of earlier turns wait for it. It loses
// nothing: there is no replay, so a client that connects again fetches the list. The bytes of the current turn of
// the event loop do not count: one MCP batch writes all its events (some MiB) before the socket can send one
// byte, also to a client that reads. So a stalled client holds at most this limit plus the events of one turn.
export const SSE_BUFFER_MAX = 1024 * 1024;

let nextId = 0;
const frame = (event, data) => `id: ${++nextId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createEvents({ store, heartbeatMs = 20000 }) {
  const clients = new Map();
  let timer;
  let closed = false;
  // The number of the current turn. It goes up one time after each turn that wrote to a stream.
  let turn = 0;
  let turnEnds = false;
  const send = (res, client, chunk) => {
    if (client.turn !== turn) Object.assign(client, { turn, written: 0 });
    const waiting = res.writableLength;
    if (waiting - client.written > SSE_BUFFER_MAX) {
      console.error("pins: closed an event stream that did not read");
      client.cleanup();
      return res.destroy();
    }
    res.write(chunk);
    client.written += res.writableLength - waiting;
    if (turnEnds) return;
    turnEnds = true;
    setImmediate(() => {
      turn++;
      turnEnds = false;
    });
  };
  const onChange = (event) => {
    const data = event.type === "settings" ? event.settings
      : event.type === "pin" ? { action: event.action, pin: event.pin } : { pin: event.pin, reply: event.reply };
    const message = frame(event.type, data);
    for (const [res, client] of clients) {
      if (event.type === "settings" || !client.host || client.host === event.pin.host) send(res, client, message);
    }
  };
  store.on("change", onChange);

  function open(req, res, query) {
    if (closed || clients.size >= 100) return sendJson(res, 503, { error: "event streams unavailable" });
    const cleanup = () => {
      clients.delete(res);
      res.off("close", cleanup);
      res.off("error", cleanup);
      if (!clients.size) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    clients.set(res, { host: query.get("host")?.toLowerCase(), cleanup });
    res.once("close", cleanup);
    res.once("error", cleanup);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(`retry: 3000\n${frame("ready", { at: new Date().toISOString() })}`);
    if (!timer) {
      timer = setInterval(() => {
        for (const [res, client] of clients) send(res, client, ": hb\n\n");
      }, heartbeatMs);
      timer.unref();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    store.off("change", onChange);
    for (const [res, { cleanup }] of clients) {
      cleanup();
      res.end();
    }
    clearInterval(timer);
  }

  return { open, close };
}
