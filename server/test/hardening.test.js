// Audit 2026-11: each test here failed before its fix. Store input, actor names, the write limit on MCP
// batches, a slow SSE client, and the server entry point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { SSE_BUFFER_MAX } from "../src/events.js";
import { formatDetail, formatList } from "../src/format.js";
import { createMcpHandler } from "../src/mcp.js";
import { openStore, ValidationError } from "../src/store.js";

const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", note: "Cut the space", targets: [{ selector: "main > h1", label: "h1" }], ...extra });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

async function fixture(t, options = {}) {
  const store = openStore({ file: ":memory:" });
  const app = createApp({ store, version: "test", mcpHandler: createMcpHandler({ store, version: "test" }), ...options });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const port = server.address().port;
  function request(path, { method = "GET", body, headers = {} } = {}) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const sent = { Host: `127.0.0.1:${port}`, ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }), ...headers };
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: sent, setHost: false, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part) => { text += part; });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      req.end(data);
    });
  }
  return { store, app, server, port, request };
}

test("captured element data: no prototype key, no number outside the safe range, no half character", () => {
  const store = openStore({ file: ":memory:" });
  const target = (extra) => ({ selector: "a", label: "a", ...extra });
  const hostile = JSON.parse('{"__proto__":"p","constructor":"c","color":"red"}');
  let pin = store.createPin(input({ targets: [target({ styles: hostile, attrs: JSON.parse('{"__proto__":"p","constructor":"c","class":"k"}') })] }));
  assert.deepEqual(Object.keys(pin.targets[0].styles), ["color"]);
  assert.deepEqual(Object.keys(pin.targets[0].attrs), ["class"]);

  // JSON carries 1e999 (Infinity after the parse) and numbers that are finite but far outside any page.
  const huge = JSON.parse('{"w":1e300,"h":900,"dpr":1.7e308,"scrollX":-1e999,"scrollY":1e999}');
  pin = store.createPin(input({ viewport: huge, targets: [target({ rect: { x: 1e300, y: 2, w: 3, h: 4 } })] }));
  assert.deepEqual(pin.viewport, { h: 900 });
  assert.equal(pin.targets[0].rect, undefined, "a box with a number outside the safe range is no box");
  pin = store.createPin(input({ viewport: { w: 1400.4, h: 900, dpr: 1.255, scrollX: 0, scrollY: 9007199254740991 }, targets: [target({ rect: { x: -3.5, y: 2, w: 3, h: 4 } })] }));
  assert.deepEqual(pin.viewport, { w: 1400, h: 900, dpr: 1.25, scrollX: 0, scrollY: 9007199254740991 });
  assert.deepEqual(pin.targets[0].rect, { x: -3, y: 2, w: 3, h: 4 });

  // A clip that lands inside an emoji drops the whole emoji.
  pin = store.createPin(input({
    title: `${"a".repeat(299)}👋`, quote: `${"q".repeat(1999)}👋`,
    targets: [target({ label: `${"l".repeat(159)}👋`, text: `${"t".repeat(299)}👋`, ancestors: [`${"n".repeat(79)}👋`], attrs: { title: `${"v".repeat(199)}👋` }, styles: { font: `${"f".repeat(119)}👋` } })],
  }));
  const { label, text, ancestors, attrs, styles } = pin.targets[0];
  assert.deepEqual([pin.title, pin.quote, label, text, ancestors[0], attrs.title, styles.font].map((value) => [value.length, value.isWellFormed(), value.includes("�")]),
    [[299, true, false], [1999, true, false], [159, true, false], [299, true, false], [79, true, false], [199, true, false], [119, true, false]]);
  // A whole emoji that fits stays.
  assert.equal(store.createPin(input({ title: `${"a".repeat(298)}👋` })).title.endsWith("👋"), true);
  // The extension cuts label at 160 and text at 300 units itself, so a value can arrive with half an emoji at
  // its end and no length left to clip. No stored string ends with half a character.
  const half = (length) => `${"x".repeat(length - 1)}👋`.slice(0, length);
  pin = store.createPin(input({
    title: half(300), quote: half(2000),
    targets: [target({ label: half(160), text: half(300), tag: half(40), ancestors: [half(80), half(12)], attrs: { title: half(200), alt: half(5) }, styles: { font: half(120), color: half(7) } })],
  }));
  const cut = pin.targets[0];
  assert.deepEqual([pin.title, pin.quote, cut.label, cut.text, cut.tag, ...cut.ancestors, cut.attrs.title, cut.attrs.alt, cut.styles.font, cut.styles.color].map((value) => [value.length, value.isWellFormed()]),
    [[299, true], [1999, true], [159, true], [299, true], [39, true], [79, true], [11, true], [199, true], [4, true], [119, true], [6, true]]);
  // A label that is only half a character is no label.
  assert.throws(() => store.createPin(input({ targets: [target({ label: "\ud83d" })] })), (error) => error instanceof ValidationError && error.message === "target label is required");
  store.close();
});

