import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, STATUSES, ValidationError, ConflictError } from "../src/store.js";
import { SHOT_MAX, shotType } from "../src/shots.js";
import { createV2Database } from "./old-schema.js";

// Every byte value follows the magic bytes, so a text decode anywhere would corrupt the image.
const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), all]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), all]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 1, 0, 0]), Buffer.from("WEBP"), all]);
const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", note: "Cut the space", targets: [{ selector: "main > h1", label: "h1" }], ...extra });
const count = (store) => store.listPins({ statuses: STATUSES }).length;

function fileStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "pins-v3-"));
  const store = openStore({ file: join(dir, "pins.db") });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, shots: join(dir, "shots") };
}

test("intent, scope and presets: valid values round-trip; anything else is 400 in createPin and createBatch", () => {
  const store = openStore({ file: ":memory:" });
  const plain = store.createPin(input());
  assert.deepEqual([plain.intent, plain.scope, plain.presets, plain.progress, plain.shots], [null, null, [], null, { before: null, after: null }]);
  for (const intent of ["text", "style", "layout", "behaviour", "remove", "task", null]) assert.equal(store.createPin(input({ intent })).intent, intent);
  for (const scope of ["element", "similar", "page", "site", null]) assert.equal(store.createPin(input({ scope })).scope, scope);
  const presets = Array.from({ length: 6 }, (_, i) => ({ label: `  Preset ${i} `, text: ` Do ${i} ` }));
  const pin = store.createPin(input({ intent: "task", scope: "site", presets }));
  assert.deepEqual(pin.presets, presets.map((_, i) => ({ label: `Preset ${i}`, text: `Do ${i}` })));
  assert.deepEqual([pin.intent, pin.scope], ["task", "site"]);
  assert.deepEqual(store.getPin(pin.id), pin);
  assert.deepEqual(store.listPins({ limit: 1 }), [pin]);
  assert.equal(store.createPin(input({ presets: [{ label: "x".repeat(40), text: "y".repeat(500) }] })).presets[0].text.length, 500);
  const before = count(store);
  const bad = [
    [{ intent: "colour" }, /intent must be one of text, style/], [{ intent: "" }, /intent/], [{ intent: 1 }, /intent/], [{ intent: ["text"] }, /intent/],
    [{ scope: "app" }, /scope must be one of element, similar/], [{ scope: "" }, /scope/], [{ scope: true }, /scope/],
    [{ presets: Array.from({ length: 7 }, () => ({ label: "a", text: "b" })) }, /0 to 6/],
    [{ presets: {} }, /0 to 6/], [{ presets: "x" }, /0 to 6/],
    [{ presets: [{ label: "a", text: "b", id: 1 }] }, /only a label and a text/],
    [{ presets: ["a"] }, /only a label and a text/], [{ presets: [null] }, /only a label and a text/], [{ presets: [[]] }, /only a label and a text/],
    [{ presets: [{ label: "x".repeat(41), text: "b" }] }, /preset label is longer than 40/],
    [{ presets: [{ label: "a", text: "y".repeat(501) }] }, /preset text is longer than 500/],
    [{ presets: [{ label: " ", text: "b" }] }, /preset label is required/],
    [{ presets: [{ label: "a" }] }, /preset text is required/],
    [{ presets: [{ label: "a", text: 5 }] }, /preset text is required/],
  ];
  for (const [extra, re] of bad) {
    const label = JSON.stringify(extra).slice(0, 80);
    assert.throws(() => store.createPin(input(extra)), (e) => e instanceof ValidationError && e.status === 400 && re.test(e.message), label);
    assert.throws(() => store.createBatch({ pins: [input(), input(extra)] }), (e) => e instanceof ValidationError && /^pin 2: /.test(e.message) && re.test(e.message), label);
  }
  assert.equal(count(store), before, "a refused pin or batch writes nothing");
  const batch = store.createBatch({ pins: [input({ intent: "remove", scope: "similar", presets: [{ label: "A", text: "B" }] }), input()] });
  assert.deepEqual(batch.pins.map((p) => [p.intent, p.scope, p.presets]), [["remove", "similar", [{ label: "A", text: "B" }]], [null, null, []]]);
  const { attrs } = store.createPin(input({ targets: [{ selector: "a", label: "a", attrs: { "data-slot": "button", "data-component": "Hero", "data-other": "x" } }] })).targets[0];
  assert.deepEqual(attrs, { "data-slot": "button", "data-component": "Hero" });
  store.close();
});

