import test from "node:test";
import assert from "node:assert/strict";
import { harness, makePin, FakeClock } from "./helpers.js";

// The state machine of a run: claim, watch, end. Each test holds one case that the audit of
// 2026-11 found or checked (docs/protocol.md, Auto-fix runner, items 4, 7, 10, 11 and 13).
const calls = (h, action) => h.requests.filter((request) => request.path.endsWith(`/${action}`)).map((request) => request.path);
const ended = (h, task, lastLine = "Stop") => h.tasks.set(task, { status: "failed", exitCode: 1, lastLine });
// What he does in the extension: an answer, "Not right" or Reopen puts the pin back in the queue.
// The server counts it in `reopens` (a pin from before the v3.1 schema holds null).
const sendBack = (h, id) => {
  const pin = h.pins.get(id);
  Object.assign(pin, { status: "queued", run: null, agent: null, startedAt: null, replyCount: pin.replyCount + 1,
    reopens: pin.reopens === null ? null : pin.reopens + 1, updatedAt: new Date(h.clock.now() + 1).toISOString() });
  h.emit("reply", { pin, reply: { kind: "user", body: "Use the dark blue" } });
};
// What a session does with `pins reopen` on its own pin: the same queue state, and no count.
const agentReopen = (h, id) => {
  const pin = h.pins.get(id);
  Object.assign(pin, { status: "queued", run: null, agent: null, startedAt: null, updatedAt: new Date(h.clock.now() + 1).toISOString() });
  h.emit("pin", { action: "updated", pin });
};

test("failover: a task that Triad continued on the other account is watched there, with no second session", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); await h.settle();
  h.tasks.set("101", { status: "failed", exitCode: 1, lastLine: "Continued on Claude 2 as task 205.", continuedAs: "205" });
  h.tasks.set("205", { status: "running", exitCode: null, lastLine: "" });
  await h.clock.tick(60_000);
  assert.equal(h.delegates.length, 1, "the same session goes on; a second one would work on the same pin");
  assert.deepEqual([h.pins.get(1).status, h.pins.get(1).run], ["working", "triad:101"]);
  assert.deepEqual([...calls(h, "replies"), ...calls(h, "reopen"), ...calls(h, "ask")], []);
  assert.ok(h.checks.some((check) => check.id === "205"), "the runner watches the new task");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("run continues")), ["run continues triad:101 task=205"]);
  // The continued task ends without a result: the normal retry follows, one time.
  ended(h, "205", "Quota");
  await h.clock.tick(15_000); await h.settle();
  assert.deepEqual(calls(h, "reopen"), ["/api/pins/1/reopen"]);
  assert.equal(h.delegates.length, 2);
});

test("a pin that he sends back while its run still runs waits for the end of that run, then starts a new run", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); await h.settle();
  sendBack(h, 1); await h.settle();
  assert.equal(h.delegates.length, 1, "one session at a time on a pin");
  h.tasks.set("101", { status: "done", exitCode: 0, lastLine: "Asked him" });
  await h.clock.tick(15_000); await h.settle();
  assert.deepEqual(calls(h, "ask"), [], "his answer gets no 'the run ended without a result'");
  assert.equal(h.delegates.length, 2);
  assert.deepEqual([h.pins.get(1).status, h.pins.get(1).run, h.pins.get(1).attempts], ["working", "triad:102", 2]);
});

test("a pin that its own session reopened gets the question when the run ends, not a new run each time", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); h.add(2, "two.koglabs.com", { reopens: null }); await h.settle();
  // Each session of pin 1 runs `pins reopen` and ends.
  for (let round = 0; round < 4 && h.pins.get(1).status === "working"; round++) {
    const task = h.pins.get(1).run.slice("triad:".length);
    agentReopen(h, 1); await h.settle();
    h.tasks.set(task, { status: "done", exitCode: 0, lastLine: "Reopened" });
    await h.clock.tick(15_000); await h.settle();
  }
  assert.equal(h.delegates.filter(({ body }) => body.label.startsWith("Pin #1 ")).length, 1, "a reopen by an agent is not his order: no run without end");
  assert.equal(h.pins.get(1).question, "The run ended without a result (done, exit 0): Reopened. Reply to retry, or dismiss it.");
  // Pin 2 is older than the count: nobody can tell who sent it back, so he gets the question too.
  sendBack(h, 2); await h.settle();
  h.tasks.set("102", { status: "done", exitCode: 0, lastLine: "Asked him" });
  await h.clock.tick(15_000); await h.settle();
  assert.equal(h.pins.get(2).question, "The run ended without a result (done, exit 0): Asked him. Reply to retry, or dismiss it.");
  assert.equal(h.delegates.length, 2);
});

