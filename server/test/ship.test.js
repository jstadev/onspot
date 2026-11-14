import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { run, ship, takeLane } from "../src/ship.js";

const NODE_DIR = dirname(process.execPath);

async function git(cwd, ...args) {
  const result = await run("git", ["-C", cwd, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

// A bare origin, a main clone with the manifest, a worktree wt on pin12, and a clone that does the fake GitHub merges.
async function fixture(t, { manifest: edit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pins-ship-"));
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const wt = join(root, "wt");
  const merger = join(root, "merger");
  const lockDir = join(root, "locks");
  const failFlag = join(root, "fail");
  const manifest = {
    key: "demo",
    repo: "jstadev/demo",
    release: { build: null, test: `test "\${PATH%%:*}" = ${NODE_DIR} || { echo "wrong PATH $PATH"; exit 9; }; if test -e ${failFlag}; then echo "check failed: app is broken"; exit 1; fi` },
    runtime: { node: NODE_DIR },
    channels: { staging: { domains: ["demo.koglabs.com"] } },
  };
  edit?.(manifest);
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "init", "-q", "-b", "main", main);
  for (const repo of [main]) {
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "user.email", "test@example.com");
  }
  mkdirSync(join(main, "deploy"));
  mkdirSync(join(main, "config"));
  writeFileSync(join(main, "deploy/project.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(main, "app.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(main, "other.txt"), "x\n");
  writeFileSync(join(main, "config/site.txt"), "y\n");
  await git(main, "add", ".");
  await git(main, "commit", "-q", "-m", "init");
  await git(main, "remote", "add", "origin", origin);
  await git(main, "push", "-q", "-u", "origin", "main");
  await git(main, "worktree", "add", "-q", "-b", "pin12", wt);
  await git(root, "clone", "-q", origin, merger);
  await git(merger, "config", "user.name", "GitHub");
  await git(merger, "config", "user.email", "gh@example.com");
  const start = await git(origin, "rev-parse", "main");

  const pin = { id: 12, status: "working", url: "https://demo.koglabs.com/", targets: [{ selector: "h1", label: "h1" }] };
  const calls = [];
  const prs = [];
  const gets = [];
  const posts = [];
  const lines = [];
  const state = { projFails: 0, version: 0, shot: { ok: true, text: 'found h1 "Demo" 200x40 · color rgb(255, 0, 0)' } };

  async function fakeGh(args) {
    const flag = (name) => args[args.indexOf(name) + 1];
    const value = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
    const byNumber = () => prs.find((p) => p.number === Number(args[2]));
    if (args[1] === "list") {
      const pr = prs.filter((p) => p.head === flag("--head")).at(-1);
      return ok(JSON.stringify(pr ? [{ number: pr.number, state: pr.state, headRefOid: pr.headRefOid ?? null }] : []));
    }
    if (args[1] === "create") {
      const pr = { number: prs.length + 1, head: flag("--head"), base: flag("--base"), state: "OPEN", title: value("--title"), body: value("--body") };
      prs.push(pr);
      return ok(`https://github.com/jstadev/demo/pull/${pr.number}\n`);
    }
    if (args[1] === "merge") {
      const pr = byNumber();
      await git(merger, "fetch", "-q", "origin");
      await git(merger, "checkout", "-q", "-B", "main", "origin/main");
      pr.headRefOid = await git(merger, "rev-parse", `origin/${pr.head}`);
      await git(merger, "merge", "-q", "--squash", `origin/${pr.head}`);
      await git(merger, "commit", "-q", "-m", `${pr.title} (#${pr.number})`);
      await git(merger, "push", "-q", "origin", "main");
      await git(merger, "push", "-q", "origin", "--delete", pr.head);
      pr.mergeCommit = await git(merger, "rev-parse", "HEAD");
      pr.state = "MERGED";
      return ok("");
    }
    if (args[1] === "view") {
      const pr = byNumber();
      return ok(JSON.stringify({ state: pr.state, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null }));
    }
    return { code: 1, stdout: "", stderr: `fake gh: unknown ${args.join(" ")}` };
  }

  async function fakeProj(args) {
    if (state.projFails > 0) {
      state.projFails--;
      return { code: 1, stdout: "", stderr: "proj: demo staging v0.1.1 failed: health 502 at http://127.0.0.1:1/" };
    }
    const sha = await git(origin, "rev-parse", "main");
    state.version++;
    return ok(`${args[1]}: staging runs v0.1.${state.version} (${sha.slice(0, 12)})\n`);
  }

  const exec = async (file, args, options) => {
    calls.push({ file, args });
    if (file === "gh") return fakeGh(args);
    if (file === "proj") return fakeProj(args);
    return run(file, args, options);
  };
  const api = {
    get: async (path) => { gets.push(path); return { pin: { ...pin } }; },
    post: async (path, body) => {
      posts.push({ path, body });
      if (path.endsWith("/resolve")) pin.status = "done";
      return {};
    },
  };

  const go = (input = {}, deps = {}) => ship(
    { id: "12", dir: wt, summary: "Make the title red", paths: ["app.txt"], ...input },
    { api, exec, lockDir, out: (line) => lines.push(line), snapAfter: async () => state.shot, sleep: async () => {}, ...deps },
  );
  const write = (file, text) => writeFileSync(join(wt, file), text);
  const projCalls = () => calls.filter((c) => c.file === "proj");
  const gitCalls = (sub) => calls.filter((c) => c.file === "git" && c.args.includes(sub));
  const originFile = (file) => git(origin, "show", `main:${file}`);
  const resolved = () => posts.filter((p) => p.path === "/pins/12/resolve");
  const text = () => lines.join("\n");

  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const call of projCalls()) assert.ok(!call.args.includes("prod"), `proj called with prod: ${call.args.join(" ")}`);
  });
  return { root, origin, main, wt, merger, lockDir, failFlag, start, pin, calls, prs, gets, posts, lines, state, go, write, projCalls, gitCalls, originFile, resolved, text };
}

