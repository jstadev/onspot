import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTriad } from "../src/triad.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("delegate sends only the exact contract body with the token; task normalizes the result", async () => {
  const calls = [];
  const triad = createTriad({ url: "http://127.0.0.1:12345/", readToken: async () => " test-token\n",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith("/delegate") ? json({ id: 42 }) : json({ status: "done", exitCode: 0, lastLine: "Result", unused: 1 });
    } });
  for (const bad of [{ model: "other" }, { model: "claude-opus-4-8" }, { model: "fable" }, { model: "opus" },
    { model: "claude-opus-5-5", effort: "ultra" }, { model: "claude-opus-5-5", effort: "" }, { effort: "XHIGH" }]) {
    await assert.rejects(triad.delegate({ cwd: "/tmp", label: "l", prompt: "p", ...bad }), /Unsupported fix model/);
  }
  assert.equal(calls.length, 0, "a refused model or effort sends nothing");
  assert.equal(await triad.delegate({ cwd: "/tmp/project", label: "Pin #12 · site.koglabs.com · Opus 5.5 max", prompt: "Prompt", agent: "other", model: "claude-opus-5-5", effort: "max", extra: true }), "42");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    agent: "claude", model: "claude-opus-5-5", effort: "max", cwd: "/tmp/project", label: "Pin #12 · site.koglabs.com · Opus 5.5 max",
    reason: "OnSpot auto-fix", prompt: "Prompt",
  });
  assert.equal(calls[0].url, "http://127.0.0.1:12345/delegate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-triad-key"], "test-token");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(await triad.task("42"), { status: "done", exitCode: 0, lastLine: "Result", continuedAs: null });
  assert.equal(calls[1].url, "http://127.0.0.1:12345/api/task/42");
  assert.equal(calls[1].options.method, "GET");
});

test("profile pin goes into the body; no profile leaves the body as today; any other profile throws and sends nothing", async () => {
  const bodies = [];
  const triad = createTriad({ url: "http://127.0.0.1:12345", readToken: async () => "test",
    fetch: async (_, options) => { bodies.push(JSON.parse(options.body)); return json({ id: 7 }); } });
  const base = { cwd: "/tmp", label: "l", prompt: "p" };
  for (const bad of ["full", "", "PIN", 0, false, {}, ["pin"]]) {
    await assert.rejects(triad.delegate({ ...base, profile: bad }), /Unsupported profile/, JSON.stringify(bad));
  }
  assert.equal(bodies.length, 0);
  await triad.delegate({ ...base, profile: "pin" });
  await triad.delegate({ ...base, profile: null });
  await triad.delegate({ ...base, profile: undefined });
  await triad.delegate(base);
  const today = { agent: "claude", model: "claude-opus-5-5", effort: "high", cwd: "/tmp", label: "l", reason: "OnSpot auto-fix", prompt: "p" };
  assert.deepEqual(bodies, [{ ...today, profile: "pin" }, today, today, today]);
});

test("both models and all five efforts reach Triad; the default is Opus at high", async () => {
  const bodies = [];
  const triad = createTriad({ url: "http://127.0.0.1:12345", readToken: async () => "test",
    fetch: async (_, options) => { bodies.push(JSON.parse(options.body)); return json({ id: 7 }); } });
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) await triad.delegate({ cwd: "/tmp", label: "l", prompt: "p", model, effort });
  }
  assert.equal(bodies.length, 10);
  await triad.delegate({ cwd: "/tmp", label: "l", prompt: "p" });
  assert.deepEqual([bodies[10].model, bodies[10].effort], ["claude-opus-5-5", "high"]);
});

