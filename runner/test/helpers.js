import assert from "node:assert/strict";
import { createRunner } from "../src/runner.js";
import { buildPrompt } from "../src/prompt.js";

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export class FakeClock {
  time;
  timers = new Map();
  serial = 0;
  constructor(time = Date.parse("2026-10-17T12:00:00Z")) { this.time = time; }
  now = () => this.time;
  setTimeout = (fn, delay) => {
    const id = ++this.serial;
    this.timers.set(id, { fn, at: this.time + delay });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  async tick(ms) {
    const end = this.time + ms;
    await flush();
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

export function harness(t, { clock = new FakeClock(), config = {}, resolveProject, initial = [], autofix = true, bulk, account = "claude", brief, shoot } = {}) {
  const pins = new Map(initial.map((pin) => [pin.id, structuredClone(pin)]));
  const requests = [], delegates = [], checks = [], logs = [], streams = [], tasks = new Map(), order = [];
  let intercept, onDelegate, serial = 100;
  // The whole settings object, as the server sends it; without bulk it is an older server.
  const settings = () => (bulk ? { autofix, bulk } : { autofix });
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const emit = (type, data) => {
    for (const stream of streams) if (!stream.closed) stream.controller.enqueue(new TextEncoder().encode(`event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`));
  };
  const fetch = async (raw, options = {}) => {
    const url = new URL(raw), method = options.method || "GET";
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "4750");
    const body = options.body ? JSON.parse(options.body) : undefined;
    const request = { path: url.pathname, query: url.searchParams, method, body, at: clock.now(), options };
    requests.push(request);
    order.push(`${method} ${url.pathname}`);
    if (intercept) {
      const result = await intercept(request);
      if (result) return result;
    }
    if (url.pathname === "/api/events") {
      const stream = { closed: false };
      const body = new ReadableStream({
        start(controller) { stream.controller = controller; },
        cancel() { stream.closed = true; },
      });
      stream.close = () => { if (!stream.closed) { stream.closed = true; stream.controller.close(); } };
      streams.push(stream);
      options.signal.addEventListener("abort", stream.close, { once: true });
      if (options.signal.aborted) stream.close();
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname === "/api/settings") return response(settings());
    if (url.pathname === "/api/pins") {
      const status = url.searchParams.get("status"), before = Number(url.searchParams.get("before")) || Infinity;
      const batch = Number(url.searchParams.get("batch")) || null;
      const host = url.searchParams.get("host"), selector = url.searchParams.get("selector");
      return response({ pins: [...pins.values()].filter((pin) => (status === "all" || status.split(",").includes(pin.status)) && pin.id < before && (!batch || pin.batch === batch)
        && (!host || pin.host === host) && (!selector || pin.targets?.[0]?.selector === selector))
        .sort((a, b) => b.id - a.id).slice(0, Number(url.searchParams.get("limit"))) });
    }
    const match = /^\/api\/pins\/(\d+)(?:\/(start|ask|replies|reopen))?$/.exec(url.pathname);
    assert.ok(match, `unexpected request ${raw}`);
    const pin = pins.get(Number(match[1]));
    if (!pin) return response({ error: "pin not found" }, 404);
    if (method === "GET") return response({ pin, replies: [] });
    assert.equal(new Headers(options.headers).get("x-pins-agent"), "claude");
    assert.equal(new Headers(options.headers).get("content-type"), "application/json");
    if (match[2] === "start") {
      if (pin.status !== "queued") return response({ error: "conflict" }, 409);
      Object.assign(pin, { status: "working", run: body.run, model: body.model ?? null, attempts: (pin.attempts || 0) + 1, agent: "claude", startedAt: new Date(clock.now()).toISOString() });
    } else if (match[2] === "replies") {
      Object.assign(pin, { replyCount: pin.replyCount + 1, lastReply: body.body });
    } else if (match[2] === "reopen") {
      if (!["working", "waiting", "done", "dismissed"].includes(pin.status)) return response({ error: "conflict" }, 409);
      Object.assign(pin, { status: "queued", run: null, agent: null, startedAt: null });
    } else {
      if (!["queued", "working"].includes(pin.status)) return response({ error: "conflict" }, 409);
      Object.assign(pin, { status: "waiting", replyCount: pin.replyCount + 1, question: body.question });
    }
    pin.updatedAt = new Date(clock.now()).toISOString();
    emit("pin", { action: "updated", pin });
    return response({ pin });
  };
  const triad = {
    account,
    async delegate(body) {
      order.push("delegate");
      delegates.push({ body, at: clock.now() });
      if (onDelegate) return onDelegate(body);
      const id = String(++serial);
      tasks.set(id, { status: "running", exitCode: null, lastLine: "" });
      return id;
    },
    async task(id) {
      checks.push({ id, at: clock.now() });
      if (!tasks.has(id)) throw new Error(`unknown task ${id}`);
      // An Error stands for a failed call (for example HTTP 404: Triad does not know the task).
      if (tasks.get(id) instanceof Error) throw tasks.get(id);
      return tasks.get(id);
    },
  };
  const defaultResolver = async (host) => ({ name: host.split(".")[0], dir: "/tmp/project", candidates: [host.split(".")[0]] });
  const runner = createRunner({ fetch, clock, triad, resolveProject: resolveProject || defaultResolver, buildPrompt, brief, shoot,
    config: { log: (line) => logs.push(line), ...config } });
  t.after(() => runner.stop());
  return {
    runner, clock, pins, requests, delegates, tasks, checks, logs, streams, order, response, emit,
    intercept: (fn) => { intercept = fn; }, onDelegate: (fn) => { onDelegate = fn; },
    setAutofix(value, event = true) { autofix = value; if (event) emit("settings", settings()); },
    setBulk(value, event = true) { bulk = value; if (event) emit("settings", settings()); },
    add(id, host = "one.koglabs.com", extra = {}, event = true) {
      const pin = makePin(id, clock.now(), { host, ...extra });
      pins.set(id, pin);
      if (event) emit("pin", { action: "created", pin });
      return pin;
    },
    async start() { await runner.start(); await flush(); await runner.idle(); },
    // Lets every event that is already sent reach the runner. The clock does not move.
    async settle() { for (let i = 0; i < 6; i++) { await clock.tick(0); await runner.idle(); } },
  };
}

export function makePin(id, now, extra = {}) {
  const host = extra.host || "one.koglabs.com", path = extra.path || "/";
  const date = new Date(now).toISOString();
  return { id, status: "queued", host, path, url: `https://${host}${path}`, note: "Private pin note",
    replyCount: 0, reopens: 0, run: null, batch: null, model: null, attempts: 0, startedAt: null, createdAt: date, updatedAt: date, ...extra };
}
