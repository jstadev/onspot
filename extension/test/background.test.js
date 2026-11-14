import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setImmediate as settle } from "node:timers/promises";
import { createAPI } from "../src/bg/api.js";
import { createLive } from "../src/bg/live.js";
import { createShot } from "../src/bg/shot.js";
import { API, API_PATH_RE, MSG, STATE } from "../src/shared/protocol.js";

const request = (overrides = {}) => ({ t: MSG.API, method: "GET", path: "/api/health", ...overrides });
const shotRequest = (overrides = {}) => ({ t: MSG.SHOT, id: 12, kind: "before", ...overrides });
const image = (bytes, type = "image/png", length) => new Response(bytes, { headers: { "Content-Type": type, ...(length ? { "Content-Length": String(length) } : {}) } });
const MIB2 = 2 * 1024 * 1024;
const encode = (text) => new TextEncoder().encode(text);
// What `fetch` gives for a redirect that it does not follow (`redirect: "manual"`).
const redirect = () => ({ type: "opaqueredirect", ok: false, status: 0, redirected: false, url: "", headers: new Headers(), body: null });
// A request that never gets an answer: it ends only when its signal aborts.
const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
// Node does not stay alive for the timer of AbortSignal.timeout; a plain timer keeps the test running.
async function alive(promise) {
  const timer = setTimeout(() => {}, 5000);
  try { return await promise; } finally { clearTimeout(timer); }
}
// One fetch call without its signal. Every request carries one (a timeout, or the stream's abort).
const sent = ([url, { signal, ...options }]) => {
  assert.ok(signal instanceof AbortSignal, "the request has a signal");
  return [url, options];
};
const COOKIE_NO_REDIRECT = { credentials: "include", redirect: "manual" };

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      const id = ++sequence;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    delays() { return [...pending.values()].map(({ at }) => at - now).sort((a, b) => a - b); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function eventTarget() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); },
    listeners,
  };
}

function port() {
  return {
    onMessage: eventTarget(), onDisconnect: eventTarget(), messages: [],
    postMessage(message) { this.messages.push(message); },
    sub(host) { this.onMessage.emit({ t: MSG.SUB, host }); },
    disconnect() { this.onDisconnect.emit(); },
  };
}

function upstream() {
  let writer;
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { writer = controller; }, cancel() { cancelled = true; } });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
    bytes: (value) => writer.enqueue(value),
    event(name, data) { writer.enqueue(new TextEncoder().encode(`event: ${name}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`)); },
    end: () => writer.close(),
    fail: () => writer.error(new Error("lost connection")),
    get cancelled() { return cancelled; },
  };
}

function harness(t, fetchRequest) {
  const clock = fakeClock();
  const calls = [];
  const live = createLive({ clock, fetch: async (...args) => {
    calls.push(args);
    return fetchRequest(...args);
  } });
  t.after(() => live.dispose());
  return { clock, calls, live };
}

test("API rejects bad messages, paths, methods, and non-object bodies before fetch", async () => {
  let count = 0;
  const api = createAPI({ fetch: () => { count++; throw new Error("must not fetch"); } });
  const cyclic = {}; cyclic.self = cyclic;
  const bad = [null, [], {}, request({ t: "other" }), ...["PUT", "HEAD", "get", null].map((method) => request({ method })),
    ...["https://evil.example/api/pins", "//evil.example/api/pins", "/api/events", "/api/pins/../health", "/api/pins/0",
      "/api/pins/1000000000000", "/api/health#fragment", "/api/pins/1/unknown", "/api/batches/1", "/api/batchesx", null].map((path) => request({ path })),
    ...[null, [], "text", 7, true, new Date(), cyclic].map((body) => request({ method: "POST", path: "/api/batches", body }))];
  for (const message of bad) {
    const result = await api(message);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.data, null);
    assert.equal(typeof result.error, "string");
  }
  assert.equal(count, 0);
});

