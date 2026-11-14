import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { openStore, ConflictError, ForbiddenError, ValidationError } from "../src/store.js";
import { createV2Database } from "./old-schema.js";

const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", note: "Cut the space", targets: [{ selector: "main > h1", label: "h1" }], ...extra });
const BULK = { on: false, delegate: false, agents: 3 };
const USER = { kind: "user", author: "sam" };
const AGENT = { kind: "agent", agent: "claude", author: "claude" };

function doneStore() {
  const store = openStore({ file: ":memory:" });
  const { id } = store.createPin(input());
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Fixed", commit: "abc123" });
  return { store, id };
}

test("accept: only a user, only a done pin, sets acceptedAt once and emits one update", () => {
  const { store, id } = doneStore();
  const seen = [];
  store.on("change", (event) => seen.push(event));
  assert.equal(store.getPin(id).acceptedAt, null);
  assert.throws(() => store.transition(id, "accept", AGENT), ForbiddenError);
  assert.throws(() => store.transition(id, "accept"), (error) => error instanceof ForbiddenError && error.status === 403, "no kind means no user");
  assert.throws(() => store.transition(999, "accept", AGENT), ForbiddenError, "the guard comes before the lookup");
  assert.equal(store.transition(999, "accept", USER), null);
  assert.deepEqual(seen, []);
  assert.equal(store.getPin(id).acceptedAt, null, "a refused accept changes nothing");

  const first = store.transition(id, "accept", USER);
  assert.match(first.acceptedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(first.status, "done");
  assert.deepEqual([first.summary, first.commit, first.closedAt, first.replyCount], ["Fixed", "abc123", store.getPin(id).closedAt, 1], "accept keeps the result and adds no reply");
  assert.deepEqual(seen.map((e) => [e.type, e.action, e.pin.acceptedAt]), [["pin", "updated", first.acceptedAt]]);

  const second = store.transition(id, "accept", USER);
  assert.deepEqual(second, first, "a second accept changes nothing");
  assert.equal(seen.length, 1, "and sends no event");
  assert.equal(store.getPin(id).updatedAt, first.updatedAt);
});

test("accept on a pin that is not done is a conflict, for every other status", () => {
  const store = openStore({ file: ":memory:" });
  const { id } = store.createPin(input());
  assert.throws(() => store.transition(id, "accept", USER), ConflictError);
  store.transition(id, "start", AGENT);
  assert.throws(() => store.transition(id, "accept", USER), ConflictError);
  store.transition(id, "ask", { ...AGENT, question: "Which size?" });
  assert.throws(() => store.transition(id, "accept", USER), ConflictError);
  store.transition(id, "dismiss", { ...AGENT, reason: "No" });
  assert.throws(() => store.transition(id, "accept", USER), ConflictError);
  assert.equal(store.getPin(id).acceptedAt, null);
});

test("reopens: new pins start at 0; only a user reopen counts; acceptedAt is cleared by every reopen", () => {
  const store = openStore({ file: ":memory:" });
  const batch = store.createBatch({ pins: [input(), input()], key: "reopens-batch" });
  assert.deepEqual(batch.pins.map((pin) => [pin.reopens, pin.acceptedAt]), [[0, null], [0, null]]);
  const { id } = store.createPin(input());
  assert.equal(store.getPin(id).reopens, 0);

  // user reopen of a done pin
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Fixed" });
  store.transition(id, "accept", USER);
  let pin = store.transition(id, "reopen", USER);
  assert.deepEqual([pin.status, pin.reopens, pin.acceptedAt, pin.summary, pin.agent, pin.run, pin.closedAt], ["queued", 1, null, null, null, null, null]);

  // agent reopen (the runner's retry) does not count, but still clears acceptedAt
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Fixed" });
  store.transition(id, "accept", USER);
  pin = store.transition(id, "reopen", AGENT);
  assert.deepEqual([pin.status, pin.reopens, pin.acceptedAt], ["queued", 1, null]);
  store.transition(id, "start", AGENT);
  assert.equal(store.transition(id, "reopen", AGENT).reopens, 1, "a retry of a working pin does not count");
  store.transition(id, "start", AGENT);
  assert.equal(store.transition(id, "reopen", USER).reopens, 2, "a user reopen of a working pin counts");
  assert.equal(store.getPin(id).attempts, 4, "reopen keeps attempts");
});

test("reopens: a user reply on waiting and a user reply with reopen:true count; an agent reply or a plain reply does not", () => {
  const store = openStore({ file: ":memory:" });
  const { id } = store.createPin(input());
  store.transition(id, "start", AGENT);
  store.transition(id, "ask", { ...AGENT, question: "Which size?" });
  store.addReply(id, { kind: "agent", author: "claude", body: "Still checking" });
  assert.deepEqual([store.getPin(id).status, store.getPin(id).reopens], ["waiting", 0]);
  store.addReply(id, { kind: "user", author: "sam", body: "24 pixels" });
  assert.deepEqual([store.getPin(id).status, store.getPin(id).reopens], ["queued", 1]);

  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Fixed" });
  store.transition(id, "accept", USER);
  store.addReply(id, { kind: "user", author: "sam", body: "Thanks" });
  assert.deepEqual([store.getPin(id).status, store.getPin(id).reopens, store.getPin(id).acceptedAt === null], ["done", 1, false], "a plain reply keeps a done pin accepted");
  store.addReply(id, { kind: "agent", author: "claude", body: "Agent note", reopen: true });
  assert.deepEqual([store.getPin(id).status, store.getPin(id).reopens], ["done", 1], "an agent reply never reopens");
  const seen = [];
  store.on("change", (event) => seen.push(event));
  store.addReply(id, { kind: "user", author: "sam", body: "Not right", reopen: true });
  const pin = store.getPin(id);
  assert.deepEqual([pin.status, pin.reopens, pin.acceptedAt], ["queued", 2, null]);
  assert.deepEqual(seen.map((e) => e.type), ["pin", "reply"]);
  assert.equal(seen[0].pin.reopens, 2);

  store.transition(id, "start", AGENT);
  store.transition(id, "dismiss", { ...AGENT, reason: "No" });
  store.addReply(id, { kind: "user", author: "sam", body: "Do it", reopen: true });
  assert.deepEqual([store.getPin(id).status, store.getPin(id).reopens], ["queued", 3], "dismissed counts too");
});

test("a v2 file: old pins keep reopens NULL and acceptedAt NULL; a user reopen keeps NULL; accept and new pins work; all persists", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-v31-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  createV2Database(file).close();
  let store = openStore({ file });
  t.after(() => store.close());
  const inspect = new DatabaseSync(file);
  t.after(() => inspect.close());
  assert.deepEqual({ ...inspect.prepare("SELECT COUNT(*) AS n, COUNT(reopens) AS r, COUNT(accepted_at) AS a FROM pins").get() }, { n: 5, r: 0, a: 0 });
  for (const id of [30, 31, 32, 33, 34]) assert.deepEqual([store.getPin(id).reopens, store.getPin(id).acceptedAt], [null, null], `pin ${id}`);

  assert.deepEqual([store.transition(33, "reopen", USER).reopens, store.getPin(33).status], [null, "queued"], "unknown stays unknown");
  store.transition(33, "start", AGENT);
  store.transition(33, "resolve", { ...AGENT, summary: "Again" });
  const accepted = store.transition(33, "accept", USER);
  assert.ok(accepted.acceptedAt);
  assert.equal(accepted.reopens, null);
  store.addReply(32, { kind: "user", author: "sam", body: "Answer" });
  assert.deepEqual([store.getPin(32).status, store.getPin(32).reopens], ["queued", null]);
  const fresh = store.createPin(input());
  assert.equal(fresh.reopens, 0);
  store.transition(fresh.id, "start", AGENT);
  assert.equal(store.transition(fresh.id, "reopen", USER).reopens, 1);

  store.close();
  store = openStore({ file });
  assert.equal(store.getPin(33).acceptedAt, accepted.acceptedAt);
  assert.deepEqual([store.getPin(33).reopens, store.getPin(fresh.id).reopens], [null, 1]);
  assert.equal(inspect.prepare("SELECT reopens FROM pins WHERE id = 33").get().reopens, null);
});

