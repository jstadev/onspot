// Unit tests for the cleanup helpers of the live checks. They talk to a fake server on their
// own port and start no browser. The live checks themselves (run.mjs, autofix.mjs) are not run here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const lib = fileURLToPath(new URL("./lib.mjs", import.meta.url));

// Stands for playwright-core, so no browser starts. The "browser" needs FAKE_START_MS to start.
// Its "page" submits a test pin every 2 ms until the browser is closed.
const FAKE_BROWSER = `
  const submit = () => fetch("http://127.0.0.1:" + process.env.PINS_PORT + "/api/pins", { method: "POST",
    headers: { "X-Pins-Agent": "e2e", "Content-Type": "application/json" }, body: JSON.stringify({ note: "e2e-tag page" }) }).catch(() => {});
  async function launchPersistentContext(profile, options) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_START_MS || 0)));
    const sent = new Set();
    const page = setInterval(() => { const request = submit(); sent.add(request); request.finally(() => sent.delete(request)); }, 2);
    console.log("browser started " + JSON.stringify({ profile, ...options }));
    return { close: async () => { clearInterval(page); await Promise.all(sent); console.log("browser closed"); } };
  }
  export const chromium = { launchPersistentContext };`;

function fakeBrowser(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onspot-e2e-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "playwright.mjs"), FAKE_BROWSER);
  return path.join(dir, "playwright.mjs");
}

// A fake Pins server: pins in memory, the settings, and a log of every request.
async function fakeServer(t, { pins = [], undeletable = [], slowMs = 0, noList = false } = {}) {
  const state = { pins: [...pins], autofix: false, log: [] };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    state.log.push(`${req.method} ${url.pathname}${body ? ` ${body}` : ""}`);
    assert.equal(req.headers["x-pins-agent"], "e2e");
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };
    if (slowMs) await sleep(slowMs);
    const id = Number(url.pathname.split("/")[3]);
    if (req.method === "GET" && url.pathname === "/api/pins" && noList) return send(500, { error: "broken" });
    if (req.method === "POST" && url.pathname === "/api/pins") { state.pins.push({ id: 100 + state.pins.length, note: JSON.parse(body).note }); return send(201, {}); }
    if (req.method === "GET" && url.pathname === "/api/pins") return send(200, { pins: state.pins.filter((pin) => pin.note.includes(url.searchParams.get("q"))) });
    if (req.method === "DELETE" && id) {
      if (undeletable.includes(id)) return send(500, { error: "broken" });
      state.pins = state.pins.filter((pin) => pin.id !== id);
      return send(204);
    }
    if (req.method === "PATCH" && url.pathname === "/api/settings") { state.autofix = JSON.parse(body).autofix; return send(200, { autofix: state.autofix }); }
    return send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { state, port: server.address().port };
}

// Runs a script that imports lib.mjs, with the fake server as the Pins server.
function child(port, script, env = {}) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import { cleanupOnExit, endRun, launchChrome, removeTestPins } from ${JSON.stringify(lib)};\n${script}`],
    { env: { PATH: process.env.PATH, PINS_PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  // "close" comes after the last output; `code` is the signal name when a signal ended the script.
  const exit = once(proc, "close").then(([code, signal]) => ({ code: code ?? signal, output }));
  // Waits until the script printed `text`. A script that ends first fails the test at once.
  const line = async (text) => {
    while (!output.includes(text)) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the script ended before "${text}":\n${output}`);
      await Promise.race([once(proc.stdout, "data"), exit]);
    }
  };
  return { proc, exit, line, output: () => output };
}

// The cleanup of e2e/run.mjs: auto-fix was on before the run.
const CLEANUP = `
  const cleanup = cleanupOnExit(async () => {
    const { left, restored } = await endRun("e2e-tag", { autofix: true });
    console.log("cleaned, left " + JSON.stringify(left) + ", restored " + restored);
  });`;