// Each expected start appears in this order in the lines.
function inOrder(lines, starts) {
  let at = 0;
  for (const start of starts) {
    const found = lines.findIndex((line, i) => i >= at && line.startsWith(start));
    assert.ok(found >= 0, `missing "${start}" after line ${at} in:\n${lines.join("\n")}`);
    at = found + 1;
  }
}

test("(a) happy path: commit, gate, merge, staging, check, close and clean up", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go(), 0, f.text());
  const [pr] = f.prs;
  assert.deepEqual(f.resolved().map((p) => p.body), [{ summary: "Make the title red", commit: pr.mergeCommit }]);
  inOrder(f.lines, ["Branch pin12, paths: 1", "Pin #12 is working", "Project demo (jstadev/demo), staging demo.koglabs.com", "Commit ",
    "No open PR yet", "Base is origin/main", "Gate passes (", `Merged ${pr.mergeCommit.slice(0, 7)}`, "Live on staging v0.1.1",
    'found h1 "Demo"', `#12 done · ${pr.mergeCommit.slice(0, 7)} · https://demo.koglabs.com`]);
  assert.ok(!f.lines.some((line) => line.startsWith("Note:")), f.text());
  assert.equal(await f.originFile("app.txt"), "one\nTWO\nthree");
  assert.equal(await git(f.origin, "rev-parse", "main"), pr.mergeCommit);
  assert.deepEqual({ title: pr.title, body: pr.body, base: pr.base }, { title: "Pin #12: Make the title red", body: "OnSpot pin #12.\n\nMake the title red", base: "main" });
  assert.equal(existsSync(f.wt), false);
  assert.equal(await git(f.main, "branch", "--list", "pin12"), "");
  assert.deepEqual(readdirSync(f.lockDir), [], "no lock and no marker is left");
  assert.deepEqual(f.posts.filter((p) => p.path.endsWith("/progress")).map((p) => p.body.text.split(" (")[0]),
    ["Gate passes", `Merged ${pr.mergeCommit.slice(0, 7)}`, "Live on staging v0.1.1"]);
  const push = f.gitCalls("push")[0].args;
  assert.deepEqual(push.slice(2, 6), ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]);
  assert.deepEqual(f.projCalls().map((c) => c.args), [["release", "demo", "staging"]]);
});