test("a pin that another agent took after a reopen is left alone when the old run ends", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); h.add(2, "two.koglabs.com"); await h.settle();
  Object.assign(h.pins.get(1), { status: "working", run: null, agent: "other" });
  Object.assign(h.pins.get(2), { status: "working", run: "triad:900", agent: "other" });
  h.tasks.set("900", { status: "running", exitCode: null, lastLine: "" });
  ended(h, "101"); ended(h, "102");
  await h.clock.tick(15_000);
  assert.deepEqual([...calls(h, "replies"), ...calls(h, "reopen"), ...calls(h, "ask")], []);
  assert.deepEqual([1, 2].map((id) => [h.pins.get(id).status, h.pins.get(id).agent]), [["working", "other"], ["working", "other"]]);
});

test("a claim that the server refuses (429) is tried again after 3 s, then after 6 s; the pin joins the same run and gets its shot", async (t) => {
  const shots = [];
  const h = harness(t, { shoot: async (id) => { shots.push(id); } });
  let refused = 0;
  h.intercept((request) => request.path === "/api/pins/1/start" && refused++ < 2 ? h.response({ error: "write limit exceeded" }, 429) : undefined);
  await h.start(); h.add(1); await h.settle();
  assert.equal(h.pins.get(1).status, "queued");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("pin claim")), ["pin claim failed pin=1 http=429"]);
  await h.clock.tick(2_999);
  assert.equal(calls(h, "start").length, 1);
  await h.clock.tick(1);
  assert.equal(calls(h, "start").length, 2, "second refusal");
  await h.clock.tick(5_999);
  assert.equal(calls(h, "start").length, 2, "the wait doubles");
  await h.clock.tick(1);
  assert.deepEqual([h.pins.get(1).status, h.pins.get(1).run, h.pins.get(1).model], ["working", "triad:101", "opus 5.5 high"]);
  assert.equal(h.delegates.length, 1, "never a second session");
  assert.deepEqual(shots, [1]);
  await h.clock.tick(60_000);
  assert.equal(calls(h, "start").length, 3, "a claimed pin is not claimed again");
});

test("each refused claim pass doubles the wait (3, 6, then 12 s); a Retry-After of the server is the least wait", async (t) => {
  const h = harness(t);
  let retryAfter = null;
  h.intercept((request) => request.path !== "/api/pins/1/start" ? undefined
    : new Response(JSON.stringify({ error: "write limit exceeded" }), { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} }));
  await h.start(); h.add(1); await h.settle();
  const first = h.clock.now();
  const seconds = () => h.requests.filter((request) => request.path === "/api/pins/1/start").map((request) => (request.at - first) / 1000);
  await h.clock.tick(120_000);
  assert.deepEqual(seconds(), [0, 3, 9, 21, 33, 45, 57, 69, 81, 93, 105, 117], "12 calls in 2 minutes; a retry every 3 s made 41");
  retryAfter = "45";
  await h.clock.tick(75_000);
  assert.deepEqual(seconds().slice(12), [129, 174], "the server asked for 45 s: longer than 12 s, so it counts");
  retryAfter = "1";
  await h.clock.tick(75_000);
  assert.deepEqual(seconds().slice(14), [219, 231, 243, 255, 267], "a short Retry-After does not cut the wait");
  // The wait belongs to the run: the refused claim of another run is made again after 3 s.
  let refused = 0;
  h.intercept((request) => request.path === "/api/pins/2/start" && refused++ === 0 ? h.response({}, 503) : undefined);
  h.add(2, "two.koglabs.com"); await h.settle();
  await h.clock.tick(3_000);
  assert.deepEqual([h.pins.get(2).status, h.pins.get(2).run, h.pins.get(1).status], ["working", "triad:102", "queued"]);
  await h.clock.tick(12_000);
  assert.deepEqual([h.pins.get(1).status, h.pins.get(1).run, seconds().at(-1), h.delegates.length], ["working", "triad:101", 279, 2]);
});