test("settings: defaults, merge of any subset, autofix keeps bulk and bulk keeps autofix, whole object in the event, persists", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-v31-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  let store = openStore({ file });
  t.after(() => store.close());
  assert.deepEqual(store.getSettings(), { autofix: true, bulk: BULK });
  const seen = [];
  store.on("change", (event) => seen.push(event));

  assert.deepEqual(store.setSettings({ bulk: { on: true } }), { autofix: true, bulk: { on: true, delegate: false, agents: 3 } });
  assert.deepEqual(store.setSettings({ bulk: { agents: 5 } }), { autofix: true, bulk: { on: true, delegate: false, agents: 5 } });
  assert.deepEqual(store.setSettings({ autofix: false }), { autofix: false, bulk: { on: true, delegate: false, agents: 5 } }, "autofix alone never resets bulk");
  assert.deepEqual(store.setSettings({ bulk: { delegate: true, on: false } }), { autofix: false, bulk: { on: false, delegate: true, agents: 5 } });
  assert.deepEqual(store.setSettings({ autofix: true, bulk: { on: true, delegate: true, agents: 8 } }), { autofix: true, bulk: { on: true, delegate: true, agents: 8 } });
  assert.deepEqual(store.setSettings({ bulk: { agents: 1 } }).bulk.agents, 1);
  assert.deepEqual(seen.map((event) => event.type), Array(6).fill("settings"));
  assert.deepEqual(seen[2].settings, { autofix: false, bulk: { on: true, delegate: false, agents: 5 } });

  store.close();
  store = openStore({ file });
  assert.deepEqual(store.getSettings(), { autofix: true, bulk: { on: true, delegate: true, agents: 1 } });
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'bulk'").get().value, '{"on":true,"delegate":true,"agents":1}');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'autofix'").get().value, "true");
});

