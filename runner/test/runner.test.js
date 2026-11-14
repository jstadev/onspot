import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../src/runner.js";
import { readConfig } from "../src/config.js";
import { harness, makePin, FakeClock, flush } from "./helpers.js";

const starts = (h) => h.requests.filter((request) => request.path.endsWith("/start"));
const done = (h, id, task) => {
  h.pins.get(id).status = "done";
  h.tasks.set(task, { status: "done", exitCode: 0, lastLine: "Finished" });
};

test("two pins of one batch start two runs at once, each with its own label, model and claim", async (t) => {
  const h = harness(t, { resolveProject: async () => ({ name: "shared", dir: "/tmp/shared", candidates: ["shared"] }) });
  await h.start();
  const start = h.clock.now();
  h.add(1, undefined, { batch: 7 }); h.add(2, "two.koglabs.com", { batch: 7 });
  await h.settle();
  assert.equal(h.delegates.length, 2);
  assert.deepEqual(h.delegates.map((delegate) => delegate.at), [start, start], "no quiet window");
  assert.deepEqual(h.delegates.map(({ body }) => [body.label, body.model, body.effort, body.cwd]), [
    ["Pin #1 · Private pin note · Opus 5.5 high", "claude-opus-5-5", "high", "/tmp/shared"],
    ["Pin #2 · Private pin note · Opus 5.5 high", "claude-opus-5-5", "high", "/tmp/shared"],
  ]);
  assert.ok(h.delegates[0].body.prompt.startsWith("You are the OnSpot session for pin #1 on one.koglabs.com."));
  assert.deepEqual(starts(h).map((request) => [request.path, request.body]), [
    ["/api/pins/1/start", { run: "triad:101", model: "opus 5.5 high" }],
    ["/api/pins/2/start", { run: "triad:102", model: "opus 5.5 high" }],
  ]);
  assert.deepEqual([1, 2].map((id) => [h.pins.get(id).status, h.pins.get(id).run, h.pins.get(id).attempts]), [["working", "triad:101", 1], ["working", "triad:102", 1]]);
  assert.ok(h.logs.some((line) => line === "started run triad:101 pin=1 model=opus 5.5 high"));
  assert.ok(h.logs.every((line) => !line.includes("Private pin note")));
});

test("a single pin without a batch also starts at once", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); await h.settle();
  assert.equal(h.delegates.length, 1);
  assert.equal(h.delegates[0].at, h.clock.now());
});

test("a model that he names in the note or in a preset sets the model, effort, label and claim", async (t) => {
  const h = harness(t);
  await h.start();
  h.add(1, undefined, { note: "use sonnet 5.5 max for the booking form" });
  h.add(2, "two.koglabs.com", { presets: [{ label: "Big", text: "Use Fable xhigh" }] });
  await h.settle();
  assert.deepEqual(h.delegates.map(({ body }) => [body.label, body.model, body.effort]), [
    ["Pin #1 · use sonnet 5.5 max for the booking form · Sonnet 5.5 max", "claude-sonnet-5-5", "max"],
    ["Pin #2 · Private pin note · Fable 5.2 xhigh", "claude-fable-5-2", "xhigh"],
  ]);
  assert.deepEqual([h.pins.get(1).model, h.pins.get(2).model], ["sonnet 5.5 max", "fable 5.2 xhigh"]);
  assert.match(h.delegates[0].body.prompt, /Model: Sonnet 5\.5 max\./);
  assert.match(h.delegates[1].body.prompt, /Model: Fable 5\.2 xhigh\./);
  assert.ok(h.logs.every((line) => !line.includes("booking")), "notes stay out of the log");
});

