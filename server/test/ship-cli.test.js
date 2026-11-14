// `pins ship` through the real CLI: real git, a real pins server, and fake gh and proj programs on PATH.
// The module's own cases are in ship.test.js; this file proves that the CLI wires it (API shape, exit code, after shot).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";

const bin = fileURLToPath(new URL("../bin/pins.js", import.meta.url));
const run = promisify(execFile);
const git = async (repo, ...args) => (await run("git", ["-C", repo, ...args])).stdout.trim();

const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const git = (...a) => execFileSync("git", ["-C", process.env.FAKE_MERGER, ...a], { encoding: "utf8" }).trim();
const flag = (name) => args[args.indexOf(name) + 1];
const value = (name) => args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
const byNumber = () => state.prs.find((p) => p.number === Number(args[2]));
if (args[1] === "list") {
  const pr = state.prs.filter((p) => p.head === flag("--head")).at(-1);
  console.log(JSON.stringify(pr ? [{ number: pr.number, state: pr.state, headRefOid: pr.headRefOid ?? null }] : []));
} else if (args[1] === "create") {
  const pr = { number: state.prs.length + 1, head: flag("--head"), state: "OPEN", title: value("--title"), body: value("--body") };
  state.prs.push(pr);
  console.log("https://github.com/jstadev/demo/pull/" + pr.number);
} else if (args[1] === "merge") {
  const pr = byNumber();
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-B", "main", "origin/main");
  pr.headRefOid = git("rev-parse", "origin/" + pr.head);
  git("merge", "-q", "--squash", "origin/" + pr.head);
  git("commit", "-q", "-m", pr.title + " (#" + pr.number + ")");
  git("push", "-q", "origin", "main");
  git("push", "-q", "origin", "--delete", pr.head);
  pr.mergeCommit = git("rev-parse", "HEAD");
  pr.state = "MERGED";
} else if (args[1] === "view") {
  const pr = byNumber();
  console.log(JSON.stringify({ state: pr.state, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null }));
} else {
  console.error("fake gh: unknown " + args.join(" "));
  process.exit(1);
}
fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
`;
const FAKE_PROJ = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PROJ_LOG, args.join(" ") + "\\n");
if (args[0] !== "release" || args[2] !== "staging") process.exit(9);
console.log("staging: v0.1.1 at 0123456789ab");
console.log(args[1] + ": staging runs v0.1.1 (0123456789ab)");
`;

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pins-ship-cli-"));
  const [origin, main, wt, merger, fakes] = ["origin.git", "main", "wt", "merger", "bin"].map((name) => join(root, name));
  const store = openStore({ file: ":memory:", shotsDir: join(root, "shots") });
  const app = createApp({ store, version: "test" });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "init", "-q", "-b", "main", main);
  await git(main, "config", "user.name", "Test");
  await git(main, "config", "user.email", "test@example.com");
  mkdirSync(join(main, "deploy"));
  writeFileSync(join(main, "deploy/project.json"), JSON.stringify({
    key: "demo", repo: "jstadev/demo", release: { build: null, test: "grep -q two app.txt" }, channels: { staging: { domains: ["demo.koglabs.com"] } },
  }));
  writeFileSync(join(main, "app.txt"), "one\ntwo\n");
  await git(main, "add", ".");
  await git(main, "commit", "-q", "-m", "init");
  await git(main, "remote", "add", "origin", origin);
  await git(main, "push", "-q", "-u", "origin", "main");
  await git(main, "worktree", "add", "-q", "-b", "pin1", wt);
  await git(root, "clone", "-q", origin, merger);
  await git(merger, "config", "user.name", "GitHub");
  await git(merger, "config", "user.email", "gh@example.com");
  mkdirSync(fakes);
  for (const [name, text] of [["gh", FAKE_GH], ["proj", FAKE_PROJ]]) {
    writeFileSync(join(fakes, name), text);
    chmodSync(join(fakes, name), 0o755);
  }
  const stateFile = join(root, "gh.json"), projLog = join(root, "proj.log");
  writeFileSync(stateFile, JSON.stringify({ prs: [] }));
  writeFileSync(projLog, "");
  const env = {
    PATH: `${fakes}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, PINS_PORT: String(server.address().port), PINS_AGENT: "claude",
    PINS_LOCK_DIR: join(root, "locks"), PINS_FACTS_DIR: join(root, "facts"), PLAYWRIGHT_CORE: join(root, "no-playwright.mjs"),
    FAKE_STATE: stateFile, FAKE_MERGER: merger, FAKE_PROJ_LOG: projLog,
  };
  const cli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const pin = store.createPin({ url: "https://demo.koglabs.com/", title: "Demo", note: "Change two", targets: [{ selector: "h1", label: 'h1 "Demo"' }] });
  return { store, pin, origin, main, wt, cli, projLog, stateFile };
}

test("pins ship through the CLI: commit, gate, merge, release to staging, close the pin, remove the worktree", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const id = String(f.pin.id);
  f.store.transition(f.pin.id, "start", { agent: "claude", kind: "agent", run: "triad:1" });
  writeFileSync(join(f.wt, "app.txt"), "one\ntwo\nthree\n");
  const result = await f.cli(["ship", id, "--dir", f.wt, "--summary", "The list has a third line", "app.txt"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  for (const [index, pattern] of [/^Gate passes \(\d+ s\)$/, /^Merged [0-9a-f]{7}$/, /^Live on staging v0\.1\.1$/, /^after shot failed: /, new RegExp(`^#${id} done · [0-9a-f]{7} · https://demo\\.koglabs\\.com$`)].entries()) {
    const at = lines.findIndex((line) => pattern.test(line));
    assert.ok(at >= 0, `missing line ${pattern}: ${result.stdout}`);
    if (index) assert.ok(at > lines.findIndex((line) => /^Gate passes/.test(line)), "the gate comes first");
  }
  const merge = await git(f.origin, "rev-parse", "main");
  const pin = f.store.getPin(f.pin.id);
  assert.deepEqual([pin.status, pin.commit, pin.summary, pin.agent], ["done", merge, "The list has a third line", "claude"]);
  assert.equal(await git(f.origin, "show", "main:app.txt"), "one\ntwo\nthree");
  assert.equal(readFileSync(f.projLog, "utf8"), "release demo staging\n", "one release, to staging only");
  assert.equal(existsSync(f.wt), false, "the worktree is gone");
  // A second run has nothing to do: the pin is done.
  const again = await f.cli(["ship", id, "--dir", f.main, "--summary", "x", "app.txt"]);
  assert.equal(again.code, 1);
  assert.equal(readFileSync(f.projLog, "utf8"), "release demo staging\n");
});