test("a pin that he changed while its claim was refused leaves the old run and starts its own", async (t) => {
  const h = harness(t);
  let refuse = true;
  h.intercept((request) => refuse && request.path.endsWith("/start") ? h.response({ error: "write limit exceeded" }, 429) : undefined);
  await h.start(); h.add(1); h.add(2, "two.koglabs.com"); await h.settle();
  assert.deepEqual([h.pins.get(1).status, h.pins.get(2).status, h.delegates.length], ["queued", "queued", 2]);
  // The session of pin 1 asks him (ask accepts a queued pin), and he answers before the next claim.
  Object.assign(h.pins.get(1), { status: "waiting", replyCount: 1, updatedAt: new Date(h.clock.now() + 1).toISOString() });
  h.emit("pin", { action: "updated", pin: h.pins.get(1) }); await h.settle();
  sendBack(h, 1); await h.settle();
  // He edits the note of pin 2. The event does not arrive: the runner sees the change in its own read.
  Object.assign(h.pins.get(2), { note: "New words", updatedAt: new Date(h.clock.now() + 1).toISOString() });
  refuse = false;
  await h.clock.tick(3_000); await h.settle();
  assert.deepEqual([1, 2].map((id) => [h.pins.get(id).status, h.pins.get(id).run, h.pins.get(id).attempts]),
    [["working", "triad:103", 1], ["working", "triad:104", 1]], "a new order: not a late claim for the old run");
  assert.equal(h.delegates.length, 4);
  assert.ok(h.delegates[3].body.prompt.includes("Note: New words\n"));
  // The old runs end: they owe these pins nothing.
  h.requests.length = 0;
  ended(h, "101"); ended(h, "102");
  await h.clock.tick(15_000); await h.settle();
  assert.deepEqual([...calls(h, "replies"), ...calls(h, "reopen"), ...calls(h, "ask")], []);
  assert.equal(h.delegates.length, 4);
});

test("a claim whose answer was lost keeps the pin; a pin that closed or moved on before the retry leaves the run", async (t) => {
  const h = harness(t);
  let lost = false;
  h.intercept((request) => {
    if (request.path === "/api/pins/1/start" && !lost) {
      lost = true;
      Object.assign(h.pins.get(1), { status: "working", run: request.body.run, attempts: 1 });
      return h.response({}, 503);
    }
    if (request.path === "/api/pins/2/start" || request.path === "/api/pins/3/start") return h.response({}, 503);
  });
  await h.start(); h.add(1); h.add(2, "two.koglabs.com"); h.add(3, "three.koglabs.com"); await h.settle();
  h.pins.get(2).status = "done";
  h.pins.delete(3);
  await h.clock.tick(3_000);
  assert.deepEqual(calls(h, "start"), ["/api/pins/1/start", "/api/pins/2/start", "/api/pins/3/start"], "no second start call");
  for (const task of ["101", "102", "103"]) ended(h, task);
  await h.clock.tick(15_000);
  assert.deepEqual(calls(h, "replies"), ["/api/pins/1/replies"], "pin 1 is still in its run and gets the retry");
  assert.deepEqual(calls(h, "ask"), []);
  assert.equal(h.pins.get(2).status, "done");
});

test("a pin whose claim never worked gets the question when its run ends", async (t) => {
  const h = harness(t);
  h.intercept((request) => request.path === "/api/pins/1/start" ? h.response({}, 503) : undefined);
  await h.start(); h.add(1); await h.settle();
  ended(h, "101");
  await h.clock.tick(15_000);
  assert.equal(h.pins.get(1).question, "The run ended without a result (failed, exit 1): Stop. Reply to retry, or dismiss it.");
  assert.equal(h.delegates.length, 1);
});

// RR-1. POST /api/reset in Triad clears its task list and stops no session, so Triad answers 404
// for a task that still runs. Triad stops every task after 105 minutes (agents.json, timeoutMs).
const unknown = () => Object.assign(new Error("Triad HTTP 404"), { status: 404 });
const GONE = "The run ended without a result (gone, exit null): Triad does not know this task. Reply to retry, or dismiss it.";
const writes = (h) => [...calls(h, "replies"), ...calls(h, "reopen"), ...calls(h, "ask")];