test("the oldest pin starts first when a limit holds the others", async (t) => {
  const clock = new FakeClock();
  const h = harness(t, { clock, config: { maxRuns: 1 }, initial: [5, 2, 9].map((id) => makePin(id, clock.now(), { host: `p${id}.koglabs.com` })) });
  await h.start();
  assert.deepEqual(h.delegates.map(({ body }) => body.label.match(/#\d+/)[0]), ["#2"]);
  done(h, 2, "101"); await clock.tick(15_000);
  done(h, 5, "102"); await clock.tick(15_000);
  assert.deepEqual(h.delegates.map(({ body }) => body.label.match(/#\d+/)[0]), ["#2", "#5", "#9"]);
});

test("history and siblings are read before the start and go into the prompt", async (t) => {
  const clock = new FakeClock();
  const day = (days) => new Date(clock.now() - days * 86_400_000).toISOString();
  const target = [{ selector: "main > h2", label: 'h2 "Title"' }];
  const old = (id, days, extra = {}) => makePin(id, clock.now(), { status: "done", targets: target, closedAt: day(days), summary: `Summary ${id}`, commit: `c0ffee${id}abcdef`, ...extra });
  const initial = [
    old(1, 20), old(2, 13), old(3, 9), old(4, 5), old(6, 1),
    old(10, 2, { host: "two.koglabs.com" }), old(11, 2, { targets: [{ selector: "main > h3", label: "h3" }] }),
    makePin(12, clock.now(), { status: "dismissed", targets: target, closedAt: day(1) }),
    makePin(8, clock.now(), { status: "done", batch: 7, host: "two.koglabs.com", closedAt: day(0), targets: [{ selector: "#b", label: 'img "boat"' }], note: "Sibling eight" }),
    makePin(9, clock.now(), { status: "waiting", batch: 8, note: "Other batch" }),
  ];
  const h = harness(t, { clock, initial, autofix: false });
  await h.start();
  h.requests.length = 0;
  h.add(5, undefined, { batch: 7, targets: target }, false);
  h.setAutofix(true); await h.clock.tick(30_000);
  assert.equal(h.delegates.length, 1);
  const lists = h.requests.filter((request) => request.path === "/api/pins" && (request.query.has("selector") || request.query.has("batch")));
  assert.deepEqual(lists.map((request) => Object.fromEntries(request.query)), [
    { host: "one.koglabs.com", selector: "main > h2", status: "done", limit: "10" },
    { batch: "7", status: "all", limit: "30" },
  ]);
  assert.ok(lists.every((request) => request.method === "GET" && request.at < h.delegates[0].at + 1));
  assert.ok(h.order.indexOf("delegate") > h.order.lastIndexOf("GET /api/pins"), "both reads come before the delegation");
  const prompt = h.delegates[0].body.prompt;
  assert.deepEqual(prompt.match(/Earlier on this element: #\d+ \([\d-]+\)/g), [6, 4, 3].map((id) => `Earlier on this element: #${id} (${day(id === 6 ? 1 : id === 4 ? 5 : 9).slice(0, 10)})`),
    "same host and element, done, closed in the last 14 days, newest 3, without the pin itself");
  assert.ok(prompt.includes('-> Summary 6 (c0ffee6).'));
  assert.ok(prompt.includes("Other pins from the same submit, each in its own session now:\n  #8 · Sibling eight\nDo not do their work. The page data names their elements."));
  assert.ok(prompt.includes('elements of the other pins: #8 img "boat"\n</page-data>'), "a sibling element name is page text: inside the fence");
  assert.ok(!prompt.includes("\n  #5 ·") && !prompt.includes("Other batch"), "without the pin itself and other batches");
});

test("a pin without a batch or an element reads no context, and a failed read does not stop the run", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); await h.settle();
  assert.equal(h.requests.filter((request) => request.path === "/api/pins" && (request.query.has("selector") || request.query.has("batch"))).length, 0);
  h.intercept((request) => request.path === "/api/pins" && request.query.has("selector") ? h.response({ error: "bad selector" }, 400)
    : request.path === "/api/pins" && request.query.has("batch") ? h.response({}, 503) : undefined);
  h.add(2, "two.koglabs.com", { batch: 4, targets: [{ selector: "h1", label: "h1" }] }); await h.settle();
  assert.equal(h.delegates.length, 2);
  assert.equal(h.pins.get(2).status, "working");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("context read failed")), ["context read failed pin=2 http=400", "context read failed pin=2 http=503"]);
  assert.ok(!h.delegates[1].body.prompt.includes("Earlier on this element"));
});

test("unknown projects use the host as the project key and PINS_RUNNER_CWD as cwd", async (t) => {
  const h = harness(t, { config: { ...readConfig({ PINS_RUNNER_CWD: "/root" }), maxRunsPerProject: 1 }, resolveProject: async () => ({ name: null, dir: null, candidates: [] }) });
  await h.start();
  h.add(1); h.add(2); h.add(3, "two.koglabs.com");
  await h.settle();
  assert.deepEqual(h.delegates.map(({ body }) => [body.label.match(/#\d+/)[0], body.cwd]), [["#1", "/root"], ["#3", "/root"]]);
  assert.equal(h.pins.get(2).status, "queued");
});

test("skipped host suffixes stay queued for the agent that owns them", async (t) => {
  const h = harness(t, { config: readConfig({ PINS_RUNNER_SKIP_HOSTS: ".drop.koglabs.com" }) });
  await h.start();
  h.add(1, "fox-shop.drop.koglabs.com"); h.add(2, "two.koglabs.com"); h.add(3, "drop.koglabs.com");
  await h.clock.tick(120_000);
  assert.equal(h.pins.get(1).status, "queued");
  assert.equal(h.delegates.length, 2);
  assert.ok(h.delegates.every(({ body }) => !body.label.includes("fox-shop")));
});

test("the global limit leaves a pin queued until a slot is free, and logs the limit once per pin", async (t) => {
  const h = harness(t, { config: { maxRuns: 2 } });
  await h.start();
  h.add(1); h.add(2, "two.koglabs.com"); h.add(3, "three.koglabs.com"); h.add(4, "four.koglabs.com");
  await h.clock.tick(70_000);
  assert.equal(h.delegates.length, 2);
  assert.deepEqual([h.pins.get(3).status, h.pins.get(4).status], ["queued", "queued"]);
  assert.deepEqual(h.logs.filter((line) => line.startsWith("limit reached")), ["limit reached concurrent pin=3", "limit reached concurrent pin=4"]);
  done(h, 1, "101");
  await h.clock.tick(5_000);
  assert.equal(h.delegates.length, 3);
  assert.deepEqual([h.pins.get(3).status, h.pins.get(4).status], ["working", "queued"]);
});

test("by default there is no limit: 100 pins of one project start 100 runs in the same moment", async (t) => {
  const h = harness(t, { resolveProject: async () => ({ name: "shared", dir: "/tmp/shared", candidates: ["shared"] }) });
  await h.start();
  const start = h.clock.now();
  for (let id = 1; id <= 100; id++) h.add(id);
  await h.settle();
  assert.equal(h.delegates.length, 100);
  assert.ok(h.delegates.every((delegate) => delegate.at === start), "no pin waits");
  assert.ok([...h.pins.values()].every((pin) => pin.status === "working"));
  assert.ok(h.logs.every((line) => !line.startsWith("limit reached")));
});

test("the per-project limit holds through polls and releases after run cleanup", async (t) => {
  const h = harness(t, { config: { maxRuns: 8, maxRunsPerProject: 2 } });
  await h.start(); h.add(1); h.add(2); h.add(3); h.add(4, "two.koglabs.com");
  await h.clock.tick(70_000);
  assert.deepEqual(h.delegates.map(({ body }) => body.label.match(/#\d+/)[0]), ["#1", "#2", "#4"]);
  assert.equal(h.pins.get(3).status, "queued");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("limit reached")), ["limit reached project pin=3"]);
  h.pins.get(1).status = "dismissed";
  h.tasks.set("101", { status: "failed", exitCode: 1, lastLine: "Stopped" });
  await h.clock.tick(5_000);
  assert.equal(h.pins.get(3).status, "working");
  assert.equal(h.delegates.length, 4);
});

test("the daily limit counts runs and resets at UTC midnight", async (t) => {
  const clock = new FakeClock(Date.parse("2026-10-17T23:58:00Z"));
  const h = harness(t, { clock, config: { maxRunsPerDay: 1 } });
  await h.start(); h.add(1); h.add(2, "two.koglabs.com");
  await clock.tick(119_999);
  assert.equal(h.delegates.length, 1);
  assert.equal(h.pins.get(2).status, "queued");
  await clock.tick(1);
  assert.equal(h.delegates.length, 2);
  assert.equal(h.delegates[1].at, Date.parse("2026-10-18T00:00:00Z"));
  assert.deepEqual(h.logs.filter((line) => line.startsWith("limit reached")), ["limit reached daily pin=2"]);
});

test("environment limits validate their values and ranges", () => {
  const home = { cwd: homedir(), projectsDir: join(homedir(), ".claude", "memory-store", "projects") };
  assert.deepEqual(readConfig({}), { port: 4750, disabled: false, maxRuns: 0, maxRunsPerProject: 0, maxRunsPerDay: 0, skipHosts: [], brief: true, shots: true, lean: true, ...home });
  assert.deepEqual(readConfig({ PINS_PORT: "6000", PINS_RUNNER_DISABLED: "1", MAX_RUNS: "100", MAX_RUNS_PER_PROJECT: "1", MAX_RUNS_PER_DAY: "0", PINS_RUNNER_SKIP_HOSTS: ".drop.koglabs.com, .x.koglabs.com",
    PINS_RUNNER_BRIEF: "0", PINS_RUNNER_SHOTS: "1", PINS_RUNNER_LEAN: "0", PINS_RUNNER_CWD: "/srv/agents", PINS_PROJECTS_DIR: "/srv/memory/projects" }),
    { port: 6000, disabled: true, maxRuns: 100, maxRunsPerProject: 1, maxRunsPerDay: 0, skipHosts: [".drop.koglabs.com", ".x.koglabs.com"], brief: false, shots: true, lean: false,
      cwd: "/srv/agents", projectsDir: "/srv/memory/projects" });
  assert.equal(readConfig({ PINS_RUNNER_DISABLED: "0" }).disabled, false);
  for (const env of [{ PINS_PORT: "https://outside" }, { MAX_RUNS: "-1" }, { MAX_RUNS: "" }, { MAX_RUNS: "2.5" },
    { MAX_RUNS_PER_PROJECT: "-1" }, { MAX_RUNS_PER_DAY: "NaN" }, { PINS_RUNNER_SKIP_HOSTS: "drop.koglabs.com" },
    { PINS_RUNNER_CWD: "relative/folder" }, { PINS_RUNNER_CWD: "" }, { PINS_PROJECTS_DIR: "projects" }]) {
    assert.throws(() => readConfig(env), /Invalid/, JSON.stringify(env));
  }
  for (const config of [{ maxRuns: -1 }, { maxRunsPerProject: 1.5 }, { maxRunsPerDay: -2 }]) assert.throws(() => createRunner({ config }), /Invalid MAX_RUNS/);
});

test("autofix off prevents new runs while running tasks still reach waiting", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); await h.settle();
  h.setAutofix(false); h.add(2, "two.koglabs.com");
  h.tasks.set("101", { status: "done", exitCode: 0, lastLine: "No result" });
  await h.clock.tick(70_000);
  assert.equal(h.delegates.length, 1);
  assert.equal(h.pins.get(1).status, "waiting");
  assert.equal(h.pins.get(2).status, "queued");
  h.setAutofix(true); await flush(); await h.runner.idle();
  assert.equal(h.delegates.length, 2);
});

test("disabled environment still adopts and cleans up working runs", async (t) => {
  const clock = new FakeClock();
  const initial = [makePin(1, clock.now() - 10_000, { status: "working", run: "triad:42", startedAt: new Date(clock.now()).toISOString() })];
  const h = harness(t, { clock, initial, config: readConfig({ PINS_RUNNER_DISABLED: "1" }) });
  h.tasks.set("42", { status: "failed", exitCode: 9, lastLine: "Stopped" });
  await h.start(); h.add(2, "two.koglabs.com"); await clock.tick(60_000);
  assert.equal(h.delegates.length, 0);
  assert.equal(h.pins.get(1).status, "waiting");
  assert.equal(h.pins.get(2).status, "queued");
});

test("settings are checked again before delegation even without a settings event", async (t) => {
  const h = harness(t);
  await h.start();
  h.setAutofix(false, false); h.add(1); await h.clock.tick(29_999);
  assert.equal(h.delegates.length, 0);
  assert.ok(h.requests.some((request) => request.path === "/api/pins/1"), "the pin reached the launch");
});

test("a settings error fails closed and polling recovers", async (t) => {
  const h = harness(t);
  h.intercept((request) => request.path === "/api/settings" ? h.response({}, 503) : undefined);
  await h.start(); h.add(1); await h.clock.tick(30_000);
  assert.equal(h.delegates.length, 0);
  h.intercept(null); await h.clock.tick(30_000);
  assert.equal(h.delegates.length, 1);
});

test("delegation precedes the claim; a 409 is left alone, including at run end", async (t) => {
  const h = harness(t);
  h.intercept((request) => {
    if (request.path === "/api/pins/2/start") {
      Object.assign(h.pins.get(2), { status: "working", run: "manual", agent: "other" });
      return h.response({ error: "taken" }, 409);
    }
  });
  await h.start(); h.add(1); h.add(2, "two.koglabs.com"); await h.settle();
  assert.ok(h.order.indexOf("delegate") < h.order.indexOf("POST /api/pins/1/start"));
  assert.ok(h.order.indexOf("POST /api/pins/1/start") < h.order.lastIndexOf("delegate"));
  assert.ok(h.order.lastIndexOf("delegate") < h.order.indexOf("POST /api/pins/2/start"));
  assert.ok(h.logs.includes("pin claim skipped pin=2 http=409"));
  h.tasks.set("102", { status: "done", exitCode: 0, lastLine: "Finished" });
  await h.clock.tick(15_000);
  assert.equal(h.pins.get(2).agent, "other");
  assert.equal(h.pins.get(2).status, "working");
  assert.equal(h.requests.filter((request) => request.path === "/api/pins/2/ask").length, 0);
});

test("run end asks queued and working pins with the exact clipped message; closed pins stay closed", async (t) => {
  const h = harness(t, { config: { maxRuns: 8, maxRunsPerProject: 8 } });
  h.intercept((request) => request.path === "/api/pins/2/start" ? h.response({}, 503) : undefined);
  // Pin 1 already had its second run, so a failed run hands it to the Chairman.
  await h.start(); h.add(1, undefined, { attempts: 1 }); h.add(2); h.add(3); h.add(4); h.add(5); await h.settle();
  assert.equal(h.delegates.length, 5);
  h.pins.get(3).status = "done"; h.pins.get(4).status = "dismissed"; h.pins.get(5).status = "waiting";
  for (const id of ["101", "102", "103", "104", "105"]) h.tasks.set(id, { status: "failed", exitCode: 1, lastLine: "x".repeat(350) });
  await h.clock.tick(14_999);
  assert.equal(h.requests.filter((request) => request.path.endsWith("/ask")).length, 0);
  await h.clock.tick(1);
  const asks = h.requests.filter((request) => request.path.endsWith("/ask"));
  assert.deepEqual(asks.map((request) => request.path), ["/api/pins/1/ask", "/api/pins/2/ask"]);
  for (const request of asks) assert.equal(request.body.question,
    `The run ended without a result (failed, exit 1): ${"x".repeat(300)}. Reply to retry, or dismiss it.`);
  assert.equal(h.requests.filter((request) => request.path.endsWith("/replies")).length, 0);
  assert.ok(h.logs.every((line) => !line.includes("x".repeat(10))));
});

test("failed ask retries without redelegating or asking successful pins twice", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1, undefined, { attempts: 1 }); h.add(2, undefined, { attempts: 1 }); await h.settle();
  h.intercept((request) => request.path === "/api/pins/2/ask" ? h.response({}, 503) : undefined);
  for (const id of ["101", "102"]) h.tasks.set(id, { status: "done", exitCode: 0, lastLine: "Done" });
  await h.clock.tick(15_000);
  assert.equal(h.pins.get(1).status, "waiting"); assert.equal(h.pins.get(2).status, "working");
  h.intercept(null); await h.clock.tick(15_000);
  assert.equal(h.pins.get(2).status, "waiting");
  assert.equal(h.requests.filter((request) => request.path === "/api/pins/1/ask").length, 1);
  assert.equal(h.delegates.length, 2);
});

test("restart adopts one old task for multiple pins and keeps its project slot", async (t) => {
  const clock = new FakeClock();
  const initial = [1, 2].map((id) => makePin(id, clock.now(), { status: "working", run: "triad:42", attempts: 2, startedAt: new Date(clock.now()).toISOString() }));
  const h = harness(t, { clock, initial, config: { maxRunsPerProject: 1 } });
  h.tasks.set("42", { status: "running", exitCode: null, lastLine: "" });
  await h.start(); h.add(3); await clock.tick(30_000);
  assert.equal(h.delegates.length, 0);
  assert.equal(h.checks.length, 2);
  assert.equal(h.logs.filter((line) => line.startsWith("adopted run triad:42")).length, 1);
  h.tasks.set("42", { status: "done", exitCode: 0, lastLine: "No result" });
  await clock.tick(15_000);
  assert.equal(h.pins.get(1).status, "waiting"); assert.equal(h.pins.get(2).status, "waiting");
  assert.equal(h.delegates.length, 1); assert.equal(h.pins.get(3).run, "triad:101");
});

test("a run that ended in this process is not adopted again from a late event", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1, undefined, { attempts: 1 }); await h.settle();
  const late = structuredClone(h.pins.get(1));
  h.tasks.set("101", { status: "failed", exitCode: 1, lastLine: "Stop" }); await h.clock.tick(15_000);
  assert.equal(h.pins.get(1).status, "waiting");
  const checks = h.checks.length;
  h.emit("pin", { action: "updated", pin: late }); await h.clock.tick(60_000);
  assert.equal(h.checks.length, checks, "no watch of the ended run");
  assert.equal(h.logs.filter((line) => line.startsWith("adopted run")).length, 0);
});

test("restart restores today's run budget from closed pins, counting each task once", async (t) => {
  const clock = new FakeClock();
  const date = new Date(clock.now()).toISOString();
  const initial = [1, 2].map((id) => makePin(id, clock.now(), { status: "done", run: "triad:42", startedAt: date }));
  const h = harness(t, { clock, initial, config: { maxRunsPerDay: 2 } });
  await h.start(); h.add(3); h.add(4, "two.koglabs.com"); await clock.tick(60_000);
  assert.equal(h.delegates.length, 1, "one task used one run; one run is left");
});

test("persistent daily reservation survives restart after pin history is cleared", async (t) => {
  let saved = { day: null, used: 0 };
  const budget = { load: async () => saved, save: async (value) => { saved = value; } };
  const first = harness(t, { config: { budget, maxRunsPerDay: 1 } });
  first.onDelegate(() => {
    assert.deepEqual(saved, { day: "2026-10-17", used: 1 });
    return "101";
  });
  await first.start(); first.add(1); await first.settle(); await first.runner.stop();
  assert.equal(first.delegates.length, 1);
  const next = harness(t, { config: { budget, maxRunsPerDay: 1 } });
  await next.start(); next.add(2); await next.clock.tick(60_000);
  assert.equal(next.delegates.length, 0);
});

test("failed budget persistence blocks delegation and retries without a busy loop", async (t) => {
  let writes = 0, failing = true;
  const budget = { load: async () => ({ day: null, used: 0 }), save: async () => { writes++; if (failing) throw new Error("Read only"); } };
  const h = harness(t, { config: { budget } });
  await h.start(); h.add(1); await h.clock.tick(29_999);
  assert.equal(h.delegates.length, 0); assert.equal(writes, 1);
  failing = false; await h.clock.tick(1);
  assert.equal(h.delegates.length, 1); assert.equal(writes, 2);
});

test("a failed initial scan must complete before settings events can start runs", async (t) => {
  const h = harness(t);
  h.intercept((request) => request.path === "/api/pins" && request.query.get("status") === "all" ? h.response({}, 503) : undefined);
  await h.start(); h.add(1); h.setAutofix(true); await h.clock.tick(20_000);
  assert.equal(h.delegates.length, 0);
  h.intercept(null); await h.clock.tick(10_000);
  assert.equal(h.delegates.length, 1);
});

test("a deleted pin releases its project slot when the run ends", async (t) => {
  const h = harness(t, { config: { maxRunsPerProject: 1 } });
  await h.start(); h.add(1); await h.settle();
  h.pins.delete(1); h.add(2); h.tasks.set("101", { status: "done", exitCode: 0, lastLine: "Done" });
  await h.clock.tick(20_000);
  assert.equal(h.delegates.length, 2);
  assert.equal(h.pins.get(2).status, "working");
});

test("poll pages beyond 500 queued pins without dropping the oldest pin", async (t) => {
  const clock = new FakeClock();
  const initial = Array.from({ length: 501 }, (_, index) => makePin(index + 1, clock.now()));
  const h = harness(t, { clock, initial, autofix: false });
  await h.start(); await clock.tick(30_000);
  assert.ok(h.requests.some((request) => request.path === "/api/pins" && request.query.get("status") === "queued" && request.query.get("before") === "2"));
});

test("SSE reconnect fetches pins missed while disconnected", async (t) => {
  const h = harness(t);
  await h.start(); assert.equal(h.streams.length, 1);
  h.streams[0].close(); await flush();
  h.add(1, "one.koglabs.com", {}, false);
  await h.clock.tick(2_999); assert.equal(h.streams.length, 1);
  assert.equal(h.delegates.length, 0);
  await h.clock.tick(1); assert.equal(h.streams.length, 2);
  await h.settle();
  assert.equal(h.delegates.length, 1);
});

test("poll and repeated SSE events race during delegation without a double start", async (t) => {
  const h = harness(t);
  await h.start(); const pin = h.add(1);
  let complete;
  h.onDelegate(() => new Promise((resolve) => { complete = resolve; }));
  await h.clock.tick(40_000);
  assert.equal(h.delegates.length, 1);
  for (let i = 0; i < 3; i++) h.emit("pin", { action: "created", pin });
  complete("101"); h.tasks.set("101", { status: "running" });
  await flush(); await h.runner.idle(); await h.clock.tick(60_000);
  assert.equal(h.delegates.length, 1);
  assert.equal(starts(h).length, 1);
});

test("a pin that is closed before its claim is re-read is never delegated", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1);
  h.pins.get(1).status = "done";
  await h.clock.tick(60_000);
  assert.ok(h.requests.some((request) => request.path === "/api/pins/1" && request.method === "GET"));
  assert.equal(h.delegates.length, 0);
});