test("(a2) a revert that deletes a file and its folder ships: git revert stages the deletion, ship commits it", async (t) => {
  const f = await fixture(t);
  // An earlier pin added a file in a new folder and changed app.txt; it is on main.
  mkdirSync(join(f.main, "parts"));
  writeFileSync(join(f.main, "parts/badge.txt"), "badge\n");
  writeFileSync(join(f.main, "app.txt"), "one\nTWO\nthree\n");
  await git(f.main, "add", ".");
  await git(f.main, "commit", "-q", "-m", "Pin #11: badge");
  const fix = await git(f.main, "rev-parse", "HEAD");
  await git(f.main, "push", "-q", "origin", "main");
  await git(f.wt, "fetch", "-q", "origin");
  await git(f.wt, "reset", "-q", "--hard", "origin/main");
  await git(f.wt, "revert", "--no-commit", fix);
  assert.equal(existsSync(join(f.wt, "parts")), false, "the folder is gone with its only file");
  assert.equal(await f.go({ summary: "Back to the page before pin #11", message: "Revert pin #12: badge", paths: ["app.txt", "parts/badge.txt"] }), 0, f.text());
  const [pr] = f.prs;
  assert.equal(pr.title, "Revert pin #12: badge");
  assert.equal(await f.originFile("app.txt"), "one\ntwo\nthree");
  assert.notEqual((await run("git", ["-C", f.origin, "cat-file", "-e", "main:parts/badge.txt"])).code, 0, "the file is gone on main");
  assert.deepEqual(f.resolved().map((p) => p.body), [{ summary: "Back to the page before pin #11", commit: pr.mergeCommit }]);
});

test("(a3) a path that is in no worktree, no index and no commit stops the commit step with the git error", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go({ paths: ["app.txt", "missing.txt"] }), 1);
  assert.match(f.text(), /ship stopped at commit: git commit exited/);
  assert.equal(f.prs.length, 0);
});

test("(b) a failing release.test stops at the gate: nothing pushed, no release, no resolve", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.failFlag, "");
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go(), 1);
  inOrder(f.lines, ["ship stopped at gate: release.test exited 1", "check failed: app is broken", "Fix it and run the same command again."]);
  assert.equal(f.lines.at(-1), "Fix it and run the same command again.");
  assert.equal((await run("git", ["-C", f.origin, "rev-parse", "--verify", "-q", "refs/heads/pin12"])).code, 1);
  assert.equal(await git(f.origin, "rev-parse", "main"), f.start);
  assert.equal(f.gitCalls("push").length, 0);
  assert.equal(f.projCalls().length, 0);
  assert.equal(f.resolved().length, 0);
  assert.deepEqual(readdirSync(f.lockDir), [], "the gate lock is removed after a failure");
});

test("(c) the same command after the fix passes with one commit and one PR", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.failFlag, "");
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go(), 1);
  rmSync(f.failFlag);
  f.lines.length = 0;
  assert.equal(await f.go(), 0, f.text());
  assert.ok(f.lines.some((line) => line.startsWith("No new changes, HEAD ")), f.text());
  assert.equal(f.gitCalls("commit").length, 1);
  assert.equal(f.prs.length, 1);
  assert.equal(await git(f.origin, "rev-list", "--count", `${f.start}..main`), "1");
  assert.equal(f.resolved().length, 1);
});