test("pins ship through the CLI: a failed gate exits 1, pushes nothing and leaves the pin working; bad usage exits 2", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const id = String(f.pin.id);
  f.store.transition(f.pin.id, "start", { agent: "claude", kind: "agent", run: "triad:1" });
  writeFileSync(join(f.wt, "app.txt"), "one\n");
  const failed = await f.cli(["ship", id, "--dir", f.wt, "--summary", "Shorter list", "app.txt"]);
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /^ship stopped at gate: release\.test exited 1$/m);
  assert.match(failed.stdout, /^Fix it and run the same command again\.$/m);
  assert.equal(f.store.getPin(f.pin.id).status, "working");
  assert.equal(JSON.parse(readFileSync(f.stateFile, "utf8")).prs.length, 0, "no PR");
  assert.equal(readFileSync(f.projLog, "utf8"), "", "no release");
  for (const args of [["ship"], ["ship", id], ["ship", id, "app.txt"], ["ship", id, "--dir", f.wt, "app.txt"], ["ship", id, "--dir", "wt", "--summary", "x", "app.txt"],
    ["ship", "0", "--dir", f.wt, "--summary", "x", "app.txt"], ["ship", id, "--dir", f.wt, "--summary", "x", "--message", "x".repeat(4001), "app.txt"]]) {
    const usage = await f.cli(args);
    assert.equal(usage.code, 2, args.join(" "));
    assert.match(usage.stderr, /pins ship <id> --dir <worktree> --summary/);
  }
});
