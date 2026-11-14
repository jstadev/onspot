// Live end-to-end check: the built extension in real Chromium and Firefox, real koglabs.com
// pages, the deployed server behind Caddy and the hub SSO, and agent actions over MCP.
// Usage: node e2e/run.mjs [chrome|firefox|brave|all] [url ...]   (run on the hub VPS)
// Auto-fix is off while it runs, so his own pins wait. E2E_IDLE_MS (default 70000) is the idle
// time before the live-update check; 0 with one URL keeps the pause under a minute.
// The end, Ctrl+C, a kill signal and an error all close the browsers, delete the test pins and
// put auto-fix back, in this order.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_URL } from "../extension/src/shared/protocol.js";
import { api, cleanupOnExit, endRun, launchChrome, launchFirefox, login, mcpCall, sleep, until } from "./lib.mjs";

const dist = fileURLToPath(new URL("../extension/dist/", import.meta.url));
const BROWSERS = ["chrome", "firefox", "brave"];
const [which = "all", ...args] = process.argv.slice(2);
const urls = args.length ? args : [
  "https://crete.koglabs.com/", "https://crm.koglabs.com/", "https://zoi.koglabs.com/login",
  "https://activities.koglabs.com/", "https://howto.koglabs.com/", "https://koglabs.com/",
  "https://market.koglabs.com/", "https://ai.koglabs.com/",
];
const IDLE_MS = Number(process.env.E2E_IDLE_MS ?? 70000);
const BRAVE = process.env.BRAVE_PATH || "/opt/brave.com/brave/brave-browser";
// Check the input before the first write: a wrong name must not run nothing and report PASS.
if (!["all", ...BROWSERS].includes(which) || !urls.every((url) => URL.canParse(url)) || !Number.isInteger(IDLE_MS) || IDLE_MS < 0) {
  console.error("Usage: node e2e/run.mjs [chrome|firefox|brave|all] [url ...]   (E2E_IDLE_MS: milliseconds, 0 or more)");
  process.exit(2);
}
// Every test note starts with this tag, so the cleanup finds each test pin on the server.
const TAG = `e2e-${Date.now().toString(36)}-${process.pid}`;
let failed = 0;
const ok = (msg) => console.log(`  PASS ${msg}`);
const bad = (msg) => { failed++; console.log(`  FAIL ${msg}`); };

// Our own errors only: the pages log some CSP errors of their own (crm and zoi block an eval).
const ours = (text) => /on-spot|moz-extension|chrome-extension|ai\.koglabs\.com\/pins/i.test(text);