test("(d) a changed tracked file that is not in the list stops at the commit step", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  f.write("other.txt", "changed\n");
  assert.equal(await f.go(), 1);
  inOrder(f.lines, ["ship stopped at commit: changed but not in the commit: add them to the command or restore them", " M other.txt"]);
  assert.equal(f.gitCalls("push").length, 0);
  assert.equal(f.calls.filter((c) => c.file === "gh").length, 0);
});

test("(e) refused paths and a main checkout stop at validate before any git write or API call", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  // A folder link that leaves the worktree, and one that stays inside it.
  mkdirSync(join(f.root, "outside"));
  writeFileSync(join(f.root, "outside/passwd"), "x\n");
  symlinkSync(join(f.root, "outside"), join(f.wt, "link"));
  symlinkSync("config", join(f.wt, "alias"));
  const refused = [".env", "deploy/.env.local", "a/.git/x", "../x", "x/../../y", ".github/workflows/ci.yml", "infra/x", "keys/server.pem",
    "id.key", "src/secrets.js", "config", "/etc/passwd", "",
    "./.env", "a/./../.ENV", ".GitHub/workflows/ci.yml", ".github/WORKFLOWS/ci.yml", "./.github//workflows/ci.yml", "INFRA/x.tf", "Infra/x.tf",
    "a/.GIT/config", "keys/SERVER.PEM", "src/My_Secrets.js", "link/passwd", "link/new.txt", "alias/site.txt"];
  for (const path of refused) {
    f.lines.length = 0;
    assert.equal(await f.go({ paths: ["app.txt", path] }), 1, path);
    assert.match(f.lines[0], /^ship stopped at validate: /, path);
  }
  for (const input of [{ paths: [] }, { paths: Array(51).fill("app.txt") }, { id: "0" }, { summary: " " }, { dir: "wt" }, { dir: f.main }]) {
    f.lines.length = 0;
    assert.equal(await f.go(input), 1, JSON.stringify(input).slice(0, 80));
    assert.match(f.lines[0], /^ship stopped at validate: /);
  }
  assert.match(f.text(), /ship needs a pin branch, not main/);
  assert.equal(f.gets.length, 0);
  assert.equal(f.calls.filter((c) => c.args.includes("add") || c.args.includes("commit")).length, 0);
  assert.equal(await git(f.wt, "status", "--porcelain", "--untracked-files=no"), "M app.txt");
});

test("(f) a pin that is not working stops before any git change", async (t) => {
  const f = await fixture(t);
  f.pin.status = "done";
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go(), 1);
  assert.equal(f.lines[1], "ship stopped at pin: pin #12 is done");
  assert.equal(await git(f.wt, "status", "--porcelain"), "M app.txt");
  assert.equal(await git(f.wt, "rev-parse", "HEAD"), f.start);
  assert.equal(f.calls.filter((c) => c.args.includes("add") || c.file !== "git").length, 0);
});

test("(g) a failed element check exits 4 after the release; a fix and the same command then ship a second PR", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  f.state.shot = { ok: false, text: 'found h1 "Demo" 200x40 · color rgb(0, 0, 0)' };
  assert.equal(await f.go(), 4, f.text());
  const merged = f.prs[0].mergeCommit;
  assert.equal(f.lines.at(-1), `The pinned element did not change as the pin asks. Look at the live page. Then fix the change and run ship again, or close with: pins done 12 --summary "..." --commit ${merged}`);
  assert.equal(f.projCalls().length, 1);
  assert.equal(f.resolved().length, 0);
  assert.equal(f.pin.status, "working");
  assert.ok(existsSync(f.wt));

  f.write("app.txt", "one\nRED\nthree\n");
  f.state.shot = { ok: null, text: "element not found, viewport saved" };
  f.lines.length = 0;
  assert.equal(await f.go(), 0, f.text());
  assert.equal(f.prs.length, 2);
  assert.equal(await f.originFile("app.txt"), "one\nRED\nthree");
  assert.deepEqual(f.resolved().map((p) => p.body.commit), [f.prs[1].mergeCommit]);
});

