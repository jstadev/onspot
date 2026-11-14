import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";

const input = (host = "crete.koglabs.com") => ({ url: `https://${host}/pricing`, note: "Spacing", targets: [{ selector: "h1", label: "h1" }] });

async function fixture(t, options = {}) {
  const store = openStore({ file: ":memory:" });
  const probe = () => {};
  const emitter = store.on("probe", probe);
  store.off("probe", probe);
  const app = createApp({ store, version: "test", ...options });
  const server = createServer(app);
  const streams = new Set();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    for (const stream of streams) stream.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const port = server.address().port;
  function request(path, method = "GET", body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method, agent: false, headers: { ...headers, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      req.end(data);
    });
  }
  function connect(path = "/api/events") {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, agent: false }, (res) => {
        const frames = [];
        const arrivals = new EventEmitter();
        let buffer = "";
        const stream = {
          res, frames,
          close() { res.destroy(); req.destroy(); streams.delete(stream); },
          wait(predicate) {
            const found = frames.find(predicate);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => { arrivals.off("frame", onFrame); reject(new Error("SSE frame did not arrive")); }, 3000);
              function onFrame(frame) {
                if (!predicate(frame)) return;
                clearTimeout(timer);
                arrivals.off("frame", onFrame);
                resolve(frame);
              }
              arrivals.on("frame", onFrame);
            });
          },
        };
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const frame = {};
            for (const line of raw.split("\n")) {
              if (line.startsWith(":")) frame.comment = line.slice(1).trim();
              else {
                const colon = line.indexOf(":");
                const key = line.slice(0, colon);
                const value = line.slice(colon + 1).trim();
                frame[key] = key === "data" ? JSON.parse(value) : value;
              }
            }
            frames.push(frame);
            arrivals.emit("frame", frame);
          }
        });
        res.on("error", () => {});
        streams.add(stream);
        resolve(stream);
      });
      req.on("error", reject);
      req.end();
    });
  }
  async function waitConnections(expected) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const n = await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
      if (n === expected) return;
      await delay(5);
    }
    assert.fail(`server did not reach ${expected} connections`);
  }
  return { store, emitter, app, request, connect, waitConnections };
}

test("SSE sends ready, all pin changes and replies with increasing event ids", async (t) => {
  const { request, connect } = await fixture(t);
  const stream = await connect();
  assert.equal(stream.res.statusCode, 200);
  assert.equal(stream.res.headers["content-type"], "text/event-stream");
  assert.equal(stream.res.headers["cache-control"], "no-store");
  assert.equal(stream.res.headers["x-accel-buffering"], "no");
  const ready = await stream.wait((frame) => frame.event === "ready");
  assert.equal(ready.retry, "3000");
  assert.equal(new Date(ready.data.at).toISOString(), ready.data.at);
  const created = (await request("/api/pins", "POST", input())).data.pin;
  const creation = await stream.wait((frame) => frame.data?.action === "created");
  assert.equal(creation.event, "pin");
  assert.deepEqual(creation.data.pin, created);
  const updated = (await request(`/api/pins/${created.id}`, "PATCH", { note: "Updated" })).data.pin;
  assert.deepEqual((await stream.wait((frame) => frame.data?.action === "updated")).data.pin, updated);
  const reply = (await request(`/api/pins/${created.id}/replies`, "POST", { body: "Mobile too" })).data;
  assert.deepEqual((await stream.wait((frame) => frame.event === "reply")).data, reply);
  assert.equal((await request(`/api/pins/${created.id}`, "DELETE")).status, 204);
  assert.equal((await stream.wait((frame) => frame.data?.action === "deleted")).data.pin.id, created.id);
  const events = stream.frames.filter((frame) => frame.event);
  assert.equal(events.length, 5);
  for (let i = 0; i < events.length; i++) {
    assert.match(events[i].id, /^[1-9][0-9]*$/);
    if (i) assert.ok(Number(events[i].id) > Number(events[i - 1].id));
  }
});

test("SSE fans out through one listener and filters every event by host", async (t) => {
  const { connect, request, emitter } = await fixture(t);
  const all = await connect();
  const filtered = await connect("/api/events?host=CRETE.koglabs.com");
  await Promise.all([all.wait((frame) => frame.event === "ready"), filtered.wait((frame) => frame.event === "ready")]);
  assert.equal(emitter.listenerCount("change"), 1);
  for (const host of ["crm.koglabs.com", "crete.koglabs.com"]) {
    const pin = (await request("/api/pins", "POST", input(host))).data.pin;
    await request(`/api/pins/${pin.id}`, "PATCH", { note: "Edited" });
    await request(`/api/pins/${pin.id}/replies`, "POST", { body: "Reply" });
    await request(`/api/pins/${pin.id}`, "DELETE");
    await all.wait((frame) => frame.data?.action === "deleted" && frame.data.pin.id === pin.id);
    if (host === "crete.koglabs.com") await filtered.wait((frame) => frame.data?.action === "deleted" && frame.data.pin.id === pin.id);
  }
  const relevant = filtered.frames.filter((frame) => frame.data?.pin);
  assert.equal(relevant.length, 4);
  assert.ok(relevant.every((frame) => frame.data.pin.host === "crete.koglabs.com"));
  assert.equal(all.frames.filter((frame) => frame.data?.pin).length, 8);
  for (const event of relevant) assert.ok(all.frames.some((other) => other.id === event.id));
});