test("an optional field that is blank says so, and changes nothing", () => {
  const store = openStore({ file: ":memory:" });
  const { id } = store.createPin(input());
  for (const [action, extra, re] of [["resolve", { summary: "Fixed", commit: " " }, /^commit must not be blank$/], ["start", { run: "\t" }, /^run must not be blank$/], ["start", { model: "  " }, /^model must not be blank$/]]) {
    assert.throws(() => store.transition(id, action, extra), (error) => error instanceof ValidationError && re.test(error.message), action);
  }
  assert.equal(store.getPin(id).status, "queued");
  store.close();
});

test("settings: a patch that changes nothing writes nothing and sends no event", () => {
  const store = openStore({ file: ":memory:" });
  const seen = [];
  store.on("change", (event) => seen.push(event));
  const defaults = { autofix: true, bulk: { on: false, delegate: false, agents: 3 } };
  assert.deepEqual(store.setSettings({ autofix: true }), defaults);
  assert.deepEqual(store.setSettings({ bulk: { agents: 3 } }), defaults);
  assert.deepEqual(store.setSettings({ autofix: true, bulk: { on: false, delegate: false, agents: 3 } }), defaults);
  assert.deepEqual(seen, []);
  assert.deepEqual(store.setSettings({ autofix: true, bulk: { agents: 4 } }), { autofix: true, bulk: { on: false, delegate: false, agents: 4 } });
  assert.deepEqual(seen, [{ type: "settings", settings: { autofix: true, bulk: { on: false, delegate: false, agents: 4 } } }]);
  assert.deepEqual(store.setSettings({ bulk: { agents: 4 } }), store.getSettings());
  assert.equal(seen.length, 1);
  store.close();
});

test("a shot file that cannot be removed does not hide a committed start or delete", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-hard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore({ file: join(dir, "pins.db") });
  t.after(() => store.close());
  const { id } = store.createPin(input());
  store.setShot(id, "after", { type: "image/png", bytes: png });
  // A folder where the "before" file belongs: rm without recursive fails on it.
  mkdirSync(join(dir, "shots", `${id}-before`, "x"), { recursive: true });
  const seen = [];
  store.on("change", (event) => seen.push(`${event.type}:${event.action}:${event.pin.status}`));
  const started = store.transition(id, "start", { agent: "claude" });
  assert.deepEqual([started.status, started.shots, store.getShot(id, "after")], ["working", { before: null, after: null }, null]);
  assert.equal(store.deletePin(id), true);
  assert.deepEqual(seen, ["pin:updated:working", "pin:deleted:working"]);
});

test("list and detail text holds no control character from a page or a note", () => {
  const dirty = "a\u001b[2J\u001b]0;title\u0007b\u0008\u0000c\u007f\u009b31m\u0085d";
  const pin = {
    id: 12, status: "queued", host: "crete.koglabs.com", path: "/pricing", title: dirty, url: "https://crete.koglabs.com/pricing", note: dirty, quote: dirty,
    createdAt: "2026-10-17T14:00:00.000Z", replyCount: 1, intent: null, scope: null, presets: [{ label: dirty, text: dirty }], shots: {},
    targets: [{ selector: dirty, label: dirty, text: dirty, attrs: { title: dirty }, styles: { font: dirty }, ancestors: [dirty] }],
  };
  const outputs = [formatList([pin]), formatDetail(pin, [{ createdAt: "2026-10-17T14:02:00.000Z", kind: "user", author: dirty, body: dirty }], [{ createdAt: "2026-10-17T14:03:00.000Z", body: dirty }])];
  for (const output of outputs) {
    assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    assert.match(output, /a \[2J \]0;title b c 31m d/);
  }
  assert.equal(outputs[0].split("\n").length, 2, "a list entry stays on two lines");
});

