import test from "node:test";
import assert from "node:assert/strict";
import { readEvents } from "../src/sse.js";

test("SSE handles chunked UTF-8, CRLF, multiline data, comments, and malformed records", async () => {
  const text = ': hb\r\nretry: 3000\r\nevent: ready\r\ndata: {"at":"now"}\r\n\r\n' +
    'event: pin\r\ndata: {"pin":\r\ndata: {"id":1,"note":"Γεια"}}\r\n\r\n' +
    'event: pin\ndata: broken\n\nevent: settings\ndata: {"autofix":false}\n\n';
  const stream = new ReadableStream({ start(controller) {
    for (const byte of new TextEncoder().encode(text)) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const events = [];
  await readEvents(stream, (type, data) => events.push({ type, data }));
  assert.deepEqual(events, [
    { type: "ready", data: { at: "now" } }, { type: "pin", data: { pin: { id: 1, note: "Γεια" } } },
    { type: "settings", data: { autofix: false } },
  ]);
});

test("abort explicitly cancels an idle stream even if fetch does not cancel its body", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const reading = readEvents(stream, () => assert.fail("unexpected event"), abort.signal);
  abort.abort();
  await reading;
  assert.equal(cancelled, true);
});

test("a line that never ends stops the stream after 1 MiB, so the caller connects again", async () => {
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { sent += chunk.length; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  await assert.rejects(readEvents(stream, () => assert.fail("unexpected event")), /SSE line too long/);
  assert.ok(sent <= 1024 * 1024 + 3 * chunk.length, `read ${sent} bytes`);
  assert.equal(cancelled, true);
  // A long event with line ends passes.
  const big = JSON.stringify({ pin: { id: 1, note: "n".repeat(900 * 1024) } });
  const events = [];
  await readEvents(new Response(`event: pin\ndata: ${big}\n\n`.repeat(2)).body, (type, data) => events.push(data.pin.id));
  assert.deepEqual(events, [1, 1]);
});
