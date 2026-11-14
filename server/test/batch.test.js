import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { openStore, BATCH_MAX, ValidationError } from "../src/store.js";

const target = (extra = {}) => ({ selector: "main > h1", label: 'h1 "Hello"', rect: { x: 1, y: 2, w: 300, h: 40 }, ...extra });
const item = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", title: "Pricing", note: "Make it blue", targets: [target()], viewport: { w: 1400, h: 900 }, ...extra });
const count = (store) => store.listPins({ statuses: ["queued", "working", "waiting", "done", "dismissed"] }).length;

test("a batch writes every pin in one transaction, then emits one created event per pin", () => {
  const store = openStore({ file: ":memory:" });
  const seen = [];
  store.on("change", (e) => seen.push(`${e.action}:${e.pin.id}:${e.pin.batch}:${count(store)}`));
  const result = store.createBatch({ pins: [item(), item({ note: "Bigger", url: "https://crete.koglabs.com/about" })], author: "sam", key: "k-12345678" });
  assert.equal(result.created, true);
  assert.equal(result.batch.id, 1);
  assert.equal(result.batch.host, "crete.koglabs.com");
  assert.equal(result.batch.count, 2);
  assert.deepEqual(result.pins.map((p) => [p.id, p.status, p.batch, p.author, p.attempts, p.model]), [[1, "queued", 1, "sam", 0, null], [2, "queued", 1, "sam", 0, null]]);
  // Both rows exist before the first event goes out, so a listener sees the whole batch.
  assert.deepEqual(seen, ["created:1:1:2", "created:2:1:2"]);
  assert.deepEqual(store.listPins({ batch: 1 }).map((p) => p.id), [2, 1]);
  assert.deepEqual(store.listPins({ batch: 2 }), []);
  store.close();
});

test("a repeated key returns the first batch and writes nothing", () => {
  const store = openStore({ file: ":memory:" });
  const first = store.createBatch({ pins: [item()], key: "same-key-1" });
  let events = 0;
  store.on("change", () => events++);
  const again = store.createBatch({ pins: [item({ note: "different" }), item()], key: "same-key-1" });
  assert.equal(again.created, false);
  assert.equal(again.batch.id, first.batch.id);
  assert.deepEqual(again.pins.map((p) => p.id), [1]);
  assert.equal(events, 0);
  assert.equal(count(store), 1);
  // No key: every call is a new batch.
  assert.equal(store.createBatch({ pins: [item()] }).batch.id, 2);
  store.close();
});

test("one bad pin, mixed hosts, or a bad size or key writes nothing", () => {
  const store = openStore({ file: ":memory:" });
  assert.throws(() => store.createBatch({ pins: [item(), item({ targets: [] })] }), (e) => e instanceof ValidationError && /^pin 2: targets/.test(e.message));
  assert.throws(() => store.createBatch({ pins: [item(), item({ url: "https://crm.koglabs.com/" })] }), /one host/);
  assert.throws(() => store.createBatch({ pins: [item({ url: "https://evil.example/" })] }), /pin 1: url host/);
  assert.throws(() => store.createBatch({ pins: [] }), /1 to 30/);
  assert.throws(() => store.createBatch({ pins: Array.from({ length: BATCH_MAX + 1 }, () => item()) }), /1 to 30/);
  assert.throws(() => store.createBatch({ pins: "x" }), /1 to 30/);
  for (const key of ["short", "has space here", 12345678, "x".repeat(81)]) {
    assert.throws(() => store.createBatch({ pins: [item()], key }), /key must be/);
  }
  assert.equal(count(store), 0);
  assert.equal(store.createBatch({ pins: [item()] }).batch.id, 1, "failed batches use no batch id");
  store.close();
});

test("start records the model and counts attempts; reopen keeps both", () => {
  const store = openStore({ file: ":memory:" });
  const { pins: [pin] } = store.createBatch({ pins: [item()] });
  let next = store.transition(pin.id, "start", { agent: "claude", run: "triad:5", model: "sonnet" });
  assert.deepEqual([next.status, next.model, next.attempts, next.run], ["working", "sonnet", 1, "triad:5"]);
  next = store.transition(pin.id, "reopen");
  assert.deepEqual([next.status, next.model, next.attempts, next.run, next.agent], ["queued", "sonnet", 1, null, null]);
  next = store.transition(pin.id, "start", { agent: "claude", run: "triad:6", model: "opus" });
  assert.deepEqual([next.model, next.attempts], ["opus", 2]);
  assert.throws(() => store.transition(pin.id, "start", {}), /pin #1 is working/);
  assert.equal(store.getPin(pin.id).attempts, 2, "a refused start does not count");
  assert.throws(() => store.transition(store.createPin(item()).id, "start", { model: "m".repeat(41) }), /model is longer/);
  store.close();
});

test("a user reply with reopen sends a done or dismissed pin back; other replies do not", () => {
  const store = openStore({ file: ":memory:" });
  const done = store.createPin(item());
  store.transition(done.id, "start", { agent: "claude", run: "triad:1", model: "sonnet" });
  store.transition(done.id, "resolve", { summary: "Button is blue", commit: "abc1234" });
  store.addReply(done.id, { kind: "user", author: "sam", body: "Thanks" });
  assert.equal(store.getPin(done.id).status, "done", "a plain reply keeps a done pin closed");
  store.addReply(done.id, { kind: "agent", author: "claude", body: "x", reopen: true });
  assert.equal(store.getPin(done.id).status, "done", "an agent cannot reopen with a reply");
  const events = [];
  store.on("change", (e) => events.push(`${e.type}:${e.pin.status}`));
  store.addReply(done.id, { kind: "user", author: "sam", body: "Not right: darker blue", reopen: true });
  const back = store.getPin(done.id);
  assert.deepEqual([back.status, back.summary, back.commit, back.agent, back.run, back.closedAt, back.model, back.attempts], ["queued", null, null, null, null, null, "sonnet", 1]);
  assert.deepEqual(events, ["pin:queued", "reply:queued"]);
  const dismissed = store.createPin(item());
  store.transition(dismissed.id, "dismiss", { reason: "test" });
  store.addReply(dismissed.id, { kind: "user", body: "Please do it", reopen: true });
  assert.equal(store.getPin(dismissed.id).status, "queued");
  const queued = store.createPin(item());
  store.addReply(queued.id, { kind: "user", body: "More detail", reopen: true });
  assert.equal(store.getPin(queued.id).status, "queued");
  store.close();
});

async function fixture(t, options = {}) {
  const store = openStore({ file: ":memory:" });
  const app = createApp({ store, version: "test", extension: "0.2.0", ...options });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const port = server.address().port;
  const request = (path, { method = "GET", body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const sent = { Host: `127.0.0.1:${port}`, ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }), ...headers };
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: sent, setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(data);
  });
  return { request, store };
}