test("(g2) a throwing after shot counts as no verdict and the pin closes", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go({}, { snapAfter: async () => { throw new Error("browser died"); } }), 0, f.text());
  assert.ok(f.lines.includes("after shot failed: browser died"));
  assert.equal(f.resolved().length, 1);
});

test("(h) a live lock makes ship wait and return 3; a lock of a dead process is taken over", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  mkdirSync(f.lockDir);
  const lock = join(f.lockDir, "gate-demo.lock");
  const live = JSON.stringify({ pid: process.pid, pin: 7, at: new Date().toISOString() });
  writeFileSync(lock, live);
  let sleeps = 0;
  assert.equal(await f.go({}, { waitMs: 4000, sleep: async (ms) => { assert.equal(ms, 2000); sleeps++; } }), 3);
  assert.equal(sleeps, 2);
  assert.equal(f.lines.filter((line) => line === "Waiting for the test lane (pin #7 holds it)").length, 1);
  assert.equal(f.lines.at(-1), "The lane is busy. Run the same command again.");
  assert.equal(readFileSync(lock, "utf8"), live, "the lock of a live process stays");
  assert.equal(f.gitCalls("push").length, 0);

  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lock, JSON.stringify({ pid: dead, pin: 7, at: new Date().toISOString() }));
  f.lines.length = 0;
  assert.equal(await f.go({}, { waitMs: 0 }), 0, f.text());
  assert.equal(existsSync(lock), false);
});

test("(i) a manifest without staging stops with the ship by hand text", async (t) => {
  const f = await fixture(t, { manifest: (m) => { m.channels.staging = null; } });
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go(), 1);
  assert.equal(f.lines[2], "ship stopped at manifest: this project has no staging manifest: ship by hand");
  assert.equal(f.calls.filter((c) => c.args.includes("add")).length, 0);
});

test("(j) main moved: a clean rebase ships; a conflict stops and leaves no rebase behind", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.merger, "other.txt"), "from main\n");
  await git(f.merger, "commit", "-q", "-am", "other change");
  await git(f.merger, "push", "-q", "origin", "main");
  f.write("app.txt", "one\nTWO\nthree\n");
  assert.equal(await f.go(), 0, f.text());
  assert.ok(f.lines.some((line) => line.startsWith("Rebased on origin/main: ")), f.text());
  assert.equal(await f.originFile("other.txt"), "from main");
  assert.equal(await f.originFile("app.txt"), "one\nTWO\nthree");

  const g = await fixture(t);
  writeFileSync(join(g.merger, "app.txt"), "one\nMAIN\nthree\n");
  await git(g.merger, "commit", "-q", "-am", "same line");
  await git(g.merger, "push", "-q", "origin", "main");
  g.write("app.txt", "one\nPIN\nthree\n");
  assert.equal(await g.go(), 1);
  assert.ok(g.lines.includes("ship stopped at base: main changed the same lines"), g.text());
  for (const name of ["rebase-merge", "rebase-apply"]) assert.equal(existsSync(await git(g.wt, "rev-parse", "--path-format=absolute", "--git-path", name)), false);
  assert.equal(await git(g.wt, "rev-parse", "--abbrev-ref", "HEAD"), "pin12");
  assert.equal(await git(g.wt, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(g.gitCalls("push").length, 0);
});

test("(k) a PR that is already merged resumes at the release", async (t) => {
  const f = await fixture(t);
  f.write("app.txt", "one\nTWO\nthree\n");
  f.state.projFails = 1;
  assert.equal(await f.go(), 1);
  inOrder(f.lines, ["Merged ", "ship stopped at release: proj release exited 1", "proj: demo staging v0.1.1 failed"]);
  f.lines.length = 0;
  assert.equal(await f.go(), 0, f.text());
  inOrder(f.lines, ["PR #1 is merged already", "Live on staging v0.1.1", "#12 done"]);
  assert.equal(f.gitCalls("push").length, 1);
  assert.equal(f.gitCalls("fetch").length, 1);
  assert.equal(f.prs.length, 1);
  assert.equal(f.projCalls().length, 2);
  assert.deepEqual(f.resolved().map((p) => p.body.commit), [f.prs[0].mergeCommit]);
});