for (const earlier of [0, 1]) {
  test(`a task that Triad does not know (HTTP 404) can still run: a pin with ${earlier + 1} of 2 attempts keeps its run and its session`, async (t) => {
    const h = harness(t);
    await h.start(); h.add(1, undefined, { attempts: earlier }); await h.settle();
    h.tasks.set("101", unknown());
    await h.clock.tick(60_000);
    assert.equal(h.delegates.length, 1, "the session still runs; a second one would work on the same pin");
    assert.deepEqual([h.pins.get(1).status, h.pins.get(1).run, h.pins.get(1).attempts], ["working", "triad:101", earlier + 1]);
    assert.deepEqual(writes(h), [], "no retry and no question: the session can still post steps and ship");
    assert.equal(h.checks.filter((check) => check.id === "101").length, 4, "the run is still watched");
    assert.deepEqual(h.logs.filter((line) => line.startsWith("run ")), ["run unknown triad:101"], "one line per run, not one per watch");
  });
}

test("an unknown task ends when Triad cannot still run it (120 minutes after the delegation); the pin gets the question, never a retry", async (t) => {
  const h = harness(t, { config: { maxRuns: 1 } });
  await h.start(); h.add(1); await h.settle();
  h.add(2, "two.koglabs.com");
  h.tasks.set("101", unknown());
  await h.clock.tick(120 * 60_000 - 1);
  assert.deepEqual([h.pins.get(1).status, h.pins.get(2).status, writes(h)], ["working", "queued", []]);
  await h.clock.tick(1); await h.settle();
  assert.equal(h.pins.get(1).question, GONE, "attempts 1 of 2, and still no retry: nobody knows what the session did");
  assert.deepEqual([calls(h, "replies"), calls(h, "reopen")], [[], []]);
  assert.deepEqual(h.logs.filter((line) => line.startsWith("run ")), ["run unknown triad:101", "run ended triad:101 status=gone"]);
  assert.deepEqual([h.pins.get(2).status, h.pins.get(2).run], ["working", "triad:102"], "the slot is free again");
  // Any other Triad error is not an end and not "unknown": the runner asks again.
  h.tasks.set("102", Object.assign(new Error("Triad HTTP 503"), { status: 503 }));
  await h.clock.tick(120 * 60_000);
  assert.equal(h.pins.get(2).status, "working");
  assert.ok(h.logs.includes("run watch failed triad:102 http=503") && !h.logs.includes("run unknown triad:102"));
});

test("an adopted run counts from the oldest start of its pins; a failover starts the count again", async (t) => {
  const clock = new FakeClock();
  const ago = (minutes) => new Date(clock.now() - minutes * 60_000).toISOString();
  const working = (id, run, minutes) => makePin(id, clock.now() - 200 * 60_000, { host: `p${id}.koglabs.com`, status: "working", run, attempts: 1, agent: "claude", startedAt: ago(minutes) });
  const h = harness(t, { clock, initial: [working(1, "triad:42", 100), working(2, "triad:42", 119), working(3, "triad:43", 119)] });
  h.tasks.set("42", unknown());
  h.tasks.set("43", { status: "failed", exitCode: 1, lastLine: "Continued on Claude 2 as task 77.", continuedAs: "77" });
  h.tasks.set("77", unknown());
  await h.start();
  await clock.tick(45_000);
  assert.deepEqual([1, 2, 3].map((id) => h.pins.get(id).status), ["working", "working", "working"], "119 minutes and 45 s");
  await clock.tick(15_000);
  assert.deepEqual([h.pins.get(1).question, h.pins.get(2).question], [GONE, GONE], "120 minutes after the oldest start");
  assert.equal(h.pins.get(3).status, "working", "task 77 started when task 43 ended, not 120 minutes ago");
  await clock.tick(119 * 60_000);
  assert.equal(h.pins.get(3).status, "working");
  await clock.tick(60_000);
  assert.equal(h.pins.get(3).question, GONE);
  assert.equal(h.delegates.length, 0);
});