test("a user retry is a new queue generation and runs again, one effort step higher", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1, undefined, { attempts: 1 }); await h.settle();
  assert.equal(h.delegates[0].body.effort, "xhigh");
  h.tasks.set("101", { status: "failed", exitCode: 1, lastLine: "Stop" }); await h.clock.tick(15_000);
  const pin = h.pins.get(1);
  assert.equal(pin.status, "waiting");
  Object.assign(pin, { status: "queued", run: null, startedAt: null, replyCount: 2, updatedAt: new Date(h.clock.now()).toISOString() });
  h.emit("reply", { pin, reply: { body: "Try again" } }); await h.settle();
  assert.equal(h.delegates.length, 2);
  assert.deepEqual([h.delegates[1].body.model, h.delegates[1].body.effort, h.delegates[1].body.label], ["claude-opus-5-5", "xhigh", "Pin #1 · Private pin note · Opus 5.5 xhigh"]);
});

test("a run that ends without a result retries its pin once at the next effort, then asks the Chairman", async (t) => {
  const h = harness(t);
  await h.start();
  h.add(1, undefined, { batch: 4 });
  await h.settle();
  assert.deepEqual([h.delegates[0].body.model, h.delegates[0].body.effort], ["claude-opus-5-5", "high"]);
  h.tasks.set("101", { status: "failed", exitCode: 1, lastLine: "Quota" });
  await h.clock.tick(15_000);
  const retried = h.clock.now();
  await h.settle(); // the reopen event arrives over SSE
  const replies = h.requests.filter((request) => request.path === "/api/pins/1/replies");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.body, "The run ended without a result (failed, exit 1): Quota. Trying again at effort xhigh.");
  assert.ok(h.order.indexOf("POST /api/pins/1/replies") < h.order.indexOf("POST /api/pins/1/reopen"));
  assert.equal(h.delegates.length, 2);
  assert.equal(h.delegates[1].at, retried, "the retry starts at once");
  assert.deepEqual([h.delegates[1].body.model, h.delegates[1].body.effort], ["claude-opus-5-5", "xhigh"]);
  assert.deepEqual([h.pins.get(1).status, h.pins.get(1).attempts, h.pins.get(1).model], ["working", 2, "opus 5.5 xhigh"]);
  h.tasks.set("102", { status: "failed", exitCode: 1, lastLine: "Again" });
  await h.clock.tick(15_000);
  assert.equal(h.pins.get(1).status, "waiting");
  assert.equal(h.pins.get(1).question, "The run ended without a result (failed, exit 1): Again. Reply to retry, or dismiss it.");
  await h.clock.tick(60_000);
  assert.equal(h.delegates.length, 2, "no third run");
});

