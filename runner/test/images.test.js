// The runner half of pin images (docs/protocol.md, Auto-fix runner, item 17).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_MAX, savePinImages } from "../src/images.js";
import { harness } from "./helpers.js";

const A = "a".repeat(22), B = "b".repeat(22), C = "c".repeat(22), D = "d".repeat(22);
const png = (size = 32) => {
  const buf = Buffer.alloc(size, 0x11);
  buf.writeUInt32BE(0x89504e47, 0);
  return buf;
};
const jpeg = (size = 32) => {
  const buf = Buffer.alloc(size, 0x22);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return buf;
};
const webp = (size = 32) => {
  const buf = Buffer.alloc(size, 0x33);
  buf.write("RIFF", 0);
  buf.write("WEBP", 8);
  return buf;
};
const image = (id, extra = {}) => ({ id, replyId: null, author: "sam", createdAt: "2026-11-15T10:00:00.000Z", ...extra });
const realClock = { now: () => Date.now(), setTimeout, clearTimeout };
const mode = (file) => statSync(file).mode & 0o777;

function rootDir(t) {
  const root = mkdtempSync(join(tmpdir(), "pins-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A pins server on loopback. handler(req, res) answers one request. The server is closed with the test.
async function serve(t, handler) {
  const server = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    Promise.resolve(handler(req, res)).catch(() => { if (!res.writableEnded) res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

test("a download saves png, jpeg and webp under the pin id, mode 0600, and cuts at 2 MiB", async (t) => {
  const root = rootDir(t), dir = join(root, "images");
  const big = png(IMAGE_MAX + 64);
  big.fill(0xab, IMAGE_MAX);
  const more = (n) => `${"m".repeat(20)}${String(n).padStart(2, "0")}`;
  const extras = Array.from({ length: 7 }, (_, n) => image(more(n + 1)));
  const dropped = image(more(99));
  const seen = [];
  const bodies = new Map([[A, png()], [B, jpeg()], [C, webp()], [D, big]]);
  const port = await serve(t, (req, res) => {
    const id = req.url.split("/").pop();
    seen.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.host.split(":")[0], "127.0.0.1");
    const body = bodies.get(id) ?? png();
    // The declared type is a lie. The bytes decide.
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(body.length) });
    res.end(body);
  });
  const logs = [];
  const pin = { id: 12, images: [image(A), image(B), image(C), image(D), image("short"), ...extras, dropped] };
  const saved = await savePinImages({ pin, fetch: globalThis.fetch, clock: realClock, port, dir, log: (line) => logs.push(line) });
  assert.equal(saved.length, 12);
  assert.deepEqual(saved.slice(0, 4).map((file) => file.slice(dir.length + 1)), ["12-1.png", "12-2.jpg", "12-3.webp", "12-4.png"]);
  assert.equal(readFileSync(saved[0]).equals(png()), true);
  assert.equal(readFileSync(saved[1]).equals(jpeg()), true);
  assert.equal(readFileSync(saved[3]).length, IMAGE_MAX, "the read stops at 2 MiB");
  assert.equal(readFileSync(saved[3])[IMAGE_MAX - 1], 0x11);
  assert.equal(saved[4], null, "an id that is not 22 url-safe characters is skipped");
  assert.equal(saved[11].endsWith("/12-12.png"), true);
  for (const file of saved) if (file) assert.equal(mode(file), 0o600, file);
  assert.equal(mode(dir), 0o700);
  assert.equal(seen.length, 11);
  assert.equal(seen.includes(`GET /api/images/${dropped.id}`), false, "a pin keeps at most 12 images");
  assert.equal(seen.includes("GET /api/images/short"), false);
  assert.deepEqual(logs, ["image skipped pin=12 n=5"]);
  assert.equal(existsSync(join(dir, "12-5.png")), false);
});

test("a wrong type, an empty body and an HTTP error are skipped and the run still returns", async (t) => {
  const root = rootDir(t), dir = join(root, "out");
  const port = await serve(t, (req, res) => {
    const id = req.url.split("/").pop();
    if (id === A) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(Buffer.from("GIF89a not a photo")); }
    if (id === B) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(); }
    res.writeHead(500); res.end("no");
  });
  const logs = [];
  const saved = await savePinImages({
    pin: { id: 7, images: [image(A), image(B), image(C)] },
    fetch: globalThis.fetch, clock: realClock, port, dir, log: (line) => logs.push(line),
  });
  assert.deepEqual(saved, [null, null, null]);
  assert.deepEqual(logs.sort(), ["image skipped pin=7 n=1", "image skipped pin=7 n=2", "image skipped pin=7 n=3"]);
  assert.equal(existsSync(dir), false, "nothing was saved, so the folder stays absent");
});

test("a hung download stops at 5 s, keeps a file that already arrived, and does not wait per image", { timeout: 8000 }, async (t) => {
  const { FakeClock } = await import("./helpers.js");
  const clock = new FakeClock();
  const root = rootDir(t), dir = join(root, "images");
  let sawFast = false;
  const port = await serve(t, (req, res) => {
    const id = req.url.split("/").pop();
    if (id === B) { sawFast = true; res.writeHead(200); return res.end(jpeg()); }
    req.on("close", () => {});
  });
  const logs = [];
  let finished = false;
  const pending = savePinImages({
    pin: { id: 12, images: [image(A), image(B)] },
    fetch: globalThis.fetch, clock, port, dir, log: (line) => logs.push(line),
  }).then((value) => { finished = true; return value; });
  for (let i = 0; i < 50 && !sawFast; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sawFast, true, "the second image starts while the first is still open");
  assert.equal(finished, false);
  await clock.tick(4999);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished, false, "4999 ms is inside the limit");
  await clock.tick(1);
  const saved = await pending;
  assert.equal(saved[0], null);
  assert.equal(saved[1].endsWith("/12-2.jpg"), true);
  assert.equal(readFileSync(saved[1]).equals(jpeg()), true);
  assert.deepEqual(logs, ["image skipped pin=12 n=1"]);
  assert.equal(existsSync(join(dir, "12-1.png")), false);
});