test("settings: an invalid patch is a ValidationError and changes nothing, not even the valid half", () => {
  const store = openStore({ file: ":memory:" });
  store.setSettings({ autofix: false, bulk: { on: true, agents: 4 } });
  const before = store.getSettings();
  const seen = [];
  store.on("change", (event) => seen.push(event));
  const bad = [
    undefined, null, false, 0, "bulk", [], {}, { other: 1 }, { autofix: "false" }, { autofix: 0 }, { autofix: null }, { autofix: undefined },
    { bulk: null }, { bulk: [] }, { bulk: {} }, { bulk: true }, { bulk: "on" },
    { bulk: { on: "true" } }, { bulk: { on: 1 } }, { bulk: { on: null } }, { bulk: { delegate: "yes" } },
    { bulk: { agents: 0 } }, { bulk: { agents: 9 } }, { bulk: { agents: -1 } }, { bulk: { agents: 1.5 } }, { bulk: { agents: "3" } }, { bulk: { agents: null } }, { bulk: { agents: true } },
    { bulk: { on: true, extra: 1 } }, { bulk: { constructor: true } }, { bulk: JSON.parse('{"__proto__":1}') }, JSON.parse('{"__proto__":{"autofix":true}}'),
    { autofix: true, other: false }, { autofix: true, bulk: { agents: 99 } }, { autofix: "no", bulk: { on: false } }, { autofix: true, bulk: { on: false, delegate: 1 } },
  ];
  for (const patch of bad) {
    assert.throws(() => store.setSettings(patch), ValidationError, JSON.stringify(patch));
    assert.deepEqual(store.getSettings(), before, JSON.stringify(patch));
  }
  assert.deepEqual(seen, []);
});

async function fixture(t) {
  const store = openStore({ file: ":memory:" });
  const app = createApp({ store, version: "test" });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  };
  // Reads the SSE stream until `wanted` frames of the type `event` arrived.
  const frames = async (event, wanted, trigger) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const found = [];
    const next = async () => {
      let end;
      while ((end = buffer.indexOf("\n\n")) < 0) {
        const { value, done } = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error("SSE frame did not arrive")), 3000).unref())]);
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return Object.fromEntries(raw.split("\n").filter((line) => /^(event|data):/.test(line)).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
    };
    while ((await next()).event !== "ready");
    await trigger();
    while (found.length < wanted) {
      const frame = await next();
      if (frame.event === event) found.push(JSON.parse(frame.data));
    }
    controller.abort();
    return found;
  };
  return { call, store, frames, port };
}

test("POST /api/pins/:id/accept: 403 agent, 404 unknown, 409 not done, 200 user; idempotent; the pin JSON carries acceptedAt and reopens", async (t) => {
  const { call, store } = await fixture(t);
  const { id } = store.createPin(input());
  const agent = { "X-Pins-Agent": "claude" };
  assert.deepEqual((await call(`/api/pins/${id}`)).data.pin.reopens, 0);
  assert.equal((await call(`/api/pins/${id}/accept`, { method: "POST", body: {} })).status, 409, "queued");
  await call(`/api/pins/${id}/start`, { method: "POST", headers: agent, body: { run: "triad:7" } });
  assert.equal((await call(`/api/pins/${id}/accept`, { method: "POST", body: {} })).status, 409, "working");
  await call(`/api/pins/${id}/resolve`, { method: "POST", headers: agent, body: { summary: "Fixed", commit: "abc123" } });

  for (const body of [{}, undefined]) {
    const refused = await call(`/api/pins/${id}/accept`, { method: "POST", headers: agent, body });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /user/);
  }
  assert.equal((await call("/api/pins/999/accept", { method: "POST", body: {} })).status, 404);
  assert.equal((await call("/api/pins/0/accept", { method: "POST", body: {} })).status, 404);
  assert.equal((await call("/api/pins/abc/accept", { method: "POST", body: {} })).status, 404);
  assert.equal((await call(`/api/pins/${id}/accept`)).status, 405, "GET is not allowed");
  assert.equal((await call(`/api/pins/${id}`)).data.pin.acceptedAt, null, "the refused calls changed nothing");

  const ok = await call(`/api/pins/${id}/accept`, { method: "POST", headers: { "X-SSO-User": "sam" }, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.data.pin.status, "done");
  assert.equal(ok.data.pin.reopens, 0);
  assert.equal(new Date(ok.data.pin.acceptedAt).toISOString(), ok.data.pin.acceptedAt);
  const again = await call(`/api/pins/${id}/accept`, { method: "POST", body: {} });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.pin, ok.data.pin);
  assert.deepEqual((await call(`/api/pins?status=done`)).data.pins.map((pin) => pin.acceptedAt), [ok.data.pin.acceptedAt]);

  // "Not right": a user reply with reopen:true counts and clears the acceptance.
  const reply = await call(`/api/pins/${id}/replies`, { method: "POST", headers: { "X-SSO-User": "sam" }, body: { body: "Still wrong", reopen: true } });
  assert.equal(reply.status, 201);
  assert.deepEqual([reply.data.pin.status, reply.data.pin.reopens, reply.data.pin.acceptedAt], ["queued", 1, null]);
  // The runner's retry (an agent reopen) does not count.
  await call(`/api/pins/${id}/start`, { method: "POST", headers: agent, body: {} });
  const retry = await call(`/api/pins/${id}/reopen`, { method: "POST", headers: agent, body: {} });
  assert.deepEqual([retry.data.pin.status, retry.data.pin.reopens], ["queued", 1]);
  const user = await call(`/api/pins/${id}/reopen`, { method: "POST", body: {} });
  assert.equal(user.status, 409, "queued cannot reopen");
});

