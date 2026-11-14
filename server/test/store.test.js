import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, parseStatuses, ValidationError, ConflictError } from "../src/store.js";
import { createOldDatabase, OLD_SCHEMA } from "./old-schema.js";

const target = { selector: "main > h1", label: 'h1 "Hello"', tag: "H1", text: "Hello", rect: { x: 1.4, y: 2, w: 300, h: 40 }, attrs: { class: "t", onclick: "x" }, styles: { font: "600 32px Inter", "bad key": "x" } };
const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing?x=1#top", title: "Pricing", note: "  Cut the space  ", targets: [target], viewport: { w: 1400, h: 900, dpr: 2 }, author: "sam", ...extra });

test("create, read, list, stats", () => {
  const store = openStore({ file: ":memory:" });
  const seen = [];
  store.on("change", (e) => seen.push(`${e.type}:${e.action ?? ""}`));
  const pin = store.createPin(input());
  assert.equal(pin.id, 1);
  assert.equal(pin.status, "queued");
  assert.equal(pin.run, null);
  assert.equal(pin.url, "https://crete.koglabs.com/pricing?x=1");
  assert.equal(pin.host, "crete.koglabs.com");
  assert.equal(pin.path, "/pricing");
  assert.equal(pin.note, "Cut the space");
  assert.deepEqual(pin.targets[0].rect, { x: 1, y: 2, w: 300, h: 40 });
  assert.equal(pin.targets[0].tag, "h1");
  assert.deepEqual(pin.targets[0].attrs, { class: "t" });
  assert.deepEqual(pin.targets[0].styles, { font: "600 32px Inter" });
  assert.deepEqual(store.getPin(1), pin);
  store.createPin(input({ url: "https://koglabs.com/" }));
  assert.deepEqual(store.listPins().map((p) => p.id), [2, 1]);
  assert.deepEqual(store.listPins({ host: "CRETE.koglabs.com" }).map((p) => p.id), [1]);
  assert.deepEqual(store.listPins({ q: "space" }).map((p) => p.id), [2, 1]);
  assert.deepEqual(store.listPins({ q: "100%" }), []);
  assert.deepEqual(store.listPins({ before: 2 }).map((p) => p.id), [1]);
  assert.equal(store.stats().total.queued, 2);
  assert.deepEqual(seen, ["pin:created", "pin:created"]);
  store.close();
});

test("validation rejects bad input", () => {
  const store = openStore({ file: ":memory:" });
  const bad = [
    [{ url: "http://crete.koglabs.com/" }, /https/],
    [{ url: "https://evil.com/" }, /subdomain/],
    [{ url: "https://koglabs.com.evil.com/" }, /subdomain/],
    [{ url: "not a url" }, /valid URL/],
    [{ note: "   " }, /note is required/],
    [{ note: "x".repeat(4001) }, /longer than 4000/],
    [{ targets: [] }, /1 to 10/],
    [{ targets: [{ label: "x" }] }, /selector is required/],
    [{ targets: [{ selector: "a".repeat(501), label: "x" }] }, /longer than 500/],
    [{ targets: "x" }, /1 to 10/],
  ];
  for (const [extra, re] of bad) assert.throws(() => store.createPin(input(extra)), (e) => e instanceof ValidationError && e.status === 400 && re.test(e.message), JSON.stringify(extra).slice(0, 60));
  assert.throws(() => parseStatuses("queued,nope"), ValidationError);
  assert.deepEqual(parseStatuses(), ["queued", "working", "waiting"]);
  assert.deepEqual(parseStatuses("all"), ["queued", "working", "waiting", "done", "dismissed"]);
  assert.deepEqual(parseStatuses("waiting"), ["waiting"]);
  assert.deepEqual(parseStatuses("done, done"), ["done"]);
  store.close();
});