// node:http writes a header block with a text body as UTF-8, so a header value above 0x7F would go out encoded
// twice. A raw socket sends the exact bytes, as Caddy does.
function rawPost(port, path, headerName, valueBytes, body) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const data = Buffer.from(JSON.stringify(body));
    const chunks = [];
    socket.on("connect", () => socket.write(Buffer.concat([
      Buffer.from(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${data.length}\r\n${headerName}: `),
      valueBytes, Buffer.from("\r\n\r\n"), data,
    ])));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      // The answer is chunked: the JSON object is between the first "{" and the last "}" of the body.
      const answer = text.slice(text.indexOf("\r\n\r\n") + 4);
      resolve({ status: Number(text.split(" ")[1]), data: JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1)) });
    });
  });
}

test("an actor name is UTF-8 text: 1 to 60 characters, no control character", async (t) => {
  const { port, store } = await fixture(t);
  const refusal = [400, "actor name must be 1 to 60 characters, with no control character"];
  // A tab, DEL as text, the byte 0x9B (CSI) and 0x85 alone, and the same two C1 characters as UTF-8 (C2 9B, C2 85).
  const refused = [[0x61, 0x09, 0x62], [0x61, 0x9b, 0x62], [0x85], [0x61, 0xc2, 0x9b, 0x62], [0xc2, 0x85], [0x61, 0xc2, 0x80, 0x62], [0x61, 0xc2, 0x9f]];
  for (const header of ["X-Pins-Agent", "X-SSO-User"]) {
    for (const bytes of refused) {
      const answer = await rawPost(port, "/api/pins", header, Buffer.from(bytes), input());
      assert.deepEqual([answer.status, answer.data.error], refusal, `${header}: ${Buffer.from(bytes).toString("hex")}`);
    }
    const long = await rawPost(port, "/api/pins", header, Buffer.from("λ".repeat(61)), input());
    assert.deepEqual([long.status, long.data.error], refusal, "61 characters");
  }
  assert.equal(store.stats().total.queued, 0);

  const names = ["claude", "cli-test", "sam", "pin 12 - opus", "a@b.example", "x".repeat(60), "Γιάννης", "Νίκος", "Ελένη", "Μαρία", "José", "Zoë", "Émile", "Jürgen", "Über", "Łukasz", "Søren", "山田", "dev 👋", "λ".repeat(60)];
  for (const header of ["X-Pins-Agent", "X-SSO-User"]) {
    for (const name of names) {
      const created = await rawPost(port, "/api/pins", header, Buffer.from(name, "utf8"), input());
      assert.deepEqual([created.status, created.data.pin?.author], [201, name], `${header}: ${name}`);
    }
  }
  // The stored name is the same text in every place: author, agent and the reply of a resolve.
  const { id } = store.createPin(input());
  const started = await rawPost(port, `/api/pins/${id}/start`, "X-Pins-Agent", Buffer.from("Γιάννης"), {});
  assert.deepEqual([started.status, started.data.pin.agent], [200, "Γιάννης"]);
  const reply = await rawPost(port, `/api/pins/${id}/replies`, "X-SSO-User", Buffer.from("山田"), { body: "ok" });
  assert.deepEqual([reply.status, reply.data.reply.author, store.listReplies(id)[0].author], [201, "山田", "山田"]);
  // Bytes that are not UTF-8 stay as they came (one character per byte): "é" alone in latin1 is E9.
  const latin = await rawPost(port, "/api/pins", "X-SSO-User", Buffer.from([0x4a, 0x6f, 0x73, 0xe9]), input());
  assert.deepEqual([latin.status, latin.data.pin.author], [201, "José"]);
});

test("each entry of an MCP batch takes a write token; a batch over the bucket size is refused", async (t) => {
  const { request, store } = await fixture(t, { writeLimit: { capacity: 5, perMs: 60000 } });
  const { id } = store.createPin(input());
  const reply = (n) => ({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "pins_reply", arguments: { id, body: `Reply ${n}` } } });
  const batch = (size) => request("/mcp", { method: "POST", body: Array.from({ length: size }, (_, n) => reply(n)) });

  const tooBig = await batch(6);
  assert.deepEqual([tooBig.status, tooBig.data], [400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: a batch holds at most 5 requests" } }]);
  assert.equal(store.getPin(id).replyCount, 0, "a refused batch writes nothing");
  // The refused batch took one token, like every POST. Four are left: a batch of 3 passes, the next one does not.
  const first = await batch(3);
  assert.deepEqual([first.status, first.data.length, store.getPin(id).replyCount], [200, 3, 3]);
  const second = await batch(3);
  assert.equal(second.status, 429);
  assert.match(second.headers["retry-after"], /^[1-9][0-9]*$/);
  assert.equal(store.getPin(id).replyCount, 3, "a limited batch writes nothing");
  assert.equal((await request("/mcp", { method: "POST", body: reply(9) })).status, 429, "the bucket is empty for single calls too");
  assert.equal((await request(`/api/pins/${id}/replies`, { method: "POST", body: { body: "REST shares the bucket" } })).status, 429);
});

// A raw stream client. read: false = it never reads. sides() gives the server sockets in connection order.
function streams(t, server, port) {
  const sides = [];
  server.on("connection", (socket) => sides.push(socket));
  const open = async (read, marker = "event: pin\n") => {
    const socket = connect(port, "127.0.0.1");
    t.after(() => socket.destroy());
    await once(socket, "connect");
    socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    let frames = 0;
    let carry = "";
    // The marker can sit on a chunk border: keep its length minus one for the next chunk.
    if (read) socket.on("data", (chunk) => {
      const text = carry + chunk.toString("latin1");
      frames += text.split(marker).length - 1;
      carry = text.slice(1 - marker.length);
    });
    else socket.pause();
    return { socket, frames: () => frames };
  };
  return { open, sides };
}
const bigTarget = { selector: "s".repeat(400), label: "l".repeat(150), text: "t".repeat(300), ancestors: Array(6).fill("a".repeat(80)), attrs: { class: "c".repeat(200), title: "t".repeat(200) } };

test("SSE drops a client that does not read; its buffer stays bounded and other clients lose nothing", { timeout: 30000 }, async (t) => {
  const { store, server, port } = await fixture(t);
  const { open, sides } = streams(t, server, port);
  const healthy = await open(true);
  await open(false);
  await delay(50);
  assert.equal(sides.length, 2);
  const { id } = store.createPin(input({ note: "n".repeat(3000), targets: Array(10).fill(bigTarget) }));
  const frame = Buffer.byteLength(JSON.stringify(store.getPin(id))) + 64;
  const live = () => sides.filter((socket) => !socket.destroyed);
  let sent = 1;
  let peak = 0;
  // The stalled client first fills the kernel buffers, then the buffer of the server. 4000 frames are over 50 MB.
  while (live().length === 2 && sent < 4000) {
    store.updateNote(id, `${"n".repeat(3000)}${sent++}`);
    peak = Math.max(peak, ...live().map((socket) => socket.writableLength));
    await turn();
  }
  assert.equal(live().length, 1, `the stalled client is still connected after ${sent} events`);
  assert.ok(peak <= SSE_BUFFER_MAX + frame, `the buffer reached ${peak} bytes; the limit is ${SSE_BUFFER_MAX} plus one event`);
  // The healthy client reads on: it got every event, also the ones after the drop.
  store.updateNote(id, "last");
  sent++;
  for (let waited = 0; healthy.frames() < sent && waited < 5000; waited += 10) await delay(10);
  assert.equal(healthy.frames(), sent);
  assert.equal(healthy.socket.destroyed, false);
});

test("SSE: one MCP batch writes all its events in one turn; a client that reads keeps them all, a client that does not read is dropped", { timeout: 60000 }, async (t) => {
  // A high write limit: this test is about the stream, and each batch entry takes a token.
  const { store, server, port, request } = await fixture(t, { writeLimit: { capacity: 6000, perMs: 60000 } });
  const { open, sides } = streams(t, server, port);
  const healthy = await open(true, "event: reply\n");
  await open(false);
  await delay(50);
  const [reads, stalls] = sides;
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  t.after(() => { console.error = error; });
  const { id } = store.createPin(input({ note: "n".repeat(3000), targets: Array(10).fill(bigTarget) }));
  // 60 replies of 4000 characters on a pin of about 22 KB: about 1.5 MiB of events, over the limit, in one turn.
  const entries = 60;
  const burst = entries * (Buffer.byteLength(JSON.stringify(store.getPin(id))) + 4000 + 400);
  assert.ok(burst > SSE_BUFFER_MAX, "the batch is larger than the limit");
  let batches = 0;
  let peak = 0;
  while (!stalls.destroyed && batches < 40) {
    const body = Array.from({ length: entries }, (_, n) => ({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "pins_reply", arguments: { id, body: `${batches}.${n} `.padEnd(4000, "r") } } }));
    const answer = await request("/mcp", { method: "POST", body });
    batches++;
    assert.deepEqual([answer.status, answer.data.length], [200, entries]);
    assert.equal(reads.destroyed, false, `the client that reads was dropped in batch ${batches}`);
    if (!stalls.destroyed) peak = Math.max(peak, stalls.writableLength);
    for (let waited = 0; healthy.frames() < batches * entries && waited < 10000; waited += 5) await delay(5);
    assert.equal(healthy.frames(), batches * entries, `the client that reads has every reply of batch ${batches}`);
  }
  assert.equal(stalls.destroyed, true, `the stalled client is still connected after ${batches} batches`);
  assert.ok(batches > 1, "the stalled client was not dropped inside its first batch");
  assert.ok(peak <= SSE_BUFFER_MAX + burst, `the buffer reached ${peak} bytes; the limit is ${SSE_BUFFER_MAX} plus one batch (${burst})`);
  assert.deepEqual(logged, ["pins: closed an event stream that did not read"]);
  assert.equal(healthy.socket.destroyed, false);
});

test("the server entry point: starts on a temp store, answers health, redirects to PINS_QUEUE_URL and stops on SIGTERM", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const index = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const env = { PATH: process.env.PATH, PORT: "0", PINS_DB: join(dir, "pins.db"), PINS_SHOTS_DIR: join(dir, "shots"), PINS_DOWNLOAD_DIR: join(dir, "dist"), PINS_QUEUE_URL: "https://hub.example/queue?tab=pins" };
  const start = (extra) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", index], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const output = { stdout: "", stderr: "" };
    for (const name of ["stdout", "stderr"]) child[name].setEncoding("utf8").on("data", (chunk) => { output[name] += chunk; });
    return { child, output, exit: once(child, "exit") };
  };
  const { child, output, exit } = start();
  while (!/listening on http:\/\/127\.0\.0\.1:\d+/.test(output.stdout) && child.exitCode === null) await delay(20);
  const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output.stdout)?.[1];
  assert.ok(base, output.stderr);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual([health.ok, health.open], [true, { queued: 0, working: 0, waiting: 0 }]);
  const moved = await fetch(`${base}/?host=crete.koglabs.com`, { redirect: "manual" });
  assert.deepEqual([moved.status, moved.headers.get("location")], [302, "https://hub.example/queue?tab=pins&host=crete.koglabs.com"]);
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);

  // A bad value stops the start with one clear line, not a stack trace from a later request.
  for (const extra of [{ PINS_QUEUE_URL: "not a url" }, { PINS_QUEUE_URL: "javascript:alert(1)" }, { PORT: "70000" }]) {
    const bad = start(extra);
    assert.deepEqual(await bad.exit, [1, null], JSON.stringify(extra));
    assert.match(bad.output.stderr, /^pins: (PINS_QUEUE_URL must be an http or https URL|PORT must be an integer from 0 to 65535)\n$/);
  }
});
