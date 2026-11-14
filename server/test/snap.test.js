import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import { loadFacts } from "../src/facts.js";
import { snapPin } from "../src/snap.js";
import { openStore } from "../src/store.js";

const bin = fileURLToPath(new URL("../bin/pins.js", import.meta.url));
const playwright = process.env.PLAYWRIGHT_CORE || "/srv/design-kit/node_modules/playwright-core/index.mjs";

// h2 is at 40,1500 (300x60). #big is larger than the 1600x1200 limit. #noise does not fit 2 MiB as a PNG.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title><style>
  body { margin: 0; font: 400 16px / 24px monospace; }
  .spacer { height: 1500px; }
  h2 { margin: 0 0 0 40px; width: 300px; height: 60px; color: rgb(17, 34, 51); font: 600 32px / 38px monospace; }
  #big { width: 2000px; height: 1500px; background: rgb(0, 90, 160); }
  canvas { display: block; }
</style></head><body>
<div class="spacer"></div>
<h2 id="title">Choose   how
  you explore</h2>
<x-card></x-card>
<p id="hidden" style="display:none">Hidden words</p>
<div id="big"></div>
<canvas id="noise" width="1600" height="1200"></canvas>
<script>
  const root = document.querySelector("x-card").attachShadow({ mode: "open" });
  root.innerHTML = '<p class="inner" style="margin:0;width:120px;height:30px;color:rgb(200, 0, 0)">Shadow text</p>';
  const context = document.getElementById("noise").getContext("2d");
  const image = context.createImageData(1600, 1200);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.random() * 256;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
