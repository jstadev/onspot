import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";

const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing#top", note: "Cut the space", targets: [{ selector: "h1", label: 'h1 "Pricing"' }], ...extra });

async function fixture(t, options = {}) {
  const store = openStore({ file: ":memory:" });
  const app = createApp({ store, version: "test-version", ...options });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const port = server.address().port;
  function request(path, { method = "GET", body, raw, chunks, headers = {} } = {}) {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const sentHeaders = { Host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers };
    if (data !== undefined && !chunks) sentHeaders["Content-Length"] = Buffer.byteLength(data);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: sentHeaders, setHost: false, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part) => { text += part; });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, data: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
      else req.end(data);
    });
  }
  return { request, store, port };
}

test("health, create, all list filters, stats, get with replies, and delete", async (t) => {
  const { request } = await fixture(t);
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { ok: true, version: "test-version", extension: null, open: { queued: 0, working: 0, waiting: 0 } });
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  const pins = [];
  for (const extra of [
    { note: "space 100%_ exact" },
    { url: "https://crm.koglabs.com/contact", note: "Contact" },
    { url: "https://crete.koglabs.com/contact", note: "Contact space" },
    { note: "Closed" }, { note: "Dismissed" },
  ]) {
    const response = await request("/api/pins", { method: "POST", body: input(extra) });
    assert.equal(response.status, 201);
    pins.push(response.data.pin);
  }
  assert.equal(pins[0].author, "user");
  assert.equal(pins[0].url, "https://crete.koglabs.com/pricing");
  await request("/api/pins/2/start", { method: "POST", body: {} });
  await request("/api/pins/3/ask", { method: "POST", body: { question: "Which size?" } });
  await request("/api/pins/4/resolve", { method: "POST", body: { summary: "Fixed" } });
  await request("/api/pins/5/dismiss", { method: "POST", body: {} });
  for (const [query, ids] of [
    ["", [3, 2, 1]], ["?status=all", [5, 4, 3, 2, 1]],
    ["?status=done,dismissed", [5, 4]], ["?status=working", [2]], ["?status=waiting", [3]],
    ["?host=CRETE.koglabs.com", [3, 1]], ["?path=%2Fcontact", [3, 2]],
    ["?q=space", [3, 1]], ["?q=100%25_", [1]], ["?q=%27%20OR%201%3D1", []],
    ["?limit=1", [3]], ["?before=3", [2, 1]],
    ["?host=crete.koglabs.com&path=%2Fpricing&q=space&before=3&limit=1", [1]],
  ]) {
    const response = await request(`/api/pins${query}`);
    assert.equal(response.status, 200, query);
    assert.deepEqual(response.data.pins.map((pin) => pin.id), ids, query);
  }
  assert.deepEqual((await request("/api/health")).data.open, { queued: 1, working: 1, waiting: 1 });
  const stats = (await request("/api/stats")).data;
  assert.deepEqual(stats.total, { queued: 1, working: 1, waiting: 1, done: 1, dismissed: 1 });
  assert.equal(stats.hosts.find((row) => row.host === "crete.koglabs.com").waiting, 1);
  assert.equal(stats.hosts.find((row) => row.host === "crm.koglabs.com").working, 1);
  const reply = await request("/api/pins/1/replies", { method: "POST", body: { body: "Also mobile" } });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.pin.replyCount, 1);
  const detail = await request("/api/pins/1");
  assert.equal(detail.status, 200);
  assert.equal(detail.data.pin.replyCount, 1);
  assert.deepEqual(detail.data.replies, [reply.data.reply]);
  const deleted = await request("/api/pins/1", { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, "");
  for (const [method, path, body] of [
    ["GET", "/api/pins/1"], ["DELETE", "/api/pins/1"], ["PATCH", "/api/pins/1", { note: "x" }],
    ["POST", "/api/pins/1/start", {}], ["POST", "/api/pins/1/replies", { body: "x" }], ["POST", "/api/pins/1/ask", { question: "Which size?" }],
  ]) assert.equal((await request(path, { method, body })).status, 404);
});