test("API refuses path tricks, a path over 2048 characters, a GET with a body and a body over 512 KiB before fetch", async () => {
  let count = 0;
  const api = createAPI({ fetch: () => { count++; throw new Error("must not fetch"); } });
  const tricks = ["/api/pins/%2e%2e/health", "/api/pins/12/%2e%2e/13", "/api//pins", "//api/pins", "/api/pins/12/../13", "/api/pins/12/./accept", "/api/pins/",
    "/api/pins/12/", "/api/pins;x", "/API/pins", "\\api\\pins", "/api/pins\n", "/api/pins/12/accept\n", "/api/pins\u0000", " /api/pins", "/api/pins ", "/api/pins/١٢",
    "/api/pins/12?x=1#frag", "/api/health/../pins", "/api/pins/12/accept?x=1/../../mcp#", `/api/pins?q=${"x".repeat(2048)}`];
  for (const path of tricks) assert.deepEqual(await api(request({ path })), { ok: false, status: 400, data: null, error: "invalid path" }, JSON.stringify(path));
  // A query cannot change the route: the path before "?" is the whole route.
  assert.equal(API_PATH_RE.test("/api/pins?x=/../../mcp"), true);
  assert.deepEqual(await api(request({ body: {} })), { ok: false, status: 400, data: null, error: "invalid body" });
  assert.deepEqual(await api(request({ method: "POST", path: "/api/batches", body: { pins: ["x".repeat(512 * 1024)] } })),
    { ok: false, status: 413, data: null, error: "body too large" });
  assert.equal(count, 0);
});

test("API takes each path only with the methods of its route", async () => {
  const calls = [];
  const api = createAPI({ fetch: async (url, options) => { calls.push(`${options.method} ${url.slice(API.length)}`); return Response.json({}); } });
  const routes = {
    "/api/health": ["GET"], "/api/stats": ["GET"], "/api/batches": ["POST"], "/api/settings": ["GET", "PATCH"], "/api/pins": ["GET", "POST"],
    "/api/pins/12": ["GET", "PATCH", "DELETE"], "/api/pins/12/replies": ["POST"], "/api/pins/12/accept?x=1": ["POST"], "/api/pins?host=a.koglabs.com": ["GET", "POST"],
  };
  const expected = [];
  for (const [path, methods] of Object.entries(routes)) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const result = await api(request({ method, path }));
      if (methods.includes(method)) expected.push(`${method} ${path}`);
      else assert.deepEqual(result, { ok: false, status: 400, data: null, error: "invalid method" }, `${method} ${path}`);
    }
  }
  assert.deepEqual(calls, expected);
});

test("the path allowlist holds what the content script calls and nothing that only an agent may call", async () => {
  const allowed = ["/api/health", "/api/pins", "/api/pins?host=a.koglabs.com&status=all&limit=50", "/api/pins/12", "/api/batches",
    "/api/pins/12/dismiss", "/api/pins/12/reopen", "/api/pins/12/replies", "/api/pins/12/accept", "/api/settings"];
  const refused = ["/api/pins/12/shots/before", "/api/pins/12/shots/after", "/api/pins/12/progress", "/api/pins/12/ask", "/api/settings/bulk",
    "/api/settingsx", "/api/pins/12/accept/1", "/api/pins/0/accept", "/api/events", "/mcp", "/download/onspot-chrome.zip", "/api/pins/12/replies/3", "/api/pins/12?x#y", "/pins/api/health"];
  for (const path of allowed) assert.equal(API_PATH_RE.test(path), true, path);
  let count = 0;
  const api = createAPI({ fetch: () => { count++; throw new Error("must not fetch"); } });
  for (const path of refused) {
    assert.equal(API_PATH_RE.test(path), false, path);
    assert.deepEqual(await api(request({ path })), { ok: false, status: 400, data: null, error: "invalid path" });
  }
  assert.equal(count, 0);
});

test("API forwards accept as POST and settings as GET and PATCH only", async () => {
  const calls = [];
  const api = createAPI({ fetch: async (...args) => { calls.push(args); return Response.json({ autofix: true, bulk: { on: true, delegate: false, agents: 3 } }); } });
  for (const [method, path, body] of [["POST", "/api/pins/12/accept", {}], ["GET", "/api/settings"], ["PATCH", "/api/settings", { bulk: { agents: 4 } }]]) {
    assert.equal((await api(request({ method, path, body }))).ok, true, `${method} ${path}`);
    assert.deepEqual(sent(calls.at(-1)), [API + path, { method, ...COOKIE_NO_REDIRECT,
      ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }]);
  }
  const count = calls.length;
  for (const method of ["DELETE", "POST"]) {
    assert.deepEqual(await api(request({ method, path: "/api/settings", body: {} })), { ok: false, status: 400, data: null, error: "invalid method" });
    assert.deepEqual(await api(request({ method, path: "/api/settings?x=1", body: {} })), { ok: false, status: 400, data: null, error: "invalid method" });
  }
  assert.equal(calls.length, count);
});

