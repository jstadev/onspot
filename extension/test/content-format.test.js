import test from "node:test";
import assert from "node:assert/strict";
import { clip, elapsed, goBack, isOpen, modelName, newer, plural, revertTag, sha7, statusText, when } from "../src/content/format.js";

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

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
test("clip never ends with half a character", () => {
  const face = "\u{1F600}"; // two UTF-16 units
  for (let pad = 0; pad < 6; pad++) {
    for (const max of [5, 6, 7, 80]) {
      const out = clip("x".repeat(pad) + face.repeat(50), max);
      assert.ok(out.length <= max, `${pad} ${max}`);
      assert.equal(lone.test(out), false, `${pad} ${max}: ${JSON.stringify(out)}`);
      assert.ok(out.endsWith("\u2026"));
    }
  }
  assert.equal(clip(`${"x".repeat(78)}${face}tail`, 80), `${"x".repeat(78)}\u2026`, "the pair goes whole");
  assert.equal(clip(`${"x".repeat(77)}${face}tail`, 80), `${"x".repeat(77)}${face}\u2026`, "a whole pair stays");
});

const C = ["a1b2c3d4e5f60718", "b2c3d4e5f6071829", "c3d4e5f60718293a"];
const versions = (n, summaries = ["Title margin 48px to 24px", "Title colour green", "Title font 600"]) =>
  C.slice(0, n).map((commit, i) => ({ commit, summary: summaries[i], at: "2026-11-14T10:00:00.000Z" }));

test("goBack: no Go back without a version, with a go back running, or on an open pin", () => {
  assert.equal(goBack({ status: "done", versions: [], revert: null }), null);
  for (const v of [undefined, null, "x", {}]) assert.equal(goBack({ status: "done", versions: v, revert: null }), null, String(v));
  assert.equal(goBack({ status: "done", versions: versions(1), revert: { commits: [C[0]], at: "x", attempts: 1 } }), null);
  for (const status of ["queued", "working", "waiting"]) assert.equal(goBack({ status, versions: versions(2), revert: null }), null, status);
  assert.notEqual(goBack({ status: "done", versions: versions(1), revert: null }), null);
  assert.notEqual(goBack({ status: "dismissed", versions: versions(1), revert: null }), null);
  assert.notEqual(goBack({ status: "done", versions: versions(1) }), null, "an older server sends no revert");
});

test("goBack with one version asks one question and undoes that fix", () => {
  assert.deepEqual(goBack({ status: "done", versions: versions(1), revert: null }), {
    now: "",
    ask: "Go back to the page before this pin? An agent undoes a1b2c3d and ships the old version.",
    choices: [{ label: "Before this pin (the page before any fix)", commit: C[0] }],
  });
});

test("goBack with three versions lists the earlier versions newest first; each choice undoes the fix after it", () => {
  assert.deepEqual(goBack({ status: "done", versions: versions(3), revert: null }), {
    now: "Now: fix 3 · c3d4e5f · Title font 600",
    ask: "Go back to which version?",
    choices: [
      { label: "After fix 2 · b2c3d4e · Title colour green", commit: C[2] },
      { label: "After fix 1 · a1b2c3d · Title margin 48px to 24px", commit: C[1] },
      { label: "Before this pin (the page before any fix)", commit: C[0] },
    ],
  });
});

test("goBack clips each summary to 80 characters and leaves out a missing one", () => {
  const long = `${"word ".repeat(15)}abc\u{1F600}${"z".repeat(30)}`; // units 78 and 79 are the pair: the cut falls inside it
  const back = goBack({ status: "dismissed", versions: versions(2, [long, null]), revert: null });
  assert.equal(back.now, "Now: fix 2 · b2c3d4e");
  const label = back.choices[0].label, summary = label.split(" · ")[2];
  assert.ok(summary.length <= 80 && summary.endsWith("\u2026"), summary);
  assert.equal(lone.test(label), false, label);
  assert.equal(summary, clip(long, 80));
  assert.equal(summary, `${"word ".repeat(15)}abc\u2026`);
  assert.equal(goBack({ status: "done", versions: [{ commit: C[0], summary: "  \n " }, { commit: C[1] }], revert: null }).choices[0].label, "After fix 1 · a1b2c3d");
});

test("sha7 and revertTag", () => {
  assert.equal(sha7(C[0]), "a1b2c3d");
  assert.equal(sha7("abc"), "abc");
  for (const bad of [null, undefined, ""]) assert.equal(sha7(bad), "");
  const revert = { commits: [C[0]], at: "2026-11-14T10:00:00.000Z", attempts: 1 };
  for (const status of ["queued", "working", "waiting"]) assert.equal(revertTag({ status, revert, revertedAt: null }), "Going back", status);
  assert.equal(revertTag({ status: "done", revert: null, revertedAt: "2026-11-14T10:05:00.000Z" }), "Reverted");
  assert.equal(revertTag({ status: "queued", revert: null, revertedAt: "2026-11-14T10:05:00.000Z" }), "", "a requeue clears it; an old value shows nothing");
  assert.equal(revertTag({ status: "done", revert: null, revertedAt: null }), "");
  assert.equal(revertTag({ status: "done" }), "");
});
