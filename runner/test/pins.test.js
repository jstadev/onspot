import test from "node:test";
import assert from "node:assert/strict";
import { createPins } from "../src/pins.js";
import { FakeClock } from "./helpers.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("a call goes to loopback as the agent claude; a status that is not 2xx throws with the status", async () => {
  const seen = [];
  const pins = createPins({ port: 4999, clock: new FakeClock(), fetch: async (url, options) => { seen.push({ url, options }); return url.endsWith("/missing") ? json({ error: "pin not found" }, 404) : json({ ok: true }); } });
  assert.deepEqual(await pins.call("/api/settings"), { ok: true });
  assert.deepEqual(await pins.call("/api/pins/1/ask", { question: "Which blue?" }), { ok: true });
  assert.deepEqual(seen.map(({ url, options }) => [url, options.method, options.redirect, options.headers ?? null, options.body ?? null]), [
    ["http://127.0.0.1:4999/api/settings", "GET", "error", null, null],
    ["http://127.0.0.1:4999/api/pins/1/ask", "POST", "error", { "Content-Type": "application/json", "X-Pins-Agent": "claude" }, '{"question":"Which blue?"}'],
  ]);
  await assert.rejects(pins.call("/missing"), { message: "Pins HTTP 404", status: 404, retryAfter: 0 });
});

test("a refused write carries the Retry-After of the server in ms, at most 60 s; a header that is no number gives 0", async () => {
  let header;
  const pins = createPins({ port: 4750, clock: new FakeClock(), fetch: async () => new Response("{}", { status: 429, headers: header === undefined ? {} : { "Retry-After": header } }) });
  for (const [value, ms] of [[undefined, 0], ["1", 1000], ["30", 30_000], ["86400", 60_000], ["soon", 0], ["-5", 0], ["", 0]]) {
    header = value;
    await assert.rejects(pins.call("/api/pins/1/start", {}), { status: 429, retryAfter: ms }, String(value));
  }
});

test("a request with no answer is aborted after 10 s and leaves no timer", async () => {
  const clock = new FakeClock();
  const pins = createPins({ port: 4750, clock, fetch: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))) });
  let failed = null;
  const pending = pins.call("/api/settings").catch((error) => { failed = error; });
  await clock.tick(9_999);
  assert.equal(failed, null);
  await clock.tick(1);
  await pending;
  assert.equal(failed.name, "AbortError");
  assert.equal(failed.status, undefined, "the runner logs it as unavailable");
  assert.equal(clock.timers.size, 0);
});

test("pages reads 500 pins at a time down to the oldest, and stops on a list or a cursor that is wrong", async () => {
  const all = Array.from({ length: 1201 }, (_, index) => ({ id: 1201 - index }));
  const queries = [], sizes = [];
  const pins = createPins({ port: 4750, clock: new FakeClock(), fetch: async (url) => {
    const query = new URL(url).searchParams;
    queries.push(query.toString());
    return json({ pins: all.filter((pin) => pin.id < (Number(query.get("before")) || Infinity)).slice(0, 500) });
  } });
  await pins.pages("all", (page) => { sizes.push(page.length); });
  assert.deepEqual(sizes, [500, 500, 201]);
  assert.deepEqual(queries, ["status=all&limit=500", "status=all&limit=500&before=702", "status=all&limit=500&before=202"]);
  const same = createPins({ port: 4750, clock: new FakeClock(), fetch: async () => json({ pins: all.slice(0, 500) }) });
  await assert.rejects(same.pages("all", () => {}), /Invalid pins cursor/, "a server that ignores the cursor cannot loop for ever");
  const broken = createPins({ port: 4750, clock: new FakeClock(), fetch: async () => json({ pins: "none" }) });
  await assert.rejects(broken.pages("all", () => {}), /Invalid pins list/);
});