async function pinOn(ctx, url, browser) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && ours(m.text())) errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => { if (ours(String(e.stack))) errors.push(String(e).slice(0, 160)); });
  const host = new URL(url).host;
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.locator("on-spot .capsule").waitFor({ state: "visible", timeout: 15000 });
    await until(() => page.locator("on-spot .connection").getAttribute("data-state").then((s) => s === "live"), { what: "live connection", timeout: 15000 });
    await page.locator("on-spot .pin-button").click(); // v3: Pin starts pin mode at once
    const target = page.locator("h1, h2, p").filter({ visible: true }).first();
    const box = await target.boundingBox();
    await page.mouse.move(box.x + Math.min(30, box.width / 2), box.y + box.height / 2);
    await page.mouse.click(box.x + Math.min(30, box.width / 2), box.y + box.height / 2);
    const note = `${TAG} ${browser} ${host} ${Date.now().toString(36)}`;
    const input = page.locator('on-spot textarea[name="pin-note"]');
    await input.waitFor({ state: "visible", timeout: 5000 });
    await input.fill(note);
    await input.press("Enter"); // v2: Enter adds an unsent pin; nothing goes to the server yet
    await page.locator('on-spot .marker[data-status="draft"]').first().waitFor({ state: "visible", timeout: 5000 });
    if ((await api("GET", `/pins?host=${host}&status=all&q=${encodeURIComponent(note)}`)).data.pins.length) bad(`${host}: Enter sent the pin before Submit all`);
    const t0 = Date.now();
    await page.keyboard.press("Control+Enter"); // Submit all
    const pin = await until(async () => (await api("GET", `/pins?host=${host}&status=all&q=${encodeURIComponent(note)}`)).data.pins[0], { what: "pin on the server" });
    const tSubmit = Date.now() - t0;
    await page.keyboard.press("Escape"); // leave pin mode
    const resolves = await page.evaluate((sel) => {
      let scope = document, node = null;
      for (const part of sel.split(" >>> ")) { node = scope?.querySelector(part) ?? null; scope = node?.shadowRoot; }
      return !!node;
    }, pin.targets[0].selector);
    await page.locator(`on-spot .marker[data-pin="${pin.id}"]`).waitFor({ state: "visible", timeout: 5000 });
    if (pin.author !== (await login()).user) bad(`${host}: author is ${pin.author}`);
    if (!Number.isInteger(pin.batch)) bad(`${host}: pin has no batch`);
    if (!resolves) bad(`${host}: selector does not resolve: ${pin.targets[0].selector}`);
    else ok(`${host}: pin #${pin.id} batch ${pin.batch} ${pin.targets[0].label} (submitted in ${tSubmit} ms, selector resolves, marker shown)`);
    if (errors.length) bad(`${host}: ${errors.length} extension errors: ${errors[0]}`);
    return { page, pin };
  } catch (error) {
    bad(`${host}: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: `/tmp/onspot-e2e-${browser}-${host}.png` }).catch(() => {});
    await page.close();
    return null;
  }
}

async function liveUpdates(page, pin, { idleMs = 0 } = {}) {
  const marker = page.locator(`on-spot .marker[data-pin="${pin.id}"]`);
  if (idleMs) await sleep(idleMs);
  const t0 = Date.now();
  const start = await mcpCall("pins_start", { id: pin.id, agent: "e2e" });
  await until(() => marker.getAttribute("data-status").then((s) => s === "working"), { what: "working marker", timeout: 5000 });
  const tWorking = Date.now() - t0;
  const reply = await mcpCall("pins_reply", { id: pin.id, body: "Checking it now.", agent: "e2e" });
  await marker.click();
  await page.locator("on-spot .reply-body", { hasText: "Checking it now." }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  const t1 = Date.now();
  const done = await mcpCall("pins_resolve", { id: pin.id, summary: "e2e check", commit: "e2e0000", agent: "e2e" });
  await until(() => marker.getAttribute("data-status").then((s) => s === "done").catch(() => false), { what: "done marker", timeout: 5000 });
  const tDone = Date.now() - t1;
  await page.locator('on-spot .toast[data-kind="done"]').waitFor({ state: "visible", timeout: 5000 });
  // "Not right" sends the done pin back through Caddy and the hub SSO as one reply with reopen.
  await marker.click();
  await page.locator('on-spot button[title="Send this pin back for another fix"]').click();
  await page.locator('on-spot textarea[name="pin-reply"]').fill("e2e: still wrong");
  await page.locator('on-spot textarea[name="pin-reply"]').press("Enter");
  await until(async () => (await api("GET", `/pins/${pin.id}`)).data.pin.status === "queued", { what: "reopened pin", timeout: 5000 });
  await page.keyboard.press("Escape");
  await mcpCall("pins_resolve", { id: pin.id, summary: "e2e check 2", agent: "e2e" });
  await until(() => marker.getAttribute("data-status").then((s) => s === "done").catch(() => false), { what: "done marker again", timeout: 5000 });
  await marker.click();
  // v3.1: "Looks good" sends accept through Caddy and the hub SSO, then marks the pin seen.
  await page.locator('on-spot button[title="Accept this change"]').click();
  await marker.waitFor({ state: "detached", timeout: 5000 });
  const accepted = await until(async () => (await api("GET", `/pins/${pin.id}`)).data.pin.acceptedAt, { what: "acceptedAt", timeout: 5000 }).catch(() => null);
  if (start.isError || reply.isError || done.isError) bad(`MCP errors: ${start.text} / ${reply.text} / ${done.text}`);
  else if (!accepted) bad(`live: "Looks good" did not reach the server (acceptedAt is null)`);
  else ok(`live after ${idleMs / 1000}s idle: working in ${tWorking} ms, reply shown, done in ${tDone} ms with a toast; "Not right" requeued it; "Looks good" accepted it and removed the marker`);
}

async function anonymous(launch, browser) {
  const { ctx, close } = await launch({ auth: false });
  try {
    const page = await ctx.newPage();
    await page.goto("https://crm.koglabs.com/", { waitUntil: "load" });
    await page.locator("on-spot .capsule").waitFor({ state: "visible", timeout: 15000 });
    await until(() => page.locator("on-spot .connection").getAttribute("data-state").then((s) => s === "login"), { what: "login state", timeout: 15000 });
    await page.locator("on-spot .menu-button").click();
    const login = await page.locator("on-spot .login").getAttribute("href");
    if (!login?.startsWith(`${LOGIN_URL}?next=`)) bad(`${browser} signed out: login link ${login}`);
    else ok(`${browser} signed out: state login, the menu offers "Log in"`);
  } catch (error) {
    bad(`${browser} signed out: ${error.message.split("\n")[0]}`);
  } finally {
    await close();
  }
}

async function run(browser, launch) {
  console.log(`${browser}:`);
  const { ctx, close } = await launch({ auth: true });
  try {
    const results = [];
    for (const url of urls) results.push(await pinOn(ctx, url, browser));
    const first = results.find(Boolean);
    if (first) await liveUpdates(first.page, first.pin, { idleMs: IDLE_MS }).catch(async (e) => {
      const state = await first.page.locator("on-spot").evaluate((host) => ({
        markers: [...host.shadowRoot.querySelectorAll(".marker")].map((node) => `${node.dataset.pin}:${node.dataset.status}`),
        connection: host.shadowRoot.querySelector(".connection")?.dataset.state, url: location.href,
      })).catch((error) => error.message.split("\n")[0]);
      await first.page.screenshot({ path: `/tmp/onspot-e2e-${browser}-live.png` }).catch(() => {});
      bad(`live: ${e.message.split("\n")[0]} · page state ${JSON.stringify(state)}`);
    });
    for (const r of results) await r?.page.close();
  } finally {
    await close();
  }
  await anonymous(launch, browser);
}

// The test pins must not start real fix runs: switch auto-fix off and restore it after.
const before = (await api("GET", "/settings")).data?.autofix;
if (typeof before !== "boolean") throw new Error("cannot read the auto-fix setting; nothing was changed");
const cleanup = cleanupOnExit(async () => {
  const { left, restored } = await endRun(TAG, { autofix: before });
  if (left === null || left.length) { failed++; console.error(`TEST PINS LEFT${left ? `: ${left.map((id) => `#${id}`).join(" ")}` : ""}. Delete each pin whose note starts with ${TAG}.`); }
  if (!restored) { failed++; console.error(`AUTO-FIX IS NOT RESTORED. Set it back by hand: it was ${before ? "on" : "off"}.`); }
  console.log(`${failed ? "FAIL" : "PASS"}: ${failed} failures; auto-fix is ${restored ? (before ? "on" : "off") : "unknown"}`);
});
try {
  if ((await api("PATCH", "/settings", { autofix: false })).data?.autofix !== false) throw new Error("cannot switch auto-fix off; no test pin was made");
  const launchers = {
    chrome: (o) => launchChrome(path.join(dist, "chrome"), o),
    firefox: (o) => launchFirefox(path.join(dist, "firefox"), o),
    brave: (o) => launchChrome(path.join(dist, "chrome"), { ...o, executablePath: BRAVE }),
  };
  for (const browser of BROWSERS) if (which === "all" || which === browser) await run(browser, launchers[browser]);
} catch (error) {
  failed++;
  console.error(`  FAIL ${error.message.split("\n")[0]}`);
} finally {
  await cleanup();
  if (failed) process.exitCode = 1;
}
