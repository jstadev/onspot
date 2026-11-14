// Shared helpers for the live end-to-end checks (e2e/run.mjs, e2e/autofix.mjs). They run against a
// deployed service behind its proxy and SSO, and drive real Chromium and Firefox with playwright-core.
// Env: PINS_PORT (4750), PLAYWRIGHT_CORE (the same file as for `pins snap`), E2E_LOGIN (the login
// module, default ~/.config/onspot/e2e-login.mjs).
// The login module is not in this repo, because it knows how the deployment's SSO signs a session.
// It exports `user` (the login name that the server records as the pin author) and
// `cookie(apiOrigin)` (one playwright cookie object for an admin session).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { API_ORIGIN } from "../extension/src/shared/protocol.js";

// Loaded only when a browser starts, so the other helpers need no playwright.
const playwright = () => import(pathToFileURL(process.env.PLAYWRIGHT_CORE || "/srv/design-kit/node_modules/playwright-core/index.mjs").href);

export const LOCAL = `http://127.0.0.1:${process.env.PINS_PORT || 4750}`;

/** The login module: { user, cookie(apiOrigin) }. Loaded at the first signed-in browser. */
export async function login() {
  const file = process.env.E2E_LOGIN || path.join(os.homedir(), ".config/onspot/e2e-login.mjs");
  const mod = await import(pathToFileURL(file).href).catch((error) => { throw new Error(`cannot load the e2e login module ${file}: ${error.message}`); });
  if (typeof mod.user !== "string" || typeof mod.cookie !== "function") throw new Error(`${file} must export user (a string) and cookie(apiOrigin)`);
  return mod;
}
const signIn = async (ctx) => ctx.addCookies([(await login()).cookie(API_ORIGIN)]);

// Every browser of this process, from the moment its start begins. `closeBrowsers` is the first
// step of a cleanup: a page that is still open can submit one more test pin.
const open = new Set();
const closeBrowsers = () => Promise.all([...open].map((close) => close()));

// Starts a browser on a fresh profile and runs `setup` on it. Returns { ctx, close, ...setup }.
// `close` waits for a start that still runs, so a signal during the start leaves no browser. A
// browser that does not start, or whose setup fails, leaves no profile folder behind.
// Playwright must not handle the signals: its handler ends the process before `cleanupOnExit`
// has put the server back.
async function openBrowser(type, options, setup) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "onspot-e2e-"));
  const starting = playwright().then((pw) => pw[type].launchPersistentContext(profile, { ...options, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }));
  const close = async () => {
    open.delete(close);
    await starting.then((ctx) => ctx.close()).catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  };
  open.add(close);
  try {
    const ctx = await starting;
    return { ctx, close, ...(await setup(ctx)) };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Chromium with the unpacked extension. Returns { ctx, close }. With `executablePath`, the same
 *  Chrome build runs in that Chromium browser (Brave: /opt/brave.com/brave/brave-browser), with
 *  its default settings in a fresh profile (Brave Shields on). */
export function launchChrome(extDir, { auth = true, executablePath } = {}) {
  return openBrowser("chromium", {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  }, async (ctx) => { if (auth) await signIn(ctx); });
}

/** Firefox with the add-on installed as a temporary add-on over the Remote Debugging Protocol. */
export function launchFirefox(extPath, { auth = true, rdpPort = 6000 + Math.floor(Math.random() * 1000) } = {}) {
  return openBrowser("firefox", {
    headless: true,
    viewport: { width: 1400, height: 900 },
    args: ["-start-debugger-server", String(rdpPort)],
    firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false },
  }, async (ctx) => {
    const addon = await installTemporaryAddon(rdpPort, extPath);
    if (auth) await signIn(ctx);
    return { addon };
  });
}