test("run: a non-zero exit, a timeout and a missing program resolve with a code", async () => {
  assert.deepEqual(await run("bash", ["-c", "echo hi; exit 3"]), { code: 3, stdout: "hi\n", stderr: "" });
  const started = Date.now();
  const slow = await run("bash", ["-c", "sleep 30 & sleep 30; wait"], { timeoutMs: 200 });
  assert.notEqual(slow.code, 0);
  assert.match(slow.stderr, /timed out after 0 s/);
  assert.ok(Date.now() - started < 5000, "the timeout also stops the children");
  const missing = await run("/nonexistent/prog", []);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

const laneWorker = fileURLToPath(new URL("./lane-worker.js", import.meta.url));

// Six processes fight for one lane for two seconds and leave it in the given ways.
async function contend(t, modes) {
  const dir = mkdtempSync(join(tmpdir(), "pins-lane-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [laneWorker, dir, String(dead), "2000", modes], { stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`lane worker exited ${code}`)));
  })));
  const total = (key) => results.reduce((sum, result) => sum + result[key], 0);
  assert.ok(total("holds") >= 50, `only ${total("holds")} holds ran`);
  assert.equal(total("violations"), 0, `${total("violations")} of ${total("holds")} holds had a second process in the lane`);
}

test("(l) holders that die while others wait: never two processes in one lane", { timeout: 60000 }, (t) => contend(t, "die"));

test("(l2) holders that release, release an old lock, die, or die inside the guard: never two processes in one lane", { timeout: 60000 }, (t) => contend(t, "release,old,die,guard"));

test("(m) takeLane: wx create, release only its own lock, wait behind a live holder and behind a takeover guard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-lane-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "gate-demo.lock");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  // The guard file of another process that lives (the test runner), and the one of a process that is gone.
  const guard = `${file}.takeover.${process.ppid}`;
  const deadGuard = `${file}.takeover.${dead}`;
  const stale = JSON.stringify({ pid: dead, pin: 7, at: "then" });
  const sleeps = [];
  const options = (waitMs) => ({ waitMs, sleep: async (ms) => { sleeps.push(ms); } });

  // A free lane: the file holds the given text; release removes it.
  const release = await takeLane(file, "mine", options(0));
  assert.equal(readFileSync(file, "utf8"), "mine");
  // A second caller waits and gives up; it names the pin of the holder one time.
  const told = [];
  writeFileSync(file, JSON.stringify({ pid: process.pid, pin: 9, at: "now" }));
  await assert.rejects(takeLane(file, "other", { ...options(4000), onWait: (pin) => told.push(pin) }), /busy/);
  assert.deepEqual([told, sleeps], [[9], [2000, 2000]]);
  // The lock changed hands: the first holder's release leaves the other lock alone.
  release();
  assert.equal(existsSync(file), true);

  // A stale lock is taken over, and the guard is gone after it.
  writeFileSync(file, stale);
  (await takeLane(file, "next", options(0)))();
  assert.deepEqual(readdirSync(dir), []);

  // Another process is inside the takeover guard: this caller removes nothing and waits.
  writeFileSync(file, stale);
  writeFileSync(guard, String(process.ppid));
  sleeps.length = 0;
  await assert.rejects(takeLane(file, "next", options(4000)), /busy/);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(readFileSync(file, "utf8"), stale, "only the guard holder removes a stale lock");
  // A guard older than one minute was left behind: it goes, and the stale lock goes in the same step.
  const old = new Date(Date.now() - 61000);
  utimesSync(guard, old, old);
  (await takeLane(file, "next", options(0)))();
  assert.deepEqual(readdirSync(dir), []);
  // The guard of a process that is gone does not wait for the minute. A file with another name is not a guard.
  writeFileSync(file, stale);
  writeFileSync(deadGuard, String(dead));
  writeFileSync(`${file}.takeover`, "1");
  (await takeLane(file, "next", options(0)))();
  assert.deepEqual(readdirSync(dir), ["gate-demo.lock.takeover"]);
});