test("shot refuses a bad message, id or kind before fetch", async () => {
  let count = 0;
  const shot = createShot({ fetch: () => { count++; throw new Error("must not fetch"); } });
  const bad = [null, [], {}, shotRequest({ t: MSG.API }),
    ...[0, -1, 1.5, 1e21, "01", "12/../13", "12?x=1", "12#", " 12", "1000000000000", "", null, undefined, true, [12], { id: 12 }].map((id) => shotRequest({ id })),
    ...["during", "Before", "before/..", "", null, undefined, ["before"]].map((kind) => shotRequest({ kind }))];
  for (const message of bad) assert.deepEqual(await shot(message), { ok: false, status: 400 }, JSON.stringify(message));
  assert.equal(count, 0);
});

test("shot fetches one image with credentials and returns its type and bytes as base64", async () => {
  const calls = [];
  const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251); // more than one 32 KiB chunk
  const shot = createShot({ fetch: async (...args) => { calls.push(args); return image(bytes, "Image/PNG; charset=binary"); } });
  const result = await shot(shotRequest({ id: "12", kind: "after" }));
  assert.deepEqual(calls.map(sent), [[API + "/api/pins/12/shots/after", COOKIE_NO_REDIRECT]]);
  assert.deepEqual({ ...result, data: null }, { ok: true, status: 200, type: "image/png", data: null });
  assert.deepEqual(new Uint8Array(Buffer.from(result.data, "base64")), bytes);
  for (const type of ["image/jpeg", "image/webp"]) assert.equal((await createShot({ fetch: async () => image(bytes, type) })(shotRequest())).type, type);
  assert.equal((await createShot({ fetch: async () => image(new Uint8Array(MIB2)) })(shotRequest())).ok, true, "exactly 2 MiB passes");
});

test("shot refuses a wrong type, a file over 2 MiB, a missing image, a lost session and a network failure", async () => {
  let login = 0;
  const live = { requireLogin: () => login++ };
  const cases = [
    [image("<svg/>", "image/svg+xml"), 415],
    [image("<html>", "text/html"), 415],
    [new Response(new Uint8Array(4)), 415],
    [image(new Uint8Array(MIB2 + 1)), 413],
    [image(new Uint8Array(4), "image/png", MIB2 + 1), 413],
    [Response.json({ error: "Not found" }, { status: 404 }), 404],
    [new Response(null, { status: 401 }), 401],
    [redirect(), 401],
  ];
  for (const [response, status] of cases) assert.deepEqual(await createShot({ fetch: async () => response, live })(shotRequest()), { ok: false, status });
  assert.equal(login, 2);
  assert.deepEqual(await createShot({ fetch: async () => { throw new Error("network"); }, live })(shotRequest()), { ok: false, status: 0 });
  assert.deepEqual(await alive(createShot({ fetch: hang, live, timeoutMs: 20 })(shotRequest())), { ok: false, status: 0 }, "no answer in time");
  assert.equal(login, 2);
});

