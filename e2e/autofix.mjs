// Live check of the whole loop: a pin submitted from the real extension ("Submit all") starts
// a fix run at once, and the run closes the pin. The note asks for no change, so the run must
// dismiss it. Costs one short Claude session (Opus 5.5, high). Usage: node e2e/autofix.mjs [url]
// The end, Ctrl+C, a kill signal and an error all close the browser and delete the test pin.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, cleanupOnExit, endRun, launchChrome, until } from "./lib.mjs";

const url = process.argv[2] || "https://koglabs.com/";
const host = new URL(url).host;
const ext = path.join(fileURLToPath(new URL("../extension/dist/", import.meta.url)), "chrome");
const t0 = Date.now();
const since = () => `${Math.round((Date.now() - t0) / 1000)}s`;

// The note starts with this tag, so the cleanup finds the pin also when the run lost track of it.
const TAG = `e2e-autofix-${Date.now().toString(36)}-${process.pid}`;

if (!(await api("GET", "/settings")).data?.autofix) throw new Error("auto-fix is off; switch it on first");
// Registered before the browser starts: a signal during the start must still close it.
const cleanup = cleanupOnExit(async () => {
  const { left } = await endRun(TAG);
  if (left === null || left.length) throw new Error(`test pins left${left ? `: ${left.map((id) => `#${id}`).join(" ")}` : ""}. Delete each pin whose note starts with ${TAG}.`);
});
try {
  const { ctx } = await launchChrome(ext);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.locator("on-spot .pin-button").click();
  const box = await page.locator("h1, h2").filter({ visible: true }).first().boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  const note = `${TAG} OnSpot auto-fix check: this is a test pin. Dismiss it and change nothing.`;
  await page.locator('on-spot textarea[name="pin-note"]').fill(note);
  await page.locator('on-spot textarea[name="pin-note"]').press("Control+Enter"); // add and submit all
  const pin = await until(async () => (await api("GET", `/pins?host=${host}&status=all&q=${encodeURIComponent(TAG)}`)).data.pins[0], { what: "the pin" });
  const id = pin.id;
  console.log(`${since()} pin #${id} queued`);
  const working = await until(async () => {
    const p = (await api("GET", `/pins/${id}`)).data.pin;
    return p.status !== "queued" && p;
  }, { what: "auto start", timeout: 120000, every: 1000 });
  console.log(`${since()} pin #${id} ${working.status}, agent ${working.agent}, model ${working.model}, run ${working.run}`);
  const marker = page.locator(`on-spot .marker[data-pin="${id}"]`);
  console.log(`${since()} marker on the page: ${await marker.getAttribute("data-status").catch(() => "gone")}`);
  const end = await until(async () => {
    const p = (await api("GET", `/pins/${id}`)).data;
    return !["queued", "working"].includes(p.pin.status) && p;
  }, { what: "the run to close the pin", timeout: 20 * 60000, every: 5000 });
  console.log(`${since()} pin #${id} ${end.pin.status}: ${end.pin.summary ?? ""}`);
  for (const r of end.replies) console.log(`  ${r.kind} ${r.author}: ${r.body.slice(0, 160)}`);
  process.exitCode = end.pin.status === "dismissed" ? 0 : 1;
} finally {
  await cleanup();
}