test("a failed delegation asks its pin, never re-delegates it, and pauses new runs for 30 seconds", async (t) => {
  const h = harness(t);
  let fail = true;
  h.onDelegate(() => {
    if (fail) throw new Error("Lost response");
    h.tasks.set("201", { status: "running", exitCode: null, lastLine: "" });
    return "201";
  });
  await h.start(); h.add(1); await h.settle();
  assert.equal(h.delegates.length, 1);
  assert.equal(h.pins.get(1).status, "waiting");
  assert.equal(h.pins.get(1).question, "Auto-fix could not start a fix run (unavailable). Reply to retry, or dismiss it.");
  assert.equal(starts(h).length, 0);
  fail = false;
  h.add(2); await h.clock.tick(29_999);
  assert.equal(h.delegates.length, 1, "paused");
  await h.clock.tick(1);
  assert.equal(h.delegates.length, 2, "resumes after the pause with the new pin only");
  assert.equal(h.delegates[1].body.label, "Pin #2 · Private pin note · Opus 5.5 high");
  assert.equal(h.pins.get(1).status, "waiting", "the failed pin stays with him");
});

test("stop closes the stream and timers but leaves the Triad run running", async (t) => {
  const h = harness(t);
  await h.start(); h.add(1); await h.settle();
  await h.runner.stop();
  assert.equal(h.clock.timers.size, 0);
  assert.ok(h.streams.every((stream) => stream.closed));
  await h.clock.tick(60_000);
  assert.equal(h.checks.length, 0);
  assert.equal(h.pins.get(1).status, "working");
  assert.equal(h.tasks.get("101").status, "running");
});