test("shot stops reading at 2 MiB when the response has no true length", async () => {
  let pulled = 0, cancelled = false;
  const endless = () => new Response(new ReadableStream({
    pull(controller) { pulled += 65536; controller.enqueue(new Uint8Array(65536)); if (pulled >= 64 * MIB2) controller.close(); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "image/png" } });
  assert.deepEqual(await createShot({ fetch: async () => endless() })(shotRequest()), { ok: false, status: 413 });
  assert.equal(cancelled, true);
  assert.ok(pulled <= MIB2 + 4 * 65536, `read ${pulled} bytes of a 128 MiB body`);
});

test("API forwards only the allowed endpoint, credentials, method, and JSON body", async () => {
  const calls = [];
  const api = createAPI({ fetch: async (...args) => { calls.push(args); return Response.json({ pins: [] }); } });
  assert.deepEqual(await api(request({ path: "/api/pins?host=crete.koglabs.com&status=open" })), { ok: true, status: 200, data: { pins: [] } });
  assert.deepEqual(sent(calls[0]), [API + "/api/pins?host=crete.koglabs.com&status=open", { method: "GET", ...COOKIE_NO_REDIRECT }]);
  for (const [method, path, body] of [["POST", "/api/pins/12/replies", { body: "Καλημέρα", reopen: true }], ["POST", "/api/batches", { key: "b-12345678", pins: [] }], ["PATCH", "/api/pins/12", { note: "Edit" }], ["DELETE", "/api/pins/12", {}]]) {
    await api(request({ method, path, body }));
    assert.deepEqual(sent(calls.at(-1)), [API + path, { method, ...COOKIE_NO_REDIRECT, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }]);
  }
  await api(request({ method: "POST", path: "/api/pins/12/reopen", body: Object.create(null) }));
  assert.equal(calls.at(-1)[1].body, "{}");
});

test("API maps JSON, 204, non-JSON, errors, 401, offline and timeout responses", async () => {
  let login = 0;
  let success = 0;
  const live = { requireLogin: () => login++, apiSucceeded: () => success++ };
  const cases = [
    [Response.json({ pin: { id: 1 } }, { status: 201 }), { ok: true, status: 201, data: { pin: { id: 1 } } }],
    [new Response(null, { status: 204 }), { ok: true, status: 204, data: null }],
    [new Response("not JSON"), { ok: false, status: 502, data: null, error: "unexpected response" }],
    [redirect(), { ok: false, status: 401, data: null, error: "login required" }],
    [Response.json({ error: "Log in" }, { status: 401 }), { ok: false, status: 401, data: null, error: "login required" }],
    [Response.json({ error: "Conflict" }, { status: 409 }), { ok: false, status: 409, data: { error: "Conflict" }, error: "Conflict" }],
    [new Response("proxy unavailable", { status: 502 }), { ok: false, status: 502, data: null, error: "HTTP 502" }],
  ];
  for (const [response, expected] of cases) assert.deepEqual(await createAPI({ fetch: async () => response, live })(request()), expected);
  assert.equal(login, 2);
  assert.equal(success, 2);
  const offline = { ok: false, status: 0, data: null, error: "offline" };
  assert.deepEqual(await createAPI({ fetch: async () => { throw new Error("network"); }, live })(request()), offline);
  // No answer in time is not "offline": the stream can be live, and the content script keeps its state.
  const timeout = { ok: false, status: 0, data: null, error: "timeout" };
  assert.deepEqual(await alive(createAPI({ fetch: hang, live, timeoutMs: 20 })(request())), timeout, "no answer in time");
  const slowBody = async (_url, { signal }) => ({ ok: true, status: 200, headers: new Headers(), json: () => hang(null, { signal }) });
  assert.deepEqual(await alive(createAPI({ fetch: slowBody, live, timeoutMs: 20 })(request())), timeout, "no body in time");
  const lateFailure = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("network"); };
  assert.deepEqual(await createAPI({ fetch: lateFailure, live, timeoutMs: 5000 })(request()), offline, "a failure before the limit stays offline");
  assert.equal(login, 2);
  assert.equal(success, 2);
});

test("a followed redirect is not trusted: only the first answer of the API counts", async () => {
  // With `redirect: "manual"` the browser never sends the cookie or the body to a second address.
  for (const make of [createAPI, createShot]) {
    const calls = [];
    await make({ fetch: async (...args) => { calls.push(args); return redirect(); } })(make === createAPI ? request() : shotRequest());
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].redirect, "manual");
    assert.equal(calls[0][1].credentials, "include");
    assert.ok(calls[0][0].startsWith(`${API}/api/`));
  }
});

