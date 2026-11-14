// v3.5: the live fix commits of a pin (versions), Go back (revert) and the revert run's resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { openStore, ConflictError, ForbiddenError, ValidationError } from "../src/store.js";
import { formatDetail, formatList } from "../src/format.js";
import { judge, verdictIntent } from "../src/facts.js";

const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", note: "Cut the space", targets: [{ selector: "main > h1", label: "h1" }], ...extra });
const USER = { kind: "user", author: "sam" };
const AGENT = { kind: "agent", agent: "claude", author: "claude" };
const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const B = "b2c3d4e";
const R = "f00dfacecafe";

// A pin with two live fixes: A, then "Not right", then B.
function twoFixes(store = openStore({ file: ":memory:" })) {
  const { id } = store.createPin(input());
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Margin 48px to 24px", commit: A });
  store.addReply(id, { ...USER, body: "Smaller", reopen: true });
  store.transition(id, "start", AGENT);
  store.transition(id, "resolve", { ...AGENT, summary: "Margin 24px to 16px", commit: B });
  return { store, id };
}

test("resolve adds a hex commit to versions once; no commit, a non-hex commit or a repeat adds none; the list keeps the newest 30", () => {
  const { store, id } = twoFixes();
  const pin = store.getPin(id);
  assert.deepEqual(pin.versions.map((v) => [v.commit, v.summary]), [[A, "Margin 48px to 24px"], [B, "Margin 24px to 16px"]]);
  assert.match(pin.versions[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(pin.commit, B);
  assert.deepEqual([pin.revert, pin.revertedAt], [null, null]);
  for (const commit of [undefined, "n/a", "jstadev/x#12", "abc12", B]) {
    store.transition(id, "reopen", AGENT);
    store.transition(id, "start", AGENT);
    store.transition(id, "resolve", { ...AGENT, summary: "Again", commit });
  }
  assert.equal(store.getPin(id).versions.length, 2, "no new version");
  const { id: many } = store.createPin(input());
  for (let i = 0; i < 32; i++) {
    store.transition(many, "start", AGENT);
    store.transition(many, "resolve", { ...AGENT, summary: `Fix ${i}`, commit: i.toString(16).padStart(7, "0") });
    store.transition(many, "reopen", USER);
  }
  const kept = store.getPin(many).versions;
  assert.equal(kept.length, 30);
  assert.equal(kept[0].summary, "Fix 2");
  assert.equal(kept.at(-1).summary, "Fix 31");
  const { id: long } = store.createPin(input());
  store.transition(long, "resolve", { ...AGENT, summary: "x".repeat(4000), commit: A });
  assert.equal(store.getPin(long).versions[0].summary.length, 300, "the summary of a version is clipped");
  const closing = store.listReplies(long).at(-1).body;
  assert.ok(closing.length === 4000 && closing.startsWith("Done: xxx") && closing.endsWith(` (${A})`), "a 4000-character summary fits: its text is cut, the commit stays");
  store.transition(long, "reopen", USER);
  assert.equal(store.transition(long, "dismiss", { ...USER, reason: "y".repeat(4000) }).status, "dismissed");
  assert.equal(store.listReplies(long).at(-1).body.length, 4000);
  store.close();
});

test("revert: users only (guard before the lookup), closed pins only, a commit of a live version only", () => {
  const { store, id } = twoFixes();
  const seen = [];
  store.on("change", (event) => seen.push(event));
  assert.throws(() => store.transition(id, "revert", { ...AGENT, commit: A }), ForbiddenError);
  assert.throws(() => store.transition(id, "revert", { commit: A }), (error) => error instanceof ForbiddenError && error.status === 403, "no kind means no user");
  assert.throws(() => store.transition(999, "revert", { ...AGENT, commit: A }), ForbiddenError);
  assert.equal(store.transition(999, "revert", { ...USER, commit: A }), null);
  assert.throws(() => store.transition(id, "revert", USER), (error) => error instanceof ValidationError && /commit is required/.test(error.message));
  assert.throws(() => store.transition(id, "revert", { ...USER, commit: 42 }), ValidationError);
  assert.throws(() => store.transition(id, "revert", { ...USER, commit: "c0ffee1" }), (error) => error instanceof ConflictError && /no live fix c0ffee1/.test(error.message));
  assert.throws(() => store.transition(id, "revert", { ...USER, commit: A.slice(0, 7) }), ConflictError, "the exact commit, not a prefix");
  assert.deepEqual(seen, [], "a refused revert sends nothing");
  assert.equal(store.getPin(id).status, "done");

  const { id: none } = store.createPin(input());
  store.transition(none, "resolve", { ...AGENT, summary: "Asked for no code" });
  assert.throws(() => store.transition(none, "revert", { ...USER, commit: A }), (error) => error instanceof ConflictError && /no version to go back to/.test(error.message));
  for (const status of ["queued", "working", "waiting"]) {
    const { id: open } = twoFixes(store);
    store.transition(open, "reopen", USER);
    if (status !== "queued") store.transition(open, "start", AGENT);
    if (status === "waiting") store.transition(open, "ask", { ...AGENT, question: "Which?" });
    assert.equal(store.getPin(open).status, status);
    assert.throws(() => store.transition(open, "revert", { ...USER, commit: A }), (error) => error.status === 409 && error.message.endsWith(`is ${status}`));
  }
  store.close();
});

test("revert to the version before the pin: queued with every fix newest first, cleared like a reopen, one user reply, one update", () => {
  const { store, id } = twoFixes();
  store.transition(id, "accept", USER);
  const before = store.getPin(id);
  const seen = [];
  store.on("change", (event) => seen.push(event));
  const pin = store.transition(id, "revert", { ...USER, commit: A });
  assert.equal(pin.status, "queued");
  assert.deepEqual(pin.revert, { commits: [B, A], at: pin.revert.at, attempts: 2 });
  assert.match(pin.revert.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual([pin.agent, pin.summary, pin.commit, pin.run, pin.startedAt, pin.closedAt, pin.acceptedAt, pin.revertedAt], [null, null, null, null, null, null, null, null]);
  assert.equal(pin.reopens, before.reopens + 1, "he sent it back");
  assert.deepEqual(pin.versions, before.versions, "the versions stay until the revert run closes the pin");
  assert.deepEqual([pin.model, pin.attempts], [before.model, before.attempts]);
  assert.deepEqual(seen.map((event) => event.type), ["pin", "reply"]);
  assert.deepEqual(store.listReplies(id).at(-1), { ...store.listReplies(id).at(-1), kind: "user", author: "sam", body: `Go back to the version before this pin: undo ${B}, ${A.slice(0, 7)}.` });
  store.close();
});

test("revert to an earlier fix undoes only the later fixes; it works from dismissed too", () => {
  const { store, id } = twoFixes();
  store.transition(id, "reopen", USER);
  store.transition(id, "dismiss", { ...USER, reason: "Leave it" });
  const pin = store.transition(id, "revert", { ...USER, commit: B });
  assert.deepEqual(pin.revert.commits, [B]);
  assert.equal(store.listReplies(id).at(-1).body, `Go back to fix 1 (${A.slice(0, 7)}): undo ${B}.`);
  store.close();
});

test("the revert survives start, ask, a user answer and the runner's reopen; its resolve trims versions and sets revertedAt", () => {
  const { store, id } = twoFixes();
  store.transition(id, "revert", { ...USER, commit: A });
  const commits = [B, A];
  assert.deepEqual(store.transition(id, "start", { ...AGENT, run: "triad:9" }).revert.commits, commits);
  assert.deepEqual(store.transition(id, "ask", { ...AGENT, question: "The commit is in which repo?" }).revert.commits, commits);
  store.addReply(id, { ...USER, body: "dropship" });
  assert.equal(store.getPin(id).status, "queued");
  assert.deepEqual(store.getPin(id).revert.commits, commits, "his answer keeps the go back");
  store.transition(id, "start", AGENT);
  assert.deepEqual(store.transition(id, "reopen", AGENT).revert.commits, commits, "the retry is a revert run again");
  store.transition(id, "start", AGENT);

  const seen = [];
  store.on("change", (event) => seen.push(event));
  const done = store.transition(id, "resolve", { ...AGENT, summary: "The title has its old margin again", commit: R });
  assert.equal(done.status, "done");
  assert.deepEqual([done.versions, done.revert, done.commit], [[], null, R]);
  assert.match(done.revertedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(store.listReplies(id).at(-1).body, `Reverted: The title has its old margin again (${R})`);
  assert.deepEqual(seen.map((event) => event.type), ["pin", "reply"]);
  assert.throws(() => store.transition(id, "revert", { ...USER, commit: A }), /no version to go back to/);

  // "Not right" on the reverted pin starts a normal fix run: revertedAt goes, the next commit is a version.
  store.addReply(id, { ...USER, body: "Try once more", reopen: true });
  assert.deepEqual([store.getPin(id).revertedAt, store.getPin(id).revert], [null, null]);
  store.transition(id, "start", AGENT);
  assert.deepEqual(store.transition(id, "resolve", { ...AGENT, summary: "New fix", commit: "c0ffee1" }).versions.map((v) => v.commit), ["c0ffee1"]);
  store.close();
});

test("a revert to fix 1 keeps fix 1; a revert run closed without a commit still trims; dismiss cancels the go back", () => {
  const { store, id } = twoFixes();
  store.transition(id, "revert", { ...USER, commit: B });
  store.transition(id, "start", AGENT);
  const done = store.transition(id, "resolve", { ...AGENT, summary: "Fix 1 is live again" });
  assert.deepEqual([done.versions.map((v) => v.commit), done.commit, done.revert], [[A], null, null]);
  assert.equal(store.listReplies(id).at(-1).body, "Reverted: Fix 1 is live again");

  store.transition(id, "revert", { ...USER, commit: A });
  store.transition(id, "start", AGENT);
  const cancelled = store.transition(id, "dismiss", { ...USER, reason: "Keep it" });
  assert.deepEqual([cancelled.status, cancelled.revert, cancelled.versions.map((v) => v.commit)], ["dismissed", null, [A]]);
  store.close();
});

test("the first open of a v3.4 file reads the versions from the Done replies, oldest first", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-v34-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  let store = openStore({ file });
  const { id } = twoFixes(store);
  store.addReply(id, { ...USER, body: "Done: not his words (abc1234) though", reopen: false });
  const { id: plain } = store.createPin(input());
  store.transition(plain, "resolve", { ...AGENT, summary: "No code (mobile)" });
  store.transition(plain, "reopen", USER);
  store.transition(plain, "resolve", { ...AGENT, summary: "Fixed (header)", commit: "jstadev/x#3" });
  const { id: fresh } = store.createPin(input());
  store.close();
  const old = new DatabaseSync(file);
  old.exec("ALTER TABLE pins DROP COLUMN versions; ALTER TABLE pins DROP COLUMN revert; ALTER TABLE pins DROP COLUMN reverted_at;");
  old.close();
  store = openStore({ file });
  t.after(() => store.close());
  assert.deepEqual(store.getPin(id).versions.map((v) => [v.commit, v.summary]), [[A, "Margin 48px to 24px"], [B, "Margin 24px to 16px"]]);
  assert.deepEqual(store.getPin(plain).versions, []);
  assert.deepEqual([store.getPin(fresh).versions, store.getPin(fresh).revert, store.getPin(fresh).revertedAt], [[], null, null]);
  assert.equal(store.transition(id, "revert", { ...USER, commit: A }).revert.commits.length, 2);
});

test("HTTP: POST /api/pins/:id/revert is 403 for an agent, 400 without a commit, 409 for an unknown commit, 200 for him", async (t) => {
  const store = openStore({ file: ":memory:" });
  const app = createApp({ store, version: "test" });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const { id } = twoFixes(store);
  assert.equal((await call(`/api/pins/${id}/revert`, { commit: A }, { "X-Pins-Agent": "claude" })).status, 403);
  assert.equal((await call(`/api/pins/${id}/revert`, {})).status, 400);
  assert.equal((await call(`/api/pins/${id}/revert`, { commit: "c0ffee1" })).status, 409);
  assert.equal((await call("/api/pins/999/revert", { commit: A })).status, 404);
  const ok = await call(`/api/pins/${id}/revert`, { commit: A }, { "X-SSO-User": "sam" });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.pin.status, ok.data.pin.revert.commits], ["queued", [B, A]]);
  assert.equal(store.listReplies(id).at(-1).author, "sam");
  assert.equal((await call(`/api/pins/${id}/revert`, { commit: A })).status, 409, "already queued");
});

test("the list and detail formats show versions, the go back and the revert time", () => {
  const { store, id } = twoFixes();
  assert.match(formatDetail(store.getPin(id)), new RegExp(`\\nversions: ${A.slice(0, 7)} Margin 48px to 24px · ${B} Margin 24px to 16px\\n`));
  const pin = store.transition(id, "revert", { ...USER, commit: A });
  assert.match(formatDetail(pin), new RegExp(`\\ngo back: undo ${B}, ${A.slice(0, 7)}\\n`));
  assert.match(formatList([pin]), / · go back · /);
  store.transition(id, "start", AGENT);
  const done = store.transition(id, "resolve", { ...AGENT, summary: "Old margin", commit: R });
  assert.match(formatDetail(done), /\nreverted: \d\d:\d\d\n/);
  assert.doesNotMatch(formatDetail(done), /versions:|go back:/);
  assert.doesNotMatch(formatList([done]), /go back/);
  store.close();
});

test("verdictIntent and the revert verdict", () => {
  const facts = (extra = {}) => ({ found: true, text: "Title", rect: { x: 0, y: 0, w: 100, h: 20 }, styles: { color: "red", margin: "48px" }, ...extra });
  assert.equal(verdictIntent({ intent: "remove" }), "remove");
  assert.equal(verdictIntent({ intent: "remove", revert: { commits: [A] } }), "revert");
  assert.equal(verdictIntent({ intent: null, revertedAt: "2026-11-14T10:00:00.000Z" }), "revert");
  assert.equal(verdictIntent({}), null);
  assert.deepEqual(judge("revert", { found: false }, facts()), { ok: true, text: "check: the element is back" });
  assert.equal(judge("revert", { found: false }, { found: false }).ok, null);
  assert.deepEqual(judge("revert", facts(), { found: false }), { ok: true, text: "check: the element is gone" });
  assert.deepEqual(judge("revert", facts(), facts()), { ok: false, text: "check: the element did not change back" });
  assert.deepEqual(judge("revert", facts(), facts({ styles: { color: "red", margin: "24px" } })), { ok: true, text: "check: changed style (margin)" });
  assert.equal(judge("revert", facts(), facts({ rect: { x: 0, y: 50, w: 100, h: 20 } })).ok, null);
  assert.equal(judge("revert", null, facts()).ok, null);
  assert.equal(judge("revert", facts(), null).ok, null);
  assert.equal(judge("remove", facts(), facts()).ok, false, "the other intents keep their rule");
});