test("the run label shows the pin title: his note on one line, at most 48 characters, no separator", async (t) => {
  const { pinTitle } = await import("../src/prompt.js");
  assert.equal(pinTitle({ note: "make this\n  red", host: "a.koglabs.com" }), "make this red");
  assert.equal(pinTitle({ note: "x".repeat(60), host: "a.koglabs.com" }), `${"x".repeat(47)}…`);
  assert.equal(pinTitle({ note: "logo · footer", host: "a.koglabs.com" }), "logo - footer");
  assert.equal(pinTitle({ note: "  ", host: "a.koglabs.com" }), "a.koglabs.com");
  const h = harness(t);
  await h.start(); h.add(1, undefined, { note: `focus on the "slop" word here. i want this word to change with a pixel effect` }); await h.settle();
  assert.equal(h.delegates[0].body.label, 'Pin #1 · focus on the "slop" word here. i want this word… · Opus 5.5 high');
  assert.match(h.delegates[0].body.label, /^Pins? ((?:#\d+ ?)+) · /, "eta still links the run by its label");
});

// The fast path: the brief, the "before" shot by the harness and the lean start.
const BRIEF = { card: ["Project card: one"], hints: ["Source hints:", "  1. src/a.js:3 (2 needles)"], ship: true, gate: "npm test", stats: { needles: 2, files: 5, learned: 1, ms: 40 } };
const ON = { on: true, delegate: false, agents: 3 };

test("the brief gets the pin, its project and the done pins of its host, before the start; its lines reach the prompt", async (t) => {
  const clock = new FakeClock();
  const initial = [
    makePin(1, clock.now(), { status: "done", summary: "Old" }), makePin(2, clock.now(), { status: "done", host: "two.koglabs.com" }),
    makePin(3, clock.now(), { status: "dismissed" }),
  ];
  const inputs = [];
  const h = harness(t, { clock, initial, brief: async (input) => { inputs.push(structuredClone(input)); return BRIEF; } });
  await h.start(); h.add(5); await h.settle();
  assert.equal(inputs.length, 1);
  assert.deepEqual([inputs[0].pin.id, inputs[0].project], [5, { name: "one", dir: "/tmp/project", candidates: ["one"] }]);
  assert.deepEqual(inputs[0].earlier.map((pin) => pin.id), [1], "done pins of the same host, without the pin itself");
  const read = h.requests.filter((request) => request.path === "/api/pins" && request.query.get("limit") === "200");
  assert.deepEqual(read.map((request) => Object.fromEntries(request.query)), [{ host: "one.koglabs.com", status: "done", limit: "200" }]);
  assert.ok(h.order.indexOf("delegate") > h.order.lastIndexOf("GET /api/pins"));
  const prompt = h.delegates[0].body.prompt;
  assert.ok(prompt.includes("\n\nProject card: one\n\nSource hints:\n  1. src/a.js:3 (2 needles)\n\nHow to work:\n"));
  assert.ok(prompt.includes("PINS_AGENT=claude pins ship 5 --dir /srv/work/<repo>-pin5"));
  assert.deepEqual(h.logs.filter((line) => line.startsWith("brief")), ["brief pin=5 hints=3 learned=1 ms=40"], "numbers only, hints at most 3");
});

test("a brief that throws, fails at once or hangs still starts the run, without a brief", async (t) => {
  for (const brief of [async () => { throw new Error("grep failed in /secret/path"); }, () => { throw new Error("/secret"); }]) {
    const h = harness(t, { brief });
    await h.start(); h.add(1); await h.settle();
    assert.equal(h.delegates.length, 1);
    assert.equal(h.pins.get(1).status, "working");
    assert.deepEqual(h.logs.filter((line) => line.startsWith("brief")), ["brief failed pin=1"]);
    assert.ok(h.logs.every((line) => !line.includes("secret")));
    assert.ok(!h.delegates[0].body.prompt.includes("pins ship") && !h.delegates[0].body.prompt.includes("Project card"));
  }
  let called = false;
  const h = harness(t, { brief: () => { called = true; return new Promise(() => {}); } });
  await h.start(); h.add(1);
  // settle() waits for the decision queue, which waits for the brief: move the clock only.
  for (let i = 0; i < 50 && !called; i++) await h.clock.tick(0);
  assert.ok(called);
  await h.clock.tick(9_999);
  assert.equal(h.delegates.length, 0, "the decision waits for the brief");
  await h.clock.tick(1); await h.settle();
  assert.equal(h.delegates.length, 1, "at most 10 seconds");
  assert.ok(h.logs.includes("brief failed pin=1"));
});

test("the before shot runs after the start call, at most 2 at a time; a failed shot stops nothing; stop does not wait", async (t) => {
  const finish = new Map(), states = [];
  let h, active = 0, most = 0;
  const shoot = (id) => {
    h.order.push(`shoot ${id}`);
    states.push(h.pins.get(id).status);
    most = Math.max(most, ++active);
    return new Promise((resolve, reject) => finish.set(id, (ok) => { active--; if (ok) resolve(); else reject(new Error("chromium /secret")); }));
  };
  h = harness(t, { shoot });
  h.intercept((request) => request.path === "/api/pins/5/start" ? h.response({ error: "taken" }, 409) : undefined);
  await h.start();
  for (let id = 1; id <= 5; id++) h.add(id);
  await h.settle();
  assert.equal(h.delegates.length, 5, "shots never hold a start");
  assert.deepEqual([...finish.keys()], [1, 2]);
  assert.ok(h.order.indexOf("POST /api/pins/1/start") < h.order.indexOf("shoot 1"));
  assert.ok(states.every((status) => status === "working"), "after the claim");
  finish.get(1)(false); await flush();
  assert.deepEqual([...finish.keys()], [1, 2, 3]);
  finish.get(2)(true); finish.get(3)(true); await flush();
  assert.deepEqual([...finish.keys()], [1, 2, 3, 4], "a pin whose claim got 409 gets no shot");
  assert.equal(most, 2);
  assert.deepEqual(h.logs.filter((line) => line.startsWith("before shot")), ["before shot failed pin=1"]);
  assert.ok(h.logs.every((line) => !line.includes("secret")));
  assert.equal(h.pins.get(1).status, "working");
  assert.ok(h.delegates[0].body.prompt.includes('6. Shots: the harness takes the "before" shot when the run starts. Do not take it yourself.'));
  assert.ok(!h.delegates[0].body.prompt.includes("snap 1 before"));
  h.add(6); h.add(7); await h.settle();
  assert.deepEqual([...finish.keys()], [1, 2, 3, 4, 6], "shot 7 waits");
  await h.runner.stop();
  finish.get(4)(true); await flush();
  assert.equal(finish.has(7), false, "stop does not wait for shots 4 and 6 and starts no queued shot");
});

test("a plain pin starts lean with profile pin; a task pin, a named skill and a bulk run get the full start", async (t) => {
  const h = harness(t);
  await h.start();
  h.add(1); h.add(2, undefined, { intent: "task" }); h.add(3, undefined, { note: "use the design kit" }); h.add(4, undefined, { note: "run /hallmark" });
  await h.settle();
  assert.deepEqual(h.delegates.map(({ body }) => body.profile ?? null), ["pin", null, null, null]);
  assert.ok(h.delegates[0].body.prompt.includes("Model: Opus 5.5 high.\nThis session starts lean:"));
  for (const { body } of h.delegates.slice(1)) assert.ok(!body.prompt.includes("starts lean"), body.label);
  const bulk = harness(t, { bulk: ON });
  await bulk.start(); bulk.add(1, undefined, { batch: 7 }); bulk.add(2, undefined, { batch: 7 }); await bulk.settle();
  assert.equal(bulk.delegates.length, 1);
  assert.equal(bulk.delegates[0].body.profile ?? null, null);
  assert.ok(!bulk.delegates[0].body.prompt.includes("starts lean"));
});

test("bulk: one brief per pin, one after the other; hints per pin, the first card; a before shot per started pin", async (t) => {
  const order = [], shots = [];
  let active = 0, most = 0;
  const brief = async ({ pin, earlier }) => {
    most = Math.max(most, ++active);
    await flush();
    active--;
    order.push([pin.id, earlier.length]);
    return { ...BRIEF, card: [`Project card: ${pin.id}`], hints: [`  1. src/${pin.id}.js:1 (1 needle)`] };
  };
  const h = harness(t, { bulk: ON, brief, shoot: async (id) => { shots.push(id); } });
  await h.start(); h.add(1, undefined, { batch: 7 }); h.add(2, undefined, { batch: 7 }); await h.settle();
  assert.deepEqual(order, [[1, 0], [2, 0]]);
  assert.equal(most, 1, "one after the other");
  const prompt = h.delegates[0].body.prompt;
  assert.ok(prompt.includes("</page-data>\n  1. src/1.js:1 (1 needle)\nCommands: PINS_AGENT=claude pins progress 1 \"<step>\" · PINS_AGENT=claude pins snap 1 after\n"));
  assert.ok(prompt.includes("  1. src/2.js:1 (1 needle)\nCommands: "));
  assert.ok(prompt.includes("\n\nProject card: 1\n\nHow to work:\n") && !prompt.includes("Project card: 2"));
  assert.ok(!prompt.includes("pins ship"), "a bulk run ships by hand");
  assert.deepEqual(shots, [1, 2]);
});

test("each PINS_RUNNER_* switch set to 0 turns its part off, also with the function injected; a bad value throws", async (t) => {
  const run = async (env, inject = true) => {
    const shots = [];
    const h = harness(t, { config: readConfig(env), ...(inject ? { brief: async () => BRIEF, shoot: async (id) => { shots.push(id); } } : {}) });
    await h.start(); h.add(1); await h.settle(); await flush();
    const { prompt, profile } = h.delegates[0].body;
    return { card: prompt.includes("Project card: one"), shot: prompt.includes("harness takes"), lean: prompt.includes("starts lean"),
      profile: profile ?? null, shots, briefs: h.logs.filter((line) => line.startsWith("brief")).length };
  };
  const all = { card: true, shot: true, lean: true, profile: "pin", shots: [1], briefs: 1 };
  assert.deepEqual(await run({}), all);
  assert.deepEqual(await run({ PINS_RUNNER_BRIEF: "1", PINS_RUNNER_SHOTS: "1", PINS_RUNNER_LEAN: "1" }), all);
  assert.deepEqual(await run({ PINS_RUNNER_BRIEF: "0" }), { ...all, card: false, briefs: 0 });
  assert.deepEqual(await run({ PINS_RUNNER_SHOTS: "0" }), { ...all, shot: false, shots: [] });
  assert.deepEqual(await run({ PINS_RUNNER_LEAN: "0" }), { ...all, lean: false, profile: null });
  assert.deepEqual(await run({}, false), { ...all, card: false, shot: false, shots: [], briefs: 0 }, "no function: no brief, no shot");
  // The stop switch too: "true" must never pass for "enabled".
  for (const name of ["PINS_RUNNER_DISABLED", "PINS_RUNNER_BRIEF", "PINS_RUNNER_SHOTS", "PINS_RUNNER_LEAN"]) {
    for (const value of ["", "true", "2", "off", " 1", "00"]) assert.throws(() => readConfig({ [name]: value }), new RegExp(`Invalid ${name}`), `${name}=${JSON.stringify(value)}`);
  }
});
