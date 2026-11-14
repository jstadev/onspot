import test from "node:test";
import assert from "node:assert/strict";
import { clip, elapsed, isOpen, modelName, newer, plural, statusText, when } from "../src/content/format.js";

test("plural adds an s for every count but one", () => {
  assert.equal(plural(1, "pin"), "1 pin");
  for (const n of [0, 2, 30]) assert.equal(plural(n, "pin"), `${n} pins`);
  assert.equal(plural(3, "open pin"), "3 open pins");
});

test("clip makes one line and cuts it with an ellipsis", () => {
  assert.equal(clip("  a \n\t b   c ", 20), "a b c");
  assert.equal(clip("abcdef", 6), "abcdef");
  assert.equal(clip("abcdefg", 6), "abcde…");
  assert.equal(clip("abcdefg", 6).length, 6);
  for (const empty of [null, undefined, "", "   "]) assert.equal(clip(empty, 10), "");
  assert.equal(clip(1234567, 4), "123…");
  assert.equal(clip("<b>x</b>", 20), "<b>x</b>", "it changes no character: the DOM gets it as text");
});

test("newer compares three version numbers", () => {
  for (const [a, b] of [["0.4.0", "0.3.2"], ["1.0.0", "0.9.9"], ["0.3.10", "0.3.9"], ["0.4", "0.3.9"], ["9.0.0", "0.4.0"]]) {
    assert.equal(newer(a, b), true, `${a} > ${b}`);
    assert.equal(newer(b, a), false, `${b} > ${a}`);
  }
  for (const [a, b] of [["0.4.0", "0.4.0"], ["0.4", "0.4.0"], [undefined, "0.4.0"], [null, "0.0.0"], ["", "0.0.0"], ["x.y.z", "0.0.0"], ["0.4.0.9", "0.4.0"]]) assert.equal(newer(a, b), false, `${a} > ${b}`);
});

test("isOpen: queued, working and waiting", () => {
  for (const status of ["queued", "working", "waiting"]) assert.equal(isOpen({ status }), true, status);
  for (const status of ["done", "dismissed", "", undefined]) assert.equal(isOpen({ status }), false, String(status));
});

test("modelName title-cases the model and adds the version to an old bare name", () => {
  assert.equal(modelName({ model: "opus 5.5 high" }), "Opus 5.5 high");
  assert.equal(modelName({ model: "fable 5.2 xhigh" }), "Fable 5.2 xhigh");
  assert.equal(modelName({ model: "opus" }), "Opus 5.5");
  assert.equal(modelName({ model: "Sonnet" }), "Sonnet 5.5");
  assert.equal(modelName({ model: "  haiku  " }), "Haiku");
  for (const model of [null, undefined, "", "   "]) assert.equal(modelName({ model }), "");
});

test("statusText names each status as he reads it", () => {
  assert.equal(statusText({ status: "queued" }), "Queued");
  assert.equal(statusText({ status: "queued", attempts: 1 }), "Queued again");
  assert.equal(statusText({ status: "working", model: "opus 5.5 high", agent: "claude" }), "Fixing · Opus 5.5 high");
  assert.equal(statusText({ status: "working", agent: "claude" }), "Fixing · claude");
  assert.equal(statusText({ status: "working" }), "Fixing");
  assert.equal(statusText({ status: "waiting" }), "Needs you");
  assert.equal(statusText({ status: "done" }), "Done");
  assert.equal(statusText({ status: "dismissed" }), "Dismissed");
  assert.equal(statusText({ status: "later" }), "later");
  assert.equal(statusText({}), "");
});

test("elapsed counts from the start of the run", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-11T12:00:00.000Z") });
  const since = seconds => ({ startedAt: new Date(Date.now() - seconds * 1000).toISOString() });
  assert.equal(elapsed(since(0)), "Fixing for 0:00");
  assert.equal(elapsed(since(9)), "Fixing for 0:09");
  assert.equal(elapsed(since(75)), "Fixing for 1:15");
  assert.equal(elapsed(since(59 * 60 + 59)), "Fixing for 59:59");
  assert.equal(elapsed(since(3600)), "Fixing for 1:00:00");
  assert.equal(elapsed(since(3 * 3600 + 7 * 60 + 5)), "Fixing for 3:07:05");
  assert.equal(elapsed(since(-5)), "", "a start in the future shows nothing");
  for (const startedAt of [null, undefined, "", "not a date"]) assert.equal(elapsed({ startedAt }), "", String(startedAt));
});

test("when shows the time for today and the date for another day", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 11, 15, 30).getTime() });
  const today = new Date(2026, 10, 11, 9, 5), other = new Date(2026, 9, 3, 9, 5);
  const time = date => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  assert.equal(when(today.toISOString()), time(today));
  assert.equal(when(other.toISOString()), `${other.toLocaleDateString([], { day: "numeric", month: "short" })} ${time(other)}`);
  assert.notEqual(when(other.toISOString()), time(other));
  for (const bad of ["", "not a date", undefined, {}]) assert.equal(when(bad), "", String(bad));
});