test("one live stream fans out only to each subscribed host and accepts pings", async (t) => {
  const stream = upstream();
  const { live, calls, clock } = harness(t, () => stream.response);
  const a = port(), b = port(), unsubscribed = port();
  assert.equal(calls.length, 0);
  for (const p of [a, b, unsubscribed]) live.addPort(p);
  a.sub("crete.koglabs.com"); b.sub("ai.koglabs.com");
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(sent(calls[0]), [API + "/api/events", COOKIE_NO_REDIRECT]);
  assert.equal(calls[0][1].signal.aborted, false);
  for (const p of [a, b, unsubscribed]) assert.deepEqual(p.messages.slice(-2), [{ t: MSG.RESYNC }, { t: MSG.STATE, state: STATE.LIVE }]);
  const pinA = { id: 1, host: "crete.koglabs.com", note: "Γεια 👋" };
  const pinB = { id: 2, host: "ai.koglabs.com" };
  const reply = { id: 3, body: "Done" };
  const bytes = new TextEncoder().encode(`event: pin\r\ndata: ${JSON.stringify({ action: "created", pin: pinA })}\r\n\r\n`);
  for (const byte of bytes) stream.bytes(Uint8Array.of(byte));
  stream.event("reply", { pin: pinB, reply });
  stream.bytes(new TextEncoder().encode("event: pin\ndata: invalid JSON\n\n"));
  stream.event("pin", { action: "invalid", pin: pinA });
  stream.event("reply", { pin: pinA });
  stream.event("ready", { at: "now" });
  await settle();
  const updates = (p) => p.messages.filter(({ t }) => t === MSG.PIN || t === MSG.REPLY);
  assert.deepEqual(updates(a), [{ t: MSG.PIN, action: "created", pin: pinA }]);
  assert.deepEqual(updates(b), [{ t: MSG.REPLY, pin: pinB, reply }]);
  assert.deepEqual(updates(unsubscribed), []);
  a.sub("ai.koglabs.com");
  stream.event("pin", { action: "updated", pin: pinB });
  await settle();
  assert.deepEqual(updates(a).at(-1), { t: MSG.PIN, action: "updated", pin: pinB });
  const count = a.messages.length;
  a.onMessage.emit({ t: MSG.PING });
  assert.equal(a.messages.length, count);
  assert.deepEqual(clock.delays(), [30000, 60000], "only the stable timer and the stall timer of the open stream");
  assert.equal(calls.length, 1);
});

test("a settings event goes to every port, also without or with another host; bad data is dropped", async (t) => {
  const stream = upstream();
  const { live } = harness(t, () => stream.response);
  const a = port(), b = port(), unsubscribed = port();
  for (const p of [a, b, unsubscribed]) live.addPort(p);
  a.sub("crete.koglabs.com"); b.sub("ai.koglabs.com");
  await settle();
  const settings = { autofix: true, bulk: { on: true, delegate: true, agents: 5 } };
  stream.event("settings", settings);
  for (const bad of ["[1]", "null", "7", "not JSON"]) stream.bytes(new TextEncoder().encode(`event: settings\ndata: ${bad}\n\n`));
  await settle();
  for (const p of [a, b, unsubscribed]) assert.deepEqual(p.messages.filter(({ t }) => t === MSG.SETTINGS), [{ t: MSG.SETTINGS, settings }]);
});

test("live reconnect broadcasts resync before live; the backoff starts again only after a stream stayed open 30 seconds", async (t) => {
  const streams = [upstream(), upstream(), upstream()];
  const [first, second, third] = streams;
  let attempt = 0;
  const { live, clock, calls } = harness(t, () => streams[attempt++].response);
  const p = port(); live.addPort(p);
  await settle();
  first.fail(); await settle();
  assert.equal(live.getState(), STATE.OFFLINE);
  assert.deepEqual(clock.delays(), [1000]);
  await clock.tick(999); assert.equal(calls.length, 1);
  await clock.tick(1); assert.equal(calls.length, 2);
  assert.deepEqual(p.messages.slice(-2), [{ t: MSG.RESYNC }, { t: MSG.STATE, state: STATE.LIVE }]);
  assert.equal(p.messages.filter(({ t }) => t === MSG.RESYNC).length, 2);
  second.end(); await settle();
  assert.deepEqual(clock.delays(), [2000], "the second stream ended at once: the backoff goes on");
  await clock.tick(2000); assert.equal(calls.length, 3);
  await clock.tick(30000); assert.equal(live.getState(), STATE.LIVE);
  third.end(); await settle();
  assert.deepEqual(clock.delays(), [1000], "the third stream stayed open 30 s: the backoff starts again");
});

