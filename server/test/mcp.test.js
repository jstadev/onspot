import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter, once } from "node:events";
import { openStore } from "../src/store.js";
import { createMcpHandler } from "../src/mcp.js";

const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", title: "Pricing", note: "Fix spacing", targets: [{ selector: "h1", label: 'h1 "Pricing"' }], ...extra });

async function fixture(t) {
  const store = openStore({ file: ":memory:" });
  const handler = createMcpHandler({ store, version: "test" });
  const events = new EventEmitter();
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const pending = handler(req, res, body);
      events.emit("handling", { req, res, body });
      await pending;
      events.emit("handled", { req, res, body });
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  async function post(body) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  }
  const rpc = async (method, params = {}, id = 1) => (await post({ jsonrpc: "2.0", id, method, params })).body;
  const call = async (name, args = {}) => rpc("tools/call", { name, arguments: args });
  return { store, server, events, url, post, rpc, call };
}
const textOf = (reply) => reply.result.content[0].text;

test("initialize negotiates every supported version and falls back for unknown versions", async (t) => {
  const f = await fixture(t);
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "unknown"]) {
    const reply = await f.post({ jsonrpc: "2.0", id: "hello", method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("content-type"), "application/json");
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
    assert.equal(reply.body.id, "hello");
    assert.equal(reply.body.result.protocolVersion, version === "unknown" ? "2025-06-18" : version);
    assert.deepEqual(reply.body.result.capabilities, { tools: {} });
    assert.deepEqual(reply.body.result.serverInfo, { name: "pins", version: "test" });
    assert.match(reply.body.result.instructions, /list.*start.*fix.*deploy.*resolve.*commit/i);
  }
});

test("notifications return 202 with no body; ping returns an empty result", async (t) => {
  const f = await fixture(t);
  for (const method of ["notifications/initialized", "ping", "unknown"]) {
    const reply = await f.post({ jsonrpc: "2.0", method });
    assert.equal(reply.status, 202);
    assert.equal(reply.text, "");
  }
  assert.deepEqual(await f.rpc("ping", {}, 0), { jsonrpc: "2.0", id: 0, result: {} });
  assert.deepEqual(await f.rpc("ping", {}, null), { jsonrpc: "2.0", id: null, result: {} });
});