test("(n) release takes the takeover guard: it waits while the guard is busy and gives up after 5 s", { timeout: 60000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-lane-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "gate-demo.lock");
  const guard = `${file}.takeover.${process.pid}`;
  // A child takes the lane and releases it when it gets a line on stdin.
  const code = `import { takeLane } from ${JSON.stringify(new URL("../src/ship.js", import.meta.url).href)};
    const release = await takeLane(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid, pin: 1, at: "now" }), { waitMs: 0, sleep: async () => {} });
    console.log("held");
    process.stdin.once("data", () => { release(); console.log("released"); process.exit(0); });`;
  const start = async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "inherit"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    const said = async (word, ms) => {
      for (let waited = 0; !out.includes(word) && waited < ms; waited += 10) await delay(10);
      return out.includes(word);
    };
    assert.ok(await said("held", 10000));
    return { child, said, closed: once(child, "close") };
  };
  // This process lives, so its guard file is not one that was left behind.
  const hold = () => writeFileSync(guard, String(process.pid), { flag: "wx" });

  const first = await start();
  const lock = readFileSync(file, "utf8");
  hold();
  first.child.stdin.write("go\n");
  assert.equal(await first.said("released", 500), false, "the release waits for the guard");
  assert.equal(readFileSync(file, "utf8"), lock, "the lock stays while the guard is busy");
  rmSync(guard);
  assert.ok(await first.said("released", 10000));
  await first.closed;
  assert.deepEqual(readdirSync(dir), []);

  // The guard stays busy: the release gives up and the lock stays. It is stale when its process is gone.
  const second = await start();
  hold();
  const began = Date.now();
  second.child.stdin.write("go\n");
  await second.closed;
  assert.ok(Date.now() - began >= 4900, `the release gave up after ${Date.now() - began} ms`);
  assert.deepEqual(readdirSync(dir).sort(), ["gate-demo.lock", `gate-demo.lock.takeover.${process.pid}`]);
  rmSync(guard);
  (await takeLane(file, "next", { waitMs: 0, sleep: async () => {} }))();
  assert.deepEqual(readdirSync(dir), []);
});

test("(o) a lock that names no process is taken over after one minute, not after thirty", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pins-lane-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "gate-demo.lock");
  const options = { waitMs: 0, sleep: async () => {} };
  const age = (ms) => utimesSync(file, new Date(Date.now() - ms), new Date(Date.now() - ms));
  // Empty: the maker died between create and write, or the disk was full.
  for (const text of ["", "{", '{"pin":7}', '{"pid":"12"}', "null"]) {
    writeFileSync(file, text);
    // A fresh one can belong to a process that is between create and write.
    await assert.rejects(takeLane(file, "next", options), /busy/, `fresh ${JSON.stringify(text)}`);
    age(50000);
    await assert.rejects(takeLane(file, "next", options), /busy/, `50 s ${JSON.stringify(text)}`);
    age(61000);
    (await takeLane(file, "next", options))();
    assert.deepEqual(readdirSync(dir), [], JSON.stringify(text));
  }
  // A lock that names a live process keeps the 30 minutes.
  writeFileSync(file, JSON.stringify({ pid: process.pid, pin: 7, at: "then" }));
  age(29 * 60000);
  await assert.rejects(takeLane(file, "next", options), /busy/);
  age(31 * 60000);
  (await takeLane(file, "next", options))();
  assert.deepEqual(readdirSync(dir), []);
});