test("a stream that opens and ends at once cannot connect every second", async (t) => {
  const { live, clock, calls } = harness(t, () => { const stream = upstream(); stream.end(); return stream.response; });
  const p = port(); live.addPort(p); await settle();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.deepEqual(clock.delays(), [delay]);
    await clock.tick(delay);
  }
  assert.equal(calls.length, 8, "8 connections in 91 s; without the rule: 92");
  assert.equal(p.messages.filter(({ t }) => t === MSG.RESYNC).length, 8);
});

test("a stream that is silent for 60 seconds is dropped and connected again; bytes keep it open", async (t) => {
  const first = upstream(), second = upstream();
  let attempt = 0;
  const { live, clock, calls } = harness(t, () => ++attempt === 1 ? first.response : second.response);
  live.addPort(port()); await settle();
  await clock.tick(50000);
  first.bytes(encode(": hb\n\n")); await settle(); // a heartbeat at 50 s
  await clock.tick(59999);
  assert.equal(live.getState(), STATE.LIVE);
  assert.equal(first.cancelled, false);
  await clock.tick(1); // 60 s after the last byte
  assert.equal(first.cancelled, true);
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(live.getState(), STATE.OFFLINE);
  assert.deepEqual(clock.delays(), [1000]);
  await clock.tick(1000);
  assert.equal(calls.length, 2);
  assert.equal(live.getState(), STATE.LIVE);
});

test("a connection attempt without an answer is aborted after 60 seconds", async (t) => {
  const { live, clock, calls } = harness(t, hang);
  live.addPort(port()); await settle();
  assert.equal(live.getState(), STATE.CONNECTING);
  assert.deepEqual(clock.delays(), [60000]);
  await clock.tick(60000);
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(live.getState(), STATE.OFFLINE);
  assert.deepEqual(clock.delays(), [1000]);
});

test("an event over 1 MiB drops the stream: nothing reaches a port and the stream is closed", async (t) => {
  const stream = upstream();
  const { live, clock } = harness(t, () => stream.response);
  const p = port(); live.addPort(p); p.sub("crete.koglabs.com"); await settle();
  stream.bytes(encode(`event: pin\ndata: {"action":"created","pin":{"host":"crete.koglabs.com","note":"`));
  for (let i = 0; i < 17; i++) stream.bytes(new Uint8Array(65536).fill(120));
  await settle();
  assert.equal(stream.cancelled, true);
  assert.equal(live.getState(), STATE.OFFLINE);
  assert.deepEqual(clock.delays(), [1000]);
  assert.equal(p.messages.some(({ t: type }) => type === MSG.PIN), false);
});

test("live retries failures at 1, 2, 4, 8, 16, 30, 30 seconds", async (t) => {
  const { live, clock, calls } = harness(t, () => { throw new Error("offline"); });
  live.addPort(port()); await settle();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.deepEqual(clock.delays(), [delay]);
    const before = calls.length;
    await clock.tick(delay - 1); assert.equal(calls.length, before);
    await clock.tick(1); assert.equal(calls.length, before + 1);
    assert.equal(live.getState(), STATE.OFFLINE);
  }
});

test("live refuses non-SSE responses and HTTP errors", async (t) => {
  for (const response of [new Response("login HTML"), new Response("unavailable", { status: 503 })]) {
    const { live, clock } = harness(t, () => response);
    const p = port(); live.addPort(p); await settle();
    assert.equal(live.getState(), STATE.OFFLINE);
    assert.deepEqual(clock.delays(), [1000]);
    assert.equal(p.messages.some(({ t }) => t === MSG.RESYNC), false);
  }
});

test("a redirect of the stream request means login, like a 401", async (t) => {
  const { live, clock } = harness(t, redirect);
  const p = port(); live.addPort(p); await settle();
  assert.equal(live.getState(), STATE.LOGIN);
  assert.deepEqual(clock.delays(), [60000]);
  assert.equal(p.messages.some(({ t: type }) => type === MSG.RESYNC), false);
});