test("tools/list exposes ten described tools with closed input schemas", async (t) => {
  const { rpc } = await fixture(t);
  const { tools } = (await rpc("tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), ["pins_list", "pins_get", "pins_start", "pins_resolve", "pins_dismiss", "pins_ask", "pins_reopen", "pins_reply", "pins_progress", "pins_wait"]);
  for (const tool of tools) {
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const key of tool.inputSchema.required) assert.ok(Object.hasOwn(tool.inputSchema.properties, key));
  }
  const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
  assert.equal(schemas.pins_list.properties.limit.maximum, 100);
  assert.equal(schemas.pins_list.properties.limit.default, 30);
  assert.equal(schemas.pins_list.properties.status.default, "open");
  assert.match(schemas.pins_list.properties.status.description, /waiting/);
  assert.deepEqual(schemas.pins_ask.required, ["id", "question"]);
  assert.equal(schemas.pins_wait.properties.timeoutSec.default, 120);
  assert.equal(schemas.pins_wait.properties.timeoutSec.maximum, 600);
  assert.equal(schemas.pins_progress.properties.text.maxLength, 200);
  assert.deepEqual(schemas.pins_progress.required, ["id", "text"]);
  for (const name of ["start", "resolve", "reply", "dismiss", "ask", "progress"]) assert.equal(schemas[`pins_${name}`].properties.agent.maxLength, 60);
});

test("pins_ask waits from queued or working, preserves the run and appears in the default list", async (t) => {
  const { store, call } = await fixture(t);
  for (const working of [false, true]) {
    const { id } = store.createPin(input());
    if (working) store.transition(id, "start", { agent: "codex", run: "triad:42" });
    const asked = await call("pins_ask", { id, question: "Which size?", ...(working ? { agent: "reviewer" } : {}) });
    assert.equal(asked.result.isError, undefined);
    assert.equal(textOf(asked), `#${id} waiting`);
    assert.equal(store.getPin(id).agent, working ? "codex" : null);
    assert.equal(store.getPin(id).run, working ? "triad:42" : null);
    const reply = store.listReplies(id)[0];
    assert.equal(reply.body, "Which size?");
    assert.equal(reply.kind, "agent");
    assert.equal(reply.author, working ? "reviewer" : "agent");
    assert.ok(textOf(await call("pins_list")).includes(`#${id} waiting`));
    if (working) assert.match(textOf(await call("pins_get", { id })), /run: triad:42/);
    await call("pins_reply", { id, body: "Still checking" });
    assert.equal(store.getPin(id).status, "waiting");
    assert.equal(textOf(await call("pins_reopen", { id })), `#${id} queued`);
    assert.equal(store.getPin(id).run, null);
  }
});

test("every immediate tool performs its real store operation and sets the actor", async (t) => {
  const { store, call } = await fixture(t);
  assert.equal(textOf(await call("pins_list")), "no pins");
  const pin = store.createPin(input());
  assert.match(textOf(await call("pins_list")), /#1 queued crete.koglabs.com\/pricing/);
  assert.match(textOf(await call("pins_get", { id: pin.id })), /note: Fix spacing\ntarget 1: h1 "Pricing"/);
  assert.equal(textOf(await call("pins_start", { id: pin.id, agent: "codex" })), "#1 working");
  assert.equal(store.getPin(pin.id).agent, "codex");
  assert.equal(textOf(await call("pins_reply", { id: pin.id, body: "Checking mobile", agent: "reviewer" })), "reply added to #1");
  assert.equal(store.listReplies(pin.id)[0].author, "reviewer");
  assert.equal(store.listReplies(pin.id)[0].kind, "agent");
  assert.equal(textOf(await call("pins_resolve", { id: pin.id, summary: "Spacing fixed", commit: "abc123", agent: "builder" })), "#1 done");
  const done = store.getPin(pin.id);
  assert.equal(done.summary, "Spacing fixed");
  assert.equal(done.commit, "abc123");
  assert.equal(done.agent, "builder");
  assert.equal(store.listReplies(pin.id).at(-1).author, "builder");
  assert.match(textOf(await call("pins_get", { id: pin.id })), /agent: builder\nsummary: Spacing fixed\ncommit: abc123/);
  assert.equal(textOf(await call("pins_list")), "no pins");
  assert.equal(textOf(await call("pins_reopen", { id: pin.id })), "#1 queued");
  assert.equal(store.getPin(pin.id).agent, null);
  assert.equal(textOf(await call("pins_dismiss", { id: pin.id, reason: "Duplicate", agent: "triage" })), "#1 dismissed");
  assert.equal(store.listReplies(pin.id).at(-1).body, "Dismissed: Duplicate");
  assert.equal(store.listReplies(pin.id).at(-1).author, "triage");
  await call("pins_reopen", { id: pin.id });
  await call("pins_start", { id: pin.id });
  assert.equal(store.getPin(pin.id).agent, "agent");
  await call("pins_reply", { id: pin.id, body: "Default actor" });
  assert.equal(store.listReplies(pin.id).at(-1).author, "agent");
  await call("pins_resolve", { id: pin.id, summary: "Done" });
  assert.equal(store.getPin(pin.id).agent, "agent");
  await call("pins_reopen", { id: pin.id });
  await call("pins_dismiss", { id: pin.id, reason: "Default actor" });
  assert.equal(store.listReplies(pin.id).at(-1).author, "agent");
});

test("list applies host, path, status, explicit limit and default limit", async (t) => {
  const { store, call } = await fixture(t);
  for (let i = 0; i < 32; i++) store.createPin(input());
  const other = store.createPin(input({ url: "https://crm.koglabs.com/other" }));
  store.transition(other.id, "resolve", { summary: "done" });
  assert.equal(textOf(await call("pins_list")).split("\n").length, 60);
  assert.match(textOf(await call("pins_list", { host: "CRM.koglabs.com", path: "/other", status: "done", limit: 1 })), /^#33 done crm.koglabs.com\/other/);
  assert.equal(textOf(await call("pins_list", { host: "crm.koglabs.com", path: "/pricing", status: "all" })), "no pins");
  assert.equal(textOf(await call("pins_list", { limit: 2 })).split("\n").length, 4);
});

test("conflicts, missing pins and store validation become plain tool errors", async (t) => {
  const { store, call } = await fixture(t);
  const { id } = store.createPin(input());
  await call("pins_resolve", { id, summary: "Fixed" });
  for (const [name, args] of [["pins_start", {}], ["pins_ask", { question: "Which size?" }]]) {
    const conflict = await call(name, { id, ...args });
    assert.equal(conflict.result.isError, true);
    assert.equal(textOf(conflict), "pin #1 is done");
  }
  for (const [name, args] of [["pins_get", {}], ["pins_start", {}], ["pins_resolve", { summary: "x" }], ["pins_dismiss", { reason: "x" }], ["pins_reopen", {}], ["pins_reply", { body: "x" }], ["pins_ask", { question: "Which size?" }]]) {
    const missing = await call(name, { id: 999, ...args });
    assert.equal(missing.result.isError, true);
    assert.equal(textOf(missing), "pin #999 not found");
  }
  const invalid = await call("pins_list", { status: "nonsense" });
  assert.equal(invalid.result.isError, true);
  assert.equal(textOf(invalid), 'unknown status "nonsense"');
});

test("tool arguments reject missing fields, wrong types, unknown keys and bounds without writes", async (t) => {
  const { store, call } = await fixture(t);
  store.createPin(input());
  const cases = [
    ["pins_get", {}], ["pins_get", { id: "1" }], ["pins_get", { id: 0 }], ["pins_get", { id: 1.5 }], ["pins_get", { id: 1000000000000 }],
    ["pins_start", { id: 1, agent: " " }], ["pins_start", { id: 1, agent: "a".repeat(61) }], ["pins_start", { id: 1, agent: null }],
    ["pins_resolve", { id: 1 }], ["pins_resolve", { id: 1, summary: " " }], ["pins_resolve", { id: 1, summary: 3 }],
    ["pins_resolve", { id: 1, summary: "x".repeat(4001) }], ["pins_resolve", { id: 1, summary: "x", commit: "a".repeat(201) }],
    ["pins_dismiss", { id: 1 }], ["pins_reply", { id: 1, body: [] }], ["pins_reply", { id: 1, body: "x", agent: false }],
    ["pins_ask", { id: 1 }], ["pins_ask", { id: 1, question: " " }], ["pins_ask", { id: 1, question: null }],
    ["pins_ask", { id: 1, question: "x".repeat(4001) }], ["pins_ask", { id: 1, question: "Which size?", agent: false }],
    ["pins_ask", { id: 1, question: "Which size?", extra: true }],
    ["pins_list", { host: false }], ["pins_list", { path: 4 }], ["pins_list", { status: [] }], ["pins_list", { limit: 101 }],
    ["pins_list", { limit: 0 }], ["pins_list", { limit: 1.1 }], ["pins_list", { extra: true }],
    ["pins_wait", { timeoutSec: -1 }], ["pins_wait", { timeoutSec: 601 }], ["pins_wait", { timeoutSec: "1" }],
    ["pins_get", null], ["pins_get", []], ["pins_get", "bad"],
  ];
  for (const [name, args] of cases) {
    const reply = await call(name, args);
    assert.equal(reply.error, undefined, `${name}: protocol must remain valid`);
    assert.equal(reply.result.isError, true, `${name}: ${JSON.stringify(args)}`);
    assert.equal(reply.result.content[0].type, "text");
    assert.ok(textOf(reply).length);
  }
  assert.equal(store.getPin(1).status, "queued");
  assert.equal(store.listReplies(1).length, 0);
});

test("JSON-RPC distinguishes invalid requests, invalid params and unknown methods/tools", async (t) => {
  const { post, rpc } = await fixture(t);
  for (const body of [null, 1, "hello", [], {}, { jsonrpc: "1.0", id: 4, method: "ping" }, { jsonrpc: "2.0", id: true, method: "ping" }, { jsonrpc: "2.0", id: 1, method: 4 }]) {
    assert.deepEqual((await post(body)).body, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  assert.equal((await rpc("unknown")).error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "unknown" })).error.code, -32602);
  assert.equal((await rpc("tools/call", {})).error.code, -32602);
  assert.equal((await rpc("tools/list", 1)).error.code, -32602);
  assert.equal((await rpc("ping", [])).error.code, -32602);
  assert.equal((await rpc("initialize", { protocolVersion: 1 })).error.code, -32602);
});

test("batches omit notifications and retain invalid entry errors", async (t) => {
  const { post } = await fixture(t);
  const reply = await post([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    17,
    { jsonrpc: "2.0", id: "bad", method: "unknown" },
  ]);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.length, 3);
  assert.deepEqual(reply.body[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(reply.body[1].error.code, -32600);
  assert.equal(reply.body[2].error.code, -32601);
  const notifications = await post([{ jsonrpc: "2.0", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal(notifications.status, 202);
  assert.equal(notifications.text, "");
});

test("pins_wait survives body completion, ignores other hosts and returns a new pin", { timeout: 5000 }, async (t) => {
  const { store, call, events } = await fixture(t);
  const started = once(events, "handling");
  const waiting = call("pins_wait", { host: "CRM.koglabs.com", timeoutSec: 2 });
  await started;
  store.createPin(input());
  const next = store.createPin(input({ url: "https://crm.koglabs.com/new", note: "New feedback" }));
  const reply = await waiting;
  assert.equal(reply.result.isError, undefined);
  assert.match(textOf(reply), new RegExp(`^#${next.id} queued · crm.koglabs.com/new`));
  assert.match(textOf(reply), /note: New feedback/);
});

test("pins_wait times out without a new pin", { timeout: 2000 }, async (t) => {
  const { call } = await fixture(t);
  const start = performance.now();
  assert.equal(textOf(await call("pins_wait", { timeoutSec: 0.04 })), "no new pins");
  assert.ok(performance.now() - start >= 30, "request body close must not cancel the wait");
});

test("pins_wait cancels the real store waiter when the client disconnects", { timeout: 3000 }, async (t) => {
  const { events, url } = await fixture(t);
  const started = once(events, "handling");
  const finished = once(events, "handled");
  const client = httpRequest(url, { method: "POST", headers: { "Content-Type": "application/json" } });
  client.on("error", () => {});
  client.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pins_wait", arguments: {} } }));
  const [{ res }] = await started;
  client.destroy();
  await finished;
  assert.equal(res.destroyed, true);
});

test("pins_progress adds a step to a working pin, sets the author and reports conflicts as tool errors", async (t) => {
  const { store, call } = await fixture(t);
  const { id } = store.createPin(input());
  const queued = await call("pins_progress", { id, text: "Too early" });
  assert.equal(queued.result.isError, true);
  assert.equal(textOf(queued), `pin #${id} is queued`);
  store.transition(id, "start", { agent: "claude" });
  assert.equal(textOf(await call("pins_progress", { id, text: "  Found the code  " })), `#${id} step 1`);
  assert.equal(textOf(await call("pins_progress", { id, text: "Change made", agent: "builder" })), `#${id} step 2`);
  assert.deepEqual(store.listSteps(id).map(({ author, body }) => [author, body]), [["agent", "Found the code"], ["builder", "Change made"]]);
  assert.deepEqual(store.getPin(id).progress.count, 2);
  assert.match(textOf(await call("pins_get", { id })), /\nsteps:\n  \d\d:\d\d Found the code\n  \d\d:\d\d Change made\nurl:/);
  for (const args of [{ id }, { id, text: " " }, { id, text: "x".repeat(201) }, { id, text: 5 }, { id, text: "ok", extra: 1 }]) {
    assert.equal((await call("pins_progress", args)).result.isError, true, JSON.stringify(args));
  }
  const missing = await call("pins_progress", { id: 999, text: "x" });
  assert.equal(missing.result.isError, true);
  assert.equal(textOf(missing), "pin #999 not found");
  for (let i = 2; i < 40; i++) store.addStep(id, { author: "claude", body: `step ${i + 1}` });
  const full = await call("pins_progress", { id, text: "One too many" });
  assert.equal(full.result.isError, true);
  assert.match(textOf(full), /40 steps/);
  assert.equal(store.listSteps(id).length, 40);
});
