import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";
import { SHOT_MAX } from "../src/shots.js";

// Every byte value follows the magic bytes, so a text decode anywhere would corrupt the image.
const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), all]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), all]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 1, 0, 0]), Buffer.from("WEBP"), all]);
const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", note: "Cut the space", targets: [{ selector: "main > h1", label: 'h1 "Pricing"' }], ...extra });
const agent = { "X-Pins-Agent": "claude" };

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pins-v3-api-"));
  const shots = join(dir, "shots");
  const store = openStore({ file: ":memory:", shotsDir: shots });
  const app = createApp({ store, version: "test", ...options });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = server.address().port;
  // `raw` is sent as it is (bytes or text); `body` is sent as JSON.
  function request(path, { method = "GET", body, raw, chunks, headers = {} } = {}) {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const sent = { Host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers };
    if (data !== undefined && !chunks) sent["Content-Length"] = Buffer.byteLength(data);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: sent, setHost: false, agent: false }, (res) => {
        const parts = [];
        res.on("data", (part) => parts.push(part));
        res.on("error", reject);
        res.on("end", () => {
          const bytes = Buffer.concat(parts);
          const json = res.headers["content-type"]?.startsWith("application/json") && bytes.length;
          resolve({ status: res.statusCode, headers: res.headers, bytes, data: json ? JSON.parse(bytes.toString("utf8")) : null });
        });
      });
      req.on("error", reject);
      if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
      else req.end(data);
    });
  }
  const put = (path, bytes, headers = { ...agent, "Content-Type": "image/png" }) => request(path, { method: "PUT", raw: bytes, headers });
  async function workingPin() {
    const { id } = store.createPin(input());
    store.transition(id, "start", { agent: "claude", run: "triad:7" });
    return id;
  }
  return { request, put, workingPin, store, shots };
}

test("create and batch take intent, scope and presets; a bad value is 400 and writes nothing", async (t) => {
  const { request, store } = await fixture(t);
  const presets = [{ label: "5 agents", text: "Start a thread and delegate 5 agents." }];
  const created = await request("/api/pins", { method: "POST", body: input({ intent: "style", scope: "element", presets }) });
  assert.equal(created.status, 201);
  assert.deepEqual([created.data.pin.intent, created.data.pin.scope, created.data.pin.presets], ["style", "element", presets]);
  assert.deepEqual([created.data.pin.progress, created.data.pin.shots], [null, { before: null, after: null }]);
  const batch = await request("/api/batches", { method: "POST", body: { key: "v3-batch-1", pins: [input({ intent: "task" }), input({ scope: "site", presets: [] }), input()] } });
  assert.equal(batch.status, 201);
  assert.deepEqual(batch.data.pins.map((pin) => [pin.intent, pin.scope, pin.presets]), [["task", null, []], [null, "site", []], [null, null, []]]);
  assert.deepEqual((await request("/api/pins/1")).data.pin, created.data.pin);
  assert.equal((await request("/api/pins?limit=500")).data.pins.at(-1).intent, "style");
  for (const extra of [
    { intent: "colour" }, { intent: "" }, { scope: "app" }, { scope: 3 }, { presets: "x" },
    { presets: Array.from({ length: 7 }, () => ({ label: "a", text: "b" })) },
    { presets: [{ label: "a", text: "b", extra: 1 }] },
    { presets: [{ label: "x".repeat(41), text: "b" }] }, { presets: [{ label: "a", text: "y".repeat(501) }] },
  ]) {
    const label = JSON.stringify(extra).slice(0, 60);
    assert.equal((await request("/api/pins", { method: "POST", body: input(extra) })).status, 400, label);
    const refused = await request("/api/batches", { method: "POST", body: { pins: [input(extra), input()] } });
    assert.equal(refused.status, 400, label);
    assert.match(refused.data.error, /^pin 1: /);
  }
  assert.equal(store.stats().total.queued, 4);
});

test("GET /api/pins?selector= matches the first target exactly and refuses more than 500 chars", async (t) => {
  const { request, store } = await fixture(t);
  const first = store.createPin(input());
  store.createPin(input({ targets: [{ selector: "main > h1.title", label: "h1" }] }));
  const other = store.createPin(input({ url: "https://crm.koglabs.com/pricing" }));
  store.transition(first.id, "resolve", { summary: "Fixed" });
  const ids = async (query) => {
    const response = await request(`/api/pins?${query}`);
    assert.equal(response.status, 200, query);
    return response.data.pins.map((pin) => pin.id);
  };
  const selector = encodeURIComponent("main > h1");
  assert.deepEqual(await ids(`selector=${selector}&status=all`), [other.id, first.id]);
  assert.deepEqual(await ids(`host=crete.koglabs.com&selector=${selector}&status=done&limit=10`), [first.id]);
  assert.deepEqual(await ids(`selector=${encodeURIComponent("main > h")}&status=all`), []);
  assert.deepEqual(await ids(`selector=${"a".repeat(500)}`), []);
  assert.deepEqual(await ids("selector="), [other.id, 2]);
  const long = await request(`/api/pins?selector=${"a".repeat(501)}`);
  assert.deepEqual([long.status, long.data.error], [400, "selector is longer than 500 characters"]);
});