test("401 broadcasts login, retries at 60 seconds, and API success reconnects at once", async (t) => {
  let authorized = false;
  const stream = upstream();
  const { live, clock, calls } = harness(t, () => authorized ? stream.response : new Response(null, { status: 401 }));
  const a = port(), b = port(); live.addPort(a); live.addPort(b); await settle();
  assert.equal(live.getState(), STATE.LOGIN);
  for (const p of [a, b]) assert.deepEqual(p.messages.at(-1), { t: MSG.STATE, state: STATE.LOGIN });
  assert.deepEqual(clock.delays(), [60000]);
  await clock.tick(59999); assert.equal(calls.length, 1);
  await clock.tick(1); assert.equal(calls.length, 2);
  assert.deepEqual(clock.delays(), [60000]);
  authorized = true;
  const api = createAPI({ live, fetch: async () => Response.json({ ok: true }) });
  await api(request()); await settle();
  assert.equal(calls.length, 3);
  assert.equal(live.getState(), STATE.LIVE);
  assert.deepEqual(clock.delays(), [30000, 60000], "no retry is queued");
  await api(request()); assert.equal(calls.length, 3);
});

test("API 401 aborts the active stream and stale fetches cannot replace the state", async (t) => {
  let resolveFetch;
  const { live, calls, clock } = harness(t, () => new Promise((resolve) => { resolveFetch = resolve; }));
  const p = port(); live.addPort(p);
  const api = createAPI({ live, fetch: async () => new Response(null, { status: 401 }) });
  await api(request());
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(live.getState(), STATE.LOGIN);
  const stale = upstream(); resolveFetch(stale.response); await settle();
  assert.equal(stale.cancelled, true);
  assert.equal(live.getState(), STATE.LOGIN);
  assert.deepEqual(clock.delays(), [60000]);
  assert.equal(p.messages.some(({ t }) => t === MSG.RESYNC), false);
});

test("last port closes the stream after 30 seconds; a returning port cancels idle close", async (t) => {
  const first = upstream(), second = upstream();
  let attempt = 0;
  const { live, clock, calls } = harness(t, () => ++attempt === 1 ? first.response : second.response);
  const a = port(), b = port(); live.addPort(a); live.addPort(b); await settle();
  const open = [30000, 60000]; // the stable timer and the stall timer of the open stream
  a.disconnect(); assert.deepEqual(clock.delays(), open);
  b.disconnect(); assert.deepEqual(clock.delays(), [30000, ...open]);
  await clock.tick(29999); assert.equal(calls[0][1].signal.aborted, false);
  const c = port(); live.addPort(c);
  assert.deepEqual(clock.delays(), [1, 30001], "the idle close is cancelled");
  await clock.tick(1); assert.equal(calls.length, 1);
  assert.equal(calls[0][1].signal.aborted, false);
  c.disconnect(); await clock.tick(30000);
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(first.cancelled, true);
  assert.equal(live.getState(), STATE.OFFLINE);
  assert.deepEqual(clock.delays(), []);
  const d = port(); live.addPort(d); await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(d.messages.slice(-2), [{ t: MSG.RESYNC }, { t: MSG.STATE, state: STATE.LIVE }]);
  for (const p of [a, b, c]) {
    assert.equal(p.onMessage.listeners.size, 0);
    assert.equal(p.onDisconnect.listeners.size, 0);
  }
});

test("disconnect cancels a queued retry and broken ports cannot stop broadcasts", async (t) => {
  const { live, clock, calls } = harness(t, () => { throw new Error("offline"); });
  const a = port(), b = port(); live.addPort(a); live.addPort(b); await settle();
  a.postMessage = () => { throw new Error("closed port"); };
  live.requireLogin();
  assert.deepEqual(b.messages.at(-1), { t: MSG.STATE, state: STATE.LOGIN });
  b.disconnect();
  assert.deepEqual(clock.delays(), [30000]);
  await clock.tick(120000);
  assert.equal(calls.length, 1);
  assert.equal(live.getState(), STATE.OFFLINE);
});