test("status changes, replies, conflicts", () => {
  const store = openStore({ file: ":memory:" });
  const { id } = store.createPin(input());
  assert.equal(store.transition(id, "start", { agent: "claude" }).status, "working");
  assert.throws(() => store.transition(id, "start"), ConflictError);
  assert.throws(() => store.updateNote(id, "new"), ConflictError);
  assert.throws(() => store.transition(id, "resolve", {}), /summary is required/);
  assert.equal(store.getPin(id).status, "working", "failed resolve rolls back");
  const done = store.transition(id, "resolve", { summary: "Margin 48px to 24px", commit: "a1b2c3d" });
  assert.equal(done.status, "done");
  assert.equal(done.agent, "claude");
  assert.equal(done.commit, "a1b2c3d");
  assert.ok(done.closedAt);
  assert.equal(done.replyCount, 1);
  assert.equal(store.listReplies(id)[0].body, "Done: Margin 48px to 24px (a1b2c3d)");
  const reopened = store.transition(id, "reopen");
  assert.equal(reopened.status, "queued");
  assert.equal(reopened.summary, null);
  assert.equal(reopened.agent, null);
  assert.equal(store.updateNote(id, "Changed").note, "Changed");
  assert.equal(store.addReply(id, { kind: "user", author: "sam", body: "also mobile" }).kind, "user");
  assert.throws(() => store.addReply(id, { kind: "bot", body: "x" }), ValidationError);
  assert.equal(store.transition(id, "dismiss", { reason: "duplicate", kind: "user", author: "sam" }).status, "dismissed");
  assert.equal(store.listReplies(id).at(-1).body, "Dismissed: duplicate");
  assert.equal(store.transition(999, "start"), null);
  assert.equal(store.addReply(999, { kind: "user", body: "x" }), null);
  assert.equal(store.deletePin(id), true);
  assert.equal(store.deletePin(id), false);
  assert.equal(store.getPin(id), null);
  store.close();
});

test("nextCreated waits for a matching pin, times out and aborts", async () => {
  const store = openStore({ file: ":memory:" });
  const wait = store.nextCreated({ host: "crm.koglabs.com", timeoutMs: 2000 });
  store.createPin(input());
  store.createPin(input({ url: "https://crm.koglabs.com/x" }));
  assert.equal((await wait).host, "crm.koglabs.com");
  assert.equal(await store.nextCreated({ timeoutMs: 20 }), null);
  const ac = new AbortController();
  const aborted = store.nextCreated({ signal: ac.signal });
  ac.abort();
  assert.equal(await aborted, null);
  store.close();
});

