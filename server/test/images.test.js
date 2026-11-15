import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { formatDetail } from "../src/format.js";
import { openStore } from "../src/store.js";
import { IMAGE_ID_RE, SHOT_MAX } from "../src/shots.js";
import { createOldDatabase, createV2Database } from "./old-schema.js";

const bin = fileURLToPath(new URL("../bin/pins.js", import.meta.url));
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("png body")]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("jpeg body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"), Buffer.from("webp body")]);
const input = (extra = {}) => ({ url: "https://crete.koglabs.com/pricing", note: "Fix spacing", targets: [{ selector: "h1", label: "h1" }], ...extra });

async function fixture(t, { file = ":memory:" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pins-images-"));
  const imagesDir = join(dir, "images");
  const store = openStore({ file, shotsDir: join(dir, "shots"), imagesDir });
  const app = createApp({ store, version: "test" });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const events = [];
  store.on("change", (event) => events.push(event));
  async function call(path, { method = "GET", body, raw, type, headers = {} } = {}) {
    const sent = { "X-SSO-User": "sam", ...headers };
    if (body !== undefined) sent["Content-Type"] = "application/json";
    if (type) sent["Content-Type"] = type;
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: sent, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(bytes.toString("utf8")) : null;
    return { status: response.status, headers: response.headers, bytes, data: json };
  }
  const upload = async (bytes = PNG, type = "image/png", headers) => {
    const response = await call("/images", { method: "POST", raw: bytes, type, headers });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.image;
  };
  const pinCount = () => store.listPins({ statuses: ["queued", "working", "waiting", "done", "dismissed"] }).length;
  return { store, port, dir, imagesDir, events, call, upload, pinCount };
}

test("an image uploads as raw bytes and comes back with the shot headers; the file is private", async (t) => {
  const f = await fixture(t);
  const image = await f.upload();
  assert.match(image.id, IMAGE_ID_RE);
  assert.deepEqual({ ...image, id: 0, createdAt: 0 }, { id: 0, type: "image/png", size: PNG.length, replyId: null, author: "sam", createdAt: 0 });
  assert.match(image.createdAt, /^\d{4}-\d\d-\d\dT/);
  const got = await f.call(`/images/${image.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.bytes, PNG);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("content-length"), String(PNG.length));
  assert.equal(got.headers.get("cache-control"), "private, no-cache");
  assert.equal(got.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(statSync(join(f.imagesDir, image.id)).mode & 0o777, 0o600);
  assert.equal(statSync(f.imagesDir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(f.imagesDir), [image.id], "no temp file stays");
  // An agent uploads too, and the user upload works through Caddy (X-Forwarded-For); the type follows the bytes.
  const agent = await f.upload(WEBP, "image/webp", { "X-Pins-Agent": "claude" });
  assert.deepEqual([agent.author, agent.type], ["claude", "image/webp"]);
  const proxied = await f.upload(JPEG, "image/jpeg; charset=x", { "X-Forwarded-For": "1.2.3.4" });
  assert.equal(proxied.type, "image/jpeg");
  assert.notEqual(proxied.id, image.id);
  assert.equal((await f.call(`/images/${proxied.id}`)).headers.get("content-type"), "image/jpeg");
});

test("an upload with a wrong type, a big or empty body or bytes of another type is refused and writes nothing", async (t) => {
  const f = await fixture(t);
  for (const type of [undefined, "text/plain", "image/gif", "application/json"]) {
    const response = await f.call("/images", { method: "POST", raw: PNG, type });
    assert.equal(response.status, 415, type);
    assert.match(response.data.error, /content type must be image\/png, image\/jpeg, image\/webp/);
  }
  assert.equal((await f.call("/images", { method: "POST", raw: Buffer.concat([PNG, Buffer.alloc(SHOT_MAX)]), type: "image/png" })).status, 413);
  for (const [bytes, type, error] of [[Buffer.alloc(0), "image/png", /1 byte to 2 MiB/], [JPEG, "image/png", /image is not image\/png/], [Buffer.from("hello"), "image/webp", /not image\/webp/]]) {
    const response = await f.call("/images", { method: "POST", raw: bytes, type });
    assert.deepEqual([response.status, response.data.error.match(error) !== null], [400, true]);
  }
  assert.equal(existsSync(f.imagesDir) ? readdirSync(f.imagesDir).length : 0, 0);
  // Unknown and malformed ids are 404; other methods are 405.
  const id = "A".repeat(22);
  for (const path of [`/images/${id}`, "/images/short", `/images/${"A".repeat(23)}`, `/images/${"A".repeat(21)}!`, `/images/${id}/x`, "/images/"]) {
    assert.equal((await f.call(path)).status, 404, path);
  }
  const image = await f.upload();
  assert.equal((await f.call("/images")).status, 405);
  const post = await f.call(`/images/${image.id}`, { method: "POST", body: {} });
  assert.deepEqual([post.status, post.headers.get("allow")], [405, "GET"]);
});

test("at most 200 unlinked images wait for a pin", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 200; i++) f.store.addImage({ type: "image/png", bytes: PNG, author: "sam" });
  const refused = await f.call("/images", { method: "POST", raw: PNG, type: "image/png" });
  assert.deepEqual([refused.status, refused.data], [409, { error: "too many images wait for a pin" }]);
  assert.equal(readdirSync(f.imagesDir).length, 200);
  // A linked image no longer waits.
  const waiting = readdirSync(f.imagesDir).slice(0, 1);
  assert.equal((await f.call("/pins", { method: "POST", body: input({ images: waiting }) })).status, 201);
  await f.upload();
});

test("a pin links its images in the insert: the created event carries them, oldest first", async (t) => {
  const f = await fixture(t);
  const [a, b] = [await f.upload(), await f.upload(JPEG, "image/jpeg")];
  const created = await f.call("/pins", { method: "POST", body: input({ images: [b.id, a.id] }) });
  assert.equal(created.status, 201);
  const pin = created.data.pin;
  assert.deepEqual(pin.images, [a, b]);
  const event = f.events.find((e) => e.type === "pin" && e.action === "created");
  assert.deepEqual(event.pin.images, [a, b]);
  assert.deepEqual((await f.call(`/pins/${pin.id}`)).data.pin.images, [a, b]);
  assert.deepEqual((await f.call("/pins")).data.pins[0].images, [a, b]);
  const plain = await f.call("/pins", { method: "POST", body: input() });
  assert.deepEqual(plain.data.pin.images, []);
  // A linked image still downloads.
  assert.deepEqual((await f.call(`/images/${a.id}`)).bytes, PNG);
  // A linked or unknown id is gone; nothing is written.
  const before = f.pinCount();
  for (const id of [a.id, "Z".repeat(22)]) {
    const refused = await f.call("/pins", { method: "POST", body: input({ images: [id] }) });
    assert.deepEqual([refused.status, refused.data.error], [400, `image ${id.slice(0, 6)} is gone; remove it and try again`]);
  }
  assert.equal(f.pinCount(), before);
  // The shape: an array of 0 to 6 different ids.
  const c = await f.upload();
  for (const images of ["x", [c.id, c.id], ["short"], [1], Array.from({ length: 7 }, (_, i) => `${"B".repeat(21)}${i}`), {}]) {
    const refused = await f.call("/pins", { method: "POST", body: input({ images }) });
    assert.deepEqual([refused.status, refused.data.error], [400, "images must hold 0 to 6 different image ids"], JSON.stringify(images));
  }
  assert.equal(f.pinCount(), before);
  assert.deepEqual((await f.call("/pins", { method: "POST", body: input({ images: [] }) })).data.pin.images, []);
});

test("a batch links each pin's images in one transaction; one gone image writes nothing; a known key links nothing new", async (t) => {
  const f = await fixture(t);
  const [a, b, c] = [await f.upload(), await f.upload(), await f.upload()];
  const refused = await f.call("/batches", { method: "POST", body: { key: "batch-key-1", pins: [input({ images: [a.id] }), input({ images: ["Q".repeat(22)] })] } });
  assert.deepEqual([refused.status, refused.data.error], [400, `image QQQQQQ is gone; remove it and try again`]);
  assert.equal(f.pinCount(), 0);
  // The same id in two pins of one batch: the second link fails, so the first is undone too.
  const twice = await f.call("/batches", { method: "POST", body: { pins: [input({ images: [a.id] }), input({ images: [a.id] })] } });
  assert.equal(twice.status, 400);
  assert.equal(f.pinCount(), 0);
  const bad = await f.call("/batches", { method: "POST", body: { pins: [input(), input({ images: "x" })] } });
  assert.deepEqual([bad.status, bad.data.error], [400, "pin 2: images must hold 0 to 6 different image ids"]);
  const created = await f.call("/batches", { method: "POST", body: { key: "batch-key-1", pins: [input({ images: [a.id, b.id] }), input(), input({ images: [c.id] })] } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.pins.map((pin) => pin.images.map((image) => image.id)), [[a.id, b.id], [], [c.id]]);
  const createdEvents = f.events.filter((e) => e.type === "pin" && e.action === "created");
  assert.deepEqual(createdEvents.map((e) => e.pin.images.length), [2, 0, 1]);
  const d = await f.upload();
  const again = await f.call("/batches", { method: "POST", body: { key: "batch-key-1", pins: [input({ images: [d.id] })] } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.pins.map((pin) => pin.images.length), [2, 0, 1]);
  // d is still unlinked: a new pin can take it.
  assert.equal((await f.call("/pins", { method: "POST", body: input({ images: [d.id] }) })).status, 201);
});

test("a reply links its images with its reply id; a pin holds at most 12; start and reopen keep the images", async (t) => {
  const f = await fixture(t);
  const first = await Promise.all(Array.from({ length: 6 }, () => f.upload()));
  const pin = (await f.call("/pins", { method: "POST", body: input({ images: first.map((i) => i.id) }) })).data.pin;
  const more = await Promise.all(Array.from({ length: 6 }, () => f.upload()));
  const replied = await f.call(`/pins/${pin.id}/replies`, { method: "POST", body: { body: "See the attached images.", images: more.map((i) => i.id) } });
  assert.equal(replied.status, 201);
  const replyId = replied.data.reply.id;
  assert.deepEqual(replied.data.pin.images.map((i) => i.replyId), [...Array(6).fill(null), ...Array(6).fill(replyId)]);
  const replyEvent = f.events.find((e) => e.type === "reply");
  assert.equal(replyEvent.pin.images.length, 12);
  const extra = await f.upload();
  const full = await f.call(`/pins/${pin.id}/replies`, { method: "POST", body: { body: "One more", images: [extra.id] } });
  assert.deepEqual([full.status, full.data.error], [409, "a pin holds at most 12 images"]);
  assert.equal(f.store.listReplies(pin.id).length, 1, "the refused reply is not written");
  const other = (await f.call("/pins", { method: "POST", body: input() })).data.pin;
  const gone = await f.call(`/pins/${other.id}/replies`, { method: "POST", body: { body: "x", images: [first[0].id] } });
  assert.deepEqual([gone.status, gone.data.error], [400, `image ${first[0].id.slice(0, 6)} is gone; remove it and try again`]);
  assert.deepEqual(f.store.listReplies(other.id), []);
  assert.equal((await f.call(`/pins/${other.id}/replies`, { method: "POST", body: { images: [extra.id] } })).status, 400, "a reply still needs a body");
  assert.equal((await f.call(`/pins/${other.id}/replies`, { method: "POST", body: { body: "x", images: [extra.id] } })).data.pin.images[0].replyId, f.store.listReplies(other.id)[0].id);
  const agent = { "X-Pins-Agent": "claude" };
  for (const action of ["start", "ask", "reopen", "start", "resolve", "reopen"]) {
    const body = { ask: { question: "Which?" }, resolve: { summary: "Fixed" } }[action] ?? {};
    const moved = await f.call(`/pins/${pin.id}/${action}`, { method: "POST", body, headers: action === "reopen" ? {} : agent });
    assert.equal(moved.status, 200, `${action}: ${JSON.stringify(moved.data)}`);
    assert.equal(moved.data.pin.images.length, 12, action);
  }
});

test("deleting a pin removes its image files; the prune removes old, closed and orphan images", async (t) => {
  const f = await fixture(t);
  const a = await f.upload();
  const pin = (await f.call("/pins", { method: "POST", body: input({ images: [a.id] }) })).data.pin;
  assert.equal((await f.call(`/pins/${pin.id}`, { method: "DELETE" })).status, 204);
  assert.equal(existsSync(join(f.imagesDir, a.id)), false);
  assert.equal((await f.call(`/images/${a.id}`)).status, 404);

  const [open, closed, waiting] = [await f.upload(), await f.upload(), await f.upload()];
  const openPin = (await f.call("/pins", { method: "POST", body: input({ images: [open.id] }) })).data.pin;
  const closedPin = (await f.call("/pins", { method: "POST", body: input({ images: [closed.id] }) })).data.pin;
  assert.equal((await f.call(`/pins/${closedPin.id}/dismiss`, { method: "POST", body: {}, headers: { "X-Pins-Agent": "claude" } })).status, 200);
  const orphan = "O".repeat(22);
  for (const name of [orphan, `${orphan}.tmp`, "notes.txt"]) writeFileSync(join(f.imagesDir, name), PNG);
  // Fresh files stay, except files without a row.
  assert.equal(f.store.pruneImages(), 2);
  assert.deepEqual(readdirSync(f.imagesDir).sort(), [open.id, closed.id, waiting.id, "notes.txt"].sort());
  // With a cutoff in the future every closed pin and every unlinked image is old.
  assert.equal(f.store.pruneImages({ olderThanDays: -1 }), 2);
  assert.deepEqual(readdirSync(f.imagesDir).sort(), [open.id, "notes.txt"].sort());
  assert.deepEqual(f.store.getPin(closedPin.id).images, []);
  assert.deepEqual(f.store.getPin(openPin.id).images.map((i) => i.id), [open.id]);
  assert.equal(f.store.getImage(waiting.id), null);
});

test("an old database file gets the images table on open", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-images-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, create, id] of [["old.db", createOldDatabase, 12], ["v2.db", createV2Database, 30]]) {
    const file = join(dir, name);
    create(file).close();
    const store = openStore({ file });
    try {
      assert.deepEqual(store.getPin(id).images, []);
      const image = store.addImage({ type: "image/png", bytes: PNG, author: "sam" });
      assert.ok(existsSync(join(dir, "images", image.id)), "images default to a folder next to the database");
      store.addReply(id, { kind: "user", author: "sam", body: "See the attached image.", images: [image.id] });
      assert.deepEqual(store.getPin(id).images.map((i) => i.id), [image.id]);
      assert.deepEqual(store.getImage(image.id), { type: "image/png", bytes: PNG });
    } finally { store.close(); }
    rmSync(join(dir, "images"), { recursive: true, force: true });
  }
});

test("the detail format names the images and the command that saves them", () => {
  const pin = { id: 12, status: "queued", host: "crete.koglabs.com", path: "/", note: "n", quote: "q", targets: [], images: [{ id: "a" }, { id: "b" }] };
  assert.match(formatDetail(pin), /\nquote: "q"\nimages: 2 \(pins images 12 saves them\)$/);
  assert.match(formatDetail({ ...pin, quote: null }), /\nnote: n\nimages: 2 \(pins images 12 saves them\)/);
  assert.doesNotMatch(formatDetail({ ...pin, images: [] }), /images:/);
});

test("CLI pins images saves each image as a private file, oldest first, and prints the paths", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, PINS_PORT: String(f.port), PINS_AGENT: "cli-test" }, stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const images = [await f.upload(), await f.upload(JPEG, "image/jpeg"), await f.upload(WEBP, "image/webp")];
  const pin = (await f.call("/pins", { method: "POST", body: input({ images: images.map((i) => i.id) }) })).data.pin;
  const out = join(f.dir, "out");
  // A stale file (or a symlink) at the target name is replaced, not followed.
  const saved = await run(["images", String(pin.id), "--dir", out]);
  assert.equal(saved.code, 0, saved.stderr);
  const files = ["png", "jpg", "webp"].map((ext, i) => join(out, `pins-${pin.id}-${i + 1}.${ext}`));
  assert.equal(saved.stdout, `${files.join("\n")}\n`);
  for (const [i, file] of files.entries()) {
    assert.deepEqual(readFileSync(file), [PNG, JPEG, WEBP][i]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  writeFileSync(files[0], "stale");
  assert.equal((await run(["images", String(pin.id), "--dir", out])).code, 0);
  assert.deepEqual(readFileSync(files[0]), PNG);
  const bare = (await f.call("/pins", { method: "POST", body: input() })).data.pin;
  assert.deepEqual(await run(["images", String(bare.id)]), { code: 0, stdout: `#${bare.id} has no images\n`, stderr: "" });
  const missing = await run(["images", "999"]);
  assert.deepEqual([missing.code, missing.stderr], [1, "pin not found\n"]);
  assert.equal((await run(["images", String(pin.id), "--dir", "relative"])).code, 2);
  assert.match((await run(["--help"])).stdout, /\n  pins images <id> \[--dir D\]\n/);
  // The default folder is the temp dir.
  const tmp = await run(["images", String(pin.id)]);
  assert.equal(tmp.stdout.split("\n")[0], join(tmpdir(), `pins-${pin.id}-1.png`));
  for (const file of tmp.stdout.trim().split("\n")) rmSync(file, { force: true });
});