test("the Claude account comes from PINS_CLAUDE_ACCOUNT; any other value throws at start", async (t) => {
  const saved = process.env.PINS_CLAUDE_ACCOUNT;
  t.after(() => { if (saved === undefined) delete process.env.PINS_CLAUDE_ACCOUNT; else process.env.PINS_CLAUDE_ACCOUNT = saved; });
  const agentOf = async (options = {}) => {
    let body;
    const triad = createTriad({ url: "http://127.0.0.1:12345", readToken: async () => "test",
      fetch: async (_, request) => { body = JSON.parse(request.body); return json({ id: 7 }); }, ...options });
    await triad.delegate({ cwd: "/tmp", label: "l", prompt: "p" });
    return body.agent;
  };
  delete process.env.PINS_CLAUDE_ACCOUNT;
  assert.equal(await agentOf(), "claude");
  process.env.PINS_CLAUDE_ACCOUNT = "claude-2";
  assert.equal(await agentOf(), "claude-2");
  assert.equal(await agentOf({ account: "claude" }), "claude");
  for (const bad of ["", "codex", "grok", "claude-3", "Claude", " claude"]) {
    process.env.PINS_CLAUDE_ACCOUNT = bad;
    assert.throws(() => createTriad({ url: "http://127.0.0.1:12345" }), /PINS_CLAUDE_ACCOUNT/, JSON.stringify(bad));
  }
});

for (const status of [401, 403]) {
  test(`HTTP ${status} re-reads the token file once and authenticates the retry`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pins-token-")), tokenFile = join(root, "token");
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(tokenFile, "old-token\n");
    const tokens = [];
    const triad = createTriad({ tokenFile, url: "http://127.0.0.1:12345", fetch: async (_, options) => {
      tokens.push(options.headers["x-triad-key"]);
      if (tokens.length === 1) { await writeFile(tokenFile, "new-token\n"); return json({}, status); }
      return json({ status: "failed", exitCode: 1, result: "first line\nlast line\n" });
    } });
    assert.deepEqual(await triad.task(42), { status: "failed", exitCode: 1, lastLine: "last line", continuedAs: null });
    assert.deepEqual(tokens, ["old-token", "new-token"]);
  });
}

test("repeated authentication rejection stops after one retry without exposing the response", async () => {
  let reads = 0, calls = 0;
  const triad = createTriad({ url: "http://localhost:12345", readToken: async () => { reads++; return "secret"; },
    fetch: async () => { calls++; return json({ error: "private contents" }, 403); } });
  await assert.rejects(triad.task(1), { message: "Triad HTTP 403", status: 403 });
  assert.equal(reads, 2); assert.equal(calls, 2);
});

test("bad input, non-loopback URLs, redirects, and malformed task results fail closed", async () => {
  assert.throws(() => createTriad({ url: "https://external.example" }), /loopback/);
  assert.throws(() => createTriad({ url: "http://user:pass@127.0.0.1" }), /loopback/);
  let calls = 0;
  const triad = createTriad({ url: "http://127.0.0.1:12345", readToken: async () => "test", fetch: async () => { calls++; return json({}); } });
  await assert.rejects(triad.task("../../secret"), /Invalid Triad/); assert.equal(calls, 0);
  await assert.rejects(triad.task(1), /no task status/);
  await assert.rejects(triad.delegate({ cwd: "/tmp", label: "label", prompt: "prompt" }), /no task id/);
  const redirect = createTriad({ url: "http://127.0.0.1:12345", readToken: async () => "test", fetch: async () => json({}, 302) });
  await assert.rejects(redirect.task(1), { status: 302 });
});

test("task names the task that continues a session after a plan limit; only a higher task id counts", async () => {
  let answer;
  const triad = createTriad({ url: "http://127.0.0.1:12345", readToken: async () => "test", fetch: async () => json(answer) });
  const ended = { status: "failed", exitCode: 1, result: "Plan limit.\nContinued on Claude 2 as task 57." };
  answer = { ...ended, continuedAs: 57 };
  assert.deepEqual(await triad.task(42), { status: "failed", exitCode: 1, lastLine: "Continued on Claude 2 as task 57.", continuedAs: "57" });
  for (const bad of [null, undefined, 0, 42, 41, -1, "57x", "../1", 5.5, {}, [57, 58]]) {
    answer = { ...ended, continuedAs: bad };
    assert.equal((await triad.task(42)).continuedAs, null, JSON.stringify(bad));
  }
});