test("real file round trip keeps Unicode and JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-"));
  try {
    const file = join(dir, "sub", "pins.db");
    let store = openStore({ file });
    const { id } = store.createPin(input({ note: "Καλώς ήρθες 👋 \"quotes\" \\ back", quote: "ξανά" }));
    store.close();
    store = openStore({ file });
    const pin = store.getPin(id);
    assert.equal(pin.note, "Καλώς ήρθες 👋 \"quotes\" \\ back");
    assert.equal(pin.quote, "ξανά");
    assert.equal(pin.targets[0].selector, "main > h1");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask preserves the run and actor, validates the question, and includes waiting in open counts", (t) => {
  const store = openStore({ file: ":memory:" });
  t.after(() => store.close());
  for (const state of ["queued", "working"]) {
    const { id } = store.createPin(input());
    if (state === "working") store.transition(id, "start", { agent: "codex", run: "triad:42" });
    const before = store.getPin(id);
    const seen = [];
    const listener = (event) => seen.push(event);
    store.on("change", listener);
    for (const question of [undefined, null, 1, " ", "x".repeat(4001)]) {
      assert.throws(() => store.transition(id, "ask", { question }), ValidationError);
      assert.deepEqual(store.getPin(id), before);
      assert.deepEqual(store.listReplies(id), []);
    }
    assert.throws(() => store.transition(id, "ask", { question: "Which size?", kind: "bot" }), ValidationError);
    assert.deepEqual(store.getPin(id), before, "invalid reply rolls back the waiting status");
    assert.deepEqual(seen, []);
    const pin = store.transition(id, "ask", { question: "  Which size?  ", kind: "user", author: "sam", agent: "reviewer" });
    assert.equal(pin.status, "waiting");
    assert.equal(pin.agent, before.agent);
    assert.equal(pin.run, before.run);
    assert.equal(pin.startedAt, before.startedAt);
    assert.equal(pin.replyCount, 1);
    const reply = store.listReplies(id)[0];
    assert.equal(reply.body, "Which size?");
    assert.equal(reply.kind, "user");
    assert.equal(reply.author, "sam");
    assert.deepEqual(seen, [{ type: "pin", action: "updated", pin }, { type: "reply", pin, reply }]);
    assert.throws(() => store.transition(id, "ask", { question: "Again?" }), ConflictError);
    assert.throws(() => store.transition(id, "start"), ConflictError);
    store.off("change", listener);
  }
  assert.deepEqual(store.listPins().map(({ status }) => status), ["waiting", "waiting"]);
  assert.deepEqual(store.stats(), {
    total: { queued: 0, working: 0, waiting: 2, done: 0, dismissed: 0 },
    hosts: [{ host: "crete.koglabs.com", queued: 0, working: 0, waiting: 2, done: 0, dismissed: 0 }],
  });
});

test("waiting pins resolve, dismiss or reopen; run clears on every reopen", (t) => {
  const store = openStore({ file: ":memory:" });
  t.after(() => store.close());
  for (const action of ["resolve", "dismiss", "reopen"]) {
    const { id } = store.createPin(input());
    for (const run of [1, {}, " ", "x".repeat(201)]) {
      assert.throws(() => store.transition(id, "start", { run }), ValidationError);
      assert.equal(store.getPin(id).status, "queued");
    }
    assert.equal(store.transition(id, "start", { agent: "codex", run: "  triad:42  " }).run, "triad:42");
    store.transition(id, "ask", { question: "Which size?" });
    const pin = store.transition(id, action, { summary: "Fixed", commit: "abc123", reason: "Duplicate" });
    assert.equal(pin.status, { resolve: "done", dismiss: "dismissed", reopen: "queued" }[action]);
    if (action !== "reopen") {
      assert.equal(pin.run, "triad:42");
      assert.throws(() => store.transition(id, "ask", { question: "Again?" }), ConflictError);
      store.transition(id, "reopen");
    }
    for (const field of ["agent", "summary", "commit", "run", "startedAt", "closedAt"]) assert.equal(store.getPin(id)[field], null, field);
    assert.equal(store.transition(id, "start").run, null);
    store.transition(id, "reopen");
    assert.equal(store.getPin(id).run, null);
  }
  const { id } = store.createPin(input());
  assert.equal(store.transition(id, "start", { run: "x".repeat(200) }).run.length, 200);
  store.transition(id, "reopen");
  assert.equal(store.transition(id, "ask", { question: "x".repeat(4000) }).replyCount, 1);
});