test("removeTestPins deletes each pin with the tag, keeps other pins and names what is left", async (t) => {
  const pins = [{ id: 1, note: "e2e-tag chrome a" }, { id: 2, note: "his own pin" }, { id: 3, note: "e2e-tag firefox b" }, { id: 4, note: "e2e-tag stuck" }];
  const { state, port } = await fakeServer(t, { pins, undeletable: [4] });
  const { code, output } = await child(port, `console.log(JSON.stringify(await removeTestPins("e2e-tag")));`).exit;
  assert.equal(code, 0, output);
  assert.equal(output.trim(), "[4]");
  assert.deepEqual(state.pins.map((pin) => pin.id), [2, 4]);
  assert.deepEqual(state.log.filter((line) => line.startsWith("DELETE")), ["DELETE /api/pins/1", "DELETE /api/pins/3", "DELETE /api/pins/4"]);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} runs the cleanup one time before the process ends`, async (t) => {
    const { state, port } = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }] });
    const run = child(port, `${CLEANUP}\n console.log("ready"); setInterval(() => {}, 1000);`);
    await run.line("ready");
    run.proc.kill(signal);
    const { code, output } = await run.exit;
    assert.equal(code, 1, output);
    assert.match(output, /cleaned, left \[\]/);
    assert.deepEqual(state.pins, []);
    assert.equal(state.autofix, true);
    assert.equal(state.log.filter((line) => line.startsWith("PATCH")).length, 1);
  });
}

test("an uncaught error and a rejected promise run the cleanup; a normal end runs it one time only", async (t) => {
  for (const crash of [`setTimeout(() => { throw new Error("boom"); }, 10);`, `Promise.reject(new Error("boom"));`]) {
    const { state, port } = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }] });
    const { code, output } = await child(port, `${CLEANUP}\n ${crash}\n setInterval(() => {}, 1000);`).exit;
    assert.equal(code, 1, output);
    assert.match(output, /boom/);
    assert.deepEqual(state.pins, []);
    assert.equal(state.autofix, true);
  }
  const { state, port } = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }] });
  const { code, output } = await child(port, `${CLEANUP}\n await cleanup(); await cleanup();`).exit;
  assert.equal(code, 0, output);
  assert.equal(state.log.filter((line) => line.startsWith("PATCH")).length, 1);
  assert.equal(output.match(/cleaned/g).length, 1);
});

test("a cleanup that fails says so and ends with code 1", async (t) => {
  const { port } = await fakeServer(t);
  const { code, output } = await child(port, `const cleanup = cleanupOnExit(async () => { throw new Error("server is gone"); });\n await cleanup();`).exit;
  assert.equal(code, 1, output);
  assert.match(output, /CLEANUP FAILED: server is gone/);
});

test("endRun restores auto-fix only for a run that changed it, and also when the pins cannot be listed", async (t) => {
  const plain = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }] });
  let { code, output } = await child(plain.port, `console.log(JSON.stringify(await endRun("e2e-tag")));`).exit;
  assert.equal(code, 0, output);
  assert.match(output, /\{"left":\[\],"restored":true\}/);
  assert.deepEqual(plain.state.pins, []);
  assert.equal(plain.state.log.some((line) => line.startsWith("PATCH")), false, "e2e/autofix.mjs does not touch the setting");

  const broken = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }], noList: true });
  ({ code, output } = await child(broken.port, `console.log(JSON.stringify(await endRun("e2e-tag", { autofix: true })));`).exit);
  assert.equal(code, 0, output);
  assert.match(output, /cannot remove the test pins: /);
  assert.match(output, /\{"left":null,"restored":true\}/);
  assert.equal(broken.state.autofix, true);

  // The server is gone: both parts fail and the caller can say so.
  ({ code, output } = await child(1, `console.log(JSON.stringify(await endRun("e2e-tag", { autofix: true })));`).exit);
  assert.match(output, /\{"left":null,"restored":false\}/);
});

test("Ctrl+C while a page still submits: the browser closes first, so no test pin is queued when auto-fix is back on", async (t) => {
  const { state, port } = await fakeServer(t);
  const run = child(port, `${CLEANUP}\n await launchChrome("/the/extension", { auth: false }); console.log("ready"); setInterval(() => {}, 1000);`, { PLAYWRIGHT_CORE: fakeBrowser(t) });
  await run.line("ready");
  // Wait for the page to submit, not a fixed time: a slow machine needs longer than a fast one.
  for (let i = 0; i < 500 && state.log.filter((line) => line.startsWith("POST")).length <= 5; i++) await sleep(10);
  run.proc.kill("SIGINT");
  const { code, output } = await run.exit;
  await sleep(100); // a pin of a page that is still open would arrive now
  assert.equal(code, 1, output);
  assert.match(output, /browser closed\ncleaned, left \[\], restored true/);
  assert.equal(state.autofix, true, output);
  assert.deepEqual(state.pins, [], `auto-fix is on again and these test pins are queued. Output of the run:\n${output}`);
  const submits = state.log.filter((line) => line.startsWith("POST")).length;
  assert.ok(submits > 5, `the page submitted ${submits} pins`);
  // The order: the last pin of the page, then the list and the deletes, then auto-fix.
  assert.ok(state.log.findLastIndex((line) => line.startsWith("POST")) < state.log.findIndex((line) => line.startsWith("GET")), state.log.join("\n"));
  assert.match(state.log.at(-1), /^PATCH \/api\/settings/);
  const started = JSON.parse(output.match(/browser started (.+)/)[1]);
  assert.deepEqual([started.handleSIGINT, started.handleSIGTERM, started.handleSIGHUP], [false, false, false], "the signals belong to cleanupOnExit");
  assert.equal(fs.existsSync(started.profile), false, "the profile folder is removed");
});

test("a signal while the browser starts: the cleanup waits for the start, closes the browser and removes its profile", async (t) => {
  const { state, port } = await fakeServer(t);
  // The order of e2e/autofix.mjs: the cleanup is registered before the browser starts.
  const run = child(port, `${CLEANUP}\n console.log("ready"); await launchChrome("/the/extension", { auth: false }); setInterval(() => {}, 1000);`, { PLAYWRIGHT_CORE: fakeBrowser(t), FAKE_START_MS: "300" });
  await run.line("ready");
  await sleep(100);
  assert.equal(run.output().includes("browser started"), false, "the browser still starts");
  run.proc.kill("SIGTERM");
  const { code, output } = await run.exit;
  await sleep(100);
  assert.equal(code, 1, output);
  assert.match(output, /browser closed\ncleaned, left \[\], restored true/);
  assert.deepEqual(state.pins, []);
  assert.equal(state.autofix, true);
  assert.equal(fs.existsSync(JSON.parse(output.match(/browser started (.+)/)[1]).profile), false, "the profile folder is removed");
});

test("a browser that does not start leaves no profile folder and nothing to close", async (t) => {
  const { port } = await fakeServer(t);
  const broken = fakeBrowser(t);
  fs.writeFileSync(broken, `export const chromium = { launchPersistentContext: async (profile) => { console.log("profile " + profile); throw new Error("no browser here"); } };`);
  const { code, output } = await child(port, `await launchChrome("/the/extension", { auth: false }).catch((error) => console.log("failed: " + error.message)); console.log(JSON.stringify(await endRun("e2e-tag")));`, { PLAYWRIGHT_CORE: broken }).exit;
  assert.equal(code, 0, output);
  assert.match(output, /failed: no browser here\n\{"left":\[\],"restored":true\}/);
  assert.equal(fs.existsSync(output.match(/profile (.+)/)[1]), false);
});

test("a second uncaught error during the cleanup waits for the same cleanup: auto-fix is back on", async (t) => {
  const { state, port } = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }], slowMs: 80 });
  const { code, output } = await child(port, `${CLEANUP}\n setTimeout(() => { throw new Error("first"); }, 10); setTimeout(() => { throw new Error("second"); }, 60); setInterval(() => {}, 1000);`).exit;
  assert.equal(code, 1, output);
  assert.match(output, /first[^]*second[^]*cleaned, left \[\], restored true/);
  assert.equal(state.autofix, true, `auto-fix stays off. Output of the run:\n${output}`);
  assert.deepEqual(state.pins, []);
  assert.equal(state.log.filter((line) => line.startsWith("PATCH")).length, 1);
});

test("a second Ctrl+C during the cleanup waits for the same cleanup: auto-fix is back on", async (t) => {
  const { state, port } = await fakeServer(t, { pins: [{ id: 7, note: "e2e-tag x" }], slowMs: 80 });
  const run = child(port, `${CLEANUP}\n console.log("ready"); setInterval(() => {}, 1000);`);
  await run.line("ready");
  run.proc.kill("SIGINT");
  await sleep(50);
  run.proc.kill("SIGINT");
  const { code, output } = await run.exit;
  assert.equal(code, 1, `the process ended with ${code}. Output of the run:\n${output}`);
  assert.equal(state.autofix, true, `auto-fix stays off. Output of the run:\n${output}`);
  assert.deepEqual(state.pins, []);
  assert.equal(output.match(/cleaned/g).length, 1);
  assert.equal(state.log.filter((line) => line.startsWith("PATCH")).length, 1);
});
