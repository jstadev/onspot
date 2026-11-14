import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/projects.js";

async function tree(t) {
  const root = await mkdtemp(join(tmpdir(), "pins-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    async project(name, meta = {}, files = {}) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "project.json"), JSON.stringify({ name, status: "active", dirs: [], urls: [], ...meta }));
      for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
      return dir;
    },
  };
}

test("same host, longest segment prefix, active first, stable candidate order", async (t) => {
  const { root, project } = await tree(t);
  await project("hub", { urls: ["https://ai.koglabs.com/"] });
  await project("pins-retired", { status: "dormant", urls: ["https://ai.koglabs.com/pins"] });
  await project("pins", { urls: ["https://ai.koglabs.com/pins/"] });
  await project("other-host", { urls: ["https://elsewhere.koglabs.com/pins/deeper/"] });
  const result = await resolveProject("AI.KOGLABS.COM", "/pins/deeper/page", { root });
  assert.deepEqual(result, { name: "pins", dir: null, candidates: ["pins", "pins-retired", "hub"] });
  assert.equal((await resolveProject("ai.koglabs.com", "/pinstripe", { root })).name, "hub");
  assert.equal((await resolveProject("ai.koglabs.com", "/pins", { root })).name, "pins");
  assert.equal((await resolveProject("ai.koglabs.com:8443", "/pins", { root })).name, null);
});

test("first existing directory wins; missing paths and regular files do not become cwd", async (t) => {
  const { root, project } = await tree(t);
  const first = join(root, "first"), second = join(root, "second"), file = join(root, "file");
  await mkdir(first); await mkdir(second); await writeFile(file, "not a directory");
  await project("app", { urls: ["https://app.koglabs.com"], dirs: [join(root, "missing"), file, first, second] });
  assert.equal((await resolveProject("app.koglabs.com", "/", { root })).dir, first);
  await project("gone", { urls: ["https://gone.koglabs.com"], dirs: [join(root, "missing")] });
  // A separate root read sees the metadata added after the cached scan.
  assert.equal((await resolveProject("gone.koglabs.com", "/", { root: `${root}/.` })).dir, null);
});

test("fallback reads MEMORY.md and state.md, prefers active, and avoids unrelated host substrings", async (t) => {
  const { root, project } = await tree(t);
  await project("old", { status: "dormant" }, { "MEMORY.md": "https://site.koglabs.com/" });
  await project("site", {}, { "state.md": "Live at site.koglabs.com. Product online." });
  await project("wrong", {}, { "MEMORY.md": "https://notsite.koglabs.com/ https://site.koglabs.com.evil/" });
  assert.deepEqual(await resolveProject("site.koglabs.com", "/", { root }), { name: "site", dir: null, candidates: ["site", "old"] });
  assert.deepEqual(await resolveProject("unknown.koglabs.com", "/", { root }), { name: null, dir: null, candidates: [] });
});

test("legacy projects work without project.json and broken metadata does not stop the scan", async (t) => {
  const { root, project } = await tree(t);
  const legacy = await project("legacy", {}, { "MEMORY.md": "legacy.koglabs.com" });
  await rm(join(legacy, "project.json"));
  const broken = await project("broken", {}, { "state.md": "broken.koglabs.com" });
  await writeFile(join(broken, "project.json"), "invalid JSON");
  assert.equal((await resolveProject("legacy.koglabs.com", "/", { root })).name, "legacy");
  assert.equal((await resolveProject("broken.koglabs.com", "/", { root })).name, "broken");
  assert.deepEqual(await resolveProject("none", "/", { root: join(root, "absent") }), { name: null, dir: null, candidates: [] });
});

test("metadata scan stays cached for 60 seconds then refreshes", async (t) => {
  const { root, project } = await tree(t);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  await project("first", { urls: ["https://app.koglabs.com/"] });
  assert.equal((await resolveProject("app.koglabs.com", "/pins", { root })).name, "first");
  await project("specific", { urls: ["https://app.koglabs.com/pins"] });
  now += 59_999;
  assert.equal((await resolveProject("app.koglabs.com", "/pins", { root })).name, "first");
  now++;
  assert.equal((await resolveProject("app.koglabs.com", "/pins", { root })).name, "specific");
});

test("a host never matches a longer or a shorter host, by URL or by mention", async (t) => {
  const { root, project } = await tree(t);
  await project("short", { urls: ["https://koglabs.com/"] }, { "MEMORY.md": "koglabs.com" });
  await project("app", { urls: ["https://app.koglabs.com/"] });
  await project("deep", {}, { "state.md": "Runs at my.app.koglabs.com and at app.koglabs.com.evil.example." });
  assert.equal((await resolveProject("app.koglabs.com", "/", { root })).name, "app");
  assert.deepEqual((await resolveProject("my.app.koglabs.com", "/", { root })).candidates, ["deep"]);
  assert.deepEqual((await resolveProject("x.koglabs.com", "/", { root })).candidates, [], "koglabs.com in a text is not x.koglabs.com");
  assert.equal((await resolveProject("koglabs.com", "/", { root })).name, "short");
});