test("only a user reply reopens waiting and emits the committed pin before the reply", (t) => {
  const store = openStore({ file: ":memory:" });
  t.after(() => store.close());
  const { id } = store.createPin(input());
  store.transition(id, "start", { agent: "codex", run: "triad:42" });
  store.transition(id, "ask", { question: "Which size?" });
  const seen = [];
  store.on("change", (event) => seen.push(event));
  const agentReply = store.addReply(id, { kind: "agent", author: "codex", body: "Still checking" });
  const waiting = store.getPin(id);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.run, "triad:42");
  assert.deepEqual(seen, [{ type: "reply", pin: waiting, reply: agentReply }]);
  seen.length = 0;
  assert.throws(() => store.addReply(id, { kind: "user", body: " " }), ValidationError);
  assert.deepEqual(store.getPin(id), waiting);
  assert.deepEqual(seen, []);
  const reply = store.addReply(id, { kind: "user", author: "sam", body: "24 pixels" });
  const pin = store.getPin(id);
  assert.equal(pin.status, "queued");
  assert.equal(pin.replyCount, 3);
  for (const field of ["agent", "summary", "commit", "run", "startedAt", "closedAt"]) assert.equal(pin[field], null, field);
  assert.deepEqual(seen, [{ type: "pin", action: "updated", pin }, { type: "reply", pin, reply }]);
  for (const action of ["start", "resolve", "dismiss"]) {
    if (action === "dismiss") store.transition(id, "reopen");
    const before = store.transition(id, action, { summary: "Fixed" });
    store.addReply(id, { kind: "user", body: "More context" });
    assert.equal(store.getPin(id).status, before.status, "user replies only reopen waiting pins");
  }
});

test("user reply and reopen roll back together on a real database write failure", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-reply-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  const store = openStore({ file });
  t.after(() => store.close());
  const { id } = store.createPin(input());
  store.transition(id, "start", { agent: "codex", run: "triad:42" });
  store.transition(id, "ask", { question: "Which size?" });
  const before = store.getPin(id);
  const replies = store.listReplies(id);
  const observer = new DatabaseSync(file);
  t.after(() => observer.close());
  observer.exec(`CREATE TRIGGER reject_reopen BEFORE UPDATE OF status ON pins
    WHEN NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'reopen blocked'); END;`);
  const seen = [];
  store.on("change", (event) => {
    seen.push(event);
    assert.equal(observer.prepare("SELECT status FROM pins WHERE id = ?").get(id).status, "queued");
    assert.equal(observer.prepare("SELECT COUNT(*) AS n FROM replies WHERE pin_id = ?").get(id).n, 2);
  });
  assert.throws(() => store.addReply(id, { kind: "user", body: "24 pixels" }), /reopen blocked/);
  assert.deepEqual(store.getPin(id), before);
  assert.deepEqual(store.listReplies(id), replies);
  assert.deepEqual(seen, []);
  observer.exec("DROP TRIGGER reject_reopen;");
  store.addReply(id, { kind: "user", body: "24 pixels" });
  assert.deepEqual(seen.map(({ type }) => type), ["pin", "reply"]);
});