test("accept keeps the write guards of its neighbours", async (t) => {
  const { call, store, port } = await fixture(t);
  const { id } = store.createPin(input());
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Fixed" });
  const path = `/api/pins/${id}/accept`;
  // fetch cannot send a foreign Host or an Origin, so these two go over node:http.
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "POST", setHost: false, agent: false, headers: { "Content-Type": "application/json", "Content-Length": 2, Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(await raw({ Host: "evil.example" }), 403);
  assert.equal(await raw({ Origin: "https://ai.koglabs.com" }), 403);
  assert.equal((await call(path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: {} })).status, 415);
  assert.equal((await call(path, { method: "POST", headers: { "X-Pins-Agent": "" }, body: {} })).status, 400);
  assert.equal(store.getPin(id).acceptedAt, null);
});

test("PATCH /api/settings merges, answers with the whole object and refuses bad input without a change", async (t) => {
  const { call } = await fixture(t);
  const whole = { autofix: true, bulk: BULK };
  assert.deepEqual((await call("/api/settings")).data, whole);
  const patched = await call("/api/settings", { method: "PATCH", body: { bulk: { on: true, agents: 5 } } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.data, { autofix: true, bulk: { on: true, delegate: false, agents: 5 } });
  const autofix = await call("/api/settings", { method: "PATCH", body: { autofix: false } });
  assert.deepEqual(autofix.data, { autofix: false, bulk: { on: true, delegate: false, agents: 5 } }, "the Triad tab sends only autofix");
  assert.deepEqual((await call("/api/settings", { method: "PATCH", body: { bulk: { delegate: true } } })).data, { autofix: false, bulk: { on: true, delegate: true, agents: 5 } });
  const saved = (await call("/api/settings")).data;
  for (const body of [{}, { other: 1 }, { bulk: {} }, { bulk: { on: "yes" } }, { bulk: { agents: 0 } }, { bulk: { agents: 9 } }, { bulk: { agents: 2.5 } }, { bulk: { agents: "3" } }, { bulk: { extra: 1 } }, { autofix: true, bulk: { agents: 99 } }, { autofix: "x" }, { bulk: null }]) {
    const response = await call("/api/settings", { method: "PATCH", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof response.data.error, "string");
    assert.deepEqual((await call("/api/settings")).data, saved, JSON.stringify(body));
  }
});

test("SSE: the settings event carries the whole object, bulk included; accept sends a pin update", async (t) => {
  const { call, store, frames } = await fixture(t);
  const [first, second] = await frames("settings", 2, async () => {
    await call("/api/settings", { method: "PATCH", body: { bulk: { on: true, delegate: true, agents: 6 } } });
    assert.equal((await call("/api/settings", { method: "PATCH", body: { autofix: false } })).status, 200);
  });
  assert.deepEqual(first, { autofix: true, bulk: { on: true, delegate: true, agents: 6 } });
  assert.deepEqual(second, { autofix: false, bulk: { on: true, delegate: true, agents: 6 } });

  const { id } = store.createPin(input());
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Fixed" });
  const [update] = await frames("pin", 1, async () => {
    await call(`/api/pins/${id}/accept`, { method: "POST", body: {} });
    await call(`/api/pins/${id}/accept`, { method: "POST", body: {} });
  });
  assert.equal(update.action, "updated");
  assert.ok(update.pin.acceptedAt);
});