test("note edits, validation rollback, and every status transition and conflict", async (t) => {
  const { request } = await fixture(t);
  const created = await request("/api/pins", { method: "POST", body: input() });
  const id = created.data.pin.id;
  const patched = await request(`/api/pins/${id}`, { method: "PATCH", body: { note: "  New note  " } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.pin.note, "New note");
  await request(`/api/pins/${id}/start`, { method: "POST", body: {} });
  assert.equal((await request(`/api/pins/${id}`, { method: "PATCH", body: { note: "No" } })).status, 409);
  assert.equal((await request(`/api/pins/${id}/resolve`, { method: "POST", body: {} })).status, 400);
  assert.equal((await request(`/api/pins/${id}`)).data.pin.status, "working");

  const allowed = {
    start: ["queued"], resolve: ["queued", "working", "waiting"], dismiss: ["queued", "working", "waiting"],
    ask: ["queued", "working"], reopen: ["working", "waiting", "done", "dismissed"],
  };
  const next = { start: "working", resolve: "done", dismiss: "dismissed", ask: "waiting", reopen: "queued" };
  for (const state of ["queued", "working", "waiting", "done", "dismissed"]) {
    for (const action of Object.keys(allowed)) {
      const { data } = await request("/api/pins", { method: "POST", body: input() });
      const path = `/api/pins/${data.pin.id}`;
      const payload = { summary: "Space fixed", commit: "a1b2c3d", reason: "Duplicate", question: "Which size?", run: "triad:42" };
      if (state !== "queued") {
        const setup = { working: "start", waiting: "ask", done: "resolve", dismissed: "dismiss" }[state];
        await request(`${path}/${setup}`, { method: "POST", body: payload, headers: { "X-Pins-Agent": "codex" } });
      }
      const before = (await request(path)).data;
      const changed = await request(`${path}/${action}`, { method: "POST", body: payload, headers: { "X-Pins-Agent": "codex" } });
      const valid = allowed[action].includes(state);
      assert.equal(changed.status, valid ? 200 : 409, `${state} -> ${action}`);
      if (!valid) {
        assert.deepEqual((await request(path)).data, before);
        continue;
      }
      const pin = changed.data.pin;
      assert.equal(pin.status, next[action]);
      if (action === "start") { assert.equal(pin.agent, "codex"); assert.equal(pin.run, "triad:42"); assert.ok(pin.startedAt); }
      if (action === "resolve") {
        assert.equal(pin.summary, "Space fixed");
        assert.equal(pin.commit, "a1b2c3d");
        assert.equal(pin.agent, "codex");
        assert.ok(pin.closedAt);
        assert.equal((await request(path)).data.replies.at(-1).body, "Done: Space fixed (a1b2c3d)");
      }
      if (action === "dismiss") {
        assert.equal(pin.summary, "Duplicate");
        assert.ok(pin.closedAt);
        assert.equal((await request(path)).data.replies.at(-1).body, "Dismissed: Duplicate");
      }
      if (action === "ask") {
        assert.equal(pin.agent, before.pin.agent);
        assert.equal(pin.run, before.pin.run);
        const reply = (await request(path)).data.replies.at(-1);
        assert.equal(reply.body, "Which size?");
        assert.equal(reply.kind, "agent");
        assert.equal(reply.author, "codex");
      }
      if (action === "reopen") {
        for (const field of ["agent", "summary", "commit", "run", "startedAt", "closedAt"]) assert.equal(pin[field], null, field);
      }
    }
  }
});

test("actors come from headers, including automatic replies", async (t) => {
  const { request } = await fixture(t);
  for (const [headers, author, kind] of [
    [{ "X-Pins-Agent": "  codex  ", "X-SSO-User": "ignored" }, "codex", "agent"],
    [{ "X-SSO-User": "sam" }, "sam", "user"], [{}, "user", "user"],
  ]) {
    const created = await request("/api/pins", { method: "POST", headers, body: input({ author: "forged" }) });
    assert.equal(created.data.pin.author, author);
    const path = `/api/pins/${created.data.pin.id}`;
    const reply = await request(`${path}/replies`, { method: "POST", headers, body: { body: "Reply", author: "forged", kind: "forged" } });
    assert.equal(reply.data.reply.kind, kind);
    assert.equal(reply.data.reply.author, author);
    const start = await request(`${path}/start`, { method: "POST", headers, body: { agent: "forged" } });
    assert.equal(start.data.pin.agent, kind === "agent" ? author : null);
    const asked = await request(`${path}/ask`, { method: "POST", headers, body: { question: "Which size?", author: "forged", kind: "forged", agent: "forged" } });
    assert.equal(asked.status, 200);
    assert.equal(asked.data.pin.status, "waiting");
    const resolved = await request(`${path}/resolve`, { method: "POST", headers, body: { summary: "Fixed", author: "forged", kind: "forged", agent: "forged" } });
    assert.equal(resolved.data.pin.agent, kind === "agent" ? author : null);
    await request(`${path}/reopen`, { method: "POST", headers, body: {} });
    await request(`${path}/dismiss`, { method: "POST", headers, body: { reason: "Duplicate" } });
    const replies = (await request(path)).data.replies;
    assert.deepEqual(replies.map(({ author: who, kind: type }) => [who, type]), [[author, kind], [author, kind], [author, kind], [author, kind]]);
  }
  for (const headers of [{ "X-Pins-Agent": "" }, { "X-Pins-Agent": "x".repeat(61) }, { "X-SSO-User": "x".repeat(61) }]) {
    assert.equal((await request("/api/pins", { method: "POST", headers, body: input() })).status, 400);
  }
  assert.equal((await request("/api/pins", { method: "POST", headers: { "X-Pins-Agent": "x".repeat(60) }, body: input() })).status, 201);
});

test("unknown routes and invalid ids return 404; known routes return 405 with Allow", async (t) => {
  const { request } = await fixture(t);
  for (const path of ["/unknown", "/api/unknown", "/api/pins/1/unknown", ...["0", "01", "-1", "1.2", "1e2", "abc", "1234567890123"].map((id) => `/api/pins/${id}`)]) {
    assert.equal((await request(path)).status, 404, path);
  }
  for (const [path, method, allow] of [
    ["/api/health", "POST", "GET"], ["/api/stats", "POST", "GET"],
    ["/api/pins", "PUT", "GET, POST"], ["/api/pins/1", "POST", "GET, PATCH, DELETE"],
    ["/api/settings", "POST", "GET, PATCH"], ["/api/settings", "DELETE", "GET, PATCH"],
    ["/api/events", "POST", "GET"], ...["start", "resolve", "dismiss", "ask", "reopen", "replies"].map((action) => [`/api/pins/1/${action}`, "GET", "POST"]),
  ]) {
    const response = await request(path, { method });
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.allow, allow, path);
  }
});