for (const existingRun of [false, true]) {
  test(`old file migration preserves all rows, replies, IDs and sequences (run column: ${existingRun})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pins-migrate-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "pins.db");
    const old = createOldDatabase(file);
    if (existingRun) old.exec("ALTER TABLE pins ADD COLUMN run TEXT; UPDATE pins SET run = 'triad:old' WHERE id = 13;");
    const rows = old.prepare("SELECT * FROM pins ORDER BY id").all().map((row) => ({ ...row, run: row.run ?? null, batch: null, model: null, attempts: 0, intent: null, scope: null, presets: null, shot_before: null, shot_after: null, accepted_at: null, reopens: null, versions: null, revert: null, reverted_at: null }));
    const replies = old.prepare("SELECT * FROM replies ORDER BY id").all();
    const sequences = old.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all();
    assert.doesNotMatch(old.prepare("SELECT sql FROM sqlite_schema WHERE name = 'pins'").get().sql, /'waiting'/);
    old.close();
    let store = openStore({ file });
    t.after(() => store.close());
    const inspect = new DatabaseSync(file);
    t.after(() => inspect.close());
    assert.deepEqual(inspect.prepare("SELECT * FROM pins ORDER BY id").all().map((row) => ({ ...row })), rows);
    assert.deepEqual(inspect.prepare("SELECT * FROM replies ORDER BY id").all(), replies);
    assert.deepEqual(inspect.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(), sequences);
    assert.deepEqual(inspect.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'pins' ORDER BY name").all().map(({ name }) => name), ["pins_batch", "pins_host_status", "pins_status"]);
    assert.equal(store.transition(13, "ask", { question: "Which size?" }).status, "waiting");
    assert.equal(store.listReplies(13).at(-1).id, 91);
    assert.equal(store.getPin(13).run, existingRun ? "triad:old" : null);
    assert.equal(store.createPin(input()).id, 81);
    assert.equal(store.deletePin(12), true);
    assert.deepEqual(store.listReplies(12), [], "foreign key cascades remain enabled after migration");
    store.close();
    store = openStore({ file });
    assert.equal(store.getPin(13).status, "waiting");
    assert.equal(store.createPin(input()).id, 82);
  });
}

test("migration preserves the pin sequence when every old pin was deleted", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  const old = createOldDatabase(file);
  old.exec("DELETE FROM pins;");
  old.close();
  const store = openStore({ file });
  t.after(() => store.close());
  const pin = store.createPin(input());
  assert.equal(pin.id, 81);
  assert.equal(store.addReply(pin.id, { kind: "user", body: "New reply" }).id, 91);
});

test("waiting schema without run gets ALTER TABLE without rebuilding pins", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-column-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(OLD_SCHEMA.replace("'working','done'", "'working','waiting','done'"));
  const rootpage = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'pins'").get().rootpage;
  const store = openStore({ file });
  t.after(() => store.close());
  assert.equal(db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'pins'").get().rootpage, rootpage);
  const { id } = store.createPin(input());
  assert.equal(store.transition(id, "start", { run: "triad:42" }).run, "triad:42");
  assert.equal(store.transition(id, "ask", { question: "Which size?" }).status, "waiting");
});

test("failed migration rolls back the column and schema changes with all data intact", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  const old = createOldDatabase(file);
  t.after(() => old.close());
  // An invalid legacy reference makes the final foreign-key check fail after the rebuild.
  old.exec("PRAGMA foreign_keys = OFF; UPDATE replies SET pin_id = 999 WHERE id = 21;");
  const schema = old.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
  const pins = old.prepare("SELECT * FROM pins ORDER BY id").all();
  const replies = old.prepare("SELECT * FROM replies ORDER BY id").all();
  const sequences = old.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all();
  assert.throws(() => openStore({ file }), /invalid foreign keys/);
  assert.deepEqual(old.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(), schema);
  assert.deepEqual(old.prepare("SELECT * FROM pins ORDER BY id").all(), pins);
  assert.deepEqual(old.prepare("SELECT * FROM replies ORDER BY id").all(), replies);
  assert.deepEqual(old.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(), sequences);
});

test("settings default to enabled, reject invalid writes, emit changes and persist JSON", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  let store = openStore({ file });
  t.after(() => store.close());
  assert.deepEqual(store.getSettings(), { autofix: true, bulk: { on: false, delegate: false, agents: 3 } });
  const seen = [];
  store.on("change", (event) => seen.push(event));
  for (const value of [undefined, null, false, [], {}, { autofix: 0 }, { autofix: "false" }, { autofix: null }, { autofix: true, extra: 1 }]) {
    assert.throws(() => store.setSettings(value), ValidationError);
  }
  assert.deepEqual(seen, []);
  assert.deepEqual(store.setSettings({ autofix: false }), { autofix: false, bulk: { on: false, delegate: false, agents: 3 } });
  assert.deepEqual(seen, [{ type: "settings", settings: { autofix: false, bulk: { on: false, delegate: false, agents: 3 } } }]);
  store.close();
  store = openStore({ file });
  assert.deepEqual(store.getSettings(), { autofix: false, bulk: { on: false, delegate: false, agents: 3 } });
  assert.deepEqual(store.setSettings({ autofix: true }), { autofix: true, bulk: { on: false, delegate: false, agents: 3 } });
  const db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'autofix'").get().value, "true");
  db.close();
});