test("background answers only its own content script on the root domain, in both namespaces", () => {
  for (const namespace of ["chrome", "browser"]) {
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const listener = () => ({ addListener(fn) { this.fn = fn; } });
      const sent = [];
      const fetched = [];
      globalThis.fetch = async (url) => { fetched.push(url); return Response.json({ ok: true }); };
      const ID = 'onspotextensionid';
      const page = { id: ID, tab: { id: 7 }, frameId: 0, url: 'https://crete.koglabs.com/pricing?x=1' };
      const api = globalThis.${namespace} = {
        runtime: { id: ID, onMessage: listener(), onConnect: listener() },
        commands: { onCommand: listener() }, action: { onClicked: listener() },
        tabs: { query: async (query) => { assert.deepEqual(query, {active: true, currentWindow: true}); return [{id: 42}]; },
          sendMessage: async (...args) => { sent.push(args); throw new Error('No content script'); } },
      };
      await import(${JSON.stringify(new URL("../src/background.js", import.meta.url).href)});
      for (const event of [api.runtime.onMessage, api.runtime.onConnect, api.commands.onCommand, api.action.onClicked]) assert.equal(typeof event.fn, 'function');
      const health = { t: 'api', method: 'GET', path: '/api/health' };

      // Any other sender gets no answer and causes no request.
      const strangers = [undefined, null, {}, { ...page, id: 'another-extension' }, { ...page, id: undefined }, { id: ID, url: 'chrome-extension://' + ID + '/page.html' },
        { ...page, url: undefined }, { ...page, url: 'https://evil.example/' }, { ...page, url: 'http://crete.koglabs.com/' },
        { ...page, url: 'https://koglabs.com.evil.example/' }, { ...page, url: 'https://notkoglabs.com/' }, { ...page, url: 'https://evil.example/?https://koglabs.com/' },
        { ...page, url: 'chrome-extension://' + ID + '/page.html' }, { ...page, url: 'about:blank' }];
      for (const sender of strangers) {
        for (const message of [{ t: 'state' }, health, { t: 'shot', id: 1, kind: 'before' }]) {
          assert.equal(api.runtime.onMessage.fn(message, sender, () => assert.fail('answered ' + JSON.stringify(sender))), false);
        }
      }
      const port = (name, sender) => ({ name, sender, closed: 0, disconnect() { this.closed++; }, onMessage: listener(), onDisconnect: listener(), postMessage() {} });
      for (const stranger of [port('pins-live', strangers[7]), port('pins-live', undefined), port('unrelated', page)]) {
        api.runtime.onConnect.fn(stranger);
        assert.equal(stranger.closed, 1);
        assert.equal(stranger.onMessage.fn, undefined);
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(fetched, []);

      // The content script on the root domain or a subdomain, also with a dot at the end of the
      // host name (Chrome) and on a page outside a tab (a sidebar, a side panel).
      for (const sender of [page, { ...page, url: 'https://koglabs.com/' }, { ...page, url: 'https://a.b.koglabs.com/x#y' }, { ...page, url: 'https://koglabs.com./' }, { ...page, tab: undefined }]) {
        let state;
        assert.equal(api.runtime.onMessage.fn({ t: 'state' }, sender, (result) => { state = result; }), false);
        assert.deepEqual(state, { state: 'offline' }, JSON.stringify(sender));
      }
      assert.equal(api.runtime.onMessage.fn({ t: 'unknown' }, page, () => assert.fail('unexpected reply')), false);
      const result = await new Promise((resolve) => assert.equal(api.runtime.onMessage.fn(health, page, resolve), true));
      assert.deepEqual(result, { ok: true, status: 200, data: { ok: true } });
      const shot = await new Promise((resolve) => assert.equal(api.runtime.onMessage.fn({ t: 'shot', id: '1/../2', kind: 'before' }, page, resolve), true));
      assert.deepEqual(shot, { ok: false, status: 400 });
      assert.deepEqual(fetched, ['https://ai.koglabs.com/pins/api/health']);
      api.commands.onCommand.fn('other');
      api.commands.onCommand.fn('toggle-pins');
      api.action.onClicked.fn({ id: 17 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(sent.sort((a, b) => a[0] - b[0]), [[17, { t: 'toggle' }], [42, { t: 'toggle' }]]);
      const own = port('pins-live', page);
      api.runtime.onConnect.fn(own);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(own.closed, 0);
      assert.equal(typeof own.onMessage.fn, 'function');
      assert.deepEqual(fetched.slice(1), ['https://ai.koglabs.com/pins/api/events']);
      process.exit(0); // The live stream keeps a retry timer.
    `], { timeout: 10000, stdio: "pipe" });
  }
});