test("Host and Origin guards apply to all routes, including empty Origin", async (t) => {
  const { request, port } = await fixture(t);
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", "", `localhost:${port}.evil`]) {
    const response = await request("/api/health", { headers: { Host: host } });
    assert.equal(response.status, 403, host);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  assert.equal((await request("/api/health", { headers: { Host: `localhost:${port}` } })).status, 200);
  for (const path of ["/api/health", "/api/events", "/api/settings", "/api/pins/1/ask", "/", "/mcp", "/unknown"]) {
    for (const Origin of ["https://ai.koglabs.com", "null", ""]) {
      assert.equal((await request(path, { headers: { Origin } })).status, 403, `${path}: ${Origin}`);
    }
  }
});

test("body guards cover type, bytes, chunked data, JSON and store validation", async (t) => {
  const { request } = await fixture(t);
  for (const type of [undefined, "text/plain", "application/jsonp"]) {
    const response = await request("/api/pins", { method: "POST", raw: "{}", headers: type ? { "Content-Type": type } : {} });
    assert.equal(response.status, 415);
  }
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  assert.equal((await request("/api/pins", { method: "POST", raw: "{".padEnd(65537, " "), headers })).status, 413);
  assert.equal((await request("/api/pins", { method: "POST", chunks: ["{", " ".repeat(65536)], headers })).status, 413);
  const full = JSON.stringify(input());
  assert.equal((await request("/api/pins", { method: "POST", raw: full.padEnd(65536, " "), headers })).status, 201);
  assert.equal((await request("/api/pins", { method: "POST", raw: " ".repeat(65536) + "é", headers })).status, 413);
  for (const raw of ["{", " ", "null", "[]", "true", '"text"']) {
    assert.equal((await request("/api/pins", { method: "POST", raw, headers })).status, 400, raw);
  }
  for (const extra of [{ url: "https://evil.example/" }, { note: "" }, { note: "x".repeat(4001) }, { targets: [] }]) {
    assert.equal((await request("/api/pins", { method: "POST", body: input(extra) })).status, 400);
  }
  for (const query of ["status=nope", "limit=0", "limit=501", "limit=1.5", "limit=NaN", "limit=", "before=0", "before=x"]) {
    assert.equal((await request(`/api/pins?${query}`)).status, 400, query);
  }
  assert.equal((await request("/api/pins/1", { method: "PATCH", body: { note: "" } })).status, 400);
  assert.equal((await request("/api/pins/1/replies", { method: "POST", body: { body: "" } })).status, 400);
  for (const question of [undefined, null, 1, " ", "x".repeat(4001)]) {
    assert.equal((await request("/api/pins/1/ask", { method: "POST", body: { question } })).status, 400);
  }
  for (const run of [1, {}, " ", "x".repeat(201)]) {
    assert.equal((await request("/api/pins/1/start", { method: "POST", body: { run } })).status, 400);
  }
  assert.equal((await request("/api/pins/1")).data.pin.status, "queued");
  assert.equal((await request("/api/pins/1/start", { method: "POST" })).status, 200, "empty writes do not need Content-Type");
  assert.equal((await request("/api/pins/1/dismiss", { method: "POST" })).data.pin.replyCount, 0);
});