</script></body></html>`;

const skip = existsSync(playwright) ? false : `playwright-core is not at ${playwright}; pins snap is not tested`;

test("pins snap renders the page in Chromium, saves the element box as the shot and prints what it found", { skip, timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-snap-"));
  const store = openStore({ file: ":memory:", shotsDir: join(dir, "shots") });
  const app = createApp({ store, version: "test" });
  const server = createServer(app);
  const visits = [];
  const site = createServer((req, res) => {
    visits.push(req.headers.cookie ?? "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  server.listen(0, "127.0.0.1");
  site.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(site, "listening")]);
  t.after(async () => {
    app.close();
    for (const item of [server, site]) await new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${site.address().port}/`;
  const factsDir = join(dir, "facts");
  const env = { ...process.env, PINS_PORT: String(server.address().port), PINS_AGENT: "snap-test", PINS_FACTS_DIR: factsDir };
  const run = (...args) => promisify(execFile)(process.execPath, [bin, ...args.map(String)], { env, timeout: 60000 });
  const size = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const target = { selector: "#title", label: 'h2 "Old words"' };
  const retina = store.createPin({ url: "https://crete.koglabs.com/pricing", note: "New words", targets: [target], intent: "text", viewport: { w: 800, h: 600, dpr: 3, scrollY: 1200 } });
  const plain = store.createPin({ url: "https://crete.koglabs.com/pricing", note: "Big", targets: [target], viewport: { w: 800, h: 600 } });
  store.transition(retina.id, "start", { agent: "claude" });

  // The first target of the pin, the default pad of 40: the box 380x140 CSS px at dpr 2 (3 is cut to 2).
  let out = await run("snap", retina.id, "before", "--url", url);
  assert.equal(out.stderr, "");
  assert.match(out.stdout, new RegExp(`^#${retina.id} before: found h2 "Choose how you explore" 300x60 · color rgb\\(17, 34, 51\\) · font .*600 32px / 38px monospace\\n$`));
  let shot = store.getShot(retina.id, "before");
  assert.equal(shot.type, "image/png");
  assert.deepEqual(size(shot.bytes), [760, 280]);
  assert.match(store.getPin(retina.id).shots.before, /^\d{4}-/);

  // The facts: what it measured, as data. A "before" snap prints no verdict line.
  const measured = loadFacts(retina.id, "before", factsDir);
  assert.deepEqual([measured.found, measured.text, measured.rect, measured.url], [true, "Choose how you explore", { x: 40, y: 1500, w: 300, h: 60 }, url]);
  assert.deepEqual([measured.styles.color, measured.styles.display, measured.styles.background, measured.styles.border], ["rgb(17, 34, 51)", "block", "rgba(0, 0, 0, 0)", "0px none rgb(17, 34, 51)"]);
  assert.match(measured.styles.font, /600 32px \/ 38px monospace/);
  assert.match(measured.at, /^\d{4}-\d\d-\d\dT/);
  // snapPin is the same call without the CLI.
  const direct = await snapPin(store.getPin(retina.id), { url, selector: "#title", pad: "0" });
  assert.deepEqual(Object.keys(direct).sort(), ["bytes", "facts", "text"]);
  assert.deepEqual({ ...direct.facts, at: "" }, { ...measured, at: "" });
  assert.equal((await snapPin(store.getPin(retina.id), { url, selector: "#missing" })).facts.found, false);
  // An element that is in the document but has no box (display: none) is gone for a visitor.
  assert.equal((await snapPin(store.getPin(retina.id), { url, selector: "#hidden" })).facts.found, false);

  // A missing element: the viewport, at the scroll position of the pin. The pin asks for new text, so the verdict says gone.
  out = await run("snap", retina.id, "after", "--url", url, "--selector", "#missing");
  assert.equal(out.stdout, `#${retina.id} after: element not found, viewport saved\n#${retina.id} check: the element is gone\n`);
  assert.deepEqual(Object.keys(loadFacts(retina.id, "after", factsDir)), ["found", "url", "at"]);
  shot = store.getShot(retina.id, "after");
  assert.deepEqual([shot.type, size(shot.bytes)], ["image/png", [1600, 1200]]);

  // A shadow part, and a pad that the page edge cuts: x 0 to 180, y 1550 to 1610. The second line is the verdict.
  out = await run("snap", retina.id, "after", "--url", url, "--selector", "x-card >>> .inner", "--pad", "60");
  assert.match(out.stdout, new RegExp(`^#${retina.id} after: found p "Shadow text" 120x30 · color rgb\\(200, 0, 0\\) · font [^\\n]*\\n#${retina.id} check: changed text, style, size, position \\(color, font, margin\\)\\n$`));
  assert.deepEqual(size(store.getShot(retina.id, "after").bytes), [360, 300]);

  // A box over the limit is cut to 1600 x 1200 CSS px.
  out = await run("snap", plain.id, "before", "--url", url, "--selector", "#big", "--pad", "0");
  assert.match(out.stdout, new RegExp(`^#${plain.id} before: found div 2000x1500 · color `));
  assert.deepEqual(size(store.getShot(plain.id, "before").bytes), [1600, 1200]);

  // A PNG over 2 MiB becomes a JPEG.
  out = await run("snap", plain.id, "after", "--url", url, "--selector", "#noise", "--pad", "0");
  assert.match(out.stdout, new RegExp(`^#${plain.id} after: found canvas 1600x1200 · `));
  shot = store.getShot(plain.id, "after");
  assert.equal(shot.type, "image/jpeg");
  assert.ok(shot.bytes.length <= 2 * 1024 * 1024);

  // The same page twice: the pin asks for a new look, so the verdict is "no change", and "done" warns but exits 0.
  const same = store.createPin({ url: "https://crete.koglabs.com/pricing", note: "Make it red", targets: [target], intent: "style" });
  await run("snap", same.id, "before", "--url", url);
  out = await run("snap", same.id, "after", "--url", url);
  assert.match(out.stdout, new RegExp(`\\n#${same.id} check: the look did not change\\n$`));
  const done = await run("done", same.id, "--summary", "Red");
  assert.deepEqual([done.stdout, done.stderr], [`#${same.id} done\n`, "warning: check: the look did not change\n"]);
  assert.equal(store.getPin(same.id).status, "done");

  assert.ok(visits.length >= 5 && visits.every((cookie) => cookie === ""), "each render is a signed-out visitor");
  await assert.rejects(run("snap", "999", "before", "--url", url), (error) => error.code === 1 && error.stderr === "pin not found\n");
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const dead = `http://127.0.0.1:${closed.address().port}/`;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(run("snap", retina.id, "before", "--url", dead), (error) => error.code === 1 && error.stderr === `page.goto: net::ERR_CONNECTION_REFUSED at ${dead}\n`);
  assert.deepEqual(size(store.getShot(retina.id, "before").bytes), [760, 280], "a failed render keeps the earlier shot");
});