test("SSE settings changes reach every client, including unrelated host filters", async (t) => {
  const { connect, request } = await fixture(t);
  const streams = await Promise.all([connect(), connect("/api/events?host=CRETE.koglabs.com"), connect("/api/events?host=crm.koglabs.com")]);
  await Promise.all(streams.map((stream) => stream.wait((frame) => frame.event === "ready")));
  for (const autofix of [false, true]) {
    const changed = await request("/api/settings", "PATCH", { autofix });
    assert.equal(changed.status, 200);
    const frames = await Promise.all(streams.map((stream) => stream.wait((frame) => frame.event === "settings" && frame.data.autofix === autofix)));
    for (const frame of frames) {
      assert.deepEqual(frame.data, { autofix, bulk: { on: false, delegate: false, agents: 3 } });
      assert.equal(frame.id, frames[0].id);
      assert.match(frame.id, /^[1-9][0-9]*$/);
    }
    assert.equal((await request("/api/settings", "PATCH", { autofix: "false" })).status, 400);
  }
  for (const stream of streams) assert.deepEqual(stream.frames.filter((frame) => frame.event === "settings").map((frame) => frame.data), [{ autofix: false, bulk: { on: false, delegate: false, agents: 3 } }, { autofix: true, bulk: { on: false, delegate: false, agents: 3 } }]);
});

test("SSE ask and user reply each send the pin update before the reply", async (t) => {
  const { connect, request } = await fixture(t);
  const stream = await connect("/api/events?host=crete.koglabs.com");
  await stream.wait((frame) => frame.event === "ready");
  const { id } = (await request("/api/pins", "POST", input())).data.pin;
  await request(`/api/pins/${id}/start`, "POST", { run: "triad:42" });
  const waiting = (await request(`/api/pins/${id}/ask`, "POST", { question: "Which size?" })).data.pin;
  await stream.wait((frame) => frame.event === "reply" && frame.data.reply.body === "Which size?");
  let pair = stream.frames.slice(-2);
  assert.deepEqual(pair.map((frame) => frame.event), ["pin", "reply"]);
  assert.deepEqual(pair[0].data, { action: "updated", pin: waiting });
  assert.deepEqual(pair[1].data.pin, waiting);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.run, "triad:42");
  const replied = (await request(`/api/pins/${id}/replies`, "POST", { body: "24 pixels" })).data;
  await stream.wait((frame) => frame.event === "reply" && frame.data.reply.body === "24 pixels");
  pair = stream.frames.slice(-2);
  assert.deepEqual(pair.map((frame) => frame.event), ["pin", "reply"]);
  assert.deepEqual(pair[0].data, { action: "updated", pin: replied.pin });
  assert.deepEqual(pair[1].data, replied);
  assert.equal(replied.pin.status, "queued");
  assert.equal(replied.pin.run, null);
});

test("SSE heartbeat interval is injectable and closing the app releases streams and listener", async (t) => {
  const { connect, app, emitter, waitConnections } = await fixture(t, { heartbeatMs: 15 });
  const stream = await connect();
  await stream.wait((frame) => frame.comment === "hb");
  assert.equal(emitter.listenerCount("change"), 1);
  const ended = once(stream.res, "end");
  app.close();
  app.close();
  await ended;
  assert.equal(emitter.listenerCount("change"), 0);
  await waitConnections(0);
});

test("SSE caps streams at 100 and reuses slots after client disconnect without listener leaks", async (t) => {
  const { connect, request, emitter, waitConnections } = await fixture(t);
  const streams = await Promise.all(Array.from({ length: 100 }, () => connect()));
  for (const stream of streams) {
    assert.equal(stream.res.statusCode, 200);
    await stream.wait((frame) => frame.event === "ready");
  }
  assert.equal(emitter.listenerCount("change"), 1);
  assert.equal((await request("/api/events")).status, 503);
  streams[0].close();
  await waitConnections(99);
  const replacement = await connect();
  assert.equal(replacement.res.statusCode, 200);
  await replacement.wait((frame) => frame.event === "ready");
  for (const stream of streams) stream.close();
  replacement.close();
  await waitConnections(0);
  assert.equal(emitter.listenerCount("change"), 1);
  const reconnected = await connect();
  assert.equal(reconnected.res.statusCode, 200);
  await reconnected.wait((frame) => frame.event === "ready");
  assert.equal(reconnected.frames.filter((frame) => frame.event).length, 1, "connections do not replay events");
});

test("SSE sends a pin update with the new progress for each step", async (t) => {
  const { connect, request } = await fixture(t);
  const stream = await connect("/api/events?host=crete.koglabs.com");
  await stream.wait((frame) => frame.event === "ready");
  const { id } = (await request("/api/pins", "POST", input())).data.pin;
  await request(`/api/pins/${id}/start`, "POST", { run: "triad:42" }, { "X-Pins-Agent": "claude" });
  for (const [count, text] of [[1, "Found the code"], [2, "Tests pass"]]) {
    const added = await request(`/api/pins/${id}/progress`, "POST", { text }, { "X-Pins-Agent": "claude" });
    assert.equal(added.status, 201);
    const frame = await stream.wait((item) => item.event === "pin" && item.data.pin.progress?.count === count);
    assert.deepEqual(frame.data, { action: "updated", pin: added.data.pin });
    assert.equal(frame.data.pin.progress.text, text);
  }
  assert.deepEqual(stream.frames.filter((frame) => frame.event).map((frame) => frame.event), ["ready", "pin", "pin", "pin", "pin"]);
});
