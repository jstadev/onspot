import test from "node:test";
import assert from "node:assert/strict";
import { createSSEParser, EVENT_MAX } from "../src/bg/sse.js";

test("SSE survives every split point, including CRLF and field names", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const input = ["\uFEFF: comment", "retry: 3000", "id: 12", "event: pin", "data: first", "data: δεύτερο", "", "data: next", "", ""].join(newline);
    const expected = [
      { event: "pin", data: "first\nδεύτερο", id: "12", retry: 3000 },
      { event: "message", data: "next", id: "12", retry: 3000 },
    ];
    for (let split = 0; split <= input.length; split++) {
      const parser = createSSEParser();
      assert.deepEqual([...parser.feed(input.slice(0, split)), ...parser.feed(""), ...parser.feed(input.slice(split))], expected,
        `split=${split}, newline=${JSON.stringify(newline)}`);
    }
    const parser = createSSEParser();
    assert.deepEqual([...input].flatMap((char) => parser.feed(char)), expected);
  }
});

test("SSE accepts mixed line endings, multiple events, and empty data", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.feed("event: discarded\r\r: hb\n\nid: 2\rdata: a\ndata:\r\ndata: c\r\rdata\n\n"), [
    { event: "message", data: "a\n\nc", id: "2" },
    { event: "message", data: "", id: "2" },
  ]);
});

test("SSE preserves IDs, clears empty IDs, and ignores IDs containing NUL", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.feed("id: first\n\nid: bad\0id\ndata: a\n\nid\ndata: b\n\n"), [
    { event: "message", data: "a", id: "first" },
    { event: "message", data: "b", id: "" },
  ]);
});

test("SSE strips one optional space and ignores unknown fields and comments", () => {
  assert.deepEqual(createSSEParser().feed("Data: ignored\nother: ignored\n: data: ignored\nevent: first\nevent: last\ndata:  leading\ndata:\ttab\ndata: a:b\n\n"), [
    { event: "last", data: " leading\n\ttab\na:b", id: "" },
  ]);
});

test("SSE accepts numeric retry controls without dispatching a data event", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.feed("retry: 007\n\n"), []);
  assert.equal(parser.retry, 7);
  for (const value of ["", "-1", "+1", "1.5", "1ms", " 1", "Infinity", "9007199254740992"]) {
    parser.feed(`retry: ${value}\n`);
    assert.equal(parser.retry, 7);
  }
  assert.deepEqual(parser.feed("retry: 0\ndata: ok\n\n"), [
    { event: "message", data: "ok", id: "", retry: 0 },
  ]);
});

test("SSE waits for a blank line, retains partial lines, and rejects non-text", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.feed("data: not yet"), []);
  assert.deepEqual(parser.feed("\n"), []);
  assert.deepEqual(parser.feed("\n"), [{ event: "message", data: "not yet", id: "" }]);
  assert.deepEqual(parser.feed("data: \uFEFFkept\n\n"), [{ event: "message", data: "\uFEFFkept", id: "" }]);
  assert.throws(() => parser.feed(new Uint8Array()), TypeError);
});

test("SSE refuses an event over the size limit: one long line, or many data lines", () => {
  assert.equal(EVENT_MAX, 1024 * 1024);
  const chunk = "x".repeat(65536);
  const feedLine = (parser, length) => { for (let sent = 0; sent < length; sent += chunk.length) parser.feed(chunk.slice(0, length - sent)); };

  // A line without an end, in any field or in a comment.
  for (const start of ["data: ", ": ", "event: ", "unknown"]) {
    const parser = createSSEParser();
    parser.feed(start);
    assert.throws(() => feedLine(parser, EVENT_MAX), RangeError, start);
  }
  // Many short data lines of one event.
  const parser = createSSEParser();
  const line = `data: ${"x".repeat(1018)}\n`; // 1018 characters of data in each line
  assert.throws(() => { for (let i = 0; i < 1100; i++) parser.feed(line); }, { name: "RangeError", message: "SSE event is too large" });
});

test("SSE takes an event at the size limit, and the count starts again after each event", () => {
  const parser = createSSEParser();
  const big = "x".repeat(EVENT_MAX - 6); // "data: " is part of the line
  for (let round = 0; round < 3; round++) {
    const events = parser.feed(`data: ${big}\n\n`);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.length, big.length);
  }
  // Comments (the heartbeat) never add up.
  for (let i = 0; i < 3000; i++) parser.feed(`: ${"h".repeat(1000)}\n`);
  assert.deepEqual(parser.feed("data: ok\n\n"), [{ event: "message", data: "ok", id: "" }]);
});