test("a broken budget file does not stop the runner; with a daily limit the day counts as used", async (t) => {
  const clock = new FakeClock();
  const saved = [];
  const budget = { load: async () => { throw new Error("Invalid runner budget"); }, save: async (value) => { saved.push(value); } };
  const initial = [makePin(1, clock.now() - 86_400_000, { status: "working", run: "triad:42", attempts: 2, startedAt: new Date(clock.now() - 86_400_000).toISOString() })];
  const h = harness(t, { clock, initial, config: { budget, maxRunsPerDay: 5 } });
  ended(h, "42");
  await h.start(); h.add(2, "two.koglabs.com"); await clock.tick(15_000);
  assert.equal(h.pins.get(1).status, "waiting", "runs that already run are still watched and closed");
  assert.equal(h.delegates.length, 0, "fail closed: no new run today");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("budget")), ["budget file unreadable; today counts as used"]);
  await clock.tick(86_400_000);
  assert.equal(h.delegates.length, 1, "the next UTC day starts new runs");
  assert.deepEqual(saved, [{ day: "2026-10-18", used: 1 }], "and writes a good file");

  const free = harness(t, { config: { budget } });
  await free.start(); free.add(1); await free.settle();
  assert.equal(free.delegates.length, 1, "no daily limit: nothing waits");
});

test("after a failed delegation, a question that the server did not take is sent again; a pin that he changed gets none", async (t) => {
  const h = harness(t);
  let fail = true, down = true;
  h.onDelegate(() => {
    if (fail) throw new Error("Lost response");
    h.tasks.set("301", { status: "running", exitCode: null, lastLine: "" });
    return "301";
  });
  h.intercept((request) => down && request.path.endsWith("/ask") ? h.response({}, 503) : undefined);
  const asks = (id) => calls(h, "ask").filter((path) => path === `/api/pins/${id}/ask`).length;
  const runsOf = (id) => h.delegates.filter(({ body }) => body.label.startsWith(`Pin #${id} `)).length;
  await h.start(); h.add(1); await h.settle();
  assert.deepEqual([h.pins.get(1).status, asks(1)], ["queued", 1]);
  assert.deepEqual(h.logs.filter((line) => line.startsWith("pin ask failed")), ["pin ask failed pin=1 http=503"]);
  // 30 s later the pause is over: pin 2 fails in the same way, and the question of pin 1 fails again.
  h.add(2, "two.koglabs.com"); await h.clock.tick(30_000);
  assert.deepEqual([asks(1), runsOf(2), h.runner.sizes().owed], [2, 1, 2]);
  // He edits pin 2: a new order. Its old question is void, and the pin runs.
  fail = false; down = false;
  Object.assign(h.pins.get(2), { note: "New words", updatedAt: new Date(h.clock.now() + 1).toISOString() });
  h.emit("pin", { action: "updated", pin: h.pins.get(2) });
  await h.clock.tick(30_000);
  assert.equal(h.pins.get(1).question, "Auto-fix could not start a fix run (unavailable). Reply to retry, or dismiss it.");
  assert.deepEqual([h.pins.get(2).status, asks(2), runsOf(2)], ["working", 0, 2], "no late question on the pin that runs");
  assert.deepEqual([asks(1), runsOf(1), h.runner.sizes().owed], [3, 1, 0], "one try per pass; pin 1 is never delegated again");
});

test("a throw in the log does not break the decision queue", async (t) => {
  const h = harness(t, { config: { log: (line) => { if (line.startsWith("runner decision failed")) throw new Error("log failed"); } } });
  let broken = true;
  h.intercept((request) => broken && request.path === "/api/pins/1" ? h.response({}, 503) : undefined);
  await h.start(); h.add(1); await h.settle();
  assert.equal(h.delegates.length, 0);
  broken = false;
  await h.clock.tick(30_000);
  assert.equal(h.delegates.length, 1, "the next pass still runs");
});

test("an events request that never answers is given up after 10 s and tried again", async (t) => {
  const h = harness(t);
  let hung = 0;
  h.intercept((request) => request.path === "/api/events" && hung++ === 0
    ? new Promise((_, reject) => request.options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
    : undefined);
  await h.start();
  await h.clock.tick(9_999);
  assert.equal(h.streams.length, 0);
  await h.clock.tick(1 + 3_000);
  assert.equal(h.streams.length, 1, "aborted at 10 s, connected again 3 s later");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("events")), ["events reconnect unavailable"]);
});