test("steps: only a working pin takes them, body 1 to 200, 40 per run; start deletes the steps of the earlier run", () => {
  const store = openStore({ file: ":memory:" });
  const { id } = store.createPin(input());
  assert.equal(store.addStep(999, { body: "x" }), null);
  assert.throws(() => store.addStep(id, { author: "claude", body: "Too early" }), (e) => e instanceof ConflictError && e.status === 409 && e.message === `pin #${id} is queued`);
  store.transition(id, "start", { agent: "claude", run: "triad:1" });
  for (const body of [undefined, null, 5, " ", "x".repeat(201)]) assert.throws(() => store.addStep(id, { author: "claude", body }), ValidationError);
  assert.throws(() => store.addStep(id, { author: "x".repeat(61), body: "ok" }), ValidationError);
  assert.deepEqual(store.listSteps(id), []);
  assert.equal(store.getPin(id).progress, null);
  const seen = [];
  const listener = (event) => seen.push(event);
  store.on("change", listener);
  const first = store.addStep(id, { author: "claude", body: "  Found the code  " });
  assert.deepEqual(first.step, { id: 1, pinId: id, author: "claude", body: "Found the code", createdAt: first.step.createdAt });
  assert.deepEqual(first.pin.progress, { text: "Found the code", at: first.step.createdAt, count: 1 });
  assert.equal(first.pin.updatedAt, first.step.createdAt);
  assert.deepEqual(seen, [{ type: "pin", action: "updated", pin: first.pin }]);
  store.off("change", listener);
  assert.equal(store.addStep(id, { body: "x".repeat(200) }).step.author, null);
  for (let i = 2; i < 40; i++) store.addStep(id, { author: "claude", body: `Step ${i + 1}` });
  assert.deepEqual([store.getPin(id).progress.text, store.getPin(id).progress.count], ["Step 40", 40]);
  assert.equal(store.listPins()[0].progress.count, 40);
  assert.throws(() => store.addStep(id, { body: "One too many" }), (e) => e instanceof ConflictError && e.status === 409 && /40 steps/.test(e.message));
  assert.deepEqual(store.listSteps(id).map((step) => step.id), Array.from({ length: 40 }, (_, i) => i + 1));
  store.transition(id, "resolve", { summary: "Fixed" });
  assert.throws(() => store.addStep(id, { body: "Late" }), /pin #1 is done/);
  store.transition(id, "reopen");
  assert.equal(store.listSteps(id).length, 40, "the steps stay until the next run starts");
  assert.equal(store.transition(id, "start", { agent: "claude", run: "triad:2" }).progress, null);
  assert.deepEqual(store.listSteps(id), []);
  assert.equal(store.addStep(id, { body: "New run" }).pin.progress.count, 1);
  const other = store.createPin(input());
  store.transition(other.id, "start");
  store.addStep(other.id, { body: "Other pin" });
  assert.deepEqual([store.getPin(id).progress.text, store.getPin(other.id).progress.text], ["New run", "Other pin"]);
  store.deletePin(id);
  assert.deepEqual(store.listSteps(id), []);
  assert.equal(store.listSteps(other.id).length, 1);
  store.close();
});

test("shots: kind, type, size and first bytes are checked; a file is 0600, one per kind, replaced whole", (t) => {
  const { store, shots } = fileStore(t);
  const { id } = store.createPin(input());
  assert.deepEqual([shotType(png), shotType(jpeg), shotType(webp), shotType(all), shotType(Buffer.alloc(0))], ["image/png", "image/jpeg", "image/webp", null, null]);
  const bad = [
    ["middle", { type: "image/png", bytes: png }, /kind must be/],
    ["before", { type: "image/gif", bytes: png }, /shot type must be/],
    ["before", {}, /shot type must be/],
    ["before", { type: "image/png", bytes: Buffer.alloc(0) }, /1 byte to 2 MiB/],
    ["before", { type: "image/png", bytes: Buffer.concat([png, Buffer.alloc(SHOT_MAX - png.length + 1)]) }, /1 byte to 2 MiB/],
    ["before", { type: "image/png", bytes: png.toString("latin1") }, /1 byte to 2 MiB/],
    ["before", { type: "image/png", bytes: jpeg }, /shot is not image\/png/],
    ["before", { type: "image/jpeg", bytes: webp }, /shot is not image\/jpeg/],
    ["before", { type: "image/webp", bytes: png }, /shot is not image\/webp/],
    ["before", { type: "image/webp", bytes: Buffer.from("RIFF1234WEBX") }, /shot is not image\/webp/],
  ];
  for (const [kind, shot, re] of bad) assert.throws(() => store.setShot(id, kind, shot), (e) => e instanceof ValidationError && e.status === 400 && re.test(e.message), String(re));
  assert.equal(store.setShot(999, "before", { type: "image/png", bytes: png }), null);
  assert.equal(existsSync(shots), false, "a refused shot writes nothing");
  assert.equal(store.getShot(id, "before"), null);
  const seen = [];
  store.on("change", (event) => seen.push(event));
  const pin = store.setShot(id, "before", { type: "image/png", bytes: png });
  assert.equal(new Date(pin.shots.before).toISOString(), pin.shots.before);
  assert.equal(pin.shots.after, null);
  assert.equal(pin.updatedAt, pin.shots.before);
  assert.deepEqual(seen, [{ type: "pin", action: "updated", pin }]);
  assert.deepEqual(store.getShot(id, "before"), { type: "image/png", bytes: png });
  assert.equal(statSync(join(shots, `${id}-before`)).mode & 0o777, 0o600);
  store.setShot(id, "before", { type: "image/jpeg", bytes: jpeg });
  store.setShot(id, "after", { type: "image/webp", bytes: webp });
  assert.deepEqual(readdirSync(shots).sort(), [`${id}-after`, `${id}-before`], "no temp file stays and a new type replaces the old file");
  assert.deepEqual(store.getShot(id, "before"), { type: "image/jpeg", bytes: jpeg });
  assert.deepEqual(store.getShot(id, "after"), { type: "image/webp", bytes: webp });
  const full = Buffer.concat([png, Buffer.alloc(SHOT_MAX - png.length, 7)]);
  store.setShot(id, "after", { type: "image/png", bytes: full });
  assert.ok(store.getShot(id, "after").bytes.equals(full), "exactly 2 MiB is allowed");
  for (const [pinId, kind] of [[id, "__proto__"], [id, "middle"], [999, "before"]]) assert.equal(store.getShot(pinId, kind), null);
  rmSync(join(shots, `${id}-before`));
  assert.equal(store.getShot(id, "before"), null, "a missing file is no shot");
  const memory = openStore({ file: ":memory:" });
  t.after(() => memory.close());
  memory.createPin(input());
  assert.throws(() => memory.setShot(1, "before", { type: "image/png", bytes: png }), /shotsDir/);
  assert.equal(memory.pruneShots(), 0);
});

test("start deletes both shot files of the earlier run; deletePin deletes the files of its pin only", (t) => {
  const { store, shots } = fileStore(t);
  const { id } = store.createPin(input());
  store.transition(id, "start", { agent: "claude" });
  store.setShot(id, "before", { type: "image/png", bytes: png });
  store.setShot(id, "after", { type: "image/jpeg", bytes: jpeg });
  const done = store.transition(id, "resolve", { summary: "Fixed" });
  assert.ok(done.shots.before && done.shots.after, "a closed pin keeps its shots");
  store.transition(id, "reopen");
  assert.ok(store.getShot(id, "after"), "reopen keeps them until the next run starts");
  assert.deepEqual(store.transition(id, "start", { agent: "claude" }).shots, { before: null, after: null });
  assert.deepEqual(readdirSync(shots), []);
  assert.equal(store.getShot(id, "before"), null);
  store.setShot(id, "before", { type: "image/png", bytes: png });
  const other = store.createPin(input());
  store.setShot(other.id, "after", { type: "image/png", bytes: png });
  assert.equal(store.deletePin(id), true);
  assert.deepEqual(readdirSync(shots), [`${other.id}-after`]);
});

test("pruneShots removes the files of deleted pins and of pins closed more than 30 days ago, and nothing else", (t) => {
  const { store, dir, shots } = fileStore(t);
  const ids = {};
  for (const name of ["open", "recent", "old", "gone"]) {
    ids[name] = store.createPin(input()).id;
    store.transition(ids[name], "start", { agent: "claude" });
    for (const kind of ["before", "after"]) store.setShot(ids[name], kind, { type: "image/png", bytes: png });
  }
  store.transition(ids.recent, "resolve", { summary: "Fixed" });
  store.transition(ids.old, "dismiss", { reason: "Duplicate" });
  const db = new DatabaseSync(join(dir, "pins.db"));
  const close = db.prepare("UPDATE pins SET closed_at = ? WHERE id = ?");
  close.run(new Date(Date.now() - 31 * 86400000).toISOString(), ids.old);
  close.run(new Date(Date.now() - 29 * 86400000).toISOString(), ids.recent);
  // A pin row that went without its files (for example a crash between the two).
  db.prepare("DELETE FROM pins WHERE id = ?").run(ids.gone);
  db.close();
  writeFileSync(join(shots, "777-after.tmp"), "half");
  writeFileSync(join(shots, `${ids.open}-before.tmp`), "half");
  writeFileSync(join(shots, "notes.txt"), "keep");
  assert.equal(store.pruneShots(), 5);
  assert.deepEqual(readdirSync(shots).sort(), [`${ids.open}-after`, `${ids.open}-before`, `${ids.open}-before.tmp`, `${ids.recent}-after`, `${ids.recent}-before`, "notes.txt"].sort());
  assert.deepEqual(store.getPin(ids.old).shots, { before: null, after: null });
  assert.equal(store.getShot(ids.old, "before"), null);
  assert.deepEqual(store.getShot(ids.recent, "before"), { type: "image/png", bytes: png });
  assert.ok(store.getPin(ids.open).shots.after);
  assert.equal(store.pruneShots(), 0);
  assert.equal(store.pruneShots({ olderThanDays: 7 }), 2);
  assert.deepEqual(store.getPin(ids.recent).shots, { before: null, after: null });
});

test("listPins filters on the exact selector of the first target", () => {
  const store = openStore({ file: ":memory:" });
  const ids = (options) => store.listPins(options).map((pin) => pin.id);
  const quoted = 'a[href="/x"] > b\'c';
  const a = store.createPin(input({ targets: [{ selector: "main > h1", label: "h1" }, { selector: "#second", label: "b" }] }));
  const b = store.createPin(input({ url: "https://crm.koglabs.com/x" }));
  store.createPin(input({ targets: [{ selector: "main > h1.title", label: "h1" }] }));
  const c = store.createPin(input({ targets: [{ selector: quoted, label: "q" }] }));
  assert.deepEqual(ids({ selector: "main > h1" }), [b.id, a.id]);
  assert.deepEqual(ids({ selector: "main > h1", host: "crete.koglabs.com" }), [a.id]);
  assert.deepEqual(ids({ selector: "#second" }), [], "only the first target counts");
  assert.deepEqual(ids({ selector: "main > h" }), [], "exact match, not a prefix");
  assert.deepEqual(ids({ selector: "%" }), []);
  assert.deepEqual(ids({ selector: quoted }), [c.id]);
  store.transition(a.id, "resolve", { summary: "Fixed" });
  assert.deepEqual(ids({ selector: "main > h1", statuses: ["done"] }), [a.id]);
  assert.equal(ids({ selector: "" }).length, 3, "an empty selector is no filter");
  store.close();
});

test("a v2 file opens as v3: every pin, reply, batch and setting stays; the new fields get defaults and work", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-v2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pins.db");
  const old = createV2Database(file);
  const rows = old.prepare("SELECT * FROM pins ORDER BY id").all().map((row) => ({ ...row, intent: null, scope: null, presets: null, shot_before: null, shot_after: null, accepted_at: null, reopens: null, versions: null, revert: null, reverted_at: null }));
  const replies = old.prepare("SELECT * FROM replies ORDER BY id").all();
  const batches = old.prepare("SELECT * FROM batches ORDER BY id").all();
  const rootpage = old.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'pins'").get().rootpage;
  assert.equal(rows.length, 5);
  old.close();
  let store = openStore({ file });
  t.after(() => store.close());
  const inspect = new DatabaseSync(file);
  t.after(() => inspect.close());
  assert.deepEqual(inspect.prepare("SELECT * FROM pins ORDER BY id").all().map((row) => ({ ...row })), rows);
  assert.deepEqual(inspect.prepare("SELECT * FROM replies ORDER BY id").all(), replies);
  assert.deepEqual(inspect.prepare("SELECT * FROM batches ORDER BY id").all(), batches);
  assert.equal(inspect.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'pins'").get().rootpage, rootpage, "new columns need no rebuild");
  assert.deepEqual(inspect.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'steps'").all().length, 1);
  assert.deepEqual(store.getSettings(), { autofix: false, bulk: { on: false, delegate: false, agents: 3 } });
  assert.deepEqual(store.listPins({ statuses: STATUSES }).map((pin) => [pin.id, pin.status]), [[34, "dismissed"], [33, "done"], [32, "waiting"], [31, "working"], [30, "queued"]]);
  const working = store.getPin(31);
  assert.deepEqual(
    [working.note, working.batch, working.model, working.attempts, working.run, working.replyCount, working.intent, working.scope, working.presets, working.progress, working.shots],
    ["Καλώς 👋 working", 4, "opus", 1, "triad:31", 1, null, null, [], null, { before: null, after: null }],
  );
  assert.deepEqual(store.listPins({ selector: "#v2-1" }).map((pin) => pin.id), [31]);
  const again = store.createBatch({ pins: [input()], key: "v2-batch-key" });
  assert.deepEqual([again.created, again.batch.id, again.pins.map((pin) => pin.id)], [false, 4, [31, 33]]);
  assert.equal(store.addStep(31, { author: "claude", body: "Step on an old pin" }).pin.progress.count, 1);
  assert.ok(store.setShot(31, "before", { type: "image/png", bytes: png }).shots.before);
  assert.equal(store.addReply(31, { kind: "agent", author: "claude", body: "New reply" }).id, 55);
  assert.deepEqual([store.createPin(input({ intent: "text", presets: [{ label: "A", text: "B" }] })).id], [35]);
  store.close();
  store = openStore({ file });
  assert.equal(store.getPin(31).progress.text, "Step on an old pin");
  assert.deepEqual(store.getShot(31, "before"), { type: "image/png", bytes: png });
  assert.deepEqual(store.getPin(35).presets, [{ label: "A", text: "B" }]);
  assert.equal(count(store), 6);
});