test("POST /api/pins/:id/progress: an agent on a working pin gets 201; a user 403; not working or 40 steps 409", async (t) => {
  const { request, store } = await fixture(t);
  const { id } = store.createPin(input());
  const path = `/api/pins/${id}/progress`;
  const early = await request(path, { method: "POST", headers: agent, body: { text: "Too early" } });
  assert.deepEqual([early.status, early.data.error], [409, `pin #${id} is queued`]);
  store.transition(id, "start", { agent: "claude", run: "triad:7" });
  for (const headers of [{}, { "X-SSO-User": "sam" }]) {
    const refused = await request(path, { method: "POST", headers, body: { text: "I am the user" } });
    assert.deepEqual([refused.status, refused.data.error], [403, "only an agent can post progress"]);
  }
  for (const text of [undefined, null, "", " ", 5, "x".repeat(201)]) {
    assert.equal((await request(path, { method: "POST", headers: agent, body: { text } })).status, 400, String(text).slice(0, 20));
  }
  assert.equal((await request(path, { method: "POST", headers: { ...agent, Origin: "https://ai.koglabs.com" }, body: { text: "x" } })).status, 403);
  assert.equal((await request(path, { method: "POST", headers: { ...agent, "Content-Type": "text/plain" }, raw: "{}" })).status, 415);
  assert.equal((await request("/api/pins/999/progress", { method: "POST", headers: agent, body: { text: "x" } })).status, 404);
  const wrong = await request(path);
  assert.deepEqual([wrong.status, wrong.headers.allow], [405, "POST"]);
  assert.deepEqual(store.listSteps(id), []);

  const seen = [];
  store.on("change", (event) => seen.push(event));
  const added = await request(path, { method: "POST", headers: agent, body: { text: "  Found the code in app/page.tsx  " } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.step, { id: 1, pinId: id, author: "claude", body: "Found the code in app/page.tsx", createdAt: added.data.step.createdAt });
  assert.deepEqual(added.data.pin.progress, { text: "Found the code in app/page.tsx", at: added.data.step.createdAt, count: 1 });
  assert.equal(added.data.pin.status, "working");
  assert.deepEqual(seen, [{ type: "pin", action: "updated", pin: added.data.pin }]);
  const second = await request(path, { method: "POST", headers: agent, body: { text: "x".repeat(200) } });
  assert.equal(second.data.pin.progress.count, 2);
  const detail = await request(`/api/pins/${id}`);
  assert.deepEqual(detail.data, { pin: second.data.pin, replies: [], steps: [added.data.step, second.data.step] });
  assert.equal((await request(`/api/pins?status=working`)).data.pins[0].progress.count, 2);

  for (let i = 2; i < 40; i++) store.addStep(id, { author: "claude", body: `Step ${i + 1}` });
  const full = await request(path, { method: "POST", headers: agent, body: { text: "One too many" } });
  assert.equal(full.status, 409);
  assert.match(full.data.error, /40 steps/);
  assert.equal((await request(`/api/pins/${id}`)).data.steps.length, 40);
  await request(`/api/pins/${id}/reopen`, { method: "POST", headers: agent, body: {} });
  await request(`/api/pins/${id}/start`, { method: "POST", headers: agent, body: {} });
  const fresh = (await request(`/api/pins/${id}`)).data;
  assert.deepEqual([fresh.steps, fresh.pin.progress], [[], null]);
});

test("PUT /api/pins/:id/shots/:kind: agents on loopback only; type, size and first bytes are checked", async (t) => {
  const { request, put, workingPin, store, shots } = await fixture(t);
  const id = await workingPin();
  const path = `/api/pins/${id}/shots/before`;
  for (const forwarded of ["203.0.113.9", ""]) {
    const remote = await put(path, png, { ...agent, "Content-Type": "image/png", "X-Forwarded-For": forwarded });
    assert.deepEqual([remote.status, remote.data.error], [403, "shot upload is local only"]);
  }
  for (const headers of [{}, { "X-SSO-User": "sam" }]) {
    const user = await put(path, png, { ...headers, "Content-Type": "image/png" });
    assert.deepEqual([user.status, user.data.error], [403, "only an agent can upload a shot"]);
  }
  for (const type of [undefined, "application/json", "image/gif", "text/plain", "image/svg+xml"]) {
    assert.equal((await put(path, png, { ...agent, ...(type ? { "Content-Type": type } : {}) })).status, 415, String(type));
  }
  const big = Buffer.concat([png, Buffer.alloc(SHOT_MAX - png.length + 1)]);
  assert.equal((await put(path, big)).status, 413);
  assert.equal((await request(path, { method: "PUT", chunks: [png, Buffer.alloc(SHOT_MAX)], headers: { ...agent, "Content-Type": "image/png" } })).status, 413);
  for (const [type, bytes] of [["image/png", jpeg], ["image/jpeg", png], ["image/webp", jpeg], ["image/png", Buffer.alloc(0)], ["image/png", Buffer.from("<svg onload=alert(1)>")]]) {
    assert.equal((await put(path, bytes, { ...agent, "Content-Type": type })).status, 400, type);
  }
  assert.equal((await put(path, png, { ...agent, "Content-Type": "image/png", Origin: "https://ai.koglabs.com" })).status, 403);
  assert.equal((await put(path, png, { ...agent, "Content-Type": "image/png", Host: "evil.example" })).status, 403);
  assert.equal((await put(path, png, { "X-Pins-Agent": "", "Content-Type": "image/png" })).status, 400);
  for (const missing of ["/api/pins/999/shots/before", `/api/pins/${id}/shots/middle`, `/api/pins/${id}/shots`, `/api/pins/${id}/shots/before/x`, "/api/pins/0/shots/before"]) {
    assert.equal((await put(missing, png)).status, 404, missing);
  }
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const wrong = await request(path, { method, headers: agent });
    assert.deepEqual([wrong.status, wrong.headers.allow], [405, "GET, PUT"], method);
  }
  assert.deepEqual(store.getPin(id).shots, { before: null, after: null });
  assert.deepEqual(readdirSync(join(shots, "..")), [], "a refused upload writes no file");

  const seen = [];
  store.on("change", (event) => seen.push(event));
  const saved = await put(path, png);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers["cache-control"], "no-store");
  assert.equal(new Date(saved.data.pin.shots.before).toISOString(), saved.data.pin.shots.before);
  assert.equal(saved.data.pin.shots.after, null);
  assert.deepEqual(seen, [{ type: "pin", action: "updated", pin: saved.data.pin }]);
  assert.equal((await put(`/api/pins/${id}/shots/after`, jpeg, { ...agent, "Content-Type": "image/jpeg; charset=binary" })).status, 200);
  assert.equal((await put(path, webp, { ...agent, "Content-Type": "IMAGE/WEBP" })).status, 200);
  const full = Buffer.concat([png, Buffer.alloc(SHOT_MAX - png.length, 9)]);
  assert.equal((await put(path, full)).status, 200, "exactly 2 MiB is allowed");
  assert.ok(store.getShot(id, "before").bytes.equals(full));
  assert.deepEqual(readdirSync(shots).sort(), [`${id}-after`, `${id}-before`]);
});