test("a before shot that waited more than 60 s is skipped: the page may show the change by then", async (t) => {
  const finish = new Map();
  const h = harness(t, { shoot: (id) => new Promise((resolve) => finish.set(id, resolve)) });
  await h.start();
  for (let id = 1; id <= 5; id++) h.add(id);
  await h.settle();
  assert.deepEqual([...finish.keys()], [1, 2]);
  await h.clock.tick(60_000);
  finish.get(1)(); await h.settle();
  assert.deepEqual([...finish.keys()], [1, 2, 3], "60 s is still in time");
  await h.clock.tick(1);
  finish.get(2)(); finish.get(3)(); await h.settle();
  assert.deepEqual([...finish.keys()], [1, 2, 3], "shots 4 and 5 waited too long");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("before shot")), ["before shot skipped pin=4", "before shot skipped pin=5"]);
  assert.equal(h.runner.sizes().shots, 0);
});

test("a claim that comes more than 60 s after the delegation gets no before shot: the session may have changed the page by then", async (t) => {
  const shots = [];
  const h = harness(t, { shoot: async (id) => { shots.push([id, (h.clock.now() - start) / 1000]); } });
  const start = h.clock.now();
  // The write limit refuses the claim of pin 1 for 40 s and the claim of pin 2 for 60 s.
  h.intercept((request) => {
    const until = { "/api/pins/1/start": 40_000, "/api/pins/2/start": 60_000 }[request.path];
    return until && request.at - start < until ? h.response({ error: "write limit exceeded" }, 429) : undefined;
  });
  await h.start(); h.add(1); h.add(2, "two.koglabs.com"); await h.settle();
  assert.deepEqual(h.delegates.map((delegate) => delegate.at), [start, start]);
  await h.clock.tick(75_000); await h.settle();
  assert.deepEqual([1, 2].map((id) => [h.pins.get(id).status, h.pins.get(id).run]), [["working", "triad:101"], ["working", "triad:102"]]);
  assert.deepEqual(shots, [[1, 45]], "pin 1 was claimed 45 s after its delegation, pin 2 after 75 s");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("before shot")), ["before shot skipped pin=2"]);
});

test("memory: 2500 pins through start, end and close, over two UTC days, leave no state behind", async (t) => {
  // Round 12 of 25 starts at midnight UTC.
  const clock = new FakeClock(Date.parse("2026-10-17T23:57:00Z"));
  const h = harness(t, { clock, shoot: async () => {} });
  await h.start();
  let peak = 0;
  for (let round = 0; round < 25; round++) {
    for (let n = 1; n <= 100; n++) h.add(round * 100 + n, `p${n % 7}.koglabs.com`, n % 10 ? {} : { batch: round + 1 });
    await h.settle();
    peak = Math.max(peak, h.runner.sizes().runs);
    for (let n = 1; n <= 100; n++) {
      const id = round * 100 + n, task = String(100 + id);
      // Most sessions close their pin. Some are dismissed or deleted, and some end without a result.
      if (n % 25 === 0) h.pins.delete(id);
      else if (n % 10 !== 1) h.pins.get(id).status = n % 9 ? "done" : "dismissed";
      else h.pins.get(id).attempts = 2;
      h.tasks.set(task, { status: n % 10 === 1 ? "failed" : "done", exitCode: 0, lastLine: "End" });
    }
    await clock.tick(15_000); await h.settle();
    // The harness is not under test: drop what it recorded.
    h.requests.length = h.delegates.length = h.order.length = h.logs.length = h.checks.length = 0;
  }
  await clock.tick(30_000);
  assert.equal(peak, 100);
  assert.deepEqual(h.runner.sizes(), { pending: 0, runs: 0, attempted: 0, owed: 0, shots: 0, counted: 1300, endedRuns: 1000 },
    "only the run ids of today (13 rounds after midnight) and the newest 1000 ended runs stay");
  assert.equal([...h.pins.values()].filter((pin) => pin.status === "waiting").length, 250, "every failed run asked its pin");
});