test("one token bucket covers different write routes, methods and actors", async (t) => {
  const { request } = await fixture(t, { writeLimit: { capacity: 2, perMs: 60000 } });
  assert.equal((await request("/api/pins", { method: "POST", body: input() })).status, 201);
  assert.equal((await request("/api/settings", { method: "PATCH", body: { autofix: false }, headers: { "X-Pins-Agent": "codex" } })).status, 200);
  for (const [method, path, body] of [
    ["DELETE", "/api/pins/1"], ["PATCH", "/api/pins/1", { note: "Changed" }], ["POST", "/api/pins/1/start", {}],
    ["POST", "/api/pins/1/ask", { question: "Which size?" }], ["PATCH", "/api/settings", { autofix: true }], ["POST", "/mcp", {}],
  ]) {
    const response = await request(path, { method, body });
    assert.equal(response.status, 429);
    assert.match(response.headers["retry-after"], /^[1-9][0-9]*$/);
    assert.ok(Number(response.headers["retry-after"]) <= 30);
  }
  assert.equal((await request("/api/health")).status, 200);
  assert.deepEqual((await request("/api/settings")).data, { autofix: false, bulk: { on: false, delegate: false, agents: 3 } });
});

test("user replies reopen waiting and clear the run; agent replies keep waiting", async (t) => {
  const { request } = await fixture(t);
  const { data } = await request("/api/pins", { method: "POST", body: input() });
  const path = `/api/pins/${data.pin.id}`;
  const headers = { "X-Pins-Agent": "codex" };
  await request(`${path}/start`, { method: "POST", headers, body: { run: "triad:42" } });
  await request(`${path}/ask`, { method: "POST", headers, body: { question: "Which size?" } });
  const agent = await request(`${path}/replies`, { method: "POST", headers, body: { body: "Still checking", kind: "user" } });
  assert.equal(agent.status, 201);
  assert.equal(agent.data.pin.status, "waiting");
  assert.equal(agent.data.pin.run, "triad:42");
  assert.equal(agent.data.reply.kind, "agent");
  const user = await request(`${path}/replies`, { method: "POST", headers: { "X-SSO-User": "sam" }, body: { body: "24 pixels", kind: "agent" } });
  assert.equal(user.status, 201);
  assert.equal(user.data.pin.status, "queued");
  assert.equal(user.data.pin.replyCount, 3);
  assert.equal(user.data.reply.kind, "user");
  assert.equal(user.data.reply.author, "sam");
  for (const field of ["agent", "summary", "commit", "run", "startedAt", "closedAt"]) assert.equal(user.data.pin[field], null, field);
  assert.deepEqual((await request("/api/health")).data.open, { queued: 1, working: 0, waiting: 0 });
});

