import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pins-static-"));
  const downloadDir = join(dir, "dist");
  await mkdir(downloadDir);
  const store = openStore({ file: ":memory:" });
  const app = createApp({ store, version: "test", downloadDir });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  function request(path, { headers = {}, method = "GET" } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path, method, headers, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  return { dir, downloadDir, request };
}

test("the old queue page address redirects to the Triad Pins tab and keeps a valid host", async (t) => {
  const { request } = await fixture(t);
  const cases = {
    "/": "https://ai.koglabs.com/triad?tab=pins",
    "/?host=crete.koglabs.com": "https://ai.koglabs.com/triad?tab=pins&host=crete.koglabs.com",
    "/?host=localhost:5173": "https://ai.koglabs.com/triad?tab=pins&host=localhost%3A5173",
    "/?host=%22%3E%3Cscript%3E": "https://ai.koglabs.com/triad?tab=pins",
    "/?host=evil.example%2F%2Fx": "https://ai.koglabs.com/triad?tab=pins",
  };
  for (const [path, location] of Object.entries(cases)) {
    const response = await request(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.location, location, path);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const wrong = await request("/", { method: "POST" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, "GET");
  assert.equal((await request("/", { headers: { Origin: "https://ai.koglabs.com" } })).status, 403);
  assert.equal((await request("/", { headers: { Host: "attacker.example" } })).status, 403);
});

test("no other path serves a file: traversal, dotfiles, the old page files and bad escapes", async (t) => {
  const { request, dir, downloadDir } = await fixture(t);
  await writeFile(join(dir, "package.json"), "OUTSIDE SECRET");
  await writeFile(join(downloadDir, ".env"), "DOTFILE SECRET");
  await symlink(join(dir, "package.json"), join(downloadDir, "escape.zip"));
  for (const path of [
    "/index.html", "/app.js", "/app.css", "/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/%00", "/%",
    "/%5c..%5cpackage.json", "/download/../../package.json", "/%252e%252e/package.json",
    "/download/.env", "/download/%2eenv", "/download/escape.zip", "//package.json", "/missing",
  ]) {
    const response = await request(path);
    assert.ok([400, 404].includes(response.status), `${path}: ${response.status}`);
    assert.ok(!response.body.toString().includes("SECRET"));
  }
});

test("only the two extension downloads are served with ZIP type and attachment headers", async (t) => {
  const { request, downloadDir } = await fixture(t);
  assert.equal((await request("/download/onspot-chrome.zip")).status, 404);
  assert.equal((await request("/download/onspot-firefox.zip")).status, 404);
  for (const browser of ["chrome", "firefox"]) {
    const name = `onspot-${browser}.zip`;
    const bytes = Buffer.from(`PK\u0003\u0004${browser}`);
    await writeFile(join(downloadDir, name), bytes);
    const response = await request(`/download/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "application/zip");
    assert.equal(response.headers["content-disposition"], `attachment; filename="${name}"`);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["cache-control"], "no-cache");
    assert.deepEqual(response.body, bytes);
    const wrong = await request(`/download/${name}`, { method: "POST" });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, "GET");
  }
  await writeFile(join(downloadDir, "other.zip"), "Not allowed");
  for (const path of ["/download/other.zip", "/download/", "/download/../package.json", "/download/onspot-chrome.zip/extra"]) {
    assert.equal((await request(path)).status, 404, path);
  }
});
