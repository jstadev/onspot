import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { createMcpHandler } from "./mcp.js";
import { openStore } from "./store.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// The extension shows "Update" when the build on this server is newer than itself.
const extension = JSON.parse(readFileSync(new URL("../../extension/package.json", import.meta.url), "utf8")).version;
// A bad setting stops the start with one line. An empty variable counts as not set.
function fail(message) {
  console.error(`pins: ${message}`);
  process.exit(1);
}
const port = Number(process.env.PORT || 4750);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail("PORT must be an integer from 0 to 65535");
// Where "/" sends a browser: the queue page (the Pins tab in the Triad console).
const queueUrl = process.env.PINS_QUEUE_URL || "https://ai.koglabs.com/triad?tab=pins";
if (!/^https?:$/.test(URL.parse(queueUrl)?.protocol ?? "")) fail("PINS_QUEUE_URL must be an http or https URL");
const store = openStore({
  file: process.env.PINS_DB || resolve(root, "data/pins.db"),
  rootDomain: process.env.PINS_ROOT_DOMAIN || "koglabs.com",
  shotsDir: process.env.PINS_SHOTS_DIR || undefined,
  imagesDir: process.env.PINS_IMAGES_DIR || undefined,
});
// Old shot and image files go at start and once a day. A failed cleanup must not stop the server.
function pruneShots() {
  for (const [what, prune] of [["shot", store.pruneShots], ["image", store.pruneImages]]) {
    try { prune(); }
    catch (error) { console.error(`pins: ${what} cleanup failed: ${String(error?.message ?? error).replace(/[\r\n]+/g, " ")}`); }
  }
}
pruneShots();
setInterval(pruneShots, 24 * 60 * 60 * 1000).unref();
const app = createApp({
  store, version, extension, queueUrl,
  downloadDir: process.env.PINS_DOWNLOAD_DIR || resolve(root, "extension/dist"),
  mcpHandler: createMcpHandler({ store, version }),
});
const server = createServer(app);
server.listen(port, "127.0.0.1", () => console.log(`OnSpot ${version} listening on http://127.0.0.1:${server.address().port}`));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  app.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Do not leave shutdown waiting for an incomplete request or a long MCP wait.
  server.closeAllConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