// RDP packets are "<length>:<json>". The length counts bytes, so the buffer stays bytes.
async function installTemporaryAddon(port, addonPath) {
  const sock = net.connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  const queue = [];
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const i = buf.indexOf(":");
      if (i < 0) return;
      const n = Number(buf.subarray(0, i).toString());
      if (buf.length < i + 1 + n) return;
      queue.push(JSON.parse(buf.subarray(i + 1, i + 1 + n).toString()));
      buf = buf.subarray(i + 1 + n);
    }
  });
  const next = async (match) => {
    for (let t = 0; t < 200; t++) {
      const k = queue.findIndex(match);
      if (k >= 0) return queue.splice(k, 1)[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Firefox RDP: no answer");
  };
  const send = (o) => {
    const s = JSON.stringify(o);
    sock.write(`${Buffer.byteLength(s)}:${s}`);
  };
  await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
  sock.on("error", () => {}); // A late socket error must not stop the process; `next` times out.
  try {
    await next((m) => m.from === "root" && m.applicationType);
    send({ to: "root", type: "getRoot" });
    const root = await next((m) => m.from === "root" && m.addonsActor);
    send({ to: root.addonsActor, type: "installTemporaryAddon", addonPath });
    const res = await next((m) => m.from === root.addonsActor);
    if (!res.addon) throw new Error(`Firefox did not install the add-on: ${JSON.stringify(res)}`);
    return res.addon;
  } finally {
    sock.destroy();
  }
}

/** Loopback REST as a local agent (no Caddy, no cookie). */
export async function api(method, route, body) {
  const res = await fetch(`${LOCAL}/api${route}`, {
    method,
    headers: { "X-Pins-Agent": "e2e", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** One MCP tools/call over loopback; returns the text result. */
export async function mcpCall(name, args) {
  const res = await fetch(`${LOCAL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`MCP ${name}: ${data.error.message}`);
  return { isError: !!data.result.isError, text: data.result.content.map((c) => c.text).join("\n") };
}

/**
 * Deletes every pin whose note holds `tag`, also one that the run made but lost track of.
 * Returns the ids that are still there (the server did not answer, or refused).
 */
export async function removeTestPins(tag) {
  const find = async () => (await api("GET", `/pins?status=all&limit=500&q=${encodeURIComponent(tag)}`)).data.pins.map((pin) => pin.id);
  for (const id of await find()) await api("DELETE", `/pins/${id}`).catch(() => {});
  return find();
}

/**
 * The end of a live check, in the one safe order: close every browser, delete the test pins by
 * tag, then put auto-fix back. With auto-fix on, a test pin that is still queued starts a real
 * fix run, so the pins go before the setting and the browsers before the pins. `autofix` is the
 * value before the run; a run that did not change the setting leaves it out.
 * Returns { left, restored }: the ids of the test pins that are still there (null when the
 * server gave no list) and whether auto-fix holds its old value again.
 */
export async function endRun(tag, { autofix } = {}) {
  await closeBrowsers();
  const left = await removeTestPins(tag).catch((error) => { console.error(`cannot remove the test pins: ${error.message}`); return null; });
  const restored = autofix === undefined || await api("PATCH", "/settings", { autofix }).then((answer) => answer.data?.autofix === autofix, () => false);
  return { left, restored };
}

/**
 * Makes sure that `cleanup` runs one time: when the caller calls the function that this returns,
 * and also on Ctrl+C, a kill signal or an uncaught error. A second signal or error while the
 * cleanup runs waits for the same cleanup. A stopped run must never leave auto-fix off or test
 * pins behind.
 */
export function cleanupOnExit(cleanup) {
  let done = null;
  const once = () => (done ??= Promise.resolve().then(cleanup).catch((error) => { console.error(`CLEANUP FAILED: ${error.message}`); process.exitCode = 1; }));
  // `on`, not `once`: with no handler left, a second signal would end the process in the middle of the cleanup.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => once().finally(() => process.exit(1)));
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => { console.error(error); once().finally(() => process.exit(1)); });
  }
  return once;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeout = 10000, every = 250, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