test("a shot upload takes a token from the shared write bucket", async (t) => {
  const { put, workingPin } = await fixture(t, { writeLimit: { capacity: 1, perMs: 60000 } });
  const id = await workingPin();
  assert.equal((await put(`/api/pins/${id}/shots/before`, png)).status, 200);
  const limited = await put(`/api/pins/${id}/shots/after`, png);
  assert.equal(limited.status, 429);
  assert.match(limited.headers["retry-after"], /^[1-9][0-9]*$/);
});

test("binary round trip: GET returns the uploaded bytes with the contract headers; 404 when none", async (t) => {
  const { request, put, workingPin } = await fixture(t);
  const id = await workingPin();
  const path = `/api/pins/${id}/shots/after`;
  const none = await request(path);
  assert.deepEqual([none.status, none.data.error], [404, "shot not found"]);
  for (const [type, bytes] of [["image/png", png], ["image/jpeg", jpeg], ["image/webp", webp]]) {
    assert.equal((await put(path, bytes, { ...agent, "Content-Type": type })).status, 200);
    // The browser reads it through Caddy: a user, with X-Forwarded-For.
    const shot = await request(path, { headers: { "X-SSO-User": "sam", "X-Forwarded-For": "203.0.113.9" } });
    assert.equal(shot.status, 200);
    assert.ok(shot.bytes.equals(bytes), `${type} bytes are identical`);
    assert.equal(shot.headers["content-type"], type);
    assert.equal(shot.headers["content-length"], String(bytes.length));
    assert.equal(shot.headers["cache-control"], "private, no-cache");
    assert.equal(shot.headers["content-security-policy"], "default-src 'none'");
    assert.equal(shot.headers["x-content-type-options"], "nosniff");
  }
  assert.equal((await request(`/api/pins/${id}/shots/before`)).status, 404, "the other kind stays empty");
  assert.equal((await request("/api/pins/999/shots/after")).status, 404);
  assert.equal((await request(path, { headers: { Origin: "https://evil.example" } })).status, 403);
  await request(`/api/pins/${id}/reopen`, { method: "POST", headers: agent, body: {} });
  assert.equal((await request(path)).status, 200, "reopen keeps the shot");
  const restarted = await request(`/api/pins/${id}/start`, { method: "POST", headers: agent, body: {} });
  assert.deepEqual(restarted.data.pin.shots, { before: null, after: null });
  assert.equal((await request(path)).status, 404, "a new run starts without shots");
  assert.equal((await put(path, png)).status, 200);
  assert.equal((await request(`/api/pins/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await request(path)).status, 404);
});
