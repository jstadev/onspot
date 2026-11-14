// v3.5, item 16: a queued pin with `revert` (he pressed Go back) starts its own revert run.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRevertPrompt } from "../src/prompt.js";
import { chooseModel } from "../src/model.js";
import { harness } from "./helpers.js";

const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", B = "b2c3d4e";
const VERSIONS = [
  { commit: A, summary: "Margin 48px to 24px", at: "2026-11-13T10:00:00.000Z" },
  { commit: B, summary: "Margin <24px> to 16px", at: "2026-11-14T09:00:00.000Z" },
];
// A pin with two fix runs behind it; he asks to go back to the page before the pin.
const back = (extra = {}) => ({ batch: 7, attempts: 2, versions: VERSIONS, revert: { commits: [B, A], at: "2026-11-14T10:00:00.000Z", attempts: 2 }, ...extra });
const BRIEF = { card: ["Project card: one"], hints: ["Source hints:", "  1. src/a.js:3"], ship: true, gate: "npm test", stats: {} };
const ON = { on: true, delegate: false, agents: 3 };

test("a go back starts its own lean run at effort high, also in bulk mode, with the card and no history, siblings or earlier pins", async (t) => {
  const inputs = [];
  const h = harness(t, { bulk: ON, brief: async (input) => { inputs.push(input); return BRIEF; } });
  await h.start();
  h.add(1, undefined, back());
  h.add(2, undefined, { batch: 7 }); h.add(3, undefined, { batch: 7 });
  await h.settle();
  const labels = h.delegates.map(({ body }) => body.label).sort();
  assert.deepEqual(labels, ["Pin #1 · Go back: Private pin note · Opus 5.5 high", "Pins #2 #3 · Private pin note +1 · Opus 5.5 xhigh · bulk"]);
  const run = h.delegates.find(({ body }) => body.label.startsWith("Pin #1")).body;
  assert.deepEqual([run.model, run.effort, run.profile], ["claude-opus-5-5", "high", "pin"]);
  assert.ok(run.prompt.startsWith('You are the OnSpot session for pin #1 on one.koglabs.com. The Chairman pressed "Go back" on this pin'));
  assert.ok(run.prompt.includes(`Undo these commits, newest first:\n  ${B} · fix 2 · 2026-11-14 · Margin ‹24px› to 16px\n  ${A} · fix 1 · 2026-11-13 · Margin 48px to 24px\nHe goes back to the page before this pin.\n`));
  assert.ok(run.prompt.includes("\n\nProject card: one\n\nHow to work:\n"));
  assert.ok(!run.prompt.includes("Source hints"), "a revert needs no source hints");
  assert.deepEqual(inputs.find((input) => input.pin.id === 1).earlier, [], "no read of the earlier pins");
  assert.ok(!h.requests.some((request) => request.path === "/api/pins" && request.query.has("selector")), "no history read");
  const listed = h.requests.filter((request) => request.query?.get("batch") === "7" && request.query.get("status") === "all");
  assert.deepEqual(listed, [], "no siblings read");
  const claims = h.requests.filter((request) => request.path === "/api/pins/1/start");
  assert.deepEqual(claims.map((request) => request.body.model), ["opus 5.5 high"]);
});

test("the runs of a go back count from his request: one retry at the next effort, then the Chairman", async (t) => {
  const h = harness(t);
  await h.start();
  h.add(1, undefined, back({ batch: null }));
  await h.settle();
  assert.equal(h.delegates[0].body.effort, "high");
  h.tasks.set("101", { status: "failed", exitCode: 1, lastLine: "Quota" });
  await h.clock.tick(15_000);
  await h.settle();
  const replies = h.requests.filter((request) => request.path === "/api/pins/1/replies");
  assert.deepEqual(replies.map((request) => request.body.body), ["The run ended without a result (failed, exit 1): Quota. Trying again at effort xhigh."]);
  assert.equal(h.delegates.length, 2);
  assert.deepEqual([h.delegates[1].body.effort, h.delegates[1].body.label], ["xhigh", "Pin #1 · Go back: Private pin note · Opus 5.5 xhigh"]);
  assert.deepEqual(h.pins.get(1).revert.commits, [B, A], "the retry is a go back again");
  h.tasks.set("102", { status: "failed", exitCode: 1, lastLine: "Quota" });
  await h.clock.tick(15_000);
  await h.settle();
  assert.equal(h.pins.get(1).status, "waiting");
  assert.match(h.pins.get(1).question, /Reply to retry, or dismiss it\.$/);
  assert.equal(h.delegates.length, 2);
});

test("the full start stays off for a go back only when the lean switch is off", async (t) => {
  const h = harness(t, { config: { lean: false } });
  await h.start();
  h.add(1, undefined, back({ batch: null, intent: "task", note: "Use the design kit skill" }));
  await h.settle();
  assert.equal(h.delegates[0].body.profile, null);
  assert.ok(!h.delegates[0].body.prompt.includes("This session starts lean"));
  const lean = harness(t);
  await lean.start();
  lean.add(1, undefined, back({ batch: null, intent: "task", note: "Use the design kit skill" }));
  await lean.settle();
  assert.equal(lean.delegates[0].body.profile, "pin", "a go back needs no skill, also when the note named one");
});

test("buildRevertPrompt: the version he keeps, the ship command or the manual ship, the before shot, no Earlier runs line", () => {
  const pin = { id: 9, host: "one.koglabs.com", path: "/", url: "https://one.koglabs.com/", note: "Smaller title", attempts: 2,
    targets: [{ selector: "h1", label: "h1 <Title>" }], versions: VERSIONS, revert: { commits: [B], attempts: 2 } };
  const project = { name: "one", dir: "/srv/one", candidates: ["one"] };
  const choice = chooseModel({ ...pin, attempts: 0 });
  const shipped = buildRevertPrompt({ pin, project, choice, brief: BRIEF, shot: true, lean: true });
  assert.ok(shipped.includes(`Undo these commits, newest first:\n  ${B} · fix 2 · 2026-11-14 · Margin ‹24px› to 16px\nHe goes back to the page after fix 1 (${A.slice(0, 7)}). Fix 1 and the fixes before it stay.\n`));
  assert.ok(shipped.includes("Model: Opus 5.5 high.\nThis session starts lean:"));
  assert.ok(shipped.includes('PINS_AGENT=claude pins ship 9 --dir /srv/work/<repo>-pin9 --message "Revert pin #9: <short what>" --summary "<what he now sees, one line, English>" <every changed file, also deleted ones>'));
  assert.ok(shipped.includes('5. Shots: the harness took the "before" shot (the page with the fix).\n'));
  assert.ok(shipped.includes("element: h1 ‹Title›"));
  assert.ok(shipped.includes("Note: Smaller title"));
  assert.ok(!shipped.includes("Earlier runs:"), "the fix runs are not runs of this go back");
  assert.ok(shipped.includes("8. Never dismiss this pin."));
  const manual = buildRevertPrompt({ pin: { ...pin, revert: { commits: [B, A] } }, project, choice });
  assert.ok(manual.includes("He goes back to the page before this pin.\n"));
  assert.ok(manual.includes("7. Ship: build and tests pass, commit (explicit paths), push, merge, deploy the way this project deploys, then check the live page. Then close: PINS_AGENT=claude pins done 9"));
  assert.ok(manual.includes("PINS_AGENT=claude pins snap 9 before` before the undo"));
  assert.ok(!manual.includes("pins ship"));
  assert.ok(manual.includes("How to work:\n1. Read the project memory first"), "no card: the memory");
  assert.ok(!/\u0000/.test(manual));
});