test("a save removes files in the folder that are older than 30 days, and leaves the rest", async (t) => {
  const root = rootDir(t), dir = join(root, "images");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const age = (name, days, link = false) => {
    const then = new Date(Date.now() - days * 86400000);
    (link ? lutimesSync : utimesSync)(join(dir, name), then, then);
  };
  writeFileSync(join(dir, "old.txt"), "gone");
  writeFileSync(join(dir, "recent.txt"), "keep");
  mkdirSync(join(dir, "kept-dir"));
  writeFileSync(join(root, "target.txt"), "keep");
  symlinkSync(join(root, "target.txt"), join(dir, "old-link"));
  age("old.txt", 31);
  age("recent.txt", 29);
  age("kept-dir", 31);
  age("old-link", 31, true);
  utimesSync(join(root, "target.txt"), new Date(0), new Date(0));
  const port = await serve(t, (req, res) => { res.writeHead(200); res.end(png()); });
  const saved = await savePinImages({
    pin: { id: 3, images: [image(A)] },
    fetch: globalThis.fetch, clock: realClock, port, dir,
  });
  assert.equal(saved[0], join(dir, "3-1.png"));
  assert.deepEqual(readdirSync(dir).sort(), ["3-1.png", "kept-dir", "recent.txt"]);
  assert.equal(readFileSync(join(root, "target.txt"), "utf8"), "keep");
  assert.equal(lstatSync(join(dir, "kept-dir")).isDirectory(), true);
  assert.equal(mode(dir), 0o700, "the folder is private even when it already existed");
  assert.equal(mode(saved[0]), 0o600);
});

test("a revert run downloads nothing; a fix run saves before the brief returns and puts the path in the prompt", { timeout: 8000 }, async (t) => {
  const root = rootDir(t), dir = join(root, "images");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let briefSawRequest = false;
  const h = harness(t, {
    config: { imagesDir: dir },
    brief: async () => {
      briefSawRequest = h.requests.some((request) => request.path === `/api/images/${A}`);
      release();
      return null;
    },
  });
  h.intercept(async (request) => {
    if (!request.path.startsWith("/api/images/")) return;
    if (request.path.endsWith(`/${B}`)) return new Response("no", { status: 404 });
    await gate;
    return new Response(png());
  });
  await h.start();
  h.add(12, "market.koglabs.com", { images: [image(A), image(B)] });
  await h.settle();
  assert.equal(briefSawRequest, true, "the download is already started when the brief runs");
  const prompt = h.delegates[0].body.prompt;
  const file = join(dir, "12-1.png");
  assert.ok(prompt.includes(`Images he attached (his material, like the note; open each one with the Read tool before you change anything):\n1. ${file} (with the note)\n2. not saved; run "pins images 12" to get it\n`));
  assert.equal(readFileSync(file).equals(png()), true);
  assert.equal(mode(file), 0o600);
  assert.ok(h.logs.includes("image skipped pin=12 n=2"));
  assert.ok(h.order.indexOf(`GET /api/images/${A}`) < h.order.indexOf("delegate"));

  const back = harness(t, { config: { imagesDir: dir } });
  await back.start();
  back.add(4, "one.koglabs.com", { images: [image(A)], revert: { commits: ["abc1234abc1234abc1234abc1234abc1234abc12"], attempts: 0 } });
  await back.settle();
  assert.equal(back.requests.some((request) => request.path.startsWith("/api/images")), false);
  assert.equal(back.delegates[0].body.prompt.includes("Images he attached"), false);
  assert.equal(back.logs.some((line) => line.startsWith("image skipped")), false);
});

test("a bulk run downloads each pin and lists that pin's images in its own words", async (t) => {
  const root = rootDir(t), dir = join(root, "images");
  const h = harness(t, { bulk: { on: true, delegate: false, agents: 3 }, config: { imagesDir: dir } });
  const bytes = new Map([[A, png()], [B, webp()]]);
  h.intercept(async (request) => {
    if (!request.path.startsWith("/api/images/")) return;
    return new Response(bytes.get(request.path.split("/").pop()));
  });
  await h.start();
  h.add(12, "market.koglabs.com", { batch: 3, images: [image(A)] });
  h.add(13, "market.koglabs.com", { batch: 3, note: "No photo" });
  h.add(14, "market.koglabs.com", { batch: 3, images: [image(B, { replyId: 8 })] });
  await h.settle();
  assert.equal(h.delegates.length, 1);
  const prompt = h.delegates[0].body.prompt;
  assert.ok(prompt.includes(`1. ${join(dir, "12-1.png")} (with the note)`));
  assert.ok(prompt.includes(`1. ${join(dir, "14-1.webp")} (with his reply at `));
  assert.ok(prompt.indexOf("Pin #12") < prompt.indexOf("12-1.png") && prompt.indexOf("12-1.png") < prompt.indexOf("Pin #13"));
  assert.ok(prompt.includes("Pin #13. His words:\nNote: No photo\n"));
  assert.equal(prompt.split("Images he attached").length, 3);
  assert.equal(mode(join(dir, "14-1.webp")), 0o600);
});