test("settings read and patch enforce the contract and existing write guards", async (t) => {
  const { request } = await fixture(t);
  const initial = await request("/api/settings");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, { autofix: true, bulk: { on: false, delegate: false, agents: 3 } });
  assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.headers["x-content-type-options"], "nosniff");
  for (const autofix of [false, true, false]) {
    const response = await request("/api/settings", { method: "PATCH", body: { autofix } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { autofix, bulk: { on: false, delegate: false, agents: 3 } });
    assert.deepEqual((await request("/api/settings")).data, { autofix, bulk: { on: false, delegate: false, agents: 3 } });
  }
  for (const body of [undefined, null, false, [], {}, { other: true }, { autofix: 0 }, { autofix: "false" }, { autofix: null }, { autofix: true, other: false }]) {
    assert.equal((await request("/api/settings", { method: "PATCH", body })).status, 400, JSON.stringify(body));
  }
  for (const [path, method, body] of [["/api/settings", "PATCH", { autofix: true }], ["/api/pins/1/ask", "POST", { question: "Which size?" }]]) {
    for (const headers of [{ Host: "evil.example" }, { Origin: "https://ai.koglabs.com" }]) {
      assert.equal((await request(path, { method, body, headers })).status, 403);
    }
    assert.equal((await request(path, { method, body, headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await request(path, { method, raw: "{", headers: { "Content-Type": "application/json" } })).status, 400);
    assert.equal((await request(path, { method, raw: " ".repeat(65537), headers: { "Content-Type": "application/json" } })).status, 413);
    assert.equal((await request(path, { method, body, headers: { "X-Pins-Agent": "" } })).status, 400);
  }
  assert.deepEqual((await request("/api/settings")).data, { autofix: false, bulk: { on: false, delegate: false, agents: 3 } });
});

test("MCP has a local guard, POST only, strict JSON, a 1 MiB limit and parsed-value delegation", async (t) => {
  const seen = [];
  const { request } = await fixture(t, { mcpHandler: async (req, res, body) => {
    await Promise.resolve();
    seen.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: body }));
  } });
  for (const forwarded of ["1.2.3.4", ""]) {
    assert.equal((await request("/mcp", { method: "POST", body: {}, headers: { "X-Forwarded-For": forwarded } })).status, 403);
  }
  const get = await request("/mcp");
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
  assert.equal((await request("/mcp", { method: "POST" })).status, 415);
  assert.equal((await request("/mcp", { method: "POST", raw: "{}", headers: { "Content-Type": "text/plain" } })).status, 415);
  const headers = { "Content-Type": "application/json" };
  for (const raw of ["{", ""]) {
    const bad = await request("/mcp", { method: "POST", raw, headers });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.data, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  assert.equal((await request("/mcp", { method: "POST", raw: "{}".padEnd(1024 * 1024 + 1, " "), headers })).status, 413);
  assert.equal((await request("/mcp", { method: "POST", chunks: ["{}", " ".repeat(1024 * 1024)], headers })).status, 413);
  assert.deepEqual(seen, []);
  const response = await request("/mcp?x=1", { method: "POST", raw: "{}".padEnd(1024 * 1024, " "), headers });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { received: {} });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal((await request("/mcp", { method: "POST", body: null })).status, 200);
  assert.deepEqual(seen, [{}, null]);
});

test("unexpected store and asynchronous MCP errors return a generic 500 and one stderr line", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (line) => logs.push(line));
  const { request, store } = await fixture(t, { mcpHandler: async () => { throw new Error("mcp failed\nprivate detail"); } });
  t.mock.method(store, "stats", () => { throw Object.assign(new Error("database failed\nprivate detail"), { status: 503 }); });
  for (const [path, options] of [["/api/health", {}], ["/mcp", { method: "POST", body: {} }]]) {
    const response = await request(path, options);
    assert.equal(response.status, 500);
    assert.deepEqual(response.data, { error: "internal error" });
  }
  assert.equal(logs.length, 2);
  for (const line of logs) assert.ok(!line.includes("\n"));
});