test("POST /api/batches: 201, repeat key 200, the SSO user as author, and 400 for bad input", async (t) => {
  const { request } = await fixture(t);
  const first = await request("/api/batches", { method: "POST", body: { key: "abc-defgh", pins: [item(), item({ note: "Second" })] }, headers: { "X-SSO-User": "sam" } });
  assert.equal(first.status, 201);
  assert.deepEqual(first.data.batch, { id: 1, host: "crete.koglabs.com", author: "sam", createdAt: first.data.batch.createdAt, count: 2 });
  assert.deepEqual(first.data.pins.map((p) => [p.id, p.batch, p.author]), [[1, 1, "sam"], [2, 1, "sam"]]);
  const again = await request("/api/batches", { method: "POST", body: { key: "abc-defgh", pins: [item()] } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.pins.map((p) => p.id), [1, 2]);
  const bad = await request("/api/batches", { method: "POST", body: { pins: [item(), item({ url: "https://crm.koglabs.com/" })] } });
  assert.deepEqual([bad.status, bad.data.error], [400, "all pins in a batch must be on one host"]);
  assert.equal((await request("/api/batches", { method: "POST", body: {} })).status, 400);
  assert.equal((await request("/api/batches")).status, 405);
  const listed = await request("/api/pins?batch=1&status=all");
  assert.deepEqual(listed.data.pins.map((p) => p.id), [2, 1]);
  assert.equal((await request("/api/pins?batch=abc")).status, 400);
  assert.deepEqual((await request("/api/health")).data.extension, "0.2.0");
});

test("a full batch fits the 512 KiB batch limit; larger bodies get 413; single pins keep 64 KiB", async (t) => {
  const { request } = await fixture(t);
  const long = "x".repeat(150);
  const heavy = item({ note: "n".repeat(1500), targets: Array.from({ length: 10 }, (_, i) => target({ selector: `#t${i}`, text: long, ancestors: ["a", "b", "c", "d", "e", "f"], styles: { font: long, color: long } })) });
  const body = { pins: Array.from({ length: BATCH_MAX }, () => heavy) };
  const size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size > 64 * 1024 && size < 512 * 1024, `test body is ${size} bytes`);
  const full = await request("/api/batches", { method: "POST", body });
  assert.equal(full.status, 201);
  assert.equal(full.data.pins.length, BATCH_MAX);
  const huge = await request("/api/batches", { method: "POST", raw: JSON.stringify({ pins: [item({ note: "y".repeat(600 * 1024) })] }), headers: { "Content-Type": "application/json" } });
  assert.equal(huge.status, 413);
  const single = await request("/api/pins", { method: "POST", raw: JSON.stringify(item({ note: "z".repeat(70 * 1024) })), headers: { "Content-Type": "application/json" } });
  assert.equal(single.status, 413);
});

test("start takes a model; a reply with reopen requeues a done pin; reopen must be boolean", async (t) => {
  const { request } = await fixture(t);
  const { data: { pins: [pin] } } = await request("/api/batches", { method: "POST", body: { pins: [item()] } });
  const agent = { "X-Pins-Agent": "claude" };
  const started = await request(`/api/pins/${pin.id}/start`, { method: "POST", body: { run: "triad:9", model: "opus" }, headers: agent });
  assert.deepEqual([started.data.pin.model, started.data.pin.attempts, started.data.pin.agent], ["opus", 1, "claude"]);
  await request(`/api/pins/${pin.id}/resolve`, { method: "POST", body: { summary: "Blue now", commit: "abc" }, headers: agent });
  assert.equal((await request(`/api/pins/${pin.id}/replies`, { method: "POST", body: { body: "Not right", reopen: "yes" } })).status, 400);
  const reply = await request(`/api/pins/${pin.id}/replies`, { method: "POST", body: { body: "Not right: darker", reopen: true } });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.pin.status, "queued");
  assert.equal(reply.data.reply.kind, "user");
});
